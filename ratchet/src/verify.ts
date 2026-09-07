import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { activeRows, readCorpus, stableStringify } from "./corpus";
import type { RatchetConfig, RowState, VerifyResult } from "./types";
import { runCheckAsync, pool } from "./runner";
import { failureSignature, signaturesMatch } from "./signature";
import { ruleHash } from "./rule";
import { loadSubjects } from "./paths";
import { explainRuleChange } from "./heuristic-history";
import { standingSubjects, subjectProofs } from "./proof";
import type { Heuristic } from "./heuristics";

export interface VerifyOptions {
  row?: string;
  subject?: string;
  quiet?: boolean;
  json?: boolean;
  ratchetHome?: string;
  /** Rows checked in parallel. Defaults to the CPU count, capped at 8. */
  concurrency?: number;
}

interface ResolvedCheck {
  command: string;
  input: unknown;
  shell?: boolean;
  timeoutMs?: number;
  testName?: string;
  homeDir?: string;
}

function resolveCheck(config: RatchetConfig, row: RowState, homeDir: string): ResolvedCheck {
  const subj = config.subjects[row.subject];
  if (!subj) {
    throw new Error(`no subject config for "${row.subject}"`);
  }
  // The test name is never interpolated into a shell string. It reaches the
  // check as a single argv element (via `{test}`) and as RATCHET_TEST, so a
  // crafted test name cannot become command syntax.
  return {
    command: subj.check,
    input: row.input,
    shell: subj.shell,
    timeoutMs: subj.timeoutMs,
    testName: row.test,
    homeDir,
  };
}

export function defaultConcurrency(): number {
  return Math.max(1, Math.min(8, os.cpus()?.length ?? 1));
}

