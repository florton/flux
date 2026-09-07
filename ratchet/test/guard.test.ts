import { test } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { capture } from "../src/capture";
import { guard, formatGuard } from "../src/guard";
import { foldRows, readEvents, rowId } from "../src/corpus";
import { readJournal } from "../src/journal";
import { proveSubjects } from "./proof";

const NODE = JSON.stringify(process.execPath);

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-guard-"));
}

/**
 * A scratch project whose check fails for input 5, plus a fast-check capture
 * naming that counterexample. Nothing is validated: that is the point of most
 * of the tests below.
 */
function project(rules?: string): { home: string; root: string; cap: string } {
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
  if (rules !== undefined) fs.writeFileSync(path.join(home, "heuristics.rules"), rules, "utf8");
  fs.writeFileSync(
    path.join(root, "check.js"),
    'const v=JSON.parse(require("fs").readFileSync(0,"utf8"));if(v===5){console.log("five is wrong");process.exit(1);}process.exit(0);',
    "utf8"
  );
  const cap = path.join(root, "cap.json");
  fs.writeFileSync(cap, JSON.stringify([{ property: "p", counterexample: [5] }]), "utf8");
  return { home, root, cap };
}

function withHome<T>(home: string, fn: () => T): T {
  const prev = process.env.RATCHET_HOME;
  process.env.RATCHET_HOME = home;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.RATCHET_HOME;
    else process.env.RATCHET_HOME = prev;
  }
}

function rows(home: string) {
  return [...foldRows(readEvents(path.join(home, "corpus.jsonl"))).values()];
}

/* -------------------------------------------------------------------------- */
/* The capture gate                                                            */
/* -------------------------------------------------------------------------- */

test("capture refuses a subject that was never proven to fail on a known bug", () => {
  // The cheapest place to catch a vacuous check is before its first row
  // exists. After that the corpus carries a green light over nothing.
  const p = project();
  const rep = withHome(p.home, () => capture(p.root, [p.cap]));
  assert.deepEqual(rep.unvalidated, ["s"]);
  assert.equal(rep.added.length, 0);
  assert.equal(rows(p.home).length, 0, "nothing entered the corpus");
});

test("capture proceeds once the subject has a proof for its current rule", () => {
  const p = project();
  proveSubjects(p.home, p.root);
  const rep = withHome(p.home, () => capture(p.root, [p.cap]));
  assert.equal(rep.unvalidated.length, 0);
  assert.equal(rep.added.length, 1);
});

test("--allow-unvalidated is an escape hatch, and it is journaled", () => {
  // The exception exists for a subject's very first use, before any known-bad
  // commit is known. It goes on the record rather than into a shell history.
  const p = project();
  const rep = withHome(p.home, () => capture(p.root, [p.cap], { allowUnvalidated: true, actor: "alice" }));
  assert.equal(rep.added.length, 1);
  const j = readJournal(path.join(p.home, "journal.jsonl"));
  const note = j.find((e) => /allow-unvalidated/.test(e.text));
  assert.ok(note, "the exception must be journaled");
  assert.equal(note!.actor, "alice");
});

test("the escape hatch is journaled once per subject, not once per row", () => {
  const p = project();
  fs.writeFileSync(
    p.cap,
    JSON.stringify([
      { property: "p", counterexample: [5] },
      { property: "p", counterexample: [5] },
    ]),
    "utf8"
  );
  withHome(p.home, () => capture(p.root, [p.cap], { allowUnvalidated: true }));
  const notes = readJournal(path.join(p.home, "journal.jsonl")).filter((e) => /allow-unvalidated/.test(e.text));
  assert.equal(notes.length, 1);
});

test("editing a check invalidates its own proof, so the gate closes again", () => {
  // A proof is tied to the rule it was proven under. Otherwise "validated
  // once" would mean "trusted forever", which is how the protocol erodes.
  const p = project();
  proveSubjects(p.home, p.root);
  fs.writeFileSync(
    path.join(p.home, "config.json"),
    JSON.stringify({ subjects: { s: { check: NODE + " check.js --now-different", captureProperty: "p" } } }),
    "utf8"
  );
  const rep = withHome(p.home, () => capture(p.root, [p.cap]));
  assert.deepEqual(rep.unvalidated, ["s"]);
});

