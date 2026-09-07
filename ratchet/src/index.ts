#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { findRoot } from "./paths";
import { capture } from "./capture";
import { verify, verifyAndExit, defaultConcurrency } from "./verify";
import { accept, reopen, reaffirm } from "./accept";
import { report, reportData } from "./report";
import { bisect } from "./bisect";
import { replay, formatReplay } from "./replay";
import { validate, formatValidate } from "./validate";
import { fsck, formatFsck } from "./fsck";
import { listRows, formatList, showRow, formatRow } from "./inspect";
import { appendJournal } from "./journal";
import { recordVisual, diffImageFiles, describeDiff, ratchetHome, type VisualInput } from "./visual-cli";

function usage(): string {
  return `ratchet — regression memory for AI-assisted development

  ratchet init                     create .ratchet/ with a config template
  ratchet capture <file...>        add counterexamples (fast-check capture JSON or junit.xml)
                                   [--reopen] put retired rows back when they recur
  ratchet verify [--row id] [--subject name] [--quiet] [--jobs N]
  ratchet list [--status active|archived] [--subject name]
  ratchet show <id>                a row's full history and journal entries
  ratchet accept <id> --reason "..." [--actor name]
  ratchet reopen <id> --reason "..." [--actor name]
  ratchet reaffirm <id> --reason "..."   re-pin a row to an edited rule
  ratchet note --text "..." [--actor name]
  ratchet report                   corpus stats and churn summary
  ratchet fsck                     corpus and journal integrity check
  ratchet bisect <id> --good ref --bad ref [--setup "npm ci"]
  ratchet replay --good ref [--bad ref] [--every N|day|week] [--subjects]
  ratchet validate <subject> --known-bad ref [--known-good ref] [--input json]
  ratchet visual diff <a.png> <b.png> [--tolerance N] [--max-percent P] [--out file]
  ratchet visual record <subject> --route <url-or-route> [--viewport WxH] [--tolerance N]
                                   [--max-percent P] [--wait-ms ms]
                                   [--file <png>]   (use your own screenshot tool)

Every command takes --home <dir> and --json. Row ids are content-addressed;
any unambiguous prefix works. A check may exit 125 to report "not applicable
at this commit", which is neither a pass nor a failure. A row whose owning
rule was edited since capture is quarantined rather than treated as a
regression: review it, then "reaffirm" (the expectation stands) or "accept"
(it does not).
`;
}

function requireRoot(): string {
  const root = findRoot(process.cwd());
  if (!root) {
    console.error("no .ratchet directory found from here — run `ratchet init` first");
    process.exit(1);
  }
  return root;
}

function homeDir(cwd: string): string {
  return process.env.RATCHET_HOME ?? path.join(cwd, ".ratchet");
}

interface Args {
  flags: Map<string, string>;
  bools: Set<string>;
  positionals: string[];
}

/**
 * Split argv into flags, boolean switches, and positionals in one pass, so a
 * flag's value is never mistaken for a positional. Previously the id was
 * found with "first token that does not start with --", which picked up the
 * value of `--reason` when flags came first.
 */
const VALUE_FLAGS = new Set([
  "--row", "--subject", "--home", "--reason", "--actor",
  "--good", "--bad", "--setup", "--text", "--status", "--jobs",
  "--every", "--known-bad", "--known-good", "--input", "--confirm",
  "--route", "--file", "--viewport", "--tolerance", "--max-percent",
  "--wait-ms", "--out",
]);

function parseArgs(args: string[]): Args {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq !== -1) {
      flags.set(a.slice(0, eq), a.slice(eq + 1));
      continue;
    }
    if (VALUE_FLAGS.has(a)) {
      if (i + 1 >= args.length) {
        console.error(`${a} needs a value`);
        process.exit(1);
      }
      flags.set(a, args[++i]);
      continue;
    }
    bools.add(a);
  }
  return { flags, bools, positionals };
}

