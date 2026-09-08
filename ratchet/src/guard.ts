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
 *   4. Is anything enforcing that was never proven? (unproven subjects)
 *
 * Rows and standing invariants are reported as separate steps and both fail
 * the build: a row says "this exact input once broke", a standing invariant
 * says "this must always be true here", and a build wants to know which of
 * the two stopped holding.
 *
 * Only those fail the build by default. An unproven subject is a warning here
 * and a refusal at `capture`, because that is where the damage would be done:
 * a vacuous check enters the corpus at capture time, not at verify time.
 */
import * as fs from "fs";
import * as path from "path";
import { loadSubjects } from "./paths";
import { loadHeuristics, formatProblems, type MergedConfig } from "./heuristic-config";
import { formatHeuristics } from "./heuristics";
import { fsck } from "./fsck";
import { instrumentsInsideTree } from "./instrument";
import { verify, countOutcomes, splitResults, emptyGateWarning } from "./verify";
import { subjectProofs, PROOF_LABEL, type ProofTier } from "./proof";
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

  // The subjects themselves: config.json parseable, and every subject a shape
  // that can actually be run. This is the same class of failure as a rules
  // file that will not parse — every subject in it has stopped enforcing — so
  // it is refused here, once, rather than left for `fsck` and `verify` to
  // rediscover separately and print the same paragraph twice.
  let config: MergedConfig;
  try {
    config = loadSubjects(opts.ratchetHome);
  } catch (err) {
    add("subjects", false, "error", err instanceof Error ? err.message : String(err));
    return { ok: false, steps, results: [] };
  }

  // 2. Corpus and journal integrity.
  const integrity = fsck(opts.ratchetHome, cwd);
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
  const { rows: rowResults, standing } = splitResults(results);
  const counts = countOutcomes(rowResults);
  // The count alone is useless in a blocked commit: what a person needs, at
  // the moment git refuses them, is which expectation broke and what the
  // measurement was. Anything less and they re-run `ratchet verify` by hand,
  // which is the step the hook existed to remove.
  const detail = [
    `${counts.pass}/${rowResults.length} rows pass` +
      (counts.fail ? `, ${counts.fail} failing` : "") +
      (counts.quarantine ? `, ${counts.quarantine} quarantined` : "") +
      (counts.na ? `, ${counts.na} n/a` : "") +
      (counts.naEnv ? `, ${counts.naEnv} could not run here` : ""),
  ];
  for (const r of rowResults) {
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

  // Standing invariants are their own step. A row says "this exact input once
  // broke"; a standing invariant says "this must always be true here", and a
  // build wants to know which of the two stopped holding.
  if (standing.length > 0) {
    const s = countOutcomes(standing);
    const lines = [
      `${s.pass}/${standing.length} standing invariants hold` +
        (s.fail ? `, ${s.fail} broken` : "") +
        (s.na ? `, ${s.na} n/a` : "") +
        (s.naEnv ? `, ${s.naEnv} could not run here` : ""),
    ];
    for (const r of standing) {
      if (r.outcome === "fail") lines.push(`✗ ${r.subject} — ${(r.reason ?? "failed").split("\n")[0]}`);
      else if (r.outcome === "na") lines.push(`− ${r.subject} — n/a: ${(r.reason ?? "").split("\n")[0]}`);
      else if (r.outcome === "na-env") lines.push(`∅ ${r.subject} — could not run here: ${(r.reason ?? "").split("\n")[0]}`);
    }
    add("standing", s.fail === 0, "error", lines.join("\n"));
  }

  // Green over nothing, shape one: a repository that declares subjects and
  // has armed none of them.
  const empty = emptyGateWarning(results, Object.keys(config.subjects).length);
  if (empty) add("coverage", false, "warning", empty);

  // The partial form of shape one, and the one that actually hid. A gate can
  // arm some subjects and leave others running nothing at all: `verify`
  // enforces active rows *union* standing invariants, so a subject in neither
  // set is declared, configured, counted by `validation` as proven — and
  // never executed once. It hid a real subject in this tool's own repository
  // for four versions, and every green it printed was true on its own terms.
  //
  // Read off what `verify` actually ran rather than re-deriving its selection
  // rule here, so the two cannot drift apart: a subject nothing reports on is
  // a subject nothing ran. A warning, not a failure — a subject can be
  // legitimately between rows, and the honest thing to say is what is true.
  const ran = new Set(results.map((r) => r.subject));
  const unrun = Object.keys(config.subjects).filter((n) => !ran.has(n)).sort();
  if (unrun.length > 0 && !empty) {
    const unrunProse = unrun.filter((n) => config.fromRules.has(n));
    const scripted = unrun.filter((n) => !config.fromRules.has(n));
    // Same discipline as the validation advice below: `rejects` is a clause in
    // the rules file, so it is only on offer to a subject that has a block
    // there. Telling a scripted subject to add one is advice it cannot take.
    const how = [`  arm one against your own history:  ratchet adopt ${unrun[0]} --good <an-old-ref>`];
    if (unrunProse.length > 0) {
      const who = unrunProse.length === unrun.length ? "" : ` for ${unrunProse.join(", ")}`;
      how.push(`  or enforce it with no row${who}, in the rules: rejects <measure> <a value the rules must refuse>`);
    }
    if (scripted.length > 0) {
      how.push(
        `  ${scripted.join(", ")} declared in config.json, with no rules block to declare a rejection in:` +
          ` to enforce without a row, re-spell as a heuristic with a run line`
      );
    }
    add(
      "unrun subjects",
      false,
      "warning",
      [`nothing runs ${unrun.length} of ${Object.keys(config.subjects).length} declared subject(s): ${unrun.join(", ")}`, ...how].join("\n")
    );
  }

  // Shape two: an instrument that lives inside the tree it measures. Correct
  // at HEAD, wrong under every history command — so it is exactly the kind of
  // thing a gate has to say out loud, because nothing else ever will.
  const inside = instrumentsInsideTree(cwd, config);
  if (inside.length > 0) {
    add(
      "frozen instrument",
      false,
      "warning",
      inside
        .flatMap((f) => [f.detail, `    fix: ${f.fix}`])
        .join("\n")
    );
  }

  // A gate that is mostly "not applicable" reads green while checking almost
  // nothing. Say so out loud rather than letting the tick speak for it.
  const noVerdict = counts.na + counts.naEnv;
  if (rowResults.length > 0 && noVerdict / rowResults.length > 0.5) {
    add(
      "coverage",
      false,
      "warning",
      `${noVerdict} of ${rowResults.length} rows returned no verdict` +
        (counts.naEnv ? ` (${counts.na} n/a, ${counts.naEnv} could not run here)` : "") +
        ` — most of this gate is not actually checking anything here`
    );
  }

  // 4. Who checks the checkers — and by which of the two proofs.
  //
  // Never a bare "validated": a reviewer who wants to know which subjects
  // have only the weaker proof must be able to see it at a glance, because
  // the entire argument for the capture gate was that "validated once" must
  // never quietly mean "trusted forever".
  const proofs = subjectProofs(cwd, opts.ratchetHome, config);
  const byTier = (t: ProofTier): string[] =>
    [...proofs.values()].filter((p) => p.tier === t).map((p) => p.subject).sort();
  const unproven = byTier("none");
  // A proof is not a promise that anything runs it. Naming an unrun subject
  // here with no qualifier is the false green R31 recorded: the reader takes
  // "validated against history" to mean the check is standing guard, when it
  // means only that it once could have.
  const unrunSet = new Set(unrun);
  const named = (t: ProofTier): string =>
    byTier(t).map((n) => (unrunSet.has(n) ? `${n} (nothing runs it)` : n)).join(", ");
  const proofLines = (["history", "declared"] as const)
    .filter((t) => byTier(t).length > 0)
    .map((t) => `  ${byTier(t).length} ${PROOF_LABEL[t]}: ${named(t)}`);
  const validated = new Set([...proofs.values()].filter((p) => p.tier !== "none").map((p) => p.subject));
  // `rejects` is a clause in the rules file, so it is only on offer to a
  // subject that has a block there. A subject declared in config.json has no
  // block and cannot take that advice — and a gate that tells you to do an
  // impossible thing is a gate you stop reading. History proof suits both, so
  // it is always offered; the second line is named when only some can use it.
  const unprovenProse = unproven.filter((s) => config.fromRules.has(s));
  const advice = [`  prove one against history:   ratchet validate ${unproven[0]} --known-bad <sha> --known-good HEAD`];
  if (unprovenProse.length > 0) {
    const who = unprovenProse.length === unproven.length ? "" : ` for ${unprovenProse.join(", ")}`;
    advice.push(`  or without it${who}, in the rules: rejects <measure> <a value the rules must refuse>`);
  }
  add(
    "validation",
    unproven.length === 0,
    opts.strict ? "error" : "warning",
    (unproven.length === 0
      ? [`all ${Object.keys(config.subjects).length} subject(s) have a proof they can fail`]
      : [`${unproven.length} subject(s) have no proof they can fail: ${unproven.join(", ")}`, ...advice]
    ).concat(proofLines).join("\n")
  );

  const yields = yieldReport(opts.ratchetHome, config, validated, {
    staleAfterDays: opts.staleAfterDays,
    fromRules: config.fromRules,
    proofs,
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
