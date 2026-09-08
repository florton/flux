import { test } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import {
  canonicalizeClause, parseHeuristics, formatHeuristics, renderHeuristic,
  formatProblem, nearest, PREDICATE_PHRASES,
} from "../src/heuristics";
import { extract, judge, evaluateHeuristic, describePredicate, checkRejection, excerpt } from "../src/evaluate";
import { loadSubjects } from "../src/paths";
import { runCheck } from "../src/runner";
import { toSubject, loadHeuristics } from "../src/heuristic-config";
import { ruleHash } from "../src/rule";
import { fmt } from "../src/heuristics-cmd";
import { installHook, uninstallHook, hookStatus } from "../src/hooks";
import { yieldReport } from "../src/yield";
import { renderComment } from "../src/pr-comment";
import { heuristicVersions, diffCanonical } from "../src/heuristic-history";
import { substituteArgv, substituteShell } from "../src/substitution";
import { observe } from "../src/probe";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-h-"));
}

/** Parse one heuristic block, asserting it had no problems. */
function one(source: string) {
  const r = parseHeuristics(source);
  assert.deepEqual(r.problems.map((p) => `${p.line}: ${p.message}`), [], "unexpected parse problems");
  assert.equal(r.heuristics.length, 1);
  return r.heuristics[0];
}

const HEAD = `heuristic h\n  run node x.js\n`;

/* -------------------------------------------------------------------------- */
/* Canonicalization                                                            */
/* -------------------------------------------------------------------------- */

test("canonicalize: modal verbs become the copula, not nothing", () => {
  // "should be greater than" must not strip to "greater than", which no
  // synonym then matches and which the predicate parser cannot read.
  assert.equal(canonicalizeClause("the edge should be greater than -0.03"), "edge is above -0.03");
  assert.equal(canonicalizeClause("count must be at least 3"), "count is at least 3");
  assert.equal(canonicalizeClause("errors have to be 0"), "errors is 0");
});

test("canonicalize: a negated modal keeps its negation", () => {
  // Stripping "should" out of "should never be above" would invert the rule.
  assert.equal(canonicalizeClause("edge should never be above 0.02"), "edge is not above 0.02");
  assert.equal(canonicalizeClause("tier must not be Standard"), "tier is not Standard");
});

test("canonicalize: operators and ranges", () => {
  assert.equal(canonicalizeClause("count >= 5"), "count is at least 5");
  assert.equal(canonicalizeClause("count <= 5"), "count is at most 5");
  assert.equal(canonicalizeClause("count > 5"), "count is above 5");
  assert.equal(canonicalizeClause("edge is between -0.03 to 0.015"), "edge is between -0.03 and 0.015");
  assert.equal(canonicalizeClause("edge is in the range -0.03 and 0.015"), "edge is between -0.03 and 0.015");
});

test("canonicalize: quoted literals are never rewritten", () => {
  // A synonym reaching inside a string literal would silently change what the
  // rule checks for.
  assert.equal(
    canonicalizeClause('title contains "should be greater than"'),
    'title contains "should be greater than"'
  );
  assert.equal(canonicalizeClause('name starts with "the "'), 'name starts with "the "');
});

test("canonicalize: a bare number in a clause survives literal restoration", () => {
  // The placeholder must not be space-delimited: restoring would match the
  // bare " 1 " in this clause and splice a literal into the middle of a band.
  assert.equal(canonicalizeClause('count is between 1 and 5'), "count is between 1 and 5");
  assert.equal(
    canonicalizeClause('label is "x" and count is between 1 and 5'),
    'label is "x" and count is between 1 and 5'
  );
});

/* -------------------------------------------------------------------------- */
/* Parsing and diagnostics                                                     */
/* -------------------------------------------------------------------------- */

test("parse: a full heuristic block", () => {
  const h = one(
    `heuristic basic-edge
  run      node tools/sim.js
  seed     20260906
  timeout  60000
  measure  edge  the number after "house edge:"
  rule     the edge should be greater than -0.03
  note     the table itself is in docs/strategy.md
  because  the published table puts this near -0.005`
  );
  assert.equal(h.name, "basic-edge");
  assert.equal(h.run, "node tools/sim.js");
  assert.equal(h.seed, 20260906);
  assert.equal(h.timeoutMs, 60000);
  assert.deepEqual(h.measures.map((m) => m.name), ["edge"]);
  assert.deepEqual(h.rules.map((r) => r.text), ["edge is above -0.03"]);
  assert.equal(h.notes.length, 1);
  assert.match(h.because!, /published table/);
});

test("parse: a heuristic with no rule cannot fail, and that is an error", () => {
  // A check that cannot fail is a green light over nothing — the exact thing
  // the validation protocol exists to prevent, caught one step earlier.
  const r = parseHeuristics(`${HEAD}  measure n the exit code\n  note we should really check this\n`);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0].message, /no .rule. clause, so it can never fail/);
  assert.match(r.problems[0].message, /note. lines are prose only/);
});

test("parse: a heuristic with no run command is an error", () => {
  const r = parseHeuristics(`heuristic h\n  measure n the exit code\n  rule n is 0\n`);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0].message, /no .run. command/);
});

test("parse: an unknown keyword suggests the nearest one", () => {
  const r = parseHeuristics(`${HEAD}  mesure n the exit code\n  rule n is 0\n`);
  const p = r.problems.find((x) => /not a clause keyword/.test(x.message));
  assert.ok(p, "expected an unknown-keyword problem");
  assert.equal(p!.suggestion, "measure");
});

test("parse: an unreadable predicate reports line, column and a suggestion", () => {
  const r = parseHeuristics(`${HEAD}  measure n the exit code\n  rule n is abov 5\n`);
  assert.equal(r.problems.length, 1);
  const p = r.problems[0];
  assert.equal(p.line, 4);
  assert.ok(p.column > 1, "column should point past the keyword");
  const rendered = formatProblem("heuristics.rules", p);
  assert.match(rendered, /heuristics\.rules:4:\d+/);
  assert.match(rendered, /\^/, "expected a caret under the offending column");
});

test("parse: a rule over an undeclared measure names the ones that exist", () => {
  const r = parseHeuristics(`${HEAD}  measure edge the exit code\n  rule egde is 0\n`);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0].message, /not a measure of this heuristic \(declared: edge\)/);
  assert.equal(r.problems[0].suggestion, "edge");
});

test("parse: `is the same as` must name a real measure", () => {
  const r = parseHeuristics(`${HEAD}  measure a the exit code\n  rule a is the same as b\n`);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0].message, /names something "h" does not measure/);
});

test("parse: duplicate heuristic names are refused", () => {
  const r = parseHeuristics(
    `heuristic h\n  run x\n  measure n the exit code\n  rule n is 0\nheuristic h\n  run y\n  measure n the exit code\n  rule n is 0\n`
  );
  assert.ok(r.problems.some((p) => /declared twice/.test(p.message)));
});

test("parse: an empty band is refused", () => {
  const r = parseHeuristics(`${HEAD}  measure n the exit code\n  rule n is between 5 and 1\n`);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0].message, /empty band/);
});

test("parse: comments and blank lines are ignored", () => {
  const h = one(`# a comment\n\nheuristic h\n  run node x.js  # trailing comment\n  measure n the exit code\n  rule n is 0\n`);
  assert.equal(h.run, "node x.js");
});

