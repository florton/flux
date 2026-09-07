/**
 * Where prose heuristics meet the rest of the ratchet.
 *
 * A parsed heuristic is compiled into an ordinary `SubjectConfig` whose check
 * is the bundled probe. Everything downstream — verify, capture, replay,
 * bisect, validate, quarantine, the worktree machinery — then works on prose
 * subjects with no changes at all, because from their side there is no
 * difference between a heuristic and a hand-written script.
 *
 * The scripted form stays as the base case, exactly as an executable property
 * test stays the base case beside a prose rule: arbitrary computation needs a
 * host language, and pretending otherwise would push people to contort prose
 * around problems it was not meant to hold.
 */
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import {
  parseHeuristics, formatProblem,
  type Heuristic, type ParseProblem,
} from "./heuristics";
import type { RatchetConfig, SubjectConfig } from "./types";

export const RULES_FILE = "heuristics.rules";

export interface LoadedHeuristics {
  heuristics: Heuristic[];
  problems: ParseProblem[];
  /** Comments in a file that declares no heuristic. */
  preamble: string[];
  /** Absolute path of the rules file, whether or not it exists. */
  file: string;
  exists: boolean;
}

export function rulesPath(ratchetDir: string): string {
  return path.join(ratchetDir, RULES_FILE);
}

export function loadHeuristics(ratchetDir: string): LoadedHeuristics {
  const file = rulesPath(ratchetDir);
  if (!fs.existsSync(file)) return { heuristics: [], problems: [], preamble: [], file, exists: false };
  const source = fs.readFileSync(file, "utf8");
  const { heuristics, problems, preamble } = parseHeuristics(source);
  return { heuristics, problems, preamble, file, exists: true };
}

/** The directory holding the ratchet's own compiled probe. */
export function ratchetBinDir(): string {
  return __dirname;
}

/** Compile one heuristic into the subject config the rest of the tool runs. */
export function toSubject(h: Heuristic): SubjectConfig {
  return {
    // {ratchet} resolves to the ratchet's own install directory, which lives
    // outside the tree being measured — so replay carries the probe across
    // history the same way {home} carries a project's own instrument.
    check: `node {ratchet}/probe.js ${h.name}`,
    owns: h.owns.length ? h.owns : undefined,
    timeoutMs: h.timeoutMs,
    heuristic: h,
  };
}

export interface MergedConfig extends RatchetConfig {
  /** Names that came from the rules file rather than config.json. */
  fromRules: Set<string>;
  problems: ParseProblem[];
  rulesFile: string;
  rulesExists: boolean;
  /** Subjects declared in both places — config.json wins, loudly. */
  collisions: string[];
}

/**
 * Read config.json and heuristics.rules into one subject map.
 *
 * A name declared in both is a genuine ambiguity, so it is reported rather
 * than silently resolved; config.json wins so that an existing project's
 * behavior never changes underneath it when a rules file appears.
 */
export function mergeConfig(config: RatchetConfig, loaded: LoadedHeuristics): MergedConfig {
  const subjects: Record<string, SubjectConfig> = { ...config.subjects };
  const fromRules = new Set<string>();
  const collisions: string[] = [];

  for (const h of loaded.heuristics) {
    if (Object.prototype.hasOwnProperty.call(config.subjects, h.name)) {
      collisions.push(h.name);
      continue;
    }
    subjects[h.name] = toSubject(h);
    fromRules.add(h.name);
  }

  return {
    ...config,
    subjects,
    fromRules,
    problems: loaded.problems,
    rulesFile: loaded.file,
    rulesExists: loaded.exists,
    collisions,
  };
}

/**
 * The message a command prints when the rules file will not parse.
 *
 * Refusing is the only safe answer: a heuristic whose clause did not parse is
 * a heuristic that is not enforcing, and a tool whose whole value is "the
 * check keeps running" must never let one quietly stop.
 */
export function formatProblems(file: string, problems: ParseProblem[]): string {
  const rel = path.basename(file);
  const body = problems.map((p) => formatProblem(rel, p)).join("\n\n");
  return (
    `${problems.length} problem${problems.length === 1 ? "" : "s"} in ${file}:\n\n${body}\n\n` +
    `Nothing was checked. Fix the lines above, or run \`ratchet fmt\` to snap loose wording to the vocabulary.`
  );
}
