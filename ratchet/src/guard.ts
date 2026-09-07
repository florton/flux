/**
 * `ratchet guard` — the one command a build runs.
 *
 * The ask behind this file: the mechanism must be self-enforcing, the way a
 * TypeScript build is. `tsc` does not ask you to remember to typecheck; it is
 * wired into the build, it exits nonzero, and that is the whole enforcement
 * story. Every ratchet guarantee up to now needed a human to remember a
 * different command — `verify` for rows, `fsck` for integrity, `fmt` for the
 * rules file, `validate` before trusting a subject — and a guarantee that
 * needs remembering is a guarantee that lapses on the first busy afternoon.
 *
 * So: one gate, one exit code, four questions.
 *
 *   1. Does the rules file parse, and is it canonical? (a clause that stopped
 *      parsing is a check that stopped running)
 *   2. Is the corpus intact? (a row hidden behind a parse error is a false pass)
 *   3. Do the active rows still hold? (the regression gate)
 *   4. Is anything enforcing that was never proven? (unvalidated subjects)
 *
 * Only the first three fail the build by default. An unvalidated subject is a
 * warning here and a refusal at `capture`, because that is where the damage
 * would be done: a vacuous check enters the corpus at capture time, not at
 * verify time.
 */
import * as fs from "fs";
import * as path from "path";
import { loadSubjects } from "./paths";
import { loadHeuristics, formatProblems } from "./heuristic-config";
import { formatHeuristics } from "./heuristics";
import { fsck } from "./fsck";
import { verify, countOutcomes } from "./verify";
import { validatedSubjects } from "./validate";
import { yieldReport, type YieldReport } from "./yield";
import type { VerifyResult } from "./types";

export interface GuardOptions {
  ratchetHome: string;
  concurrency?: number;
  /** Fail the build on unvalidated subjects too. Off by default. */
  strict?: boolean;
  staleAfterDays?: number;
}

export interface GuardStep {
  name: string;
  ok: boolean;
  severity: "error" | "warning";
  detail: string;
}

export interface GuardResult {
  ok: boolean;
  steps: GuardStep[];
  results: VerifyResult[];
  yields?: YieldReport;
}

