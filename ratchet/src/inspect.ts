import * as path from "path";
import { allRows, findRow, readEvents, stableStringify } from "./corpus";
import { readJournal } from "./journal";
import { inputString } from "./verify";
import type { CorpusEvent, RowState } from "./types";

export interface ListOptions {
  status?: "active" | "archived";
  subject?: string;
}

export function listRows(ratchetDir: string, opts: ListOptions = {}): RowState[] {
  let rows = allRows(path.join(ratchetDir, "corpus.jsonl"));
  if (opts.status) rows = rows.filter((r) => r.status === opts.status);
  if (opts.subject) rows = rows.filter((r) => r.subject === opts.subject);
  return rows.sort((a, b) => (a.capturedAt < b.capturedAt ? -1 : a.capturedAt > b.capturedAt ? 1 : 0));
}

export function formatList(rows: RowState[]): string {
  if (rows.length === 0) return "no rows";
  const idWidth = Math.max(...rows.map((r) => r.id.length));
  const subjWidth = Math.min(24, Math.max(...rows.map((r) => r.subject.length)));
  const lines = rows.map((r) => {
    const mark = r.status === "active" ? "●" : "○";
    const input = inputString(r);
    const shown = input.length > 48 ? input.slice(0, 45) + "..." : input;
    return `${mark} ${r.id.padEnd(idWidth)}  ${r.subject.slice(0, subjWidth).padEnd(subjWidth)}  ${shown}`;
  });
  const active = rows.filter((r) => r.status === "active").length;
  lines.push(`\n${rows.length} rows — ${active} active (●), ${rows.length - active} archived (○)`);
  return lines.join("\n");
}

export interface RowDetail {
  row: RowState;
  events: CorpusEvent[];
  journal: { at: string; actor: string; kind: string; text: string }[];
}

/**
 * Everything known about one row: its current state, every event that
 * produced it, and the journal entries that reference it. This is what the
 * accept ceremony needs in front of a human before they retire something.
 */
export function showRow(ratchetDir: string, id: string): RowDetail {
  const corpusPath = path.join(ratchetDir, "corpus.jsonl");
  const row = findRow(corpusPath, id);
  if (!row) throw new Error(`no row ${id} in corpus`);
  const events = readEvents(corpusPath).filter((e) => e.id === row.id);
  const journal = readJournal(path.join(ratchetDir, "journal.jsonl"))
    .filter((j) => j.corpusId === row.id)
    .map((j) => ({ at: j.at, actor: j.actor, kind: j.kind, text: j.text }));
  return { row, events, journal };
}

export function formatRow(detail: RowDetail): string {
  const { row, events, journal } = detail;
  const lines = [
    `${row.id}  ${row.subject}  [${row.status}]`,
    `  input:     ${stableStringify(row.input)}`,
  ];
  if (row.test) lines.push(`  test:      ${row.test}`);
  lines.push(`  source:    ${row.source}`);
  lines.push(`  captured:  ${row.capturedAt}`);
  if (row.signature) lines.push(`  witness:   ${row.signature}`);

  lines.push("", "history:");
  for (const e of events) {
    const who = e.actor ? ` by ${e.actor}` : "";
    const why = e.reason ? ` — ${e.reason}` : "";
    const at = e.commit ? ` @${e.commit}` : "";
    lines.push(`  ${e.at}  ${e.op}${who}${at}${why}`);
  }
  if (journal.length > 0) {
    lines.push("", "journal:");
    for (const j of journal) lines.push(`  ${j.at}  ${j.kind} by ${j.actor}: ${j.text}`);
  }
  return lines.join("\n");
}
