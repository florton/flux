import { test } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { appendEvent, readEvents, foldRows, rowId } from "../src/corpus";
import { readJournal } from "../src/journal";
import { ruleHash, collectOwned } from "../src/rule";
import { runCheck } from "../src/runner";
import { capture } from "../src/capture";
import { proveSubjects } from "./proof";
import { recorderBody, maxOverlap, probes } from "./concurrency";
import { verify } from "../src/verify";
import { accept, reaffirm } from "../src/accept";
import { replay, sample, parsePolicy, formatReplay } from "../src/replay";
import { validate, validatedSubjects } from "../src/validate";
import { adopt } from "../src/adopt";
import { commitRange, type CommitInfo } from "../src/worktree";
import type { SubjectConfig } from "../src/types";
import { tmpDir } from "./tmp";

const NODE = JSON.stringify(process.execPath);

function rows(home: string) {
  return [...foldRows(readEvents(path.join(home, "corpus.jsonl"))).values()];
}

async function withHome<T>(home: string, fn: () => T | Promise<T>): Promise<T> {
  process.env.RATCHET_HOME = home;
  try {
    return await fn();
  } finally {
    delete process.env.RATCHET_HOME;
  }
}

/**
 * A repository whose history contains one real bug: `double(n)` returns
 * `n + 2` instead of `n * 2` for a stretch of commits, then is fixed.
 */
function seedHistory(
  commits = 9,
  breakAt = 3,
  fixAt = 7,
  delayMs?: number,
  probeLog?: string
): { dir: string; base: string; log: CommitInfo[] } {
  const dir = tmpDir();
  const g = (...args: string[]) =>
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
      { cwd: dir, encoding: "utf8" });

  g("init", "-q", "-b", "main", ".");
  fs.mkdirSync(path.join(dir, ".ratchet"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "check.js"),
    [
      'const v = JSON.parse(require("fs").readFileSync(0, "utf8"));',
      'const { double } = require("./lib.js");',
      probeLog
        ? recorderBody(probeLog, delayMs ?? 0)
        : delayMs
          ? `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${delayMs});`
          : "",
      "const got = double(v);",
      "if (got === v * 2) process.exit(0);",
      'console.log("double(" + v + ") gave " + got + ", expected " + v * 2);',
      "process.exit(1);",
    ]
      .filter((l) => l !== "")
      .join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, ".ratchet", "config.json"),
    JSON.stringify({ subjects: { doubling: { check: NODE + " check.js", owns: ["check.js"] } } }),
    "utf8"
  );
  fs.writeFileSync(path.join(dir, ".ratchet", "corpus.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(dir, ".ratchet", "journal.jsonl"), "", "utf8");

  const good = "module.exports = { double: (n) => n * 2 };\n";
  const bad = "module.exports = { double: (n) => n + 2 };\n";
  for (let i = 0; i < commits; i++) {
    fs.writeFileSync(path.join(dir, "lib.js"), i >= breakAt && i < fixAt ? bad : good);
    fs.writeFileSync(path.join(dir, "note.txt"), `commit ${i}\n`);
    g("add", "-A");
    g("commit", "-qm", `c${i}${i === breakAt ? " BREAKS" : i === fixAt ? " fixes" : ""}`,
      "--date", `2026-01-${String(i + 1).padStart(2, "0")}T12:00:00`);
  }
  const base = spawnSync("git", ["rev-list", "--max-parents=0", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  return { dir, base, log: commitRange(dir, base, "HEAD").commits };
}

// ------------------------------------------------ owning-rule hash and quarantine

test("ruleHash covers the check command and the files it owns", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "check.js"), "original\n", "utf8");
  const subj: SubjectConfig = { check: "node check.js", owns: ["check.js"] };

  const before = ruleHash("s", subj, dir);
  assert.equal(ruleHash("s", subj, dir), before, "hashing is stable");
  assert.notEqual(ruleHash("s", { ...subj, check: "node other.js" }, dir), before, "the command is part of the rule");

  fs.writeFileSync(path.join(dir, "check.js"), "rewritten\n", "utf8");
  assert.notEqual(ruleHash("s", subj, dir), before, "the owned script is part of the rule");

  fs.rmSync(path.join(dir, "check.js"));
  assert.notEqual(ruleHash("s", subj, dir), before, "a missing owned file is not the same as an empty one");
});

