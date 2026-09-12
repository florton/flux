import { test } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { appendEvent, readCorpus, readEvents, foldRows, rowId, stableStringify } from "../src/corpus";
import { readJournal } from "../src/journal";
import { pool } from "../src/runner";
import { capture } from "../src/capture";
import { proveSubjects } from "./proof";
import { recorderBody, maxOverlap, probes } from "./concurrency";
import { verify, countOutcomes } from "../src/verify";
import { accept, reopen } from "../src/accept";
import { fsck } from "../src/fsck";
import { listRows, showRow, formatRow } from "../src/inspect";
import { tmpDir } from "./tmp";

const NODE = process.execPath;
// process.execPath contains a space on Windows; the tokenizer would split it.
const QUOTED_NODE = JSON.stringify(process.execPath);

function project(subjects: Record<string, unknown>, checkBody: string): { home: string; root: string } {
  const home = tmpDir();
  const root = path.join(home, "proj");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ subjects }), "utf8");
  fs.writeFileSync(path.join(home, "corpus.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(home, "journal.jsonl"), "", "utf8");
  fs.writeFileSync(
    path.join(root, "check.js"),
    [
      'const fs=require("fs");',
      'const raw=fs.readFileSync(0,"utf8");',
      'const v=raw.trim()===""?null:JSON.parse(raw);',
      "function fail(r){console.log(r);process.exit(1);}",
      "function na(r){console.log(r);process.exit(125);}",
      checkBody,
      "process.exit(0);",
    ].join("\n"),
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

// ----------------------------- R8: a bad line is reportable, not fatal

test("R8: malformed corpus lines are collected, not thrown", () => {
  const p = path.join(tmpDir(), "corpus.jsonl");
  const good = JSON.stringify({
    op: "capture", id: "c1", at: "2026-01-01T00:00:00Z", subject: "s", input: 1, source: "manual",
  });
  fs.writeFileSync(p, good + "\n<<<<<<< HEAD\n" + '{"op":"capture","id":"c2","subj\n', "utf8");

  const { events, problems } = readCorpus(p);
  assert.equal(events.length, 1, "the readable row survives");
  assert.equal(problems.length, 2);
  assert.equal(problems[0].line, 2);
});

test("R8: verify refuses a corpus it cannot fully read", async () => {
  const { home, root } = project({ s: { check: QUOTED_NODE + " check.js" } }, "");
  fs.appendFileSync(path.join(home, "corpus.jsonl"), '{"op":"capt\n', "utf8");
  await assert.rejects(
    () => verify(root, { quiet: true, ratchetHome: home }),
    /unreadable line/,
    "a row hidden behind a parse error would be a false pass"
  );
});

test("R8: fsck reports bad lines, orphans, and tampered ids", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ subjects: {} }), "utf8");
  fs.writeFileSync(path.join(dir, "journal.jsonl"), "", "utf8");
  fs.writeFileSync(
    path.join(dir, "corpus.jsonl"),
    [
      JSON.stringify({ op: "capture", id: rowId("s", 1), at: "2026-01-01T00:00:00Z", subject: "s", input: 1, source: "manual" }),
      JSON.stringify({ op: "capture", id: "cdeadbeefdead", at: "2026-01-02T00:00:00Z", subject: "s", input: 2, source: "manual" }),
      JSON.stringify({ op: "accept", id: "cmissing00000", at: "2026-01-03T00:00:00Z", subject: "s", input: 3, source: "manual" }),
      "{ broken",
    ].join("\n") + "\n",
    "utf8"
  );

  const r = fsck(dir);
  const kinds = r.findings.map((f) => f.kind);
  assert.ok(kinds.includes("corpus-unreadable-line"));
  assert.ok(kinds.includes("orphan-event"));
  assert.ok(kinds.includes("id-mismatch"), "content-addressed ids make a hand-edited row detectable");
  assert.ok(kinds.includes("unconfigured-subject"));
  assert.equal(r.ok, false);
});

test("a malformed config is reported as a subjects problem, not a corpus one", () => {
  // R39. `fsck` funnelled every `loadSubjects` failure into
  // `corpus-unreadable-line`, which sends a reader to the one file that is
  // fine. The corpus here is empty and perfectly well formed.
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ subjects: { s: { command: "x" } } }), "utf8");
  fs.writeFileSync(path.join(dir, "corpus.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(dir, "journal.jsonl"), "", "utf8");

  const r = fsck(dir);
  const kinds = r.findings.map((f) => f.kind);
  assert.ok(kinds.includes("subjects-unreadable"), "the finding names the file that is actually wrong");
  assert.ok(!kinds.includes("corpus-unreadable-line"), "the corpus is empty and fine");
  assert.match(r.findings.find((f) => f.kind === "subjects-unreadable")!.detail, /check is missing/);
  assert.equal(r.ok, false);
});