test("parse: a `#` inside a quoted value is a character, not a comment", () => {
  // The silent-false-pass direction. `does not contain "debug # verbose"`
  // truncating to `does not contain "debug` is a *weaker* rule -- the value it
  // then looks for cannot occur -- so the subject passes while the property
  // the file names is violated. That is the one outcome this tool exists to
  // prevent, so both directions are pinned here.
  const lax = one(`${HEAD}  measure line the output\n  rule line does not contain "debug # verbose"\n`);
  assert.equal(lax.rules[0].text, 'line does not contain "debug # verbose"');

  // The other direction truncated into a *stricter* rule, which failed red and
  // so got noticed. Noticed is not correct.
  const strict = one(`${HEAD}  measure line the output\n  rule line contains "debug # verbose"\n`);
  assert.equal(strict.rules[0].text, 'line contains "debug # verbose"');

  // And the rules behave, not just their text: the lax one must refuse output
  // that contains the value it names.
  const seen = new Map<string, never>(Object.entries({ line: "debug # verbose tracing is ON" }) as never);
  assert.equal(judge(lax.rules[0], seen).ok, false, "the truncated rule passed this, which is the false green");
  assert.equal(judge(strict.rules[0], seen).ok, true, "the truncated rule failed this, which is the false red");
});

test("parse: a `#` in a quoted extractor label survives, with or without a leading space", () => {
  // ` #tag` used to mangle into a parse error blaming the extractor phrase;
  // `#tag` worked only because the stripper wanted whitespace before the `#`.
  const spaced = one(`${HEAD}  measure tagged count of lines matching " #tag"\n  rule tagged is 0\n`);
  const tight = one(`${HEAD}  measure tagged count of lines matching "#tag"\n  rule tagged is 0\n`);
  const out = { stdout: "a #tag here\nnone\n", stderr: "", exitCode: 0 };
  assert.equal(extract("tagged", spaced.measures[0].extractor, out).value, 1);
  assert.equal(extract("tagged", tight.measures[0].extractor, out).value, 1);
});

test("parse: a real comment after a quoted value is still stripped", () => {
  // The fix must not go the other way and swallow comments. The quotes here
  // are balanced and closed, so the `#` that follows is a comment.
  const h = one(`${HEAD}  measure n count of lines matching "release"   # only the release lines\n  rule n is 1\n`);
  assert.equal(h.measures.length, 1);
  assert.equal(h.rules[0].text, "n is 1");
  assert.match(renderHeuristic(h), /count of lines matching "release"/);
  assert.doesNotMatch(renderHeuristic(h), /only the release lines/);
});

test("parse: the caret points at the body, not into the alignment `fmt` writes", () => {
  // `bodyColumn` was `keyword.length + 2`, which assumes one space. The
  // canonical form aligns clause bodies into a column, so every caret in a
  // formatted file pointed at whitespace -- in the one form the tool itself
  // produces.
  const r = parseHeuristics(`heuristic caret\n  run      node x.js\n  measure  v      count of lines matching "x"\n  rule     v is abov 5\n`);
  assert.equal(r.problems.length, 1);
  // "  rule     v is abov 5" -- `v` is the 12th column.
  assert.equal(r.problems[0].column, 12);
  const rendered = formatProblem("heuristics.rules", r.problems[0]);
  const [, line, caret] = rendered.split("\n");
  assert.equal(line[caret.indexOf("^")], "v", "the caret must land on the body it is about");
});

test("parse: a caret inside a clause counts tokens, not lengths", () => {
  // The same defect one level down: the extractor's column was
  // `bodyColumn + name.length + 1`, and a `measure` body is canonicalized --
  // whitespace collapsed -- before it is split, so those lengths describe a
  // string the file does not contain.
  const r = parseHeuristics(`heuristic caret\n  run      node x.js\n  measure  v      count of lines mtaching "x"\n`);
  assert.equal(r.problems.length, 1);
  const rendered = formatProblem("heuristics.rules", r.problems[0]);
  const [, line, caret] = rendered.split("\n");
  assert.equal(line.slice(caret.indexOf("^"), caret.indexOf("^") + 5), "count");
});

test("`rejects <measure>` with no value says so, instead of denying the measure", () => {
  // The name lookup wanted `name + " "`, so a body that was *only* the measure
  // name matched nothing and fell through to "not a measure of this heuristic
  // (declared: <that very name>)" -- a message that contradicts itself and
  // suggests the word it just rejected.
  const r = parseHeuristics(`${HEAD}  measure ok count of lines matching "x"\n  rule ok is 0\n  rejects  ok\n`);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0].message, /names no value/);
  assert.doesNotMatch(r.problems[0].message, /is not a measure/);
});

test("`rejects output` with an unquoted tail names the real complaint", () => {
  // Only the fully-quoted form entered this branch, so an unquoted tail fell
  // through to the measure lookup and reported "output is not a measure",
  // sending the author to declare one. That is not what they meant.
  const r = parseHeuristics(`${HEAD}  measure ok count of lines matching "x"\n  rule ok is 0\n  rejects output not-quoted\n`);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0].message, /must be one double-quoted string/);
});

test("parse: every problem is reported, not just the first", () => {
  const r = parseHeuristics(`${HEAD}  measure n the exit code\n  rule n is abov 5\n  rule n is belo 3\n`);
  assert.equal(r.problems.length, 2, "an author fixing a file wants every complaint at once");
});

test("nearest: an unrelated word gets no suggestion", () => {
  assert.equal(nearest("xyzzyplughq", PREDICATE_PHRASES), undefined);
});

/* -------------------------------------------------------------------------- */
/* The rule hash                                                               */
/* -------------------------------------------------------------------------- */

test("rule hash: derived from prose, not from an install path", () => {
  // Hashing the compiled `node {ratchet}/probe.js` command would fold in an
  // absolute path and quarantine every row on a colleague's machine.
  const h = one(`${HEAD}  measure n the exit code\n  rule n is 0\n`);
  const a = ruleHash("h", toSubject(h), "/some/checkout");
  const b = ruleHash("h", toSubject(h), "/a/completely/different/checkout");
  assert.equal(a, b);
  assert.ok(!toSubject(h).check.includes(process.cwd()));
});

test("rule hash: changes when a clause changes", () => {
  const a = one(`${HEAD}  measure n the exit code\n  rule n is 0\n`);
  const b = one(`${HEAD}  measure n the exit code\n  rule n is 1\n`);
  assert.notEqual(ruleHash("h", toSubject(a), "/x"), ruleHash("h", toSubject(b), "/x"));
});

test("rule hash: unchanged by re-alignment and loose wording", () => {
  // A cosmetic edit is not a change of expectation. If it quarantined every
  // row, people would stop touching the file.
  const tight = one(`heuristic h\n  run node x.js\n  measure n the exit code\n  rule n is above 0\n`);
  const loose = one(`heuristic h\n    run     node x.js\n    measure n   the exit code\n    rule    n should be greater than 0\n`);
  assert.equal(ruleHash("h", toSubject(tight), "/x"), ruleHash("h", toSubject(loose), "/x"));
});

test("fmt output round-trips to the same hash", () => {
  const h = one(`heuristic h\n  run node x.js\n  seed 7\n  measure n the exit code\n  rule n is 0\n  because it matters\n`);
  const reparsed = one(renderHeuristic(h));
  assert.equal(ruleHash("h", toSubject(h), "/x"), ruleHash("h", toSubject(reparsed), "/x"));
  assert.equal(formatHeuristics([reparsed]), formatHeuristics([h]), "fmt must be idempotent");
});

/* -------------------------------------------------------------------------- */
/* Extraction                                                                  */
/* -------------------------------------------------------------------------- */

