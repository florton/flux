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
import { verify, emptyGateWarning } from "../src/verify";
import { subjectProofs, PROOF_LABEL } from "../src/proof";
import { instrumentPath } from "../src/instrument";
import { loadSubjects } from "../src/paths";

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
  // `coverage` is a warning, not an error: this project declares a subject
  // and has armed no rows, so the gate is green over nothing and says so.
  // `coverage` and `frozen instrument` are both warnings, and both are true
  // of this fixture: it declares a subject with no armed rows, and its check
  // reaches `check.js` inside the very tree it measures.
  assert.deepEqual(
    r.steps.map((s) => s.name),
    ["integrity", "rows", "coverage", "frozen instrument", "validation"]
  );
  assert.deepEqual(
    r.steps.filter((s) => !s.ok).map((s) => `${s.name}:${s.severity}`),
    ["coverage:warning", "frozen instrument:warning"]
  );
  assert.match(r.steps.find((s) => s.name === "frozen instrument")!.detail, /inside that tree/);
  assert.match(formatGuard(r), /guard passed with 2 warning/);
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

/* -------------------------------------------------------------------------- */
/* Standing invariants — enforcing with no row behind them                     */
/* -------------------------------------------------------------------------- */

/**
 * A project whose only subject is a prose heuristic that has never failed
 * here and never will: the shape the capture gate used to refuse outright.
 *
 * Five of the eight subjects in the two field experiments looked exactly like
 * this — Monty Hall is 2/3, particle count equals capacity, the mode
 * constants index their own table, the tree builds — and every one of them
 * was turned away for never having failed, which is the reason they are worth
 * having.
 */
function standingProject(rule = "f is 0", rejects = "rejects  f 1", prints = "findings: 0"): {
  home: string;
  root: string;
} {
  const home = tmpDir();
  const root = path.join(home, "proj");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(home, "tools"), { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ subjects: {} }), "utf8");
  fs.writeFileSync(path.join(home, "corpus.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(home, "journal.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(home, "tools", "audit.js"), `console.log(${JSON.stringify(prints)});`, "utf8");
  fs.writeFileSync(
    path.join(home, "heuristics.rules"),
    [
      "heuristic every-card-has-an-image",
      `  run      ${NODE} {home}/tools/audit.js`,
      '  measure  f  number after "findings:"',
      `  rule     ${rule}`,
      `  ${rejects}`,
      "  because  a card with no image renders as an empty box in the grid",
      "",
    ].join("\n"),
    "utf8"
  );
  return { home, root };
}

test("a heuristic proven by a declared rejection enforces with no corpus row", async () => {
  const { home, root } = standingProject();
  const results = await verify(root, { ratchetHome: home, quiet: true });
  assert.equal(results.length, 1);
  assert.equal(results[0].kind, "standing");
  assert.equal(results[0].outcome, "pass");

  const r = await guard(root, { ratchetHome: home });
  assert.equal(r.ok, true);
  const standing = r.steps.find((s) => s.name === "standing");
  assert.ok(standing, "a standing invariant is its own step, not a row");
  assert.match(standing!.detail, /1\/1 standing invariants hold/);
  // And it is not counted as a row: the catch rate is a statement about rows.
  assert.match(r.steps.find((s) => s.name === "rows")!.detail, /0\/0 rows pass/);
});

test("a broken standing invariant fails the build and names itself", async () => {
  const { home, root } = standingProject("f is 0", "rejects  f 1", "findings: 3");
  const r = await guard(root, { ratchetHome: home });
  assert.equal(r.ok, false);
  const standing = r.steps.find((s) => s.name === "standing")!;
  assert.equal(standing.ok, false);
  assert.match(standing.detail, /f measured 3/);
  assert.match(formatGuard(r), /guard failed: standing/);
});

test("the two proofs are reported apart, and history outranks a declaration", () => {
  const { home, root } = standingProject();
  const config = loadSubjects(home);
  let proofs = subjectProofs(root, home, config);
  assert.equal(proofs.get("every-card-has-an-image")!.tier, "declared");
  assert.equal(proofs.get("every-card-has-an-image")!.standing, true);
  assert.match(PROOF_LABEL[proofs.get("every-card-has-an-image")!.tier], /declared counterexample/);

  // Adopting the same heuristic against real history is the stronger proof,
  // and is what gets reported once it exists.
  proveSubjects(home, root);
  proofs = subjectProofs(root, home, config);
  assert.equal(proofs.get("every-card-has-an-image")!.tier, "history");
  assert.equal(proofs.get("every-card-has-an-image")!.standing, true, "it still enforces without a row");
});

