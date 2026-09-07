/* eslint-disable @typescript-eslint/no-use-before-define */
/**
 * Heuristics as data — the prose form of a subject.
 *
 * Every subject through v0.6 was a host-language script, and the field
 * experiments found the check bugs living in exactly that hand-written
 * plumbing: a matchAll off-by-one, a character class that matched the "e" in
 * "percent", a null stdout crash. None of those bugs were in the *heuristic*;
 * they were in the instrument built to express it. A heuristic that reads
 *
 *     rule  edge is between -0.03 and 0.015
 *
 * has nowhere to put a bug of that class, and — the reason this file exists at
 * all — it can be written and reviewed by the person who knows the domain
 * rather than the person who knows Node.
 *
 * The vocabulary is closed and fixed by the tool, not per project. Nothing
 * here calls a model: parsing, canonicalization and evaluation are all
 * deterministic, which is the property every working piece of the ratchet has.
 *
 * Authoring is loose and storage is canonical, the way a code formatter works.
 * `ratchet fmt` snaps "should be greater than" to "is above" through a synonym
 * table; what the table cannot resolve is a hard error naming the line, the
 * column, and the nearest phrase in the vocabulary. A rewrite is never guessed.
 */

// Syntax reaching for semantics, on purpose: a declared rejection is checked
// by *evaluating* it, and the evaluator is the same one that judges a real
// run. The reverse edge — evaluate.ts naming these types — is `import type`
// and erases at compile time, so this is not a cycle.
import { checkRejection, describePredicate } from "./evaluate";

/** How a named quantity is read out of the instrument's output. */
export type Extractor =
  /**
   * `occurrence` selects *which* appearance of the label to read from, 1-based
   * and omitted when it is the first. An extractor anchored to a label used to
   * take the first match with no way to say otherwise, so a subject whose
   * natural reading is "the second `Win percent:`" had to be rewritten around
   * the instrument instead of describing it.
   */
  | { kind: "number-after"; label: string; occurrence?: number }
  | { kind: "json-field"; path: string }
  | { kind: "line-count"; substring: string }
  | { kind: "exit-code" }
  | { kind: "output" };

/** A checked clause: one predicate applied to one measure. */
export type Predicate =
  | { kind: "is"; value: string; negated: boolean }
  | { kind: "one-of"; values: string[] }
  | { kind: "above"; n: number }
  | { kind: "below"; n: number }
  | { kind: "at-least"; n: number }
  | { kind: "at-most"; n: number }
  | { kind: "between"; low: number; high: number }
  | { kind: "within-percent"; percent: number; of: number }
  | { kind: "contains"; value: string; negated: boolean }
  | { kind: "starts-with"; value: string }
  | { kind: "ends-with"; value: string }
  | { kind: "empty"; negated: boolean }
  | { kind: "is-a-number" }
  | { kind: "same-as"; measure: string }
  /**
   * An ordering between two readings of the same run. `is the same as` was
   * the only relation the vocabulary had, so "change is above keep" — the
   * natural statement of a Monty Hall check — could only be written as
   * equality, which is false, or worked around by banding raw counts against
   * the instrument's own iteration count, which couples a true rule to a
   * number that is free to change.
   */
  | { kind: "compare"; op: "above" | "below" | "at-least" | "at-most"; measure: string };

export interface Measure {
  name: string;
  extractor: Extractor;
  line: number;
}

export interface Rule {
  measure: string;
  predicate: Predicate;
  /** The canonical text of this clause, without the leading keyword. */
  text: string;
  line: number;
}

/**
 * A reading the author declares this heuristic must refuse — the second way
 * to prove a check can fail.
 *
 * Since the rules are pure predicates over named measures, they can be
 * evaluated against a hypothetical reading with no process, no git and no
 * clock. That makes a declared rejection nearly free, and it is *checked*:
 * if every rule accepts the reading, the declaration is a parse error naming
 * the line, exactly as a clause that does not parse is.
 *
 * What it establishes: the rule discriminates. What it does not, and what
 * history does: that the check catches a mistake a human actually made. The
 * two proofs are ordered, not equivalent, and both stay visible — see
 * `proof.ts`.
 */
export type Rejection =
  /** A single named reading, judged by the rules that read that measure alone. */
  | { kind: "reading"; measure: string; value: string; line: number; column: number; text: string }
  /**
   * A fabricated instrument output, run through the whole pipeline —
   * extraction and judgment both. More general and more verbose; the
   * measure-and-value form is the cheap default.
   */
  | { kind: "output"; output: string; line: number; column: number; text: string };