const obs = (stdout: string, exitCode = 0, stderr = "") => ({ stdout, stderr, exitCode });

test("extract: the number after a label", () => {
  assert.equal(extract("e", { kind: "number-after", label: "house edge:" }, obs("house edge: -0.0765\n")).value, -0.0765);
  assert.equal(extract("e", { kind: "number-after", label: "n=" }, obs("n=1.2e3")).value, 1200);
});

test("extract: a missing label says what the command actually printed", () => {
  // "check failed" sends someone to read the script. This sends them to the
  // one line that explains it.
  const r = extract("e", { kind: "number-after", label: "house edge:" }, obs("all good\nnothing here\n"));
  assert.equal(r.value, null);
  assert.match(r.error!, /no "house edge:" in the output/);
  // One separator for every excerpt in the tool, so the shape reads the same
  // whether it is two lines of output or the two ends of two hundred.
  assert.match(r.error!, /the command printed: "all good" \| "nothing here"/);
});

test("extract: a label present but numberless says so distinctly", () => {
  const r = extract("e", { kind: "number-after", label: "edge:" }, obs("edge: unknown"));
  assert.match(r.error!, /found "edge:" in the output but no number after it/);
});

test("extract: json field, including a missing path", () => {
  assert.equal(extract("v", { kind: "json-field", path: "a.b" }, obs('{"a":{"b":42}}')).value, 42);
  assert.equal(extract("v", { kind: "json-field", path: "a" }, obs('{"a":[1,2,3]}')).value, 3, "an array reads as its length");
  const missing = extract("v", { kind: "json-field", path: "a.c" }, obs('{"a":{"b":42}}'));
  assert.equal(missing.value, null);
  assert.match(missing.error!, /has no .a\.c.; it has: b/);
});

test("extract: non-JSON output reports what it saw", () => {
  const r = extract("v", { kind: "json-field", path: "a" }, obs("Error: boom"));
  assert.match(r.error!, /not JSON/);
  assert.match(r.error!, /Error: boom/);
});

test("extract: line count and exit code", () => {
  assert.equal(extract("n", { kind: "line-count", substring: "warn" }, obs("warn a\nok\nWARN b\n")).value, 2);
  assert.equal(extract("n", { kind: "exit-code" }, obs("", 3)).value, 3);
  assert.equal(extract("s", { kind: "output" }, obs("  hi  ")).value, "hi");
});

/* -------------------------------------------------------------------------- */
/* Judgement                                                                   */
/* -------------------------------------------------------------------------- */

function judged(clause: string, value: unknown, others: Record<string, unknown> = {}) {
  const h = one(`${HEAD}  measure v the output\n  measure w the output\n  rule ${clause}\n`);
  const values = new Map<string, never>(Object.entries({ v: value, ...others }) as never);
  return judge(h.rules[0], values);
}

test("judge: numeric predicates", () => {
  assert.equal(judged("v is above 5", 6).ok, true);
  assert.equal(judged("v is above 5", 5).ok, false);
  assert.equal(judged("v is at least 5", 5).ok, true);
  assert.equal(judged("v is below 5", 4).ok, true);
  assert.equal(judged("v is at most 5", 5).ok, true);
  assert.equal(judged("v is between -0.03 and 0.015", -0.0765).ok, false);
  assert.equal(judged("v is between -0.03 and 0.015", -0.005).ok, true);
});

test("judge: the witness states the measured value", () => {
  // The number is the point: "-0.0765" is reproducible evidence, "failed" is
  // an invitation to go and re-derive it.
  const j = judged("v is between -0.03 and 0.015", -0.0765);
  assert.match(j.witness, /v measured -0\.0765/);
  assert.match(j.witness, /rule says "v is between -0\.03 and 0\.015"/);
});

test("judge: within-percent, and its meaning against zero", () => {
  assert.equal(judged("v is within 10 percent of 100", 105).ok, true);
  assert.equal(judged("v is within 10 percent of 100", 120).ok, false);
  // A ratio to zero has no meaning; equality is the only honest reading.
  assert.equal(judged("v is within 10 percent of 0", 0).ok, true);
  assert.equal(judged("v is within 10 percent of 0", 0.001).ok, false);
});

test("judge: string predicates", () => {
  assert.equal(judged('v contains "ok"', "it is ok").ok, true);
  assert.equal(judged('v does not contain "ok"', "it is ok").ok, false);
  assert.equal(judged('v starts with "ab"', "abc").ok, true);
  assert.equal(judged('v ends with "bc"', "abc").ok, true);
  assert.equal(judged("v is one of a, b, c", "b").ok, true);
  assert.equal(judged("v is one of a, b, c", "d").ok, false);
  assert.equal(judged("v is not Standard", "Heavy").ok, true);
});

test("judge: a non-numeric value under a numeric rule fails and says why", () => {
  const j = judged("v is above 5", "banana");
  assert.equal(j.ok, false);
  assert.match(j.witness, /which is not a number/);
});

test("judge: a relational rule compares two measures", () => {
  assert.equal(judged("v is the same as w", 5, { w: 5 }).ok, true);
  assert.equal(judged("v is the same as w", 5, { w: 6 }).ok, false);
});

test("evaluate: an unmeasurable value is a failure, reported once", () => {
  // Greening a heuristic whose instrument stopped producing the number is the
  // exact false pass this tool exists to prevent — and saying it once per rule
  // buries the fact that there is one broken instrument.
  const h = one(
    `${HEAD}  measure edge the number after "edge:"\n  rule edge is above -0.03\n  rule edge is below 0.015\n`
  );
  const e = evaluateHeuristic(h, obs("nothing useful here"));
  assert.ok(e.failure);
  assert.equal(e.failure!.split(";").length, 1, "one broken instrument, one message");
  assert.match(e.failure!, /edge could not be measured/);
});

test("evaluate: every failing rule is reported, not just the first", () => {
  const h = one(`${HEAD}  measure n the exit code\n  rule n is above 5\n  rule n is below 0\n`);
  const e = evaluateHeuristic(h, obs("", 3));
  assert.equal(e.failure!.split("; ").length, 2);
});

test("evaluate: readings are printed on success, so a green run still shows its numbers", () => {
  const h = one(`${HEAD}  measure n the exit code\n  rule n is 0\n`);
  const e = evaluateHeuristic(h, obs("", 0));
  assert.equal(e.failure, null);
  assert.deepEqual(e.readings, ["n=0"]);
});

test("describePredicate covers every predicate kind", () => {
  const clauses = [
    "v is 3", "v is not 3", "v is one of a, b", "v is above 1", "v is below 1",
    "v is at least 1", "v is at most 1", "v is between 1 and 2", "v is within 5 percent of 10",
    'v contains "x"', 'v does not contain "x"', 'v starts with "x"', 'v ends with "x"',
    "v is empty", "v is not empty", "v is a number", "v is the same as w",
  ];
  for (const c of clauses) {
    const h = one(`${HEAD}  measure v the output\n  measure w the output\n  rule ${c}\n`);
    assert.ok(describePredicate(h.rules[0].predicate).length > 0, c);
  }
});

/* -------------------------------------------------------------------------- */
/* The probe, end to end                                                       */
/* -------------------------------------------------------------------------- */

const NODE = process.execPath;
const PROBE = path.join(__dirname, "..", "src", "probe.js");

