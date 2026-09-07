/**
 * `ratchet adopt` — putting a new heuristic to work on the history it was
 * written for.
 *
 * A heuristic is born the moment somebody notices something worth watching,
 * which is almost always *after* the bug it describes. Until now, arming it
 * against that bug meant a manual worktree dance: check out the bad commit,
 * build it, run capture against a carried home, come back, reaffirm the rows
 * to today's instrument. That is six commands and a mistake waiting to happen,
 * and it was the actual procedure used to populate this repository's own
 * corpus.
 *
 * `adopt` is that procedure as one command. It walks history from a known-good
 * ref, finds where the heuristic fails, captures a row at the first such
 * commit with the failure recorded as provenance, and re-pins the row to
 * today's rule so it enforces from now on.
 *
 * The result is the natural lifecycle of a human-authored characteristic:
 * born validated, immediately enforcing, with its fix history already drawn.
 */
import * as path from "path";
import { appendEvent, foldRows, readEvents, rowId } from "./corpus";
import { appendJournal } from "./journal";
import { runCheckAsync } from "./runner";
import { failureSignature } from "./signature";
import { ruleHash } from "./rule";
import { loadSubjects } from "./paths";
import { commitInfo, commitRange, runSetup, withWorktree, type CommitInfo } from "./worktree";
import type { CorpusEvent } from "./types";

export interface AdoptOptions {
  good: string;
  bad?: string;
  setup?: string;
  ratchetHome: string;
  actor?: string;
  /** Probe every Nth commit rather than every one. */
  every?: number;
  /** Report what would happen without writing anything. */
  dryRun?: boolean;
}

export interface AdoptProbe {
  sha: string;
  shortSha: string;
  message: string;
  outcome: "pass" | "fail" | "na";
  reason: string;
}

export interface AdoptResult {
  subject: string;
  ruleHash: string;
  probes: AdoptProbe[];
  /** The oldest probed commit where the heuristic fails. */
  firstFailing?: AdoptProbe;
  /** The newest probed commit where it passes, if any. */
  lastPassing?: AdoptProbe;
  rowId?: string;
  captured: boolean;
  validated: boolean;
  notes: string[];
}