test("R8: fsck treats legacy sequential ids as info, not corruption", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "journal.jsonl"), "", "utf8");
  fs.writeFileSync(
    path.join(dir, "corpus.jsonl"),
    JSON.stringify({ op: "capture", id: "c0001", at: "2026-01-01T00:00:00Z", subject: "s", input: 1, source: "manual" }) + "\n",
    "utf8"
  );
  const r = fsck(dir);
  assert.deepEqual(r.findings.map((f) => f.kind), ["legacy-id"]);
  assert.equal(r.ok, true, "a pre-0.2 corpus is old, not broken");
});

// ------------------------------------------ R14: the third outcome, na

test("R14: exit 125 is n/a — neither a pass nor a failure", async () => {
  const { home, root } = project(
    { s: { check: QUOTED_NODE + " check.js" } },
    'if (v === 7) na("no such feature at this commit");\nif (v === 8) fail("real failure");'
  );
  for (const n of [7, 8]) {
    appendEvent(path.join(home, "corpus.jsonl"), {
      op: "capture", id: rowId("s", n), at: "2026-01-0" + n + "T00:00:00Z",
      subject: "s", input: n, source: "manual",
    });
  }

  const results = await verify(root, { quiet: true, ratchetHome: home });
  const naRow = results.find((r) => r.id === rowId("s", 7));
  const failRow = results.find((r) => r.id === rowId("s", 8));
  assert.equal(naRow!.outcome, "na");
  assert.equal(naRow!.pass, false, "n/a is not a pass");
  assert.equal(failRow!.outcome, "fail");
  assert.deepEqual(countOutcomes(results), { pass: 0, fail: 1, na: 1, naEnv: 0, quarantine: 0 });
});

test("R14: exit 126 is `could not run here` — the other job n/a used to do", async () => {
  // "This feature did not exist yet" and "today's toolchain cannot build that
  // commit" mean opposite things about the commit under test. Collapsing them
  // is how dependency rot gets reported as a regression.
  const { home, root } = project(
    { s: { check: QUOTED_NODE + " check.js" } },
    'if (v === 7) { console.log("no compiler on this machine"); process.exit(126); }\nif (v === 8) fail("real failure");'
  );
  for (const n of [7, 8]) {
    appendEvent(path.join(home, "corpus.jsonl"), {
      op: "capture", id: rowId("s", n), at: "2026-01-0" + n + "T00:00:00Z",
      subject: "s", input: n, source: "manual",
    });
  }

  const results = await verify(root, { quiet: true, ratchetHome: home });
  const envRow = results.find((r) => r.id === rowId("s", 7))!;
  assert.equal(envRow.outcome, "na-env");
  assert.equal(envRow.pass, false, "no verdict is not a pass");
  assert.match(envRow.reason!, /no compiler on this machine/);
  assert.deepEqual(countOutcomes(results), { pass: 0, fail: 1, na: 0, naEnv: 1, quarantine: 0 });

  // And it does not fail the build on its own: only the real failure does.
  assert.equal(results.filter((r) => r.outcome === "fail").length, 1);
});

test("R14: an n/a counterexample is not stored as evidence", async () => {
  const { home, root } = project(
    { s: { check: QUOTED_NODE + " check.js", captureProperty: "p" } },
    'na("not applicable here");'
  );
  const capFile = path.join(root, "cap.json");
  fs.writeFileSync(capFile, JSON.stringify([{ property: "p", counterexample: [1] }]), "utf8");
  await withHome(home, async () => {
    const rep = capture(root, [capFile]);
    assert.equal(rep.added.length, 0);
    assert.match(rep.skipped[0], /n\/a/);
  });
});

// ------------------------------ R13: list and show for the accept ceremony

test("R13: list and show expose what the ceremony is retiring", async () => {
  const { home, root } = project(
    { s: { check: QUOTED_NODE + " check.js", captureProperty: "p" } },
    'if (v === 99) fail("ninety-nine is wrong");'
  );
  const capFile = path.join(root, "cap.json");
  fs.writeFileSync(capFile, JSON.stringify([{ property: "p", counterexample: [99] }]), "utf8");

  await withHome(home, async () => {
    capture(root, [capFile]);
    const id = rows(home)[0].id;
    accept(root, id, "99 is allowed now", "alice");

    assert.equal(listRows(home).length, 1);
    assert.equal(listRows(home, { status: "active" }).length, 0);
    assert.equal(listRows(home, { status: "archived" }).length, 1);

    const detail = showRow(home, id.slice(0, 6));
    assert.equal(detail.row.id, id, "an id prefix resolves");
    assert.equal(detail.events.length, 2, "capture + accept");
    assert.equal(detail.journal.length, 1);

    const text = formatRow(detail);
    assert.match(text, /99/, "the input being retired must be visible");
    assert.match(text, /99 is allowed now/);
    assert.match(text, /alice/);
  });
});