/** A ratchet home plus a project root, with a rules file and an instrument. */
function project(rules: string, instrument?: string): { home: string; root: string } {
  const dir = tmpDir();
  const home = path.join(dir, ".ratchet");
  const root = path.join(dir, "proj");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ subjects: {} }), "utf8");
  fs.writeFileSync(path.join(home, "corpus.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(home, "journal.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(home, "heuristics.rules"), rules, "utf8");
  if (instrument !== undefined) fs.writeFileSync(path.join(root, "sim.js"), instrument, "utf8");
  return { home, root };
}

function runProbe(p: { home: string; root: string }, name: string, input = "null") {
  const r = spawnSync(NODE, [PROBE, name], {
    cwd: p.root,
    input,
    encoding: "utf8",
    env: { ...process.env, RATCHET_HOME: p.home, RATCHET_PROJECT_ROOT: p.root },
  });
  return { status: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

test("probe: a satisfied rule exits 0 and prints the readings", () => {
  const p = project(
    `heuristic edge\n  run ${JSON.stringify(NODE)} sim.js\n  measure e the number after "edge:"\n  rule e is between -0.03 and 0.015\n`,
    'console.log("edge: -0.005")'
  );
  const r = runProbe(p, "edge");
  assert.equal(r.status, 0);
  assert.equal(r.out, "e=-0.005");
});

test("probe: a violated rule exits 1 with the measured number as the witness", () => {
  const p = project(
    `heuristic edge\n  run ${JSON.stringify(NODE)} sim.js\n  measure e the number after "edge:"\n  rule e is between -0.03 and 0.015\n  because the published table puts this near -0.005\n`,
    'console.log("edge: -0.0765")'
  );
  const r = runProbe(p, "edge");
  assert.equal(r.status, 1);
  assert.match(r.out, /e measured -0\.0765/);
  assert.match(r.out, /because: the published table/);
});

test("probe: `applies when ... exists` reports n/a, not a failure", () => {
  // Replay across history needs this: a check that cannot apply to an old
  // commit must not be scored as a bug there.
  const p = project(
    `heuristic edge\n  run ${JSON.stringify(NODE)} sim.js\n  applies when feature.js exists\n  measure e the exit code\n  rule e is 0\n`,
    'console.log("hi")'
  );
  const r = runProbe(p, "edge");
  assert.equal(r.status, 125);
  assert.match(r.out, /n\/a: feature\.js does not exist here/);
});

test("probe: a crashing instrument is a failure that names the instrument", () => {
  const p = project(
    `heuristic edge\n  run ${JSON.stringify(NODE)} sim.js\n  measure e the number after "edge:"\n  rule e is 0\n`,
    'throw new Error("boom")'
  );
  const r = runProbe(p, "edge");
  assert.equal(r.status, 1);
  assert.match(r.out, /exited 1 before any rule could be checked/);
  assert.match(r.out, /measure status exit code/, "should say how to make a nonzero exit expected");
});

test("probe: a heuristic that measures the exit code tolerates a nonzero one", () => {
  const p = project(
    `heuristic status\n  run ${JSON.stringify(NODE)} sim.js\n  measure code the exit code\n  rule code is 3\n`,
    "process.exit(3)"
  );
  assert.equal(runProbe(p, "status").status, 0);
});

test("probe: a command that cannot be spawned fails loudly", () => {
  const p = project(
    `heuristic edge\n  run definitely-not-a-real-command-xyz\n  measure e the exit code\n  rule e is 0\n`
  );
  const r = runProbe(p, "edge");
  assert.equal(r.status, 1);
  assert.match(r.out, /could not run/);
});

test("probe: an unparseable rules file refuses rather than passing", () => {
  const p = project(`heuristic edge\n  run x\n  measure e the exit code\n  rule e is abov 5\n`);
  const r = runProbe(p, "edge");
  assert.equal(r.status, 1, "a heuristic that stopped parsing must never be green");
  assert.match(r.out, /Nothing was checked/);
});

test("probe: an unknown heuristic name lists the ones that exist", () => {
  const p = project(`heuristic edge\n  run x\n  measure e the exit code\n  rule e is 0\n`);
  const r = runProbe(p, "nope");
  assert.equal(r.status, 1);
  assert.match(r.out, /it declares: edge/);
});

test("probe: `seed` makes a Math.random instrument reproducible", () => {
  // Every field experiment that measured a simulation hand-rolled this. A band
  // over an unseeded simulation is measuring noise.
  const instrument = 'let s=0; for(let i=0;i<1000;i++) s+=Math.random(); console.log("total: "+s.toFixed(6))';
  const seeded = project(
    `heuristic sum\n  run ${JSON.stringify(NODE)} sim.js\n  seed 12345\n  measure t the number after "total:"\n  rule t is above 0\n`,
    instrument
  );
  const a = runProbe(seeded, "sum");
  const b = runProbe(seeded, "sum");
  assert.equal(a.status, 0);
  assert.equal(a.out, b.out, "the same seed must give the same reading");

  const unseeded = project(
    `heuristic sum\n  run ${JSON.stringify(NODE)} sim.js\n  measure t the number after "total:"\n  rule t is above 0\n`,
    instrument
  );
  assert.notEqual(runProbe(unseeded, "sum").out, runProbe(unseeded, "sum").out);
});

test("probe: a different seed gives a different reading", () => {
  const instrument = 'let s=0; for(let i=0;i<1000;i++) s+=Math.random(); console.log("total: "+s.toFixed(6))';
  const rules = (seed: number) =>
    `heuristic sum\n  run ${JSON.stringify(NODE)} sim.js\n  seed ${seed}\n  measure t the number after "total:"\n  rule t is above 0\n`;
  const a = runProbe(project(rules(1), instrument), "sum");
  const b = runProbe(project(rules(2), instrument), "sum");
  assert.notEqual(a.out, b.out);
});

test("probe: the row input reaches the instrument on stdin and in the environment", () => {
  const p = project(
    `heuristic echo\n  run ${JSON.stringify(NODE)} sim.js\n  measure v the json field got\n  rule v is 42\n`,
    'const raw=require("fs").readFileSync(0,"utf8"); console.log(JSON.stringify({got: JSON.parse(raw).n, env: process.env.RATCHET_INPUT}))'
  );
  assert.equal(runProbe(p, "echo", JSON.stringify({ n: 42 })).status, 0);
});

/* -------------------------------------------------------------------------- */
/* Config merging                                                              */
/* -------------------------------------------------------------------------- */

test("loadSubjects merges prose heuristics with scripted subjects", () => {
  const p = project(`heuristic prose-one\n  run x\n  measure e the exit code\n  rule e is 0\n`);
  fs.writeFileSync(
    path.join(p.home, "config.json"),
    JSON.stringify({ subjects: { scripted: { check: "node check.js" } } }),
    "utf8"
  );
  const config = loadSubjects(p.home);
  assert.deepEqual(Object.keys(config.subjects).sort(), ["prose-one", "scripted"]);
  assert.ok(config.fromRules.has("prose-one"));
  assert.ok(!config.fromRules.has("scripted"));
});

test("loadSubjects refuses a rules file that will not parse", () => {
  // Carrying on with the heuristics that happened to parse would mean a
  // mistyped clause silently stops enforcing while the build stays green.
  const p = project(`heuristic h\n  run x\n  measure e the exit code\n  rule e is abov 5\n`);
  assert.throws(() => loadSubjects(p.home), /Nothing was checked/);
});

test("loadSubjects reports a name declared in both places rather than resolving it", () => {
  const p = project(`heuristic both\n  run x\n  measure e the exit code\n  rule e is 0\n`);
  fs.writeFileSync(
    path.join(p.home, "config.json"),
    JSON.stringify({ subjects: { both: { check: "node check.js" } } }),
    "utf8"
  );
  const config = loadSubjects(p.home);
  assert.deepEqual(config.collisions, ["both"]);
  assert.equal(config.subjects.both.check, "node check.js", "config.json wins, so behavior never changes underneath a project");
});

test("loadSubjects explains a config.json that is not valid JSON", () => {
  const p = project(`heuristic h\n  run x\n  measure e the exit code\n  rule e is 0\n`);
  fs.writeFileSync(path.join(p.home, "config.json"), "{ not json", "utf8");
  assert.throws(() => loadSubjects(p.home), /is not valid JSON/);
});

/* -------------------------------------------------------------------------- */
/* fmt                                                                         */
/* -------------------------------------------------------------------------- */

test("fmt rewrites loose wording and reports each clause it moved", () => {
  const p = project(`heuristic h\n  run node x.js\n  measure n the exit code\n  rule the n should be greater than 5\n`);
  const r = fmt(p.home, { write: true });
  assert.equal(r.changed, true);
  assert.equal(r.rewrites.length, 1);
  assert.equal(r.rewrites[0].before, "the n should be greater than 5");
  assert.equal(r.rewrites[0].after, "n is above 5");
  assert.match(fs.readFileSync(path.join(p.home, "heuristics.rules"), "utf8"), /rule\s+n is above 5/);
});

test("fmt preserves comments and the author's clause order", () => {
  // A formatter that deletes the reasoning written beside a rule is a
  // formatter nobody runs twice — and the reasoning is half of why the prose
  // form exists at all.
  const source = [
    "# Owned by the QA group, not the simulator team.",
    "",
    "heuristic h",
    "  # 200k hands is where the variance stops mattering",
    "  run node x.js",
    "  measure n the exit code",
    "  # widened in March, after the surrender rules landed",
    "  rule n should be above 5",
    "",
  ].join("\n");
  const p = project(source);
  fmt(p.home, { write: true });
  const after = fs.readFileSync(path.join(p.home, "heuristics.rules"), "utf8");

  assert.match(after, /Owned by the QA group/);
  assert.match(after, /200k hands is where the variance/);
  assert.match(after, /widened in March/);
  assert.match(after, /rule\s+n is above 5/, "the clause is still canonicalized");
  // The March comment introduces the rule; it must not drift away from it.
  const lines = after.split(/\r?\n/);
  const comment = lines.findIndex((l) => /widened in March/.test(l));
  assert.match(lines[comment + 1], /rule/);
});

test("comments and layout are presentation: they never change the rule hash", () => {
  // If re-commenting or re-aligning a file quarantined every row in the
  // repository, people would stop touching the file — which is the opposite
  // of what a prose spec is for.
  const bare = one("heuristic h\n  run node x.js\n  measure n the exit code\n  rule n is above 5\n");
  const commented = one(
    [
      "# a heading",
      "heuristic h",
      "  # why we run it",
      "  run     node x.js",
      "",
      "  measure n   the exit code",
      "  # why this bound",
      "  rule    n is above 5",
    ].join("\n")
  );
  assert.equal(ruleHash("h", toSubject(bare), "/x"), ruleHash("h", toSubject(commented), "/x"));
});

test("a rules file of nothing but comments is already canonical", () => {
  // `ratchet init` writes exactly that, and a tool whose first run complains
  // about its own scaffolding teaches people to ignore its warnings.
  const p = project("# write your first heuristic here\n#\n#   heuristic name\n");
  assert.equal(fmt(p.home, { write: false }).changed, false);
});

test("fmt is idempotent", () => {
  const p = project(`heuristic h\n  run node x.js\n  measure n the exit code\n  rule n should be at least 5\n`);
  fmt(p.home, { write: true });
  assert.equal(fmt(p.home, { write: true }).changed, false);
});

/* -------------------------------------------------------------------------- */
/* Hooks                                                                       */
/* -------------------------------------------------------------------------- */

function gitRepo(): string {
  const dir = tmpDir();
  spawnSync("git", ["init", "-q", "."], { cwd: dir });
  return dir;
}

test("hooks: install, status, uninstall round-trip", () => {
  const repo = gitRepo();
  assert.equal(hookStatus(repo).installed, false);
  const installed = installHook(repo, { command: "ratchet guard --quiet" });
  assert.equal(installed.action, "installed");
  assert.equal(hookStatus(repo).installed, true);
  assert.match(fs.readFileSync(installed.path, "utf8"), /ratchet guard --quiet/);
  assert.equal(uninstallHook(repo).action, "removed");
  assert.equal(hookStatus(repo).installed, false);
});

test("hooks: installing twice does not duplicate the block", () => {
  const repo = gitRepo();
  installHook(repo, { command: "ratchet guard --quiet" });
  installHook(repo, { command: "ratchet guard --quiet" });
  const text = fs.readFileSync(hookStatus(repo).path, "utf8");
  assert.equal(text.split("ratchet guard --quiet").length - 1, 1);
});

test("hooks: an existing shell hook is appended to, never replaced", () => {
  // Clobbering a colleague's hook to install a quality gate would be its own
  // small regression.
  const repo = gitRepo();
  const file = path.join(repo, ".git", "hooks", "pre-commit");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "#!/bin/sh\necho theirs\n", "utf8");
  installHook(repo, { command: "ratchet guard --quiet" });
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /echo theirs/);
  assert.match(text, /ratchet guard/);
  uninstallHook(repo);
  assert.match(fs.readFileSync(file, "utf8"), /echo theirs/, "uninstall must leave their hook intact");
});

