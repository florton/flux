#!/usr/bin/env node
/**
 * The ratchet's self-hosted subjects — checks of the checker.
 *
 * This script lives in `.ratchet/tools/`, not in the source tree, and is
 * invoked through `{home}` so that replay carries it out of the working tree.
 * That is what makes it a *frozen instrument*: the same script measures every
 * commit, instead of each commit measuring itself with whatever it happened
 * to contain. Readings across history are then comparable by construction.
 *
 * Each subject is written to be version-agnostic — it exercises the invariant
 * through whatever API the checked-out tree provides — so it can be validated
 * against the commits where the bug actually lived.
 *
 * Contract: one JSON value on stdin (unused here), exit 0 pass / 1 fail /
 * 125 not-applicable, reason on stdout.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const subject = process.argv[2];
const root = process.cwd();
const dist = path.join(root, "ratchet", "dist", "src");

function pass(msg) {
  if (msg) console.log(msg);
  process.exit(0);
}
function fail(msg) {
  console.log(msg);
  process.exit(1);
}
function na(msg) {
  console.log(msg);
  process.exit(125);
}

function load(name) {
  const p = path.join(dist, name + ".js");
  if (!fs.existsSync(p)) {
    na(`${name}.js is not built at this commit (looked in ${path.relative(root, dist)})`);
  }
  return require(p);
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-self-"));
}

/**
 * A scratch project the capture path can actually run against: a ratchet
 * home, a project root, and an inner check whose body is supplied.
 */
function scratch(body) {
  const home = tmp();
  const root = path.join(home, "proj");
  fs.mkdirSync(root, { recursive: true });
  const inner = path.join(root, "inner.js");
  fs.writeFileSync(
    inner,
    'const v = JSON.parse(require("fs").readFileSync(0, "utf8"));\n' + body + "\nprocess.exit(0);\n"
  );
  const command = JSON.stringify(process.execPath) + " " + JSON.stringify(inner);
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ subjects: { s: { check: command, captureProperty: "p" } } })
  );
  fs.writeFileSync(path.join(home, "corpus.jsonl"), "");
  fs.writeFileSync(path.join(home, "journal.jsonl"), "");
  return { home, root };
}

function withHome(home, fn) {
  const previous = process.env.RATCHET_HOME;
  process.env.RATCHET_HOME = home;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.RATCHET_HOME;
    else process.env.RATCHET_HOME = previous;
  }
}

