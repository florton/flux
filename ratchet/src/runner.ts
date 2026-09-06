import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface RunOptions {
  cwd: string;
  timeoutMs?: number;
  /** Run the command through a shell. Opt-in per subject; see `tokenize`. */
  shell?: boolean;
  /** Value for `{test}` substitution and the RATCHET_TEST env var. */
  testName?: string;
}

export interface RunResult {
  pass: boolean;
  reason: string;
  /** Exit status, or null when the process was killed or never started. */
  code: number | null;
  /** True when the check could not be run at all (spawn failure, timeout). */
  errored: boolean;
}

/**
 * Split a configured check command into argv.
 *
 * Single and double quotes group tokens and are stripped; backslash is a
 * literal character, so Windows paths survive unescaped. There is no
 * expansion of any kind — that is the point. A subject that needs pipes,
 * redirection, `&&`, or a `.cmd`/`.bat` entry point sets `"shell": true`
 * in its config and gets the old behavior for its own committed command
 * string only.
 */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (cur !== "" || started) tokens.push(cur);
      cur = "";
      started = false;
      continue;
    }
    cur += ch;
  }
  if (quote) throw new Error(`unbalanced ${quote} quote in check command: ${command}`);
  if (cur !== "" || started) tokens.push(cur);
  return tokens;
}

/**
 * Resolve a bare command name against PATHEXT on Windows. Node will not do
 * this without a shell, so `check: "tsc"` would otherwise fail on win32.
 */
function resolveExecutable(cmd: string, cwd: string): string {
  if (process.platform !== "win32" || path.extname(cmd)) return cmd;
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const hasDir = cmd.includes("/") || cmd.includes("\\");
  const dirs = hasDir
    ? [path.resolve(cwd, path.dirname(cmd))]
    : (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const base = hasDir ? path.basename(cmd) : cmd;
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, base + ext);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return cmd;
}

export function runCheck(command: string, input: unknown, opts: RunOptions): RunResult {
  const env = { ...process.env };
  if (opts.testName !== undefined) env.RATCHET_TEST = opts.testName;

  const common = {
    cwd: opts.cwd,
    input: JSON.stringify(input) ?? "null",
    encoding: "utf8" as const,
    timeout: opts.timeoutMs ?? 30_000,
    env,
  };

  let result;
  if (opts.shell) {
    // The command string is the project's own committed config, at the same
    // trust level as a Makefile target. The test name is NOT interpolated
    // into it — it reaches the check through RATCHET_TEST only.
    if (command.includes("{test}")) {
      return {
        pass: false,
        reason: '{test} substitution is not available with "shell": true — read RATCHET_TEST instead',
        code: null,
        errored: true,
      };
    }
    result = spawnSync(command, { ...common, shell: true });
  } else {
    let argv: string[];
    try {
      argv = tokenize(command);
    } catch (err) {
      return { pass: false, reason: String(err), code: null, errored: true };
    }
    if (argv.length === 0) {
      return { pass: false, reason: "empty check command", code: null, errored: true };
    }
    // Whole-token substitution: the test name becomes exactly one argv
    // element and can never split into extra arguments or shell syntax.
    if (opts.testName !== undefined) {
      argv = argv.map((t) => (t.includes("{test}") ? t.split("{test}").join(opts.testName!) : t));
    }
    const exe = resolveExecutable(argv[0], opts.cwd);
    if (/\.(cmd|bat)$/i.test(exe)) {
      return {
        pass: false,
        reason: `${argv[0]} resolves to a ${path.extname(exe)} script, which cannot be spawned directly — set "shell": true for this subject`,
        code: null,
        errored: true,
      };
    }
    result = spawnSync(exe, argv.slice(1), { ...common, shell: false });
  }

  if (result.error) {
    return { pass: false, reason: result.error.message, code: null, errored: true };
  }
  if (result.status === null) {
    return { pass: false, reason: `killed: ${result.signal ?? "timeout"}`, code: null, errored: true };
  }
  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();
  const pass = result.status === 0;
  return {
    pass,
    reason: pass ? stdout : stdout || stderr || `exit ${result.status}`,
    code: result.status,
    errored: false,
  };
}
