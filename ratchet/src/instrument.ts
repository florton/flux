/**
 * Where a check's instrument lives, and why that decides whether a reading
 * across history means anything.
 *
 * A check configured as `node tools/check.js` runs the *checked-out commit's*
 * copy of that script -- or, if the file is untracked, does not run at all in
 * a worktree. Both are silent at HEAD and wrong under `replay`, `adopt`,
 * `bisect` and `validate`, which is to say wrong exactly where the readings
 * are supposed to be comparable by construction.
 *
 * This is not hypothetical. The particles experiment pointed its config at
 * `tools/ratchet-check.cjs`, which is untracked, while its write-up listed
 * "Frozen instrument. The check script is pinned across every commit" as one
 * of three guards on instrument integrity. That was true of the other
 * repository and false of this one, and nothing said so, because in v0 the
 * history commands checked commits out in place and the distinction could not
 * bite. v0.4 moved history into worktrees and made it bite.
 *
 * The fix a project needs is one token: `node {home}/tools/check.js` reaches
 * the *carried* home, which replay copies out of the tree before it starts.
 */
import * as fs from "fs";
import * as path from "path";
import { tokenize } from "./runner";
import { SUBSTITUTION_TOKENS } from "./substitution";
import { git } from "./worktree";
import type { RatchetConfig } from "./types";

export interface InstrumentFinding {
  subject: string;
  /** The instrument path, as the command spells it. */
  instrument: string;
  /** Repo-relative, with forward slashes. */
  relative: string;
  /**
   * False only when git is available and does not track the file — in a
   * worktree it would then not exist at all. Where git cannot answer, the
   * milder claim is the honest one: the file is in the tree, and that is
   * already enough for the readings to drift.
   */
  tracked: boolean;
  detail: string;
  fix: string;
}

/**
 * Interpreters whose first non-flag argument is the program being run.
 *
 * For anything else, argv[0] is itself the executable. `npm run build` names
 * no instrument in the tree and produces no finding; `./tools/check.sh` does.
 */
const INTERPRETERS = new Set([
  "node", "nodejs", "deno", "bun", "ts-node", "tsx",
  "python", "python3", "py", "ruby", "perl", "php",
  "sh", "bash", "zsh", "pwsh", "powershell",
]);

/**
 * The path a command reaches its instrument through, if it names one.
 *
 * A *directory* argument is deliberately not an instrument: `node --test
 * ratchet/dist/test/` measures the tree it points at, and reading the
 * checked-out commit's tests is the whole point of that subject.
 */
export function instrumentPath(command: string, shell: boolean): string | undefined {
  let argv: string[];
  try {
    argv = tokenize(command);
  } catch {
    return undefined;
  }
  if (argv.length === 0) return undefined;
  const exe = path.basename(argv[0]).replace(/[.](exe|cmd|bat|ps1)$/i, "").toLowerCase();
  if (!INTERPRETERS.has(exe)) {
    // A bare name resolves on PATH, which is outside the tree by definition.
    return /[\\/]/.test(argv[0]) ? argv[0] : undefined;
  }
  // `sh -c "..."` puts a script *body* here, not a path; it will not resolve
  // to a file and so produces no finding either way.
  if (shell && (exe === "sh" || exe === "bash" || exe === "zsh")) return undefined;
  for (let i = 1; i < argv.length; i++) {
    if (!argv[i].startsWith("-")) return argv[i];
  }
  return undefined;
}

/**
 * Subjects whose instrument resolves inside the tree being measured.
 *
 * `cwd` is the project root. The tool already knows everything this needs --
 * the root, the check command, and whether the command reached its instrument
 * through a token -- so the only reason this went unsaid for four versions is
 * that nobody asked.
 */
export function instrumentsInsideTree(cwd: string, config: RatchetConfig): InstrumentFinding[] {
  const findings: InstrumentFinding[] = [];
  const insideGit = git(cwd, ["rev-parse", "--is-inside-work-tree"]).status === 0;
  for (const [subject, subj] of Object.entries(config.subjects)) {
    // For a prose heuristic the compiled check is `node {ratchet}/probe.js`,
    // which is outside the tree by construction; the instrument that matters
    // is the one the author wrote on the `run` line.
    const command = subj.heuristic?.run ?? subj.check;
    const shell = subj.heuristic ? subj.heuristic.shell : subj.shell === true;
    if (command === undefined) continue;
    if (SUBSTITUTION_TOKENS.some((t) => command.includes(t))) continue;

    const named = instrumentPath(command, shell);
    if (named === undefined) continue;

    const abs = path.resolve(cwd, named);
    const rel = path.relative(cwd, abs);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) continue;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      // A check pointing at a file that is not there is simply broken, and
      // `verify` says so in the words of the failure. Not this finding.
      continue;
    }
    if (stat.isDirectory()) continue;

    const relative = rel.split(path.sep).join("/");
    const tracked = !insideGit || git(cwd, ["ls-files", "--error-unmatch", "--", relative]).status === 0;
    findings.push({
      subject,
      instrument: named,
      relative,
      tracked,
      detail: tracked
        ? `"${subject}" measures the tree through ${relative}, which is inside that tree: ` +
          `across history it runs each commit's own copy of the instrument, so the readings are not comparable`
        : `"${subject}" measures the tree through ${relative}, which is inside that tree and untracked: ` +
          `in a worktree the file is simply absent, so replay, adopt, bisect and validate cannot run it at all`,
      fix:
        `move it under the ratchet home and reach it through the token, as in: ` +
        command.split(named).join("{home}/" + path.basename(named)),
    });
  }
  return findings;
}
