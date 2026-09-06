import * as fs from "fs";
import * as path from "path";
import { activeRows } from "./corpus";
import type { RatchetConfig, RowState, VerifyResult } from "./types";
import { runCheck } from "./runner";
import { stableStringify } from "./corpus";

export interface VerifyOptions {
  row?: string;
  subject?: string;
  json?: boolean;
  quiet?: boolean;
  ratchetHome?: string;
}

function resolveCheck(config: RatchetConfig, row: RowState, cwd: string): { command: string; input: unknown } {
  const subj = config.subjects[row.subject];
  if (!subj) {
    throw new Error(`no subject config for "${row.subject}"`);
  }
  if (row.input === null && row.test) {
    return { command: subj.check.replace(/\{test\}/g, row.test), input: null };
  }
  return { command: subj.check, input: row.input };
}

export function verify(cwd: string, opts: VerifyOptions): VerifyResult[] {
  const ratchetDir = opts.ratchetHome ?? process.env.RATCHET_HOME ?? path.join(cwd, ".ratchet");
  const configPath = path.join(ratchetDir, "config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error("no .ratchet/config.json found — run `ratchet init` first");
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as RatchetConfig;
  const corpusPath = path.join(ratchetDir, "corpus.jsonl");

  let rows = activeRows(corpusPath);
  if (opts.row) rows = rows.filter((r) => r.id === opts.row);
  if (opts.subject) rows = rows.filter((r) => r.subject === opts.subject);

  const results: VerifyResult[] = [];
  for (const row of rows) {
    let result: VerifyResult;
    try {
      const { command, input } = resolveCheck(config, row, cwd);
      const res = runCheck(command, input, { cwd });
      result = { id: row.id, subject: row.subject, pass: res.pass, reason: res.reason };
    } catch (err) {
      result = { id: row.id, subject: row.subject, pass: false, reason: String(err) };
    }
    results.push(result);
  }

  if (!opts.quiet) {
    for (const r of results) {
      const mark = r.pass ? "✓" : "✗";
      console.log(`${mark} ${r.id} ${r.subject} ${r.pass ? "" : "— " + (r.reason ?? "failed")}`);
    }
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} rows pass${failed.length ? `, ${failed.length} failing` : ""}`);
  }
  return results;
}

export function verifyAndExit(cwd: string, opts: VerifyOptions): never {
  const results = verify(cwd, opts);
  const failed = results.filter((r) => !r.pass);
  process.exit(failed.length > 0 ? 1 : 0);
}

export function inputString(input: unknown): string {
  return input === null ? "(test-name)" : stableStringify(input);
}
