#!/usr/bin/env node
/**
 * The bundled probe — the instrument for every prose heuristic.
 *
 * `ratchet verify` runs each subject's check with an input on stdin and reads
 * pass/fail/n-a from the exit code. A prose heuristic compiles to
 *
 *     node {ratchet}/probe.js <name>
 *
 * and this file is that program: it loads the heuristic out of the carried
 * ratchet home, runs the declared command, reads the declared measures out of
 * what the command printed, and judges the declared rules. Exit 0 pass, 1
 * fail, 125 not-applicable — the same three outcomes as any other check, so
 * nothing downstream needs to know a heuristic is not a script.
 *
 * What it prints on failure is the point: the measured number, in the words
 * of the rule that rejected it. That string is the row's witness, so drift
 * detection and cause-preserving reduction work on prose heuristics exactly
 * as they do on hand-written ones.
 */
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { loadHeuristics, formatProblems, RULES_FILE } from "./heuristic-config";
import { evaluateHeuristic, type Observation } from "./evaluate";
import { tokenize } from "./runner";
import { NA_EXIT_CODE, type RatchetConfig } from "./types";
import { summarize, type Heuristic } from "./heuristics";

function out(msg: string, code: number): never {
  if (msg) console.log(msg);
  process.exit(code);
}
// Declarations, not arrow consts: only a declared `never` return narrows
// control flow, and every call below relies on that to keep the happy path
// free of non-null assertions.
function pass(m: string): never { return out(m, 0); }
function fail(m: string): never { return out(m, 1); }
function na(m: string): never { return out(m, NA_EXIT_CODE); }

function readStdin(): unknown {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    return null;
  }
  if (raw.trim() === "") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Run the heuristic's instrument and collect everything an extractor may look
 * at. A command that cannot be spawned at all is a hard failure, not an n/a:
 * that is indistinguishable from a broken config, and greening it would be
 * the exact false pass this tool exists to prevent.
 */
export function observe(
  h: Heuristic,
  cwd: string,
  input: unknown,
  extraEnv: Record<string, string>
): Observation | { spawnError: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };

  if (h.seed !== undefined) {
    env.RATCHET_SEED = String(h.seed);
    // Injected via NODE_OPTIONS so it reaches the instrument and everything
    // the instrument spawns.
    //
    // Forward slashes, always: Node's NODE_OPTIONS parser treats a backslash
    // as an escape, so a Windows path arrives as "C:Usersflux..." and the
    // preload fails with a module-not-found that has nothing to do with the
    // project. Node accepts forward slashes on win32.
    const preload = path.join(__dirname, "seed-preload.js").split("\\").join("/");
    if (!fs.existsSync(preload)) {
      return { spawnError: `the seeded-RNG preload is missing from this build (${preload}) — rebuild the ratchet, or drop the \`seed\` line` };
    }
    if (preload.includes(String.fromCharCode(34))) {
      // A quote in the path cannot be expressed in NODE_OPTIONS. Say so
      // rather than silently running unseeded, which would make the band
      // measure noise while still reporting a number.
      return { spawnError: `cannot seed: the ratchet is installed at a path containing a quote (${preload})` };
    }
    const q = String.fromCharCode(34);
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ? env.NODE_OPTIONS + " " : ""}--require ${q}${preload}${q}`;
  }
  env.RATCHET_INPUT = JSON.stringify(input ?? null);

  const command = h.run!;
  const options = {
    cwd,
    env,
    input: JSON.stringify(input ?? null),
    encoding: "utf8" as const,
    timeout: h.timeoutMs ?? 30_000,
    maxBuffer: 32 * 1024 * 1024,
  };

  type Spawned = { error?: Error; status?: number | null; signal?: string | null; stdout?: string; stderr?: string };
  let result: Spawned;
  if (h.shell) {
    result = spawnSync(command, [], { ...options, shell: true });
  } else {
    // Tokenized and spawned directly, exactly like a scripted subject: nothing
    // substituted into the command can become shell syntax.
    let argv: string[] = [];
    let tokenizeError: Error | undefined;
    try {
      argv = tokenize(command);
    } catch (err) {
      tokenizeError = err instanceof Error ? err : new Error(String(err));
    }
    if (tokenizeError) result = { error: tokenizeError };
    else if (argv.length === 0) result = { error: new Error("the `run` command is empty") };
    else result = spawnSync(argv[0], argv.slice(1), { ...options, shell: false });
  }

  if (result.error) {
    const msg = result.error.message;
    return {
      spawnError:
        /ENOENT/.test(msg)
          ? `could not run \`${command}\` (${msg.split("\n")[0]}) — check the command, or set \`shell yes\` if it needs a shell or is a .cmd/.bat`
          : `could not run \`${command}\`: ${msg.split("\n")[0]}`,
    };
  }
  if (result.status === null || result.status === undefined) {
    return { spawnError: `\`${command}\` did not finish within ${options.timeout}ms (${result.signal ?? "killed"}) — raise it with a \`timeout\` line` };
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.status };
}

