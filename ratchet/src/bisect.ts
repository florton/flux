import * as path from "path";
import { verify } from "./verify";
import { runCheckAsync } from "./runner";
import { commitRange, withWorktree } from "./worktree";

export interface BisectOptions {
  /** Command run inside the worktree before each probe (e.g. "npm ci"). */
  setup?: string;
  ratchetHome?: string;
}

export interface BisectResult {
  firstBad: string;
  probes: number;
  notes: string[];
}

/**
 * Find the first commit in `good..bad` where a corpus row starts failing.
 *
 * The search runs entirely inside a detached `git worktree` (see
 * `withWorktree`): the user's checkout never moves, a dirty working tree is
 * fine, and an error part-way through cannot strand the repository.
 */
export async function bisect(
  cwd: string,
  id: string,
  good: string,
  bad: string,
  opts: BisectOptions = {}
): Promise<BisectResult> {
  const notes: string[] = [];
  const { commits, firstParent } = commitRange(cwd, good, bad);
  if (firstParent) notes.push("range contains merge commits — searching along first-parent only");

  const home = opts.ratchetHome ?? process.env.RATCHET_HOME ?? path.join(cwd, ".ratchet");
  let probes = 0;

  return withWorktree(cwd, home, commits[commits.length - 1].sha, async (session) => {
    const runTest = async (sha: string): Promise<boolean> => {
      probes++;
      session.checkout(sha);
      if (opts.setup) {
        const s = await runCheckAsync(opts.setup, null, {
          cwd: session.path,
          shell: true,
          timeoutMs: 600_000,
          // The setup script needs the carried home for the same reason the
          // check does: a build script added last month does not exist in a
          // worktree checked out at a commit from last year, so `{home}` must
          // resolve outside the tree being measured.
          homeDir: session.home,
          projectRoot: session.path,
        });
        if (s.outcome !== "pass") throw new Error(`setup failed at ${sha.slice(0, 8)}: ${s.reason}`);
      }
      const results = await verify(session.path, { row: id, quiet: true, ratchetHome: session.home });
      const row = results.find((r) => r.id === id || r.id.startsWith(id));
      if (!row) throw new Error(`row ${id} not found while verifying ${sha}`);
      return row.pass;
    };

    const last = commits[commits.length - 1].sha;
    if (await runTest(last)) {
      throw new Error(`row ${id} passes at ${bad} — --bad must be a failing commit`);
    }
    // `good` is excluded from the range (rev-list good..bad), so it is probed
    // by ref rather than by index; it must pass for the search to mean
    // anything.
    if (!(await runTest(good))) {
      throw new Error(`row ${id} fails at ${good} — --good must be a passing commit`);
    }

    let lo = 0;
    let hi = commits.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (await runTest(commits[mid].sha)) lo = mid + 1;
      else hi = mid;
    }
    return { firstBad: commits[lo].sha, probes, notes };
  });
}