export interface Heuristic {
  name: string;
  /** The command that produces the observation. */
  run?: string;
  /** Run `run` through a shell. Opt-in, same contract as a scripted subject. */
  shell: boolean;
  seed?: number;
  timeoutMs?: number;
  owns: string[];
  measures: Measure[];
  rules: Rule[];
  /** Readings this heuristic declares it refuses. Checked at parse time. */
  rejects: Rejection[];
  /** Unchecked prose. Counted separately and never mistaken for a guarantee. */
  notes: string[];
  /** Why this heuristic exists — carried into failure output and the journal. */
  because?: string;
  /** Paths whose absence makes this heuristic not-applicable (exit 125). */
  appliesWhenExists: string[];
  /**
   * Paths whose absence means the *environment* cannot run this here — the
   * other job `na` used to do (exit 126).
   *
   * "The feature did not exist at this commit" and "today's toolchain cannot
   * prepare that commit" mean opposite things about the code under test, and
   * the vocabulary offered only the first. Every scripted instrument grew its
   * own three-way split by hand as a result.
   */
  needsExists: string[];
  line: number;
  /** Canonical source of this block, for display and for diffing an edit. */
  canonical: string;
  /**
   * Comment and blank lines that introduce this block, verbatim.
   */
  leading: string[];
  /**
   * The block as the author ordered it, comments included.
   *
   * `canonical` is the semantics and is what the rule hash is taken over;
   * this is the presentation. They are separate so that `fmt` can rewrite
   * wording without deleting the reasoning written beside it, and so that
   * re-ordering or re-commenting a file quarantines nothing.
   */
  layout: LayoutEntry[];
}

export type LayoutEntry =
  | { kind: "clause"; keyword: string; body: string }
  | { kind: "text"; text: string };

export interface ParseProblem {
  line: number;
  column: number;
  text: string;
  message: string;
  /** The nearest phrase in the closed vocabulary, when there is one. */
  suggestion?: string;
}

export interface ParseResult {
  heuristics: Heuristic[];
  problems: ParseProblem[];
  /** Comments in a file that declares no heuristic at all. */
  preamble: string[];
}

/* -------------------------------------------------------------------------- */
/* Canonicalization                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The synonym table. Longest phrase first, so "no less than" is not eaten by
 * "less than". Every entry is a deterministic rewrite: this is spelling
 * normalization, not interpretation.
 */
const SYNONYMS: [RegExp, string][] = [
  [/\bis\s+no\s+less\s+than\b/g, "is at least"],
  [/\bis\s+no\s+more\s+than\b/g, "is at most"],
  [/\bis\s+not\s+less\s+than\b/g, "is at least"],
  [/\bis\s+not\s+more\s+than\b/g, "is at most"],
  [/\bis\s+greater\s+than\s+or\s+equal\s+to\b/g, "is at least"],
  [/\bis\s+less\s+than\s+or\s+equal\s+to\b/g, "is at most"],
  [/\bis\s+greater\s+than\b/g, "is above"],
  [/\bis\s+more\s+than\b/g, "is above"],
  [/\bis\s+larger\s+than\b/g, "is above"],
  [/\bis\s+higher\s+than\b/g, "is above"],
  [/\bis\s+less\s+than\b/g, "is below"],
  [/\bis\s+fewer\s+than\b/g, "is below"],
  [/\bis\s+smaller\s+than\b/g, "is below"],
  [/\bis\s+lower\s+than\b/g, "is below"],
  [/\bis\s+in\s+the\s+range\b/g, "is between"],
  [/\bis\s+equal\s+to\b/g, "is"],
  [/\bequals\b/g, "is"],
  [/\bis\s+never\b/g, "is not"],
  [/\bis\s+always\b/g, "is"],
  [/\bdoes\s+not\s+include\b/g, "does not contain"],
  [/\bincludes\b/g, "contains"],
  [/\bbegins\s+with\b/g, "starts with"],
  [/\bis\s+blank\b/g, "is empty"],
  [/\bis\s+missing\b/g, "is empty"],
  [/\bis\s+numeric\b/g, "is a number"],
  [/\bis\s+the\s+same\s+value\s+as\b/g, "is the same as"],
];

/**
 * Modal verbs are how people actually write requirements, and in this grammar
 * a modal is just a copula: "the edge should be greater than -0.03" means
 * "edge is above -0.03". Negated forms are matched first, because stripping
 * "should" out of "should never be above" would invert the clause.
 */
const MODAL = "(?:should|must|shall|will|ought to|needs? to|has to|have to|can|may)";
const NEGATED_MODALS = new RegExp(`\\b${MODAL}\\s+(?:not|never)\\s+(?:be\\s+|have\\s+)?`, "g");
const MODALS = new RegExp(`\\b${MODAL}\\s+(?:be\\s+|have\\s+)?`, "g");

/** Comparison operators written as symbols. Two-character forms first. */
const OPERATORS: [RegExp, string][] = [
  [/\s*>=\s*/g, " is at least "],
  [/\s*<=\s*/g, " is at most "],
  [/\s*==\s*/g, " is "],
  [/\s*!=\s*/g, " is not "],
  [/\s*>\s*/g, " is above "],
  [/\s*<\s*/g, " is below "],
];

/**
 * Snap one clause body to canonical form.
 *
 * Quoted spans are lifted out before any rewrite and put back after, so a
 * synonym never edits the inside of a string literal the author meant
 * verbatim. The placeholder is NUL-delimited rather than space-delimited
 * because a space delimiter collides with ordinary prose: restoring
 * `count is between 1 and 5` would match the bare " 1 " and splice a string
 * literal into the middle of the band. NUL cannot occur in a clause.
 */
