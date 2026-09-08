import { test } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { capture } from "../src/capture";
import { accept } from "../src/accept";
import { guard, formatGuard } from "../src/guard";
import { foldRows, readEvents, rowId } from "../src/corpus";
import { readJournal } from "../src/journal";
import { proveSubjects } from "./proof";
import { verify, emptyGateWarning } from "../src/verify";
import { subjectProofs, PROOF_LABEL } from "../src/proof";
import { instrumentPath, instrumentPaths } from "../src/instrument";
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

test("guard offers `rejects` only to a subject that has a rules-file block", async () => {
  // `rejects` is a clause in heuristics.rules. A subject declared in
  // config.json has no block and cannot have one, and a gate that tells you to
  // do an impossible thing is a gate you stop reading. History proof suits
  // both, so that line is always offered.
  const only = project();
  const scripted = await guard(only.root, { ratchetHome: only.home, strict: true });
  const advice = scripted.steps.find((s) => s.name === "validation")!.detail;
  assert.match(advice, /no proof they can fail: s/);
  assert.doesNotMatch(advice, /rejects/, "a scripted subject cannot take this advice");

  // With an unproven prose subject in the mix the line comes back, and says
  // which of the two it is for.
  const mixed = project("heuristic h\n  run node x.js\n  measure n the exit code\n  rule n is 0\n");
  const both = await guard(mixed.root, { ratchetHome: mixed.home, strict: true });
  const mixedAdvice = both.steps.find((s) => s.name === "validation")!.detail;
  assert.match(mixedAdvice, /or without it for h, in the rules: rejects <measure>/);
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

test("a config that will not load is one refusal, not the same paragraph twice", () => {
  // R39. `fsck` and `verify` each rediscovered the malformed config and each
  // printed the whole message, so `guard failed: integrity, rows` arrived with
  // one cause stated twice. A config that will not load is the same class of
  // failure as a rules file that will not parse — every subject in it has
  // stopped enforcing — so it is refused where that one is, and once.
  const p = project();
  fs.writeFileSync(
    path.join(p.home, "config.json"),
    JSON.stringify({ subjects: { s: { command: NODE + " check.js" } } }),
    "utf8"
  );
  return guard(p.root, { ratchetHome: p.home }).then((r) => {
    assert.equal(r.ok, false);
    assert.deepEqual(r.steps.map((s) => s.name), ["subjects"], "nothing else runs without subjects");
    assert.match(r.steps[0].detail, /subjects\."s"\.check is missing/);
    assert.match(r.steps[0].detail, /has "command", which nothing reads/);
    assert.doesNotMatch(r.steps[0].detail, /is not iterable/);
    assert.match(formatGuard(r), /guard failed: subjects/);
  });
});

test("a well-formed config adds no subjects step", async () => {
  // The control: the step exists only when there is something to say.
  const p = project();
  proveSubjects(p.home, p.root);
  const r = await guard(p.root, { ratchetHome: p.home });
  assert.equal(r.steps.some((s) => s.name === "subjects"), false);
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

/**
 * Two scripted subjects, one to be armed with a row and one not, plus a state
 * file so the same check can fail (to arm a row) and then pass (so the gate is
 * green afterwards, which is the situation R31 is about). Each check leaves a
 * mark next to itself when it runs.
 *
 * The mark is the point. A claim about what the gate *runs* cannot be tested
 * against the gate's own bookkeeping without assuming the thing in question —
 * R31 survived four versions precisely because every number `guard` printed
 * was true. A file on disk is a fact outside that loop.
 */
function twoSubjects(): { home: string; root: string; cap: string; fix: () => void } {
  const home = tmpDir();
  const root = path.join(home, "proj");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({
      subjects: {
        armed: { check: NODE + " mark.js armed 5", captureProperty: "p" },
        bare: { check: NODE + " mark.js bare 7", captureProperty: "q" },
      },
    }),
    "utf8"
  );
  fs.writeFileSync(path.join(home, "corpus.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(home, "journal.jsonl"), "", "utf8");
  fs.writeFileSync(
    path.join(root, "mark.js"),
    'const fs=require("fs"),p=require("path");' +
      'fs.writeFileSync(p.join(__dirname,process.argv[2]+".mark"),"ran");' +
      'let raw="";try{raw=fs.readFileSync(0,"utf8");}catch(e){}' +
      'const bad=fs.readFileSync(p.join(__dirname,"state.txt"),"utf8").trim()==="bad";' +
      'if(bad&&raw.trim()===process.argv[3]){console.log(process.argv[2]+" is wrong");process.exit(1);}' +
      "process.exit(0);",
    "utf8"
  );
  fs.writeFileSync(path.join(root, "state.txt"), "bad", "utf8");
  const cap = path.join(root, "cap.json");
  fs.writeFileSync(cap, JSON.stringify([{ property: "p", counterexample: [5] }]), "utf8");
  // Arming runs the checks; clear the marks so the next run's marks are its own.
  const fix = (): void => {
    fs.writeFileSync(path.join(root, "state.txt"), "good", "utf8");
    for (const f of fs.readdirSync(root)) if (f.endsWith(".mark")) fs.rmSync(path.join(root, f));
  };
  return { home, root, cap, fix };
}

const ranMark = (root: string, name: string): boolean => fs.existsSync(path.join(root, name + ".mark"));

const bothCounterexamples = (cap: string): void =>
  fs.writeFileSync(
    cap,
    JSON.stringify([
      { property: "p", counterexample: [5] },
      { property: "q", counterexample: [7] },
    ]),
    "utf8"
  );

test("a subject with no row and no declared rejection is named as run by nothing", async () => {
  // R31. `verify` enforces active rows *union* standing invariants, so a
  // subject in neither is declared, configured, counted by `validation` as
  // proven — and never executed. Every line the gate printed was accurate on
  // its own terms and the whole was misleading.
  const p = twoSubjects();
  proveSubjects(p.home, p.root);
  withHome(p.home, () => capture(p.root, [p.cap]));
  p.fix();
  const r = await guard(p.root, { ratchetHome: p.home });

  assert.equal(r.steps.find((s) => s.name === "rows")!.ok, true, "the armed row passes");
  assert.ok(ranMark(p.root, "armed"), "the armed subject ran");
  assert.ok(!ranMark(p.root, "bare"), "nothing ran the bare subject");

  const unrun = r.steps.find((s) => s.name === "unrun subjects");
  assert.ok(unrun, "the gate must say so out loud");
  assert.equal(unrun.severity, "warning");
  assert.match(unrun.detail, /nothing runs 1 of 2 declared subject\(s\): bare/);
  assert.equal(r.ok, true, "a subject between rows is not a failing build");

  // Advice a scripted subject can actually take: it has no rules block, so it
  // cannot declare a rejection, and saying otherwise is how warnings stop
  // being read.
  assert.match(unrun.detail, /bare declared in config\.json/);
  assert.doesNotMatch(unrun.detail, /in the rules: rejects/);

  // And the line that used to mislead now carries the qualifier.
  const validation = r.steps.find((s) => s.name === "validation");
  assert.ok(validation);
  assert.match(validation.detail, /bare \(nothing runs it\)/);
  assert.doesNotMatch(validation.detail, /armed \(nothing runs it\)/);
});

test("arming the second subject silences the warning, and it starts running", async () => {
  const p = twoSubjects();
  proveSubjects(p.home, p.root);
  bothCounterexamples(p.cap);
  withHome(p.home, () => capture(p.root, [p.cap]));
  p.fix();
  const r = await guard(p.root, { ratchetHome: p.home });

  assert.ok(ranMark(p.root, "bare"), "the second subject now runs");
  assert.equal(r.steps.find((s) => s.name === "unrun subjects"), undefined);
  const validation = r.steps.find((s) => s.name === "validation");
  assert.ok(validation);
  assert.doesNotMatch(validation.detail, /nothing runs it/);
});

test("archiving a subject's last row brings the warning back", async () => {
  // The silent path R31 named: arm a subject, later retire its last row, keep
  // the history proof. From then on nothing runs it, and until now the gate
  // went on naming it as proven.
  const p = twoSubjects();
  proveSubjects(p.home, p.root);
  bothCounterexamples(p.cap);
  withHome(p.home, () => capture(p.root, [p.cap]));
  const bare = rows(p.home).find((row) => row.subject === "bare");
  assert.ok(bare, "the second subject was armed");
  withHome(p.home, () => accept(p.root, bare.id, "no longer a concern", "test"));
  p.fix();

  const r = await guard(p.root, { ratchetHome: p.home });
  assert.ok(!ranMark(p.root, "bare"), "the retired subject is not run by anything");
  const unrun = r.steps.find((s) => s.name === "unrun subjects");
  assert.ok(unrun, "retiring the last row must not be silent");
  assert.match(unrun.detail, /nothing runs 1 of 2 declared subject\(s\): bare/);
});

test("an unrun prose subject is offered the rejects route instead", async () => {
  // A prose heuristic with no rows and no `rejects` clause is equally unrun,
  // and unlike a scripted subject it can fix that in the rules file.
  const p = project("heuristic h\n  run node x.js\n  measure n the exit code\n  rule n is 0\n");
  proveSubjects(p.home, p.root);
  withHome(p.home, () => capture(p.root, [p.cap]));
  const r = await guard(p.root, { ratchetHome: p.home });
  const unrun = r.steps.find((s) => s.name === "unrun subjects");
  assert.ok(unrun);
  assert.match(unrun.detail, /nothing runs 1 of 2 declared subject\(s\): h/);
  assert.match(unrun.detail, /in the rules: rejects <measure>/);
  assert.doesNotMatch(unrun.detail, /config\.json/);
});

test("the empty-gate warning is not doubled by the unrun one", async () => {
  // When nothing is armed at all, `coverage` already says nothing was
  // checked. Two warnings for one situation is how a gate teaches people to
  // skim it.
  const p = twoSubjects();
  proveSubjects(p.home, p.root);
  const r = await guard(p.root, { ratchetHome: p.home });
  assert.ok(r.steps.find((s) => s.name === "coverage"), "the empty gate still warns");
  assert.equal(r.steps.find((s) => s.name === "unrun subjects"), undefined);
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

test("a shell-mode check names its instrument in any command, not only the first", () => {
  // The detector read `argv[0]` and stopped, so it missed exactly the shape it
  // exists to name: `cd . && node tools/check.js` reaches into the measured
  // tree through its *second* command, and `cd` is not an interpreter.
  assert.deepEqual(instrumentPaths("cd . && node tools/check.js", true), ["tools/check.js"]);
  assert.deepEqual(instrumentPaths("echo hi | node tools/check.js", true), ["tools/check.js"]);
  assert.deepEqual(instrumentPaths("setup ; node tools/check.js", true), ["tools/check.js"]);
  assert.deepEqual(instrumentPaths("node a.js || node b.js", true), ["a.js", "b.js"], "each one is its own finding");

  // A quoted operator belongs to the argument; the shell never sees it.
  assert.deepEqual(instrumentPaths('node -e "a && b"', true), ["a && b"]);
  // And without a shell the operators are ordinary arguments to `cd`.
  assert.deepEqual(instrumentPaths("cd . && node tools/check.js", false), []);
});

test("only the `-c` form of a shell hides a path, not every invocation of one", () => {
  // `sh -c "..."` takes a script body where a path would go, so there is
  // nothing in the tree to name. That was being read as a reason to skip
  // every command whose program is a shell, which hid the plainest shape
  // there is: `bash tools/setup.sh` names a file in the measured tree.
  assert.deepEqual(instrumentPaths('sh -c "node tools/check.js"', true), []);
  assert.deepEqual(instrumentPaths('bash -c "node tools/check.js"', true), []);
  assert.deepEqual(instrumentPaths('bash -lc "node tools/check.js"', true), [], "combined flags too");

  assert.deepEqual(instrumentPaths("bash tools/setup.sh", true), ["tools/setup.sh"]);
  assert.deepEqual(instrumentPaths("cd . && bash tools/setup.sh", true), ["tools/setup.sh"]);
  assert.deepEqual(instrumentPaths("bash --norc tools/setup.sh", true), ["tools/setup.sh"]);
});

test("a chained shell check is reported as a frozen instrument", async () => {
  // The end of the same defect: the warning, not just the path list.
  const p = project();
  fs.writeFileSync(
    path.join(p.home, "config.json"),
    JSON.stringify({ subjects: { s: { check: "cd . && " + NODE + " check.js", shell: true, captureProperty: "p" } } }),
    "utf8"
  );
  const r = await guard(p.root, { ratchetHome: p.home });
  const frozen = r.steps.find((s) => s.name === "frozen instrument");
  assert.ok(frozen, "a chained check reaching into the tree must still be named");
  assert.match(frozen.detail, /check\.js, which is inside that tree/);
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
