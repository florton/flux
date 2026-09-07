import { spawn, spawnSync, SpawnOptions } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { NA_EXIT_CODE, type CheckOutcome } from "./types";
import { substituteArgv, substituteShell } from "./substitution";

export interface RunOptions {
  cwd: string;
  timeoutMs?: number;
  /** Run the command through a shell. Opt-in per subject; see `tokenize`. */
  shell?: boolean;
  /** Value for `{test}` substitution and the RATCHET_TEST env var. */
  testName?: string;
  /**
   * The ratchet home, for `{home}` substitution and the RATCHET_HOME env var.
   *
   * This is what lets an instrument live outside the tree it measures. During
   * replay the home is carried out of the working tree, so a check written as
   * `node {home}/tools/probe.js` runs the *same* script at every commit
   * instead of whatever that commit happened to contain — which is what makes
   * readings across history comparable by construction rather than by hope.
   */
  homeDir?: string;
  /**
   * The ratchet's own install directory, for `{ratchet}` substitution and the
   * RATCHET_BIN env var. This is how a prose heuristic reaches the bundled
   * probe: the probe is the ratchet's binary, not the project's, so it is
   * outside the measured tree by construction and replay carries it across
   * history for free. Defaults to the running build.
   */
  ratchetBin?: string;
  /**
   * The repository root, exported as RATCHET_PROJECT_ROOT. A check spawned in
   * a worktree needs to know which tree it is measuring; `cwd` already says
   * so, but the bundled probe re-spawns and must not lose it.
   */
  projectRoot?: string;
}

export interface RunResult {
  outcome: CheckOutcome;
  /** True only when the check passed. */
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

interface Invocation {
  exe: string;
  args: string[];
  options: SpawnOptions & { input: string };
}

function fail(reason: string): RunResult {
  return { outcome: "fail", pass: false, reason, code: null, errored: true };
}

/** Build the spawn call, or return the RunResult that explains why we cannot. */
function invocation(command: string, input: unknown, opts: RunOptions): Invocation | RunResult {
  const env = { ...process.env };
  if (opts.testName !== undefined) env.RATCHET_TEST = opts.testName;
  if (opts.homeDir !== undefined) env.RATCHET_HOME = opts.homeDir;
  const ratchetBin = opts.ratchetBin ?? __dirname;
  env.RATCHET_BIN = ratchetBin;
  env.RATCHET_PROJECT_ROOT = opts.projectRoot ?? opts.cwd;

  const options = {
    cwd: opts.cwd,
    input: JSON.stringify(input) ?? "null",
    env,
    timeout: opts.timeoutMs ?? 30_000,
  };

  if (opts.shell) {
    // The command string is the project's own committed config, at the same
    // trust level as a Makefile target. The test name is NOT interpolated
    // into it — it reaches the check through RATCHET_TEST only, because a
    // test name comes from a test file and can contain anything.
    if (command.includes("{test}")) {
      return fail('{test} substitution is not available with "shell": true — read RATCHET_TEST instead');
    }
    // {home} and {ratchet} are different: they are paths the ratchet computes
    // itself, and substituting them is the whole frozen-instrument mechanism.
    // Without this, a `--setup` script written as `node {home}/tools/build.js`
    // is looked for inside the worktree, where a script added last month does
    // not exist at a commit from last year.
    const substituted = substituteShell(command, { home: opts.homeDir, ratchet: ratchetBin });
    if ("error" in substituted) return fail(substituted.error);
    return { exe: substituted.command, args: [], options: { ...options, shell: true } };
  }

  let argv: string[];
  try {
    argv = tokenize(command);
  } catch (err) {
    return fail(String(err));
  }
  if (argv.length === 0) return fail("empty check command");

  // Whole-token substitution: a substituted value becomes exactly one argv
  // element and can never split into extra arguments or shell syntax.
  if (opts.testName !== undefined) {
    argv = argv.map((t) => (t.includes("{test}") ? t.split("{test}").join(opts.testName!) : t));
  }
  argv = substituteArgv(argv, { home: opts.homeDir, ratchet: ratchetBin });
  const exe = resolveExecutable(argv[0], opts.cwd);
  if (/\.(cmd|bat)$/i.test(exe)) {
    return fail(
      `${argv[0]} resolves to a ${path.extname(exe)} script, which cannot be spawned directly — set "shell": true for this subject`
    );
  }
  return { exe, args: argv.slice(1), options: { ...options, shell: false } };
}

function interpret(status: number | null, signal: string | null, stdout: string, stderr: string): RunResult {
  if (status === null) {
    return { outcome: "fail", pass: false, reason: `killed: ${signal ?? "timeout"}`, code: null, errored: true };
  }
  const out = stdout.trim();
  const err = stderr.trim();
  if (status === NA_EXIT_CODE) {
    return { outcome: "na", pass: false, reason: out || err || "not applicable at this commit", code: status, errored: false };
  }
  const pass = status === 0;
  return {
    outcome: pass ? "pass" : "fail",
    pass,
    reason: pass ? out : out || err || `exit ${status}`,
    code: status,
    errored: false,
  };
}

export function runCheck(command: string, input: unknown, opts: RunOptions): RunResult {
  const inv = invocation(command, input, opts);
  if ("outcome" in inv) return inv;

  const result = spawnSync(inv.exe, inv.args, { ...inv.options, encoding: "utf8" });
  if (result.error) {
    return { outcome: "fail", pass: false, reason: result.error.message, code: null, errored: true };
  }
  return interpret(result.status, result.signal, result.stdout ?? "", result.stderr ?? "");
}

export function runCheckAsync(command: string, input: unknown, opts: RunOptions): Promise<RunResult> {
  const inv = invocation(command, input, opts);
  if ("outcome" in inv) return Promise.resolve(inv);

  return new Promise((resolve) => {
    const { input: stdin, timeout, ...spawnOpts } = inv.options;
    const child = spawn(inv.exe, inv.args, { ...spawnOpts, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({ outcome: "fail", pass: false, reason: `killed: timeout after ${timeout}ms`, code: null, errored: true });
    }, timeout as number);

    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", (err) =>
      finish({ outcome: "fail", pass: false, reason: err.message, code: null, errored: true })
    );
    child.on("close", (code, signal) => finish(interpret(code, signal, stdout, stderr)));

    child.stdin?.on("error", () => {
      /* a check that never reads stdin is fine */
    });
    child.stdin?.end(stdin);
  });
}

/** Run `tasks` with bounded concurrency, preserving input order in the result. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}
