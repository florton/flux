import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import type { CorpusEvent, CorpusFold, LineProblem, RowState } from "./types";

/**
 * Canonical, order-independent rendering of a value.
 *
 * Values outside the JSON domain get an explicit sentinel rather than the
 * silent nonsense `JSON.stringify` produces for them (`undefined` for
 * undefined, `"null"` for NaN — which collided with a real null, `"{}"` for
 * every Date). Nothing currently feeds such a value in, because inputs
 * arrive via JSON.parse; the sentinels are here so that the day something
 * does, it cannot alias a different row's dedup key.
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "<undefined>";
  if (typeof value === "function") return "<function>";
  if (typeof value === "bigint") return `<bigint:${value}>`;
  if (typeof value === "symbol") return `<symbol:${String(value)}>`;
  if (typeof value === "number" && !Number.isFinite(value)) return `<${String(value)}>`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value instanceof Date) return `<date:${value.toISOString()}>`;
  if (value instanceof Set) return `<set:${stableStringify([...value])}>`;
  if (value instanceof Map) {
    const entries = [...value.entries()].map(([k, v]) => [stableStringify(k), stableStringify(v)] as const);
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return `<map:{${entries.map(([k, v]) => `${k}:${v}`).join(",")}}>`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`
  );
  return `{${parts.join(",")}}`;
}

/**
 * The canonical identity of a corpus row. A row is its (subject, input) pair
 * — or (subject, test) for test-name rows, which carry no input.
 */
export function rowKey(subject: string, input: unknown, test?: string): string {
  return input === null && test
    ? `${subject} test ${test}`
    : `${subject} input ${stableStringify(input)}`;
}

/**
 * Content-addressed row id.
 *
 * Sequential ids were allocated from local file state, so two branches both
 * minted `c0001` and the fold — keyed by id — silently dropped one of them
 * on merge. Deriving the id from the content makes id allocation and dedup
 * the same operation: the same counterexample gets the same id on every
 * machine, and two branches that find it independently converge instead of
 * colliding.
 */
export function rowId(subject: string, input: unknown, test?: string): string {
  return "c" + createHash("sha256").update(rowKey(subject, input, test)).digest("hex").slice(0, 12);
}

/** Ids minted by the pre-0.2 sequential allocator, which cannot be verified. */
export function isLegacyId(id: string): boolean {
  return /^c\d{1,4}$/.test(id);
}

export interface CorpusRead {
  events: CorpusEvent[];
  problems: LineProblem[];
}

/**
 * Read the corpus, keeping malformed lines instead of dying on them.
 *
 * A single truncated write or a merge-conflict marker used to make every
 * command exit with a raw SyntaxError and no way back. Callers that enforce
 * (verify) must still refuse to certify a corpus they cannot fully read —
 * a row hidden behind a parse error is a false pass — but they can now say
 * which line is broken, and `ratchet fsck` can report the whole set.
 */
export function readCorpus(corpusPath: string): CorpusRead {
  if (!fs.existsSync(corpusPath)) return { events: [], problems: [] };
  const text = fs.readFileSync(corpusPath, "utf8");
  const events: CorpusEvent[] = [];
  const problems: LineProblem[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as CorpusEvent;
      if (!parsed || typeof parsed !== "object" || !parsed.id || !parsed.op) {
        problems.push({ line: i + 1, text: line.slice(0, 120), error: "not a corpus event (missing id or op)" });
        continue;
      }
      events.push(parsed);
    } catch (err) {
      problems.push({
        line: i + 1,
        text: line.slice(0, 120),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { events, problems };
}

export function readEvents(corpusPath: string): CorpusEvent[] {
  return readCorpus(corpusPath).events;
}

export function appendEvent(corpusPath: string, event: CorpusEvent): void {
  fs.mkdirSync(path.dirname(corpusPath), { recursive: true });
  fs.appendFileSync(corpusPath, JSON.stringify(event) + "\n", "utf8");
}

/**
 * Fold events into row states.
 *
 * Events are replayed in timestamp order, not file order: a git merge can
 * interleave two branches' appends so that an `accept` lands above the
 * `capture` it retires, and a file-order fold drops it silently. When any
 * event carries an unparseable `at`, file order is used unchanged — that
 * keeps hand-written corpora predictable rather than reordering them by a
 * timestamp we could not read.
 *
 * accept/reopen events with no preceding capture are collected as orphans
 * instead of being discarded; an orphan means the corpus is missing history,
 * which is worth reporting rather than ignoring.
 */
export function foldCorpus(events: CorpusEvent[]): CorpusFold {
  const parsed = events.map((ev) => Date.parse(ev.at));
  const allParseable = parsed.every((t) => !Number.isNaN(t));
  const order = events.map((_, i) => i);
  if (allParseable) order.sort((a, b) => parsed[a] - parsed[b] || a - b);

  const rows = new Map<string, RowState>();
  const orphans: CorpusEvent[] = [];

  for (const i of order) {
    const ev = events[i];
    const prev = rows.get(ev.id);
    if (ev.op === "capture") {
      rows.set(ev.id, {
        id: ev.id,
        subject: ev.subject,
        input: ev.input,
        status: "active",
        test: ev.test,
        signature: ev.signature,
        ruleHash: ev.ruleHash,
        source: ev.source,
        capturedAt: prev?.capturedAt ?? ev.at,
        lastOp: ev.op,
        lastAt: ev.at,
        lastReason: ev.reason,
        lastActor: ev.actor,
      });
    } else if (ev.op === "accept" || ev.op === "reopen" || ev.op === "reaffirm") {
      if (!prev) {
        orphans.push(ev);
        continue;
      }
      rows.set(ev.id, {
        ...prev,
        // reaffirm re-pins the row to the current rule and leaves its status
        // alone; it is the operation that lifts a quarantine without
        // pretending the expectation itself changed.
        status: ev.op === "accept" ? "archived" : ev.op === "reopen" ? "active" : prev.status,
        ruleHash: ev.op === "reaffirm" ? ev.ruleHash ?? prev.ruleHash : prev.ruleHash,
        lastOp: ev.op,
        lastAt: ev.at,
        lastReason: ev.reason,
        lastActor: ev.actor,
      });
    }
  }
  return { rows, orphans };
}

export function foldRows(events: CorpusEvent[]): Map<string, RowState> {
  return foldCorpus(events).rows;
}

export function allRows(corpusPath: string): RowState[] {
  return [...foldRows(readEvents(corpusPath)).values()];
}

export function activeRows(corpusPath: string): RowState[] {
  return allRows(corpusPath).filter((r) => r.status === "active");
}

/**
 * Look a row up by full id or by unambiguous prefix. Content-addressed ids
 * are long; the ceremony still has to be typeable.
 */
export function findRow(corpusPath: string, id: string): RowState | null {
  const rows = foldRows(readEvents(corpusPath));
  const exact = rows.get(id);
  if (exact) return exact;
  const matches = [...rows.values()].filter((r) => r.id.startsWith(id));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`id "${id}" is ambiguous — matches ${matches.map((m) => m.id).join(", ")}`);
  }
  return null;
}

/** Rows whose id does not match their own content — hand-edited or corrupt. */
export function mismatchedIds(rows: RowState[]): RowState[] {
  return rows.filter((r) => !isLegacyId(r.id) && rowId(r.subject, r.input, r.test) !== r.id);
}
