import * as fs from "fs";
import * as path from "path";
import type { CorpusEvent, RowState } from "./types";

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`
  );
  return `{${parts.join(",")}}`;
}

export function readEvents(corpusPath: string): CorpusEvent[] {
  if (!fs.existsSync(corpusPath)) return [];
  const text = fs.readFileSync(corpusPath, "utf8");
  const events: CorpusEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    events.push(JSON.parse(line) as CorpusEvent);
  }
  return events;
}

export function appendEvent(corpusPath: string, event: CorpusEvent): void {
  fs.mkdirSync(path.dirname(corpusPath), { recursive: true });
  fs.appendFileSync(corpusPath, JSON.stringify(event) + "\n", "utf8");
}

export function foldRows(events: CorpusEvent[]): Map<string, RowState> {
  const rows = new Map<string, RowState>();
  for (const ev of events) {
    const prev = rows.get(ev.id);
    if (ev.op === "capture") {
      rows.set(ev.id, {
        id: ev.id,
        subject: ev.subject,
        input: ev.input,
        status: "active",
        test: ev.test,
        source: ev.source,
        capturedAt: ev.at,
        lastOp: ev.op,
        lastAt: ev.at,
      });
    } else if (ev.op === "accept") {
      if (prev) {
        rows.set(ev.id, { ...prev, status: "archived", lastOp: ev.op, lastAt: ev.at });
      }
    } else if (ev.op === "reopen") {
      if (prev) {
        rows.set(ev.id, { ...prev, status: "active", lastOp: ev.op, lastAt: ev.at });
      }
    }
  }
  return rows;
}

export function activeRows(corpusPath: string): RowState[] {
  return [...foldRows(readEvents(corpusPath)).values()].filter((r) => r.status === "active");
}

export function findRow(corpusPath: string, id: string): RowState | null {
  return foldRows(readEvents(corpusPath)).get(id) ?? null;
}
