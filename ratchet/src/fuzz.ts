/**
 * `ratchet fuzz` — the secondary verifier.
 *
 * `guard` proves the *rows hold*: every counterexample in the corpus still
 * fails, every standing invariant still stands. `fuzz` attacks the *machinery
 * that produces rows*: the parsers, the fold, the judges, the CLI surface.
 * It is the second, independent way of verifying enforcement, and it is a
 * shipped command rather than a test file because a check that lives in the
 * test suite only runs where the tests run — a gate worth having must be
 * runnable against any repository that uses this tool.
 *
 * Three targets, each matching a measured defect class (the v0.8 review
 * classified the twenty-one v0 defects: sixteen sat at the process boundary,
 * on the CLI surface or in an error path, and not one in a data structure):
 *
 *   state — mutations of a valid corpus/journal/config/rules against the
 *           oracles: `guard` must never throw, `fsck` must detect exactly the
 *           rows whose id does not match their content, and unreadable lines
 *           must be named by line number.
 *   cli   — random argv against the real binary. Oracle: exit 0 or 1 with a
 *           first-class message, never an uncaught stack trace; `--json` with
 *           exit 0 must emit JSON.
 *   rules — grammar-generated and mutated heuristics.rules text. Oracle: the
 *           parser never throws; problems carry line and column; `fmt` is a
 *           fixpoint and never changes a heuristic's canonical text.
 *
 * Determinism is the ratchet's own standard: mulberry32 (the same generator
 * `seed-preload.ts` ships, duplicated here because that file is a side-effect
 * preload with no exports), one seed, one stream, findings reproduced from
 * seed + iteration. A finding is minimized the way `capture` minimizes a
 * counterexample — cause-preserving reduction over the mutation list, so the
 * report shows the smallest repro, never a different bug that happened to
 * also crash.
 *
 * Honest limits, the way this codebase states them: the state target mutates
 * a *synthetic* scratch home, not the repository's own — fuzzing your real
 * corpus would mean rewriting your memory. The PNG decoder, the worktree
 * machinery, and instrument execution are not fuzzed (each is covered by the
 * test suite instead). And no oracle can detect a mutation that preserves
 * every property it checks; a fuzzer is evidence, not a proof.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { isLegacyId, readCorpus, foldCorpus, rowId } from "./corpus";
import { ruleHash } from "./rule";
import { readJournalFile } from "./journal";
import { parseHeuristics, formatHeuristics, type ParseProblem } from "./heuristics";
import { fsck } from "./fsck";
import { guard, type GuardResult } from "./guard";
import { ddmin, minimize, type Budget } from "./shrink";
import type { CorpusEvent } from "./types";

export type Target = "state" | "cli" | "rules";

/* -------------------------------------------------------------------------- */
/* The generator                                                               */
/* -------------------------------------------------------------------------- */

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [0, n). */
  int(n: number): number;
  /** Uniform integer in [min, max], inclusive. */
  range(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
  str(len: number, alphabet: string): string;
}

/** mulberry32 — small, fast, and good enough for reproducibility. */
export function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    range: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)],
    chance: (p) => next() < p,
    str: (len, alphabet) =>
      Array.from({ length: len }, () => alphabet[Math.floor(next() * alphabet.length)]).join(""),
  };
}

/** Bytes most likely to break a JSON line, a rules clause, or a CLI parse. */
const JUNK_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789{}[]\":,.# \n\t'\\/-=<>|_@$%*";

/** Characters safe inside a prose clause: no `#` (a comment), no quotes. */
const PROSE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789 .,;-";

function junk(rng: Rng, maxLen = 24): string {
  return rng.str(rng.range(1, maxLen), JUNK_ALPHABET);
}

/** Junk safe for a prose clause: no newlines, never whitespace-only. */
function cleanJunk(rng: Rng, maxLen: number): string {
  for (;;) {
    const t = junk(rng, maxLen).replace(/[\n\r\t]+/g, " ").trim();
    if (t !== "") return t;
  }
}

/** Prose that must parse as a `note` or `because` body. */
function proseJunk(rng: Rng, maxLen: number): string {
  for (;;) {
    const t = rng.str(rng.range(3, maxLen), PROSE_ALPHABET).trim();
    if (t !== "" && !t.startsWith("#")) return t;
  }
}

/* -------------------------------------------------------------------------- */
/* The scratch state                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A complete, valid ratchet home plus one scripted subject and one prose
 * standing invariant. Everything the fuzzer mutates starts from this, so the
 * mutations land in states that exercise the real paths rather than dying at
 * "no subject config" on every line.
 *
 * The instrument reads a number off stdin and exits 0, 1, 125 or 126 by it —
 * the whole four-outcome contract in one deterministic process, so the seed
 * corpus can hold a passing row, failing rows, an n/a row and a cannot-run
 * row at once. The row ids and the owning-rule hash are computed with the
 * same functions the tool uses, so the seed is internally consistent by
 * construction rather than by hand.
 */
const STUB_INSTRUMENT = `// Fuzz instrument: a deterministic verdict from the input number.
const fs = require("fs");
let input = null;
try {
  const raw = fs.readFileSync(0, "utf8");
  if (raw.trim() !== "") input = JSON.parse(raw);
} catch (_) { input = null; }
const n = typeof input === "number" ? input : 0;
if (n === 125) { console.log("stub n/a"); process.exit(125); }
if (n === 126) { console.log("stub cannot run here"); process.exit(126); }
if (n < 0) { console.log("stub failed on " + n); process.exit(1); }
console.log("stub ok count: 5");
process.exit(0);
`;

