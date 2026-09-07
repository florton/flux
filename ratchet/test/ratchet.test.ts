import { test } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { appendEvent, readEvents, foldRows, foldCorpus, rowId, stableStringify } from "../src/corpus";
import { appendJournal, readJournal } from "../src/journal";
import { ddmin, shrinkNumber, minimize } from "../src/shrink";
import { tokenize } from "../src/runner";
import { failureSignature } from "../src/signature";
import { capture } from "../src/capture";
import { proveSubjects } from "./proof";
import { verify } from "../src/verify";
import { accept, reopen } from "../src/accept";
import { report, reportData } from "../src/report";
import { bisect, formatBisect } from "../src/bisect";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-test-"));
}

const NODE = process.execPath;

/**
 * A scratch project: a .ratchet home, a project root, and a check script.
 * `check` is a JS body that receives the parsed stdin as `v` and calls
 * `fail(reason)` or falls through to pass.
 */
function project(subjects: Record<string, unknown>, checkBody: string): { home: string; root: string } {
  const home = tmpDir();
  const root = path.join(home, "proj");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ subjects }), "utf8");
  fs.writeFileSync(path.join(home, "corpus.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(home, "journal.jsonl"), "", "utf8");
  fs.writeFileSync(
    path.join(root, "check.js"),
    `const fs=require("fs");
const raw=fs.readFileSync(0,"utf8");
const v=raw.trim()===""?null:JSON.parse(raw);
function fail(r){console.log(r);process.exit(1);}
${checkBody}
process.exit(0);
`,
    "utf8"
  );
  proveSubjects(home, root);
  return { home, root };
}

async function withHome<T>(home: string, fn: () => T | Promise<T>): Promise<T> {
  process.env.RATCHET_HOME = home;
  try {
    return await fn();
  } finally {
    delete process.env.RATCHET_HOME;
  }
}

function rows(home: string) {
  return [...foldRows(readEvents(path.join(home, "corpus.jsonl"))).values()];
}

// ---------------------------------------------------------------- units

test("stableStringify orders object keys", () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  assert.equal(stableStringify({ a: [1, { c: 3, b: 2 }] }), '{"a":[1,{"b":2,"c":3}]}');
});

test("journal appends and reads", () => {
  const p = path.join(tmpDir(), "journal.jsonl");
  appendJournal(p, { at: "t1", kind: "accept", actor: "alice", text: "x" });
  appendJournal(p, { at: "t2", kind: "decision", actor: "bob", text: "y" });
  assert.equal(readJournal(p).length, 2);
});

test("ddmin reduces an array while preserving failure", () => {
  const original = [1, 2, 3, 4, 5, 6, 7, 8];
  const failsOn = (arr: number[]) => arr.includes(6);
  const reduced = ddmin(original, failsOn);
  assert.ok(failsOn(reduced));
  assert.ok(reduced.length < original.length);
});

test("shrinkNumber walks toward zero while failing", () => {
  const value = shrinkNumber(8347, (n) => n > 5000);
  assert.ok(value > 5000 && value < 8347);
});

test("minimize handles strings and respects its budget", () => {
  const s = minimize("abcdefXghijkl", (c) => (c as string).includes("X"));
  assert.ok((s as string).includes("X"));
  assert.ok((s as string).length < "abcdefXghijkl".length);

  let calls = 0;
  minimize([1, 2, 3, 4, 5, 6, 7, 8], () => {
    calls++;
    return true;
  }, { remaining: 3 });
  assert.equal(calls, 3, "budget must cap predicate calls");
});

test("failureSignature normalizes values but separates causes", () => {
  const a = failureSignature("expected 3600, got 60", 1);
  const b = failureSignature("expected 1000, got 20", 1);
  const c = failureSignature("divide by zero", 1);
  assert.equal(a, b, "same failure quoting different numbers must match");
  assert.notEqual(a, c, "different failures must not match");
  assert.notEqual(a, failureSignature("expected 3600, got 60", 2), "exit code is part of the signature");
});

