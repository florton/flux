/**
 * The `heuristics` and `fmt` commands — everything about the prose file that
 * is not running it.
 *
 * These exist so that editing a heuristic stays an ordinary text edit. `fmt`
 * is the formatter that lets an author write "should be greater than" without
 * memorizing that the vocabulary says "is above"; `heuristics` is the listing
 * that answers "what are we watching, and is any of it stale"; `heuristics
 * log` is the change history, read out of git rather than out of a ledger the
 * ratchet would have to keep in sync.
 */
import * as fs from "fs";
import * as path from "path";
import { loadHeuristics, formatProblems, toSubject } from "./heuristic-config";
import { formatHeuristics, describeExtractor, stripComment, type Heuristic } from "./heuristics";
import { heuristicVersions, diffCanonical } from "./heuristic-history";
import { ruleHash } from "./rule";
import { validatedSubjects } from "./validate";
import { loadSubjects } from "./paths";
import { yieldReport } from "./yield";
import { subjectProofs, declaredRejections, PROOF_LABEL, type ProofTier } from "./proof";

export interface FmtResult {
  file: string;
  changed: boolean;
  before: string;
  after: string;
  /** Clauses the formatter rewrote, as before/after pairs. */
  rewrites: { line: number; before: string; after: string }[];
}

/**
 * Rewrite the rules file in canonical form.
 *
 * Every rewrite is deterministic — a synonym table, operator spellings, modal
 * verbs, articles. Nothing is guessed and no model is consulted, so `fmt` can
 * run unattended in a build. What the table cannot resolve is a parse error
 * with a location and a suggestion, never a silent reinterpretation: a tool
 * that quietly decides you meant `is above 5000` is the same failure as a
 * model in the oracle.
 */
export function fmt(ratchetDir: string, opts: { write?: boolean } = {}): FmtResult {
  const loaded = loadHeuristics(ratchetDir);
  if (!loaded.exists) throw new Error(`no ${path.basename(loaded.file)} in ${ratchetDir} — nothing to format`);
  if (loaded.problems.length > 0) throw new Error(formatProblems(loaded.file, loaded.problems));

  const before = fs.readFileSync(loaded.file, "utf8");
  const after = formatHeuristics(loaded.heuristics, loaded.preamble);

  // Which clauses actually moved, in the author's terms. A diff of the whole
  // file would bury one rewritten band in reflowed whitespace.
  const rewrites: FmtResult["rewrites"] = [];
  const beforeLines = before.split(/\r?\n/);
  for (const h of loaded.heuristics) {
    for (const r of h.rules) {
      const raw = stripComment(beforeLines[r.line - 1] ?? "").trim();
      const original = raw.replace(/^rule\s+/i, "").trim();
      if (original !== "" && original !== r.text) {
        rewrites.push({ line: r.line, before: original, after: r.text });
      }
    }
  }

  const changed = normalize(before) !== normalize(after);
  if (changed && opts.write) fs.writeFileSync(loaded.file, after, "utf8");
  return { file: loaded.file, changed, before, after, rewrites };
}

