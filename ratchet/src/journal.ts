import * as fs from "fs";
import * as path from "path";
import type { JournalEvent } from "./types";

export function appendJournal(journalPath: string, event: JournalEvent): void {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  fs.appendFileSync(journalPath, JSON.stringify(event) + "\n", "utf8");
}

export function readJournal(journalPath: string): JournalEvent[] {
  if (!fs.existsSync(journalPath)) return [];
  const events: JournalEvent[] = [];
  for (const line of fs.readFileSync(journalPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    events.push(JSON.parse(line) as JournalEvent);
  }
  return events;
}
