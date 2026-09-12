import { test } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { capture } from "../src/capture";
import { proveSubjects } from "./proof";
import { foldRows, readEvents } from "../src/corpus";
import type { RowState } from "../src/types";
import { tmpDir } from "./tmp";

const NODE = JSON.stringify(process.execPath);

/**
 * A scratch project whose check fails loudly for every subject. Captures go
 * through the real gate: discrimination, confirmation, dedup. The config is
 * keyed by test name — that is the contract for JUnit/TAP rows: the row's
 * subject is the test's name, and the check re-runs it.
 */
function scratch(names: string[]): { home: string; root: string } {
  const home = tmpDir();
  const root = path.join(home, "proj");
  fs.mkdirSync(root, { recursive: true });
  const subjects: Record<string, { check: string }> = {};
  for (const n of names) subjects[n] = { check: `${NODE} check.js {test}` };
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ subjects }), "utf8");
  fs.writeFileSync(path.join(home, "corpus.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(home, "journal.jsonl"), "", "utf8");
  fs.writeFileSync(
    path.join(root, "check.js"),
    `const name = process.argv[2];\n` +
      `console.log("boom: " + name + " — assertion text with 42 in it");\n` +
      `process.exit(1);\n`,
    "utf8"
  );
  proveSubjects(home, root);
  return { home, root };
}

function rows(home: string): RowState[] {
  return [...foldRows(readEvents(path.join(home, "corpus.jsonl"))).values()];
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

function captureFile(home: string, root: string, file: string) {
  return withHome(home, () => capture(root, [path.join(root, file)]));
}

// ---------------------------------------------------------------- JUnit

test("junit: CDATA, message-less text, errors, entities and quoting all capture", () => {
  const { home, root } = scratch(["cdata case", "single quote name", "plain text failure", "crashed", 'entity "name"']);
  fs.writeFileSync(
    path.join(root, "junit.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="s">
    <testcase classname="t" name="cdata case"><failure><![CDATA[Expected 2, got 3]]></failure></testcase>
    <testcase name='single quote name'><failure message="loud"/></testcase>
    <testcase name="plain text failure"><failure type="AssertionError">assert.equal: &lt;2&gt; vs &lt;3&gt;</failure></testcase>
    <testcase name="crashed"><error message="TypeError: boom"/></testcase>
    <testcase name="entity &quot;name&quot;"><failure message="escaped &quot;message&quot;"/></testcase>
    <testcase name="passing"><system-out>fine</system-out></testcase>
    <testcase name="skipped"><skipped/></testcase>
  </testsuite>
</testsuites>
`,
    "utf8"
  );

  const report = captureFile(home, root, "junit.xml");
  const stored = rows(home);
  assert.deepEqual(
    stored.map((r) => r.subject).sort(),
    ["cdata case", "crashed", 'entity "name"', "plain text failure", "single quote name"].sort()
  );
  assert.equal(stored.length, 5, "passing and skipped testcases produce no rows");
  for (const r of stored) assert.equal(r.input, null);
  // The witness is the check's own output (what verify will see again), not
  // the parsed junit text — that is the honest comparison direction.
  const cdata = stored.find((r) => r.test === "cdata case");
  assert.ok(cdata?.signature?.includes("boom: cdata case"), "signature derives from the check run");
  assert.equal(stored.filter((r) => r.status === "active").length, 5);
});

test("junit: a message-less silent check still stores the parsed reason for display", () => {
  const { home, root } = scratch(["silent"]);
  // Rewrite the check to exit silently: the witness degrades to exit:1, but
  // the junit text is preserved on the row's display reason.
  fs.writeFileSync(
    path.join(root, "check.js"),
    `process.exit(1);\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "junit.xml"),
    `<testsuites><testsuite name="s"><testcase name="silent"><failure message="real reason from the runner"/></testcase></testsuite></testsuites>\n`,
    "utf8"
  );
  captureFile(home, root, "junit.xml");
  const [row] = rows(home);
  assert.equal(row.lastReason, "real reason from the runner");
  assert.match(row.signature ?? "", /^exit:1\|exit <n>$/, "the signature stays check-derived");
});

// ---------------------------------------------------------------- TAP

test("tap: failures with diagnostics capture the error text as the row reason", () => {
  const { home, root } = scratch(["multiplies two numbers"]);
  fs.writeFileSync(
    path.join(root, "results.tap"),
    `TAP version 13
ok 1 - adds two numbers
not ok 2 - multiplies two numbers
  ---
  duration_ms: 4.2
  error: |-
    Expected values to be strictly equal:
    + actual - expected
  ...
1..2
`,
    "utf8"
  );
  const report = captureFile(home, root, "results.tap");
  assert.equal(report.added.length, 1);
  const [row] = rows(home);
  assert.equal(row.subject, "multiplies two numbers");
  assert.equal(row.source, "tap");
  assert.equal(row.input, null);
});

test("tap: no diagnostics degrades to the test name, directives are skipped", () => {
  const { home, root } = scratch(["silent failure"]);
  fs.writeFileSync(
    path.join(root, "results.tap"),
    `TAP version 13
not ok 1 - silent failure
not ok 2 - planned later # TODO
not ok 3 - skipped feature # SKIP
ok 4 - passes
1..4
`,
    "utf8"
  );
  const report = captureFile(home, root, "results.tap");
  assert.deepEqual(rows(home).map((r) => r.subject), ["silent failure"]);
});

test("tap: node --test-style output with message: key and subtests captures once", () => {
  const { home, root } = scratch(["inner failing test"]);
  fs.writeFileSync(
    path.join(root, "results.tap"),
    `TAP version 13
# Subtest: suite
    not ok 1 - inner failing test
      ---
      duration_ms: 1.5
      message: |
        the inner assertion blew up
      ...
1..1
`,
    "utf8"
  );
  captureFile(home, root, "results.tap");
  const stored = rows(home);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].subject, "inner failing test");
});

test("tap: capturing the same failing stream twice dedups, not multiplies", () => {
  const { home, root } = scratch(["flaky"]);
  fs.writeFileSync(
    path.join(root, "results.tap"),
    `TAP version 13\nnot ok 1 - flaky\n1..1\n`,
    "utf8"
  );
  const first = captureFile(home, root, "results.tap");
  const second = captureFile(home, root, "results.tap");
  assert.equal(first.added.length, 1);
  assert.equal(second.added.length, 0, "the identical failure is already in corpus");
  assert.equal(rows(home).length, 1);
});