function main(): void {
  const name = process.argv[2];
  if (!name) fail("usage: probe <heuristic-name> — this program is invoked by `ratchet verify`, not by hand");

  const home = process.env.RATCHET_HOME;
  if (!home) {
    fail("RATCHET_HOME is not set — the probe is invoked by the ratchet, which exports it");
  }
  const cwd = process.env.RATCHET_PROJECT_ROOT ?? process.cwd();

  const loaded = loadHeuristics(home!);
  if (!loaded.exists) {
    fail(`no ${RULES_FILE} in ${home} — heuristic "${name}" has nowhere to live`);
  }
  if (loaded.problems.length > 0) {
    fail(formatProblems(loaded.file, loaded.problems));
  }

  const h = loaded.heuristics.find((x) => x.name === name);
  if (!h) {
    const names = loaded.heuristics.map((x) => x.name);
    fail(
      `no heuristic named "${name}" in ${loaded.file}` +
        (names.length ? ` — it declares: ${names.join(", ")}` : " — the file declares none")
    );
  }

  // Declared applicability, checked before anything runs: an old commit that
  // predates the feature reports n/a instead of a failure, which is what
  // replay across history needs to stay honest.
  for (const rel of h!.appliesWhenExists) {
    if (!fs.existsSync(path.resolve(cwd, rel))) {
      na(`n/a: ${rel} does not exist here, and "${name}" applies only when it does`);
    }
  }

  const observed = observe(h!, cwd, readStdin(), {});
  if ("spawnError" in observed) fail(observed.spawnError);

  // The instrument's own exit code propagates n/a, so a `run` command can say
  // "this does not apply here" the same way any other check does.
  if (observed.exitCode === NA_EXIT_CODE) {
    na(`n/a: \`${h!.run}\` reported not-applicable${observed.stdout.trim() ? ` — ${observed.stdout.trim().split("\n")[0]}` : ""}`);
  }

  const measuresExit = h!.measures.some((m) => m.extractor.kind === "exit-code");
  if (observed.exitCode !== 0 && !measuresExit) {
    // Reading numbers out of a crashed command is reading noise. Unless the
    // heuristic explicitly measures the exit code, a nonzero one means the
    // instrument broke, and that is a different message than a failed rule.
    const detail = (observed.stderr.trim() || observed.stdout.trim() || "(no output)")
      .split(/\r?\n/).slice(0, 4).join(" | ").slice(0, 400);
    fail(
      `\`${h!.run}\` exited ${observed.exitCode} before any rule could be checked: ${detail}\n` +
        `    if a nonzero exit is expected here, measure it: \`measure status exit code\``
    );
  }

  const evaluation = evaluateHeuristic(h!, observed);
  if (evaluation.failure !== null) {
    fail(evaluation.failure + (h!.because ? `\n    because: ${h!.because}` : ""));
  }
  pass(evaluation.readings.length ? evaluation.readings.join(" ") : summarize(h!));
}

/** True when this module is the entry point rather than an import. */
if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.log(`probe crashed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
  }
}

export type { RatchetConfig };