// -------------------------------------------------- R1: no shell injection

test("R1: a crafted test name cannot become shell syntax", async () => {
  const { home, root } = project(
    { suite: { check: `"${NODE}" record.js {test}` } },
    "process.exit(0);"
  );
  fs.writeFileSync(
    path.join(root, "record.js"),
    `require("fs").writeFileSync("received.txt", process.argv[2] ?? "");process.exit(1);`,
    "utf8"
  );

  const payload = 'a & echo PWNED > owned.txt & echo x';
  appendEvent(path.join(home, "corpus.jsonl"), {
    op: "capture",
    id: rowId("suite", null, payload),
    at: new Date().toISOString(),
    subject: "suite",
    input: null,
    test: payload,
    source: "junit",
  });

  const results = await withHome(home, () => verify(root, { quiet: true, ratchetHome: home }));
  assert.equal(results.length, 1);
  assert.equal(results[0].pass, false);
  assert.ok(!fs.existsSync(path.join(root, "owned.txt")), "no injected command may run");
  assert.equal(
    fs.readFileSync(path.join(root, "received.txt"), "utf8"),
    payload,
    "the test name must arrive as one intact argv element"
  );
});

test("R1: tokenize groups quotes and leaves backslashes alone", () => {
  assert.deepEqual(tokenize(`node -e "a b" c`), ["node", "-e", "a b", "c"]);
  assert.deepEqual(tokenize(`node "C:\\x\\y.js"`), ["node", "C:\\x\\y.js"]);
  assert.deepEqual(tokenize(`a '{"k": 1}'`), ["a", '{"k": 1}']);
  assert.throws(() => tokenize(`node "unbalanced`), /unbalanced/);
});

// -------------------------------------- R2: a retired row that comes back

test("R2: an accepted counterexample that recurs is reported, not swallowed", async () => {
  const { home, root } = project(
    { s: { check: `"${NODE}" check.js`, captureProperty: "p" } },
    `if (v === 42) fail("boom on 42");`
  );
  const capFile = path.join(root, "cap.json");
  fs.writeFileSync(capFile, JSON.stringify([{ property: "p", counterexample: [42] }]), "utf8");

  await withHome(home, async () => {
    const first = capture(root, [capFile]);
    assert.equal(first.added.length, 1);
    const id = rows(home)[0].id;
    accept(root, id, "intended for now", "alice");
    assert.equal(rows(home)[0].status, "archived");

    // the same bug comes back
    const again = capture(root, [capFile]);
    assert.equal(again.added.length, 0);
    assert.equal(again.skipped.length, 0, "a recurrence is not a skip");
    assert.equal(again.recurred.length, 1, "recurrence must be surfaced");
    assert.equal(again.recurred[0].id, id);
    assert.equal(again.recurred[0].acceptedReason, "intended for now");
    assert.equal(again.recurred[0].acceptedBy, "alice");
    assert.equal(again.recurred[0].reopened, false);

    // and --reopen puts it back into enforcement
    const reopened = capture(root, [capFile], { reopen: true, actor: "ci" });
    assert.equal(reopened.recurred[0].reopened, true);
    assert.equal(rows(home)[0].status, "active");
    assert.equal((await verify(root, { quiet: true, ratchetHome: home }))[0].pass, false);

    // Every recurrence is journaled — reopening is a choice, remembering is
    // not — and the journal entry is what the churn report rates.
    const entries = readJournal(path.join(home, "journal.jsonl"));
    assert.equal(
      entries.filter((e) => e.kind === "recurrence").length,
      2,
      "one recurrence entry per match, with or without --reopen"
    );
  });
});

// ------------------------------------------- R3: ids survive branch merges

