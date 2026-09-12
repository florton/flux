import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Scratch space, owned per run instead of per fixture.
 *
 * Every fixture used to call `mkdtempSync(path.join(os.tmpdir(), "ratchet-X-"))`
 * and almost none of them were ever removed. On Linux and macOS that is just a
 * stale directory; on Windows `os.tmpdir()` is `%LOCALAPPDATA%\Temp`, and the
 * Windows User Profile Service enumerates that directory during the logon
 * notification. So N leaked fixtures meant N more entries at the top level of
 * `%TEMP%`, and each one was ~linear logon cost: 24,711 leaked `ratchet-*`
 * directories turned a healthy logon into 102–134 s.
 * (microsoft/Windows-Dev-Performance#92.)
 *
 * The fixture directories were never the hazard — the *unbounded sibling count
 * inside `%TEMP%`* was. So scratch is nested now: one run root at the top
 * level, every fixture a child of it. A run that is `SIGKILL`ed, or that dies
 * in a timeout, leaks exactly one searchable entry instead of ~65, and the
 * stale root is collected by age on the next run.
 *
 * Three mechanisms, and each covers what the others cannot:
 *
 *   1. `disposeScratch` on `exit` and on `SIGINT`/`SIGTERM` — the ordinary
 *      path, which is almost every run;
 *   2. nesting — a run that `SIGKILL`s, or dies in a build timeout, can run no
 *      teardown, but leaks one entry rather than one per fixture;
 *   3. `sweepStale` — collects those roots by age on the next long command, so
 *      the damage from (2) does not accumulate.
 *
 * (1) is not optional and was missing at first: without it every `guard` and
 * `verify` left a fresh empty root behind, since nothing else removes the root
 * a process creates. Nesting alone made each leak smaller, not absent.
 *
 * `RATCHET_TMPDIR` moves the whole run root off the user profile, which is how
 * you decouple scratch from logon entirely on Windows.
 */

/**
 * The root every scratch directory in this process is created under.
 *
 * Created lazily so that importing this module is free and a caller that ends
 * up not needing scratch never pays for it.
 */
let runRoot: string | undefined;

/**
 * `RATCHET_TMPDIR` is read once and only as a parent directory: the run root is
 * still a fresh `mkdtemp` under it, so two concurrent runs can never share
 * one, and an override can never be mistaken for scratch this process owns.
 */
function parentDir(): string {
  const override = process.env.RATCHET_TMPDIR;
  const base = override !== undefined && override !== "" ? override : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return base;
}

export function scratchRoot(): string {
  if (runRoot === undefined) {
    runRoot = fs.mkdtempSync(path.join(parentDir(), "ratchet-"));
    installTeardown();
  }
  return runRoot;
}

/**
 * Remove this process's scratch root.
 *
 * Nesting bounds a killed run to *one* top-level entry, but bounding is not
 * removing: without this, every `guard` or `verify` left a fresh empty
 * `%TEMP%\ratchet-*` behind — 13 of them per invocation, one per process — and
 * the only thing that ever collected them was `sweepStale` a day later. That is
 * the same leak this module exists to close, one order of magnitude smaller,
 * and it lands on the commands that run most often.
 *
 * Idempotent and silent on failure, for the same reason `removeDir` is: this
 * runs from an exit handler, and cleanup must never be what a run reports.
 */
export function disposeScratch(): void {
  const root = runRoot;
  runRoot = undefined;
  if (root !== undefined) removeDir(root);
}

let teardownInstalled = false;

/**
 * Teardown for the root *this* process created.
 *
 * Installed lazily, when the first scratch directory is made, so importing this
 * module stays free and a process that never needed scratch installs nothing.
 *
 * `exit` covers every ordinary path, including a thrown error. The signals
 * cover Ctrl-C and CI cancellation and exit with `128 + signo`, the shell
 * convention, so an interrupted run cannot read as a passing one.
 *
 * Neither the signals nor anything else can cover a hard kill — `SIGKILL`, and
 * on Windows `Stop-Process`/`taskkill`, which no handler sees. That case is why
 * `sweepStale` exists: it is the only thing that collects an abandoned root,
 * which is also why nesting has to bound the damage on its own.
 *
 * `test/tmp.ts` installs its own handlers before this runs and removes the root
 * itself; both are idempotent, and after the test's `sweep()` this one finds
 * `runRoot` already cleared.
 */
function installTeardown(): void {
  if (teardownInstalled) return;
  teardownInstalled = true;
  process.on("exit", disposeScratch);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      disposeScratch();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

export interface TempDirOptions {
  /** The parent the directory is created in. Defaults to this run's root. */
  dir?: string;
}

/**
 * A fresh scratch directory.
 *
 * `prefix` used to name the top-level `%TEMP%` entry, which is why it must
 * still be passed: it is the only thing identifying a leaked directory to a
 * human reading `%TEMP%`. Nesting moves where it lives, not what it says.
 */
export function tempDir(prefix: string, opts: TempDirOptions = {}): string {
  return fs.mkdtempSync(path.join(opts.dir ?? scratchRoot(), prefix));
}

/** Windows keeps `node_modules` and git objects read-only; deletion needs retries. */
export const REMOVE_OPTS: fs.RmOptions = {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 100,
};

/**
 * Remove a scratch directory, whatever state it is in. Removal is best-effort
 * cleanup: a failure here must never be the reason a run reports failure.
 */
export function removeDir(dir: string): boolean {
  try {
    fs.rmSync(dir, REMOVE_OPTS);
    return true;
  } catch {
    return false;
  }
}

export interface SweepOptions {
  /** Defaults to `os.tmpdir()`, plus `RATCHET_TMPDIR` when it points elsewhere. */
  dirs?: string[];
  /** Only entries older than this are removed. Default: 24 hours. */
  olderThanMs?: number;
  /** Roots to leave alone — in particular, whatever the caller is using now. */
  keep?: string[];
  /** A clock, for tests. */
  now?: number;
  /** Called for each entry removed, so a caller can report what it collected. */
  onRemove?: (dir: string) => void;
}

/**
 * Collect scratch roots left behind by runs that never reached their teardown.
 *
 * `SIGKILL` and a hard timeout cannot be caught, which is exactly why the age
 * sweep exists: nesting bounds the damage to one entry per killed run, and this
 * is what stops those entries from accumulating. The age threshold is what
 * makes it safe to run at startup of a long command — a live concurrent run's
 * root is far too young to be collected.
 */
export function sweepStale(opts: SweepOptions = {}): string[] {
  const parents = opts.dirs ?? scanDirs();
  const now = opts.now ?? Date.now();
  const olderThanMs = opts.olderThanMs ?? 24 * 3600_000;
  const keep = new Set((opts.keep ?? []).map(canonical));
  const removed: string[] = [];

  for (const parent of parents) {
    let entries: string[];
    try {
      entries = fs.readdirSync(parent);
    } catch {
      continue;
    }
    for (const name of entries) {
      // The prefix is the contract: only scratch this tool created is ever
      // a deletion candidate, so nothing else in `%TEMP%` is at risk.
      if (!name.startsWith("ratchet-")) continue;
      const at = path.join(parent, name);
      if (keep.has(canonical(at))) continue;
      try {
        const stat = fs.statSync(at);
        if (!stat.isDirectory()) continue;
        if (now - stat.mtimeMs <= olderThanMs) continue;
        if (!removeDir(at)) continue;
      } catch {
        continue;
      }
      removed.push(at);
      opts.onRemove?.(at);
    }
  }
  return removed;
}

function scanDirs(): string[] {
  const dirs = [os.tmpdir()];
  const override = process.env.RATCHET_TMPDIR;
  if (override !== undefined && override !== "") dirs.push(override);
  return dirs;
}

/** `%TEMP%` and `C:\Temp` name the same directory differently on Windows. */
function canonical(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