test("collectOwned walks directories and skips node_modules", () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "tools", "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tools", "b.js"), "", "utf8");
  fs.writeFileSync(path.join(dir, "tools", "a.js"), "", "utf8");
  fs.writeFileSync(path.join(dir, "tools", "node_modules", "junk.js"), "", "utf8");
  const owned = collectOwned(["tools"], dir).map((p) => p.replace(/\\/g, "/"));
  assert.deepEqual(owned, ["tools/a.js", "tools/b.js"]);
});

test("a row whose rule was edited is quarantined, not treated as a regression", async () => {
  const home = tmpDir();
  const root = path.join(home, "proj");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ subjects: { s: { check: NODE + " check.js", captureProperty: "p", owns: ["check.js"] } } }),
    "utf8"
  );
  fs.writeFileSync(path.join(home, "corpus.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(home, "journal.jsonl"), "", "utf8");
  const check = (body: string) =>
    fs.writeFileSync(
      path.join(root, "check.js"),
      'const v=JSON.parse(require("fs").readFileSync(0,"utf8"));\n' + body + "\nprocess.exit(0);",
      "utf8"
    );
  check('if (v === 5) { console.log("five is wrong"); process.exit(1); }');
  fs.writeFileSync(path.join(root, "cap.json"), JSON.stringify([{ property: "p", counterexample: [5] }]), "utf8");

  await withHome(home, async () => {
    proveSubjects(home, root);
    capture(root, [path.join(root, "cap.json")]);
    const row = rows(home)[0];
    assert.ok(row.ruleHash, "capture records the rule that justified the row");

    // still failing, rule untouched -> a hard block
    let res = await verify(root, { quiet: true, ratchetHome: home });
    assert.equal(res[0].outcome, "fail");
    assert.equal(res[0].ruleChanged, false);

    // the instrument is rewritten; the row still fails -> quarantine
    check('if (v === 5) { console.log("five is wrong, per the new rule"); process.exit(1); }');
    res = await verify(root, { quiet: true, ratchetHome: home });
    assert.equal(res[0].outcome, "quarantine", "the heuristic moved, so this is review, not regression");
    assert.equal(res[0].ruleChanged, true);
    assert.equal(res[0].pass, false);

    // reaffirming re-pins it to the current rule and lifts the quarantine
    reaffirm(root, row.id, "same expectation, tidied wording", "alice");
    res = await verify(root, { quiet: true, ratchetHome: home });
    assert.equal(res[0].outcome, "fail", "back to a hard block once re-pinned");
    assert.equal(res[0].ruleChanged, false);
    assert.throws(() => reaffirm(root, row.id, "again", "alice"), /already pinned/);

    const j = readJournal(path.join(home, "journal.jsonl")).filter((e) => e.kind !== "validation");
    assert.equal(j.length, 1);
    assert.match(j[0].text, /reaffirmed under edited rule/);
  });
});

test("quarantined rows do not fail the build; accept still retires them", async () => {
  const home = tmpDir();
  const root = path.join(home, "proj");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ subjects: { s: { check: NODE + " check.js", owns: ["check.js"] } } }),
    "utf8"
  );
  fs.writeFileSync(path.join(root, "check.js"), 'console.log("always fails"); process.exit(1);', "utf8");
  fs.writeFileSync(path.join(home, "journal.jsonl"), "", "utf8");
  appendEvent(path.join(home, "corpus.jsonl"), {
    op: "capture",
    id: rowId("s", 1),
    at: "2026-01-01T00:00:00Z",
    subject: "s",
    input: 1,
    ruleHash: "stale0000000000",
    source: "manual",
  });

  await withHome(home, async () => {
    const res = await verify(root, { quiet: true, ratchetHome: home });
    assert.equal(res[0].outcome, "quarantine");
    assert.equal(res.some((r) => r.outcome === "fail"), false, "quarantine must not fail the build");
    accept(root, rowId("s", 1), "the expectation is retired", "alice");
    assert.equal((await verify(root, { quiet: true, ratchetHome: home })).length, 0);
  });
});

// ---------------------------------------------- the second confirmation run

