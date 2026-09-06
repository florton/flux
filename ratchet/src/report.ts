import * as fs from "fs";
import * as path from "path";
import { readEvents, foldRows, stableStringify } from "./corpus";
import { readJournal } from "./journal";

export function report(cwd: string): string {
  const ratchetDir = process.env.RATCHET_HOME ?? path.join(cwd, ".ratchet");
  const corpusPath = path.join(ratchetDir, "corpus.jsonl");
  const events = readEvents(corpusPath);
  const rows = [...foldRows(events).values()];
  const journal = readJournal(path.join(ratchetDir, "journal.jsonl"));

  const byStatus: Record<string, number> = { active: 0, archived: 0 };
  const bySource: Record<string, number> = {};
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let newThisWeek = 0;
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    bySource[r.source] = (bySource[r.source] ?? 0) + 1;
    if (Date.parse(r.capturedAt) >= weekAgo) newThisWeek++;
  }

  const lines: string[] = [];
  lines.push(`corpus: ${rows.length} rows (${byStatus.active ?? 0} active, ${byStatus.archived ?? 0} archived) — +${newThisWeek} this week`);
  lines.push(`sources: ${Object.entries(bySource).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  lines.push(`journal: ${journal.length} entries`);
  const accepts = events.filter((e) => e.op === "accept").length;
  if (accepts > 0) lines.push(`retirements: ${accepts} accepted via ceremony`);

  const recent = events.filter((e) => e.op === "capture").slice(-5);
  if (recent.length > 0) {
    lines.push("latest captures:");
    for (const ev of recent.reverse()) {
      lines.push(`  ${ev.id} ${ev.subject} ${stableStringify(ev.input)}`);
    }
  }
  return lines.join("\n");
}
