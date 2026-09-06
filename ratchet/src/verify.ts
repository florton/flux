import * as fs from "fs";
import * as path from "path";
import { activeRows, stableStringify } from "./corpus";
import type { RatchetConfig, RowState, VerifyResult } from "./types";
import { runCheck } from "./runner";
import { failureSignature, signaturesMatch } from "./signature";

export interface VerifyOptions {
  row?: string;
  subject?: string;
  quiet?: boolean;
  ratchetHome?: string;
}

interface ResolvedCheck {
  command: string;
  input: unknown;
  shell?: boolean;
  testName?: string;
}

function resolveCheck(config: RatchetConfig, row: RowState): ResolvedCheck {
  const subj = config.subjects[row.subject];
  if (!subj) {
    throw new Error(`no subject config for "${row.subject}"`);
  }
  // The test name is never interpolated into a shell string. It reaches the
  // check as a single argv element (via `{test}`) and as RATCHET_TEST, so a
  // crafted test name cannot become command syntax.
  return { command: subj.check, input: row.input, shell: subj.shell, testName: row.test };
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
  if (opts.row) rows = rows.filter((r) => r.id === opts.row || r.id.startsWith(opts.row!));
  if (opts.subject) rows = rows.filter((r) => r.subject === opts.subject);

  const results: VerifyResult[] = [];
  for (const row of rows) {
    let result: VerifyResult;
    try {
      const { command, input, shell, testName } = resolveCheck(config, row);
      const res = runCheck(command, input, { cwd, shell, testName });
      const drift =
        !res.pass && !res.errored && row.signature !== undefined
          ? !signaturesMatch(failureSignature(res.reason, res.code), row.signature)
          : false;
      result = { id: row.id, subject: row.subject, pass: res.pass, reason: res.reason, signatureDrift: drift };
    } catch (err) {
      result = { id: row.id, subject: row.subject, pass: false, reason: String(err) };
    }
    results.push(result);
  }

  if (!opts.quiet) {
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const r of results) {
      if (r.pass) {
        console.log(`✓ ${r.id} ${r.subject}`);
        continue;
      }
      const row = byId.get(r.id);
      const shown = row ? ` ${inputString(row)}` : "";
      const drift = r.signatureDrift ? "  [!] different failure than the one captured" : "";
      console.log(`✗ ${r.id} ${r.subject}${shown} — ${r.reason ?? "failed"}${drift}`);
    }
    const failed = results.filter((r) => !r.pass);
    console.log(
      `\n${results.length - failed.length}/${results.length} rows pass${failed.length ? `, ${failed.length} failing` : ""}`
    );
    const drifted = failed.filter((r) => r.signatureDrift).length;
    if (drifted > 0) {
      console.log(
        `${drifted} failing for a different reason than captured — check whether the row still describes the bug it was created for`
      );
    }
  }
  return results;
}

export function verifyAndExit(cwd: string, opts: VerifyOptions): never {
  const results = verify(cwd, opts);
  const failed = results.filter((r) => !r.pass);
  process.exit(failed.length > 0 ? 1 : 0);
}

export function inputString(row: { input: unknown; test?: string }): string {
  return row.input === null && row.test ? `(test: ${row.test})` : stableStringify(row.input);
}
