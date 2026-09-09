/**
 * Telling a measurement apart from a corpse.
 *
 * `validate` asks one question — did this check fail at a commit known to
 * carry the bug — and reads the answer off an exit code. But an instrument
 * that cannot *run* at a commit also exits nonzero there, and it does so at
 * every commit it cannot run at, which is shaped exactly like a check that
 * discriminates perfectly. R39 caught one road to that (a config typo reaching
 * the spawn site as a TypeError) and closed it by validating the config's
 * shape; the road stayed open for the ordinary case, which is a pinned
 * instrument replayed across history:
 *
 *     ✓ known-bad ed0195e8 — fails as required: Error: Cannot find module
 *                            '…/src/engine.js'
 *     ✓ known-good eb908d88 — passes as required
 *     validated — proof recorded in the journal
 *
 * That is a permanent top-tier proof earned by an instrument that never ran.
 * R39's own write-up says the outcome there was "right by accident… because
 * it also crashed on the other side"; when the missing file is one the *old*
 * tree lacks, there is no other side to crash on.
 *
 * So: recognize the corpse. What this cannot do is decide whether a crash is
 * the regression — a bug whose symptom is a stack trace is a perfectly good
 * known-bad — so it never decides. It refuses, shows what it saw, and routes
 * the judgment to a person, the same way a quarantine does.
 *
 * Scope, stated rather than implied: this reads the witness the runner kept,
 * which is stdout when there was any and stderr otherwise. An instrument that
 * prints diagnostics on stdout *and* dies leaves a witness that looks like a
 * reading, and this will not catch it. `errored` covers what the runner knows
 * for certain — a spawn that never started, a timeout kill.
 */
import type { RunResult } from "./runner";

export interface CrashWitness {
  /** Which signal fired. The message names it, so nothing is a black box. */
  kind: "spawn" | "probe" | "trace";
  /** What was recognized, in a phrase that finishes "it died with …". */
  detail: string;
}

/**
 * Shapes that are an uncaught exception in some language, never a reading.
 *
 * Deliberately narrow. A false positive here refuses a proof somebody is
 * entitled to, and the flag that overrides it is a claim they then have to
 * make in writing — so each pattern has to be something no check would print
 * on purpose.
 */
const TRACES: [RegExp, string][] = [
  [/^\s+at [^\s(]+ \(.*:\d+:\d+\)\s*$/m, "an uncaught exception (a stack frame)"],
  [/^\s+at .*:\d+:\d+\s*$/m, "an uncaught exception (a stack frame)"],
  [/Traceback \(most recent call last\)/, "an uncaught Python exception"],
  [/^Exception in thread |^\s+at [\w$.]+\([\w.]+:\d+\)\s*$/m, "an uncaught Java exception"],
  [/^panic: .*\n[\s\S]*^goroutine \d+ \[/m, "a Go panic"],
  [/^Unhandled exception\.|^Unhandled Exception:/m, "an unhandled .NET exception"],
  [/^\s*from .*\.rb:\d+:in [`']/m, "an uncaught Ruby exception"],
  [/Cannot find module|MODULE_NOT_FOUND/, "a module the instrument could not load"],
];

/**
 * Markers the bundled probe prints when the *heuristic's* instrument broke.
 *
 * A prose subject has this for free: `probe.js` already separates "the rules
 * rejected the reading" from "nothing was read", and says so in words. These
 * are those words, so a heuristic gets the sharper answer than the shape test
 * can give a script.
 */
const PROBE_MARKERS: [RegExp, string][] = [
  [/exited -?\d+ before any rule could be checked/, "the instrument exiting before any rule could be checked"],
  [/^probe crashed:/m, "a crash inside the probe itself"],
  [/RATCHET_HOME is not set/, "a probe invoked without its home"],
  [/^no heuristic named "/m, "a heuristic the rules file does not declare"],
  [/^no heuristics\.rules in /m, "a missing rules file"],
  [/Nothing was checked\. Fix the lines above/, "a rules file that would not parse"],
];

/**
 * What the run died of, or null when it looks like it measured something.
 *
 * Order matters only for the message: `errored` is the one the runner knows
 * for a fact, so it speaks first.
 */
export function crashWitness(run: RunResult): CrashWitness | null {
  if (run.outcome !== "fail") return null;
  if (run.errored) {
    return { kind: "spawn", detail: run.code === null ? `never started or was killed (${run.reason})` : run.reason };
  }
  const text = run.reason ?? "";
  for (const [re, detail] of PROBE_MARKERS) {
    if (re.test(text)) return { kind: "probe", detail };
  }
  for (const [re, detail] of TRACES) {
    if (re.test(text)) return { kind: "trace", detail };
  }
  return null;
}

/**
 * The paragraph a refusal prints.
 *
 * It teaches the mechanism that already exists rather than inventing one: a
 * check that cannot measure a commit is supposed to say so with 125 or 126,
 * and every history command already honors that. The override is spelled out
 * in full because typing it is the claim.
 */
export function crashAdvice(crash: CrashWitness, subject: string, ref: string): string[] {
  return [
    `the known-bad run did not measure anything: it died with ${crash.detail}.`,
    `  An instrument that cannot run at a commit fails there for a reason that has nothing`,
    `  to do with the code, and it fails that way at every commit it cannot run at — which`,
    `  is shaped exactly like a check that discriminates perfectly. Recording that as proof`,
    `  would prove the check can fail by breaking it.`,
    ``,
    `  Either:`,
    `    - exit 125 from the check when it cannot measure a commit ("not applicable"), or`,
    `      126 when this environment cannot run it there, and re-run against a ref where`,
    `      the instrument actually runs;`,
    `    - find one with:  ratchet replay --subjects --subject ${subject} --good <an-old-ref>`,
    `    - or, if the crash IS the regression, say so on the command line:`,
    `        ratchet validate ${subject} --known-bad ${ref} --crash-is-the-regression`,
  ];
}

/**
 * The one line of a corpse worth printing.
 *
 * The first line of a Node trace is the loader's own internal path, which
 * tells a reader nothing; the line that names the error is several down. Show
 * that one, and fall back to the first line that has anything on it.
 */
export function crashLine(reason: string): string {
  const lines = reason.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  const named = lines.find((l) => /^([A-Za-z_.]*(Error|Exception)\b|panic:|Traceback|Unhandled)/.test(l));
  return named ?? lines[0] ?? "";
}