test("a failure must reproduce twice to enter the corpus", async () => {
  const home = tmpDir();
  const root = path.join(home, "proj");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ subjects: { s: { check: NODE + " check.js", captureProperty: "p" } } }),
    "utf8"
  );
  fs.writeFileSync(path.join(home, "corpus.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(home, "journal.jsonl"), "", "utf8");
  // Fails on the first run and passes on every later one: the classic flake.
  fs.writeFileSync(
    path.join(root, "check.js"),
    [
      'const fs = require("fs");',
      'const marker = "runs.txt";',
      'const n = fs.existsSync(marker) ? Number(fs.readFileSync(marker, "utf8")) : 0;',
      "fs.writeFileSync(marker, String(n + 1));",
      'if (n === 0) { console.log("intermittent failure"); process.exit(1); }',
      "process.exit(0);",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(path.join(root, "cap.json"), JSON.stringify([{ property: "p", counterexample: [1] }]), "utf8");

  await withHome(home, async () => {
    proveSubjects(home, root);
    const rep = capture(root, [path.join(root, "cap.json")]);
    assert.equal(rep.added.length, 0, "a flake must not become a permanent row");
    assert.equal(rep.flaky.length, 1);
    assert.match(rep.flaky[0], /run 1 failed/);
    assert.equal(rows(home).length, 0);
  });
});

test("--confirm 1 opts out of the second run", async () => {
  const home = tmpDir();
  const root = path.join(home, "proj");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ subjects: { s: { check: NODE + " check.js", captureProperty: "p" } } }),
    "utf8"
  );
  fs.writeFileSync(path.join(home, "corpus.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(home, "journal.jsonl"), "", "utf8");
  fs.writeFileSync(
    path.join(root, "check.js"),
    'const v=JSON.parse(require("fs").readFileSync(0,"utf8"));if(v===1){console.log("stable failure");process.exit(1);}process.exit(0);',
    "utf8"
  );
  fs.writeFileSync(path.join(root, "cap.json"), JSON.stringify([{ property: "p", counterexample: [1] }]), "utf8");

  await withHome(home, async () => {
    proveSubjects(home, root);
    assert.equal(capture(root, [path.join(root, "cap.json")], { confirmations: 1 }).added.length, 1);
  });
});

// --------------------------------------------------------- sampling policy

test("sampling policies pick the right commits", () => {
  const commits: CommitInfo[] = Array.from({ length: 10 }, (_, i) => ({
    sha: "sha" + i,
    date: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    subject: "c" + i,
  }));

  assert.equal(sample(commits, { kind: "dense" }).length, 10);

  const stride = sample(commits, { kind: "stride", n: 4 });
  assert.deepEqual(stride.map((c) => c.sha), ["sha0", "sha4", "sha8", "sha9"]);
  assert.equal(stride[stride.length - 1].sha, "sha9", "the endpoint is always sampled");

  const weekly = sample(commits, { kind: "period", unit: "week" });
  assert.ok(weekly.length < commits.length && weekly.length >= 2);
  assert.equal(weekly[weekly.length - 1].sha, "sha9");

  assert.deepEqual(parsePolicy(undefined), { kind: "dense" });
  assert.deepEqual(parsePolicy("1"), { kind: "dense" });
  assert.deepEqual(parsePolicy("4"), { kind: "stride", n: 4 });
  assert.deepEqual(parsePolicy("week"), { kind: "period", unit: "week" });
  assert.throws(() => parsePolicy("often"), /positive integer/);
});

// ------------------------------------------------------------------ replay

test("replay samples history and halves to the introducing commit", async () => {
  const { dir, base, log } = seedHistory();
  appendEvent(path.join(dir, ".ratchet", "corpus.jsonl"), {
    op: "capture",
    id: rowId("doubling", 21),
    at: "2026-02-01T00:00:00Z",
    subject: "doubling",
    input: 21,
    source: "manual",
  });

  const r = await replay(dir, {
    good: base,
    bad: "HEAD",
    every: "4",
    ratchetHome: path.join(dir, ".ratchet"),
  });

  assert.ok(r.sampled < r.total, `sampled ${r.sampled} of ${r.total}`);
  assert.ok(r.environment.node.startsWith("v"), "the run records the environment it happened under");
  const broke = r.transitions.find((t) => t.kind === "broke");
  assert.ok(broke, "a pass -> fail transition must be found");
  assert.equal(broke!.commit.subject, "c3 BREAKS", "halving names the commit that introduced it");

  // The user's checkout is untouched throughout.
  assert.equal(
    spawnSync("git", ["branch", "--show-current"], { cwd: dir, encoding: "utf8" }).stdout.trim(),
    "main"
  );
  assert.equal(
    spawnSync("git", ["worktree", "list"], { cwd: dir, encoding: "utf8" }).stdout.trim().split("\n").length,
    1,
    "no worktree is left behind"
  );
});

test("replay reports a commit it cannot prepare as na-env, not as a bug", async () => {
  const { dir, base } = seedHistory(4, 99, 99); // never broken
  appendEvent(path.join(dir, ".ratchet", "corpus.jsonl"), {
    op: "capture",
    id: rowId("doubling", 21),
    at: "2026-02-01T00:00:00Z",
    subject: "doubling",
    input: 21,
    source: "manual",
  });

  const r = await replay(dir, {
    good: base,
    bad: "HEAD",
    setup: "exit 1",
    ratchetHome: path.join(dir, ".ratchet"),
  });
  assert.ok(r.samples.length > 0);
  assert.ok(r.samples.every((s) => s.status === "na-env"), "dependency rot is not a regression");
  assert.equal(r.samples.every((s) => (s.note ?? "").includes("setup failed")), true);
});

test("replay --jobs probes commits on parallel worktrees, results in order", async () => {
  // Each probe records the window it occupied and the directory it ran in.
  // Four sessions over eight commits must show four distinct worktrees --
  // the fan-out, which is a fact about the run and not about its speed -- and
  // windows that intersect, which only two probes running at once can produce.
  //
  // This used to time a serial run against a parallel one and assert the
  // parallel one came in under 60% of it. That is a measurement of the
  // machine: the suite runs its files in parallel, so the four workers
  // competed with the rest of the suite, and the assertion failed on an
  // untouched tree about one run in three. See test/concurrency.ts.
  const probeLog = tmpDir();
  const { dir, base, log } = seedHistory(8, 99, 99, 400, probeLog); // never broken, slow checks
  appendEvent(path.join(dir, ".ratchet", "corpus.jsonl"), {
    op: "capture",
    id: rowId("doubling", 21),
    at: "2026-02-01T00:00:00Z",
    subject: "doubling",
    input: 21,
    source: "manual",
  });
  const home = path.join(dir, ".ratchet");

  const r = await replay(dir, { good: base, bad: "HEAD", ratchetHome: home, concurrency: 4 });

  assert.equal(r.samples.length, log.length);
  assert.ok(r.samples.every((s) => s.status === "pass"));
  assert.deepEqual(
    r.samples.map((s) => s.commit.sha),
    log.map((c) => c.sha),
    "parallel probing must preserve commit order in the report"
  );

  const ran = probes(probeLog);
  assert.equal(ran.length, log.length, "every commit must have been probed exactly once");
  assert.equal(
    new Set(ran.map((p) => p.cwd)).size,
    4,
    "--jobs 4 must spread the probes over four distinct worktrees, one checkout each"
  );
  const overlap = maxOverlap(probeLog);
  assert.ok(overlap >= 2, `probes never ran at the same time (most in flight at once: ${overlap})`);

  // No worktrees are left behind, same as the serial path.
  assert.equal(
    spawnSync("git", ["worktree", "list"], { cwd: dir, encoding: "utf8" }).stdout.trim().split("\n").length,
    1
  );
});

// ---------------------------------------------------------------- validate

test("validate proves a subject catches a known bug, and refuses one that does not", async () => {
  const { dir, log } = seedHistory();
  const broken = log.find((c) => c.subject.includes("BREAKS"))!.sha;
  const fixed = log.find((c) => c.subject.includes("fixes"))!.sha;
  const home = path.join(dir, ".ratchet");

  const good = await validate(dir, "doubling", {
    knownBad: broken,
    knownGood: fixed,
    input: 21,
    ratchetHome: home,
  });
  assert.equal(good.knownBad.failed, true);
  assert.equal(good.knownGood!.passed, true);
  assert.equal(good.valid, true);

  const journal = readJournal(path.join(home, "journal.jsonl"));
  assert.equal(journal.length, 1);
  assert.equal(journal[0].kind, "validation");
  assert.match(journal[0].text, /fails at/);

  const config = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.ok(validatedSubjects(dir, home, config).has("doubling"));

  // Editing the check invalidates its own proof: the rule it was proven
  // against no longer exists.
  fs.appendFileSync(path.join(dir, "check.js"), "\n// tweak\n");
  assert.equal(validatedSubjects(dir, home, config).has("doubling"), false);
});

test("validate fails a subject that passes through the known bug", async () => {
  const { dir, log } = seedHistory();
  const broken = log.find((c) => c.subject.includes("BREAKS"))!.sha;
  const home = path.join(dir, ".ratchet");

  // A subject that asserts nothing about doubling at all.
  const config = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  config.subjects.toothless = { check: NODE + ' -e "process.exit(0)"' };
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(config), "utf8");

  const r = await validate(dir, "toothless", { knownBad: broken, input: 21, ratchetHome: home });
  assert.equal(r.knownBad.failed, false);
  assert.equal(r.valid, false, "a subject that passes through a known bug is too weak");
  assert.equal(readJournal(path.join(home, "journal.jsonl")).length, 0, "no proof is recorded for a failed validation");
});

