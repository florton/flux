import * as fs from "fs";
import * as path from "path";

/**
 * Evidence that work overlapped, instead of a stopwatch.
 *
 * A test that proves concurrency by timing a parallel run against a serial one
 * is measuring the machine, not the code. Node's test runner executes test
 * files in parallel, so the parallel run competes with the rest of the suite
 * for the same cores; the ratio drifts with load and the assertion fails on a
 * tree nobody touched. That is what `replay --jobs probes commits on parallel
 * worktrees` did — green in isolation, red about one whole-suite run in three,
 * and red through `ratchet guard`, since the suite is this repository's own
 * standing invariant.
 *
 * The property those tests exist to defend is not "parallel is faster". It is
 * "the pool dispatched more than one task at a time, bounded by the limit, and
 * put the answers back in input order". Overlap is a fact about a run: each
 * probe records the interval it occupied, and two intervals that intersect
 * could only have been produced by two probes running at once. A slow machine
 * cannot make that false — it can only make the intervals longer.
 *
 * The window is a real sleep because these probes are real spawned processes.
 * Where the unit under test is a promise pool rather than a process, prefer
 * hand-resolved promises and assert the saturation directly: no clock at all.
 */

/**
 * A JavaScript fragment for a scratch project's `check.js`. It occupies a
 * window of `delayMs`, then records that window and the directory it ran in.
 *
 * It declares no bindings its host might already have — `fs` in particular is
 * required inline, because both scratch checks that use this already have a
 * `const fs` of their own in the same scope.
 */
export function recorderBody(logDir: string, delayMs: number): string {
  return [
    "const __start = Date.now();",
    `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${delayMs});`,
    "require(\"fs\").writeFileSync(",
    `  require("path").join(${JSON.stringify(logDir)},`,
    '    process.pid + "-" + __start + "-" + Math.random().toString(36).slice(2) + ".json"),',
    '  JSON.stringify({ cwd: process.cwd(), start: __start, end: Date.now() }));',
  ].join("\n");
}

export interface Probe {
  cwd: string;
  start: number;
  end: number;
}

/** Every window recorded into `logDir`, in no particular order. */
export function probes(logDir: string): Probe[] {
  return fs
    .readdirSync(logDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(logDir, f), "utf8")) as Probe);
}

/**
 * The largest number of probes in flight at once.
 *
 * Ends are ordered before starts at an equal timestamp, so two windows that
 * merely touch do not count as an overlap. `Date.now()` is coarse on Windows,
 * and the error should fall toward reporting less concurrency than happened,
 * never more.
 */
export function maxOverlap(logDir: string): number {
  const events: { at: number; delta: number }[] = [];
  for (const p of probes(logDir)) {
    events.push({ at: p.start, delta: 1 });
    events.push({ at: p.end, delta: -1 });
  }
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);

  let live = 0;
  let most = 0;
  for (const e of events) {
    live += e.delta;
    if (live > most) most = live;
  }
  return most;
}