const SENTINEL = "\u0000";
const SENTINEL_RE = /\u0000(\d+)\u0000/g;

export function canonicalizeClause(body: string): string {
  const literals: string[] = [];
  let s = body.replace(/"[^"]*"/g, (m) => {
    literals.push(m);
    return `${SENTINEL}${literals.length - 1}${SENTINEL}`;
  });

  s = " " + s.trim() + " ";
  for (const [re, to] of OPERATORS) s = s.replace(re, to);
  s = s.replace(NEGATED_MODALS, "is not ");
  s = s.replace(MODALS, "is ");
  // A modal following a copula ("is never above") leaves "is is"; collapse it.
  s = s.replace(/\bis\s+is not\b/g, "is not").replace(/\bis\s+is\b/g, "is");
  // Articles carry no meaning here: "the edge is above" becomes "edge is
  // above". The exceptions are the two vocabulary phrases that contain one:
  // eating it turns "is the same as x" into "is same as x", which then falls
  // through to the equality catch-all and silently becomes a string compare.
  s = s.replace(/\bthe\s+(?!same\b|range\b)/g, "");
  for (const [re, to] of SYNONYMS) s = s.replace(re, to);
  // "between -0.03 to 0.015" is the other common way to write a band.
  s = s.replace(/\bis\s+between\s+(\S+)\s+to\s+/g, "is between $1 and ");
  s = s.replace(/\s+/g, " ").trim();

  return s.replace(SENTINEL_RE, (_, i) => literals[Number(i)]);
}

/**
 * Ordinal words, for the nth-match extractor. Scoped to `measure` clauses
 * rather than folded into the general synonym table: `rule status is second`
 * is an equality against the string "second", and a table that rewrote it to
 * "2nd" would silently change what that rule compares.
 */
const ORDINAL_WORDS: [RegExp, string][] = [
  [/\bfirst\b/g, "1st"], [/\bsecond\b/g, "2nd"], [/\bthird\b/g, "3rd"],
  [/\bfourth\b/g, "4th"], [/\bfifth\b/g, "5th"], [/\bsixth\b/g, "6th"],
  [/\bseventh\b/g, "7th"], [/\beighth\b/g, "8th"], [/\bninth\b/g, "9th"],
  [/\btenth\b/g, "10th"],
];

/** Snap a `measure` clause body to canonical form. */
export function canonicalizeMeasure(body: string): string {
  const literals: string[] = [];
  let s = body.replace(/"[^"]*"/g, (m) => {
    literals.push(m);
    return `${SENTINEL}${literals.length - 1}${SENTINEL}`;
  });
  for (const [re, to] of ORDINAL_WORDS) s = s.replace(re, to);
  // "the 2nd number after" reads naturally and so does "2nd number after".
  s = s.replace(SENTINEL_RE, (_, i) => literals[Number(i)]);
  return canonicalizeClause(s);
}

/* -------------------------------------------------------------------------- */
/* Vocabulary, for suggestions                                                 */
/* -------------------------------------------------------------------------- */

export const KEYWORDS = [
  "heuristic", "run", "shell", "seed", "timeout", "owns",
  "measure", "rule", "rejects", "note", "because", "applies", "needs",
];

export const PREDICATE_PHRASES = [
  "is", "is not", "is one of", "is above", "is below", "is at least",
  "is at most", "is between", "is within", "contains", "does not contain",
  "starts with", "ends with", "is empty", "is not empty", "is a number",
  "is the same as",
];

export const EXTRACTOR_PHRASES = [
  'number after "LABEL"',
  'Nth number after "LABEL"',
  "json field PATH",
  'count of lines matching "TEXT"',
  "exit code",
  "output",
];

function editDistance(a: string, b: string): number {
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** The nearest vocabulary phrase, or undefined when nothing is close enough. */
export function nearest(word: string, vocabulary: string[]): string | undefined {
  let best: string | undefined;
  let bestScore = Infinity;
  for (const v of vocabulary) {
    const d = editDistance(word.toLowerCase(), v.toLowerCase());
    if (d < bestScore) {
      bestScore = d;
      best = v;
    }
  }
  // Up to half the word may differ before the suggestion stops being one.
  return best !== undefined && bestScore <= Math.max(2, Math.floor(word.length / 2)) ? best : undefined;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

function unquote(s: string): string | undefined {
  const m = /^"([^"]*)"$/.exec(s.trim());
  return m ? m[1] : undefined;
}

/**
 * A quoted literal that may carry escapes, for `rejects output "..."`.
 *
 * The clause grammar is one line per clause and a fabricated instrument
 * output is usually several, so a backslash escape has to mean something
 * here — unlike in an extractor's label, where a literal newline cannot
 * occur and a backslash is just a character in a Windows path.
 */
export function unquoteEscaped(s: string): string | undefined {
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(s.trim());
  if (!m) return undefined;
  return m[1].replace(/\\(.)/g, (_, c: string) =>
    c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c
  );
}