export async function verify(cwd: string, opts: VerifyOptions): Promise<VerifyResult[]> {
  const ratchetDir = opts.ratchetHome ?? process.env.RATCHET_HOME ?? path.join(cwd, ".ratchet");
  const config = loadSubjects(ratchetDir);
  const corpusPath = path.join(ratchetDir, "corpus.jsonl");

  // A corpus that cannot be fully read cannot certify anything: a row hidden
  // behind a parse error is a false pass. Refuse, and say which line.
  const { problems } = readCorpus(corpusPath);
  if (problems.length > 0) {
    const shown = problems.slice(0, 3).map((p) => `  line ${p.line}: ${p.error}`).join("\n");
    throw new Error(
      `corpus.jsonl has ${problems.length} unreadable line(s), so verification cannot be trusted:\n${shown}\n` +
        `run \`ratchet fsck\` for the full report`
    );
  }

  let rows = activeRows(corpusPath);
  if (opts.row) rows = rows.filter((r) => r.id === opts.row || r.id.startsWith(opts.row!));
  if (opts.subject) rows = rows.filter((r) => r.subject === opts.subject);

  // One hash per subject, not per row: the rule is a property of the subject.
  const ruleCache = new Map<string, string>();
  const currentRule = (subject: string): string | undefined => {
    const subj = config.subjects[subject];
    if (!subj) return undefined;
    let h = ruleCache.get(subject);
    if (h === undefined) {
      h = ruleHash(subject, subj, cwd);
      ruleCache.set(subject, h);
    }
    return h;
  };

  // Standing invariants: subjects a declared rejection has proven, with no
  // row to carry them. `verify` enforces rows *union* standing invariants —
  // the tool has had both natures since `replay --subjects` and had simply
  // never named the second, so a never-failed invariant had no way to enforce
  // at all. Skipped when a single row was asked for by id: that question is
  // about one counterexample, not about the gate.
  const proofs = subjectProofs(cwd, ratchetDir, config);
  const rowed = new Set(rows.filter((r) => r.input === null).map((r) => r.subject));
  const standing = opts.row
    ? []
    : standingSubjects(config, proofs, rowed).filter((n) => !opts.subject || n === opts.subject);

  const rowResults = await pool(rows, opts.concurrency ?? defaultConcurrency(), async (row): Promise<VerifyResult> => {
    try {
      const { command, input, shell, timeoutMs, testName, homeDir } = resolveCheck(config, row, ratchetDir);
      const res = await runCheckAsync(command, input, { cwd, shell, timeoutMs, testName, homeDir });
      const drift =
        res.outcome === "fail" && !res.errored && row.signature !== undefined
          ? !signaturesMatch(failureSignature(res.reason, res.code), row.signature)
          : false;

      // Rule unchanged and row fails -> hard block, this is a regression.
      // Rule changed and row fails  -> quarantine, routed to review: the
      // instrument moved, so the failure no longer cleanly means the code
      // regressed. Re-deriving the expectation silently is what the ceremony
      // exists to prevent.
      const rule = currentRule(row.subject);
      const ruleChanged = row.ruleHash !== undefined && rule !== undefined && row.ruleHash !== rule;
      const outcome = res.outcome === "fail" && ruleChanged ? "quarantine" : res.outcome;

      return {
        id: row.id,
        subject: row.subject,
        outcome,
        pass: outcome === "pass",
        reason: res.reason,
        signatureDrift: drift,
        ruleChanged,
      };
    } catch (err) {
      return {
        id: row.id,
        subject: row.subject,
        outcome: "fail",
        pass: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  });

  const standingResults = await pool(standing, opts.concurrency ?? defaultConcurrency(), async (name): Promise<VerifyResult> => {
    const subj = config.subjects[name];
    try {
      const res = await runCheckAsync(subj.check, null, {
        cwd,
        shell: subj.shell,
        timeoutMs: subj.timeoutMs,
        homeDir: ratchetDir,
        projectRoot: cwd,
      });
      return {
        id: name,
        subject: name,
        kind: "standing",
        outcome: res.outcome === "quarantine" ? "fail" : res.outcome,
        pass: res.outcome === "pass",
        reason: res.reason,
      };
    } catch (err) {
      return {
        id: name,
        subject: name,
        kind: "standing",
        outcome: "fail",
        pass: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  });

  const results = [...rowResults, ...standingResults];

  if (opts.json) {
    console.log(JSON.stringify({ results, counts: countOutcomes(results) }, null, 2));
  } else if (!opts.quiet) {
    printResults(results, new Map(rows.map((r) => [r.id, r])), {
      cwd, ratchetDir, config, declaredSubjects: Object.keys(config.subjects).length,
    });
  }
  return results;
}

/** Rows and standing invariants, kept apart: they measure different things. */
export function splitResults(results: VerifyResult[]): { rows: VerifyResult[]; standing: VerifyResult[] } {
  return {
    rows: results.filter((r) => r.kind !== "standing"),
    standing: results.filter((r) => r.kind === "standing"),
  };
}

export function countOutcomes(results: VerifyResult[]): {
  pass: number; fail: number; na: number; naEnv: number; quarantine: number;
} {
  return {
    pass: results.filter((r) => r.outcome === "pass").length,
    fail: results.filter((r) => r.outcome === "fail").length,
    na: results.filter((r) => r.outcome === "na").length,
    naEnv: results.filter((r) => r.outcome === "na-env").length,
    quarantine: results.filter((r) => r.outcome === "quarantine").length,
  };
}

interface PrintContext {
  cwd: string;
  ratchetDir: string;
  config: { subjects: Record<string, { heuristic?: Heuristic }> };
  /** How many subjects this repository declares, for the empty-gate warning. */
  declaredSubjects?: number;
}

/**
 * A gate that is green while checking nothing.
 *
 * `verify` on an empty corpus prints "0/0 rows pass" and exits 0. That is
 * right for a freshly initialized home and wrong for a repository that
 * declares subjects and has armed none of them — and it is not hypothetical:
 * a v0.7 note recorded that `verify` and twenty-one other commands resolved
 * `--home` identically when checked by hand. They did, because the check ran
 * against an empty corpus where both routes answer "0/0 rows pass". With one
 * row they disagreed, and the disagreement reddened every row in the corpus.
 * A defect was written down as "not a defect" because the gate was green over
 * nothing.
 */
export function emptyGateWarning(results: VerifyResult[], declaredSubjects: number): string | undefined {
  if (results.length > 0 || declaredSubjects === 0) return undefined;
  return (
    `this repository declares ${declaredSubjects} subject(s) and has no armed rows and no standing invariants` +
    ` — nothing was checked, and a green tick here means only that there was nothing to check.\n` +
    `  arm one against your own history:  ratchet adopt <subject> --good <an-old-ref>\n` +
    "  or prove one without history:      add a `rejects <measure> <value>` line to its heuristic"
  );
}

function printResults(results: VerifyResult[], byId: Map<string, RowState>, ctx?: PrintContext): void {
  const { rows: rowResults, standing } = splitResults(results);
  for (const r of rowResults) {
    const row = byId.get(r.id);
    const shown = row ? ` ${inputString(row)}` : "";
    if (r.outcome === "pass") {
      console.log(`✓ ${r.id} ${r.subject}`);
    } else if (r.outcome === "na") {
      console.log(`− ${r.id} ${r.subject}${shown} — n/a: ${r.reason}`);
    } else if (r.outcome === "na-env") {
      console.log(`∅ ${r.id} ${r.subject}${shown} — could not run here: ${r.reason}`);
    } else if (r.outcome === "quarantine") {
      console.log(`? ${r.id} ${r.subject}${shown} — quarantined: ${r.reason}`);
      // "rule fd59 became a3b1" tells a reviewer nothing. When the subject is
      // prose and git still holds the old version, show the clause that moved.
      const h = ctx?.config.subjects[r.subject]?.heuristic;
      if (h && ctx && row?.ruleHash) {
        for (const line of explainRuleChange(ctx.cwd, ctx.ratchetDir, r.subject, row.ruleHash, h) ?? []) {
          console.log(`    ${line}`);
        }
      }
      console.log(`    review, then \`ratchet reaffirm ${r.id} --reason "..."\` (the expectation stands) or \`ratchet accept ${r.id} --reason "..."\` (it does not)`);
    } else {
      const drift = r.signatureDrift ? "  [!] different failure than the one captured" : "";
      console.log(`✗ ${r.id} ${r.subject}${shown} — ${r.reason ?? "failed"}${drift}`);
    }
  }
  // Standing invariants are printed as their own block and counted
  // separately. They are not counterexamples and the catch rate is a
  // statement about counterexamples, so merging the two numbers would make
  // both of them mean less.
  for (const r of standing) {
    if (r.outcome === "pass") console.log(`✓ ${r.subject} — standing invariant holds`);
    else if (r.outcome === "na") console.log(`− ${r.subject} — standing invariant n/a: ${r.reason}`);
    else if (r.outcome === "na-env") console.log(`∅ ${r.subject} — standing invariant could not run here: ${r.reason}`);
    else console.log(`✗ ${r.subject} — standing invariant broken: ${r.reason ?? "failed"}`);
  }

  const { pass, fail, na, naEnv, quarantine } = countOutcomes(rowResults);
  const parts = [`${pass}/${rowResults.length} rows pass`];
  if (fail) parts.push(`${fail} failing`);
  if (quarantine) parts.push(`${quarantine} quarantined`);
  if (na) parts.push(`${na} n/a`);
  if (naEnv) parts.push(`${naEnv} could not run here`);
  if (standing.length > 0) {
    const s = countOutcomes(standing);
    parts.push(
      `${s.pass}/${standing.length} standing invariants hold` +
        (s.fail ? `, ${s.fail} broken` : "") +
        (s.na ? `, ${s.na} n/a` : "") +
        (s.naEnv ? `, ${s.naEnv} could not run here` : "")
    );
  }
  console.log(`\n${parts.join(", ")}`);

  const empty = emptyGateWarning(results, ctx?.declaredSubjects ?? 0);
  if (empty) console.log(empty);

  const staleRule = rowResults.filter((r) => r.ruleChanged && r.outcome === "pass").length;
  if (staleRule > 0) {
    console.log(
      `${staleRule} passing row(s) are pinned to an older version of their rule — \`ratchet reaffirm\` to re-pin them`
    );
  }

  // A gate that is mostly "not applicable" is green while checking almost
  // nothing, which is the quietest way for this tool to become theatre.
  // Both kinds of "no verdict" count here: a gate that is green while
  // checking nothing is the quietest way for this tool to become theatre,
  // and it does not matter which of the two reasons produced the silence.
  if (rowResults.length > 0 && (na + naEnv) / rowResults.length > 0.5) {
    console.log(
      `${na + naEnv} of ${rowResults.length} rows returned no verdict` +
        (naEnv ? ` (${na} n/a, ${naEnv} could not run here)` : "") +
        ` — most of this gate is not checking anything here`
    );
  }

  const drifted = rowResults.filter((r) => r.outcome === "fail" && r.signatureDrift).length;
  if (drifted > 0) {
    console.log(
      `${drifted} failing for a different reason than captured — check whether the row still describes the bug it was created for`
    );
  }
}

export async function verifyAndExit(cwd: string, opts: VerifyOptions): Promise<never> {
  const results = await verify(cwd, opts);
  process.exit(results.some((r) => r.outcome === "fail") ? 1 : 0);
}

export function inputString(row: { input: unknown; test?: string }): string {
  return row.input === null && row.test ? `(test: ${row.test})` : stableStringify(row.input);
}
