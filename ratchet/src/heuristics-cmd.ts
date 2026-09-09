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
import { RULES_TEMPLATE } from "./templates";
import { instrumentPath } from "./instrument";

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
  /**
   * True when config.json declares this name too, so the block never becomes
   * a subject. Listed anyway -- it is in the file, and a reader looking for
   * why it is not enforcing needs to find it here rather than in fsck.
   */
  shadowed: boolean;
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
      shadowed: config.collisions.includes(h.name),
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
      h.shadowed ? "NOT RUNNING -- shadowed by config.json" : null,
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
  // Said before the proof advice, because it changes what that advice means:
  // a shadowed block's `rejects` line is not a proof of anything, since the
  // proof is looked up against the subject that actually exists — the script.
  const shadowed = items.filter((h) => h.shadowed);
  if (shadowed.length > 0) {
    lines.push(
      `${shadowed.length} heuristic(s) are declared here and not running: ${shadowed.map((h) => h.name).join(", ")}`
    );
    lines.push(`  config.json declares the same name(s) and wins, so the block never becomes a subject.`);
    lines.push(`  fix: delete the config.json entry, or rename the block (\`ratchet fsck\` names the collision too)`);
    lines.push("");
  }
  const unvalidated = items.filter((h) => h.proof === "none");
  if (unvalidated.length > 0) {
    lines.push(
      `${unvalidated.length} heuristic(s) have no proof they can fail: ${unvalidated.map((h) => h.name).join(", ")}`
    );
    lines.push(`  prove one against history: ratchet adopt ${unvalidated[0].name} --good <old-ref>`);
    lines.push(`    find a ref where it fails: ratchet replay --subjects --subject ${unvalidated[0].name} --good <an-old-ref>`);
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

export interface NewHeuristicResult {
  file: string;
  name: string;
  /** True when the rules file did not exist and was created with its header. */
  createdFile: boolean;
  /** The block as written, commented. */
  block: string;
}

/**
 * The skeleton `ratchet heuristics new` appends.
 *
 * Commented, exactly like the example `init` ships. A live skeleton whose
 * `run` line points at nothing would redden the build the moment it was
 * written, and a tool that breaks your gate to help you extend it is a tool
 * you stop reaching for. Uncommenting is one motion in any editor and one
 * `sed` for an agent.
 *
 * The clause order is the order the vocabulary reads in: what to run, what to
 * read out of it, what must be true, what it must refuse, why it matters.
 */
function skeleton(name: string, run: string | undefined): string {
  const command = run ?? `node {home}/tools/${name}.mjs`;
  // `owns` has to name the script the `run` line actually reaches, or the
  // skeleton ships the exact defect the comment under it warns about. The
  // instrument reader already knows how to find it; when it cannot — a
  // command with no path in it, or one outside the home — say so instead of
  // writing a path that is wrong.
  const reached = instrumentPath(command, false);
  const owned =
    reached && reached.includes("{home}")
      ? ".ratchet" + reached.split("{home}")[1]
      : undefined;
  return [
    `# heuristic ${name}`,
    `#   run      ${command}`,
    owned
      ? `#   owns     ${owned}`
      : `#   owns     <the script the run line above reaches, relative to the repo root>`,
    `#   measure  thing  the number after "things found:"`,
    `#   rule     thing is 0`,
    `#   rejects  thing 1`,
    `#   because  say what breaks for a person when this stops being true`,
    ``,
    `# owns is not decoration: without it the instrument's contents are outside`,
    `# the rule hash, and rewriting the script re-points every row it armed.`,
    `# rejects is the proof this check can fail without waiting for a bug --`,
    `# it is checked against the rules on every load, so a value your rules`,
    `# would accept is an error with a line and a column.`,
    `# Reach a script through {home} so history commands run the same one at`,
    `# every commit. \`applies when <path> exists\` reports n/a where the feature`,
    `# did not exist yet; \`needs <path> exists\` reports "cannot run here".`,
  ].join("\n");
}

/**
 * Start a new heuristic block, with the two collisions checked up front.
 *
 * The second one is the point. A prose block sharing a name with a
 * `config.json` subject is dropped by `mergeConfig` — config wins — so it
 * parses, gets counted, gets listed, and never runs. Discovering that after
 * writing the block costs a reading of the merge logic; discovering it here
 * costs nothing.
 */
export function newHeuristic(
  ratchetDir: string,
  name: string,
  opts: { run?: string } = {}
): NewHeuristicResult {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(
      `"${name}" is not a usable subject name — use letters, digits, dots, dashes and underscores`
    );
  }

  const loaded = loadHeuristics(ratchetDir);
  if (loaded.heuristics.some((h) => h.name === name)) {
    throw new Error(
      `"${name}" is already a heuristic in ${path.basename(loaded.file)}:` +
        `${loaded.heuristics.find((h) => h.name === name)!.line} — edit that block, or pick another name`
    );
  }
  // A skeleton is commented, so it is not a *parsed* heuristic and the check
  // above cannot see it. Without this, running the command twice — which is
  // exactly what happens when an agent retries — silently appends a second
  // copy, and the day somebody uncomments both they get "declared twice".
  if (loaded.exists) {
    const already = fs
      .readFileSync(loaded.file, "utf8")
      .split(/\r?\n/)
      .findIndex((l) => {
        const parts = l.replace(/^\s*#?\s*/, "").trim().split(/\s+/);
        return parts.length === 2 && parts[0] === "heuristic" && parts[1] === name;
      });
    if (already !== -1) {
      throw new Error(
        `"${name}" already has a block in ${path.basename(loaded.file)}:${already + 1}` +
          ` — it is commented out, so nothing parses it yet. Fill that one in rather than starting a second.`
      );
    }
  }

  const configPath = path.join(ratchetDir, "config.json");
  if (fs.existsSync(configPath)) {
    let declared: string[] = [];
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as { subjects?: Record<string, unknown> };
      declared = Object.keys(raw.subjects ?? {});
    } catch {
      // A config.json that will not parse is `guard`'s finding to report, not
      // a reason to refuse a text edit to a different file.
    }
    if (declared.includes(name)) {
      throw new Error(
        `"${name}" is already a subject in config.json, and config.json wins: a heuristic block with that name ` +
          `would parse, be counted, be listed by \`ratchet heuristics\` — and never run.\n` +
          `  Either delete the config.json entry first and re-spell the whole subject here,\n` +
          `  or give this one its own name, e.g. ${name}-standing, and leave the scripted subject enforcing.`
      );
    }
  }

  const createdFile = !loaded.exists;
  const block = skeleton(name, opts.run);
  const existing = createdFile ? RULES_TEMPLATE : fs.readFileSync(loaded.file, "utf8");
  const body = existing.replace(/\s*$/, "") + "\n\n" + block + "\n";
  fs.writeFileSync(loaded.file, body, "utf8");
  return { file: loaded.file, name, createdFile, block };
}

export function formatNewHeuristic(r: NewHeuristicResult): string {
  return [
    r.createdFile
      ? `created ${r.file} and appended a commented skeleton for "${r.name}"`
      : `appended a commented skeleton for "${r.name}" to ${r.file}`,
    "",
    r.block,
    "",
    "next:",
    `  1. fill it in and uncomment it (the block is inert until you do)`,
    `  2. ratchet fmt                     snap loose wording to the vocabulary`,
    `  3. ratchet guard                   see what it says about the new subject`,
    `  4. prove it can fail, either way:`,
    `       ratchet adopt ${r.name} --good <an-old-ref>       against your own history`,
    `       or keep the \`rejects\` line                     against a stated reading`,
  ].join("\n");
}