/** The suffix English gives a number: 1st, 2nd, 3rd, 4th, 11th, 21st. */
export function ordinalSuffix(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return "th";
  return ["th", "st", "nd", "rd"][n % 10] ?? "th";
}

function parseNumber(s: string): number | undefined {
  const t = s.trim().replace(/%$/, "");
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isNaN(n) ? undefined : n;
}

/** Parse the body of a `measure` clause: `NAME is EXTRACTOR`, or `NAME EXTRACTOR`. */
export function parseExtractor(text: string): Extractor | { error: string; suggestion?: string } {
  const s = text.trim();
  let m: RegExpExecArray | null;

  // The ordinal prefix is optional and its suffix is not checked for
  // agreement: `fmt` rewrites "2st" to "2nd" rather than refusing it, which
  // is the same courtesy the synonym table extends to loose wording.
  if ((m = /^(?:(\d+)(?:st|nd|rd|th)\s+)?number after\s+(".*")$/.exec(s))) {
    const occurrence = m[1] === undefined ? 1 : Number(m[1]);
    if (!Number.isInteger(occurrence) || occurrence < 1) {
      return { error: `\`${m[1]}\` is not a match to count to — the first match is 1st` };
    }
    const label = unquote(m[2]);
    if (label === undefined) return { error: "the label after `number after` must be in double quotes" };
    if (label === "") return { error: "the label after `number after` is empty, so it would match anywhere" };
    return occurrence === 1
      ? { kind: "number-after", label }
      : { kind: "number-after", label, occurrence };
  }
  if ((m = /^json field\s+(\S+)$/.exec(s))) {
    return { kind: "json-field", path: m[1].replace(/^\.+|\.+$/g, "") };
  }
  if ((m = /^count of lines matching\s+(".*")$/.exec(s))) {
    const sub = unquote(m[1]);
    if (sub === undefined) return { error: "the text after `count of lines matching` must be in double quotes" };
    return { kind: "line-count", substring: sub };
  }
  if (/^exit code$/.test(s)) return { kind: "exit-code" };
  if (/^output$/.test(s)) return { kind: "output" };

  const head = s.split(/\s+/).slice(0, 2).join(" ");
  return {
    error: `not a way to measure something: "${s}"`,
    suggestion: nearest(head, EXTRACTOR_PHRASES.map((p) => p.split(/\s+/).slice(0, 2).join(" "))),
  };
}

/** Parse the body of a `rule` clause: `MEASURE PREDICATE`. */
export function parseRule(
  text: string,
  known: string[]
): { measure: string; predicate: Predicate } | { error: string; suggestion?: string } {
  const s = text.trim();

  // The measure name is the longest declared name this clause starts with, so
  // a name containing a space ("cards without images") still resolves.
  const measure = [...known]
    .sort((a, b) => b.length - a.length)
    .find((name) => s === name || s.toLowerCase().startsWith(name.toLowerCase() + " "));
  if (measure === undefined) {
    const first = s.split(/\s+/)[0];
    return {
      error: known.length
        ? `"${first}" is not a measure of this heuristic (declared: ${known.join(", ")})`
        : `"${first}" is not a measure — this heuristic declares none, so add a \`measure\` line first`,
      suggestion: nearest(first, known),
    };
  }
  const rest = s.slice(measure.length).trim();
  const predicate = parsePredicate(rest, known);
  if ("error" in predicate) return predicate;
  return { measure, predicate };
}

/** Leading words of every comparison phrase, for near-miss detection. */
const COMPARATOR_WORDS = ["above", "below", "between", "within", "at least", "at most", "one of", "empty", "a number", "the same as", "not"];

/** The declared measure this text names, if any. Longest name wins. */
function measureNamed(text: string, known: string[]): string | undefined {
  const t = text.trim();
  return [...known].sort((a, b) => b.length - a.length)
    .find((name) => name.toLowerCase() === t.toLowerCase());
}