// ------------------------------------------------- R18: reopen symmetry

test("R18: reopen on an active row is refused, like accept on an archived one", async () => {
  const { home, root } = project(
    { s: { check: QUOTED_NODE + " check.js", captureProperty: "p" } },
    'if (v === 3) fail("three");'
  );
  const capFile = path.join(root, "cap.json");
  fs.writeFileSync(capFile, JSON.stringify([{ property: "p", counterexample: [3] }]), "utf8");

  await withHome(home, async () => {
    capture(root, [capFile]);
    const id = rows(home)[0].id;
    assert.throws(() => reopen(root, id, "no-op", "alice"), /already active/);
    accept(root, id, "fine", "alice");
    assert.throws(() => accept(root, id, "again", "alice"), /already archived/);
    assert.equal(
      readJournal(path.join(home, "journal.jsonl")).filter((e) => e.kind !== "validation").length,
      1,
      "no-ops must not pollute the decision log"
    );
  });
});

// --------------------------------------- R20: stableStringify soundness

test("R20: values outside the JSON domain get distinct keys", () => {
  assert.notEqual(stableStringify(NaN), stableStringify(null));
  assert.notEqual(stableStringify(Infinity), stableStringify(null));
  assert.notEqual(stableStringify(undefined), stableStringify(null));
  assert.notEqual(stableStringify(new Date(0)), stableStringify(new Date(1)));
  assert.notEqual(stableStringify(new Date(0)), stableStringify({}));
  assert.equal(typeof stableStringify(undefined), "string", "the return type must not lie");
  assert.notEqual(rowId("s", NaN), rowId("s", null), "distinct values must not share a row");
});

// ------------------------------------------- R9: concurrency and ordering

test("R9: verify runs rows concurrently", async () => {
  // Each row's check records the window it occupied. Two windows that
  // intersect can only have come from two checks in flight at once, which is
  // the property; comparing a parallel run's clock against a serial one's
  // measured the machine instead, and this suite runs its files in parallel.
  // See test/concurrency.ts.
  const probeLog = tmpDir();
  const { home, root } = project({ s: { check: QUOTED_NODE + " check.js" } }, recorderBody(probeLog, 200));
  for (let i = 0; i < 8; i++) {
    appendEvent(path.join(home, "corpus.jsonl"), {
      op: "capture", id: rowId("s", i), at: "2026-01-01T00:00:0" + i + "Z",
      subject: "s", input: i, source: "manual",
    });
  }

  const results = await verify(root, { quiet: true, ratchetHome: home, concurrency: 8 });

  assert.equal(results.length, 8);
  assert.ok(results.every((r) => r.pass));
  assert.equal(probes(probeLog).length, 8, "every row must have been checked exactly once");
  const overlap = maxOverlap(probeLog);
  assert.ok(overlap >= 2, `rows were checked one at a time (most in flight at once: ${overlap})`);
});

test("R9: pool preserves input order regardless of completion order", async () => {
  const out = await pool([30, 5, 20, 1], 4, async (ms) => {
    await new Promise((r) => setTimeout(r, ms));
    return ms;
  });
  assert.deepEqual(out, [30, 5, 20, 1]);
});

test("R9: pool holds exactly `limit` in flight, and starts one more as each finishes", async () => {
  // The pool is a promise scheduler, so nothing here needs a clock: every task
  // is released by hand and the saturation is read off directly. The processes
  // it ends up running are what the two overlap tests cover.
  const items = [0, 1, 2, 3, 4, 5, 6, 7];
  const release: (() => void)[] = [];
  const started: number[] = [];
  let live = 0;
  let most = 0;

  const done = pool(items, 3, async (i) => {
    started.push(i);
    live++;
    most = Math.max(most, live);
    await new Promise<void>((r) => release.push(r));
    live--;
    return i * 2;
  });
  const settle = async () => {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };

  await settle();
  assert.equal(live, 3, "the pool must fill to the limit at once, not one at a time");
  assert.deepEqual(started, [0, 1, 2], "and take its items in order");

  release.shift()!();
  await settle();
  assert.equal(live, 3, "a finished task must be replaced immediately");
  assert.deepEqual(started, [0, 1, 2, 3], "by the next item, in order");

  while (release.length > 0) {
    release.shift()!();
    await settle();
  }

  assert.deepEqual(await done, items.map((i) => i * 2), "results land at their input index");
  assert.equal(most, 3, "the limit is a ceiling, never exceeded");
  assert.deepEqual(started, items, "every item runs exactly once");
});
