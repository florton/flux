/**
 * Reading measures out of an instrument's output, and checking rules against
 * them. Pure functions: no spawning, no filesystem, no clock — so the whole
 * semantics of a prose heuristic is testable without running anything.
 *
 * The output of every function here is a *witness*: the measured value, in
 * the words of the rule that judged it. "edge measured -0.0765, rule says
 * between -0.03 and 0.015" is a number a reviewer can act on; "check failed"
 * is not, and the difference is most of what makes this tool usable.
 */
import { ordinalSuffix } from "./heuristics";
import type { Extractor, Heuristic, Predicate, Rejection, Rule } from "./heuristics";

export type Measured = number | string | null;

export interface Extraction {
  name: string;
  value: Measured;
  /** Why the value could not be read. Set only when `value` is null. */
  error?: string;
}

/** Everything the instrument produced, which is all an extractor may look at. */
export interface Observation {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * The first number following the `occurrence`th appearance of `label`.
 *
 * Counting appearances of the *label* rather than of numbers is what makes
 * "the second `Win percent:`" mean what a reader thinks it means: the second
 * time the instrument said that thing, not the second number after the first
 * time it did.
 */
function numberAfter(text: string, label: string, occurrence = 1): number | undefined {
  const haystack = text.toLowerCase();
  const needle = label.toLowerCase();
  let idx = -1;
  for (let i = 0; i < occurrence; i++) {
    idx = haystack.indexOf(needle, idx === -1 ? 0 : idx + needle.length);
    if (idx === -1) return undefined;
  }
  const after = text.slice(idx + label.length);
  // The first numeric literal following the label, exponents and signs
  // included. Anchored to the label rather than pattern-matched over the
  // whole line: a label that appears mid-line still reads left to right.
  const m = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(after);
  if (!m) return undefined;
  const n = Number(m[0]);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * A readable slice of what a crashed instrument printed.
 *
 * The head alone is the wrong half. A test runner opens with a banner and puts
 * the verdict at the end; a compiler opens with the first error and a stack
 * trace ends with the frame that matters. Showing four leading lines of a TAP
 * stream produced `TAP version 13 | # Subtest: ... | ok 1 - ...` as the
 * witness for a suite that failed somewhere in the middle — technically the
 * output, and useless.
 *
 * So: both ends, and say plainly how much was dropped, because the one thing
 * worse than a short excerpt is a short excerpt that looks complete.
 */
export function excerpt(output: string, opts: { head?: number; tail?: number; quote?: boolean } = {}): string {
  if (output === "") return "(no output)";
  const head = opts.head ?? 3;
  const tail = opts.tail ?? 5;
  const lines = output.split(/\r?\n/);
  // Quoting is right for a short preview, where the reader needs to see where
  // a line ends and whether it is blank, and wrong for a wall of test output,
  // where it doubles the noise.
  const clip = (l: string): string => {
    const t = l.length > 160 ? l.slice(0, 160) + "…" : l;
    return opts.quote ? JSON.stringify(t) : t;
  };
  if (lines.length <= head + tail) return lines.map(clip).join(" | ");
  return (
    lines.slice(0, head).map(clip).join(" | ") +
    ` | …${lines.length - head - tail} more lines… | ` +
    lines.slice(-tail).map(clip).join(" | ")
  );
}

function readJsonPath(text: string, dotted: string): { value: Measured } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch (err) {
    const head = text.trim().split("\n")[0] ?? "";
    return {
      error:
        `the output is not JSON (${err instanceof Error ? err.message : String(err)})` +
        (head ? `; it starts with: ${JSON.stringify(head.slice(0, 80))}` : " and is empty"),
    };
  }
  let cur: unknown = parsed;
  const segments = dotted === "" ? [] : dotted.split(".");
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (cur === null || typeof cur !== "object") {
      return { error: `\`${segments.slice(0, i).join(".") || "the root"}\` is not an object, so \`${dotted}\` cannot be read` };
    }
    const container = cur as Record<string, unknown>;
    if (!(seg in container)) {
      const available = Object.keys(container).slice(0, 8).join(", ");
      return {
        error:
          `the output has no \`${segments.slice(0, i + 1).join(".")}\`` +
          (available ? `; it has: ${available}` : " and is empty"),
      };
    }
    cur = container[seg];
  }
  if (cur === null) return { value: null };
  if (typeof cur === "number" || typeof cur === "string") return { value: cur };
  if (typeof cur === "boolean") return { value: String(cur) };
  if (Array.isArray(cur)) return { value: cur.length };
  return { value: JSON.stringify(cur) };
}

