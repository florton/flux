import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { appendEvent, foldRows, readEvents, rowId, stableStringify } from "./corpus";
import { appendJournal } from "./journal";
import type { CorpusEvent, RatchetConfig, RowState, SubjectConfig } from "./types";
import { minimize, DEFAULT_BUDGET } from "./shrink";
import { runCheck } from "./runner";
import { failureSignature, signaturesMatch } from "./signature";
import { ruleHash } from "./rule";

export interface Recurrence {
  id: string;
  subject: string;
  input: unknown;
  test?: string;
  acceptedAt: string;
  acceptedBy?: string;
  acceptedReason?: string;
  reopened: boolean;
}

export interface CaptureReport {
  added: string[];
  skipped: string[];
  /** Counterexamples that match a row the accept ceremony had retired. */
  recurred: Recurrence[];
  /** Bindings dropped because their subject has no check configured. */
  unconfigured: string[];
  /** Counterexamples whose repeated runs disagreed — a flaky check. */
  flaky: string[];
}

export interface CaptureOptions {
  /** Reopen a retired row when its counterexample comes back. */
  reopen?: boolean;
  actor?: string;
  /**
   * How many times a failure must reproduce before it enters the corpus.
   * Default 2, per the design: "a failure must reproduce twice to enter the
   * corpus. Flakes are the fastest way to make a corpus untrustworthy."
   */
  confirmations?: number;
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

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
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
    const cex = capture.counterexample ?? [];
    out.push({
      subject: capture.property,
      input: cex.length === 1 ? cex[0] : cex,
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
    const name = decodeXml(m[1]);
    const body = m[2];
    const failRe = /<failure\b[^>]*message="([^"]*)"(?:\s*\/>|>[\s\S]*?<\/failure>)|<failure\b[^>]*>([\s\S]*?)<\/failure>/;
    const f = failRe.exec(body);
    if (f) {
      out.push({
        subject: name,
        input: null,
        test: name,
        reason: decodeXml(f[1] ?? f[2] ?? "failed"),
        source: "junit",
      });
    }
  }
  return out;
}