const STUB_OWNED = "owned version 1\n";

function stubConfig(): { check: string; owns: string[]; timeoutMs: number } {
  return { check: "node {home}/tools/stub.js", owns: [".ratchet/tools/owned.txt"], timeoutMs: 15000 };
}

export function generateSeedState(root: string, rng: Rng): Record<string, string> {
  const files: Record<string, string> = {};
  const home = path.join(root, ".ratchet");
  fs.mkdirSync(path.join(home, "tools"), { recursive: true });

  files[".ratchet/tools/stub.js"] = STUB_INSTRUMENT;
  files[".ratchet/tools/owned.txt"] = STUB_OWNED;

  // The owned file must exist on disk *before* the hash is taken: ruleHash
  // reads the files it owns, and a missing owned file hashes differently
  // from one that exists (the `<missing>` sentinel), which would make every
  // seeded row carry the hash of a file that is absent at verify time.
  fs.writeFileSync(path.join(home, "tools", "stub.js"), STUB_INSTRUMENT, "utf8");
  fs.writeFileSync(path.join(home, "tools", "owned.txt"), STUB_OWNED, "utf8");

  const config = { subjects: { stub: stubConfig() } };
  files[".ratchet/config.json"] = JSON.stringify(config, null, 2) + "\n";

  files[".ratchet/heuristics.rules"] = generateSeedRules(rng);

  // The owning-rule hash for the stub subject, computed with the tool's own
  // function against the scratch root so every seeded row carries the hash the
  // verifier will compute at run time.
  const stubHash = ruleHash("stub", stubConfig(), root);

  const base = 1767000000000;
  let seq = 0;
  const ev = (
    op: CorpusEvent["op"],
    id: string,
    subject: string,
    input: unknown,
    extra: Partial<CorpusEvent> = {}
  ): CorpusEvent => ({
    op,
    id,
    at: new Date(base + ++seq * 1000).toISOString(),
    subject,
    input: input === undefined ? null : input,
    source: "manual",
    ...extra,
  });

  const corpus = [
    ev("capture", rowId("stub", 5), "stub", 5),
    ev("capture", rowId("stub", 6), "stub", 6),
    ev("capture", rowId("stub", -1), "stub", -1, {
      signature: "exit:1|stub failed on <n>",
      ruleHash: stubHash,
    }),
    ev("capture", rowId("stub", -2), "stub", -2, {
      signature: "exit:1|stub failed on <n>",
      ruleHash: stubHash,
    }),
    ev("capture", rowId("stub", 125), "stub", 125),
    ev("capture", rowId("stub", 126), "stub", 126),
    ev("capture", "c42", "stub", 9), // a legacy sequential id, reported as info
    ev("capture", rowId("stub", null, "flaky-test"), "stub", null, { test: "flaky-test" }),
    ev("accept", rowId("stub", 6), "stub", 6, { reason: "the expectation moved", actor: "fuzz" }),
  ];
  files[".ratchet/corpus.jsonl"] = corpus.map((e) => JSON.stringify(e)).join("\n") + "\n";

  const journal = [
    { at: new Date(base + ++seq * 1000).toISOString(), kind: "validation", actor: "fuzz", text: `validated "stub" (rule ${stubHash}) — fuzz seed` },
    { at: new Date(base + ++seq * 1000).toISOString(), kind: "decision", actor: "fuzz", text: "fuzz seed state" },
  ];
  files[".ratchet/journal.jsonl"] = journal.map((e) => JSON.stringify(e)).join("\n") + "\n";

  writeFiles(root, files);
  return files;
}

/**
 * One prose heuristic with a standing invariant, generated through the real
 * parser and formatter so the file on disk is canonical by construction. The
 * band varies with the rng; the `rejects` value is always outside it, because
 * a declared rejection the rules accept is a parse error.
 */
function generateSeedRules(rng: Rng): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const low = rng.range(1, 3);
    const high = rng.range(8, 12);
    const out = high + rng.range(1, 5);
    const text =
      `heuristic alpha\n` +
      `  run      node {home}/tools/stub.js\n` +
      `  measure  n  the number after "count:"\n` +
      `  rule     n is between ${low} and ${high}\n` +
      `  rejects  n ${out}\n` +
      `  because  a generated standing invariant\n`;
    const parsed = parseHeuristics(text);
    if (parsed.problems.length === 0 && parsed.heuristics.length === 1) {
      return formatHeuristics(parsed.heuristics, parsed.preamble);
    }
  }
  return (
    `heuristic alpha\n` +
    `  run      node {home}/tools/stub.js\n` +
    `  measure  n  the number after "count:"\n` +
    `  rule     n is between 1 and 10\n` +
    `  rejects  n 99\n` +
    `  because  a generated standing invariant\n`
  );
}

/* -------------------------------------------------------------------------- */
/* The rules grammar — the rules target's generator                            */
/* -------------------------------------------------------------------------- */

const RUN_POOL = ["node tool.js --iters 100", "node script.js run", "npm test", "python3 sim.py"];
const LABEL_POOL = ["house edge:", "Win percent:", "count:", "x:", "elapsed:"];
const SUBSTR_POOL = ["FAIL ", "not ok", "debug", "ok"];

interface GeneratedMeasure {
  name: string;
  /** True when this measure has an own (non-relational) rule to reject on. */
  ownable: boolean;
  /**
   * True when the extractor always reads a number. An equality against a
   * non-numeric string over one of these has a constant answer, and the
   * parser refuses it — so the generator must not emit one.
   */
  numeric: boolean;
}

interface GeneratedRule {
  measure: string;
  text: string;
  /** A reading the rule refuses, when a consistent one exists. */
  rejectsValue?: string;
}

