import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { verify } from "./verify";
import { runCheck } from "./runner";

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

function git(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

/**
 * Find the first commit in `good..bad` where a corpus row starts failing.
 *
 * The search runs entirely inside a detached `git worktree`. The previous
 * implementation ran `git checkout` in the user's own working tree with no
 * teardown, so any error — a typo'd row id was enough — left the repository
 * on a detached HEAD at some old commit. Nothing here touches the user's
 * checkout, the worktree is removed in a `finally`, and a dirty working tree
 * is no longer a reason to refuse.
 */
export function bisect(cwd: string, id: string, good: string, bad: string, opts: BisectOptions = {}): BisectResult {
  const notes: string[] = [];

  const goodSha = git(cwd, ["rev-parse", good]);
  if (goodSha.status !== 0) throw new Error(`bad --good ref: ${good}`);
  const badSha = git(cwd, ["rev-parse", bad]);
  if (badSha.status !== 0) throw new Error(`bad --bad ref: ${bad}`);

  const ancestor = git(cwd, ["merge-base", "--is-ancestor", goodSha.stdout, badSha.stdout]);
  if (ancestor.status !== 0) {
    throw new Error(
      `${good} is not an ancestor of ${bad} — bisect needs a range, not two unrelated refs`
    );
  }

  // A binary search assumes the commit list is monotone: everything before
  // the introducing commit passes, everything after fails. That holds on a
  // linear range; across merges it does not. Following first-parent keeps
  // the search on the mainline, where the assumption is true, and names the
  // merge that brought the regression in.
  const merges = git(cwd, ["rev-list", "--merges", `${goodSha.stdout}..${badSha.stdout}`]);
  const firstParent = merges.status === 0 && merges.stdout !== "";
  if (firstParent) {
    notes.push("range contains merge commits — searching along first-parent only");
  }

  const listArgs = ["rev-list", "--reverse"];
  if (firstParent) listArgs.push("--first-parent");
  listArgs.push(`${goodSha.stdout}..${badSha.stdout}`);
  const list = git(cwd, listArgs);
  if (list.status !== 0 || list.stdout === "") {
    throw new Error(`no commits between ${good} and ${bad}`);
  }
  const commits = list.stdout.split("\n");

  const home = opts.ratchetHome ?? process.env.RATCHET_HOME ?? path.join(cwd, ".ratchet");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-bisect-"));
  const tempHome = path.join(tmp, ".ratchet");
  const worktree = path.join(tmp, "wt");
  let worktreeAdded = false;
  let probes = 0;

  try {
    // The corpus is carried out of the tree so that checking out a commit
    // whose .ratchet/ predates today's memory cannot shadow it.
    fs.cpSync(home, tempHome, { recursive: true });

    const add = git(cwd, ["worktree", "add", "--detach", worktree, badSha.stdout]);
    if (add.status !== 0) throw new Error(`could not create worktree: ${add.stderr}`);
    worktreeAdded = true;

    const runTest = (sha: string): boolean => {
      probes++;
      const co = git(worktree, ["checkout", "--detach", "--force", sha]);
      if (co.status !== 0) throw new Error(`checkout ${sha} failed: ${co.stderr}`);
      if (opts.setup) {
        const s = runCheck(opts.setup, null, { cwd: worktree, shell: true, timeoutMs: 600_000 });
        if (!s.pass) throw new Error(`setup failed at ${sha.slice(0, 8)}: ${s.reason}`);
      }
      const results = verify(worktree, { row: id, quiet: true, ratchetHome: tempHome });
      const row = results.find((r) => r.id === id || r.id.startsWith(id));
      if (!row) throw new Error(`row ${id} not found while verifying ${sha}`);
      return row.pass;
    };

    if (runTest(badSha.stdout)) {
      throw new Error(`row ${id} passes at ${bad} — --bad must be a failing commit`);
    }
    if (!runTest(goodSha.stdout)) {
      throw new Error(`row ${id} fails at ${good} — --good must be a passing commit`);
    }

    let lo = 0;
    let hi = commits.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (runTest(commits[mid])) lo = mid + 1;
      else hi = mid;
    }
    return { firstBad: commits[lo], probes, notes };
  } finally {
    if (worktreeAdded) git(cwd, ["worktree", "remove", "--force", worktree]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
