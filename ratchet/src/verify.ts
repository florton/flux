import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { activeRows, readCorpus, stableStringify } from "./corpus";
import type { RatchetConfig, RowState, VerifyResult } from "./types";
import { runCheckAsync, pool } from "./runner";
import { failureSignature, signaturesMatch } from "./signature";
import { ruleHash } from "./rule";

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
  const configPath = path.join(ratchetDir, "config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error("no .ratchet/config.json found — run `ratchet init` first");
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as RatchetConfig;
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

  const results = await pool(rows, opts.concurrency ?? defaultConcurrency(), async (row): Promise<VerifyResult> => {
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

  if (opts.json) {
    console.log(JSON.stringify({ results, counts: countOutcomes(results) }, null, 2));
  } else if (!opts.quiet) {
    printResults(results, new Map(rows.map((r) => [r.id, r])));
  }
  return results;
}

export function countOutcomes(results: VerifyResult[]): { pass: number; fail: number; na: number; quarantine: number } {
  return {
    pass: results.filter((r) => r.outcome === "pass").length,
    fail: results.filter((r) => r.outcome === "fail").length,
    na: results.filter((r) => r.outcome === "na").length,
    quarantine: results.filter((r) => r.outcome === "quarantine").length,
  };
}

function printResults(results: VerifyResult[], byId: Map<string, RowState>): void {
  for (const r of results) {
    const row = byId.get(r.id);
    const shown = row ? ` ${inputString(row)}` : "";
    if (r.outcome === "pass") {
      console.log(`✓ ${r.id} ${r.subject}`);
    } else if (r.outcome === "na") {
      console.log(`− ${r.id} ${r.subject}${shown} — n/a: ${r.reason}`);
    } else if (r.outcome === "quarantine") {
      console.log(`? ${r.id} ${r.subject}${shown} — quarantined: ${r.reason}`);
      console.log(`    behavior changed under an edited rule — review, then \`ratchet reaffirm ${r.id}\` or \`ratchet accept ${r.id}\``);
    } else {
      const drift = r.signatureDrift ? "  [!] different failure than the one captured" : "";
      console.log(`✗ ${r.id} ${r.subject}${shown} — ${r.reason ?? "failed"}${drift}`);
    }
  }
  const { pass, fail, na, quarantine } = countOutcomes(results);
  const parts = [`${pass}/${results.length} rows pass`];
  if (fail) parts.push(`${fail} failing`);
  if (quarantine) parts.push(`${quarantine} quarantined`);
  if (na) parts.push(`${na} n/a`);
  console.log(`\n${parts.join(", ")}`);

  const staleRule = results.filter((r) => r.ruleChanged && r.outcome === "pass").length;
  if (staleRule > 0) {
    console.log(
      `${staleRule} passing row(s) are pinned to an older version of their rule — \`ratchet reaffirm\` to re-pin them`
    );
  }

  const drifted = results.filter((r) => r.outcome === "fail" && r.signatureDrift).length;
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