export function capture(cwd: string, inputs: string[], opts: CaptureOptions = {}): CaptureReport {
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
  const journalPath = path.join(ratchetDir, "journal.jsonl");
  const commit = currentCommit(cwd);
  const report: CaptureReport = { added: [], skipped: [], recurred: [], unconfigured: [], flaky: [] };
  const confirmations = Math.max(1, opts.confirmations ?? 2);
  const rows = foldRows(readEvents(corpusPath));

  for (const b of bindings) {
    const subj: SubjectConfig | undefined = config.subjects[b.subject];

    // A binding with no configured check cannot be verified, so it is not
    // evidence and it does not enter the corpus. Storing it would create a
    // row that fails forever with "no subject config" — a red build caused
    // by a config gap rather than by a regression.
    if (!subj) {
      report.unconfigured.push(b.subject);
      continue;
    }

    const runOpts = { cwd, shell: subj.shell, timeoutMs: subj.timeoutMs, testName: b.test, homeDir: ratchetDir };

    // Discrimination, for every source: the counterexample must reproduce
    // against the current code before it is worth remembering.
    const confirm = runCheck(subj.check, b.input, runOpts);
    if (confirm.errored) {
      report.skipped.push(`${b.subject} (check could not run: ${confirm.reason})`);
      continue;
    }
    if (confirm.outcome === "na") {
      report.skipped.push(`${b.subject} (check reports n/a here: ${confirm.reason})`);
      continue;
    }
    if (confirm.pass) {
      report.skipped.push(
        `${b.subject} ${stableStringify(b.input)} (not reproducible — check passes now)`
      );
      continue;
    }

    const signature = failureSignature(confirm.reason, confirm.code);

    // Discrimination, part two: the same failure must reproduce. A check that
    // fails intermittently would otherwise be stored on whichever run happened
    // to be red, and then make `verify` flaky forever. Disagreement between
    // runs is reported as a flaky check, not as a counterexample.
    let flaky = false;
    for (let i = 1; i < confirmations; i++) {
      const again = runCheck(subj.check, b.input, runOpts);
      if (again.outcome !== "fail" || !signaturesMatch(failureSignature(again.reason, again.code), signature)) {
        report.flaky.push(
          `${b.subject} ${stableStringify(b.input)} (run 1 failed with "${confirm.reason}", run ${i + 1} gave "${again.reason}" — not stored)`
        );
        flaky = true;
        break;
      }
    }
    if (flaky) continue;

    const rule = ruleHash(b.subject, subj, cwd);

    // Cause-preserving reduction. A smaller input is only accepted when it
    // fails the *same way*; otherwise reduction can walk off the captured
    // bug onto an unrelated one, storing a row that reproduces something
    // nobody captured while the real regression is minimized away.
    let input: unknown = b.input;
    let reason = confirm.reason;
    if (b.input !== null) {
      const budget = { remaining: DEFAULT_BUDGET };
      try {
        input = minimize(
          b.input,
          (candidate) => {
            const r = runCheck(subj.check, candidate, runOpts);
            return r.outcome === "fail" && !r.errored && signaturesMatch(failureSignature(r.reason, r.code), signature);
          },
          budget
        );
      } catch {
        input = b.input;
      }
      // Confirm the reduced input one final time. A flaky check can let a
      // bad reduction through; if the result no longer matches, keep the
      // original counterexample rather than storing something unproven.
      if (stableStringify(input) !== stableStringify(b.input)) {
        const recheck = runCheck(subj.check, input, runOpts);
        if (recheck.outcome !== "fail" || recheck.errored || !signaturesMatch(failureSignature(recheck.reason, recheck.code), signature)) {
          report.skipped.push(`${b.subject} (reduction did not hold on recheck — kept the original input)`);
          input = b.input;
        } else {
          reason = recheck.reason;
        }
      }
    }

    const id = rowId(b.subject, input, b.test);
    const existing: RowState | undefined = rows.get(id);

    if (existing && existing.status === "active") {
      report.skipped.push(`${id} ${b.subject} ${stableStringify(input)} (already in corpus)`);
      continue;
    }

    if (existing && existing.status === "archived") {
      // The accept ceremony retired this exact counterexample, and it is
      // failing again. Dedup must not swallow it: that would report the
      // regression as "already handled" and leave the build green.
      const rec: Recurrence = {
        id,
        subject: b.subject,
        input,
        test: b.test,
        acceptedAt: existing.lastAt,
        acceptedBy: existing.lastActor,
        acceptedReason: existing.lastReason,
        reopened: false,
      };
      if (opts.reopen) {
        const at = new Date().toISOString();
        appendEvent(corpusPath, {
          op: "reopen",
          id,
          at,
          subject: b.subject,
          input,
          test: b.test,
          signature,
          ruleHash: rule,
          reason: `recurred: ${reason}`,
          actor: opts.actor ?? "ratchet",
          commit,
          source: b.source,
        });
        appendJournal(journalPath, {
          at,
          kind: "decision",
          actor: opts.actor ?? "ratchet",
          text: `reopened on recurrence — the retired counterexample fails again: ${reason}`,
          corpusId: id,
          commit,
        });
        rec.reopened = true;
        rows.set(id, { ...existing, status: "active", lastOp: "reopen", lastAt: at });
      }
      report.recurred.push(rec);
      continue;
    }

    const at = new Date().toISOString();
    const event: CorpusEvent = {
      op: "capture",
      id,
      at,
      subject: b.subject,
      input,
      reason,
      signature,
      ruleHash: rule,
      test: b.test,
      seed: b.seed,
      commit,
      source: b.source,
    };
    appendEvent(corpusPath, event);
    rows.set(id, {
      id,
      subject: b.subject,
      input,
      status: "active",
      test: b.test,
      signature,
      ruleHash: rule,
      source: b.source,
      capturedAt: at,
      lastOp: "capture",
      lastAt: at,
    });
    report.added.push(`${id} ${b.subject} ${stableStringify(input)}`);
  }
  return report;
}