export async function adopt(cwd: string, subject: string, opts: AdoptOptions): Promise<AdoptResult> {
  const config = loadSubjects(opts.ratchetHome);
  const subj = config.subjects[subject];
  if (!subj) {
    const names = Object.keys(config.subjects);
    throw new Error(
      `no subject "${subject}" is configured` +
        (names.length ? ` — this repository has: ${names.join(", ")}` : " — this repository configures none")
    );
  }

  const bad = opts.bad ?? "HEAD";
  const { commits } = commitRange(cwd, opts.good, bad);
  if (commits.length === 0) {
    throw new Error(`no commits between ${opts.good} and ${bad} — is --good an ancestor of --bad?`);
  }
  const step = Math.max(1, opts.every ?? 1);
  const picked = commits.filter((_, i) => i % step === 0 || i === commits.length - 1);

  const notes: string[] = [];
  const probes: AdoptProbe[] = [];

  const head = commitInfo(cwd, bad);
  const result = await withWorktree(cwd, opts.ratchetHome, head.sha, async (session) => {
    const run = async (commit: CommitInfo): Promise<AdoptProbe> => {
      session.checkout(commit.sha);
      if (opts.setup) {
        const s = await runSetup(session, opts.setup);
        if (s.outcome !== "pass") {
          // Dependency rot, not a regression: an old tree today's toolchain
          // can no longer build says nothing about that commit's behavior.
          return { sha: commit.sha, shortSha: commit.sha.slice(0, 8), message: commit.subject, outcome: "na", reason: `setup failed: ${s.reason}` };
        }
      }
      const r = await runCheckAsync(subj.check, null, {
        cwd: session.path,
        shell: subj.shell,
        timeoutMs: subj.timeoutMs,
        // The carried home, so every commit is measured by today's heuristic
        // rather than by whatever that commit happened to contain.
        homeDir: session.home,
        projectRoot: session.path,
      });
      return {
        sha: commit.sha,
        shortSha: commit.sha.slice(0, 8),
        message: commit.subject,
        outcome: r.outcome === "quarantine" ? "fail" : r.outcome,
        reason: r.reason,
      };
    };

    for (const c of picked) probes.push(await run(c));

    const firstFailing = probes.find((p) => p.outcome === "fail");
    if (!firstFailing) return { firstFailing: undefined, confirmation: undefined };

    // Confirm at the failing commit before storing anything, exactly as a
    // capture would: a heuristic that fails once and passes on the retry is
    // measuring noise, and a noisy row poisons every later verify.
    session.checkout(firstFailing.sha);
    const again = await runCheckAsync(subj.check, null, {
      cwd: session.path,
      shell: subj.shell,
      timeoutMs: subj.timeoutMs,
      homeDir: session.home,
      projectRoot: session.path,
    });
    return { firstFailing, confirmation: again };
  });

  const firstFailing = result.firstFailing;
  const lastPassing = [...probes].reverse().find((p) => p.outcome === "pass");
  const rule = ruleHash(subject, subj, cwd);

  const out: AdoptResult = {
    subject,
    ruleHash: rule,
    probes,
    firstFailing,
    lastPassing,
    captured: false,
    validated: false,
    notes,
  };

  if (!firstFailing) {
    notes.push(
      `"${subject}" passes at every probed commit between ${opts.good} and ${bad}.` +
        ` Nothing to adopt: either this history never had the problem, or the heuristic is too weak to see it.` +
        ` A heuristic that cannot fail anywhere in your history has not been proven to catch anything.`
    );
    return out;
  }

  if (result.confirmation && result.confirmation.outcome !== "fail") {
    notes.push(
      `"${subject}" failed at ${firstFailing.shortSha} but passed on the confirmation run` +
        ` ("${result.confirmation.reason}") — that is a flaky heuristic, and a flaky row would redden every future build. Nothing was captured.`
    );
    return out;
  }

  // Failing where the bug lived and passing at a later commit is exactly the
  // validation protocol, observed rather than asserted.
  out.validated = lastPassing !== undefined;

  const id = rowId(subject, null, subject);
  out.rowId = id;
  if (opts.dryRun) {
    notes.push(`dry run: would capture ${id} and pin it to rule ${rule}`);
    return out;
  }

  const corpusPath = path.join(opts.ratchetHome, "corpus.jsonl");
  const journalPath = path.join(opts.ratchetHome, "journal.jsonl");
  const existing = foldRows(readEvents(corpusPath)).get(id);
  if (existing && existing.status === "active") {
    notes.push(`${id} is already in the corpus and enforcing — nothing to add`);
    return out;
  }

  const at = new Date().toISOString();
  const event: CorpusEvent = {
    op: "capture",
    id,
    at,
    subject,
    input: null,
    test: subject,
    reason: firstFailing.reason,
    signature: failureSignature(firstFailing.reason, 1),
    // Pinned to today's rule, not to the historical one: the row must enforce
    // against the current heuristic from the moment it exists, or its first
    // verify would quarantine it for an edit nobody made.
    ruleHash: rule,
    commit: firstFailing.sha.slice(0, 8),
    actor: opts.actor ?? "human",
    source: "manual",
  };
  appendEvent(corpusPath, event);
  appendJournal(journalPath, {
    at,
    kind: "decision",
    actor: opts.actor ?? "human",
    text:
      `adopted "${subject}" over ${opts.good}..${bad}: fails at ${firstFailing.shortSha} "${firstFailing.message}"` +
      (lastPassing ? `, passes at ${lastPassing.shortSha} "${lastPassing.message}"` : ", never observed passing in this range") +
      ` — ${firstFailing.reason}`,
    corpusId: id,
    commit: firstFailing.sha.slice(0, 8),
  });

  if (out.validated) {
    // The same proof `ratchet validate` writes, in the same shape, so the
    // capture gate recognizes it: adopting a heuristic *is* validating it.
    appendJournal(journalPath, {
      at,
      kind: "validation",
      actor: opts.actor ?? "human",
      text:
        `validated "${subject}" (rule ${rule}): fails at ${firstFailing.sha.slice(0, 8)} "${firstFailing.message}",` +
        ` passes at ${lastPassing!.sha.slice(0, 8)} "${lastPassing!.message}"`,
      commit: firstFailing.sha,
    });
  } else {
    notes.push(
      `"${subject}" failed at ${firstFailing.shortSha} but was never observed passing in this range,` +
        ` so no validation proof was recorded. Widen --good, or check whether the heuristic is simply broken.`
    );
  }

  out.captured = true;
  return out;
}

/** Witnesses are multi-line; a probe table wants one line per commit. */
function firstLine(reason: string): string {
  return (reason.split(/\r?\n/)[0] ?? "").slice(0, 90);
}

export function formatAdopt(r: AdoptResult): string {
  const lines: string[] = [`subject: ${r.subject}  (rule ${r.ruleHash})`];
  for (const p of r.probes) {
    const mark = p.outcome === "pass" ? "✓" : p.outcome === "fail" ? "✗" : "−";
    lines.push(`  ${mark} ${p.shortSha}  ${p.message.slice(0, 48).padEnd(48)} ${p.outcome === "pass" ? "" : firstLine(p.reason)}`);
  }
  lines.push("");
  if (r.firstFailing) {
    lines.push(`first failing probed commit: ${r.firstFailing.shortSha} "${r.firstFailing.message}"`);
    lines.push(`  witness: ${r.firstFailing.reason}`);
  }
  if (r.captured) {
    lines.push(
      `captured ${r.rowId} pinned to the current rule — \`ratchet verify\` enforces it from now on` +
        (r.validated ? "\nvalidated: it fails where the bug lived and passes where it was fixed" : "")
    );
  }
  for (const n of r.notes) lines.push(n);
  return lines.join("\n");
}