function normalize(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function formatFmt(r: FmtResult, wrote: boolean): string {
  if (!r.changed) return `${path.basename(r.file)} is already canonical`;
  const lines: string[] = [];
  if (r.rewrites.length > 0) {
    lines.push(`${r.rewrites.length} clause(s) snapped to the vocabulary:`);
    for (const w of r.rewrites) {
      lines.push(`  ${String(w.line).padStart(4)} | ${w.before}`);
      lines.push(`       | ${w.after}`);
    }
    lines.push("");
  }
  lines.push(
    wrote
      ? `wrote ${path.basename(r.file)} — commit it, so the clauses that are checked are the clauses that are reviewed`
      : `${path.basename(r.file)} is NOT canonical — run \`ratchet fmt\` to rewrite it`
  );
  return lines.join("\n");
}

export interface HeuristicSummary {
  name: string;
  ruleHash: string;
  run?: string;
  measures: string[];
  rules: string[];
  notes: string[];
  because?: string;
  seed?: number;
  rejects: string[];
  rows: number;
  activeRows: number;
  validated: boolean;
  /** Which proof this heuristic has, never merely that it has one. */
  proof: ProofTier;
  standing: boolean;
  quietDays: number | null;
  line: number;
}

export function listHeuristics(cwd: string, ratchetDir: string): HeuristicSummary[] {
  const loaded = loadHeuristics(ratchetDir);
  if (loaded.problems.length > 0) throw new Error(formatProblems(loaded.file, loaded.problems));
  const config = loadSubjects(ratchetDir);
  const proofs = subjectProofs(cwd, ratchetDir, config);
  const validated = validatedSubjects(cwd, ratchetDir, config);
  const yields = yieldReport(ratchetDir, config, validated, { fromRules: config.fromRules, proofs });
  const byName = new Map(yields.subjects.map((s) => [s.subject, s]));

  return loaded.heuristics.map((h) => {
    const y = byName.get(h.name);
    return {
      name: h.name,
      ruleHash: ruleHash(h.name, toSubject(h), cwd),
      run: h.run,
      measures: h.measures.map((m) => `${m.name} = ${describeExtractor(m.extractor)}`),
      rules: h.rules.map((r) => r.text),
      rejects: declaredRejections({ check: "", heuristic: h }),
      notes: h.notes,
      because: h.because,
      seed: h.seed,
      rows: y?.rows ?? 0,
      activeRows: y?.activeRows ?? 0,
      validated: y?.validated ?? false,
      proof: proofs.get(h.name)?.tier ?? "none",
      standing: proofs.get(h.name)?.standing ?? false,
      quietDays: y?.quietDays ?? null,
      line: h.line,
    };
  });
}

export function formatHeuristicList(items: HeuristicSummary[], file: string): string {
  if (items.length === 0) {
    return (
      `no heuristics declared in ${file}\n\n` +
      `A heuristic is a command, a measure and a rule:\n\n` +
      `  heuristic every-card-has-an-image\n` +
      `    run      node tools/audit-cards.js\n` +
      `    measure  missing  the number after "cards without images:"\n` +
      `    rule     missing is 0\n`
    );
  }
  const lines: string[] = [];
  for (const h of items) {
    const flags = [
      `${h.rows} row${h.rows === 1 ? "" : "s"}`,
      PROOF_LABEL[h.proof],
      h.standing && h.rows === 0 ? "enforcing as a standing invariant" : null,
      h.seed !== undefined ? `seed ${h.seed}` : null,
      h.notes.length ? `${h.notes.length} note${h.notes.length === 1 ? "" : "s"} (unchecked)` : null,
    ].filter(Boolean);
    lines.push(`${h.name}  (rule ${h.ruleHash}, ${path.basename(file)}:${h.line}) — ${flags.join(", ")}`);
    lines.push(`  run  ${h.run}`);
    for (const r of h.rules) lines.push(`  rule ${r}`);
    for (const r of h.rejects) lines.push(`  rejects ${r}  (checked: the rules must refuse this)`);
    // Notes are excluded from every rule count, and saying so at the point of
    // display is what stops them being read as guarantees.
    for (const n of h.notes) lines.push(`  note ${n}  (prose only, never checked)`);
    lines.push("");
  }
  const unvalidated = items.filter((h) => h.proof === "none");
  if (unvalidated.length > 0) {
    lines.push(
      `${unvalidated.length} heuristic(s) have no proof they can fail: ${unvalidated.map((h) => h.name).join(", ")}`
    );
    lines.push(`  prove one against history: ratchet adopt ${unvalidated[0].name} --good <old-ref>`);
    lines.push(`  or without history, in the block itself: rejects <measure> <a value the rules must refuse>`);
  }
  return lines.join("\n");
}

export interface HeuristicLogEntry {
  sha: string;
  shortSha: string;
  date: string;
  author: string;
  message: string;
  ruleHash: string;
  /** The canonical block as of this commit. */
  canonical: string;
  diff: string[];
}

/**
 * Every time this heuristic actually changed, newest first.
 *
 * The source is `git log` over the rules file, so the audit trail of a
 * heuristic edit is the same audit trail as any other code change: no separate
 * ledger to keep in sync, no second place for the truth to live, and it works
 * retroactively on history recorded before this command existed.
 */
export function heuristicLog(cwd: string, ratchetDir: string, name: string): HeuristicLogEntry[] {
  const versions = heuristicVersions(cwd, ratchetDir, name);
  const out: HeuristicLogEntry[] = [];
  for (let i = 0; i < versions.length; i++) {
    const v = versions[i];
    const previous = versions[i - 1];
    out.push({
      sha: v.sha,
      shortSha: v.shortSha,
      date: v.date,
      author: v.author,
      message: v.message,
      ruleHash: v.ruleHash,
      canonical: v.canonical,
      diff: previous ? diffCanonical(previous.canonical, v.canonical) : v.canonical.split("\n").map((l) => `+ ${l.trim()}`),
    });
  }
  return out.reverse();
}

export function formatHeuristicLog(name: string, entries: HeuristicLogEntry[], current?: Heuristic, currentHash?: string): string {
  if (entries.length === 0) {
    return (
      `no committed history for "${name}"\n` +
      `  Either it has never been committed, or git cannot see .ratchet/heuristics.rules from here.`
    );
  }
  const lines: string[] = [];
  // An edit that has not been committed yet is the most important entry on
  // the page: it is the one that just quarantined somebody's rows.
  if (current && currentHash && entries[0].ruleHash !== currentHash) {
    lines.push(`working tree (uncommitted)  rule ${currentHash}`);
    for (const d of diffCanonical(entries[0].canonical, current.canonical)) lines.push(`  ${d}`);
    lines.push(`  edited since ${entries[0].shortSha} — commit it so the change is on the record`);
    lines.push("");
  }
  for (const e of entries) {
    lines.push(`${e.shortSha}  ${e.date.slice(0, 10)}  ${e.author}  ${e.message}`);
    lines.push(`  rule ${e.ruleHash}`);
    for (const d of e.diff) lines.push(`  ${d}`);
    lines.push("");
  }
  lines.push(
    `${entries.length} version(s). A row captured under an older rule is quarantined, not failed:` +
      ` review it, then \`ratchet reaffirm\` (the expectation stands) or \`ratchet accept\` (it does not).`
  );
  return lines.join("\n");
}