test("hooks: a non-shell hook is refused with instructions rather than clobbered", () => {
  const repo = gitRepo();
  const file = path.join(repo, ".git", "hooks", "pre-commit");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "#!/usr/bin/env python3\nprint('theirs')\n", "utf8");
  const r = installHook(repo, { command: "ratchet guard --quiet" });
  assert.equal(r.action, "refused");
  assert.match(r.detail, /Add this line to it yourself/);
  assert.match(fs.readFileSync(file, "utf8"), /print\('theirs'\)/);
});

/* -------------------------------------------------------------------------- */
/* Yield, history, and the PR comment                                          */
/* -------------------------------------------------------------------------- */

test("yield: a subject with no evidence is distinguished from a stale one", () => {
  const p = project(`heuristic quiet\n  run x\n  measure e the exit code\n  rule e is 0\n`);
  const old = new Date(Date.now() - 200 * 24 * 3600 * 1000).toISOString();
  fs.writeFileSync(
    path.join(p.home, "corpus.jsonl"),
    JSON.stringify({ op: "capture", id: "cabc", at: old, subject: "quiet", input: null, source: "manual" }) + "\n",
    "utf8"
  );
  const config = loadSubjects(p.home);
  const r = yieldReport(p.home, config, new Set(), { staleAfterDays: 90, fromRules: config.fromRules });
  assert.equal(r.stale.length, 1);
  assert.equal(r.neverFired.length, 0);
  assert.ok(r.subjects[0].quietDays! > 90);
});

test("yield: a subject that has never produced a counterexample is flagged separately", () => {
  const p = project(`heuristic fresh\n  run x\n  measure e the exit code\n  rule e is 0\n`);
  const config = loadSubjects(p.home);
  const r = yieldReport(p.home, config, new Set(), { fromRules: config.fromRules });
  assert.equal(r.neverFired.length, 1);
  assert.equal(r.stale.length, 0);
});