test("R3: row ids are content-addressed, so two branches converge", () => {
  assert.equal(rowId("s", { a: 1, b: 2 }), rowId("s", { b: 2, a: 1 }), "key order must not matter");
  assert.notEqual(rowId("s", 1), rowId("s", 2));
  assert.notEqual(rowId("s", 1), rowId("t", 1));
  assert.notEqual(rowId("s", null, "test-a"), rowId("s", null, "test-b"));

  // Two independent corpora capturing different counterexamples, then merged.
  const merged = [
    { op: "capture" as const, id: rowId("s", "alice"), at: "2026-01-01T00:00:00Z", subject: "s", input: "alice", source: "manual" as const },
    { op: "capture" as const, id: rowId("s", "bob"), at: "2026-01-02T00:00:00Z", subject: "s", input: "bob", source: "manual" as const },
  ];
  assert.equal(foldCorpus(merged).rows.size, 2, "neither branch's row may be lost");
});

// ------------------------------- R4: fold order and orphan-event integrity

test("R4: an accept above its capture still retires the row", () => {
  const out = foldCorpus([
    { op: "accept", id: "c1", at: "2026-02-01T00:00:00Z", subject: "s", input: 1, source: "manual" },
    { op: "capture", id: "c1", at: "2026-01-01T00:00:00Z", subject: "s", input: 1, source: "manual" },
  ]);
  assert.equal(out.rows.get("c1")!.status, "archived", "replay must follow timestamps, not file order");
  assert.equal(out.orphans.length, 0);
});

test("R4: an accept with no capture is reported as an orphan", () => {
  const out = foldCorpus([
    { op: "accept", id: "gone", at: "2026-02-01T00:00:00Z", subject: "s", input: 1, source: "manual" },
  ]);
  assert.equal(out.rows.size, 0);
  assert.equal(out.orphans.length, 1);
  assert.equal(out.orphans[0].id, "gone");
});

test("R4: unparseable timestamps fall back to file order", () => {
  const out = foldCorpus([
    { op: "capture", id: "c1", at: "t1", subject: "s", input: 1, source: "manual" },
    { op: "accept", id: "c1", at: "t2", subject: "s", input: 1, source: "manual" },
    { op: "reopen", id: "c1", at: "t3", subject: "s", input: 1, source: "manual" },
  ]);
  assert.equal(out.rows.get("c1")!.status, "active");
});

// ------------------------------------ R5: reduction must preserve the cause

test("R5: minimization does not slip onto an unrelated bug", async () => {
  // Two independent defects: an unrelated legacy one at 0, and the
  // regression actually being captured at n >= 1000.
  const { home, root } = project(
    { s: { check: `"${NODE}" check.js`, captureProperty: "p" } },
    `if (v === 0) fail("legacy: divide by zero");
     if (v >= 1000) fail("regression: value " + v + " out of range");`
  );
  const capFile = path.join(root, "cap.json");
  fs.writeFileSync(capFile, JSON.stringify([{ property: "p", counterexample: [8347] }]), "utf8");

  await withHome(home, async () => {
    const rep = capture(root, [capFile]);
    assert.equal(rep.added.length, 1);
    const row = rows(home)[0];
    assert.equal(row.input, 1000, "must reduce to the true minimal witness of the captured bug");
    assert.notEqual(row.input, 0, "must not walk onto the unrelated failure at zero");
    assert.ok(row.signature, "the row carries its failure signature");
  });
});

test("R5: a row failing for a new reason is flagged as drift", async () => {
  const { home, root } = project(
    { s: { check: `"${NODE}" check.js`, captureProperty: "p" } },
    `if (v === 5) fail("original cause");`
  );
  const capFile = path.join(root, "cap.json");
  fs.writeFileSync(capFile, JSON.stringify([{ property: "p", counterexample: [5] }]), "utf8");

  await withHome(home, async () => {
    capture(root, [capFile]);
    assert.equal((await verify(root, { quiet: true, ratchetHome: home }))[0].signatureDrift, false);

    // same input still fails, but for something else entirely
    fs.writeFileSync(
      path.join(root, "check.js"),
      `const v=JSON.parse(require("fs").readFileSync(0,"utf8"));
       if (v === 5) { console.log("something completely different"); process.exit(1); }
       process.exit(0);`,
      "utf8"
    );
    const res = (await verify(root, { quiet: true, ratchetHome: home }))[0];
    assert.equal(res.pass, false);
    assert.equal(res.signatureDrift, true);
  });
});

