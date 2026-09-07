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
import type { Extractor, Heuristic, Predicate, Rule } from "./heuristics";

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

function firstNumberAfter(text: string, label: string): number | undefined {
  const idx = text.toLowerCase().indexOf(label.toLowerCase());
  if (idx === -1) return undefined;
  const after = text.slice(idx + label.length);
  // The first numeric literal following the label, exponents and signs
  // included. Anchored to the label rather than pattern-matched over the
  // whole line: a label that appears mid-line still reads left to right.
  const m = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(after);
  if (!m) return undefined;
  const n = Number(m[0]);
  return Number.isNaN(n) ? undefined : n;
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
      const n = firstNumberAfter(obs.stdout, e.label);
      if (n === undefined) {
        const seen = obs.stdout.trim();
        const preview = seen === ""
          ? "the command printed nothing on stdout"
          : `the command printed: ${seen.split(/\r?\n/).slice(0, 3).map((l) => JSON.stringify(l.slice(0, 100))).join(", ")}`;
        return {
          name,
          value: null,
          error:
            (obs.stdout.toLowerCase().includes(e.label.toLowerCase())
              ? `found "${e.label}" in the output but no number after it`
              : `no "${e.label}" in the output`) + ` — ${preview}`,
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
  }
}

export interface Judgement {
  ok: boolean;
  /** The measured value stated in the rule's own terms. */
  witness: string;
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
    return { ok: false, witness: `${rule.measure} could not be measured, so "${rule.measure} ${describePredicate(p)}" cannot be checked` };
  }

  const needNumber = (n: number | undefined, check: (x: number) => boolean): Judgement => {
    if (n === undefined) {
      return { ok: false, witness: `${rule.measure} measured ${shown}, which is not a number, so "${describePredicate(p)}" cannot be checked` };
    }
    return { ok: check(n), witness: stated };
  };
  const text = value === null ? "" : String(value);

  switch (p.kind) {
    case "is": {
      const equal = text === p.value || asNumber(value) === asNumber(p.value) && asNumber(value) !== undefined;
      return { ok: p.negated ? !equal : equal, witness: stated };
    }
    case "one-of":
      return { ok: p.values.some((v) => v === text || (asNumber(v) !== undefined && asNumber(v) === asNumber(value))), witness: stated };
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
      return { ok: p.negated ? !has : has, witness: stated };
    }
    case "starts-with": return { ok: text.startsWith(p.value), witness: stated };
    case "ends-with": return { ok: text.endsWith(p.value), witness: stated };
    case "empty": {
      const empty = value === null || text.trim() === "" || value === 0;
      return { ok: p.negated ? !empty : empty, witness: stated };
    }
    case "is-a-number": return { ok: asNumber(value) !== undefined, witness: stated };
    case "same-as": {
      const other = values.get(p.measure) ?? null;
      const same = String(other) === text;
      return {
        ok: same,
        witness: `${rule.measure} measured ${shown} and ${p.measure} measured ${other === null ? "nothing" : String(other)}`,
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

  const failures: string[] = [];

  // A measure the instrument stopped producing is reported once, not once
  // per rule that mentions it: three rules over one missing number is one
  // broken instrument, and saying it three times buries the fact.
  const unreadable = new Set<string>();
  for (const e of extractions) {
    if (e.value !== null || e.error === undefined) continue;
    if (!h.rules.some((r) => r.measure === e.name && r.predicate.kind !== "empty")) continue;
    unreadable.add(e.name);
    failures.push(`${e.name} could not be measured: ${e.error}`);
  }

  for (const rule of h.rules) {
    if (unreadable.has(rule.measure)) continue;
    const j = judge(rule, values);
    if (!j.ok) failures.push(j.witness);
  }

  return { failure: failures.length === 0 ? null : failures.join("; "), extractions, readings };
}
