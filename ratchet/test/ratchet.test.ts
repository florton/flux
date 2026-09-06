import { test } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { appendEvent, readEvents, foldRows, stableStringify } from "../src/corpus";
import { appendJournal, readJournal } from "../src/journal";
import { ddmin, shrinkNumber, minimize } from "../src/shrink";
import { capture } from "../src/capture";
import { verify } from "../src/verify";
import { accept, reopen } from "../src/accept";
import { report } from "../src/report";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-test-"));
}

function writeConfig(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({
      subjects: {
        lt1000: {
          check: 'node -e "const fs=require(\'fs\');const v=JSON.parse(fs.readFileSync(0,\'utf8\'));process.exit(typeof v===\'number\'&&v<1000?0:1)"',
          captureProperty: "lt1000.prop",
        },
        named: {
          check: 'node -e "process.exit(0)"',
        },
      },
    }),
    "utf8"
  );
  fs.writeFileSync(path.join(dir, "corpus.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(dir, "journal.jsonl"), "", "utf8");
}

test("stableStringify orders object keys", () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  assert.equal(stableStringify({ a: [1, { c: 3, b: 2 }] }), '{"a":[1,{"b":2,"c":3}]}');
});

test("corpus folds capture/accept/reopen events", () => {
  const dir = tmpDir();
  const p = path.join(dir, "corpus.jsonl");
  appendEvent(p, { op: "capture", id: "c0001", at: "t1", subject: "s", input: 5, source: "manual" });
  appendEvent(p, { op: "accept", id: "c0001", at: "t2", subject: "s", input: 5, source: "manual" });
  let rows = foldRows(readEvents(p));
  assert.equal(rows.get("c0001")!.status, "archived");
  appendEvent(p, { op: "reopen", id: "c0001", at: "t3", subject: "s", input: 5, source: "manual" });
  rows = foldRows(readEvents(p));
  assert.equal(rows.get("c0001")!.status, "active");
});

test("journal appends and reads", () => {
  const dir = tmpDir();
  const p = path.join(dir, "journal.jsonl");
  appendJournal(p, { at: "t1", kind: "accept", actor: "alice", text: "x" });
  appendJournal(p, { at: "t2", kind: "decision", actor: "bob", text: "y" });
  assert.equal(readJournal(p).length, 2);
});

test("ddmin reduces an array while preserving failure", () => {
  const original = [1, 2, 3, 4, 5, 6, 7, 8];
  const failsOn = (arr: number[]) => arr.includes(6);
  const reduced = ddmin(original, failsOn);
  assert.ok(failsOn(reduced), "reduced array must still fail");
  assert.ok(reduced.length < original.length);
  assert.ok(reduced.includes(6));
});

test("shrinkNumber walks toward zero while failing", () => {
  const value = shrinkNumber(8347, (n) => n > 5000);
  assert.ok(value > 5000);
  assert.ok(value < 8347);
});

test("minimize handles strings", () => {
  const s = minimize("abcdefXghijkl", (c) => (c as string).includes("X"));
  assert.ok((s as string).includes("X"));
  assert.ok((s as string).length < "abcdefXghijkl".length);
});

test("capture from fast-check JSON, dedup, and verify", () => {
  const dir = tmpDir();
  writeConfig(dir);
  const root = path.join(dir, "proj");
  fs.mkdirSync(root, { recursive: true });
  process.env.RATCHET_HOME = dir;

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
  const rep = capture(root, [capFile]);
  assert.equal(rep.added.length, 1, JSON.stringify(rep));
  assert.equal(rep.skipped.length, 2);

  const results = verify(root, { quiet: true, ratchetHome: dir });
  assert.equal(results.length, 1);
  assert.equal(results[0].pass, false, "1234 must fail the <1000 check");
  delete process.env.RATCHET_HOME;
});

test("capture minimizes the counterexample before storing", () => {
  const dir = tmpDir();
  writeConfig(dir);
  const root = path.join(dir, "proj");
  fs.mkdirSync(root, { recursive: true });
  process.env.RATCHET_HOME = dir;

  const capFile = path.join(root, "capture.json");
  fs.writeFileSync(capFile, JSON.stringify([{ property: "lt1000.prop", counterexample: [8347] }]), "utf8");
  const rep = capture(root, [capFile]);
  assert.equal(rep.added.length, 1);
  const rows = [...foldRows(readEvents(path.join(dir, "corpus.jsonl"))).values()];
  assert.equal(rows.length, 1);
  assert.ok((rows[0].input as number) < 8347, `input was minimized to ${rows[0].input}`);
  delete process.env.RATCHET_HOME;
});

test("capture parses junit failure into a test-name row", () => {
  const dir = tmpDir();
  writeConfig(dir);
  const root = path.join(dir, "proj");
  fs.mkdirSync(root, { recursive: true });
  process.env.RATCHET_HOME = dir;

  const junit = path.join(root, "junit.xml");
  fs.writeFileSync(
    junit,
    `<testsuite><testcase classname="t" name="named test"><failure message="boom &lt;bad&gt;"/></testcase></testsuite>`,
    "utf8"
  );
  const rep = capture(root, [junit]);
  assert.equal(rep.added.length, 1);
  const events = readEvents(path.join(dir, "corpus.jsonl"));
  assert.equal(events[0].test, "named test");
  assert.equal(events[0].reason, "boom <bad>");
  delete process.env.RATCHET_HOME;
});

test("accept retires a row and journals the reason; reopen restores", () => {
  const dir = tmpDir();
  writeConfig(dir);
  const corpusPath = path.join(dir, "corpus.jsonl");
  appendEvent(corpusPath, { op: "capture", id: "c0001", at: "t1", subject: "named", input: null, source: "manual" });
  process.env.RATCHET_HOME = dir;
  accept(dir, "c0001", "behavior changed on purpose", "alice");
  assert.equal(foldRows(readEvents(corpusPath)).get("c0001")!.status, "archived");
  const j = readJournal(path.join(dir, "journal.jsonl"));
  assert.equal(j.length, 1);
  assert.equal(j[0].kind, "accept");
  assert.equal(j[0].corpusId, "c0001");

  reopen(dir, "c0001", "reverted decision", "alice");
  assert.equal(foldRows(readEvents(corpusPath)).get("c0001")!.status, "active");
  delete process.env.RATCHET_HOME;
});

test("report counts rows and sources", () => {
  const dir = tmpDir();
  writeConfig(dir);
  appendEvent(path.join(dir, "corpus.jsonl"), { op: "capture", id: "c0001", at: new Date().toISOString(), subject: "named", input: 1, source: "manual" });
  process.env.RATCHET_HOME = dir;
  const text = report(dir);
  assert.match(text, /1 rows/);
  assert.match(text, /manual 1/);
  delete process.env.RATCHET_HOME;
});
