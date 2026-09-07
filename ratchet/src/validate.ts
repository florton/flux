import * as fs from "fs";
import * as path from "path";
import { runCheckAsync } from "./runner";
import { appendJournal, readJournal } from "./journal";
import { ruleHash } from "./rule";
import { commitInfo, runSetup, withWorktree } from "./worktree";
import { loadSubjects } from "./paths";
import type { RatchetConfig } from "./types";

export interface ValidateOptions {
  knownBad: string;
  knownGood?: string;
  /** Input fed to the check, as JSON. Defaults to null. */
  input?: unknown;
  setup?: string;
  ratchetHome?: string;
  actor?: string;
}

export interface ValidateResult {
  subject: string;
  ruleHash: string;
  knownBad: { ref: string; sha: string; subject: string; failed: boolean; reason: string };
  knownGood?: { ref: string; sha: string; subject: string; passed: boolean; reason: string };
  valid: boolean;
}

/**
 * The subject-validation protocol, as a command.
 *
 * "Every subject must be proven to fail on at least one known past bug before
 * it can be captured from. A subject that passes through history's known bugs
 * is too weak" — this is the mechanical answer to who checks the checkers,
 * and as a convention rather than a command it erodes the first time someone
 * is in a hurry.
 *
 * A subject is validated by showing it fails at a commit known to contain the
 * bug, and (optionally, but strongly preferred) passes at a commit known not
 * to. The proof is written to the journal against the rule hash it was proven
 * under, so editing the check invalidates its own validation.
 */
export async function validate(cwd: string, subject: string, opts: ValidateOptions): Promise<ValidateResult> {
  const ratchetDir = opts.ratchetHome ?? process.env.RATCHET_HOME ?? path.join(cwd, ".ratchet");
  const config = loadSubjects(ratchetDir);
  const subj = config.subjects[subject];
  if (!subj) {
    const names = Object.keys(config.subjects);
    throw new Error(
      `no subject "${subject}" is configured` +
        (names.length ? ` — this repository has: ${names.join(", ")}` : " — this repository configures none")
    );
  }

  const input = opts.input ?? null;
  const bad = commitInfo(cwd, opts.knownBad);
  const good = opts.knownGood ? commitInfo(cwd, opts.knownGood) : undefined;

  const result = await withWorktree(cwd, ratchetDir, bad.sha, async (session) => {
    const probe = async (sha: string) => {
      session.checkout(sha);
      if (opts.setup) {
        const s = await runSetup(session, opts.setup);
        if (s.outcome !== "pass") throw new Error(`setup failed at ${sha.slice(0, 8)}: ${s.reason}`);
      }
      return runCheckAsync(subj.check, input, {
        cwd: session.path,
        shell: subj.shell,
        timeoutMs: subj.timeoutMs,
        // The carried home, not the checked-out tree: the instrument must be
        // the same one at every commit for the readings to be comparable.
        homeDir: session.home,
      });
    };

    const badRun = await probe(bad.sha);
    const goodRun = good ? await probe(good.sha) : undefined;
    return { badRun, goodRun };
  });

  const rule = ruleHash(subject, subj, cwd);
  const badFailed = result.badRun.outcome === "fail";
  const goodPassed = result.goodRun ? result.goodRun.outcome === "pass" : true;

  const out: ValidateResult = {
    subject,
    ruleHash: rule,
    knownBad: {
      ref: opts.knownBad,
      sha: bad.sha,
      subject: bad.subject,
      failed: badFailed,
      reason: result.badRun.reason,
    },
    knownGood: good
      ? {
          ref: opts.knownGood!,
          sha: good.sha,
          subject: good.subject,
          passed: result.goodRun!.outcome === "pass",
          reason: result.goodRun!.reason,
        }
      : undefined,
    valid: badFailed && goodPassed,
  };

  if (out.valid) {
    const detail =
      `validated "${subject}" (rule ${rule}): fails at ${bad.sha.slice(0, 8)} "${bad.subject}"` +
      (good ? `, passes at ${good.sha.slice(0, 8)} "${good.subject}"` : " (no known-good ref given)");
    appendJournal(path.join(ratchetDir, "journal.jsonl"), {
      at: new Date().toISOString(),
      kind: "validation",
      actor: opts.actor ?? "human",
      text: detail,
      commit: bad.sha,
    });
  }
  return out;
}

/**
 * Subjects with a recorded validation for their *current* rule. Editing a
 * check changes its hash, so its validation no longer applies — the proof is
 * tied to the instrument it was proven against.
 */
export function validatedSubjects(cwd: string, ratchetDir: string, config: RatchetConfig): Set<string> {
  const journal = readJournal(path.join(ratchetDir, "journal.jsonl"));
  const valid = new Set<string>();
  for (const [name, subj] of Object.entries(config.subjects)) {
    const rule = ruleHash(name, subj, cwd);
    const needle = `validated "${name}" (rule ${rule})`;
    if (journal.some((j) => j.kind === "validation" && j.text.startsWith(needle))) valid.add(name);
  }
  return valid;
}

export function formatValidate(r: ValidateResult): string {
  const lines = [`subject: ${r.subject}  (rule ${r.ruleHash})`];
  lines.push(
    `  ${r.knownBad.failed ? "✓" : "✗"} known-bad ${r.knownBad.sha.slice(0, 8)} "${r.knownBad.subject}" — ` +
      (r.knownBad.failed ? `fails as required: ${r.knownBad.reason}` : "PASSES, so this subject is too weak to catch that bug")
  );
  if (r.knownGood) {
    lines.push(
      `  ${r.knownGood.passed ? "✓" : "✗"} known-good ${r.knownGood.sha.slice(0, 8)} "${r.knownGood.subject}" — ` +
        (r.knownGood.passed ? "passes as required" : `FAILS here too: ${r.knownGood.reason}`)
    );
  }
  lines.push("");
  lines.push(
    r.valid
      ? "validated — proof recorded in the journal against this rule hash"
      : "NOT validated — a subject that passes through a known bug cannot be trusted to catch a new one"
  );
  return lines.join("\n");
}
