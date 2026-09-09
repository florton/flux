/**
 * The gate saying what is actually true.
 *
 * Five defects, each reproduced against the real binary before it was fixed,
 * each pinned here:
 *
 *   1. a heuristic block shadowed by config.json was invisible — guard was
 *      green on integrity, counted the block as canonical, and advised writing
 *      the block that was already there;
 *   2. `validate` read a crashed instrument as "fails as required" and wrote
 *      a permanent top-tier proof;
 *   3. `owns` was documented as guarded by fsck and guarded by nothing;
 *   4. `heuristics new` did not exist, so a first block was copied from
 *      another repository;
 *   5. nothing said where a `--known-bad` ref comes from.
 */
import { test } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { guard } from "../src/guard";
import { fsck } from "../src/fsck";
import { unownedInstruments } from "../src/instrument";
import { newHeuristic, listHeuristics, formatHeuristicList } from "../src/heuristics-cmd";
import { loadSubjects } from "../src/paths";
import { crashWitness, crashLine } from "../src/witness";
import { validate } from "../src/validate";
import { readJournal } from "../src/journal";
import type { RunResult } from "../src/runner";

const NODE = JSON.stringify(process.execPath);

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-honest-"));
}

function ran(reason: string, outcome: RunResult["outcome"] = "fail", errored = false): RunResult {
  return { outcome, pass: outcome === "pass", reason, code: outcome === "pass" ? 0 : 1, errored };
}

