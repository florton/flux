import * as os from "os";
import { after } from "node:test";
import { scratchRoot, tempDir as newTempDir, sweepStale, removeDir } from "../src/scratch";

/**
 * The scratch directory every test fixture is created under.
 *
 * Nine test files each defined their own `tmpDir()` calling
 * `mkdtempSync(path.join(os.tmpdir(), "ratchet-X-"))`, and almost none of them
 * ever removed the result. Every fixture was therefore a new sibling entry at
 * the top level of `%TEMP%` — 24,711 of them, ~65 per suite run — and the
 * Windows User Profile Service walks that directory during logon. That was
 * 102–134 s of logon on a machine with a 9–15 s boot, and the suite runs
 * repeatedly as this repository's own `test-suite` standing invariant.
 *
 * Two things fix it, and they are independent:
 *
 *   1. nesting — one run root at the top level, fixtures as its children, so a
 *      killed run leaks one entry instead of ~65;
 *   2. actually removing them — after the file's tests, on exit, and on signal.
 *
 * `SIGKILL` cannot be caught, which is why (1) has to hold on its own.
 *
 * Kept separate from `src/scratch.ts` because `after`, the `exit` hook and the
 * signal handlers are test-runner concerns: the shipped tool must not install
 * them.
 */

/**
 * Created at import, not on first use, so that a fixture directory can never
 * exist outside a root this process will sweep.
 */
const RUN_ROOT: string = scratchRoot();

const live: string[] = [];

/** Nested, and named by prefix so a leaked root is still readable in `%TEMP%`. */
export function tmpDir(prefix = "f-"): string {
  const dir = newTempDir(prefix, { dir: RUN_ROOT });
  live.push(dir);
  return dir;
}

export function runRoot(): string {
  return RUN_ROOT;
}

let swept = false;

/**
 * Idempotent on purpose: it runs from `after`, from `exit`, and from the signal
 * handlers, and whichever fires first must leave the others as no-ops rather
 * than as a second removal of the root they are running in.
 */
export function sweep(): void {
  if (swept) return;
  swept = true;
  if (process.env.RATCHET_KEEP_TMP) return;
  for (const dir of live) removeDir(dir);
  live.length = 0;
  removeDir(RUN_ROOT);
}

/**
 * Roots left by earlier killed runs, collected before this one makes its own.
 *
 * A killed suite run cannot run any teardown, so the only place its root can be
 * cleaned is the next run's startup. The 24-hour floor is what makes that safe
 * when several suite runs are alive at once.
 */
sweepStale({ keep: [RUN_ROOT] });

after(sweep);
process.on("exit", sweep);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    sweep();
    // 128 + signal number, the shell convention: an interrupted run must not
    // read as a passing one.
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

/** The run root is a child of this, and the guard has to know which one to check. */
export function scratchParent(): string {
  const override = process.env.RATCHET_TMPDIR;
  return override !== undefined && override !== "" ? override : os.tmpdir();
}

/** Re-exported so the guard tests the sweep the fixtures actually run. */
export { sweepStale };
