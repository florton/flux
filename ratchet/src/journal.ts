import * as fs from "fs";
import * as path from "path";
import type { JournalEvent, LineProblem } from "./types";

export function appendJournal(journalPath: string, event: JournalEvent): void {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  fs.appendFileSync(journalPath, JSON.stringify(event) + "\n", "utf8");
}

export interface JournalRead {
  events: JournalEvent[];
  problems: LineProblem[];
}

/** Lenient read: malformed lines are collected, not thrown. See readCorpus. */
export function readJournalFile(journalPath: string): JournalRead {
  if (!fs.existsSync(journalPath)) return { events: [], problems: [] };
  const events: JournalEvent[] = [];
  const problems: LineProblem[] = [];
  const lines = fs.readFileSync(journalPath, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as JournalEvent);
    } catch (err) {
      problems.push({
        line: i + 1,
        text: line.slice(0, 120),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { events, problems };
}

export function readJournal(journalPath: string): JournalEvent[] {
  return readJournalFile(journalPath).events;
}