test("diffCanonical names the clause that moved", () => {
  const d = diffCanonical("heuristic h\n  rule n is above 5", "heuristic h\n  rule n is above 9");
  assert.deepEqual(d, ["- rule n is above 5", "+ rule n is above 9"]);
});

test("heuristicVersions collapses commits that left the heuristic alone", () => {
  const repo = gitRepo();
  spawnSync("git", ["config", "user.email", "t@e.st"], { cwd: repo });
  spawnSync("git", ["config", "user.name", "T"], { cwd: repo });
  const home = path.join(repo, ".ratchet");
  fs.mkdirSync(home, { recursive: true });
  const rules = path.join(home, "heuristics.rules");
  const write = (band: string) =>
    fs.writeFileSync(rules, `heuristic h\n  run node x.js\n  measure n the exit code\n  rule n is above ${band}\n`, "utf8");

  write("5");
  spawnSync("git", ["add", "-A"], { cwd: repo });
  spawnSync("git", ["commit", "-qm", "add h"], { cwd: repo });
  // A commit touching the file without changing this heuristic must not appear.
  fs.appendFileSync(rules, "\n# an unrelated comment\n", "utf8");
  spawnSync("git", ["add", "-A"], { cwd: repo });
  spawnSync("git", ["commit", "-qm", "comment"], { cwd: repo });
  write("9");
  spawnSync("git", ["add", "-A"], { cwd: repo });
  spawnSync("git", ["commit", "-qm", "widen h"], { cwd: repo });

  const versions = heuristicVersions(repo, home, "h");
  assert.equal(versions.length, 2, "two real changes, not three commits");
  assert.equal(versions[0].message, "add h");
  assert.equal(versions[1].message, "widen h");
  assert.notEqual(versions[0].ruleHash, versions[1].ruleHash);
});

test("pr-comment states the verdict, the witness and the caught/new split", () => {
  const md = renderComment({
    results: [
      { id: "cabc123456789", subject: "basic-edge", outcome: "fail", pass: false, reason: "edge measured -0.0765" },
      { id: "cdef123456789", subject: "other", outcome: "pass", pass: true },
    ],
    report: {
      rows: 2, active: 2, archived: 0, newThisWeek: 1, caughtThisWeek: 3, catchRateThisWeek: 75,
      novelAllTime: 9, caughtAllTime: 21, catchRateAllTime: 70, bySource: {}, journalEntries: 0,
      accepts: 0, reopens: 0, orphans: [], unreadableLines: 0, latestCaptures: [],
    },
  });
  assert.match(md, /\*\*1 regression\*\*/);
  assert.match(md, /edge measured -0\.0765/);
  assert.match(md, /caught by corpus: \*\*3\*\* \(75%\)/);
  assert.match(md, /all time: 21 caught, 9 new/);
});

test("pr-comment escapes a pipe so the table survives", () => {
  const md = renderComment({
    results: [{ id: "cabc", subject: "s", outcome: "fail", pass: false, reason: "a | b\nsecond line" }],
    report: {
      rows: 1, active: 1, archived: 0, newThisWeek: 0, caughtThisWeek: 0, catchRateThisWeek: null,
      novelAllTime: 0, caughtAllTime: 0, catchRateAllTime: null, bySource: {}, journalEntries: 0,
      accepts: 0, reopens: 0, orphans: [], unreadableLines: 0, latestCaptures: [],
    },
  });
  const row = md.split("\n").find((l) => l.includes("cabc"))!;
  assert.match(row, /a \\\| b second line/);
});

test("shell mode substitutes {home} and {ratchet}, but never {test}", () => {
  // A `--setup` script runs through a shell, and a build script added last
  // month does not exist in a worktree checked out at a commit from last
  // year — so {home} must resolve outside the tree being measured. The test
  // name stays out: it comes from a test file and can contain anything.
  const dir = tmpDir();
  const script = path.join(dir, "echo.js");
  fs.writeFileSync(script, 'console.log("ran from " + process.argv[2]);', "utf8");

  const ok = runCheck(`node "{home}/echo.js" marker`, null, { cwd: dir, shell: true, homeDir: dir });
  assert.equal(ok.outcome, "pass", ok.reason);
  assert.match(ok.reason, /ran from marker/);

  const refused = runCheck('node "{home}/echo.js" {test}', null, {
    cwd: dir, shell: true, homeDir: dir, testName: "x",
  });
  assert.equal(refused.outcome, "fail");
  assert.match(refused.reason, /read RATCHET_TEST instead/);
});

test("shell mode refuses a home path that could break out of the command", () => {
  const evil = runCheck('echo "{home}"', null, { cwd: process.cwd(), shell: true, homeDir: 'a"b' });
  assert.equal(evil.outcome, "fail");
  assert.match(evil.reason, /shell metacharacter/);
});

test("loadHeuristics on a directory with no rules file is not an error", () => {
  const dir = tmpDir();
  const loaded = loadHeuristics(dir);
  assert.equal(loaded.exists, false);
  assert.deepEqual(loaded.heuristics, []);
});

/* -------------------------------------------------------------------------- */
/* The path-token vocabulary, and every spawn path reaching it                 */
/* -------------------------------------------------------------------------- */

test("substituteArgv fills a token as exactly one argv element", () => {
  // Whole-token, so a path with a space in it can never split into two
  // arguments or turn into shell syntax.
  assert.deepEqual(
    substituteArgv(["node", "{home}/tools/e2e.js", "{ratchet}/probe.js"], {
      home: "C:\Program Files\home",
      ratchet: "/opt/ratchet",
    }),
    ["node", "C:\Program Files\home/tools/e2e.js", "/opt/ratchet/probe.js"]
  );
});

test("substituteArgv leaves a token alone when nothing binds it", () => {
  assert.deepEqual(substituteArgv(["node", "{home}/x.js"], {}), ["node", "{home}/x.js"]);
});

test("substituteShell refuses a path that would change the shape of the command", () => {
  const evil = substituteShell('echo "{home}"', { home: 'a"b' });
  assert.ok("error" in evil && /shell metacharacter/.test(evil.error));
  const fine = substituteShell("node {home}/x.js", { home: "/tmp/h" });
  assert.deepEqual(fine, { command: "node /tmp/h/x.js" });
});

test("a prose heuristic reaches an instrument that lives only in the home", () => {
  // The frozen-instrument mechanism, on the *prose* path. Until v0.8 the
  // probe substituted neither token, so `run node {home}/tools/audit.js` was
  // expressible in config.json and nowhere in prose — a heuristic could only
  // ever run a script out of the tree it was measuring.
  const home = tmpDir();
  const project = tmpDir();
  fs.mkdirSync(path.join(home, "tools"), { recursive: true });
  fs.writeFileSync(path.join(home, "tools", "audit.js"), 'console.log("findings: 0");', "utf8");

  const h = one(`heuristic carried\n  run ${JSON.stringify(NODE)} "{home}/tools/audit.js"\n  measure f number after "findings:"\n  rule f is 0\n`);
  const observed = observe(h, project, null, {}, { home, ratchet: __dirname });
  assert.ok(!("spawnError" in observed), "spawnError" in observed ? observed.spawnError : "");
  assert.equal((observed as { exitCode: number }).exitCode, 0);
  assert.match((observed as { stdout: string }).stdout, /findings: 0/);
});

test("an unsubstituted {home} is a spawn failure, not a silent pass", () => {
  const project = tmpDir();
  const h = one(`heuristic carried\n  run ${JSON.stringify(NODE)} "{home}/tools/audit.js"\n  measure f number after "findings:"\n  rule f is 0\n`);
  const observed = observe(h, project, null, {}, {});
  const failed = "spawnError" in observed || (observed as { exitCode: number }).exitCode !== 0;
  assert.ok(failed, "a heuristic whose instrument could not be found must not report a reading");
});