function emit(json: boolean, data: unknown, text: string): void {
  console.log(json ? JSON.stringify(data, null, 2) : text);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const { flags, bools, positionals } = parseArgs(argv.slice(1));
  const home = flags.get("--home");
  if (home) process.env.RATCHET_HOME = path.resolve(home);
  const json = bools.has("--json");

  switch (command) {
    case "init": {
      const dir = path.join(process.cwd(), ".ratchet");
      if (fs.existsSync(dir)) {
        console.error(".ratchet already exists");
        process.exit(1);
      }
      fs.mkdirSync(dir, { recursive: true });
      const config = {
        subjects: {
          example: {
            check: "node check.js example",
            captureProperty: "example property",
          },
        },
      };
      fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config, null, 2) + "\n", "utf8");
      fs.writeFileSync(path.join(dir, "corpus.jsonl"), "", "utf8");
      fs.writeFileSync(path.join(dir, "journal.jsonl"), "", "utf8");
      // Union-merge keeps two branches' appends from conflicting on the last
      // line; content-addressed ids keep them from colliding once merged.
      fs.writeFileSync(path.join(dir, ".gitattributes"), "corpus.jsonl merge=union\njournal.jsonl merge=union\n", "utf8");
      // Screenshot artifacts are repro output, not memory: the baselines are
      // committed, the failure artifacts generated at verify time are not.
      fs.writeFileSync(
        path.join(dir, ".gitignore"),
        "visual/*-actual.png\nvisual/*-diff.png\n",
        "utf8"
      );
      console.log("created .ratchet/ — configure subjects in .ratchet/config.json");
      break;
    }

    case "capture": {
      const cwd = requireRoot();
      if (positionals.length === 0) {
        console.error("usage: ratchet capture <file...> [--reopen]");
        process.exit(1);
      }
      const rep = capture(
        cwd,
        positionals.map((f) => path.resolve(cwd, f)),
        {
          reopen: bools.has("--reopen"),
          actor: flags.get("--actor") ?? "human",
          confirmations: flags.has("--confirm") ? parseInt(flags.get("--confirm")!, 10) : undefined,
        }
      );
      const unhandled = rep.recurred.filter((r) => !r.reopened).length;
      if (json) {
        console.log(JSON.stringify(rep, null, 2));
      } else {
        for (const id of rep.added) console.log(`+ ${id}`);
        for (const s of rep.skipped) console.log(`skip: ${s}`);
        for (const s of rep.flaky) console.log(`flaky: ${s}`);
        for (const s of rep.unconfigured) {
          console.log(`not captured: "${s}" has no subject in .ratchet/config.json — add one, then capture again`);
        }
        for (const r of rep.recurred) {
          const who = r.acceptedBy ? ` by ${r.acceptedBy}` : "";
          console.log(
            `\n[!] REGRESSION RECURRED — ${r.id} ${r.subject}\n` +
              `    retired ${r.acceptedAt}${who}: ${r.acceptedReason ?? "(no reason recorded)"}\n` +
              `    that accepted behavior is failing again` +
              (r.reopened ? " — row reopened and enforcing" : `\n    reopen it with: ratchet reopen ${r.id} --reason "..."`)
          );
        }
        console.log(
          `\n${rep.added.length} added, ${rep.skipped.length} skipped` +
            (rep.flaky.length ? `, ${rep.flaky.length} flaky` : "") +
            (rep.recurred.length ? `, ${rep.recurred.length} recurred` : "") +
            (rep.unconfigured.length ? `, ${rep.unconfigured.length} unconfigured` : "")
        );
      }
      // A recurrence is a live regression against a decision someone already
      // made. It must not exit green.
      if (unhandled > 0 || rep.unconfigured.length > 0) process.exit(1);
      break;
    }

    case "verify": {
      const cwd = requireRoot();
      const jobs = flags.get("--jobs");
      await verifyAndExit(cwd, {
        row: flags.get("--row"),
        subject: flags.get("--subject"),
        quiet: bools.has("--quiet"),
        json,
        ratchetHome: flags.get("--home"),
        concurrency: jobs ? Math.max(1, parseInt(jobs, 10) || defaultConcurrency()) : undefined,
      });
      break;
    }

    case "list": {
      const cwd = requireRoot();
      const status = flags.get("--status");
      if (status && status !== "active" && status !== "archived") {
        console.error("--status must be active or archived");
        process.exit(1);
      }
      const rows = listRows(homeDir(cwd), {
        status: status as "active" | "archived" | undefined,
        subject: flags.get("--subject"),
      });
      emit(json, rows, formatList(rows));
      break;
    }

    case "show": {
      const cwd = requireRoot();
      if (!positionals[0]) {
        console.error("usage: ratchet show <id>");
        process.exit(1);
      }
      const detail = showRow(homeDir(cwd), positionals[0]);
      emit(json, detail, formatRow(detail));
      break;
    }

    case "accept":
    case "reopen":
    case "reaffirm": {
      const cwd = requireRoot();
      const id = positionals[0];
      const reason = flags.get("--reason");
      if (!id || !reason) {
        console.error(`usage: ratchet ${command} <id> --reason "..."`);
        process.exit(1);
      }
      const actor = flags.get("--actor") ?? "human";
      if (command === "accept") {
        console.log(`accepted ${accept(cwd, id, reason, actor)} — expectation retired, audit trail retained`);
      } else if (command === "reopen") {
        console.log(`reopened ${reopen(cwd, id, reason, actor)} — row is enforcing again`);
      } else {
        console.log(
          `reaffirmed ${reaffirm(cwd, id, reason, actor)} — re-pinned to the current rule, quarantine lifted`
        );
      }
      break;
    }

    case "note": {
      const cwd = requireRoot();
      const text = flags.get("--text");
      if (!text) {
        console.error('usage: ratchet note --text "..."');
        process.exit(1);
      }
      appendJournal(path.join(homeDir(cwd), "journal.jsonl"), {
        at: new Date().toISOString(),
        kind: "decision",
        actor: flags.get("--actor") ?? "human",
        text,
      });
      console.log("journal entry appended");
      break;
    }

    case "report": {
      const cwd = requireRoot();
      emit(json, reportData(cwd), report(cwd));
      break;
    }

    case "fsck": {
      const cwd = requireRoot();
      const result = fsck(homeDir(cwd));
      emit(json, result, formatFsck(result));
      if (!result.ok) process.exit(1);
      break;
    }

    case "bisect": {
      const cwd = requireRoot();
      const id = positionals[0];
      const good = flags.get("--good");
      const bad = flags.get("--bad");
      if (!id || !good || !bad) {
        console.error('usage: ratchet bisect <id> --good ref --bad ref [--setup "npm ci"]');
        process.exit(1);
      }
      if (!json) console.log(`bisecting row ${id} (good=${good}, bad=${bad})...`);
      const result = await bisect(cwd, id, good, bad, {
        setup: flags.get("--setup"),
        ratchetHome: homeDir(cwd),
      });
      emit(
        json,
        result,
        result.notes.map((n) => `note: ${n}`).concat(`first bad commit: ${result.firstBad}  (${result.probes} probes)`).join("\n")
      );
      break;
    }

    case "replay": {
      const cwd = requireRoot();
      const good = flags.get("--good");
      const bad = flags.get("--bad") ?? "HEAD";
      if (!good) {
        console.error('usage: ratchet replay --good ref [--bad ref] [--every N|day|week]');
        process.exit(1);
      }
      const result = await replay(cwd, {
        good,
        bad,
        row: flags.get("--row"),
        subject: flags.get("--subject"),
        every: flags.get("--every"),
        setup: flags.get("--setup"),
        ratchetHome: homeDir(cwd),
        noPinpoint: bools.has("--no-pinpoint"),
        subjects: bools.has("--subjects"),
      });
      emit(json, result, formatReplay(result));
      if (result.samples.some((x) => x.status === "fail")) process.exit(1);
      break;
    }

    case "validate": {
      const cwd = requireRoot();
      const subject = positionals[0];
      const knownBad = flags.get("--known-bad");
      if (!subject || !knownBad) {
        console.error('usage: ratchet validate <subject> --known-bad ref [--known-good ref] [--input json]');
        process.exit(1);
      }
      const raw = flags.get("--input");
      const result = await validate(cwd, subject, {
        knownBad,
        knownGood: flags.get("--known-good"),
        input: raw === undefined ? undefined : JSON.parse(raw),
        setup: flags.get("--setup"),
        ratchetHome: homeDir(cwd),
        actor: flags.get("--actor") ?? "human",
      });
      emit(json, result, formatValidate(result));
      if (!result.valid) process.exit(1);
      break;
    }

    case "visual": {
      const cwd = requireRoot();
      const sub = positionals[0];
      if (sub === "diff") {
        const a = positionals[1];
        const b = positionals[2];
        if (!a || !b) {
          console.error('usage: ratchet visual diff <a.png> <b.png> [--tolerance N] [--max-percent P] [--out file]');
          process.exit(1);
        }
        const perPixel = flags.get("--tolerance") !== undefined ? parseInt(flags.get("--tolerance")!, 10) : undefined;
        const maxPercent = flags.get("--max-percent") !== undefined ? parseFloat(flags.get("--max-percent")!) : undefined;
        const { stats, diffPng } = diffImageFiles(path.resolve(cwd, a), path.resolve(cwd, b), { perPixel, maxPercent });
        const out = flags.get("--out");
        let outLine = "";
        if (out !== undefined) {
          fs.writeFileSync(path.resolve(cwd, out), diffPng);
          outLine = `; diff written to ${out}`;
        }
        if (json) {
          console.log(JSON.stringify({ ...stats, outPng: out ?? null }, null, 2));
        } else {
          console.log(describeDiff(stats, []) + outLine);
        }
        if (!stats.equal) process.exit(1);
        break;
      }
      if (sub === "record") {
        const subject = positionals[1];
        if (!subject || (!flags.get("--route") && !flags.get("--file"))) {
          console.error('usage: ratchet visual record <subject> --route <url> [--file <png>] [--viewport WxH --tolerance N --max-percent P --wait-ms ms]');
          process.exit(1);
        }
        const viewport: string | undefined = flags.get("--viewport");
        let width: number | undefined;
        let height: number | undefined;
        if (viewport) {
          const m = /^(\d+)[xX](\d+)$/.exec(viewport);
          if (!m) {
            console.error(`--viewport must be WxH, got "${viewport}"`);
            process.exit(1);
          }
          width = parseInt(m[1], 10);
          height = parseInt(m[2], 10);
        }
        const input: VisualInput = {
          route: flags.get("--route"),
          file: flags.get("--file"),
          width,
          height,
          waitMs: flags.get("--wait-ms") !== undefined ? parseInt(flags.get("--wait-ms")!, 10) : undefined,
          tolerance: flags.get("--tolerance") !== undefined ? parseInt(flags.get("--tolerance")!, 10) : undefined,
          maxPercent: flags.get("--max-percent") !== undefined ? parseFloat(flags.get("--max-percent")!) : undefined,
        };
        const result = await recordVisual(cwd, subject, input, flags.get("--actor"));
        emit(
          json,
          result,
          `recorded ${result.id} ${subject} — baseline .ratchet/visual/${result.pngName} (sha256 ${result.sha256.slice(0, 12)}…, size ${fs.statSync(path.join(ratchetHome(cwd), "visual", result.pngName)).size} bytes)` +
            (result.previousStatus === "active"
              ? "\nnote: row was already active — the previous baseline is replaced in place; its hash is kept in the corpus audit trail"
              : result.previousStatus === "archived"
                ? "\nnote: this row was retired — the new capture re-activates it"
                : "")
        );
        break;
      }
      console.error('usage: ratchet visual <diff|record> ...');
      process.exit(1);
      break;
    }

    default:
      console.log(usage());
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(`ratchet: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
