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
  /** Skip the halving pass that closes each transition to one commit. */
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

/**
 * A verdict boundary, closed to a single commit and labelled by direction.
 *
 * v0 searched for *the* transition, and only a pass -> fail one: it reported
 * "no pass -> fail transition inside this range" on a repository whose
 * boundary ran the other way, and the manual probing that answer forced is
 * exactly the work `replay` exists to remove. "When did we lose the arms" and
 * "when did we get them back" are the same question asked twice, and a range
 * that holds both a break and a fix — the ordinary case for any bug that was
 * found and fixed — used to report at most the first of them, labelled
 * `first bad commit` whichever it was.
 */
export interface Transition {
  /** `broke` is pass -> fail; `fixed` is fail -> pass. */
  kind: "broke" | "fixed";
  /** The first commit on the *new* side of the boundary. */
  commit: CommitInfo;
  probes: number;
  /** The sampled commits the boundary was found between. */
  window: [string, string];
}

export interface ReplayReport {
  environment: Environment;
  policy: SamplePolicy;
  sampled: number;
  total: number;
  firstParent: boolean;
  samples: ReplaySample[];
  /**
   * Every verdict boundary in the range, in history order. Monotonicity is
   * still assumed *within* a window, exactly as before; sampling is what finds
   * the windows, and that assumption is now per-window rather than per-range.
   */
  transitions: Transition[];
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
  // A check that said "this environment cannot run me here" is the same
  // finding as a setup that could not prepare the commit, and is reported the
  // same way rather than as a plain n/a.
  if (c.naEnv > 0) return "na-env";
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
      transitions: [],
    };

    // Coarse to fine: the sampler finds the windows, halving closes them.
    //
    // *Every* adjacent pair of usable samples whose verdict differs is a
    // window, and each is halved independently. That is the whole of the
    // generalization: a break and a later fix are two boundaries in one range
    // and both get named, in history order, with their direction. `na` and
    // `na-env` samples are skipped over rather than treated as either side of
    // a boundary. Halving is inherently sequential and runs on one session.
    if (opts.noPinpoint) return report;
    const usable = samples.filter((s) => s.status === "pass" || s.status === "fail");
    const indexOf = (sha: string): number => commits.findIndex((c) => c.sha === sha);

    for (let i = 1; i < usable.length; i++) {
      const before = usable[i - 1];
      const after = usable[i];
      if (before.status === after.status) continue;

      const lo = indexOf(before.commit.sha) + 1;
      const hi = indexOf(after.commit.sha);
      if (lo < 0 || hi < 0 || lo > hi) continue;

      // Find the first commit in (before, after] carrying `after`'s verdict.
      // Written against `before.status` rather than against "pass" so the
      // search runs identically in both directions.
      let probes = 0;
      let a = lo;
      let b = hi;
      while (a < b) {
        const mid = Math.floor((a + b) / 2);
        probes++;
        const s = await probe(poolSessions[0], commits[mid]);
        if (s.status === before.status) a = mid + 1;
        else b = mid;
      }
      report.transitions.push({
        kind: after.status === "fail" ? "broke" : "fixed",
        commit: commits[a],
        probes,
        window: [before.commit.sha.slice(0, 8), after.commit.sha.slice(0, 8)],
      });
    }
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
        ? s.note ?? s.results.map((r) => r.reason).find((x) => x) ?? "could not run here"
        : `${c.pass} pass, ${c.fail} fail` + (c.quarantine ? `, ${c.quarantine} quarantined` : "") + (c.na ? `, ${c.na} n/a` : "");
    lines.push(`  ${mark[s.status]} ${s.commit.sha.slice(0, 8)}  ${(s.commit.date || "").slice(0, 10)}  ${detail}  ${s.commit.subject}`);
  }

  if (r.transitions.length > 0) {
    lines.push("");
    lines.push(`transitions (${r.transitions.length}):`);
    for (const t of r.transitions) {
      lines.push(
        `  ${t.kind === "broke" ? "broke" : "fixed"}  at ${t.commit.sha.slice(0, 8)}  ` +
          `${JSON.stringify(t.commit.subject.slice(0, 40))}  ` +
          `${t.kind === "broke" ? "pass -> fail" : "fail -> pass"}, halved in ${t.probes} probe${t.probes === 1 ? "" : "s"}` +
          ` (between ${t.window[0]} and ${t.window[1]})`
      );
    }
    for (const t of r.transitions) {
      if (t.kind === "broke") lines.push(`  first bad commit: ${t.commit.sha}  ${t.commit.subject}`);
    }
  } else {
    const seen = new Set(r.samples.filter((s) => s.status === "pass" || s.status === "fail").map((s) => s.status));
    if (seen.size === 1) {
      lines.push("");
      lines.push(
        `no transition inside this range — every usable sample ${seen.has("fail") ? "fails" : "passes"}.` +
          ` Widen the range, or sample more densely if a boundary could be hiding between two probes.`
      );
    }
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
