import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { verify } from "./verify";

function git(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

export function bisect(cwd: string, id: string, good: string, bad: string): string {
  const clean = git(cwd, ["status", "--porcelain"]);
  if (clean.stdout !== "") {
    throw new Error("working tree is not clean — commit or stash before bisecting");
  }

  const home = process.env.RATCHET_HOME ?? path.join(cwd, ".ratchet");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-bisect-"));
  const tempHome = path.join(tmp, ".ratchet");
  fs.cpSync(home, tempHome, { recursive: true });

  const goodSha = git(cwd, ["rev-parse", good]);
  if (goodSha.status !== 0) throw new Error(`bad --good ref: ${good}`);
  const badSha = git(cwd, ["rev-parse", bad]);
  if (badSha.status !== 0) throw new Error(`bad --bad ref: ${bad}`);

  const list = git(cwd, ["rev-list", "--reverse", `${goodSha.stdout}..${badSha.stdout}`]);
  if (list.status !== 0 || list.stdout === "") {
    throw new Error(`no commits between ${good} and ${bad}`);
  }
  const commits = list.stdout.split("\n");

  const originalHead = git(cwd, ["rev-parse", "HEAD"]).stdout;
  const branch = git(cwd, ["branch", "--show-current"]).stdout;
  const restore = branch !== "" ? branch : originalHead;

  const runTest = (sha: string): boolean => {
    const co = git(cwd, ["checkout", "--quiet", sha]);
    if (co.status !== 0) throw new Error(`checkout ${sha} failed: ${co.stderr}`);
    const results = verify(cwd, { row: id, quiet: true, ratchetHome: tempHome });
    const row = results.find((r) => r.id === id);
    if (!row) throw new Error(`row ${id} not found while verifying ${sha}`);
    return row.pass;
  };

  const badPasses = runTest(badSha.stdout);
  if (badPasses) {
    git(cwd, ["checkout", "--quiet", restore]);
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`row ${id} passes at ${bad} — --bad must be a failing commit`);
  }
  const goodPasses = runTest(goodSha.stdout);
  if (!goodPasses) {
    git(cwd, ["checkout", "--quiet", restore]);
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`row ${id} fails at ${good} — --good must be a passing commit`);
  }

  let lo = 0;
  let hi = commits.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (runTest(commits[mid])) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  const firstBad = commits[lo];
  git(cwd, ["checkout", "--quiet", restore]);
  fs.rmSync(tmp, { recursive: true, force: true });
  return firstBad;
}
