import * as fs from "fs";
import * as path from "path";
import { appendEvent, findRow } from "./corpus";
import { ruleHash } from "./rule";
import type { RatchetConfig } from "./types";
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

/**
 * Re-pin a row to the current rule without changing its status.
 *
 * When a check script is edited, every row it owns is quarantined: the
 * instrument moved, so a failure no longer cleanly means "the code
 * regressed". Reaffirming says, on the record and with a reason, that the
 * expectation still stands under the new instrument. It is the counterpart
 * to `accept`, which says the expectation itself is retired.
 */
export function reaffirm(cwd: string, id: string, reason: string, actor: string): string {
  const { corpusPath, journalPath } = corpusFile(cwd);
  const ratchetDir = process.env.RATCHET_HOME ?? path.join(cwd, ".ratchet");
  const row = findRow(corpusPath, id);
  if (!row) throw new Error(`no row ${id} in corpus`);

  const config = JSON.parse(fs.readFileSync(path.join(ratchetDir, "config.json"), "utf8")) as RatchetConfig;
  const subj = config.subjects[row.subject];
  if (!subj) throw new Error(`no subject config for "${row.subject}"`);
  const current = ruleHash(row.subject, subj, cwd);
  if (row.ruleHash === current) {
    throw new Error(`row ${row.id} is already pinned to the current rule (${current})`);
  }

  const at = new Date().toISOString();
  appendEvent(corpusPath, {
    op: "reaffirm",
    id: row.id,
    at,
    subject: row.subject,
    input: row.input,
    test: row.test,
    reason,
    actor,
    ruleHash: current,
    source: row.source as CorpusEvent["source"],
  });
  appendJournal(journalPath, {
    at,
    kind: "decision",
    actor,
    text: `reaffirmed under edited rule ${row.ruleHash ?? "(none)"} -> ${current}: ${reason}`,
    corpusId: row.id,
  });
  return row.id;
}
