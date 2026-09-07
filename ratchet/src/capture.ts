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
  source: "fast-check" | "junit" | "manual" | "tap";
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
  // The testcase body may nest <failure>, <error>, <skipped> and the output
  // elements; the closing-tag backreference keeps the pairing honest even
  // when a failure message itself contains "</failure>"-shaped text.
  const caseRe = /<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/g;
  for (const m of text.matchAll(caseRe)) {
    const name = decodeXml(extractAttr(m[1], "name") ?? "");
    if (!name) continue;
    const body = m[2];
    const failRe = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g;
    for (const f of body.matchAll(failRe)) {
      const attrs = f[2];
      const content = f[3];
      const message = extractAttr(attrs, "message");
      // CDATA wraps the reason in unescaped form; message-less failures carry
      // it as element text (possibly with entities that need decoding).
      const raw = message ?? (content ? unwrapCdata(content) : "");
      out.push({
        subject: name,
        input: null,
        test: name,
        reason: decodeXml(raw.trim() || `${f[1]} in ${name}`),
        source: "junit",
      });
    }
  }
  return out;
}

/** `name="value"` or `name='value'` inside an element's attribute list. */
function extractAttr(tag: string, name: string): string | undefined {
  // \b keeps "name" from matching inside "classname" or "nodename".
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`);
  const m = re.exec(tag);
  return m ? (m[2] ?? m[3]) : undefined;
}

function unwrapCdata(content: string): string {
  return content.replace(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/, "$1").trim();
}

/**
 * Parse a TAP stream (v12/v13 — what `node --test --test-reporter=tap` and
 * most Perl-family runners emit) into test-name rows.
 *
 * The failure reason is the diagnostics block's `error`/`message` key when
 * the reporter wrote one, otherwise the test name — which degrades the row's
 * witness exactly like a check that prints nothing, and is worth knowing
 * about, so the reason is the strongest text the stream offers.
 */
function parseTap(filePath: string): SubjectBinding[] {
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  const out: SubjectBinding[] = [];
  for (let i = 0; i < lines.length; i++) {
    // Nested subtests are indented in TAP output (node --test does this).
    const m = /^\s*not ok\s+\d+\s*(?:-\s*)?(.*)$/.exec(lines[i]);
    if (!m) continue;
    let name = m[1].trim();
    // Directives ("# SKIP", "# TODO") mark planned failures; a skipped test
    // is not a counterexample.
    const directive = /#\s*(SKIP|TODO)\b/i.exec(name);
    if (directive) continue;
    const hashIdx = name.indexOf(" #");
    if (hashIdx !== -1) name = name.slice(0, hashIdx).trim();
    if (!name) continue;

    // The diagnostics block is the indented `---` ... `...` span right after
    // the failing line; collect the error/message key when present.
    let reason: string | undefined;
    let j = i + 1;
    let inDiag = false;
    const block: string[] = [];
    while (j < lines.length) {
      const line = lines[j];
      if (/^\s+---\s*$/.test(line)) {
        inDiag = true;
        j++;
        continue;
      }
      if (inDiag && /^\s+\.\.\.\s*$/.test(line)) {
        inDiag = false;
        j++;
        continue;
      }
      if (!inDiag && !/^\s/.test(line)) break;
      if (inDiag) block.push(line.replace(/^\s{2,}/, ""));
      j++;
    }
    i = j - 1;

    if (block.length > 0) {
      for (let k = 0; k < block.length; k++) {
        const em = /^(error|message):\s*(.*)$/.exec(block[k]);
        if (!em) continue;
        const value = em[2].trim();
        if (value !== "" && value !== "|-" && value !== "|") {
          reason = value;
          break;
        }
        // YAML block scalar: the message continues on more-indented lines.
        const parts: string[] = [];
        while (k + 1 < block.length && /^\s/.test(block[k + 1])) {
          const part = block[++k].trim();
          if (part) parts.push(part);
        }
        reason = parts.join(" ") || undefined;
        break;
      }
    }
    out.push({ subject: name, input: null, test: name, reason: reason ?? name, source: "tap" });
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
    if (/^TAP version \d+/m.test(text)) {
      bindings = bindings.concat(parseTap(input));
    } else if (text.startsWith("<")) {
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
      const at = new Date().toISOString();
      // A recurrence is the corpus catching a regression against a decision
      // someone already made — the event the churn report rates. It is
      // always journaled, even when the row stays retired: reopening is a
      // choice, remembering is not.
      appendJournal(journalPath, {
        at,
        kind: "recurrence",
        actor: opts.actor ?? "ratchet",
        text:
          `counterexample matched a row retired ${existing.lastAt} by ${existing.lastActor ?? "unknown"}` +
          ` (${existing.lastReason ?? "no reason recorded"}) — it is failing again: ${reason}`,
        corpusId: id,
        commit,
      });
      if (opts.reopen) {
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
    // The witness that enforces the row comes from the check's own output —
    // that is what `verify` will be compared against. When the check prints
    // nothing (reason degrades to `exit <n>`), the parsed capture source may
    // still know why the test failed, and the row's *display* should carry
    // that rather than the degraded placeholder. The signature stays
    // check-derived, so drift detection stays honest either way.
    const shownReason =
      b.reason && /^exit \d+$/.test(reason.trim()) ? b.reason : reason;
    const event: CorpusEvent = {
      op: "capture",
      id,
      at,
      subject: b.subject,
      input,
      reason: shownReason,
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