function parsePredicate(rest: string, known: string[] = []): Predicate | { error: string; suggestion?: string } {
  let m: RegExpExecArray | null;

  if ((m = /^is between\s+(\S+)\s+and\s+(\S+)$/.exec(rest))) {
    const low = parseNumber(m[1]);
    const high = parseNumber(m[2]);
    if (low === undefined || high === undefined) {
      return { error: `\`is between\` needs two numbers, got "${m[1]}" and "${m[2]}"` };
    }
    if (low > high) return { error: `\`is between ${m[1]} and ${m[2]}\` is an empty band — the low bound is above the high one` };
    return { kind: "between", low, high };
  }
  if ((m = /^is within\s+(\S+)\s+percent of\s+(\S+)$/.exec(rest))) {
    const percent = parseNumber(m[1]);
    const of = parseNumber(m[2]);
    if (percent === undefined || of === undefined) {
      return { error: `\`is within N percent of M\` needs two numbers, got "${m[1]}" and "${m[2]}"` };
    }
    return { kind: "within-percent", percent, of };
  }
  for (const [phrase, kind] of [
    ["is above", "above"],
    ["is below", "below"],
    ["is at least", "at-least"],
    ["is at most", "at-most"],
  ] as const) {
    if (!rest.toLowerCase().startsWith(phrase + " ")) continue;
    const raw = rest.slice(phrase.length).trim();
    const n = parseNumber(raw);
    if (n !== undefined) return { kind, n } as Predicate;
    // The same comparison, against another reading of the same run. A band
    // against a constant and an ordering between two measures are both things
    // people want to say, and until now only the first could be said.
    const other = measureNamed(raw, known);
    if (other !== undefined) return { kind: "compare", op: kind, measure: other };
    return {
      error: `\`${phrase}\` needs a number or another measure, got "${raw}"`,
      suggestion: nearest(raw, known),
    };
  }
  if ((m = /^is one of\s+(.+)$/i.exec(rest))) {
    const values = m[1].split(",").map((v) => (unquote(v) ?? v).trim()).filter((v) => v !== "");
    if (values.length < 2) return { error: "`is one of` needs at least two comma-separated values" };
    return { kind: "one-of", values };
  }
  if (/^is a number$/i.test(rest)) return { kind: "is-a-number" };
  if (/^is empty$/i.test(rest)) return { kind: "empty", negated: false };
  if (/^is not empty$/i.test(rest)) return { kind: "empty", negated: true };
  if ((m = /^is the same as\s+(.+)$/i.exec(rest))) return { kind: "same-as", measure: m[1].trim() };
  if ((m = /^does not contain\s+(.+)$/i.exec(rest))) {
    return { kind: "contains", value: unquote(m[1]) ?? m[1].trim(), negated: true };
  }
  if ((m = /^contains\s+(.+)$/i.exec(rest))) {
    return { kind: "contains", value: unquote(m[1]) ?? m[1].trim(), negated: false };
  }
  if ((m = /^starts with\s+(.+)$/i.exec(rest))) return { kind: "starts-with", value: unquote(m[1]) ?? m[1].trim() };
  if ((m = /^ends with\s+(.+)$/i.exec(rest))) return { kind: "ends-with", value: unquote(m[1]) ?? m[1].trim() };
  if ((m = /^is not\s+(.+)$/i.exec(rest))) return { kind: "is", value: unquote(m[1]) ?? m[1].trim(), negated: true };
  if ((m = /^is\s+(.+)$/i.exec(rest))) {
    const value = unquote(m[1]);
    if (value === undefined) {
      // `is X` is the catch-all, and a catch-all swallows typos: "is abov 5"
      // would parse as equality against the string "abov 5" — a rule that can
      // never hold, sitting in the file looking like a guarantee. A first word
      // that is *nearly* a comparator is a misspelling, not a value.
      const first = m[1].trim().split(/\s+/)[0];
      const guess = first.length >= 3 ? nearest(first, COMPARATOR_WORDS) : undefined;
      if (guess !== undefined && guess !== first.toLowerCase()) {
        return { error: `"is ${first}" is not a comparison`, suggestion: `is ${guess}` };
      }
    }
    return { kind: "is", value: value ?? m[1].trim(), negated: false };
  }

  const head = rest.split(/\s+/).slice(0, 3).join(" ");
  return {
    error: rest === "" ? "this rule says nothing about the measure" : `not a way to check something: "${rest}"`,
    suggestion: nearest(head, PREDICATE_PHRASES),
  };
}

/**
 * Parse a `.rules` file. Blocks open with `heuristic <name>`; every other
 * clause belongs to the block above it.
 *
 * Parsing never throws and never stops at the first problem: an author fixing
 * a file wants every complaint at once, and a caller that must refuse (verify,
 * capture) refuses on `problems.length > 0`.
 */