export async function guard(cwd: string, opts: GuardOptions): Promise<GuardResult> {
  const steps: GuardStep[] = [];
  const add = (name: string, ok: boolean, severity: GuardStep["severity"], detail: string): void => {
    steps.push({ name, ok, severity, detail });
  };

  // 1. The rules file: parseable, and canonical on disk.
  const loaded = loadHeuristics(opts.ratchetHome);
  if (loaded.exists && loaded.problems.length > 0) {
    add("heuristics parse", false, "error", formatProblems(loaded.file, loaded.problems));
    return { ok: false, steps, results: [] };
  }
  if (loaded.exists) {
    const canonical = formatHeuristics(loaded.heuristics, loaded.preamble);
    const onDisk = fs.readFileSync(loaded.file, "utf8");
    const drifted = normalize(onDisk) !== normalize(canonical);
    add(
      "heuristics canonical",
      !drifted,
      "warning",
      drifted
        ? `${path.basename(loaded.file)} is not in canonical form — run \`ratchet fmt\` so the committed clauses are the checked clauses`
        : `${loaded.heuristics.length} heuristic(s), canonical`
    );
  }

  // 2. Corpus and journal integrity.
  const integrity = fsck(opts.ratchetHome);
  const errors = integrity.findings.filter((f) => f.severity === "error");
  add(
    "integrity",
    errors.length === 0,
    "error",
    errors.length === 0
      ? "corpus and journal readable, ids match their content"
      : errors.map((f) => `${f.kind}: ${f.detail}`).join("\n")
  );

  // 3. The regression gate itself.
  //
  // `verify` refuses outright on an unreadable corpus — a row hidden behind a
  // parse error is a false pass. That refusal is a *finding*, not a crash: a
  // guard that dies with a stack trace inside a pre-commit hook tells the
  // person nothing about what is wrong or how to fix it.
  let results: VerifyResult[] = [];
  try {
    results = await verify(cwd, {
      ratchetHome: opts.ratchetHome,
      quiet: true,
      concurrency: opts.concurrency,
    });
  } catch (err) {
    add("rows", false, "error", err instanceof Error ? err.message : String(err));
    return { ok: false, steps, results: [] };
  }
  const counts = countOutcomes(results);
  // The count alone is useless in a blocked commit: what a person needs, at
  // the moment git refuses them, is which expectation broke and what the
  // measurement was. Anything less and they re-run `ratchet verify` by hand,
  // which is the step the hook existed to remove.
  const detail = [
    `${counts.pass}/${results.length} rows pass` +
      (counts.fail ? `, ${counts.fail} failing` : "") +
      (counts.quarantine ? `, ${counts.quarantine} quarantined` : "") +
      (counts.na ? `, ${counts.na} n/a` : ""),
  ];
  for (const r of results) {
    if (r.outcome === "fail") {
      detail.push(`✗ ${r.id.slice(0, 9)} ${r.subject} — ${(r.reason ?? "failed").split("\n")[0]}`);
      if (r.signatureDrift) detail.push("    [!] a different failure than the one captured");
    } else if (r.outcome === "quarantine") {
      detail.push(`? ${r.id.slice(0, 9)} ${r.subject} — quarantined (the heuristic moved): ${(r.reason ?? "").split("\n")[0]}`);
    }
  }
  if (counts.fail > 0 || counts.quarantine > 0) {
    detail.push("run `ratchet verify` for the full witness, or `ratchet show <id>` for one row's history");
  }
  add("rows", counts.fail === 0, "error", detail.join("\n"));

  // A gate that is mostly "not applicable" reads green while checking almost
  // nothing. Say so out loud rather than letting the tick speak for it.
  if (results.length > 0 && counts.na / results.length > 0.5) {
    add(
      "coverage",
      false,
      "warning",
      `${counts.na} of ${results.length} rows reported n/a — most of this gate is not actually checking anything here`
    );
  }

  // 4. Who checks the checkers.
  const config = loadSubjects(opts.ratchetHome);
  const validated = validatedSubjects(cwd, opts.ratchetHome, config);
  const unvalidated = Object.keys(config.subjects).filter((n) => !validated.has(n));
  add(
    "validation",
    unvalidated.length === 0,
    opts.strict ? "error" : "warning",
    unvalidated.length === 0
      ? `all ${Object.keys(config.subjects).length} subject(s) proven against a known bug`
      : `${unvalidated.length} subject(s) have no validation proof for their current rule: ${unvalidated.join(", ")}\n` +
        `  prove one with: ratchet validate ${unvalidated[0]} --known-bad <sha> --known-good HEAD`
  );

  const yields = yieldReport(opts.ratchetHome, config, validated, {
    staleAfterDays: opts.staleAfterDays,
    fromRules: config.fromRules,
  });

  return {
    ok: steps.every((s) => s.ok || s.severity === "warning"),
    steps,
    results,
    yields,
  };
}

/** Trailing whitespace and blank-line runs are not part of canonical form. */
function normalize(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function formatGuard(r: GuardResult): string {
  const lines: string[] = [];
  for (const s of r.steps) {
    const mark = s.ok ? "✓" : s.severity === "error" ? "✗" : "!";
    const first = s.detail.split("\n")[0];
    lines.push(`${mark} ${s.name.padEnd(20)} ${first}`);
    for (const extra of s.detail.split("\n").slice(1)) lines.push(`  ${extra}`);
  }
  const failed = r.steps.filter((s) => !s.ok && s.severity === "error");
  const warned = r.steps.filter((s) => !s.ok && s.severity === "warning");
  lines.push("");
  lines.push(
    failed.length === 0
      ? `guard passed${warned.length ? ` with ${warned.length} warning(s)` : ""}`
      : `guard failed: ${failed.map((s) => s.name).join(", ")}`
  );
  return lines.join("\n");
}
