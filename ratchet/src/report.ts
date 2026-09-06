import * as path from "path";
import { readCorpus, foldCorpus, stableStringify } from "./corpus";
import { readJournalFile } from "./journal";

export interface ReportData {
  rows: number;
  active: number;
  archived: number;
  newThisWeek: number;
  bySource: Record<string, number>;
  journalEntries: number;
  accepts: number;
  reopens: number;
  orphans: string[];
  unreadableLines: number;
  latestCaptures: { id: string; subject: string; input: string }[];
}

export function reportData(cwd: string): ReportData {
  const ratchetDir = process.env.RATCHET_HOME ?? path.join(cwd, ".ratchet");
  const corpusPath = path.join(ratchetDir, "corpus.jsonl");
  const { events, problems } = readCorpus(corpusPath);
  const { rows: rowMap, orphans } = foldCorpus(events);
  const rows = [...rowMap.values()];
  const journal = readJournalFile(path.join(ratchetDir, "journal.jsonl"));

  const bySource: Record<string, number> = {};
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let active = 0;
  let archived = 0;
  let newThisWeek = 0;
  for (const r of rows) {
    if (r.status === "active") active++;
    else archived++;
    bySource[r.source] = (bySource[r.source] ?? 0) + 1;
    if (Date.parse(r.capturedAt) >= weekAgo) newThisWeek++;
  }

  return {
    rows: rows.length,
    active,
    archived,
    newThisWeek,
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
  lines.push(`corpus: ${d.rows} rows (${d.active} active, ${d.archived} archived) — +${d.newThisWeek} this week`);
  lines.push(`sources: ${Object.entries(d.bySource).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  lines.push(`journal: ${d.journalEntries} entries`);
  if (d.accepts > 0) lines.push(`retirements: ${d.accepts} accepted via ceremony`);
  if (d.reopens > 0) lines.push(`reopened: ${d.reopens} rows put back into enforcement`);

  // Integrity signals: an accept/reopen with no capture means the corpus is
  // missing history, and an unreadable line means part of it is invisible.
  if (d.orphans.length > 0) {
    lines.push(`[!] ${d.orphans.length} orphaned events (accept/reopen with no capture): ${d.orphans.join(", ")}`);
  }
  if (d.unreadableLines > 0) {
    lines.push(`[!] ${d.unreadableLines} unreadable line(s) — run \`ratchet fsck\``);
  }

  if (d.latestCaptures.length > 0) {
    lines.push("latest captures:");
    for (const c of d.latestCaptures) lines.push(`  ${c.id} ${c.subject} ${c.input}`);
  }
  return lines.join("\n");
}