test("a heuristic with no declared rejection and no history still enforces nothing", async () => {
  // The state item 1 describes: it sits in heuristics.rules, is listed
  // UNVALIDATED, and guards nothing at all.
  const { home, root } = standingProject("f is 0", "note     no proof here");
  const results = await verify(root, { ratchetHome: home, quiet: true });
  assert.deepEqual(results, []);
  const r = await guard(root, { ratchetHome: home });
  assert.equal(r.steps.some((s) => s.name === "standing"), false);
  assert.match(r.steps.find((s) => s.name === "validation")!.detail, /no proof they can fail/);
});

test("an active row for the same subject takes the standing invariant's place", async () => {
  // Two identical probes per gate is time spent for no information: a row
  // carrying no input already runs exactly this check.
  const { home, root } = standingProject();
  fs.appendFileSync(
    path.join(home, "corpus.jsonl"),
    JSON.stringify({
      op: "capture",
      id: rowId("every-card-has-an-image", null, "every-card-has-an-image"),
      at: new Date().toISOString(),
      subject: "every-card-has-an-image",
      input: null,
      test: "every-card-has-an-image",
      source: "manual",
    }) + "\n",
    "utf8"
  );
  const results = await verify(root, { ratchetHome: home, quiet: true });
  assert.equal(results.length, 1);
  assert.notEqual(results[0].kind, "standing", "the row runs it; the invariant does not run it twice");
});

/* -------------------------------------------------------------------------- */
/* Green over nothing                                                          */
/* -------------------------------------------------------------------------- */

test("a repository that declares subjects and has armed none of them says so", async () => {
  const p = project();
  proveSubjects(p.home, p.root);
  const r = await guard(p.root, { ratchetHome: p.home });
  const coverage = r.steps.find((s) => s.name === "coverage")!;
  assert.equal(coverage.severity, "warning");
  assert.match(coverage.detail, /no armed rows and no standing invariants/);
  assert.match(coverage.detail, /ratchet adopt/);
  assert.equal(r.ok, true, "a fresh project is not a failing build");
});

test("an empty home with no subjects at all warns about nothing", () => {
  assert.equal(emptyGateWarning([], 0), undefined, "a freshly initialized home is not a finding");
  assert.match(emptyGateWarning([], 3)!, /declares 3 subject/);
});

test("an instrument inside the measured tree is a warning, and a token silences it", async () => {
  // What the particles experiment did: a config pointing at an untracked
  // script in the tree, while the write-up claimed a frozen instrument.
  const p = project();
  proveSubjects(p.home, p.root);
  const r = await guard(p.root, { ratchetHome: p.home });
  const frozen = r.steps.find((s) => s.name === "frozen instrument")!;
  assert.equal(frozen.severity, "warning");
  assert.match(frozen.detail, /check\.js, which is inside that tree/);
  assert.match(frozen.detail, /fix: .*\{home\}\/check\.js/);

  fs.mkdirSync(path.join(p.home, "tools"), { recursive: true });
  fs.copyFileSync(path.join(p.root, "check.js"), path.join(p.home, "tools", "check.js"));
  fs.writeFileSync(
    path.join(p.home, "config.json"),
    JSON.stringify({ subjects: { s: { check: NODE + " {home}/tools/check.js", captureProperty: "p" } } }),
    "utf8"
  );
  const after = await guard(p.root, { ratchetHome: p.home });
  assert.equal(after.steps.some((s) => s.name === "frozen instrument"), false);
});

test("instrumentPath names the program, not a flag, a directory or a bare command", () => {
  assert.equal(instrumentPath("node tools/check.js", false), "tools/check.js");
  assert.equal(instrumentPath("node --test --experimental-x tools/check.js", false), "tools/check.js");
  assert.equal(instrumentPath("./tools/check.sh", false), "./tools/check.sh");
  assert.equal(instrumentPath("npm run verify", false), undefined, "a bare command resolves on PATH");
  assert.equal(instrumentPath("node {home}/tools/check.js", false), "{home}/tools/check.js");
});

test("a directory argument is not an instrument", async () => {
  // `node --test ratchet/dist/test/` measures the tree it points at, and
  // reading the checked-out commit's tests is the whole point of that subject.
  const p = project();
  proveSubjects(p.home, p.root);
  fs.mkdirSync(path.join(p.root, "suite"), { recursive: true });
  fs.writeFileSync(
    path.join(p.home, "config.json"),
    JSON.stringify({ subjects: { s: { check: NODE + " --test suite/", captureProperty: "p" } } }),
    "utf8"
  );
  const r = await guard(p.root, { ratchetHome: p.home });
  assert.equal(r.steps.some((s) => s.name === "frozen instrument"), false);
});
