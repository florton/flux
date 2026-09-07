import * as fs from "fs";
import * as path from "path";
import { verify, countOutcomes } from "./verify";
import { runCheckAsync, pool } from "./runner";
import { loadSubjects } from "./paths";
import { commitRange, environment, runSetup, withWorktrees, type CommitInfo, type Environment, type Session } from "./worktree";
import type { RatchetConfig, VerifyResult } from "./types";

export type SamplePolicy = { kind: "dense" } | { kind: "stride"; n: number } | { kind: "period"; unit: "day" | "week" };

export interface ReplayOptions {
  good: string;
  bad: string;
  row?: string;
  subject?: string;
  /** Sampling policy. Dense is the small-repo default. */
  every?: string;
  /** Command run in the worktree before each probe, e.g. "npm ci". */
  setup?: string;
  ratchetHome?: string;
  concurrency?: number;
  /** Skip the halving pass that pinpoints a transition. */
  noPinpoint?: boolean;
  /**
   * Replay the configured *subjects* rather than the corpus rows.
   *
   * A corpus row is a counterexample: a specific input that must not fail
   * again. A subject is a standing invariant, which has no counterexample
   * while it holds — and those are what the field experiments replayed
   * ("one check, run at each commit of the repo's history"). Both are the
   * same check contract pointed at history; this chooses which set to run.
   */
  subjects?: boolean;
}

export interface ReplaySample {
  commit: CommitInfo;
  /** "na-env" when the commit could not be prepared to run at all. */
  status: "pass" | "fail" | "na" | "quarantine" | "na-env";
  counts: { pass: number; fail: number; na: number; quarantine: number };
  results: VerifyResult[];
  note?: string;
}

export interface ReplayReport {
  environment: Environment;
  policy: SamplePolicy;
  sampled: number;
  total: number;
  firstParent: boolean;
  samples: ReplaySample[];
  /** Set when a pass -> fail transition was closed to a single commit. */
  pinpoint?: { firstBad: CommitInfo; probes: number; window: [string, string] };
}

export function parsePolicy(every?: string): SamplePolicy {
  if (!every) return { kind: "dense" };
  if (every === "day" || every === "week") return { kind: "period", unit: every };
  const n = parseInt(every, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`--every takes a positive integer, "day", or "week" (got "${every}")`);
  }
  return n === 1 ? { kind: "dense" } : { kind: "stride", n };
}

/**
 * Choose which commits to probe.
 *
 * Dense replay does not scale: real repositories have thousands of commits
 * and multi-minute builds. Sampling finds the window a transition lives in,
 * and halving closes it — coarse to fine. The last commit is always sampled,
 * so the range's endpoint is never missed by a stride that does not divide it.
 */
export function sample(commits: CommitInfo[], policy: SamplePolicy): CommitInfo[] {
  if (commits.length === 0) return [];
  if (policy.kind === "dense") return commits;

  const picked: CommitInfo[] = [];
  if (policy.kind === "stride") {
    for (let i = 0; i < commits.length; i += policy.n) picked.push(commits[i]);
  } else {
    const bucketOf = (iso: string): string => {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      if (policy.unit === "day") return d.toISOString().slice(0, 10);
      const week = new Date(d);
      week.setUTCDate(week.getUTCDate() - week.getUTCDay());
      return week.toISOString().slice(0, 10);
    };
    let last: string | undefined;
    for (const c of commits) {
      const b = bucketOf(c.date);
      if (b !== last) {
        picked.push(c);
        last = b;
      }
    }
  }
  const final = commits[commits.length - 1];
  if (picked[picked.length - 1]?.sha !== final.sha) picked.push(final);
  return picked;
}

/**
 * Run every configured subject's check once, with no input. The config comes
 * from the carried home, not the checked-out tree, so the set of subjects is
 * the same at every commit.
 */
async function runSubjects(session: Session, only?: string): Promise<VerifyResult[]> {
  const config = loadSubjects(session.home);
  const names = Object.keys(config.subjects).filter((n) => !only || n === only);
  const out: VerifyResult[] = [];
  for (const name of names) {
    const subj = config.subjects[name];
    const res = await runCheckAsync(subj.check, null, {
      cwd: session.path,
      shell: subj.shell,
      timeoutMs: subj.timeoutMs,
      homeDir: session.home,
      projectRoot: session.path,
    });
    out.push({
      id: name,
      subject: name,
      outcome: res.outcome,
      pass: res.outcome === "pass",
      reason: res.reason,
    });
  }
  return out;
}

function statusOf(results: VerifyResult[]): ReplaySample["status"] {
  const c = countOutcomes(results);
  if (c.fail > 0) return "fail";
  if (c.quarantine > 0) return "quarantine";
  if (c.pass > 0) return "pass";
  return "na";
}