/** A rule clause and, when one exists, a reading that rule refuses. */
function generateRule(rng: Rng, measures: GeneratedMeasure[]): GeneratedRule {
  const m = rng.pick(measures);
  const others = measures.filter((x) => x.name !== m.name);
  const roll = rng.next();
  const canonical = rng.chance(0.7);

  if (roll < 0.12 && others.length > 0) {
    // Relational predicates read a second measure, so no single-reading
    // rejection can be declared over them.
    const other = rng.pick(others);
    const op = rng.pick(["is above", "is below", "is at least", "is at most", "is the same as"]);
    return { measure: m.name, text: `rule ${m.name} ${op} ${other.name}` };
  }
  if (roll < 0.22) {
    const a = rng.range(-10, 10);
    const b = a + rng.range(1, 20);
    const loose = rng.pick(["is between", "is in the range"]);
    return { measure: m.name, text: `rule ${m.name} ${loose} ${a} and ${b}`, rejectsValue: String(b + 5) };
  }
  if (roll < 0.32) {
    const n = rng.range(-20, 20);
    const op = rng.pick(["is above", "is below", "is at least", "is at most", "is greater than", "is no less than"]);
    const rejectsValue = op.includes("above") || op.includes("least") || op.includes("greater") || op.includes("no less")
      ? String(n - 5)
      : String(n + 5);
    return { measure: m.name, text: `rule ${m.name} ${op} ${n}`, rejectsValue };
  }
  if (roll < 0.42) {
    const n = rng.range(1, 50);
    const p = rng.range(1, 30);
    const of = rng.range(-10, 10);
    const rejectsValue = String(of === 0 ? 1 : of + Math.abs(of) * (p / 100 + 2) + 1);
    return { measure: m.name, text: `rule ${m.name} is within ${p} percent of ${of}`, rejectsValue };
  }
  if (roll < 0.52) {
    // A numeric measure only ever equals a number; over one of those the
    // alphabet is digits, so the clause the generator emits is one the parser
    // will accept for the same reason a human's would be.
    const v = m.numeric
      ? String(rng.range(0, 9999))
      : rng.str(rng.range(1, 6), "abcdef0123456789");
    const negated = rng.chance(0.3);
    return {
      measure: m.name,
      text: `rule ${m.name} ${negated ? "is not" : "is"} ${v}`,
      rejectsValue: negated ? v : String(Number(v) + 1 || 1),
    };
  }
  if (roll < 0.62) {
    const values = [rng.range(0, 9), rng.range(10, 19)];
    return { measure: m.name, text: `rule ${m.name} is one of ${values[0]}, ${values[1]}`, rejectsValue: "zz" };
  }
  if (roll < 0.75) {
    const s = rng.str(rng.range(1, 6), "abcdefgh");
    const op = rng.pick(["contains", "does not contain", "starts with", "ends with"]);
    const rejectsValue = op === "does not contain" ? s : "zz";
    return { measure: m.name, text: `rule ${m.name} ${op} "${s}"`, rejectsValue };
  }
  if (roll < 0.85) {
    const negated = rng.chance(0.4);
    // A "rejects" clause must name a reading the rule refuses. "is not empty"
    // refuses the empty reading, which there is no way to write as a bare
    // value — so the negated form carries no declared rejection.
    return {
      measure: m.name,
      text: `rule ${m.name} ${negated ? "is not empty" : "is empty"}`,
      rejectsValue: negated ? undefined : "x",
    };
  }
  if (roll < 0.92) {
    return { measure: m.name, text: `rule ${m.name} is a number`, rejectsValue: "abc" };
  }
  // The fallback: a loose operator spelling, which canonicalization must
  // snap. The semantics are picked first and the spelling second, so the
  // declared rejection always matches the rule the text will actually say —
  // a `rejects` computed for "must be below" while the rule reads "is above"
  // is a parse error of the generator's own making.
  const choices = [
    { canonical: "is above", loose: [">", "is greater than", "should be above"], refused: (n: number) => String(n - 5) },
    { canonical: "is below", loose: ["<", "must be below"], refused: (n: number) => String(n + 5) },
    { canonical: "is at least", loose: [">=", "is no less than"], refused: (n: number) => String(n - 5) },
    { canonical: "is at most", loose: ["<=", "is no more than"], refused: (n: number) => String(n + 5) },
  ];
  const choice = rng.pick(choices);
  const n = rng.range(-5, 5);
  const spelling = canonical ? choice.canonical : rng.pick(choice.loose);
  return { measure: m.name, text: `rule ${m.name} ${spelling} ${n}`, rejectsValue: choice.refused(n) };
}

function generateExtractorText(rng: Rng): { text: string; numeric: boolean } {
  const roll = rng.next();
  if (roll < 0.35) {
    const label = rng.pick(LABEL_POOL);
    const which = rng.chance(0.25) ? `the ${rng.pick(["2nd", "3rd"])} number after ` : "the number after ";
    return { text: `${which}"${label}"`, numeric: true };
  }
  if (roll < 0.5) return { text: `the json field ${rng.pick(["a", "a.b", "x.y.z", "n"])}`, numeric: false };
  if (roll < 0.65) return { text: `the count of lines matching "${rng.pick(SUBSTR_POOL)}"`, numeric: true };
  if (roll < 0.8) return { text: "exit code", numeric: true };
  return { text: "the output", numeric: false };
}