export function extract(name: string, e: Extractor, obs: Observation): Extraction {
  switch (e.kind) {
    case "exit-code":
      return { name, value: obs.exitCode ?? -1 };

    case "output":
      return { name, value: obs.stdout.trim() };

    case "line-count": {
      const needle = e.substring.toLowerCase();
      const count = obs.stdout
        .split(/\r?\n/)
        .filter((l) => l.toLowerCase().includes(needle)).length;
      return { name, value: count };
    }

    case "number-after": {
      const which = e.occurrence ?? 1;
      const n = numberAfter(obs.stdout, e.label, which);
      if (n === undefined) {
        const seen = obs.stdout.trim();
        const preview = seen === ""
          ? "the command printed nothing on stdout"
          : `the command printed: ${excerpt(seen, { head: 2, tail: 2, quote: true })}`;
        return {
          name,
          value: null,
          error:
            (obs.stdout.toLowerCase().split(e.label.toLowerCase()).length - 1 >= which
              ? `found ${which === 1 ? "" : `the ${which}${ordinalSuffix(which)} `}"${e.label}" in the output but no number after it`
              : which === 1
                ? `no "${e.label}" in the output`
                : `fewer than ${which} "${e.label}" in the output`) + ` — ${preview}`,
        };
      }
      return { name, value: n };
    }

    case "json-field": {
      const r = readJsonPath(obs.stdout, e.path);
      return "error" in r ? { name, value: null, error: r.error } : { name, value: r.value };
    }
  }
}

function asNumber(v: Measured): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}

const COMPARISON_PHRASE = {
  above: "above", below: "below", "at-least": "at least", "at-most": "at most",
} as const;

export function describePredicate(p: Predicate): string {
  switch (p.kind) {
    case "is": return `${p.negated ? "is not" : "is"} ${p.value}`;
    case "one-of": return `is one of ${p.values.join(", ")}`;
    case "above": return `is above ${p.n}`;
    case "below": return `is below ${p.n}`;
    case "at-least": return `is at least ${p.n}`;
    case "at-most": return `is at most ${p.n}`;
    case "between": return `is between ${p.low} and ${p.high}`;
    case "within-percent": return `is within ${p.percent} percent of ${p.of}`;
    case "contains": return `${p.negated ? "does not contain" : "contains"} "${p.value}"`;
    case "starts-with": return `starts with "${p.value}"`;
    case "ends-with": return `ends with "${p.value}"`;
    case "empty": return p.negated ? "is not empty" : "is empty";
    case "is-a-number": return "is a number";
    case "same-as": return `is the same as ${p.measure}`;
    case "compare": return `is ${COMPARISON_PHRASE[p.op]} ${p.measure}`;
  }
}

export interface Judgement {
  ok: boolean;
  /** The measured value stated in the rule's own terms. */
  witness: string;
  /**
   * True when the predicate actually judged the value, false when it bailed
   * out — the value was unreadable, or was not a number where a number was
   * needed. A declared rejection (`rejects`) is only a proof when some rule
   * *judged* the reading and refused it; "the extractor found nothing" would
   * otherwise pass for a proof that the band discriminates, which is exactly
   * the vacuity the gate exists to catch.
   */
  checked: boolean;
}