// -------------------------------------- R6: bisect never touches your tree

function seedRepo(): { dir: string; good: string } {
  const dir = tmpDir();
  const g = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  g("init", "-q", ".");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  g("config", "commit.gpgsign", "false");
  fs.mkdirSync(path.join(dir, ".ratchet"), { recursive: true });
  fs.writeFileSync(path.join(dir, "lib.js"), "module.exports={f:x=>x}\n", "utf8");
  fs.writeFileSync(
    path.join(dir, "check.js"),
    `const v=JSON.parse(require("fs").readFileSync(0,"utf8"));
     const {f}=require("./lib.js");
     if (f(v)!==v) { console.log("identity broken"); process.exit(1); }
     process.exit(0);`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, ".ratchet", "config.json"),
    JSON.stringify({ subjects: { s: { check: `"${NODE}" check.js` } } }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, ".ratchet", "corpus.jsonl"),
    JSON.stringify({
      op: "capture",
      id: rowId("s", 5),
      at: "2026-01-01T00:00:00Z",
      subject: "s",
      input: 5,
      source: "manual",
    }) + "\n",
    "utf8"
  );
  fs.writeFileSync(path.join(dir, ".ratchet", "journal.jsonl"), "", "utf8");
  g("add", "-A");
  g("commit", "-qm", "c1");
  const good = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  for (const n of [2, 3, 4]) {
    fs.appendFileSync(path.join(dir, "lib.js"), `// ${n}\n`);
    g("add", "-A");
    g("commit", "-qm", `c${n}`);
  }
  fs.writeFileSync(path.join(dir, "lib.js"), "module.exports={f:x=>x+1}\n", "utf8");
  g("add", "-A");
  g("commit", "-qm", "c5-breaks");
  return { dir, good };
}

function headState(dir: string): { branch: string; head: string } {
  return {
    branch: spawnSync("git", ["branch", "--show-current"], { cwd: dir, encoding: "utf8" }).stdout.trim(),
    head: spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim(),
  };
}

test("R6: bisect finds the introducing commit without moving the checkout", async () => {
  const { dir, good } = seedRepo();
  const before = headState(dir);
  const id = rowId("s", 5);

  const result = await bisect(dir, id, good, "HEAD", { ratchetHome: path.join(dir, ".ratchet") });
  const subject = spawnSync("git", ["log", "-1", "--format=%s", result.firstBad], { cwd: dir, encoding: "utf8" }).stdout.trim();
  assert.equal(subject, "c5-breaks");

  const after = headState(dir);
  assert.deepEqual(after, before, "the user's checkout must be exactly where it was");
  assert.notEqual(after.branch, "", "and must not be detached");
});

test("R6: bisect names a fix, not only a regression", async () => {
  // "When did we lose the arms" and "when did we get them back" are the same
  // search. The old command answered only the first: it required --good to
  // pass, and the passing side of a fix is the *newer* commit, which cannot
  // be an ancestor of the older one. So the direction is measured now.
  const { dir, good } = seedRepo();
  const g = (...a: string[]) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
  const broke = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  fs.appendFileSync(path.join(dir, "lib.js"), "// still broken\n");
  g("add", "-A");
  g("commit", "-qm", "c6");
  fs.writeFileSync(path.join(dir, "lib.js"), "module.exports={f:x=>x}\n", "utf8");
  g("add", "-A");
  g("commit", "-qm", "c7-fixes");

  const result = await bisect(dir, rowId("s", 5), broke, "HEAD", { ratchetHome: path.join(dir, ".ratchet") });
  assert.equal(result.direction, "fixed");
  const subject = spawnSync("git", ["log", "-1", "--format=%s", result.boundary], { cwd: dir, encoding: "utf8" }).stdout.trim();
  assert.equal(subject, "c7-fixes");
  assert.match(formatBisect(result, "s"), /first passes at .*fail -> pass/s);
});