/** One full heuristics.rules text, generated from the vocabulary. */
export function generateRulesText(rng: Rng): string {
  const blocks: string[] = [];
  const used = new Set<string>();
  const count = rng.range(1, 3);
  for (let i = 0; i < count; i++) {
    let name = "";
    do {
      name = `gen-${rng.str(4, "abcdefghijklmnopqrstuvwxyz")}`;
    } while (used.has(name));
    used.add(name);

    const lines: string[] = [`heuristic ${name}`];
    lines.push(`  run      ${rng.pick(RUN_POOL)}`);
    if (rng.chance(0.2)) lines.push(`  seed     ${rng.range(1, 99999)}`);
    if (rng.chance(0.15)) lines.push(`  timeout  ${rng.range(1000, 60000)}`);

    const measures: GeneratedMeasure[] = [];
    const mCount = rng.range(1, 3);
    for (let j = 0; j < mCount; j++) {
      const mName = `m${j + 1}`;
      const extractor = generateExtractorText(rng);
      measures.push({ name: mName, ownable: true, numeric: extractor.numeric });
      lines.push(`  measure  ${mName} ${extractor.text}`);
    }

    const rules: GeneratedRule[] = [];
    const rCount = rng.range(1, 3);
    for (let j = 0; j < rCount; j++) rules.push(generateRule(rng, measures));

    const rejectable = rules.filter((r) => r.rejectsValue !== undefined);
    if (rejectable.length > 0 && rng.chance(0.5)) {
      const pick = rng.pick(rejectable);
      lines.push(`  rejects  ${pick.measure} ${pick.rejectsValue}`);
    }

    lines.push(...rules.map((r) => `  ${r.text}`));

    if (rng.chance(0.3)) lines.push(`  note     ${proseJunk(rng, 20)}`);
    if (rng.chance(0.5)) lines.push(`  because  ${proseJunk(rng, 16)}`);
    if (rng.chance(0.15)) lines.push(`  owns     tools/stub.js`);
    if (rng.chance(0.15)) lines.push(`  applies  when src/sim.js exists`);
    if (rng.chance(0.15)) lines.push(`  needs    node_modules exists`);
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n") + "\n";
}

/** String mutations — the rules target's adversarial half. */
function mutateRulesText(rng: Rng, text: string): string {
  const ops = rng.range(1, 4);
  let out = text;
  for (let i = 0; i < ops; i++) {
    const at = rng.int(Math.max(1, out.length + 1));
    switch (rng.int(7)) {
      case 0: out = out.slice(0, at); break;
      case 1: out = out.slice(0, at) + junk(rng, 8) + out.slice(at); break;
      case 2: out = out.slice(0, at) + out.slice(at + rng.range(1, Math.min(20, Math.max(1, out.length - at)))); break;
      case 3: out = out.slice(0, at) + junk(rng, 6) + out.slice(at + rng.range(1, Math.min(10, Math.max(1, out.length - at)))); break;
      case 4: {
        const len = rng.range(1, Math.min(20, Math.max(1, out.length - at)));
        out = out.slice(0, at) + out.slice(at, at + len) + out.slice(at);
        break;
      }
      case 5: {
        // A `#` mid-value: the R22 class, where the comment stripper must not
        // eat the inside of a quoted string.
        const q = out.indexOf('"', at);
        out = q === -1 ? out : out.slice(0, q + 1) + " #" + out.slice(q + 1);
        break;
      }
      default: {
        const q = out.indexOf('"', at);
        out = q === -1 ? out : out.slice(0, q) + out.slice(q + 1);
        break;
      }
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* State mutations                                                             */
/* -------------------------------------------------------------------------- */

export interface TextOp {
  kind: "insert" | "delete" | "replace" | "truncate" | "dup";
  at: number;
  text: string;
  len: number;
}

export type CorpusOpKind =
  | "flip-id" | "flip-subject" | "tamper-input" | "drop-line" | "dup-line"
  | "swap-lines" | "orphan" | "junk-line" | "merge-marker" | "bad-at";

export interface CorpusOpData {
  kind: CorpusOpKind;
  /** Selector among candidate lines, taken modulo so it never falls over. */
  pick: number;
  text: string;
}

export interface ConfigOpData {
  kind: "junk" | "no-subjects" | "empty-check";
  text: string;
}

export type StateOp =
  | { kind: "text"; file: string; op: TextOp }
  | { kind: "corpus"; op: CorpusOpData }
  | { kind: "config"; op: ConfigOpData };

const STATE_FILES = [
  ".ratchet/corpus.jsonl",
  ".ratchet/journal.jsonl",
  ".ratchet/config.json",
  ".ratchet/heuristics.rules",
  ".ratchet/tools/stub.js",
];

function textOp(rng: Rng, file: string): StateOp {
  return {
    kind: "text",
    file,
    op: {
      kind: rng.pick(["insert", "delete", "replace", "truncate", "dup"] as const),
      at: rng.int(400),
      text: junk(rng, 8),
      len: rng.range(1, 30),
    },
  };
}

const TAMPER_POOL = ["7", "-3", '{"k":1}', "[1,2]", '"s"', "null", "true"];

function corpusOp(rng: Rng): StateOp {
  const kind = rng.pick([
    "flip-id", "flip-subject", "tamper-input", "drop-line", "dup-line",
    "swap-lines", "orphan", "junk-line", "merge-marker", "bad-at",
  ] as const);
  let text = "";
  if (kind === "flip-id") text = "c" + rng.str(12, "0123456789abcdef");
  else if (kind === "flip-subject") text = "ghost-" + rng.str(4, "0123456789");
  else if (kind === "tamper-input") text = rng.pick(TAMPER_POOL);
  else if (kind === "junk-line") text = junk(rng, 20);
  return { kind: "corpus", op: { kind, pick: rng.int(20), text } };
}

function configOp(rng: Rng): StateOp {
  const kind = rng.pick(["junk", "no-subjects", "empty-check"] as const);
  return { kind: "config", op: { kind, text: kind === "junk" ? junk(rng, 30) : "" } };
}

/** One iteration's mutations: 1–4 ops, biased toward the corpus. */
export function generateStateOps(rng: Rng): StateOp[] {
  const ops: StateOp[] = [];
  for (let i = 0; i < rng.range(1, 4); i++) {
    const roll = rng.next();
    if (roll < 0.5) ops.push(corpusOp(rng));
    else if (roll < 0.8) ops.push(textOp(rng, rng.pick(STATE_FILES)));
    else if (roll < 0.9) ops.push(configOp(rng));
    else ops.push(textOp(rng, ".ratchet/heuristics.rules"));
  }
  return ops;
}

function applyTextOp(content: string, op: TextOp): string {
  const at = Math.min(op.at, content.length);
  switch (op.kind) {
    case "truncate": return content.slice(0, at);
    case "insert": return content.slice(0, at) + op.text + content.slice(at);
    case "delete": {
      const len = Math.max(1, op.len);
      return content.slice(0, at) + content.slice(Math.min(content.length, at + len));
    }
    case "replace": {
      const len = Math.max(1, op.len);
      return content.slice(0, at) + op.text + content.slice(Math.min(content.length, at + len));
    }
    case "dup": {
      const len = Math.max(1, op.len);
      const span = content.slice(at, Math.min(content.length, at + len));
      return content.slice(0, at) + span + content.slice(at);
    }
  }
}

function applyCorpusOp(text: string, op: CorpusOpData): string {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) {
    return op.kind === "junk-line" || op.kind === "merge-marker" ? op.kind === "merge-marker" ? "<<<<<<< HEAD\n" : op.text + "\n" : text;
  }
  switch (op.kind) {
    case "junk-line":
    case "merge-marker": {
      const at = op.pick % (lines.length + 1);
      lines.splice(at, 0, op.kind === "merge-marker" ? "<<<<<<< HEAD" : op.text);
      break;
    }
    case "drop-line":
      lines.splice(op.pick % lines.length, 1);
      break;
    case "dup-line": {
      const i = op.pick % lines.length;
      lines.splice(i, 0, lines[i]);
      break;
    }
    case "swap-lines": {
      if (lines.length >= 2) {
        const a = op.pick % lines.length;
        const b = (a + 1) % lines.length;
        [lines[a], lines[b]] = [lines[b], lines[a]];
      }
      break;
    }
    default: {
      const events: { idx: number; ev: Record<string, unknown> }[] = [];
      for (let i = 0; i < lines.length; i++) {
        try {
          const parsed = JSON.parse(lines[i]) as Record<string, unknown>;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) events.push({ idx: i, ev: parsed });
        } catch {
          // not an event — skip
        }
      }
      if (events.length === 0) return text;
      const target = events[op.pick % events.length];
      const ev = { ...target.ev };
      if (op.kind === "flip-id") ev.id = op.text;
      else if (op.kind === "flip-subject") ev.subject = op.text;
      else if (op.kind === "tamper-input") ev.input = JSON.parse(op.text);
      else if (op.kind === "orphan") ev.op = "accept";
      else if (op.kind === "bad-at") ev.at = "not a timestamp";
      lines[target.idx] = JSON.stringify(ev);
    }
  }
  return lines.join("\n") + "\n";
}

/** Apply ops to a fresh copy of the seed files. Pure: the seed map survives. */
export function applyStateOps(seed: Record<string, string>, ops: StateOp[]): Record<string, string> {
  const files = { ...seed };
  for (const op of ops) {
    if (op.kind === "text") {
      files[op.file] = applyTextOp(files[op.file] ?? "", op.op);
    } else if (op.kind === "config") {
      files[".ratchet/config.json"] =
        op.op.kind === "junk" ? op.op.text
        : op.op.kind === "no-subjects" ? '{"subjects":{}}\n'
        : '{"subjects":{"stub":{"check":"","owns":[".ratchet/tools/owned.txt"]}}}\n';
    } else {
      files[".ratchet/corpus.jsonl"] = applyCorpusOp(files[".ratchet/corpus.jsonl"] ?? "", op.op);
    }
  }
  return files;
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
}

/* -------------------------------------------------------------------------- */
/* Findings                                                                    */
/* -------------------------------------------------------------------------- */

export type FindingRepro =
  | { kind: "files"; files: Record<string, string>; ops: string }
  | { kind: "argv"; argv: string[] }
  | { kind: "rules"; text: string };

export interface Finding {
  target: Target;
  iteration: number;
  /** Which invariant was violated. */
  oracle: string;
  detail: string;
  repro: FindingRepro;
}

function firstLine(s: string): string {
  return s.split("\n").find((l) => l.trim() !== "") ?? "";
}

function findingSig(f: { oracle: string; detail: string }): string {
  return `${f.oracle}|${firstLine(f.detail)}`;
}

function renderError(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

/* -------------------------------------------------------------------------- */
/* Oracles — state                                                             */
/* -------------------------------------------------------------------------- */

function guardShape(r: GuardResult): string {
  return JSON.stringify({ ok: r.ok, steps: r.steps.map((s) => `${s.name}:${s.ok}`) });
}

async function runStateOracles(
  root: string,
  iteration: number,
  doDeterminism: boolean
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const home = path.join(root, ".ratchet");
  const push = (oracle: string, detail: string): void => {
    findings.push({ target: "state", iteration, oracle, detail, repro: { kind: "files", files: {}, ops: "" } });
  };

  // Oracle 1: the gate must never throw. `guard` catches a verifier refusal
  // and reports it as a step — that is designed. An exception out of the gate
  // itself is not, and nothing else would ever see it.
  let first: GuardResult;
  try {
    first = await guard(root, { ratchetHome: home });
  } catch (err) {
    push("unhandled-error", renderError(err));
    return findings;
  }

  // Oracle 2: fsck's id-verification is complete. The ids are content-
  // addressed, so the fuzzer recomputes the truth independently: a row whose
  // id does not match its content that fsck does not flag is a false pass —
  // the exact bug class this tool exists to prevent, now checked on the tool.
  const report = fsck(home, root);
  const { events } = readCorpus(path.join(home, "corpus.jsonl"));
  const rows = foldCorpus(events).rows;
  const flagged = new Set(report.findings.filter((f) => f.kind === "id-mismatch").map((f) => f.detail.split(" ")[0]));
  for (const r of rows.values()) {
    if (isLegacyId(r.id)) continue;
    if (rowId(r.subject, r.input, r.test) !== r.id && !flagged.has(r.id)) {
      push("fsck-missed-mismatch", `row ${r.id} does not match its content, and fsck reports no id-mismatch for it`);
    }
  }

  // Oracle 3: an unreadable line is named by line number. The designed
  // failure mode is "line N:", never a bare refusal. Checked on the problem
  // records themselves: a config parse error is a whole-file error and has
  // no line number by design, which is why fsck reuses the same finding kind
  // for it — the line contract belongs to line problems only.
  const corpusRead = readCorpus(path.join(home, "corpus.jsonl"));
  for (const p of corpusRead.problems) {
    if (!Number.isInteger(p.line) || p.line < 1) push("unnamed-line", `corpus problem without a usable line: ${p.error}`);
  }
  for (const p of readJournalFile(path.join(home, "journal.jsonl")).problems) {
    if (!Number.isInteger(p.line) || p.line < 1) push("unnamed-line", `journal problem without a usable line: ${p.error}`);
  }

  // Oracle 4 (sampled): the gate is deterministic. Same state, same verdict.
  if (doDeterminism) {
    let second: GuardResult;
    try {
      second = await guard(root, { ratchetHome: home });
    } catch (err) {
      push("unhandled-error-second-run", renderError(err));
      return findings;
    }
    const a = guardShape(first);
    const b = guardShape(second);
    if (a !== b) push("nondeterministic-gate", `first run: ${a}\nsecond run: ${b}`);
  }

  return findings;
}

/* -------------------------------------------------------------------------- */
/* Oracles — cli                                                               */
/* -------------------------------------------------------------------------- */

const VALUE_FLAGS = [
  "--row", "--subject", "--reason", "--actor", "--good", "--bad", "--from", "--to",
  "--setup", "--text", "--status", "--jobs", "--every", "--known-bad", "--known-good",
  "--input", "--confirm", "--route", "--file", "--viewport", "--tolerance",
  "--max-percent", "--wait-ms", "--out", "--command", "--stale-after", "--title",
];
const BOOL_FLAGS = [
  "--json", "--quiet", "--strict", "--reopen", "--allow-unvalidated", "--check",
  "--pre-push", "--dry-run", "--subjects", "--no-pinpoint",
];

/** Commands weighted so the slow, spawn-heavy ones appear less often. */
const CLI_COMMANDS: [string, number][] = [
  ["guard", 1], ["verify", 2], ["replay", 1], ["adopt", 1], ["bisect", 1],
  ["validate", 1], ["fmt", 5], ["fsck", 5], ["list", 5], ["show", 5],
  ["report", 5], ["note", 4], ["heuristics", 5], ["capture", 4],
  ["accept", 4], ["reopen", 4], ["reaffirm", 4], ["hooks", 3], ["yield", 4],
  ["pr-comment", 2], ["visual", 3], ["init", 2],
];

function pickCommand(rng: Rng): string {
  const total = CLI_COMMANDS.reduce((n, [, w]) => n + w, 0);
  let roll = rng.int(total);
  for (const [cmd, w] of CLI_COMMANDS) {
    if (roll < w) return cmd;
    roll -= w;
  }
  return "fsck";
}

export function generateCliArgv(rng: Rng): string[] {
  const argv: string[] = [pickCommand(rng)];
  const flags = rng.range(0, 4);
  for (let i = 0; i < flags; i++) {
    if (rng.chance(0.5)) {
      const f = rng.pick(VALUE_FLAGS);
      argv.push(f, rng.chance(0.3) ? "c" + rng.str(6, "0123456789abcdef") : junk(rng, 10));
    } else {
      argv.push(rng.pick(BOOL_FLAGS));
    }
  }
  if (rng.chance(0.5)) argv.push("--json");
  const positionals = rng.range(0, 3);
  for (let i = 0; i < positionals; i++) argv.push(rng.chance(0.4) ? "c" + rng.str(12, "0123456789abcdef") : junk(rng, 8));
  return argv;
}

/**
 * True when the CLI, parsing argv by its own rules, would see `--json` as a
 * boolean switch. A value flag consumes the next token, so `--text --json`
 * takes "--json" as the text — the command never enters json mode, and
 * holding it to the JSON contract would be an oracle bug, not a finding.
 */
function jsonModeRequested(argv: string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    if (a.includes("=")) continue;
    if (VALUE_FLAGS.includes(a)) {
      i++;
      continue;
    }
    if (a === "--json") return true;
  }
  return false;
}

/** Spawn the real binary with this argv and check the CLI contracts. */
export function runCliOracle(root: string, argv: string[], iteration: number): Finding[] {
  const findings: Finding[] = [];
  const push = (oracle: string, detail: string): void => {
    findings.push({ target: "cli", iteration, oracle, detail, repro: { kind: "argv", argv: [...argv] } });
  };

  const args = [path.join(__dirname, "index.js"), ...argv, "--home", path.join(root, ".ratchet")];
  const res = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 32 * 1024 * 1024,
  });

  if (res.error) {
    push("spawn-failure", `${res.error.message} (argv: ${argv.join(" ")})`);
    return findings;
  }
  const code = res.status === null ? -1 : res.status;
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";

  if (res.status === null) {
    push("timeout", `did not finish within 30s (${res.signal ?? "killed"}): argv ${argv.join(" ")}`);
    return findings;
  }
  if (code !== 0 && code !== 1) {
    push("unexpected-exit-code", `exit ${code}: argv ${argv.join(" ")}\n${firstLines(stderr || stdout, 5)}`);
  }
  // Designed failures print a message; only a crash prints stack frames to
  // stderr (V8 frames always carry file:line:col, which no message does).
  if (/^\s+at\s+[^\n]*:\d+:\d+/.test(stderr) || /uncaught|unhandled rejection/i.test(stderr + stdout)) {
    push("stack-trace", `argv ${argv.join(" ")}\n${firstLines(stderr, 8)}`);
  }
  if (jsonModeRequested(argv) && code === 0) {
    if (stdout.trim() === "") {
      push("empty-json", `--json and exit 0, but nothing on stdout: argv ${argv.join(" ")}`);
    } else {
      try {
        JSON.parse(stdout);
      } catch (err) {
        push("invalid-json", `--json stdout does not parse (${err instanceof Error ? err.message : String(err)}):\n${firstLines(stdout, 3)}`);
      }
    }
  }
  return findings;
}