export function judge(rule: Rule, values: Map<string, Measured>): Judgement {
  const p = rule.predicate;
  const value = values.get(rule.measure) ?? null;
  const shown = value === null ? "nothing" : typeof value === "string" ? JSON.stringify(value) : String(value);
  const stated = `${rule.measure} measured ${shown}, rule says "${rule.measure} ${describePredicate(p)}"`;

  // A rule over a value that could not be read is a failure, not a pass. The
  // instrument stopped producing the number the heuristic is about, and
  // greening that is the false pass this tool exists to prevent.
  if (value === null && p.kind !== "empty") {
    return { ok: false, checked: false, witness: `${rule.measure} could not be measured, so "${rule.measure} ${describePredicate(p)}" cannot be checked` };
  }

  const needNumber = (n: number | undefined, check: (x: number) => boolean): Judgement => {
    if (n === undefined) {
      return { ok: false, checked: false, witness: `${rule.measure} measured ${shown}, which is not a number, so "${describePredicate(p)}" cannot be checked` };
    }
    return { ok: check(n), checked: true, witness: stated };
  };
  const text = value === null ? "" : String(value);

  switch (p.kind) {
    case "is": {
      const equal = text === p.value || asNumber(value) === asNumber(p.value) && asNumber(value) !== undefined;
      return { ok: p.negated ? !equal : equal, checked: true, witness: stated };
    }
    case "one-of":
      return { ok: p.values.some((v) => v === text || (asNumber(v) !== undefined && asNumber(v) === asNumber(value))), checked: true, witness: stated };
    case "above": return needNumber(asNumber(value), (x) => x > p.n);
    case "below": return needNumber(asNumber(value), (x) => x < p.n);
    case "at-least": return needNumber(asNumber(value), (x) => x >= p.n);
    case "at-most": return needNumber(asNumber(value), (x) => x <= p.n);
    case "between": return needNumber(asNumber(value), (x) => x >= p.low && x <= p.high);
    case "within-percent":
      return needNumber(asNumber(value), (x) => {
        // Against a zero target, "within N percent" has no meaning as a ratio;
        // the only honest reading is exact equality.
        if (p.of === 0) return x === 0;
        return Math.abs((x - p.of) / p.of) * 100 <= p.percent;
      });
    case "contains": {
      const has = text.includes(p.value);
      return { ok: p.negated ? !has : has, checked: true, witness: stated };
    }
    case "starts-with": return { ok: text.startsWith(p.value), checked: true, witness: stated };
    case "ends-with": return { ok: text.endsWith(p.value), checked: true, witness: stated };
    case "empty": {
      const empty = value === null || text.trim() === "" || value === 0;
      return { ok: p.negated ? !empty : empty, checked: true, witness: stated };
    }
    case "is-a-number": return { ok: asNumber(value) !== undefined, checked: true, witness: stated };
    case "same-as": {
      const other = values.get(p.measure) ?? null;
      const same = String(other) === text;
      return {
        ok: same,
        checked: other !== null,
        witness: `${rule.measure} measured ${shown} and ${p.measure} measured ${other === null ? "nothing" : String(other)}`,
      };
    }
    case "compare": {
      const other = values.get(p.measure) ?? null;
      const a = asNumber(value);
      const b = asNumber(other);
      if (a === undefined || b === undefined) {
        const bad = a === undefined ? rule.measure : p.measure;
        const badValue = a === undefined ? value : other;
        return {
          ok: false,
          checked: false,
          witness:
            `${bad} measured ${badValue === null ? "nothing" : JSON.stringify(String(badValue))}, which is not a number,` +
            ` so "${rule.measure} ${describePredicate(p)}" cannot be checked`,
        };
      }
      const ok = p.op === "above" ? a > b : p.op === "below" ? a < b : p.op === "at-least" ? a >= b : a <= b;
      return {
        ok,
        checked: true,
        witness: `${rule.measure} measured ${a} and ${p.measure} measured ${b}, rule says "${rule.measure} ${describePredicate(p)}"`,
      };
    }
  }
}

export interface Evaluation {
  /** null when every rule held. */
  failure: string | null;
  extractions: Extraction[];
  /** Every measured value, whether or not a rule looked at it. */
  readings: string[];
  /** Measures a rule needed and the extractor could not read. */
  unreadable: string[];
  /**
   * Witnesses from rules that judged a value that *was* read.
   *
   * Kept apart from the unreadable set because they answer different
   * questions: a rule that refused a number is the heuristic working, and a
   * rule that could not find its number is the instrument broken. Only the
   * first is evidence that the rule discriminates.
   */
  ruleFailures: string[];
}

/** The other measure a predicate reads, when it reads one. */
export function comparedMeasure(p: Predicate): string | undefined {
  return p.kind === "same-as" || p.kind === "compare" ? p.measure : undefined;
}

/**
 * Run every rule of a heuristic against one observation.
 *
 * All rules are evaluated, not just up to the first failure: a heuristic that
 * fails three ways at once should say so in one run, because the human reading
 * it is deciding whether the code moved or the heuristic did.
 */
export function evaluateHeuristic(h: Heuristic, obs: Observation): Evaluation {
  const extractions = h.measures.map((m) => extract(m.name, m.extractor, obs));
  const values = new Map<string, Measured>(extractions.map((e) => [e.name, e.value]));
  const readings = extractions.map((e) =>
    e.value === null
      ? `${e.name}=<unreadable: ${e.error ?? "no value"}>`
      : `${e.name}=${typeof e.value === "string" ? JSON.stringify(e.value) : e.value}`
  );

  const broken: string[] = [];
  const ruleFailures: string[] = [];

  // A measure the instrument stopped producing is reported once, not once
  // per rule that mentions it: three rules over one missing number is one
  // broken instrument, and saying it three times buries the fact. A measure
  // is "needed" when a rule reads it directly *or* compares another reading
  // against it — the second half was missing, so `change is above keep` with
  // an unreadable `keep` said "keep measured nothing" without ever saying
  // why the extractor came back empty.
  const needed = (name: string): boolean =>
    h.rules.some(
      (r) =>
        (r.measure === name && r.predicate.kind !== "empty") ||
        comparedMeasure(r.predicate) === name
    );
  const unreadable = new Set<string>();
  for (const e of extractions) {
    if (e.value !== null || e.error === undefined) continue;
    if (!needed(e.name)) continue;
    unreadable.add(e.name);
    broken.push(`${e.name} could not be measured: ${e.error}`);
  }

  for (const rule of h.rules) {
    const other = comparedMeasure(rule.predicate);
    if (unreadable.has(rule.measure) || (other !== undefined && unreadable.has(other))) continue;
    const j = judge(rule, values);
    if (!j.ok) ruleFailures.push(j.witness);
  }

  const failures = [...broken, ...ruleFailures];
  return {
    failure: failures.length === 0 ? null : failures.join("; "),
    extractions,
    readings,
    unreadable: [...unreadable],
    ruleFailures,
  };
}