/** A project whose scripted subject and prose block share a name. */
function shadowed(): { home: string; root: string } {
  const home = tmpDir();
  const root = path.join(home, "proj");
  fs.mkdirSync(path.join(home, "tools"), { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ subjects: { "data-integrity": { check: NODE + " {home}/tools/check.js" } } }),
    "utf8"
  );
  fs.writeFileSync(path.join(home, "tools", "check.js"), 'console.log("warnings found: 3");', "utf8");
  fs.writeFileSync(
    path.join(home, "heuristics.rules"),
    [
      "heuristic data-integrity",
      "  run      " + NODE + " {home}/tools/check.js",
      '  measure  warnings  number after "warnings found:"',
      "  rule     warnings is at most 14",
      "  rejects  warnings 15",
      "  because  the exit code throws the warning count away",
      "",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(path.join(home, "corpus.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(home, "journal.jsonl"), "", "utf8");
  return { home, root };
}

test("a shadowed heuristic is named by guard, not left for the reader to find", async () => {
  const { home, root } = shadowed();
  const result = await guard(root, { ratchetHome: home });

  const step = result.steps.find((s) => s.name === "shadowed heuristics");
  assert.ok(step, "guard must have a step for a block that does not run");
  assert.equal(step!.severity, "warning");
  assert.match(step!.detail, /data-integrity/);
  assert.match(step!.detail, /config\.json/);

  // And the advice must not send somebody to write what they already wrote.
  const validation = result.steps.find((s) => s.name === "validation");
  assert.ok(validation);
  assert.match(validation!.detail, /shadowed by config\.json/);
  assert.doesNotMatch(
    result.steps.map((s) => s.detail).join("\n"),
    /with no rules block to declare a rejection in/,
    "a name with a rules block must never be told it has none"
  );
});

test("`ratchet heuristics` shows a shadowed block as not running", () => {
  const { home, root } = shadowed();
  const items = listHeuristics(root, home);
  assert.equal(items.length, 1);
  assert.equal(items[0].shadowed, true);
  const text = formatHeuristicList(items, path.join(home, "heuristics.rules"));
  assert.match(text, /NOT RUNNING/);
  assert.match(text, /declared here and not running/);
});

test("fsck warnings reach guard's integrity step instead of being dropped", async () => {
  // The home lives inside the project, as it does in a real repository: an
  // instrument outside the tree cannot be named by a repo-relative `owns`,
  // and the check correctly stays quiet about it.
  const root = tmpDir();
  const home = path.join(root, ".ratchet");
  fs.mkdirSync(path.join(home, "tools"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ subjects: { s: { check: NODE + " {home}/tools/check.js" } } }),
    "utf8"
  );
  fs.writeFileSync(path.join(home, "tools", "check.js"), "process.exit(0);", "utf8");
  fs.writeFileSync(path.join(home, "corpus.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(home, "journal.jsonl"), "", "utf8");

  const report = fsck(home, root);
  assert.ok(
    report.findings.some((f) => f.kind === "instrument-unowned"),
    "fsck must name an instrument that is outside the rule hash"
  );

  const result = await guard(root, { ratchetHome: home });
  const integrity = result.steps.find((s) => s.name === "integrity");
  assert.ok(integrity);
  assert.equal(integrity!.ok, false);
  assert.equal(integrity!.severity, "warning", "a warning must not fail the build");
  assert.match(integrity!.detail, /instrument-unowned/);
  assert.equal(result.ok, true, "warnings still pass the gate");
});

test("owns silences the unowned finding, and a PATH command never raises it", () => {
  const root = tmpDir();
  const home = path.join(root, ".ratchet");
  fs.mkdirSync(path.join(home, "tools"), { recursive: true });
  fs.writeFileSync(path.join(home, "tools", "check.js"), "process.exit(0);", "utf8");

  const rel = path.relative(root, path.join(home, "tools", "check.js")).split(path.sep).join("/");
  const owned = {
    subjects: { s: { check: NODE + " {home}/tools/check.js", owns: [rel] } },
  };
  assert.equal(unownedInstruments(root, home, owned as never).length, 0);

  const onPath = { subjects: { s: { check: "npm run build" } } };
  assert.equal(unownedInstruments(root, home, onPath as never).length, 0);

  const bare = { subjects: { s: { check: NODE + " {home}/tools/check.js" } } };
  const found = unownedInstruments(root, home, bare as never);
  assert.equal(found.length, 1);
  assert.match(found[0].fix, /owns/);
});

test("crashWitness tells a corpse from a measurement", () => {
  const nodeTrace = [
    "node:internal/modules/cjs/loader:1051",
    "Error: Cannot find module '/tmp/wt/src/engine.js'",
    "    at Module._resolveFilename (node:internal/modules/cjs/loader:1048:15)",
  ].join("\n");
  assert.equal(crashWitness(ran(nodeTrace))?.kind, "trace");
  assert.equal(crashLine(nodeTrace), "Error: Cannot find module '/tmp/wt/src/engine.js'");

  const python = 'Traceback (most recent call last):\n  File "x.py", line 1\nValueError: nope';
  assert.equal(crashWitness(ran(python))?.kind, "trace");

  const probe = "`node tools/audit.mjs` exited 1 before any rule could be checked: boom";
  assert.equal(crashWitness(ran(probe))?.kind, "probe");

  assert.equal(crashWitness(ran("spawn ENOENT", "fail", true))?.kind, "spawn");

  // The whole point: an ordinary measured failure is not a crash.
  assert.equal(crashWitness(ran("problems found: 2")), null);
  assert.equal(crashWitness(ran("failing measured 1, rule says \"failing is 0\"")), null);
  assert.equal(crashWitness(ran("problems found: 0", "pass")), null);
});

test("validate refuses a crashed known-bad, and records the claim when it is affirmed", async () => {
  const dir = tmpDir();
  const g = (...args: string[]) =>
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
      { cwd: dir, encoding: "utf8" });
  g("init", "-q", "-b", "main", ".");
  const home = path.join(dir, ".ratchet");
  fs.mkdirSync(path.join(home, "tools"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ subjects: { quality: { check: NODE + " {home}/tools/check.js" } } }),
    "utf8"
  );
  // The instrument is fine; the *old tree* has no file for it to load. That
  // is the shape a pinned instrument makes at every commit it predates.
  fs.writeFileSync(
    path.join(home, "tools", "check.js"),
    [
      'const path = require("path");',
      'const engine = require(path.resolve(process.cwd(), "src/engine.js"));',
      'console.log("problems found: " + engine.audit());',
      "process.exit(engine.audit() ? 1 : 0);",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(path.join(home, "corpus.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(home, "journal.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(dir, "src", "README.txt"), "no engine yet\n", "utf8");
  g("add", "-A");
  g("commit", "-qm", "before the engine existed");
  const old = g("rev-parse", "HEAD").stdout.trim();
  fs.writeFileSync(path.join(dir, "src", "engine.js"), "exports.audit = () => 0;\n", "utf8");
  g("add", "-A");
  g("commit", "-qm", "add engine");

  const refused = await validate(dir, "quality", {
    knownBad: old,
    knownGood: "HEAD",
    ratchetHome: home,
  });
  assert.equal(refused.valid, false, "a crash at known-bad is not a proof");
  assert.ok(refused.crash, "the crash must be reported, not merely refused");
  assert.equal(refused.crashAffirmed, false);
  assert.equal(
    readJournal(path.join(home, "journal.jsonl")).filter((e) => e.kind === "validation").length,
    0,
    "nothing may reach the journal"
  );

  const affirmed = await validate(dir, "quality", {
    knownBad: old,
    knownGood: "HEAD",
    ratchetHome: home,
    actor: "tester",
    crashIsTheRegression: true,
  });
  assert.equal(affirmed.valid, true);
  assert.equal(affirmed.crashAffirmed, true);
  const proofs = readJournal(path.join(home, "journal.jsonl")).filter((e) => e.kind === "validation");
  assert.equal(proofs.length, 1);
  assert.match(proofs[0].text, /affirmed as the regression by tester/,
    "the journal must show the claim a person made, not just the verdict");
});

test("heuristics new refuses the two collisions and derives owns from the run line", () => {
  const home = tmpDir();
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ subjects: { "data-integrity": { check: "node x.js" } } }),
    "utf8"
  );

  assert.throws(
    () => newHeuristic(home, "data-integrity"),
    /config\.json wins[\s\S]*never run/,
    "the name that cannot work must be refused before the block is written"
  );

  const made = newHeuristic(home, "read-invariants", { run: "node {home}/tools/read.mjs --strict" });
  assert.equal(made.createdFile, true);
  assert.match(made.block, /owns\s+\.ratchet\/tools\/read\.mjs/, "owns must name what run reaches");

  // A skeleton is commented, so it is not a parsed heuristic — the duplicate
  // check has to read the file, or a retry silently appends a second copy.
  assert.throws(() => newHeuristic(home, "read-invariants"), /already has a block/);

  // A command with no path in it cannot have owns guessed for it.
  const vague = newHeuristic(home, "build-works", { run: "npm run build" });
  assert.match(vague.block, /owns\s+<the script/);

  // Nothing written is live yet, so the file still parses to no heuristics.
  assert.equal(loadSubjects(home).fromRules.size, 0);
});
