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
import { collectOwned } from "./rule";
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

/** The subset whose `-c` form takes a script body where a path would go. */
const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh"]);

/**
 * The parts of a shell command that each begin a new program.
 *
 * Splitting is quote-aware: the operator in `node -e "a && b"` is inside a
 * string, so that command is one segment. Grouping (`(...)`, `$(...)`),
 * redirection and a trailing `&` are not modelled — this reads far enough to
 * find the program names, not far enough to be a shell. Anything it fails to
 * split is read as a single segment, which is what it did before.
 */
export function shellSegments(command: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") { parts.push(cur); cur = ""; i++; continue; }
    if (ch === ";" || ch === "|" || ch === "\n") { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

/**
 * Every path a command reaches an instrument through, in order, deduplicated.
 *
 * A shell-mode check runs more than one program, and the instrument is not
 * always the first: `cd . && node tools/check.js` reaches into the measured
 * tree through its *second* command, and reading only `argv[0]` sees `cd` and
 * reports nothing. That was a missed warning on exactly the shape the check
 * exists to name.
 */
export function instrumentPaths(command: string, shell: boolean): string[] {
  const found: string[] = [];
  for (const segment of shell ? shellSegments(command) : [command]) {
    const one = instrumentInSegment(segment, shell);
    if (one !== undefined && !found.includes(one)) found.push(one);
  }
  return found;
}

/** The first instrument a command names, if it names one. */
export function instrumentPath(command: string, shell: boolean): string | undefined {
  return instrumentPaths(command, shell)[0];
}

/**
 * The path one command reaches its instrument through, if it names one.
 *
 * A *directory* argument is deliberately not an instrument: `node --test
 * ratchet/dist/test/` measures the tree it points at, and reading the
 * checked-out commit's tests is the whole point of that subject.
 */
function instrumentInSegment(command: string, shell: boolean): string | undefined {
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
  // `sh -c "..."` puts a script *body* in the next token, not a path, and it
  // will not resolve to a file either way. That is a reason to skip the `-c`
  // form, and it was being read as a reason to skip every invocation of a
  // shell -- so `bash tools/setup.sh`, which names a file in the measured tree
  // as plainly as `./tools/setup.sh` does, produced no finding.
  if (shell && SHELL_INTERPRETERS.has(exe) && argv.slice(1).some((a) => /^-[a-z]*c$/i.test(a))) {
    return undefined;
  }
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

    // Every instrument the command reaches, not just the first: a chained
    // check can name one program outside the tree and the next one inside it,
    // and each is its own finding with its own fix.
    for (const named of instrumentPaths(command, shell)) {
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
            `across history it runs each commit's own copy of the instrument, so the readings are not comparable. ` +
            `Silent at HEAD — it bites only under replay, adopt, bisect and validate`
          : `"${subject}" measures the tree through ${relative}, which is inside that tree and untracked: ` +
            `in a worktree the file is simply absent, so replay, adopt, bisect and validate cannot run it at all`,
        fix:
          `move it under the ratchet home and reach it through the token, as in: ` +
          command.split(named).join("{home}/" + path.basename(named)),
      });
    }
  }
  return findings;
}

export interface UnownedFinding {
  subject: string;
  /** The instrument path, as the command spells it. */
  instrument: string;
  /** Repo-relative, with forward slashes — what an `owns` entry would say. */
  relative: string;
  detail: string;
  fix: string;
}

/**
 * Subjects whose frozen instrument is not part of their rule's identity.
 *
 * `owns` is what makes the accept ceremony safe: the rule hash is the check
 * command plus the contents of the files the subject declares it owns, so
 * editing the measuring script quarantines the rows it produced instead of
 * silently re-pointing them at a different measurement. Without it only the
 * command string is hashed, and `node {home}/tools/check.js` is the same
 * string whatever that file now contains.
 *
 * `rule.ts` said "`ratchet fsck` says so" for four versions and fsck said
 * nothing — the word `owns` appeared in neither fsck nor guard. Reproduced
 * against a scratch project: a row armed by `adopt` from a real regression,
 * the bug still in the tree, the un-owned instrument rewritten to
 * `process.exit(0)` — `0/1 rows pass` became `1/1 rows pass`, with no
 * quarantine, no warning, and the validation still on the books.
 *
 * Only `{home}`-rooted instruments are considered. One inside the tree is a
 * worse problem with its own finding, and one on PATH is not a file this
 * repository can own.
 */
export function unownedInstruments(cwd: string, ratchetHome: string, config: RatchetConfig): UnownedFinding[] {
  const findings: UnownedFinding[] = [];
  for (const [subject, subj] of Object.entries(config.subjects)) {
    const command = subj.heuristic?.run ?? subj.check;
    const shell = subj.heuristic ? subj.heuristic.shell : subj.shell === true;
    if (command === undefined) continue;

    const owned = new Set(
      collectOwned(subj.owns ?? [], cwd).map((p) => p.split(path.sep).join("/"))
    );
    for (const named of instrumentPaths(command, shell)) {
      if (!named.includes("{home}")) continue;
      const abs = path.resolve(named.split("{home}").join(ratchetHome));
      // A path that does not resolve to a file is `verify`'s problem to
      // report, in the words of the failure. Not this finding.
      try {
        if (!fs.statSync(abs).isFile()) continue;
      } catch {
        continue;
      }
      const rel = path.relative(cwd, abs);
      if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) continue;
      const relative = rel.split(path.sep).join("/");
      if (owned.has(relative)) continue;

      findings.push({
        subject,
        instrument: named,
        relative,
        detail:
          `"${subject}" measures through ${relative} and does not declare it in \`owns\`, so the instrument's ` +
          `contents are not part of the rule hash: rewriting it re-points every row that subject armed, with no ` +
          `quarantine and no warning`,
        fix: subj.heuristic
          ? `add a line to the heuristic block:  owns     ${relative}`
          : `add it to the subject in config.json:  "owns": ["${relative}"]`,
      });
    }
  }
  return findings;
}