/* -------------------------------------------------------------------------- */
/* The guard                                                                   */
/* -------------------------------------------------------------------------- */

test("guard passes on a clean project and names each step", async () => {
  const p = project();
  proveSubjects(p.home, p.root);
  const r = await guard(p.root, { ratchetHome: p.home });
  assert.equal(r.ok, true);
  assert.deepEqual(r.steps.map((s) => s.name), ["integrity", "rows", "validation"]);
  assert.match(formatGuard(r), /guard passed/);
});

test("guard fails on a failing row and prints its witness", async () => {
  // A blocked commit that says only "1 failing" sends the person back to run
  // `ratchet verify` by hand — the step the gate existed to remove.
  const p = project();
  proveSubjects(p.home, p.root);
  withHome(p.home, () => capture(p.root, [p.cap]));
  const r = await guard(p.root, { ratchetHome: p.home });
  assert.equal(r.ok, false);
  const rowsStep = r.steps.find((s) => s.name === "rows")!;
  assert.equal(rowsStep.ok, false);
  assert.match(rowsStep.detail, /five is wrong/);
  assert.match(formatGuard(r), /guard failed: rows/);
});

test("guard refuses outright when the rules file will not parse", async () => {
  // Every heuristic in that file has silently stopped enforcing. Continuing
  // with the ones that happened to parse would be the false pass this tool
  // exists to prevent.
  const p = project("heuristic h\n  run node x.js\n  measure n the exit code\n  rule n is abov 5\n");
  const r = await guard(p.root, { ratchetHome: p.home });
  assert.equal(r.ok, false);
  assert.equal(r.steps[0].name, "heuristics parse");
  assert.match(r.steps[0].detail, /Nothing was checked/);
  assert.equal(r.results.length, 0, "nothing is run once the file is broken");
});

test("guard warns, but does not fail, on a rules file that is not canonical", async () => {
  const p = project("heuristic h\n  run node x.js\n  measure n the exit code\n  rule n should be above 5\n");
  const r = await guard(p.root, { ratchetHome: p.home });
  const step = r.steps.find((s) => s.name === "heuristics canonical")!;
  assert.equal(step.ok, false);
  assert.equal(step.severity, "warning");
  assert.equal(r.ok, true, "formatting is not a regression");
});

test("guard warns on unvalidated subjects, and --strict makes it fatal", async () => {
  const p = project();
  const lenient = await guard(p.root, { ratchetHome: p.home });
  assert.equal(lenient.ok, true);
  assert.equal(lenient.steps.find((s) => s.name === "validation")!.severity, "warning");

  const strict = await guard(p.root, { ratchetHome: p.home, strict: true });
  assert.equal(strict.ok, false);
  assert.match(strict.steps.find((s) => s.name === "validation")!.detail, /ratchet validate s --known-bad/);
});

test("guard flags a gate that is mostly not-applicable", async () => {
  // A gate that is mostly `na` reads green while checking almost nothing,
  // which is the quietest way for this tool to become theatre.
  const p = project();
  fs.writeFileSync(path.join(p.root, "check.js"), 'console.log("feature absent here");process.exit(125);', "utf8");
  proveSubjects(p.home, p.root);
  withHome(p.home, () =>
    capture(p.root, [p.cap], { allowUnvalidated: true })
  );
  // Capture skips an n/a counterexample, so seed the row directly and re-check.
  fs.appendFileSync(
    path.join(p.home, "corpus.jsonl"),
    JSON.stringify({
      op: "capture", id: rowId("s", 5), at: new Date().toISOString(),
      subject: "s", input: 5, source: "manual",
    }) + "\n",
    "utf8"
  );
  const r = await guard(p.root, { ratchetHome: p.home });
  const coverage = r.steps.find((s) => s.name === "coverage");
  assert.ok(coverage, "expected a coverage warning");
  assert.match(coverage!.detail, /not actually checking anything/);
  assert.equal(r.ok, true, "n/a is not a failure, only a warning");
});

test("guard reports corpus corruption as an error", async () => {
  const p = project();
  proveSubjects(p.home, p.root);
  fs.writeFileSync(path.join(p.home, "corpus.jsonl"), "{ not json\n", "utf8");
  const r = await guard(p.root, { ratchetHome: p.home });
  assert.equal(r.ok, false);
  assert.equal(r.steps.find((s) => s.name === "integrity")!.ok, false);
});
