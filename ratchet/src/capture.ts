import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { appendEvent, readEvents, stableStringify } from "./corpus";
import { nextRowId } from "./paths";
import type { CorpusEvent, RatchetConfig } from "./types";
import { minimize } from "./shrink";
import { runCheck } from "./runner";

export interface CaptureReport {
  added: string[];
  skipped: string[];
}

interface FastCheckCapture {
  property: string;
  seed?: number;
  counterexample?: unknown[];
  error?: string;
}

interface SubjectBinding {
  subject: string;
  input: unknown;
  test?: string;
  seed?: string;
  reason?: string;
  source: "fast-check" | "junit" | "manual";
}

function currentCommit(cwd: string): string {
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd, encoding: "utf8" });
  return r.status === 0 ? (r.stdout ?? "").trim() : "";
}

function bindFastCheck(capture: FastCheckCapture, config: RatchetConfig): SubjectBinding[] {
  const out: SubjectBinding[] = [];
  for (const [subject, subj] of Object.entries(config.subjects)) {
    if (subj.captureProperty && subj.captureProperty === capture.property) {
      const cex = capture.counterexample ?? [];
      out.push({
        subject,
        input: cex.length === 1 ? cex[0] : cex,
        test: capture.property,
        seed: capture.seed !== undefined ? String(capture.seed) : undefined,
        reason: capture.error,
        source: "fast-check",
      });
    }
  }
  if (out.length === 0 && capture.property) {
    out.push({
      subject: capture.property,
      input: (capture.counterexample ?? []).length === 1 ? capture.counterexample![0] : (capture.counterexample ?? []),
      test: capture.property,
      seed: capture.seed !== undefined ? String(capture.seed) : undefined,
      reason: capture.error,
      source: "fast-check",
    });
  }
  return out;
}

function parseJUnit(filePath: string): SubjectBinding[] {
  const text = fs.readFileSync(filePath, "utf8");
  const out: SubjectBinding[] = [];
  const caseRe = /<testcase\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/testcase>/g;
  for (const m of text.matchAll(caseRe)) {
    const name = m[1];
    const body = m[2];
    const failRe = /<failure\b[^>]*message="([^"]*)"(?:\s*\/>|>[\s\S]*?<\/failure>)|<failure\b[^>]*>([\s\S]*?)<\/failure>/;
    const f = failRe.exec(body);
    if (f) {
      out.push({
        subject: name,
        input: null,
        test: name,
        reason: (f[1] ?? f[2] ?? "failed").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"),
        source: "junit",
      });
    }
  }
  return out;
}

function dedupKey(subject: string, input: unknown): string {
  return `${subject}|${stableStringify(input)}`;
}

export function capture(cwd: string, inputs: string[]): CaptureReport {
  const ratchetDir = process.env.RATCHET_HOME ?? path.join(cwd, ".ratchet");
  const configPath = path.join(ratchetDir, "config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error("no .ratchet/config.json found — run `ratchet init` first");
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as RatchetConfig;

  let bindings: SubjectBinding[] = [];
  for (const input of inputs) {
    if (!fs.existsSync(input)) {
      throw new Error(`capture input not found: ${input}`);
    }
    const text = fs.readFileSync(input, "utf8").trim();
    if (text.startsWith("<")) {
      bindings = bindings.concat(parseJUnit(input));
    } else {
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const cap of list) {
        bindings = bindings.concat(bindFastCheck(cap as FastCheckCapture, config));
      }
    }
  }

  const corpusPath = path.join(ratchetDir, "corpus.jsonl");
  const existing = new Set(readEvents(corpusPath).map((ev) => dedupKey(ev.subject, ev.input)));
  const commit = currentCommit(cwd);
  const report: CaptureReport = { added: [], skipped: [] };

  for (const b of bindings) {
    if (b.input === null) {
      const id = nextRowId(corpusPath);
      appendEvent(corpusPath, {
        op: "capture",
        id,
        at: new Date().toISOString(),
        subject: b.subject,
        input: null,
        reason: b.reason,
        test: b.test,
        commit,
        source: b.source,
      } as CorpusEvent);
      report.added.push(id);
      continue;
    }

    const checkCmd = config.subjects[b.subject]?.check;
    if (!checkCmd) {
      report.skipped.push(`${b.subject} (no check command configured)`);
      continue;
    }

    const reproduces = runCheck(checkCmd, b.input, { cwd });
    if (reproduces.pass) {
      report.skipped.push(`${b.subject} ${stableStringify(b.input)} (not reproducible — check passes now)`);
      continue;
    }

    let input: unknown = b.input;
    try {
      input = minimize(input, (candidate) => !runCheck(checkCmd, candidate, { cwd }).pass);
    } catch {
      // minimization failed or ran out — keep the original counterexample
    }

    const key = dedupKey(b.subject, input);
    if (existing.has(key)) {
      report.skipped.push(`${b.subject} ${stableStringify(input)} (already in corpus)`);
      continue;
    }

    const id = nextRowId(corpusPath);
    appendEvent(corpusPath, {
      op: "capture",
      id,
      at: new Date().toISOString(),
      subject: b.subject,
      input,
      reason: b.reason,
      test: b.test,
      seed: b.seed,
      commit,
      source: b.source,
    } as CorpusEvent);
    existing.add(key);
    report.added.push(`${id} ${b.subject} ${stableStringify(input)}`);
  }
  return report;
}