// ------------------------------- the frozen instrument: {home} substitution

test("{home} lets the instrument live outside the tree it measures", async () => {
  const { dir, base, log } = seedHistory();
  const home = path.join(dir, ".ratchet");
  const tools = path.join(home, "tools");
  fs.mkdirSync(tools, { recursive: true });

  // The probe lives in the ratchet home, not in the repository, so replay
  // carries it across every commit instead of each commit supplying its own.
  fs.writeFileSync(
    path.join(tools, "probe.js"),
    [
      'const { double } = require(require("path").join(process.cwd(), "lib.js"));',
      "if (double(21) === 42) process.exit(0);",
      'console.log("double(21) gave " + double(21));',
      "process.exit(1);",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ subjects: { frozen: { check: NODE + " {home}/tools/probe.js" } } }),
    "utf8"
  );

  const r = await replay(dir, { good: base, bad: "HEAD", subjects: true, ratchetHome: home });
  const byCommit = new Map(r.samples.map((x) => [x.commit.subject, x.status]));
  // the range is good..bad, so the root commit c0 is excluded
  assert.equal(byCommit.get("c1"), "pass");
  assert.equal(byCommit.get("c3 BREAKS"), "fail", "the carried probe runs at a commit that never contained it");
  assert.equal(byCommit.get("c7 fixes"), "pass");
  // The fixture breaks at c3 and fixes at c7, so this range holds *both*
  // boundaries. Reporting only the first — labelled "first bad commit"
  // whichever it was — is what made a fix invisible.
  assert.deepEqual(
    r.transitions.map((t) => [t.kind, t.commit.subject]),
    [["broke", "c3 BREAKS"], ["fixed", "c7 fixes"]],
    "every transition is reported, in history order, with its direction"
  );
});