export function parseHeuristics(source: string, canonicalizeFirst = true): ParseResult {
  const lines = source.split(/\r?\n/);
  const heuristics: Heuristic[] = [];
  const problems: ParseProblem[] = [];
  let current: Heuristic | undefined;
  const canonicalLines: string[][] = [];
  // Comments and blank lines buffer until the next clause or heuristic, so a
  // comment introducing a block stays attached to the block it introduces
  // rather than trailing the one above it.
  let pending: string[] = [];

  const problem = (line: number, column: number, text: string, message: string, suggestion?: string): void => {
    problems.push({ line, column, text, message, suggestion });
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;
    const stripped = raw.replace(/(^|\s)#.*$/, "$1");
    const trimmed = stripped.trim();
    if (trimmed === "") {
      // Not noise: a comment is the author's reasoning, and `fmt` rewriting
      // the file must not throw it away.
      pending.push(raw.trimEnd());
      continue;
    }

    const indent = stripped.length - stripped.trimStart().length;
    const kwMatch = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
    if (!kwMatch) continue;
    const keyword = kwMatch[1].toLowerCase();
    let body = (kwMatch[2] ?? "").trim();

    if (keyword === "heuristic") {
      if (!body) {
        problem(lineNo, indent + 1, raw, "`heuristic` needs a name");
        continue;
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(body)) {
        problem(lineNo, indent + kwMatch[1].length + 2, raw,
          `"${body}" is not a usable subject name — use letters, digits, dots, dashes and underscores`);
        continue;
      }
      if (heuristics.some((h) => h.name === body)) {
        problem(lineNo, indent + 1, raw, `heuristic "${body}" is declared twice — subject names must be unique`);
        continue;
      }
      current = {
        name: body, shell: false, owns: [], measures: [], rules: [], rejects: [], notes: [],
        appliesWhenExists: [], needsExists: [], line: lineNo, canonical: "",
        leading: trimLeadingBlanks(pending), layout: [],
      };
      pending = [];
      heuristics.push(current);
      canonicalLines.push([`heuristic ${body}`]);
      continue;
    }

    if (!current) {
      problem(lineNo, indent + 1, raw,
        `"${keyword}" appears before any \`heuristic\` line — every clause belongs to a heuristic`,
        nearest(keyword, ["heuristic"]));
      continue;
    }
    const canonLines = canonicalLines[canonicalLines.length - 1];
    const layout = current.layout;
    for (const text of pending) layout.push({ kind: "text", text: text.trim() });
    pending = [];
    // One helper writes both records: the semantic line that is hashed, and
    // the ordered entry that is rendered.
    const canon = {
      /**
       * `line` is the canonical clause — normalized, single-spaced, and what
       * the rule hash is taken over. `display` is how it should be written
       * back to the file when the two differ (a `measure` reads better with
       * its name in a column). Presentation never reaches the hash.
       */
      push(line: string, display?: string): void {
        canonLines.push(line);
        const m = /^\s+(\S+)\s?([\s\S]*)$/.exec(line);
        if (m) layout.push({ kind: "clause", keyword: m[1], body: display ?? m[2].trim() });
      },
    };
    const bodyColumn = indent + kwMatch[1].length + 2;

    switch (keyword) {
      case "run":
        if (!body) { problem(lineNo, bodyColumn, raw, "`run` needs a command"); break; }
        if (current.run !== undefined) {
          problem(lineNo, indent + 1, raw, `"${current.name}" already has a \`run\` command on line ${current.line}`);
          break;
        }
        current.run = body;
        canon.push(`  run ${body}`);
        break;

      case "shell":
        current.shell = !/^(no|false|off)$/i.test(body);
        canon.push(`  shell ${current.shell}`);
        break;

      case "seed": {
        const n = parseNumber(body);
        if (n === undefined || !Number.isInteger(n)) {
          problem(lineNo, bodyColumn, raw, `\`seed\` needs a whole number, got "${body}"`);
          break;
        }
        current.seed = n;
        canon.push(`  seed ${n}`);
        break;
      }

      case "timeout": {
        const n = parseNumber(body.replace(/\s*ms$/i, ""));
        if (n === undefined || n <= 0) {
          problem(lineNo, bodyColumn, raw, `\`timeout\` needs a positive number of milliseconds, got "${body}"`);
          break;
        }
        current.timeoutMs = n;
        canon.push(`  timeout ${n}`);
        break;
      }

      case "owns":
        if (!body) { problem(lineNo, bodyColumn, raw, "`owns` needs a path"); break; }
        current.owns.push(unquote(body) ?? body);
        canon.push(`  owns ${unquote(body) ?? body}`);
        break;

      case "measure": {
        if (canonicalizeFirst) body = canonicalizeMeasure(body);
        // `measure NAME is EXTRACTOR` and `measure NAME EXTRACTOR` both read
        // naturally; the copula is optional and carries no meaning.
        const split = /^(\S+(?:\s+\S+)*?)\s+(?:is\s+)?(\d+(?:st|nd|rd|th)\s+number after\b[\s\S]*|number after\b[\s\S]*|json field\b[\s\S]*|count of lines\b[\s\S]*|exit code$|output$)/.exec(body);
        if (!split) {
          const parsedNoName = parseExtractor(body);
          problem(lineNo, bodyColumn, raw,
            "error" in parsedNoName
              ? `\`measure\` reads: measure <name> <how to read it>. ${parsedNoName.error}`
              : "`measure` needs a name before the extractor, as in: measure edge " + body,
            "error" in parsedNoName ? parsedNoName.suggestion : undefined);
          break;
        }
        const name = split[1].trim();
        const ex = parseExtractor(split[2]);
        if ("error" in ex) {
          problem(lineNo, bodyColumn + split[1].length + 1, raw, ex.error, ex.suggestion);
          break;
        }
        if (current.measures.some((x) => x.name === name)) {
          problem(lineNo, bodyColumn, raw, `"${name}" is measured twice in "${current.name}"`);
          break;
        }
        current.measures.push({ name, extractor: ex, line: lineNo });
        canon.push(`  measure ${name} ${describeExtractor(ex)}`, `${name}  ${describeExtractor(ex)}`);
        break;
      }

      case "rule": {
        if (canonicalizeFirst) body = canonicalizeClause(body);
        const parsed = parseRule(body, current.measures.map((x) => x.name));
        if ("error" in parsed) {
          problem(lineNo, bodyColumn, raw, parsed.error, parsed.suggestion);
          break;
        }
        current.rules.push({ measure: parsed.measure, predicate: parsed.predicate, text: body, line: lineNo });
        canon.push(`  rule ${body}`);
        break;
      }

      case "rejects": {
        // Deliberately not canonicalized: the right-hand side is a *value*,
        // and running the synonym table over it would rewrite the very reading
        // the author is claiming the rules refuse.
        if (!body) {
          problem(lineNo, bodyColumn, raw,
            "`rejects` reads: rejects <measure> <a value the rules must refuse>, or rejects output \"...\"");
          break;
        }
        const outM = /^output\s+("[\s\S]*")$/.exec(body);
        if (outM) {
          // `output` is also a way to measure, so a heuristic that names a
          // measure `output` makes this clause ambiguous. Say so rather than
          // picking one reading and hoping.
          if (current.measures.some((x) => x.name.toLowerCase() === "output")) {
            problem(lineNo, bodyColumn, raw,
              `"rejects output ..." means a fabricated instrument output, but "${current.name}" also measures something called "output" -- rename the measure`);
            break;
          }
          const text = unquoteEscaped(outM[1]);
          if (text === undefined) {
            problem(lineNo, bodyColumn + 7, raw, "the output after `rejects output` must be one double-quoted string");
            break;
          }
          current.rejects.push({ kind: "output", output: text, line: lineNo, column: bodyColumn, text: body });
          canon.push(`  rejects output ${outM[1]}`);
          break;
        }
        const knownNames = current.measures.map((x) => x.name);
        const rejected = [...knownNames]
          .sort((a, b) => b.length - a.length)
          .find((name) => body.toLowerCase().startsWith(name.toLowerCase() + " "));
        if (rejected === undefined) {
          const first = body.split(/\s+/)[0];
          problem(lineNo, bodyColumn, raw,
            knownNames.length
              ? `"${first}" is not a measure of this heuristic (declared: ${knownNames.join(", ")})`
              : `\`rejects\` names a measure and a value, and this heuristic declares no measure yet`,
            nearest(first, knownNames));
          break;
        }
        const rawValue = body.slice(rejected.length).trim();
        if (rawValue === "") {
          problem(lineNo, bodyColumn + rejected.length + 1, raw,
            `\`rejects ${rejected}\` names no value — say what reading of ${rejected} the rules must refuse`);
          break;
        }
        current.rejects.push({
          kind: "reading",
          measure: rejected,
          value: unquote(rawValue) ?? rawValue,
          line: lineNo,
          column: bodyColumn,
          text: `${rejected} ${rawValue}`,
        });
        canon.push(`  rejects ${rejected} ${rawValue}`);
        break;
      }

      case "note":
        if (!body) { problem(lineNo, bodyColumn, raw, "`note` needs some text"); break; }
        current.notes.push(body);
        canon.push(`  note ${body}`);
        break;

      case "because":
        if (!body) { problem(lineNo, bodyColumn, raw, "`because` needs some text"); break; }
        current.because = current.because ? `${current.because} ${body}` : body;
        canon.push(`  because ${body}`);
        break;

      case "needs": {
        const m = /^(.+?)\s+(?:to\s+)?exists?$/i.exec(body);
        if (!m) {
          problem(lineNo, bodyColumn, raw,
            "`needs` reads: needs <path> exists — it makes the heuristic report \"could not run here\" where that path is absent, " +
              "which is different from `applies when <path> exists` (\"this did not exist yet\") and from a failure");
          break;
        }
        const p = (unquote(m[1]) ?? m[1]).trim();
        current.needsExists.push(p);
        canon.push(`  needs ${p} exists`);
        break;
      }

      case "applies": {
        const m = /^when\s+(.+?)\s+exists$/i.exec(body);
        if (!m) {
          problem(lineNo, bodyColumn, raw,
            "the only applicability clause is: applies when <path> exists — it makes the heuristic report n/a where that path is absent, instead of failing");
          break;
        }
        const p = (unquote(m[1]) ?? m[1]).trim();
        current.appliesWhenExists.push(p);
        canon.push(`  applies when ${p} exists`);
        break;
      }

      default:
        problem(lineNo, indent + 1, raw, `"${keyword}" is not a clause keyword`, nearest(keyword, KEYWORDS));
    }
  }

  // Trailing comments belong to the last block, or to the file when it
  // declares none (which is what `ratchet init` writes).
  const preamble = heuristics.length === 0 ? pending : [];
  if (heuristics.length > 0) {
    for (const text of trimTrailingBlanks(pending)) {
      heuristics[heuristics.length - 1].layout.push({ kind: "text", text: text.trim() });
    }
  }

  for (let i = 0; i < heuristics.length; i++) {
    const h = heuristics[i];
    h.canonical = canonicalLines[i].join("\n");
    if (h.run === undefined) {
      problems.push({
        line: h.line, column: 1, text: `heuristic ${h.name}`,
        message: `"${h.name}" has no \`run\` command, so there is nothing to measure`,
      });
    }
    // ...unless a rule line in this block already failed to parse. The
    // author has a typo, not a missing clause, and reporting the consequence
    // alongside the cause just buries the line they need to fix.
    const ruleLineFailed = problems.some(
      (p) => p.line >= h.line && (i + 1 >= heuristics.length || p.line < heuristics[i + 1].line)
    );
    if (h.rules.length === 0 && !ruleLineFailed) {
      problems.push({
        line: h.line, column: 1, text: `heuristic ${h.name}`,
        message:
          `"${h.name}" has no \`rule\` clause, so it can never fail — a check that cannot fail is a green light over nothing` +
          (h.notes.length ? ". Its \`note\` lines are prose only and are never checked" : ""),
      });
    }
    for (const r of h.rules) {
      // A relational rule naming a measure that does not exist would sit in
      // the file looking like a guarantee while comparing against nothing.
      const other = r.predicate.kind === "same-as" || r.predicate.kind === "compare" ? r.predicate.measure : undefined;
      if (other === undefined || h.measures.some((x) => x.name === other)) continue;
      problems.push({
        line: r.line, column: 1, text: r.text,
        message: `\`${describePredicate(r.predicate)}\` names something "${h.name}" does not measure`,
        suggestion: nearest(other, h.measures.map((x) => x.name)),
      });
    }

    // The declared rejections, checked. A proof that does not prove anything
    // is caught here, the same way a clause that does not parse is: with a
    // line, a column, and the reason in the author's own terms.
    //
    // Skipped when a rule in this block already failed to parse — the rules
    // the rejection would be judged against are not all present, so the
    // complaint would be about a consequence rather than about the cause.
    if (!ruleLineFailed) {
      for (const r of h.rejects) {
        const check = checkRejection(h, r);
        if (check.ok) continue;
        problems.push({
          line: r.line, column: r.column,
          text: source.split(/\r?\n/)[r.line - 1] ?? `rejects ${r.text}`,
          message: check.problem!,
        });
      }
    }
  }

  return { heuristics, problems, preamble };
}

function trimLeadingBlanks(lines: string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && out[0].trim() === "") out.shift();
  return out;
}

