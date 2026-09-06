import * as path from "path";
import { appendEvent, findRow } from "./corpus";
import { appendJournal } from "./journal";
import type { CorpusEvent } from "./types";

function corpusFile(cwd: string): { corpusPath: string; journalPath: string } {
  const ratchetDir = process.env.RATCHET_HOME ?? path.join(cwd, ".ratchet");
  return {
    corpusPath: path.join(ratchetDir, "corpus.jsonl"),
    journalPath: path.join(ratchetDir, "journal.jsonl"),
  };
}

/**
 * Retire a row. The reason and actor are written to the corpus as well as
 * the journal, so a later recurrence of the same counterexample can say who
 * accepted it and why without a second file lookup.
 */
export function accept(cwd: string, id: string, reason: string, actor: string): string {
  const { corpusPath, journalPath } = corpusFile(cwd);
  const row = findRow(corpusPath, id);
  if (!row) throw new Error(`no row ${id} in corpus`);
  if (row.status === "archived") throw new Error(`row ${row.id} is already archived`);

  const at = new Date().toISOString();
  appendEvent(corpusPath, {
    op: "accept",
    id: row.id,
    at,
    subject: row.subject,
    input: row.input,
    test: row.test,
    reason,
    actor,
    source: row.source as CorpusEvent["source"],
  });
  appendJournal(journalPath, { at, kind: "accept", actor, text: reason, corpusId: row.id });
  return row.id;
}

export function reopen(cwd: string, id: string, reason: string, actor: string): string {
  const { corpusPath, journalPath } = corpusFile(cwd);
  const row = findRow(corpusPath, id);
  if (!row) throw new Error(`no row ${id} in corpus`);
  if (row.status === "active") throw new Error(`row ${row.id} is already active`);

  const at = new Date().toISOString();
  appendEvent(corpusPath, {
    op: "reopen",
    id: row.id,
    at,
    subject: row.subject,
    input: row.input,
    test: row.test,
    reason,
    actor,
    source: row.source as CorpusEvent["source"],
  });
  appendJournal(journalPath, { at, kind: "decision", actor, text: reason, corpusId: row.id });
  return row.id;
}
