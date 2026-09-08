import { test } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  makeRng,
  generateSeedState,
  generateRulesText,
  generateStateOps,
  generateCliArgv,
  applyStateOps,
  runRulesOracle,
  runCliOracle,
  runFuzz,
} from "../src/fuzz";
import { guard } from "../src/guard";
import { fsck } from "../src/fsck";
import { parseHeuristics } from "../src/heuristics";
import { readCorpus } from "../src/corpus";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-fuzz-test-"));
}

test("the generator stream is deterministic and seed-separated", () => {
  const a = makeRng(20260906);
  const b = makeRng(20260906);
  const c = makeRng(20260907);
  const seqA = Array.from({ length: 50 }, () => a.next());
  const seqB = Array.from({ length: 50 }, () => b.next());
  const seqC = Array.from({ length: 50 }, () => c.next());
  assert.deepStrictEqual(seqA, seqB);
  assert.notDeepStrictEqual(seqA, seqC);
});

test("the seed state is a complete, internally consistent ratchet home", () => {
  const root = tmpDir();
  const rng = makeRng(7);
  const files = generateSeedState(root, rng);

  // Everything parses, and the ids the corpus claims are the ids its content
  // computes — the seed is consistent by construction, not by hand.
  const config = JSON.parse(files[".ratchet/config.json"]);
  assert.ok(config.subjects.stub.check);
  const rules = parseHeuristics(files[".ratchet/heuristics.rules"]);
  assert.strictEqual(rules.problems.length, 0);
  const corpus = readCorpus(path.join(root, ".ratchet", "corpus.jsonl"));
  assert.strictEqual(corpus.problems.length, 0);
  assert.ok(corpus.events.length >= 8);

  // fsck on the untouched seed reports no errors — infos for the legacy id
  // are allowed, errors are not.
  const report = fsck(path.join(root, ".ratchet"), root);
  assert.deepStrictEqual(report.findings.filter((f) => f.severity === "error"), []);

  fs.rmSync(root, { recursive: true, force: true });
});

test("the gate over the seed state is deterministic and exception-free", async () => {
  const root = tmpDir();
  const files = generateSeedState(root, makeRng(11));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content, "utf8");
  }
  const home = path.join(root, ".ratchet");
  const first = await guard(root, { ratchetHome: home });
  const second = await guard(root, { ratchetHome: home });
  assert.deepStrictEqual(
    { ok: first.ok, steps: first.steps.map((s) => `${s.name}:${s.ok}`) },
    { ok: second.ok, steps: second.steps.map((s) => `${s.name}:${s.ok}`) }
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("generated rules text parses cleanly across many seeds", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const text = generateRulesText(makeRng(seed));
    const parsed = parseHeuristics(text);
    assert.strictEqual(parsed.problems.length, 0, `seed ${seed}: ${parsed.problems[0]?.message ?? ""}`);
    assert.ok(parsed.heuristics.length >= 1, `seed ${seed}`);
  }
});

test("the rules oracle holds: parse problems carry line and column, fmt is a fixpoint", () => {
  for (let seed = 1; seed <= 100; seed++) {
    const rng = makeRng(seed);
    const text = generateRulesText(rng);
    const findings = runRulesOracle(text, 0);
    assert.deepStrictEqual(findings, [], `seed ${seed}: ${findings[0]?.oracle} ${findings[0]?.detail}`);
  }
});

test("mutated rules never crash the parser or the oracle", () => {
  // The mutations are adversarial; the oracles must still hold their own
  // contracts (line/column on problems, no exceptions).
  const rng = makeRng(4242);
  for (let i = 0; i < 300; i++) {
    const text = generateRulesText(rng);
    const findings = runRulesOracle(text, i);
    for (const f of findings) {
      assert.ok(!["unhandled-error", "bad-line-number", "bad-column"].includes(f.oracle), `${f.oracle}: ${f.detail}`);
    }
  }
});

test("state ops are deterministic and leave the seed map untouched", () => {
  const root = tmpDir();
  const rng1 = makeRng(99);
  const seed = generateSeedState(root, rng1);
  // Two fresh rngs at the same seed: identical streams, identical ops.
  const opsA = generateStateOps(makeRng(99));
  const opsB = generateStateOps(makeRng(99));
  const filesA = applyStateOps(seed, opsA);
  const filesB = applyStateOps(seed, opsB);
  assert.deepStrictEqual(filesA, filesB);
  assert.deepStrictEqual(seed, generateSeedState(root, makeRng(99)));
  fs.rmSync(root, { recursive: true, force: true });
});

test("the cli oracle accepts the designed exit codes and json contract", () => {
  const root = tmpDir();
  const files = generateSeedState(root, makeRng(5));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content, "utf8");
  }
  const clean = runCliOracle(root, ["fsck", "--json"], 0);
  assert.deepStrictEqual(clean, []);
  const usage = runCliOracle(root, ["capture"], 0);
  assert.deepStrictEqual(usage, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test("every command the fuzzer found ignoring --json now honors it", () => {
  // Two real findings: `pr-comment` and `note` printed plain text with
  // --json and exit 0, violating the documented contract that every command
  // takes --json.
  const { spawnSync } = require("child_process");
  const root = tmpDir();
  const files = generateSeedState(root, makeRng(5));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content, "utf8");
  }
  const home = path.join(root, ".ratchet");
  const cli = (argv: string[]) =>
    spawnSync(process.execPath, [path.join(__dirname, "..", "src", "index.js"), ...argv, "--home", home], {
      cwd: root,
      encoding: "utf8",
      timeout: 60000,
    });
  for (const argv of [["note", "--text", "fuzz regression test", "--json"], ["pr-comment", "--json"]]) {
    const res = cli(argv);
    assert.equal(res.status, 0, `${argv.join(" ")}: ${res.stderr}`);
    JSON.parse(res.stdout);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("a bounded fuzz run over all three targets stays clean on a healthy build", async () => {
  const report = await runFuzz({ seed: 20260906, iterations: 5, targets: ["state", "cli", "rules"], maxFindings: 10 });
  assert.strictEqual(report.targets.length, 3);
  for (const t of report.targets) {
    assert.deepStrictEqual(t.findings, [], `${t.target}: ${t.findings[0]?.oracle ?? ""} ${t.findings[0]?.detail ?? ""}`);
  }
  assert.strictEqual(report.ok, true);
});