function trimTrailingBlanks(lines: string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return out;
}

export function describeExtractor(e: Extractor): string {
  switch (e.kind) {
    case "number-after": {
      const n = e.occurrence ?? 1;
      const which = n === 1 ? "" : `${n}${ordinalSuffix(n)} `;
      return `${which}number after "${e.label}"`;
    }
    case "json-field": return `json field ${e.path}`;
    case "line-count": return `count of lines matching "${e.substring}"`;
    case "exit-code": return "exit code";
    case "output": return "output";
  }
}

/**
 * Render one heuristic as the file should hold it: canonical clauses, with
 * the keyword column aligned so a block reads like a small table.
 *
 * Layout is deliberately NOT part of `canonical`, which is what the rule hash is
 * taken over. Re-aligning a file, or adding a longer keyword to one block,
 * must never quarantine every row in the repository — a cosmetic edit is not a
 * change of expectation, and a tool that treats it as one teaches people to
 * stop touching the file.
 */
export function renderHeuristic(h: Heuristic): string {
  const width = Math.max(
    7,
    ...h.layout.filter((e): e is { kind: "clause"; keyword: string; body: string } => e.kind === "clause")
      .map((e) => e.keyword.length)
  );
  const lines = [...h.leading.map((l) => l.trim()), `heuristic ${h.name}`];
  for (const entry of h.layout) {
    if (entry.kind === "text") lines.push(entry.text === "" ? "" : `  ${entry.text}`);
    else lines.push(`  ${entry.keyword.padEnd(width)}  ${entry.body}`);
  }
  return lines.join("\n");
}

