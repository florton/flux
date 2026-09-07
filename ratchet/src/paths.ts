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
    if (!base || typeof base !== "object" || typeof base.subjects !== "object" || base.subjects === null) {
      throw new Error(`${configPath} needs a top-level "subjects" object mapping subject names to checks`);
    }
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