/* -------------------------------------------------------------------------- */
/* Declared rejections — proof without history                                 */
/* -------------------------------------------------------------------------- */

test("a declared rejection the rules refuse parses clean and is recorded", () => {
  const h = one(
    `heuristic monty-hall
  run      node deal.js
  measure  keep  number after "Keep wins:"
  rule     keep is between 3200000 and 3500000
  rejects  keep 5000000
  because  Monty Hall is 1/3 keep and 2/3 switch, an outside truth
`
  );
  assert.equal(h.rejects.length, 1);
  assert.deepEqual(h.rejects[0], {
    kind: "reading",
    measure: "keep",
    value: "5000000",
    line: 5,
    // Where the body actually starts. `rejects` ends at column 9 and the
    // canonical alignment puts two spaces after it, so `keep` is at 12 — the
    // keyword's length plus one would point into the gap.
    column: 12,
    text: "keep 5000000",
  });
  const check = checkRejection(h, h.rejects[0]);
  assert.equal(check.ok, true);
  assert.match(check.refusedBy[0], /keep measured 5000000/);
});

test("a declared rejection the rules ACCEPT is a parse error with a line and a column", () => {
  // A proof that does not prove anything is caught the same way a clause that
  // does not parse is. Without this the second proof tier would be a comment.
  const r = parseHeuristics(
    `heuristic bad
  run      node x.js
  measure  keep  number after "Keep wins:"
  rule     keep is between 3200000 and 3500000
  rejects  keep 3300000
`
  );
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0].line, 5);
  assert.equal(r.problems[0].column, 12);
  assert.match(r.problems[0].message, /every rule accepts it/);
  assert.match(formatProblem("heuristics.rules", r.problems[0]), /heuristics\.rules:5:12/);
});

test("a rejection naming a measure with no rule about it is refused", () => {
  const r = parseHeuristics(
    `heuristic h
  run      node x.js
  measure  keep   number after "Keep:"
  measure  other  number after "Other:"
  rule     other is 1
  rejects  keep 5
`
  );
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0].message, /no rule says anything about keep/);
});

test("a rejection judged only by relational rules says to use the output form", () => {
  const r = parseHeuristics(
    `heuristic rel
  run      node x.js
  measure  a  number after "A:"
  measure  b  number after "B:"
  rule     a is above b
  rejects  a 1
`
  );
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0].message, /one reading does not settle the verdict/);
});

test("rejects output runs the whole pipeline against a fabricated reading", () => {
  const h = one(
    `heuristic monty-hall
  run      node deal.js
  measure  change  the first number after "Win percent:"
  measure  keep    the second number after "Win percent:"
  rule     change is above keep
  rejects  output "Win percent: 33.3\\nWin percent: 66.6"
`
  );
  assert.equal(h.rejects.length, 1);
  assert.equal(h.rejects[0].kind, "output");
  const check = checkRejection(h, h.rejects[0]);
  assert.equal(check.ok, true, check.problem);
  assert.match(check.refusedBy[0], /change measured 33\.3 and keep measured 66\.6/);
});

test("a fabricated output the extractors cannot read is not a proof", () => {
  // "The extractor found nothing" would otherwise pass for a proof that the
  // band discriminates, which is exactly the vacuity the gate exists to catch.
  const r = parseHeuristics(
    `heuristic weak
  run      node x.js
  measure  keep  number after "Keep wins:"
  rule     keep is between 1 and 5
  rejects  output "total nonsense"
`
  );
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0].message, /no rule ever judged it/);
  assert.match(r.problems[0].message, /proves nothing about the rules/);
});

test("rejects survives a fmt round trip", () => {
  const source = `heuristic h
  run      node x.js
  measure  f  number after "findings:"
  rule     f is 0
  rejects  f 1
  rejects  output "findings: 9"
`;
  const parsed = parseHeuristics(source);
  assert.deepEqual(parsed.problems, []);
  const rendered = formatHeuristics(parsed.heuristics);
  const again = parseHeuristics(rendered);
  assert.deepEqual(again.problems, []);
  assert.equal(formatHeuristics(again.heuristics), rendered, "canonical form is a fixed point");
  assert.equal(again.heuristics[0].rejects.length, 2);
});

test("a rejects clause does not move the rule hash", () => {
  // The hash says what a row is pinned to, and a declared rejection changes
  // neither what is measured nor how it is judged. Folding it in would
  // quarantine every row in a repository the moment somebody strengthened a
  // proof — punishing exactly the behavior the second tier exists to invite.
  const dir = tmpDir();
  const before = one(`heuristic h\n  run node x.js\n  measure f number after "f:"\n  rule f is 0\n`);
  const after = one(`heuristic h\n  run node x.js\n  measure f number after "f:"\n  rule f is 0\n  rejects f 1\n`);
  assert.equal(ruleHash("h", toSubject(before), dir), ruleHash("h", toSubject(after), dir));

  const moved = one(`heuristic h\n  run node x.js\n  measure f number after "f:"\n  rule f is 1\n  rejects f 0\n`);
  assert.notEqual(ruleHash("h", toSubject(before), dir), ruleHash("h", toSubject(moved), dir));
});

/* -------------------------------------------------------------------------- */
/* The nth match, and comparing two measures                                   */
/* -------------------------------------------------------------------------- */

test("an extractor can read the nth appearance of a label", () => {
  const e = { kind: "number-after", label: "Win percent:", occurrence: 2 } as const;
  assert.equal(extract("keep", e, obs("Win percent: 33.3\nWin percent: 66.6")).value, 66.6);
  const missing = extract("keep", e, obs("Win percent: 33.3"));
  assert.equal(missing.value, null);
  assert.match(missing.error!, /fewer than 2 "Win percent:" in the output/);
});

test("the ordinal is parsed, canonicalized and rendered back", () => {
  const h = one(
    `heuristic h
  run      node x.js
  measure  keep  the second number after "Win percent:"
  rule     keep is above 0
`
  );
  assert.deepEqual(h.measures[0].extractor, {
    kind: "number-after",
    label: "Win percent:",
    occurrence: 2,
  });
  assert.match(renderHeuristic(h), /2nd number after "Win percent:"/);
  // A mismatched suffix is spelling, not a refusal: fmt snaps it.
  const sloppy = one(`heuristic h\n  run node x.js\n  measure k 2st number after "X:"\n  rule k is 0\n`);
  assert.match(renderHeuristic(sloppy), /2nd number after/);
});

test("a comparison can name another measure instead of a number", () => {
  // The natural rule for Monty Hall is "change is above keep". The vocabulary
  // had `is the same as` and nothing else, so the only way to write it was to
  // band the raw counts against the instrument's iteration count — coupling a
  // rule that is always true to a number that is free to change.
  const h = one(
    `heuristic h
  run      node x.js
  measure  change  number after "change:"
  measure  keep    number after "keep:"
  rule     change is above keep
`
  );
  assert.deepEqual(h.rules[0].predicate, { kind: "compare", op: "above", measure: "keep" });
  assert.equal(describePredicate(h.rules[0].predicate), "is above keep");
  assert.equal(evaluateHeuristic(h, obs("change: 66\nkeep: 33")).failure, null);
  assert.match(
    evaluateHeuristic(h, obs("change: 33\nkeep: 66")).failure!,
    /change measured 33 and keep measured 66/
  );
});