/** Re-render a parsed file in canonical form: what `ratchet fmt` writes. */
export function formatHeuristics(heuristics: Heuristic[], preamble: string[] = []): string {
  // A file with no heuristics is all comments — which is exactly what
  // `ratchet init` writes, and it must not be reported as non-canonical on a
  // brand-new project.
  if (heuristics.length === 0) {
    return preamble.length === 0 ? "" : preamble.map((l) => l.trimEnd()).join("\n") + "\n";
  }
  return heuristics.map(renderHeuristic).join("\n\n") + "\n";
}

/**
 * Render a parse problem the way a compiler does: the location, the source
 * line, a caret under the offending column, and the nearest vocabulary phrase.
 * Vague errors are how a tool like this loses its users.
 */
export function formatProblem(file: string, p: ParseProblem): string {
  const out = [`${file}:${p.line}:${p.column}: ${p.message}`];
  if (p.text.trim() !== "") {
    const gutter = String(p.line).padStart(4);
    out.push(`${gutter} | ${p.text}`);
    out.push(`${" ".repeat(4)} | ${" ".repeat(Math.max(0, p.column - 1))}^`);
  }
  if (p.suggestion) out.push(`     did you mean \`${p.suggestion}\`?`);
  return out.join("\n");
}

/** A one-line summary of what a heuristic checks, for listings. */
export function summarize(h: Heuristic): string {
  return h.rules.map((r) => r.text).join("; ");
}