const subjects = {
  /**
   * Two developers on two branches each capture a different counterexample,
   * neither aware of the other, and the branches are merged. Both rows must
   * survive. Sequential ids minted from local file state made both branches
   * choose the same id, and the fold — keyed by id — silently dropped one.
   */
  "corpus-merge-safe"() {
    const corpus = load("corpus");
    let allocate;
    if (typeof corpus.rowId === "function") {
      allocate = (_corpusPath, s, input) => corpus.rowId(s, input);
    } else {
      // Pre-0.2 trees allocated ids by scanning the corpus file.
      const paths = load("paths");
      if (typeof paths.nextRowId !== "function") na("no id allocation API in this tree");
      allocate = (corpusPath) => paths.nextRowId(corpusPath);
    }

    const dir = tmp();
    const branchA = path.join(dir, "a.jsonl");
    const branchB = path.join(dir, "b.jsonl");
    fs.writeFileSync(branchA, "");
    fs.writeFileSync(branchB, "");

    const mk = (corpusPath, input) => ({
      op: "capture",
      id: allocate(corpusPath, "subject", input),
      at: new Date().toISOString(),
      subject: "subject",
      input,
      source: "manual",
    });
    const a = mk(branchA, "alice-found-this");
    const b = mk(branchB, "bob-found-this");

    // A union merge concatenates both branches' appends.
    const merged = [a, b];
    const rows = corpus.foldRows(merged);
    if (rows.size !== 2) {
      fail(
        `merging two branches' captures left ${rows.size} of 2 rows: ` +
          `ids were ${a.id} and ${b.id}` +
          (a.id === b.id ? " (identical, so one row was silently lost)" : "")
      );
    }
    pass("both branches' rows survive the merge");
  },

  /**
   * Distinct values must not share a dedup key. `JSON.stringify` renders NaN
   * and Infinity as "null", so they aliased onto a real null and only the
   * first of them could ever be stored.
   */
  "stringify-injective"() {
    const corpus = load("corpus");
    const cases = [
      ["null", null],
      ["NaN", NaN],
      ["Infinity", Infinity],
      ["undefined", undefined],
      ["empty object", {}],
      ["epoch date", new Date(0)],
      ["later date", new Date(1)],
    ];
    const seen = new Map();
    for (const [label, value] of cases) {
      const key = corpus.stableStringify(value);
      if (seen.has(key)) {
        fail(`${label} and ${seen.get(key)} both stringify to ${JSON.stringify(key)} — they would share one corpus row`);
      }
      seen.set(key, label);
    }
    pass(`${cases.length} distinct values produce ${seen.size} distinct keys`);
  },

  /**
   * Reduction must preserve the failure cause.
   *
   * This exercises the real capture path, not `minimize` in isolation: the
   * defect lived in the predicate capture passed to it ("does it still
   * fail?" rather than "does it still fail the same way?"), so a subject
   * that supplies its own cause-preserving predicate would pass straight
   * through the bug. Two independent defects are planted — an unrelated one
   * at 0 and the captured regression at >= 1000 — and the stored row must
   * describe the one that was captured.
   */
  "reduction-preserves-cause"() {
    const capture = load("capture");
    const corpus = load("corpus");
    const project = scratch(
      'if (v === 0) { console.log("legacy: divide by zero"); process.exit(1); }\n' +
        'if (v >= 1000) { console.log("regression: value " + v + " out of range"); process.exit(1); }'
    );
    fs.writeFileSync(
      path.join(project.root, "cap.json"),
      JSON.stringify([{ property: "p", counterexample: [8347] }])
    );

    const report = withHome(project.home, () => capture.capture(project.root, [path.join(project.root, "cap.json")]));
    const rows = [...corpus.foldRows(corpus.readEvents(path.join(project.home, "corpus.jsonl"))).values()];
    if (rows.length !== 1) {
      fail(`expected one stored row, got ${rows.length} (${JSON.stringify(report)})`);
    }
    if (rows[0].input === 0) {
      fail("reduction walked onto the unrelated failure at 0 — the captured regression was minimized away");
    }
    if (typeof rows[0].input !== "number" || rows[0].input < 1000) {
      fail(`stored input ${JSON.stringify(rows[0].input)} does not reproduce the captured regression`);
    }
    pass(`captured 8347, stored ${rows[0].input}, still failing for the captured reason`);
  },

  /**
   * A retired row must not swallow its own recurrence.
   *
   * Again the real capture path: dedup that ignores row status reports a
   * returning regression as "already in corpus" and leaves the build green,
   * which is a false pass on a decision someone already made.
   */
  "recurrence-is-visible"() {
    const capture = load("capture");
    const accept = load("accept");
    const corpus = load("corpus");
    const project = scratch('if (v === 42) { console.log("boom on 42"); process.exit(1); }');
    const capFile = path.join(project.root, "cap.json");
    fs.writeFileSync(capFile, JSON.stringify([{ property: "p", counterexample: [42] }]));

    const first = withHome(project.home, () => capture.capture(project.root, [capFile]));
    if (!first.added || first.added.length !== 1) {
      fail(`the counterexample was not captured in the first place: ${JSON.stringify(first)}`);
    }
    const corpusPath = path.join(project.home, "corpus.jsonl");
    const id = [...corpus.foldRows(corpus.readEvents(corpusPath)).values()][0].id;
    withHome(project.home, () => accept.accept(project.root, id, "intended for now", "selfcheck"));

    // The identical bug comes back.
    const again = withHome(project.home, () => capture.capture(project.root, [capFile]));
    const recurred = (again.recurred || []).length;
    const skippedSilently = (again.skipped || []).some((line) => /already in corpus/.test(line));

    if (recurred === 0 && skippedSilently) {
      fail("a returning regression against an accepted row was reported as a duplicate and silently dropped");
    }
    if (recurred === 0 && (again.added || []).length === 0) {
      fail(`the recurrence was neither reported nor stored: ${JSON.stringify(again)}`);
    }
    pass("a counterexample that returns after being accepted is surfaced, not deduplicated away");
  },

  /** The corpus fold must follow timestamps, not physical file order. */
  "fold-is-order-independent"() {
    const corpus = load("corpus");
    const id = "cselfhost0001";
    const shuffled = [
      { op: "accept", id, at: "2026-02-01T00:00:00Z", subject: "s", input: 1, source: "manual" },
      { op: "capture", id, at: "2026-01-01T00:00:00Z", subject: "s", input: 1, source: "manual" },
    ];
    const row = corpus.foldRows(shuffled).get(id);
    if (!row) fail("an accept above its capture dropped the row entirely");
    if (row.status !== "archived") {
      fail(`accept written above its capture left status "${row.status}" — the retirement was lost`);
    }
    pass("events replay in timestamp order regardless of file order");
  },
};

if (!subject || !subjects[subject]) {
  console.log(`unknown subject "${subject}"; known: ${Object.keys(subjects).join(", ")}`);
  process.exit(1);
}

try {
  subjects[subject]();
} catch (err) {
  fail(`check crashed: ${err && err.message ? err.message : String(err)}`);
}