test("R6: bisect refuses a range whose endpoints agree", async () => {
  // Not "--bad must be a failing commit": the endpoints simply do not
  // disagree, so there is no boundary here to find in either direction.
  const { dir, good } = seedRepo();
  await assert.rejects(
    () => bisect(dir, rowId("s", 5), good, "HEAD~1", { ratchetHome: path.join(dir, ".ratchet") }),
    /passes at both/
  );
});

test("R6: a failed bisect still leaves the checkout untouched", async () => {
  const { dir, good } = seedRepo();
  const before = headState(dir);

  await assert.rejects(
    () => bisect(dir, "does-not-exist", good, "HEAD", { ratchetHome: path.join(dir, ".ratchet") }),
    /not found/
  );
  assert.deepEqual(headState(dir), before, "an error must not strand the repository");
});

test("R6: bisect refuses two refs that are not a range", async () => {
  const { dir } = seedRepo();
  const g = (...a: string[]) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
  g("checkout", "-q", "-b", "side", "HEAD~3");
  fs.writeFileSync(path.join(dir, "other.txt"), "x", "utf8");
  g("add", "-A");
  g("commit", "-qm", "side-commit");
  const side = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  g("checkout", "-q", "-");

  await assert.rejects(
    () => bisect(dir, rowId("s", 5), side, "HEAD", { ratchetHome: path.join(dir, ".ratchet") }),
    /not an ancestor/
  );
});

// ------------------------------------------ R7: the JUnit path is gated too

test("R7: junit rows are deduped instead of multiplying", async () => {
  const { home, root } = project(
    { "login works": { check: `"${NODE}" check.js` } },
    `fail("still broken");`
  );
  const junit = path.join(root, "junit.xml");
  fs.writeFileSync(
    junit,
    `<testsuite><testcase classname="t" name="login works"><failure message="boom &lt;bad&gt;"/></testcase></testsuite>`,
    "utf8"
  );

  await withHome(home, async () => {
    assert.equal(capture(root, [junit]).added.length, 1);
    assert.equal(capture(root, [junit]).added.length, 0, "a second capture must not add a duplicate");
    assert.equal(capture(root, [junit]).added.length, 0);
    assert.equal(rows(home).length, 1, "three captures of one failure is one row");
    const events = readEvents(path.join(home, "corpus.jsonl"));
    assert.equal(events[0].test, "login works");
  });
});

test("R7: junit rows run discrimination — a passing test is not stored", async () => {
  const { home, root } = project({ "flaky test": { check: `"${NODE}" check.js` } }, "process.exit(0);");
  const junit = path.join(root, "junit.xml");
  fs.writeFileSync(junit, `<testsuite><testcase name="flaky test"><failure message="was red"/></testcase></testsuite>`, "utf8");

  await withHome(home, async () => {
    const rep = capture(root, [junit]);
    assert.equal(rep.added.length, 0, "a failure that no longer reproduces is not evidence");
    assert.equal(rep.skipped.length, 1);
    assert.match(rep.skipped[0], /not reproducible/);
  });
});

test("R7: a subject with no check is not stored and does not redden the build", async () => {
  const { home, root } = project({ configured: { check: `"${NODE}" check.js` } }, "process.exit(0);");
  const junit = path.join(root, "junit.xml");
  fs.writeFileSync(junit, `<testsuite><testcase name="never configured"><failure message="x"/></testcase></testsuite>`, "utf8");

  await withHome(home, async () => {
    const rep = capture(root, [junit]);
    assert.equal(rep.added.length, 0);
    assert.deepEqual(rep.unconfigured, ["never configured"]);
    assert.equal(rows(home).length, 0, "an unverifiable row must never enter the corpus");
    assert.equal((await verify(root, { quiet: true, ratchetHome: home })).length, 0);
  });
});

// --------------------------------------------------------- end-to-end loop