/* -------------------------------------------------------------------------- */
/* Oracles — rules                                                             */
/* -------------------------------------------------------------------------- */

export function runRulesOracle(text: string, iteration: number): Finding[] {
  const findings: Finding[] = [];
  const push = (oracle: string, detail: string): void => {
    findings.push({ target: "rules", iteration, oracle, detail, repro: { kind: "rules", text } });
  };

  // The parser's contract: errors are problems, never exceptions.
  let parsed;
  try {
    parsed = parseHeuristics(text);
  } catch (err) {
    push("unhandled-error", renderError(err));
    return findings;
  }

  for (const p of parsed.problems as ParseProblem[]) {
    if (!Number.isInteger(p.line) || p.line < 1) push("bad-line-number", `problem without a usable line: ${p.message}`);
    if (typeof p.column !== "number" || p.column < 0) push("bad-column", `problem without a usable column: ${p.message}`);
  }
  if (parsed.problems.length > 0) return findings;

  // The formatter's contract: a fixpoint, and canonically identical to its
  // input. A rewrite that is stable at the wrong text — the R22 class — is
  // caught by the canonical comparison, because parsing and formatting must
  // never change what a heuristic *means*.
  const canon1 = formatHeuristics(parsed.heuristics, parsed.preamble);
  let parsed2;
  try {
    parsed2 = parseHeuristics(canon1);
  } catch (err) {
    push("canonical-output-crashes", renderError(err));
    return findings;
  }
  if (parsed2.problems.length > 0) {
    push("canonical-output-does-not-reparse", parsed2.problems.map((p) => p.message).join("; "));
    return findings;
  }
  const canon2 = formatHeuristics(parsed2.heuristics, parsed2.preamble);
  if (canon1 !== canon2) push("fmt-not-idempotent", "formatting twice yields different text");
  const after = new Map(parsed2.heuristics.map((h) => [h.name, h.canonical]));
  for (const h of parsed.heuristics) {
    if (after.get(h.name) !== h.canonical) {
      push("fmt-changed-semantics", `"${h.name}" canonical text changed across a format cycle`);
    }
  }
  return findings;
}

