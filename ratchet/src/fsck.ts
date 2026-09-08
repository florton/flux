import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { foldCorpus, isLegacyId, readCorpus, rowId, stableStringify } from "./corpus";
import { readJournalFile } from "./journal";
import { loadSubjects } from "./paths";
import { instrumentsInsideTree } from "./instrument";
import type { CorpusEvent, LineProblem, RatchetConfig } from "./types";

export interface FsckFinding {
  kind:
    | "corpus-unreadable-line"
    | "subjects-unreadable"
    | "journal-unreadable-line"
    | "orphan-event"
    | "id-mismatch"
    | "legacy-id"
    | "unconfigured-subject"
    | "instrument-inside-tree"
    | "visual-baseline-missing"
    | "visual-baseline-hash-mismatch";
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
export function fsck(ratchetDir: string, projectRoot?: string): FsckReport {
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

  // Subjects come from config.json and heuristics.rules together, and a
  // rules file that will not parse is itself an integrity failure: every
  // heuristic in it has silently stopped enforcing.
  if (fs.existsSync(configPath) || fs.existsSync(path.join(ratchetDir, "heuristics.rules"))) {
    try {
      const config = loadSubjects(ratchetDir);
      const seen = new Set<string>();
      for (const r of rows.values()) {
        if (config.subjects[r.subject] || seen.has(r.subject)) continue;
        seen.add(r.subject);
        push(
          "unconfigured-subject",
          "warning",
          `rows exist for subject "${r.subject}" but nothing defines it — add it to config.json, or as a 'heuristic' block in heuristics.rules`
        );
      }
      for (const name of config.collisions) {
        push(
          "unconfigured-subject",
          "warning",
          `"${name}" is declared both in config.json and in heuristics.rules — config.json wins; delete one`
        );
      }

      // A check whose instrument lives inside the tree it measures is correct
      // at HEAD and wrong across history — the quietest of the three shapes of
      // "green over nothing", because at HEAD it looks like everything works.
      const root = projectRoot ?? path.dirname(ratchetDir);
      for (const f of instrumentsInsideTree(root, config)) {
        push("instrument-inside-tree", "warning", `${f.detail}. Fix: ${f.fix}`);
      }
    } catch (err) {
      // Not the corpus: this is config.json or heuristics.rules failing to
      // load. Naming the corpus here sends a reader to the one file that is
      // fine, which is how a finding costs more time than it saves.
      push("subjects-unreadable", "error", err instanceof Error ? err.message : String(err));
    }
  }

  // Visual pins carry a second integrity surface: the baseline PNG next to
  // the JSONL. A row whose baseline file went missing (or was edited) is
  // enforcing against pixels it no longer describes — the check would fail
  // on a restored file and pass on a stray one. `fsck` makes that visible as
  // corruption rather than as a mysterious red/green elsewhere.
  const visualCheck = checkVisualBaselines(ratchetDir, events, rows);
  for (const f of visualCheck) findings.push(f);

  return {
    findings,
    rows: rows.size,
    events: events.length,
    ok: !findings.some((f) => f.severity === "error"),
  };
}

/** Validate that each visual row's baseline file is present and hash-true. */
function checkVisualBaselines(
  ratchetDir: string,
  events: CorpusEvent[],
  rows: Map<string, { id: string }>
): FsckFinding[] {
  const findings: FsckFinding[] = [];
  const latest = new Map<string, { sha256?: string; png: string; at: number }>();
  for (const ev of events) {
    if (ev.op !== "capture" || ev.source !== "visual" || !ev.expected) continue;
    const meta = ev.expected as { sha256?: string; png?: string };
    if (typeof meta.png !== "string") continue;
    const at = Date.parse(ev.at);
    const prev = latest.get(ev.id);
    // Unparseable timestamps compare as "keep the existing", i.e. file order.
    if (!prev || (!Number.isNaN(at) && (Number.isNaN(prev.at) || at >= prev.at))) {
      latest.set(ev.id, { sha256: meta.sha256, png: meta.png, at });
    }
  }
  const push = (kind: FsckFinding["kind"], severity: FsckFinding["severity"], detail: string) =>
    findings.push({ kind, severity, detail });
  for (const row of rows.values()) {
    const meta = latest.get(row.id);
    if (!meta) continue;
    const rel = path.join(ratchetDir, "visual", meta.png);
    if (!fs.existsSync(rel)) {
      push("visual-baseline-missing", "error", `${row.id} baseline file is gone (${meta.png}) — restore it from git or re-record`);
      continue;
    }
    if (meta.sha256) {
      const actual = createHash("sha256").update(fs.readFileSync(rel)).digest("hex");
      if (actual !== meta.sha256) {
        push(
          "visual-baseline-hash-mismatch",
          "error",
          `${row.id} baseline ${meta.png} does not hash to the recorded ${meta.sha256.slice(0, 12)}… (is ${actual.slice(0, 12)}…) — the pin no longer identifies what it claims`
        );
      }
    }
  }
  return findings;
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
