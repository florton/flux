/**
 * Which heuristics are still earning their keep.
 *
 * The caught/new split says what *did* fail. Nothing said which subject has
 * stopped producing evidence, and the two silences look identical from the
 * outside: a heuristic that guards a stable invariant and a heuristic that
 * broke six months ago both print a green tick forever.
 *
 * Three signals separate them, and all three are already in the files:
 *
 *   - **rows** — how many counterexamples this subject has ever pinned.
 *   - **staleness** — how long since it last captured or caught anything.
 *   - **n/a share** — a gate that mostly reports "not applicable" is green
 *     while checking almost nothing, which is the quietest possible failure.
 *
 * Humans own the portfolio of heuristics. This is the page that tells them
 * which ones to retire, strengthen, or go and fix.
 */
import * as path from "path";
import { readCorpus, foldCorpus } from "./corpus";
import { readJournalFile } from "./journal";
import { PROOF_LABEL, type ProofTier, type SubjectProof } from "./proof";
import type { RatchetConfig } from "./types";

export interface SubjectYield {
  subject: string;
  /** True when the subject came from heuristics.rules rather than config.json. */
  prose: boolean;
  rows: number;
  activeRows: number;
  /** ISO date of the most recent capture for this subject, if any. */
  lastCapture?: string;
  /** ISO date of the most recent recurrence this subject caught, if any. */
  lastCatch?: string;
  /** Days since the most recent capture or catch; null when there never was one. */
  quietDays: number | null;
  validated: boolean;
  /**
   * *How* it was proven, never merely *that* it was.
   *
   * "validated against history" and "validated against a declared
   * counterexample" are different claims, and a portfolio page that collapsed
   * them would hide exactly the thing a reviewer opens this page to find.
   */
  proof: ProofTier;
  /** True when it enforces with no row behind it. */
  standing: boolean;
}

export interface YieldReport {
  subjects: SubjectYield[];
  /** Subjects with rows or evidence older than the staleness window. */
  stale: SubjectYield[];
  /** Subjects that have never produced a single counterexample. */
  neverFired: SubjectYield[];
  staleAfterDays: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function daysSince(iso: string | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor((now - t) / DAY_MS);
}

export function yieldReport(
  ratchetDir: string,
  config: RatchetConfig,
  validated: Set<string>,
  opts: {
    staleAfterDays?: number;
    now?: number;
    fromRules?: Set<string>;
    /** The two proof tiers. Absent means "only the historical one is known". */
    proofs?: Map<string, SubjectProof>;
  } = {}
): YieldReport {
  const staleAfterDays = opts.staleAfterDays ?? 90;
  const now = opts.now ?? Date.now();
  const { events } = readCorpus(path.join(ratchetDir, "corpus.jsonl"));
  const { rows } = foldCorpus(events);
  const journal = readJournalFile(path.join(ratchetDir, "journal.jsonl"));

  const lastCapture = new Map<string, string>();
  for (const ev of events) {
    if (ev.op !== "capture") continue;
    const prev = lastCapture.get(ev.subject);
    if (!prev || ev.at > prev) lastCapture.set(ev.subject, ev.at);
  }

  // A recurrence names its row, and the row names its subject: that is the
  // subject having caught something the corpus already knew.
  const subjectOfRow = new Map<string, string>();
  for (const r of rows.values()) subjectOfRow.set(r.id, r.subject);
  const lastCatch = new Map<string, string>();
  for (const e of journal.events) {
    if (e.kind !== "recurrence" || !e.corpusId) continue;
    const subject = subjectOfRow.get(e.corpusId);
    if (!subject) continue;
    const prev = lastCatch.get(subject);
    if (!prev || e.at > prev) lastCatch.set(subject, e.at);
  }

  const counts = new Map<string, { total: number; active: number }>();
  for (const r of rows.values()) {
    const c = counts.get(r.subject) ?? { total: 0, active: 0 };
    c.total++;
    if (r.status === "active") c.active++;
    counts.set(r.subject, c);
  }

  const subjects: SubjectYield[] = Object.keys(config.subjects)
    .sort()
    .map((name) => {
      const c = counts.get(name) ?? { total: 0, active: 0 };
      const capture = lastCapture.get(name);
      const caught = lastCatch.get(name);
      const newest = [capture, caught].filter((x): x is string => !!x).sort().pop();
      return {
        subject: name,
        prose: opts.fromRules?.has(name) ?? false,
        rows: c.total,
        activeRows: c.active,
        lastCapture: capture,
        lastCatch: caught,
        quietDays: daysSince(newest, now),
        validated: validated.has(name),
        proof: opts.proofs?.get(name)?.tier ?? (validated.has(name) ? "history" : "none"),
        standing: opts.proofs?.get(name)?.standing ?? false,
      };
    });

  return {
    subjects,
    stale: subjects.filter((s) => s.quietDays !== null && s.quietDays > staleAfterDays),
    neverFired: subjects.filter((s) => s.quietDays === null),
    staleAfterDays,
  };
}

export function formatYield(r: YieldReport): string {
  if (r.subjects.length === 0) return "no subjects configured";
  const width = Math.max(...r.subjects.map((s) => s.subject.length));
  const lines: string[] = [];
  for (const s of r.subjects) {
    const age =
      s.quietDays === null
        ? "no evidence yet"
        : s.quietDays === 0
          ? "evidence today"
          : `last evidence ${s.quietDays}d ago`;
    const flags = [
      s.prose ? "prose" : "script",
      PROOF_LABEL[s.proof],
      s.standing && s.rows === 0 ? "standing" : null,
    ].filter((f): f is string => f !== null);
    lines.push(
      `  ${s.subject.padEnd(width)}  ${String(s.rows).padStart(3)} row${s.rows === 1 ? " " : "s"}` +
        ` (${s.activeRows} active)  ${age.padEnd(22)} [${flags.join(", ")}]`
    );
  }
  const neverFiredUnproven = r.neverFired.filter((s) => s.proof === "none");
  if (r.neverFired.length > 0) {
    lines.push(
      `\n${r.neverFired.length} subject(s) have never produced a counterexample: ${r.neverFired.map((s) => s.subject).join(", ")}` +
        (neverFiredUnproven.length === 0
          ? `\n  All of them declare a counterexample their rules refuse, so each is a proven standing invariant rather than an unproven one.`
          : `\n  ${neverFiredUnproven.length} of those have no proof at all (${neverFiredUnproven.map((s) => s.subject).join(", ")}):` +
            ` a check that has never fired and cannot say what it would refuse is indistinguishable from one that cannot fail.`)
    );
  }
  if (r.stale.length > 0) {
    lines.push(
      `\n${r.stale.length} subject(s) quiet for over ${r.staleAfterDays} days: ${r.stale.map((s) => `${s.subject} (${s.quietDays}d)`).join(", ")}`
    );
  }
  return lines.join("\n");
}