/* -------------------------------------------------------------------------- */
/* Minimization — the fuzzer shrinks its own repro, like capture shrinks a row */
/* -------------------------------------------------------------------------- */

/** ddmin with an async test — the same algorithm as shrink.ts, awaited. */
async function ddminAsync<T>(candidate: T[], test: (c: T[]) => Promise<boolean>, maxIterations = 40): Promise<T[]> {
  let current = candidate.slice();
  let granularity = 2;
  for (let iterations = 0; current.length >= 2 && iterations < maxIterations; iterations++) {
    const chunkSize = Math.ceil(current.length / granularity);
    let reduced = false;
    for (let i = 0; i < granularity; i++) {
      const start = i * chunkSize;
      const trial = current.slice(0, start).concat(current.slice(start + chunkSize));
      if (await test(trial)) {
        current = trial;
        granularity = Math.max(2, granularity - 1);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (granularity >= current.length) break;
      granularity = Math.min(current.length, granularity * 2);
    }
  }
  return current;
}

async function minimizeStateOps(
  root: string,
  seedFiles: Record<string, string>,
  ops: StateOp[],
  sig: string
): Promise<StateOp[]> {
  const budget: Budget = { remaining: 30 };
  const test = async (trial: StateOp[]): Promise<boolean> => {
    if (budget.remaining <= 0) return false;
    budget.remaining--;
    const files = applyStateOps(seedFiles, trial);
    writeFiles(root, files);
    const findings = await runStateOracles(root, 0, false);
    return findings.some((f) => findingSig(f) === sig);
  };
  if (ops.length < 2) return ops;
  const reduced = await ddminAsync(ops, test, 30);
  return reduced.length > 0 ? reduced : ops;
}

function minimizeCli(argv: string[], root: string, sig: string): string[] {
  if (argv.length < 2) return argv;
  const budget: Budget = { remaining: 30 };
  const test = (trial: string[]): boolean => {
    if (budget.remaining <= 0) return false;
    budget.remaining--;
    const findings = runCliOracle(root, trial, 0);
    return findings.some((f) => findingSig(f) === sig);
  };
  const reduced = ddmin(argv, test, 30);
  return reduced.length > 0 ? reduced : argv;
}

function minimizeRules(text: string, sig: string): string {
  if (text.length < 2) return text;
  const budget: Budget = { remaining: 30 };
  const test = (candidate: unknown): boolean => {
    if (budget.remaining <= 0) return false;
    budget.remaining--;
    const findings = runRulesOracle(String(candidate), 0);
    return findings.some((f) => findingSig(f) === sig);
  };
  const reduced = minimize(text, test, budget);
  return String(reduced);
}

/* -------------------------------------------------------------------------- */
/* The engine                                                                  */
/* -------------------------------------------------------------------------- */

export interface FuzzOptions {
  seed: number;
  /** Iterations per target. */
  iterations: number;
  targets: Target[];
  /** Stop after this many findings across all targets. */
  maxFindings: number;
}

export interface FuzzTargetReport {
  target: Target;
  iterations: number;
  findings: Finding[];
}

export interface FuzzReport {
  seed: number;
  targets: FuzzTargetReport[];
  ok: boolean;
}

export async function runFuzz(opts: FuzzOptions): Promise<FuzzReport> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-fuzz-"));
  const reports: FuzzTargetReport[] = [];
  try {
    const findings: Finding[] = [];
    for (const target of opts.targets) {
      const targetFindings = findings.slice();
      const rng = makeRng(opts.seed);
      if (target === "state") {
        const seedFiles = generateSeedState(root, rng);
        for (let i = 0; i < opts.iterations && findings.length < opts.maxFindings; i++) {
          const ops = generateStateOps(rng);
          const files = applyStateOps(seedFiles, ops);
          writeFiles(root, files);
          const found = await runStateOracles(root, i, i % 5 === 0);
          for (const f of found) {
            const sig = findingSig(f);
            const reduced = await minimizeStateOps(root, seedFiles, ops, sig);
            f.repro = { kind: "files", files: applyStateOps(seedFiles, reduced), ops: JSON.stringify(reduced) };
            findings.push(f);
          }
        }
      } else if (target === "cli") {
        const seedFiles = generateSeedState(root, rng);
        writeFiles(root, seedFiles);
        for (let i = 0; i < opts.iterations && findings.length < opts.maxFindings; i++) {
          // Reset to the seed state each iteration so one command's writes
          // cannot derail the next iteration's expectations.
          writeFiles(root, seedFiles);
          const argv = generateCliArgv(rng);
          const found = runCliOracle(root, argv, i);
          for (const f of found) {
            f.repro = { kind: "argv", argv: minimizeCli(argv, root, findingSig(f)) };
            findings.push(f);
          }
        }
      } else {
        for (let i = 0; i < opts.iterations && findings.length < opts.maxFindings; i++) {
          const text = mutateRulesText(rng, generateRulesText(rng));
          const found = runRulesOracle(text, i);
          for (const f of found) {
            f.repro = { kind: "rules", text: minimizeRules(text, findingSig(f)) };
            findings.push(f);
          }
        }
      }
      const mine = findings.slice(targetFindings.length);
      reports.push({ target, iterations: opts.iterations, findings: mine });
    }
    return { seed: opts.seed, targets: reports, ok: findings.length === 0 };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                   */
/* -------------------------------------------------------------------------- */

function firstLines(s: string, n: number): string {
  return s.split("\n").slice(0, n).join("\n");
}

function excerptText(text: string, maxLines = 12): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text.trimEnd();
  return lines.slice(0, maxLines).join("\n") + `\n…${lines.length - maxLines} more lines…`;
}

function reproText(f: Finding): string {
  if (f.repro.kind === "argv") return `repro: ratchet ${f.repro.argv.join(" ")}`;
  if (f.repro.kind === "rules") return `repro (rules text):\n${excerptText(f.repro.text)}`;
  const diffs: string[] = [];
  for (const [file, content] of Object.entries(f.repro.files)) {
    diffs.push(`${file}:\n${excerptText(content)}`);
  }
  return `repro (state, ops ${f.repro.ops}):\n${diffs.join("\n")}`;
}

export function formatFuzz(report: FuzzReport): string {
  const lines: string[] = [];
  const iters = report.targets.map((t) => t.iterations)[0] ?? 0;
  lines.push(`fuzz: ${report.targets.map((t) => t.target).join(",")} · ${iters} iteration(s) each · seed ${report.seed}`);
  for (const t of report.targets) {
    if (t.findings.length === 0) {
      lines.push(`✓ ${t.target.padEnd(8)} clean`);
      continue;
    }
    lines.push(`✗ ${t.target.padEnd(8)} ${t.findings.length} finding(s)`);
    for (const f of t.findings) {
      lines.push(`  [${f.oracle}] iteration ${f.iteration}: ${firstLine(f.detail)}`);
      lines.push(`  ${reproText(f)}`);
    }
  }
  lines.push("");
  lines.push(
    report.ok
      ? "fuzz passed — no oracle violated"
      : "fuzz failed: an oracle invariant was violated — see the repro above"
  );
  return lines.join("\n");
}
