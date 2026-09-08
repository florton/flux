import * as fs from "fs";
import * as path from "path";
import type { RatchetConfig } from "./types";
import { loadHeuristics, mergeConfig, formatProblems, type MergedConfig } from "./heuristic-config";

export function findRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".ratchet"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function ratchetDir(root: string, home?: string): string {
  return home ?? path.join(root, ".ratchet");
}

export function loadConfig(dir: string): RatchetConfig {
  const raw = fs.readFileSync(path.join(dir, "config.json"), "utf8");
  return JSON.parse(raw) as RatchetConfig;
}

/**
 * A subject's shape, checked where it is loaded rather than where it is spawned.
 *
 * `check: string` is a promise the type system makes and JSON does not keep. A
 * config.json subject with no `check` reached `tokenize(command)` and died with
 * `TypeError: command is not iterable` — and under `validate` that crash was
 * reported as the check *failing as required* at the known-bad commit, because
 * an instrument that cannot run fails everywhere, which is indistinguishable
 * from discriminating perfectly until you read the message.
 *
 * `owns` written as a bare string was worse than a crash. A string is iterable,
 * so it was walked one character at a time and the owning-rule hash went
 * scanning directories with nothing to do with the repository. A shape error in
 * a config file should not be able to send a hash walking the filesystem.
 *
 * Problems are collected rather than raised one at a time, for the reason the
 * rules file collects them: someone fixing a config wants the list, not a
 * conversation. Every message names the subject, the key, and the shape it
 * should have.
 */
function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  if (typeof v === "number") return `${v}`;
  return `a ${typeof v}`;
}

export function subjectProblems(subjects: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const name of Object.keys(subjects)) {
    const at = `subjects.${JSON.stringify(name)}`;
    const subj = subjects[name];
    if (subj === null || typeof subj !== "object" || Array.isArray(subj)) {
      problems.push(`${at} is ${describe(subj)}; a subject is an object, as in { "check": "node tools/check.js" }`);
      continue;
    }
    const s = subj as Record<string, unknown>;

    if (s.check === undefined) {
      // Naming the near-miss key is the whole difference between a message
      // that ends the search and one that starts it.
      const near = ["command", "cmd", "run", "script"].filter((k) => s[k] !== undefined);
      problems.push(
        `${at}.check is missing; a subject needs the command that measures it, as in "check": "node tools/check.js"` +
          (near.length > 0 ? ` — this subject has ${near.map((k) => `"${k}"`).join(" and ")}, which nothing reads` : "")
      );
    } else if (typeof s.check !== "string") {
      problems.push(`${at}.check is ${describe(s.check)}; it must be the command to run, as one string`);
    } else if (s.check.trim() === "") {
      problems.push(`${at}.check is blank; it must be the command that measures this subject`);
    }

    if (s.owns !== undefined) {
      if (!Array.isArray(s.owns)) {
        problems.push(
          `${at}.owns is ${describe(s.owns)}; it must be an array of paths, as in "owns": [".ratchet/tools/check.js"]` +
            ` — a bare string is walked one character at a time`
        );
      } else {
        s.owns.forEach((p, i) => {
          if (typeof p !== "string") {
            problems.push(`${at}.owns[${i}] is ${describe(p)}; every entry must be a path relative to the repository root`);
          } else if (p.trim() === "") {
            problems.push(`${at}.owns[${i}] is blank; every entry must be a path relative to the repository root`);
          }
        });
      }
    }

    if (
      s.timeoutMs !== undefined &&
      (typeof s.timeoutMs !== "number" || !Number.isFinite(s.timeoutMs) || s.timeoutMs <= 0)
    ) {
      problems.push(`${at}.timeoutMs is ${describe(s.timeoutMs)}; it must be a positive number of milliseconds`);
    }
    if (s.shell !== undefined && typeof s.shell !== "boolean") {
      problems.push(`${at}.shell is ${describe(s.shell)}; it must be true or false`);
    }
    if (s.captureProperty !== undefined && typeof s.captureProperty !== "string") {
      problems.push(`${at}.captureProperty is ${describe(s.captureProperty)}; it must be the fast-check property name, as a string`);
    }
  }
  return problems;
}

export function formatConfigProblems(file: string, problems: string[]): string {
  return (
    `${problems.length} problem${problems.length === 1 ? "" : "s"} in ${file}:\n\n` +
    problems.map((p) => `  ${p}`).join("\n") +
    `\n\nNothing was checked. A subject that cannot run is a check that has stopped enforcing.`
  );
}

/**
 * The one place subjects come from: scripted ones in config.json, prose ones
 * in heuristics.rules, merged into a single map.
 *
 * A rules file that will not parse is a hard error here, for every caller.
 * The alternative — carrying on with the heuristics that happened to parse —
 * would mean a mistyped clause silently stops enforcing while the build stays
 * green, which is the one failure mode this tool cannot afford.
 */
export function loadSubjects(ratchetDirPath: string): MergedConfig {
  const configPath = path.join(ratchetDirPath, "config.json");
  const loaded = loadHeuristics(ratchetDirPath);

  let base: RatchetConfig = { subjects: {} };
  if (fs.existsSync(configPath)) {
    let raw: string;
    try {
      raw = fs.readFileSync(configPath, "utf8");
    } catch (err) {
      throw new Error(`cannot read ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      base = JSON.parse(raw) as RatchetConfig;
    } catch (err) {
      throw new Error(`${configPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (
      !base ||
      typeof base !== "object" ||
      typeof base.subjects !== "object" ||
      base.subjects === null ||
      Array.isArray(base.subjects)
    ) {
      throw new Error(`${configPath} needs a top-level "subjects" object mapping subject names to checks`);
    }
    // Refuse a malformed subject here, where the file is named and every
    // command passes through, rather than letting it reach the spawn site as
    // an internal TypeError with the config nowhere in the message.
    const shape = subjectProblems(base.subjects as unknown as Record<string, unknown>);
    if (shape.length > 0) throw new Error(formatConfigProblems(configPath, shape));
  } else if (!loaded.exists) {
    throw new Error(
      `no .ratchet/config.json found in ${ratchetDirPath} — run \`ratchet init\` first`
    );
  }

  if (loaded.problems.length > 0) {
    throw new Error(formatProblems(loaded.file, loaded.problems));
  }
  return mergeConfig(base, loaded);
}
