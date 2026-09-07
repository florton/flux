import * as path from "path";
import { readCorpus, foldCorpus, stableStringify } from "./corpus";
import { readJournalFile } from "./journal";
import { loadSubjects } from "./paths";
import { validatedSubjects } from "./validate";
import { yieldReport } from "./yield";

function ratchetHome(cwd: string): string {
  return process.env.RATCHET_HOME ?? path.join(cwd, ".ratchet");
}

export interface ReportData {
  rows: number;
  active: number;
  archived: number;
  /** Novel counterexamples captured in the last 7 days (first capture of an id). */
  newThisWeek: number;
  /** Recurrence journal entries in the last 7 days — regressions the corpus already knew. */
  caughtThisWeek: number;
  /** caught / (caught + new) over the last 7 days, or null with no observations. */
  catchRateThisWeek: number | null;
  novelAllTime: number;
  caughtAllTime: number;
  catchRateAllTime: number | null;
  bySource: Record<string, number>;
  journalEntries: number;
  accepts: number;
  reopens: number;
  orphans: string[];
  unreadableLines: number;
  latestCaptures: { id: string; subject: string; input: string }[];
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function inWindow(at: string, weekAgo: number): boolean {
  const t = Date.parse(at);
  return !Number.isNaN(t) && t >= weekAgo;
}

function rate(caught: number, novel: number): number | null {
  return caught + novel === 0 ? null : Math.round((caught / (caught + novel)) * 100);
}

export function reportData(cwd: string): ReportData {
  const ratchetDir = process.env.RATCHET_HOME ?? path.join(cwd, ".ratchet");
  const corpusPath = path.join(ratchetDir, "corpus.jsonl");
  const { events, problems } = readCorpus(corpusPath);
  const { rows: rowMap, orphans } = foldCorpus(events);
  const rows = [...rowMap.values()];
  const journal = readJournalFile(path.join(ratchetDir, "journal.jsonl"));
  const weekAgo = Date.now() - WEEK_MS;

  const bySource: Record<string, number> = {};
  let active = 0;
  let archived = 0;
  for (const r of rows) {
    if (r.status === "active") active++;
    else archived++;
    bySource[r.source] = (bySource[r.source] ?? 0) + 1;
  }

  // A novel counterexample is the *first* capture of an id, in timestamp
  // order (the same order the fold replays): a re-record of an existing row
  // is a ceremony, not a new discovery.
  const parsed = events.map((ev) => Date.parse(ev.at));
  const allParseable = parsed.every((t) => !Number.isNaN(t));
  const order = events.map((_, i) => i);
  if (allParseable) order.sort((a, b) => parsed[a] - parsed[b] || a - b);
  const firstSeen = new Set<string>();
  let novelAllTime = 0;
  let newThisWeek = 0;
  for (const i of order) {
    const ev = events[i];
    if (ev.op !== "capture" || firstSeen.has(ev.id)) continue;
    firstSeen.add(ev.id);
    novelAllTime++;
    if (inWindow(ev.at, weekAgo)) newThisWeek++;
  }

  // Caught = the corpus remembering past itself: a counterexample that came
  // back after its row was retired (journaled at capture, see capture.ts).
  const recurrences = journal.events.filter((e) => e.kind === "recurrence");
  const caughtAllTime = recurrences.length;
  const caughtThisWeek = recurrences.filter((e) => inWindow(e.at, weekAgo)).length;

  return {
    rows: rows.length,
    active,
    archived,
    newThisWeek,
    caughtThisWeek,
    catchRateThisWeek: rate(caughtThisWeek, newThisWeek),
    novelAllTime,
    caughtAllTime,
    catchRateAllTime: rate(caughtAllTime, novelAllTime),
    bySource,
    journalEntries: journal.events.length,
    accepts: events.filter((e) => e.op === "accept").length,
    reopens: events.filter((e) => e.op === "reopen").length,
    orphans: orphans.map((o) => o.id),
    unreadableLines: problems.length + journal.problems.length,
    latestCaptures: events
      .filter((e) => e.op === "capture")
      .slice(-5)
      .reverse()
      .map((e) => ({ id: e.id, subject: e.subject, input: stableStringify(e.input) })),
  };
}

export function report(cwd: string): string {
  const d = reportData(cwd);
  const lines: string[] = [];
  lines.push(`corpus: ${d.rows} rows (${d.active} active, ${d.archived} archived) — +${d.newThisWeek} new this week`);
  lines.push(`sources: ${Object.entries(d.bySource).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  lines.push(`journal: ${d.journalEntries} entries`);
  if (d.accepts > 0) lines.push(`retirements: ${d.accepts} accepted via ceremony`);
  if (d.reopens > 0) lines.push(`reopened: ${d.reopens} rows put back into enforcement`);

  // The number that ends the argument: of the failure signals that reached
  // capture, how many were regressions the corpus already knew (memory
  // working) vs. genuinely novel bugs (churn).
  const observations = d.caughtThisWeek + d.newThisWeek;
  if (observations === 0) {
    lines.push("failure signals this week: none recorded — point `ratchet capture` at red CI runs to feed the rate");
  } else {
    lines.push(`failure signals this week: ${observations}`);
    lines.push(
      `  caught by corpus: ${d.caughtThisWeek}  (${d.catchRateThisWeek}%) — known regressions, the ratchet worked`
    );
    lines.push(`  new counterexamples: ${d.newThisWeek} — novel bugs`);
  }
  if (d.novelAllTime + d.caughtAllTime > 0) {
    lines.push(
      `all-time: ${d.caughtAllTime} caught, ${d.novelAllTime} new (${d.catchRateAllTime}%)`
    );
  }

  // Integrity signals: an accept/reopen with no capture means the corpus is
  // missing history, and an unreadable line means part of it is invisible.
  if (d.orphans.length > 0) {
    lines.push(`[!] ${d.orphans.length} orphaned events (accept/reopen with no capture): ${d.orphans.join(", ")}`);
  }
  if (d.unreadableLines > 0) {
    lines.push(`[!] ${d.unreadableLines} unreadable line(s) — run \`ratchet fsck\``);
  }

  // Which heuristics have stopped producing evidence. A subject that has
  // never fired and one that guards a stable invariant look identical from
  // the outside; the portfolio is the human's to manage, so say which is which.
  try {
    const config = loadSubjects(ratchetHome(cwd));
    const y = yieldReport(ratchetHome(cwd), config, validatedSubjects(cwd, ratchetHome(cwd), config), {
      fromRules: config.fromRules,
    });
    const unvalidated = y.subjects.filter((s) => !s.validated);
    if (y.stale.length > 0) {
      lines.push(
        `quiet over ${y.staleAfterDays}d: ${y.stale.map((s) => `${s.subject} (${s.quietDays}d)`).join(", ")}`
      );
    }
    if (unvalidated.length > 0) {
      lines.push(
        `[!] ${unvalidated.length} subject(s) with no validation proof for their current rule: ${unvalidated.map((s) => s.subject).join(", ")}`
      );
    }
  } catch {
    // A config the report cannot read is `fsck`'s business to complain about,
    // not a reason for the churn numbers above to go missing.
  }

  if (d.latestCaptures.length > 0) {
    lines.push("latest captures:");
    for (const c of d.latestCaptures) lines.push(`  ${c.id} ${c.subject} ${c.input}`);
  }
  return lines.join("\n");
}
