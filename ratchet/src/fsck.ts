import * as fs from "fs";
import * as path from "path";
import { foldCorpus, isLegacyId, readCorpus, rowId, stableStringify } from "./corpus";
import { readJournalFile } from "./journal";
import type { LineProblem, RatchetConfig } from "./types";

export interface FsckFinding {
  kind:
    | "corpus-unreadable-line"
    | "journal-unreadable-line"
    | "orphan-event"
    | "id-mismatch"
    | "legacy-id"
    | "unconfigured-subject";
  severity: "error" | "warning" | "info";
  detail: string;
}

export interface FsckReport {
  findings: FsckFinding[];
  rows: number;
  events: number;
  ok: boolean;
}

/**
 * Integrity check for the corpus and journal.
 *
 * Content-addressed ids make most of this possible: a row whose id does not
 * match `sha256(subject + input)` was hand-edited or corrupted, and that is
 * mechanically detectable. Rows carrying pre-0.2 sequential ids cannot be
 * verified that way and are reported as info, because they also will not
 * dedup against new captures of the same counterexample.
 */
export function fsck(ratchetDir: string): FsckReport {
  const findings: FsckFinding[] = [];
  const corpusPath = path.join(ratchetDir, "corpus.jsonl");
  const journalPath = path.join(ratchetDir, "journal.jsonl");
  const configPath = path.join(ratchetDir, "config.json");

  const push = (kind: FsckFinding["kind"], severity: FsckFinding["severity"], detail: string) =>
    findings.push({ kind, severity, detail });

  const line = (p: LineProblem) => `line ${p.line}: ${p.error} — ${p.text}`;

  const { events, problems } = readCorpus(corpusPath);
  for (const p of problems) push("corpus-unreadable-line", "error", line(p));

  const journal = readJournalFile(journalPath);
  for (const p of journal.problems) push("journal-unreadable-line", "error", line(p));

  const { rows, orphans } = foldCorpus(events);
  for (const o of orphans) {
    push("orphan-event", "error", `${o.op} for ${o.id} has no capture — history is missing`);
  }

  for (const r of rows.values()) {
    if (isLegacyId(r.id)) {
      push(
        "legacy-id",
        "info",
        `${r.id} uses the pre-0.2 sequential id format; a new capture of ${stableStringify(r.input)} will not dedup against it`
      );
      continue;
    }
    const expected = rowId(r.subject, r.input, r.test);
    if (expected !== r.id) {
      push("id-mismatch", "error", `${r.id} does not match its content (expected ${expected}) — hand-edited or corrupt`);
    }
  }

  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as RatchetConfig;
      const seen = new Set<string>();
      for (const r of rows.values()) {
        if (config.subjects[r.subject] || seen.has(r.subject)) continue;
        seen.add(r.subject);
        push("unconfigured-subject", "warning", `rows exist for subject "${r.subject}" but it has no check in config.json`);
      }
    } catch (err) {
      push("corpus-unreadable-line", "error", `config.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    findings,
    rows: rows.size,
    events: events.length,
    ok: !findings.some((f) => f.severity === "error"),
  };
}

export function formatFsck(report: FsckReport): string {
  const lines = [`corpus: ${report.events} events, ${report.rows} rows`];
  if (report.findings.length === 0) {
    lines.push("no problems found");
    return lines.join("\n");
  }
  const mark = { error: "[!]", warning: "[?]", info: "[i]" };
  for (const f of report.findings) lines.push(`${mark[f.severity]} ${f.kind}: ${f.detail}`);
  const errors = report.findings.filter((f) => f.severity === "error").length;
  lines.push(errors > 0 ? `\n${errors} error(s) — the corpus cannot be trusted until these are resolved` : "\nno errors");
  return lines.join("\n");
}