export async function replay(cwd: string, opts: ReplayOptions): Promise<ReplayReport> {
  const policy = parsePolicy(opts.every);
  const { commits, firstParent } = commitRange(cwd, opts.good, opts.bad);
  const picked = sample(commits, policy);
  const home = opts.ratchetHome ?? process.env.RATCHET_HOME ?? path.join(cwd, ".ratchet");
  const sessions = Math.max(1, Math.min(opts.concurrency ?? 1, picked.length));

  return withWorktrees(cwd, home, commits[commits.length - 1].sha, sessions, async (poolSessions) => {
    const probe = async (session: Session, commit: CommitInfo): Promise<ReplaySample> => {
      session.checkout(commit.sha);

      // A setup failure at an old commit is an environment candidate, not a
      // bug in that commit's code: the tree was fine, today's toolchain or
      // registry can no longer satisfy it. Reporting it as a failure would
      // manufacture regressions out of dependency rot.
      if (opts.setup) {
        const s = await runSetup(session, opts.setup);
        if (s.outcome !== "pass") {
          return {
            commit,
            status: "na-env",
            counts: { pass: 0, fail: 0, na: 0, quarantine: 0 },
            results: [],
            note: `setup failed: ${s.reason}`,
          };
        }
      }

      const results = opts.subjects
        ? await runSubjects(session, opts.subject)
        : await verify(session.path, {
            row: opts.row,
            subject: opts.subject,
            quiet: true,
            ratchetHome: session.home,
            concurrency: opts.concurrency,
          });
      return { commit, status: statusOf(results), counts: countOutcomes(results), results };
    };

    // One worker per session: a session is a single checkout at a time, so
    // its commits must be probed sequentially by exactly one worker. Items
    // are distributed round-robin and results land at their original index.
    const samples: ReplaySample[] = new Array(picked.length);
    const perSession: { session: Session; items: { commit: CommitInfo; index: number }[] }[] = Array.from(
      { length: sessions },
      (_, i) => ({ session: poolSessions[i], items: [] })
    );
    picked.forEach((commit, index) => perSession[index % sessions].items.push({ commit, index }));
    await pool(perSession, sessions, async (chunk) => {
      for (const { commit, index } of chunk.items) samples[index] = await probe(chunk.session, commit);
    });

    const report: ReplayReport = {
      environment: environment(),
      policy,
      sampled: picked.length,
      total: commits.length,
      firstParent,
      samples,
    };

    // Coarse to fine: the sampler found the window, halving closes it. Only a
    // pass -> fail transition is pinpointed; na-env samples are skipped over
    // rather than treated as either side of a boundary. Halving is inherently
    // sequential and runs on the first session.
    if (opts.noPinpoint) return report;
    const usable = samples.filter((s) => s.status === "pass" || s.status === "fail");
    let lastPass: ReplaySample | undefined;
    let firstFail: ReplaySample | undefined;
    for (const s of usable) {
      if (s.status === "pass") {
        lastPass = s;
        firstFail = undefined;
      } else if (!firstFail && lastPass) {
        firstFail = s;
        break;
      }
    }
    if (!lastPass || !firstFail) return report;

    const lo = commits.findIndex((c) => c.sha === lastPass!.commit.sha) + 1;
    const hi = commits.findIndex((c) => c.sha === firstFail!.commit.sha);
    if (lo > hi) return report;

    let probes = 0;
    let a = lo;
    let b = hi;
    while (a < b) {
      const mid = Math.floor((a + b) / 2);
      probes++;
      const s = await probe(poolSessions[0], commits[mid]);
      if (s.status === "pass") a = mid + 1;
      else b = mid;
    }
    report.pinpoint = {
      firstBad: commits[a],
      probes,
      window: [lastPass.commit.sha.slice(0, 8), firstFail.commit.sha.slice(0, 8)],
    };
    return report;
  });
}

export function formatReplay(r: ReplayReport): string {
  const mark: Record<ReplaySample["status"], string> = {
    pass: "✓",
    fail: "✗",
    na: "−",
    quarantine: "?",
    "na-env": "∅",
  };
  const lines: string[] = [];
  const policy =
    r.policy.kind === "dense" ? "dense" : r.policy.kind === "stride" ? `every ${r.policy.n} commits` : `one per ${r.policy.unit}`;
  lines.push(`replay: ${r.sampled} of ${r.total} commits (${policy})`);
  lines.push(`environment: node ${r.environment.node} on ${r.environment.platform}/${r.environment.arch}`);
  if (r.firstParent) lines.push("range contains merges — following first-parent");
  lines.push("");

  for (const s of r.samples) {
    const c = s.counts;
    const detail =
      s.status === "na-env"
        ? s.note ?? "could not run here"
        : `${c.pass} pass, ${c.fail} fail` + (c.quarantine ? `, ${c.quarantine} quarantined` : "") + (c.na ? `, ${c.na} n/a` : "");
    lines.push(`  ${mark[s.status]} ${s.commit.sha.slice(0, 8)}  ${(s.commit.date || "").slice(0, 10)}  ${detail}  ${s.commit.subject}`);
  }

  if (r.pinpoint) {
    lines.push("");
    lines.push(
      `transition between ${r.pinpoint.window[0]} and ${r.pinpoint.window[1]}, halved in ${r.pinpoint.probes} probes:`
    );
    lines.push(`  first bad commit: ${r.pinpoint.firstBad.sha}  ${r.pinpoint.firstBad.subject}`);
  } else if (r.samples.some((s) => s.status === "fail")) {
    lines.push("");
    lines.push("no pass -> fail transition inside this range (the earliest sample already fails)");
  }

  const envSkipped = r.samples.filter((s) => s.status === "na-env").length;
  if (envSkipped > 0) {
    lines.push("");
    lines.push(
      `${envSkipped} commit(s) could not be prepared in this environment. Replay answers ` +
        `"does this commit pass today's checks under today's environment", not a faithful ` +
        `historical re-enactment; run inside a pinned image for that.`
    );
  }
  return lines.join("\n");
}
