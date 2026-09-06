import * as fs from "fs";
import * as path from "path";
import { appendEvent, findRow } from "./corpus";
import { appendJournal } from "./journal";

export function accept(cwd: string, id: string, reason: string, actor: string): void {
  const ratchetDir = process.env.RATCHET_HOME ?? path.join(cwd, ".ratchet");
  const corpusPath = path.join(ratchetDir, "corpus.jsonl");
  const row = findRow(corpusPath, id);
  if (!row) {
    throw new Error(`no row ${id} in corpus`);
  }
  if (row.status === "archived") {
    throw new Error(`row ${id} is already archived`);
  }
  appendEvent(corpusPath, {
    op: "accept",
    id,
    at: new Date().toISOString(),
    subject: row.subject,
    input: row.input,
    source: row.source as "fast-check",
  });
  appendJournal(path.join(ratchetDir, "journal.jsonl"), {
    at: new Date().toISOString(),
    kind: "accept",
    actor,
    text: reason,
    corpusId: id,
  });
}

export function reopen(cwd: string, id: string, reason: string, actor: string): void {
  const ratchetDir = process.env.RATCHET_HOME ?? path.join(cwd, ".ratchet");
  const corpusPath = path.join(ratchetDir, "corpus.jsonl");
  const row = findRow(corpusPath, id);
  if (!row) {
    throw new Error(`no row ${id} in corpus`);
  }
  appendEvent(corpusPath, {
    op: "reopen",
    id,
    at: new Date().toISOString(),
    subject: row.subject,
    input: row.input,
    source: row.source as "fast-check",
  });
  appendJournal(path.join(ratchetDir, "journal.jsonl"), {
    at: new Date().toISOString(),
    kind: "decision",
    actor,
    text: reason,
    corpusId: id,
  });
}