test("replay names a fix, in a range that holds only a fix", async () => {
  // The headline result the v0 experiment recorded — the commit where a
  // galaxy *gained* its arms — did not reproduce: `replay` searched for a
  // pass -> fail pair and halved that window only, so a fail -> pass boundary
  // reported "no transition inside this range" and had to be closed by hand.
  const { dir, log } = seedHistory();
  appendEvent(path.join(dir, ".ratchet", "corpus.jsonl"), {
    op: "capture",
    id: rowId("doubling", 21),
    at: "2026-02-01T00:00:00Z",
    subject: "doubling",
    input: 21,
    source: "manual",
  });

  // c4..HEAD starts inside the broken era, so the only boundary is the fix.
  const r = await replay(dir, {
    good: log[4].sha,
    bad: "HEAD",
    ratchetHome: path.join(dir, ".ratchet"),
  });
  assert.deepEqual(
    r.transitions.map((t) => [t.kind, t.commit.subject]),
    [["fixed", "c7 fixes"]]
  );
  assert.match(formatReplay(r), /fixed  at .* fail -> pass/);
});

test("replay says so plainly when a range holds no transition at all", async () => {
  const { dir, log } = seedHistory();
  appendEvent(path.join(dir, ".ratchet", "corpus.jsonl"), {
    op: "capture",
    id: rowId("doubling", 21),
    at: "2026-02-01T00:00:00Z",
    subject: "doubling",
    input: 21,
    source: "manual",
  });
  // log[i] is c(i+1): the range good..bad excludes its start. c3..c6 is
  // entirely inside the broken era, so there is no boundary to find.
  const r = await replay(dir, {
    good: log[2].sha,
    bad: log[5].sha,
    ratchetHome: path.join(dir, ".ratchet"),
  });
  assert.deepEqual(r.transitions, []);
  assert.match(formatReplay(r), /no transition inside this range . every usable sample fails/);
});

