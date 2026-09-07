/**
 * A heuristic's history, read straight out of git.
 *
 * Updating a heuristic should be an ordinary text edit — open the file, change
 * the band, commit. That only works if the *consequences* of the edit are
 * legible afterwards, and the ratchet already routes them through quarantine:
 * a row pinned to the old rule hash stops enforcing until someone reaffirms or
 * accepts it.
 *
 * What was missing is the sentence. "rule fd59… became a3b1…" tells a reviewer
 * nothing; "the band moved from [-0.03, 0.015] to [-0.05, 0.02] in 9f53b4d2"
 * tells them everything. Since the heuristics live in a plain text file that
 * git already versions, no new ledger is needed: walk the file's commits,
 * parse each version, and hash the block. The audit trail is the repository.
 */
import * as path from "path";
import { spawnSync } from "child_process";
import { parseHeuristics, type Heuristic } from "./heuristics";
import { ruleHash } from "./rule";
import { toSubject, RULES_FILE } from "./heuristic-config";

export interface HeuristicVersion {
  sha: string;
  shortSha: string;
  date: string;
  /** The commit subject line — usually the reason the heuristic moved. */
  message: string;
  author: string;
  canonical: string;
  ruleHash: string;
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? "" };
}

/** The rules file's path relative to the repository root, in git's own form. */
export function rulesRelPath(cwd: string, ratchetDir: string): string {
  return path.relative(cwd, path.join(ratchetDir, RULES_FILE)).split("\\").join("/");
}

/**
 * Every distinct version of one heuristic, oldest first.
 *
 * Consecutive commits that left the block unchanged collapse into one entry,
 * so the result is the list of times this heuristic actually moved — not the
 * list of times somebody edited a different heuristic in the same file.
 */
export function heuristicVersions(cwd: string, ratchetDir: string, name: string): HeuristicVersion[] {
  const rel = rulesRelPath(cwd, ratchetDir);
  const log = git(cwd, ["log", "--follow", "--format=%H%x1f%h%x1f%aI%x1f%an%x1f%s", "--", rel]);
  if (!log.ok) return [];

  const out: HeuristicVersion[] = [];
  const commits = log.out.split("\n").filter((l) => l.trim() !== "");
  // git log is newest first; walk oldest first so "unchanged since" reads
  // forwards and the collapse below keeps the *introducing* commit.
  for (const line of commits.reverse()) {
    const [sha, shortSha, date, author, message] = line.split("\u001f");
    const show = git(cwd, ["show", `${sha}:${rel}`]);
    if (!show.ok) continue;
    const parsed = parseHeuristics(show.out);
    const h = parsed.heuristics.find((x) => x.name === name);
    if (!h) continue;
    const hash = ruleHash(name, toSubject(h), cwd);
    const last = out[out.length - 1];
    if (last && last.ruleHash === hash) continue;
    out.push({ sha, shortSha, date, author, message, canonical: h.canonical, ruleHash: hash });
  }
  return out;
}

/** The version of a heuristic whose rule hash is `hash`, if git still has it. */
export function versionByHash(versions: HeuristicVersion[], hash: string): HeuristicVersion | undefined {
  return versions.find((v) => v.ruleHash === hash);
}

/**
 * A line diff of two canonical blocks, in the plainest possible form.
 *
 * This is deliberately not a real diff algorithm: canonical blocks are a
 * handful of short lines, and "these lines went, these arrived" is what a
 * reviewer needs to decide whether the expectation still stands.
 */
export function diffCanonical(before: string, after: string): string[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const bSet = new Set(b);
  const aSet = new Set(a);
  const out: string[] = [];
  for (const line of a) if (!bSet.has(line)) out.push(`- ${line.trim()}`);
  for (const line of b) if (!aSet.has(line)) out.push(`+ ${line.trim()}`);
  return out;
}

/**
 * Explain, in the author's own words, why a row is quarantined.
 *
 * Returns undefined when git cannot supply the old version — a heuristic
 * edited but not yet committed, a shallow clone, a repository-less checkout.
 * The caller still has the hashes; this only ever adds information.
 */
export function explainRuleChange(
  cwd: string,
  ratchetDir: string,
  name: string,
  recordedHash: string,
  current: Heuristic
): string[] | undefined {
  const versions = heuristicVersions(cwd, ratchetDir, name);
  const old = versionByHash(versions, recordedHash);
  if (!old) return undefined;
  const lines = diffCanonical(old.canonical, current.canonical);
  if (lines.length === 0) return undefined;
  return [`the heuristic changed since this row was captured (${old.shortSha} "${old.message}"):`, ...lines];
}