/* -------------------------------------------------------------------------- */
/* Declared rejections — proof without history                                 */
/* -------------------------------------------------------------------------- */

export interface RejectionCheck {
  /** True when some rule judged the declared reading and refused it. */
  ok: boolean;
  /** Why the declaration is not a proof. Set only when `ok` is false. */
  problem?: string;
  /** The witnesses of the rules that refused it, in the rule's own words. */
  refusedBy: string[];
}

/** A value as an extractor would have produced it: a number when it reads as one. */
function asMeasured(raw: string): Measured {
  const t = raw.trim();
  if (t === "") return "";
  const n = Number(t);
  return t !== "" && !Number.isNaN(n) ? n : raw;
}

/**
 * Check one declared rejection against the rules that would judge it.
 *
 * This is the whole of the second proof tier, and it is deliberately a pure
 * function over parsed data: no process, no git, no clock. That is what makes
 * a declared rejection nearly free to state and impossible to fake — the same
 * evaluator that judges a real run judges the hypothetical one.
 */
export function checkRejection(h: Heuristic, r: Rejection): RejectionCheck {
  if (r.kind === "output") {
    const evaluation = evaluateHeuristic(h, { stdout: r.output, stderr: "", exitCode: 0 });
    if (evaluation.ruleFailures.length > 0) {
      return { ok: true, refusedBy: evaluation.ruleFailures };
    }
    // Every failure was an unreadable measure. That says the fabricated output
    // does not look like this instrument's output — it does not say the rules
    // discriminate, which is the only thing this clause claims to prove.
    if (evaluation.unreadable.length > 0) {
      return {
        ok: false,
        refusedBy: [],
        problem:
          `you declared that "${h.name}" rejects this output, and no rule ever judged it:` +
          ` ${evaluation.unreadable.join(", ")} could not be read out of it at all` +
          ` (${evaluation.extractions.filter((e) => e.value === null).map((e) => e.error).join("; ")}).` +
          ` A fabricated output that the extractors cannot read proves nothing about the rules`,
      };
    }
    return {
      ok: false,
      refusedBy: [],
      problem:
        `you declared that "${h.name}" rejects this output, and every rule accepts it` +
        ` (${evaluation.readings.join(" ")}) — so this heuristic has not been shown to discriminate`,
    };
  }

  // A single reading determines a verdict only for rules that judge that
  // measure on its own. A relational rule needs both sides, so it is not
  // evidence here and saying so is more useful than quietly ignoring it.
  const own = h.rules.filter((rule) => rule.measure === r.measure && comparedMeasure(rule.predicate) === undefined);
  const relational = h.rules.filter((rule) => rule.measure === r.measure || comparedMeasure(rule.predicate) === r.measure);
  if (own.length === 0) {
    return {
      ok: false,
      refusedBy: [],
      problem: relational.length
        ? `\`rejects ${r.text}\` cannot be checked: every rule about ${r.measure} compares it to another measure,` +
          ` so one reading does not settle the verdict — declare a whole fabricated output instead,` +
          ` as \`rejects output "..."\``
        : `\`rejects ${r.text}\` claims a reading of ${r.measure} is refused, but no rule says anything about ${r.measure}`,
    };
  }

  const values = new Map<string, Measured>([[r.measure, asMeasured(r.value)]]);
  const refusedBy: string[] = [];
  const unjudged: string[] = [];
  for (const rule of own) {
    const j = judge(rule, values);
    if (!j.ok && j.checked) refusedBy.push(j.witness);
    else if (!j.ok) unjudged.push(j.witness);
  }
  if (refusedBy.length > 0) return { ok: true, refusedBy };
  return {
    ok: false,
    refusedBy: [],
    problem: unjudged.length
      ? `\`rejects ${r.text}\` is not a proof: no rule judged that reading — ${unjudged.join("; ")}`
      : `you declared that "${h.name}" rejects ${r.measure} = ${r.value}, and every rule accepts it` +
        ` (${own.map((rule) => `"${rule.measure} ${describePredicate(rule.predicate)}"`).join(", ")})`,
  };
}