test("a comparison against a measure that does not exist is a parse error", () => {
  const r = parseHeuristics(
    `heuristic h
  run      node x.js
  measure  a  number after "a:"
  rule     a is above b
`
  );
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0].message, /needs a number or another measure/);
});

test("an unreadable measure on the far side of a comparison is named once", () => {
  const h = one(
    `heuristic h
  run      node x.js
  measure  change  number after "change:"
  measure  keep    number after "keep:"
  rule     change is above keep
`
  );
  const e = evaluateHeuristic(h, obs("change: 66"));
  assert.deepEqual(e.unreadable, ["keep"]);
  assert.deepEqual(e.ruleFailures, [], "the rule is not judged twice over a number nobody could read");
  assert.match(e.failure!, /keep could not be measured: no "keep:" in the output/);
});

test("monty-hall is expressible as it is meant to be read", () => {
  // The acceptance case for the vocabulary work: two `Win percent:` readings
  // and `change is above keep`, with no dependence on the iteration count —
  // and a declared rejection standing in for a bug this repository never had.
  const h = one(
    `heuristic monty-hall
  run      node deal.js
  measure  keep    the first number after "Win percent:"
  measure  change  the second number after "Win percent:"
  rule     change is above keep
  rule     change is between 65 and 68
  rejects  output "Win percent: 66.6\\nWin percent: 33.3"
  because  Monty Hall is 1/3 keep and 2/3 switch, an outside truth that does
  because  not depend on any of this code being right
`
  );
  assert.equal(evaluateHeuristic(h, obs("Win percent: 33.34\nWin percent: 66.66")).failure, null);
  assert.match(
    evaluateHeuristic(h, obs("Win percent: 66.66\nWin percent: 33.34")).failure!,
    /change measured 33\.34 and keep measured 66\.66/
  );
  assert.equal(checkRejection(h, h.rejects[0]).ok, true);
});

/** Write one heuristic into a scratch ratchet home and return the home path. */
function writeRules(h: { name: string }): string {
  const home = tmpDir();
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ subjects: {} }), "utf8");
  fs.writeFileSync(path.join(home, "heuristics.rules"), renderHeuristic(h as never) + "\n", "utf8");
  return home;
}

test("`needs <path> exists` reports could-not-run, not not-applicable", () => {
  // The two jobs `na` used to do at once. `applies when` says the subject is
  // absent at this commit; `needs` says the environment is — and only the
  // first is a statement about the code under test.
  const h = one(
    `heuristic sim
  run      node sim.js
  applies  when src/sim.c exists
  needs    node_modules exists
  measure  count number after "particles:"
  rule     count is 65536
`
  );
  assert.deepEqual(h.appliesWhenExists, ["src/sim.c"]);
  assert.deepEqual(h.needsExists, ["node_modules"]);
  assert.match(renderHeuristic(h), /needs +node_modules exists/);

  const project = tmpDir();
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "sim.c"), "", "utf8");
  const run = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "src", "probe.js"), "sim"],
    {
      cwd: project,
      encoding: "utf8",
      // RATCHET_PROJECT_ROOT is set explicitly, not inherited: when this suite
      // itself runs as a heuristic's instrument the outer probe exports it,
      // and a child probe prefers it over its own cwd. Found by the ratchet's
      // own standing invariant on its first green run.
      env: { ...process.env, RATCHET_HOME: writeRules(h), RATCHET_PROJECT_ROOT: project },
    }
  );
  assert.equal(run.status, 126, run.stdout + run.stderr);
  assert.match(run.stdout, /needs node_modules/);
  assert.match(run.stdout, /not about the code at this commit/);
});

test("a `needs` path that is present lets the check run normally", () => {
  const h = one(
    `heuristic sim
  run      ${JSON.stringify(NODE)} -e "console.log('particles: 4')"
  needs    present.txt exists
  measure  count number after "particles:"
  rule     count is 4
`
  );
  const project = tmpDir();
  fs.writeFileSync(path.join(project, "present.txt"), "", "utf8");
  const run = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "src", "probe.js"), "sim"],
    {
      cwd: project,
      encoding: "utf8",
      // RATCHET_PROJECT_ROOT is set explicitly, not inherited: when this suite
      // itself runs as a heuristic's instrument the outer probe exports it,
      // and a child probe prefers it over its own cwd. Found by the ratchet's
      // own standing invariant on its first green run.
      env: { ...process.env, RATCHET_HOME: writeRules(h), RATCHET_PROJECT_ROOT: project },
    }
  );
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test("`needs` with no path says what the clause reads", () => {
  const r = parseHeuristics(`heuristic h\n  run node x.js\n  measure f number after "f:"\n  rule f is 0\n  needs\n`);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0].message, /needs <path> exists/);
  assert.match(r.problems[0].message, /different from .applies when/);
});

test("an excerpt shows both ends of what a crashed instrument printed", () => {
  // The head alone is the wrong half. A test runner opens with a banner and
  // puts the verdict at the end, so four leading lines of a TAP stream made
  // the witness for a failing suite read `TAP version 13 | # Subtest: ... |
  // ok 1 - ...` — technically the output, and useless.
  const tap = [
    "TAP version 13",
    "# Subtest: junit: CDATA, message-less text, errors capture",
    "ok 1 - junit: CDATA, message-less text, errors capture",
    ...Array.from({ length: 38 }, (_, i) => `ok ${i + 2} - filler`),
    "not ok 41 - the one that actually broke",
    "# tests 41",
    "# pass 40",
    "# fail 1",
  ].join("\n");

  const e = excerpt(tap);
  assert.match(e, /TAP version 13/, "the head is still there");
  assert.match(e, /not ok 41 - the one that actually broke/, "and so is the line that matters");
  assert.match(e, /# fail 1/);
  assert.match(e, /…37 more lines…/, "and it says how much was dropped");

  assert.equal(excerpt(""), "(no output)");
  assert.equal(excerpt("one\ntwo"), "one | two", "short output is shown whole");
  assert.match(excerpt("x".repeat(400)), /…$/, "and a single enormous line is clipped");
  assert.match(excerpt("a\nb", { quote: true }), /"a" \| "b"/, "a short preview quotes each line");
});

test("an unreadable measure quotes both ends of the output too", () => {
  const h = one(`heuristic h\n  run node x.js\n  measure f number after "findings:"\n  rule f is 0\n`);
  const noisy = Array.from({ length: 30 }, (_, i) => `line ${i}`).concat("the last word").join("\n");
  const e = evaluateHeuristic(h, obs(noisy));
  assert.match(e.failure!, /line 0/);
  assert.match(e.failure!, /the last word/);
});

test("fmt is a fixpoint: an empty or comment-only rules file does not grow", () => {
  // Found by `ratchet fuzz`: parseHeuristics("") returned a one-blank-line
  // preamble, formatHeuristics rendered it as "\n", and re-parsing yielded
  // two blanks — every `fmt` added a line to a file nobody had touched.
  const cycle = (source: string): string => {
    const p = parseHeuristics(source);
    assert.equal(p.problems.length, 0);
    return formatHeuristics(p.heuristics, p.preamble);
  };
  const inputs = ["", "\n", "\n\n", "# a comment\n", "# a\n\n# b\n", "\n# c\n\n"];
  for (const input of inputs) {
    const once = cycle(input);
    assert.equal(cycle(once), once, `not a fixpoint for ${JSON.stringify(input)}`);
  }
  const commentOnly = cycle("# a comment\n");
  assert.equal(commentOnly, "# a comment\n", "comments survive; blank lines do not");
});
