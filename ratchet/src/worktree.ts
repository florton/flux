import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function git(cwd: string, args: string[]): GitResult {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

/**
 * The environment a history run happened under.
 *
 * Old commits fail on today's machine for reasons that were never committed:
 * toolchain upgrades, dependency registries, OS changes. Recording what the
 * run happened under is what makes such a failure attributable rather than
 * reported as a bug in the code.
 */
export interface Environment {
  node: string;
  platform: string;
  arch: string;
  at: string;
}

export function environment(): Environment {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    at: new Date().toISOString(),
  };
}

export interface Session {
  /** Path of the detached worktree. Checks run with this as cwd. */
  path: string;
  /** A private copy of the ratchet home, carried out of the tree. */
  home: string;
  checkout(sha: string): void;
}

function makeSession(worktree: string, tempHome: string): Session {
  return {
    path: worktree,
    home: tempHome,
    checkout(sha: string): void {
      const co = git(worktree, ["checkout", "--detach", "--force", sha]);
      if (co.status !== 0) throw new Error(`checkout ${sha} failed: ${co.stderr}`);
    },
  };
}

interface CreatedWorktree {
  worktree: string;
  tmp: string;
}

function createWorktree(cwd: string, home: string, startSha: string): CreatedWorktree {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-wt-"));
  const worktree = path.join(tmp, "wt");
  const tempHome = path.join(tmp, ".ratchet");
  fs.cpSync(home, tempHome, { recursive: true });
  const add = git(cwd, ["worktree", "add", "--detach", worktree, startSha]);
  if (add.status !== 0) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`could not create worktree: ${add.stderr}`);
  }
  return { worktree, tmp };
}

function removeWorktrees(cwd: string, created: CreatedWorktree[]): void {
  for (const c of created) git(cwd, ["worktree", "remove", "--force", c.worktree]);
  for (const c of created) fs.rmSync(c.tmp, { recursive: true, force: true });
}

/**
 * Run `fn` against a detached worktree, and tear it down whatever happens.
 *
 * History commands must never touch the user's checkout. A `git checkout` in
 * the working tree strands the repository on a detached HEAD the moment
 * anything throws, and it forces the tree to be clean for no good reason.
 * A worktree has neither problem.
 *
 * The ratchet home is copied out of the tree as well, so checking out a
 * commit whose `.ratchet/` predates today's memory cannot shadow it.
 */
export async function withWorktree<T>(
  cwd: string,
  home: string,
  startSha: string,
  fn: (session: Session) => Promise<T>
): Promise<T> {
  return withWorktrees(cwd, home, startSha, 1, async (sessions) => fn(sessions[0]));
}

/**
 * Like `withWorktree`, but with `count` parallel sessions.
 *
 * A `git worktree` holds one checked-out commit at a time, so probing N
 * commits concurrently needs N worktrees. Each session has its own copy of
 * the ratchet home (checks must never observe a half-written shared one), and
 * every session is torn down in the `finally` whatever happens.
 */
export async function withWorktrees<T>(
  cwd: string,
  home: string,
  startSha: string,
  count: number,
  fn: (sessions: Session[]) => Promise<T>
): Promise<T> {
  const created: CreatedWorktree[] = [];
  try {
    const sessions: Session[] = [];
    for (let i = 0; i < count; i++) {
      const c = createWorktree(cwd, home, startSha);
      created.push(c);
      sessions.push(makeSession(c.worktree, path.join(c.tmp, ".ratchet")));
    }
    return await fn(sessions);
  } finally {
    removeWorktrees(cwd, created);
  }
}

export interface CommitInfo {
  sha: string;
  date: string;
  subject: string;
}

export function commitInfo(cwd: string, sha: string): CommitInfo {
  const r = git(cwd, ["log", "-1", "--format=%H%x00%cI%x00%s", sha]);
  const [full, date, subject] = r.stdout.split("\u0000");
  return { sha: full ?? sha, date: date ?? "", subject: subject ?? "" };
}

/**
 * Resolve `good..bad` to an ordered commit list.
 *
 * A binary search assumes the list is monotone: everything before the
 * introducing commit passes, everything after fails. That holds on a linear
 * range; across merges it does not, which is why a range containing merges is
 * followed along first-parent — the mainline, where the assumption is true.
 */
export function commitRange(
  cwd: string,
  good: string,
  bad: string
): { commits: CommitInfo[]; firstParent: boolean } {
  const goodSha = git(cwd, ["rev-parse", good]);
  if (goodSha.status !== 0) throw new Error(`bad ref: ${good}`);
  const badSha = git(cwd, ["rev-parse", bad]);
  if (badSha.status !== 0) throw new Error(`bad ref: ${bad}`);

  if (git(cwd, ["merge-base", "--is-ancestor", goodSha.stdout, badSha.stdout]).status !== 0) {
    throw new Error(`${good} is not an ancestor of ${bad} — this needs a range, not two unrelated refs`);
  }

  const merges = git(cwd, ["rev-list", "--merges", `${goodSha.stdout}..${badSha.stdout}`]);
  const firstParent = merges.status === 0 && merges.stdout !== "";

  const args = ["rev-list", "--reverse"];
  if (firstParent) args.push("--first-parent");
  args.push("--format=%H%x00%cI%x00%s", `${goodSha.stdout}..${badSha.stdout}`);
  const list = git(cwd, args);
  if (list.status !== 0 || list.stdout === "") {
    throw new Error(`no commits between ${good} and ${bad}`);
  }

  // `rev-list --format` emits a "commit <sha>" header line before each entry.
  const commits: CommitInfo[] = [];
  for (const line of list.stdout.split("\n")) {
    if (line.startsWith("commit ")) continue;
    const [sha, date, subject] = line.split("\u0000");
    if (sha) commits.push({ sha, date: date ?? "", subject: subject ?? "" });
  }
  return { commits, firstParent };
}