test("a check reads RATCHET_HOME and RATCHET_TEST from the environment", () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, "echo.js"),
    'console.log(process.env.RATCHET_HOME + "|" + process.env.RATCHET_TEST); process.exit(1);',
    "utf8"
  );
  const res = runCheck(NODE + " echo.js", null, {
    cwd: dir,
    homeDir: "/some/home",
    testName: "a test name",
  });
  assert.equal(res.reason, "/some/home|a test name");
});

test("replay --subjects runs configured subjects, not corpus rows", async () => {
  const { dir, base } = seedHistory(5, 2, 99); // broken from c2 onward
  const home = path.join(dir, ".ratchet");
  // The corpus is empty: a standing invariant has no counterexample while it
  // holds, so row-mode replay would have nothing to run.
  assert.equal(fs.readFileSync(path.join(home, "corpus.jsonl"), "utf8").trim(), "");

  const rows = await replay(dir, { good: base, bad: "HEAD", ratchetHome: home });
  assert.ok(rows.samples.every((x) => x.status === "na"), "no rows means nothing to replay");

  const subjects = await replay(dir, { good: base, bad: "HEAD", subjects: true, ratchetHome: home });
  assert.ok(subjects.samples.some((x) => x.status === "fail"), "subject mode finds the break");
  assert.ok(subjects.samples.some((x) => x.status === "pass"));
});

// -------------------------------- adopt: the confirmation probe is prepared too

test("adopt re-runs --setup before the confirmation probe", async () => {
  // Build output is not tracked, so `git checkout --force` leaves the previous
  // probe's artifacts in the worktree. `adopt` confirms a failure by checking
  // the bad commit out a second time; without re-running setup, that
  // confirmation measures whichever commit was built last — which is the
  // *fixed* one, since probing walks forward. Every subject with a build step
  // was therefore reported flaky and refused, and in the other direction a
  // failure caused by stale artifacts would have been confirmed and stored.
  const { dir, base } = seedHistory(5, 2, 4);
  const home = path.join(dir, ".ratchet");
  const tools = path.join(home, "tools");
  fs.mkdirSync(tools, { recursive: true });

  // A "build": derive an untracked artifact from the tracked source.
  fs.writeFileSync(
    path.join(tools, "build.js"),
    'require("fs").copyFileSync("lib.js", "built.js");\nconsole.log("built");\n',
    "utf8"
  );
  // A check that reads only the artifact, the way a compiled project's does.
  fs.writeFileSync(
    path.join(tools, "check.js"),
    [
      'const { double } = require(require("path").resolve("built.js"));',
      "if (double(21) === 42) process.exit(0);",
      'console.log("double(21) gave " + double(21) + ", expected 42");',
      "process.exit(1);",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ subjects: { built: { check: NODE + " {home}/tools/check.js" } } }),
    "utf8"
  );

  const result = await adopt(dir, "built", {
    good: base,
    setup: NODE + " {home}/tools/build.js",
    ratchetHome: home,
    actor: "test",
  });

  assert.ok(result.firstFailing, "adopt found no failing commit in a range that contains the bug");
  assert.match(result.firstFailing!.message, /BREAKS/);
  assert.deepEqual(
    result.notes.filter((n) => /flaky/.test(n)),
    [],
    "the confirmation probe measured a stale build and called a sound heuristic flaky"
  );
  assert.equal(result.captured, true);
  assert.equal(rows(home).length, 1, "a confirmed failure must enter the corpus");
});
