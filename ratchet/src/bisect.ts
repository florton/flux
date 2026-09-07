import * as path from "path";
import { verify } from "./verify";
import { runCheckAsync } from "./runner";
import { commitRange, runSetup, withWorktree } from "./worktree";

export interface BisectOptions {
  /** Command run inside the worktree before each probe (e.g. "npm ci"). */
  setup?: string;
  ratchetHome?: string;
}

export interface BisectResult {
  /** The first commit on the far side of the boundary. */
  boundary: string;
  /** `broke` is pass -> fail; `fixed` is fail -> pass. */
  direction: "broke" | "fixed";
  /** Kept for readers that only ever wanted the regression. */
  firstBad: string;
  probes: number;
  notes: string[];
}

/**
 * Find the commit in `from..to` where a corpus row's verdict changes.
 *
 * The two refs are *range endpoints in history order*, not verdicts. Naming
 * them `--good` and `--bad` presumed the older one passes, which made the
 * command answer only half the question it is asked: "when did we lose the
 * arms" and "when did we get them back" are the same search, and the second
 * one could not be expressed at all — the passing side of a fix is the newer
 * commit, and `--good` has to be an ancestor of `--bad`. So the direction is
 * measured at the endpoints and reported, rather than assumed.
 *
 * The search runs entirely inside a detached `git worktree` (see
 * `withWorktree`): the user's checkout never moves, a dirty working tree is
 * fine, and an error part-way through cannot strand the repository.
 */
export async function bisect(
  cwd: string,
  id: string,
  from: string,
  to: string,
  opts: BisectOptions = {}
): Promise<BisectResult> {
  const notes: string[] = [];
  const { commits, firstParent } = commitRange(cwd, from, to);
  if (firstParent) notes.push("range contains merge commits — searching along first-parent only");

  const home = opts.ratchetHome ?? process.env.RATCHET_HOME ?? path.join(cwd, ".ratchet");
  let probes = 0;

  return withWorktree(cwd, home, commits[commits.length - 1].sha, async (session) => {
    const runTest = async (sha: string): Promise<boolean> => {
      probes++;
      session.checkout(sha);
      if (opts.setup) {
        const s = await runSetup(session, opts.setup);
        if (s.outcome !== "pass") throw new Error(`setup failed at ${sha.slice(0, 8)}: ${s.reason}`);
      }
      const results = await verify(session.path, { row: id, quiet: true, ratchetHome: session.home });
      const row = results.find((r) => r.id === id || r.id.startsWith(id));
      if (!row) throw new Error(`row ${id} not found while verifying ${sha}`);
      return row.pass;
    };

    // `from` is excluded from the range (rev-list from..to), so it is probed
    // by ref rather than by index. Both endpoints are measured before any
    // halving: the two verdicts are what say which direction to search in,
    // and equal verdicts mean there is nothing here to find.
    const startPasses = await runTest(from);
    const endPasses = await runTest(commits[commits.length - 1].sha);
    if (startPasses === endPasses) {
      throw new Error(
        `row ${id} ${startPasses ? "passes" : "fails"} at both ${from} and ${to}, so there is no boundary in this range` +
          ` — widen it, or check whether this row still describes the behavior you are looking for`
      );
    }

    // Find the first commit whose verdict differs from the starting one.
    // Written against `startPasses` rather than against "pass" so the search
    // runs identically whether the range holds a break or a fix.
    let lo = 0;
    let hi = commits.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await runTest(commits[mid].sha)) === startPasses) lo = mid + 1;
      else hi = mid;
    }
    const direction = startPasses ? "broke" : "fixed";
    return { boundary: commits[lo].sha, direction, firstBad: commits[lo].sha, probes, notes };
  });
}

/** The boundary, said in the direction it actually runs. */
export function formatBisect(r: BisectResult, id: string): string {
  const lines =
    r.direction === "broke"
      ? [`row ${id} first fails at ${r.boundary}`, `  pass -> fail, found in ${r.probes} probes`]
      : [`row ${id} first passes at ${r.boundary}`, `  fail -> pass, found in ${r.probes} probes`];
  for (const n of r.notes) lines.push(`  ${n}`);
  return lines.join("\n");
}