test("capture, dedup, verify, accept, reopen, report", async () => {
  const { home, root } = project(
    { lt1000: { check: `"${NODE}" check.js`, captureProperty: "lt1000.prop" } },
    `if (typeof v === "number" && v >= 1000) fail("value " + v + " is not under 1000");`
  );
  const capFile = path.join(root, "capture.json");
  fs.writeFileSync(
    capFile,
    JSON.stringify([
      { property: "lt1000.prop", seed: 42, counterexample: [1234], error: "1234 >= 1000" },
      { property: "lt1000.prop", seed: 43, counterexample: [1234], error: "dup" },
      { property: "lt1000.prop", seed: 44, counterexample: [999], error: "should pass now" },
    ]),
    "utf8"
  );

  await withHome(home, async () => {
    const rep = capture(root, [capFile]);
    assert.equal(rep.added.length, 1, JSON.stringify(rep));
    // The duplicate counterexample matches a row that is still enforcing, so
    // it is a *catch*, not a skip: the corpus already held this bug and it
    // came back. Counting it as a skip is why the all-time rate read 0%.
    assert.deepEqual(rep.caught.length, 1, JSON.stringify(rep));
    assert.equal(rep.skipped.length, 1, "only the input that passes now is skipped");

    const results = await verify(root, { quiet: true, ratchetHome: home });
    assert.equal(results.length, 1);
    assert.equal(results[0].pass, false);

    const id = rows(home)[0].id;
    accept(root, id, "1000 is the new ceiling", "alice");
    assert.equal((await verify(root, { quiet: true, ratchetHome: home })).length, 0, "archived rows stop enforcing");

    // The decision log, which is what the ceremony writes. Validation proofs
    // and recurrences live in the same file but are not decisions.
    const all = readJournal(path.join(home, "journal.jsonl"));
    const j = all.filter((e) => e.kind === "accept" || e.kind === "decision");
    assert.equal(j.length, 1);
    assert.equal(j[0].kind, "accept");
    assert.equal(j[0].corpusId, id);
    // The duplicate capture above was a catch against a row that was still
    // enforcing, and it is on the record as one.
    const caught = all.filter((e) => e.kind === "recurrence");
    assert.equal(caught.length, 1);
    assert.match(caught[0].text, /matched an active row/);

    reopen(root, id.slice(0, 6), "reverted the decision", "alice");
    assert.equal(rows(home)[0].status, "active", "an id prefix resolves to the row");

    const text = report(root);
    assert.match(text, /1 rows/);
    assert.match(text, /fast-check 1/);
    assert.match(text, /reopened: 1/);
  });
});

test("report splits failure signals into corpus-caught vs. novel", async () => {
  const { home, root } = project(
    { s: { check: `"${NODE}" check.js`, captureProperty: "p" } },
    `if (v === 42) fail("boom on 42");`
  );
  const capFile = path.join(root, "cap.json");
  fs.writeFileSync(capFile, JSON.stringify([{ property: "p", counterexample: [42] }]), "utf8");

  await withHome(home, async () => {
    // Nothing has been observed yet: there is no rate to report.
    let d = reportData(root);
    assert.equal(d.catchRateThisWeek, null);
    assert.equal(d.catchRateAllTime, null);
    assert.match(report(root), /none recorded/);

    capture(root, [capFile]); // a novel counterexample
    const id = rows(home)[0].id;
    accept(root, id, "intended for now", "alice");
    capture(root, [capFile]); // the same input returns — caught by corpus

    d = reportData(root);
    assert.equal(d.newThisWeek, 1, "the first capture of an id is a novel bug");
    assert.equal(d.caughtThisWeek, 1, "a recurrence is a regression the corpus already knew");
    assert.equal(d.catchRateThisWeek, 50);
    assert.equal(d.novelAllTime, 1);
    assert.equal(d.caughtAllTime, 1);

    const text = report(root);
    assert.match(text, /caught by corpus: 1  \(50%\) — known regressions, the ratchet worked/);
    assert.match(text, /new counterexamples: 1 — novel bugs/);
    assert.match(text, /all-time: 1 caught, 1 new \(50%\)/);
  });
});
