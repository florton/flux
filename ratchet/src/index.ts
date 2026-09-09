#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { findRoot } from "./paths";
import { capture } from "./capture";
import { verify, verifyAndExit, defaultConcurrency } from "./verify";
import { accept, reopen, reaffirm } from "./accept";
import { report, reportData } from "./report";
import { bisect, formatBisect } from "./bisect";
import { replay, formatReplay } from "./replay";
import { validate, formatValidate } from "./validate";
import { fsck, formatFsck } from "./fsck";
import { listRows, formatList, showRow, formatRow } from "./inspect";
import { appendJournal } from "./journal";
import { recordVisual, diffImageFiles, describeDiff, ratchetHome, type VisualInput } from "./visual-cli";
import { guard, formatGuard } from "./guard";
import {
  fmt, formatFmt, listHeuristics, formatHeuristicList, heuristicLog, formatHeuristicLog,
  newHeuristic, formatNewHeuristic,
} from "./heuristics-cmd";
import { installHook, uninstallHook, hookStatus } from "./hooks";
import { adopt, formatAdopt } from "./adopt";
import { renderComment } from "./pr-comment";
import { yieldReport, formatYield } from "./yield";
import { fuzzMain } from "./fuzz-cli";
import { loadSubjects } from "./paths";
import { loadHeuristics } from "./heuristic-config";
import { validatedSubjects } from "./validate";
import { subjectProofs } from "./proof";
import { ruleHash } from "./rule";
import { toSubject } from "./heuristic-config";
import { RULES_TEMPLATE, CONFIG_TEMPLATE, INIT_MESSAGE, AGENTS_TEMPLATE } from "./templates";

function usage(): string {
  return `ratchet — regression memory for AI-assisted development

  ratchet init                     create .ratchet/ (config, rules, AGENTS.md).
                                   Safe to re-run: adds missing files, touches nothing.
  ratchet guard [--strict] [--quiet]   the one command a build runs: parse, integrity,
                                   rows, validation. Exits nonzero on any failure.
  ratchet hooks install|uninstall|status [--pre-push]
  ratchet heuristics [show <name>] [log <name>]   the prose subjects and their history
  ratchet heuristics new <name> [--run "<cmd>"]   start a block, with the name checked first
  ratchet fmt [--check]            snap heuristics.rules to the canonical vocabulary
  ratchet adopt <subject> --good <ref> [--bad ref] [--every N] [--dry-run]
  ratchet yield                    which heuristics still produce evidence
  ratchet pr-comment               the caught/new split as markdown, for CI
  ratchet capture <file...>        add counterexamples (fast-check capture JSON, junit.xml, or .tap)
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
  ratchet fuzz [--seed N] [--iterations N] [--targets state,cli,rules]
                                   the secondary verifier: mutate the gate's
                                   state, fuzz the CLI surface, and fuzz the
                                   rules grammar against the oracle invariants
  ratchet bisect <id> --from <older-ref> --to <newer-ref> [--setup "npm ci"]
                                   names the boundary and which way it runs
  ratchet replay --good ref [--bad ref] [--every N|day|week] [--subjects] [--jobs N]
                 [--subject name] [--row id] [--no-pinpoint]
                                   every transition in the range, with its direction.
                                   --subjects --subject <name> is how you find a commit
                                   where one subject fails, e.g. for validate's --known-bad
  ratchet validate <subject> --known-bad ref [--known-good ref] [--input json]
                 [--crash-is-the-regression]   a known-bad run that crashed rather than
                                   measured is refused, unless the crash is the bug
  ratchet visual diff <a.png> <b.png> [--tolerance N] [--max-percent P] [--out file]
  ratchet visual record <subject> --route <url-or-route> [--viewport WxH] [--tolerance N]
                                   [--max-percent P] [--wait-ms ms]
                                   [--file <png>]   (use your own screenshot tool)

Every command takes --home <dir> and --json. Row ids are content-addressed;
any unambiguous prefix works.

A check may exit 125 for "not applicable at this commit" (the feature did not
exist yet) or 126 for "this environment cannot run me here" (the toolchain
cannot prepare that commit). Neither is a pass or a failure, and they mean
opposite things about the code under test. A row whose owning rule was edited
since capture is quarantined rather than treated as a regression: review it,
then "reaffirm" (the expectation stands) or "accept" (it does not).

\`verify\` and \`guard\` enforce corpus rows *and* standing invariants — prose
heuristics proven by a declared \`rejects\` clause, which enforce with no row
behind them. The two are counted apart: the catch rate is a statement about
counterexamples.
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

/**
 * The one resolver. Every command asks this; nothing reads `--home` itself.
 *
 * An empty `RATCHET_HOME` counts as unset, not as "the home is the empty
 * path". `export RATCHET_HOME=` is how a shell unsets a variable sloppily,
 * and `??` honored it — every command then failed with
 * "no .ratchet/config.json found in " and a blank where the path should be.
 */
function homeDir(cwd: string): string {
  const fromEnv = process.env.RATCHET_HOME;
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : path.join(cwd, ".ratchet");
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
  "--good", "--bad", "--from", "--to", "--setup", "--text", "--status", "--jobs",
  "--every", "--known-bad", "--known-good", "--input", "--confirm",
  "--route", "--file", "--viewport", "--tolerance", "--max-percent",
  "--wait-ms", "--out", "--command", "--stale-after", "--title",
  "--seed", "--iterations", "--targets", "--max-findings", "--run",
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
      const fresh = !fs.existsSync(dir);
      fs.mkdirSync(dir, { recursive: true });

      // Additive, never destructive. Refusing outright on an existing home
      // left every project already using the ratchet with no way to pick up
      // a file a later version started shipping — which is how `AGENTS.md`
      // would have reached new projects only. Nothing here overwrites: a file
      // that exists is the project's, whatever it now contains.
      const files: [string, string][] = [
        ["AGENTS.md", AGENTS_TEMPLATE],
        ["config.json", JSON.stringify(CONFIG_TEMPLATE, null, 2) + "\n"],
        ["heuristics.rules", RULES_TEMPLATE],
        ["corpus.jsonl", ""],
        ["journal.jsonl", ""],
        // Union-merge keeps two branches' appends from conflicting on the last
        // line; content-addressed ids keep them from colliding once merged.
        [".gitattributes", "corpus.jsonl merge=union\njournal.jsonl merge=union\n"],
        // Screenshot artifacts are repro output, not memory: the baselines are
        // committed, the failure artifacts generated at verify time are not.
        [".gitignore", "visual/*-actual.png\nvisual/*-diff.png\n"],
      ];
      const written: string[] = [];
      for (const [name, body] of files) {
        const at = path.join(dir, name);
        if (fs.existsSync(at)) continue;
        fs.writeFileSync(at, body, "utf8");
        written.push(name);
      }

      if (fresh) {
        console.log(INIT_MESSAGE);
      } else if (written.length === 0) {
        console.log(".ratchet is already complete — nothing to add");
      } else {
        console.log(`.ratchet already exists; added ${written.length} missing file(s):`);
        for (const name of written) console.log(`  ${name}`);
        console.log("\nnothing existing was touched.");
      }
      break;
    }

    case "guard": {
      const cwd = requireRoot();
      const jobs = flags.get("--jobs");
      const stale = flags.get("--stale-after");
      const result = await guard(cwd, {
        ratchetHome: homeDir(cwd),
        strict: bools.has("--strict"),
        concurrency: jobs ? Math.max(1, parseInt(jobs, 10) || defaultConcurrency()) : undefined,
        staleAfterDays: stale ? parseInt(stale, 10) : undefined,
      });
      if (json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (bools.has("--quiet")) {
        // Quiet is for hooks: silence on success, the failures on failure.
        if (!result.ok) console.log(formatGuard(result));
      } else {
        console.log(formatGuard(result));
      }
      process.exit(result.ok ? 0 : 1);
      break;
    }

    case "hooks": {
      const cwd = requireRoot();
      const which = bools.has("--pre-push") ? "pre-push" : "pre-commit";
      const sub = positionals[0] ?? "status";
      if (sub === "install") {
        const r = installHook(cwd, { hook: which, command: flags.get("--command") });
        emit(json, r, `${r.detail}\n${r.path}`);
        if (r.action === "refused") process.exit(1);
      } else if (sub === "uninstall") {
        const r = uninstallHook(cwd, which);
        emit(json, r, r.detail);
      } else if (sub === "status") {
        const r = hookStatus(cwd, which);
        emit(
          json,
          r,
          r.installed
            ? `${which}: the ratchet gate is installed (${r.path})`
            : `${which}: not installed — \`ratchet hooks install\` wires \`ratchet guard\` into it`
        );
      } else {
        console.error("usage: ratchet hooks <install|uninstall|status> [--pre-push] [--command \"...\"]");
        process.exit(1);
      }
      break;
    }

    case "fmt": {
      const cwd = requireRoot();
      const check = bools.has("--check");
      const result = fmt(homeDir(cwd), { write: !check });
      emit(json, result, formatFmt(result, !check));
      // --check is the CI form: exit nonzero when the committed file is not
      // the canonical one, so a review always reads the checked clauses.
      if (check && result.changed) process.exit(1);
      break;
    }

    case "heuristics": {
      const cwd = requireRoot();
      const dir = homeDir(cwd);
      const sub = positionals[0];

      if (sub === "log") {
        const name = positionals[1];
        if (!name) {
          console.error("usage: ratchet heuristics log <name>");
          process.exit(1);
        }
        const loaded = loadHeuristics(dir);
        const current = loaded.heuristics.find((h) => h.name === name);
        const entries = heuristicLog(cwd, dir, name);
        emit(
          json,
          entries,
          formatHeuristicLog(name, entries, current, current ? ruleHash(name, toSubject(current), cwd) : undefined)
        );
        break;
      }

      if (sub === "new") {
        const name = positionals[1];
        if (!name) {
          console.error('usage: ratchet heuristics new <name> [--run "<command>"]');
          process.exit(1);
        }
        try {
          const created = newHeuristic(dir, name, { run: flags.get("--run") });
          emit(json, created, formatNewHeuristic(created));
        } catch (err) {
          // A name collision is a finding with a fix in it, not a stack trace.
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
        break;
      }

      const items = listHeuristics(cwd, dir);
      if (sub === "show") {
        const name = positionals[1];
        const one = items.find((h) => h.name === name);
        if (!one) {
          console.error(
            `no heuristic named "${name}"` +
              (items.length ? ` — this repository declares: ${items.map((h) => h.name).join(", ")}` : "")
          );
          process.exit(1);
        }
        emit(json, one, formatHeuristicList([one!], loadHeuristics(dir).file));
        break;
      }
      emit(json, items, formatHeuristicList(items, loadHeuristics(dir).file));
      break;
    }

    case "yield": {
      const cwd = requireRoot();
      const dir = homeDir(cwd);
      const config = loadSubjects(dir);
      const stale = flags.get("--stale-after");
      const r = yieldReport(dir, config, validatedSubjects(cwd, dir, config), {
        staleAfterDays: stale ? parseInt(stale, 10) : undefined,
        fromRules: config.fromRules,
        proofs: subjectProofs(cwd, dir, config),
      });
      emit(json, r, formatYield(r));
      break;
    }

    case "adopt": {
      const cwd = requireRoot();
      const subject = positionals[0];
      const good = flags.get("--good");
      if (!subject || !good) {
        console.error('usage: ratchet adopt <subject> --good <ref> [--bad ref] [--every N] [--setup "npm ci"] [--dry-run] [--crash-is-the-regression]');
        process.exit(1);
      }
      const every = flags.get("--every");
      const result = await adopt(cwd, subject, {
        good: good!,
        bad: flags.get("--bad"),
        setup: flags.get("--setup"),
        ratchetHome: homeDir(cwd),
        actor: flags.get("--actor") ?? "human",
        every: every ? Math.max(1, parseInt(every, 10)) : undefined,
        dryRun: bools.has("--dry-run"),
        crashIsTheRegression: bools.has("--crash-is-the-regression"),
      });
      emit(json, result, formatAdopt(result));
      // Nothing captured is not an error — it is a finding about the heuristic.
      break;
    }

    case "pr-comment": {
      const cwd = requireRoot();
      const dir = homeDir(cwd);
      const results = await verify(cwd, { ratchetHome: dir, quiet: true });
      const config = loadSubjects(dir);
      const report = reportData(cwd);
      const yields = yieldReport(dir, config, validatedSubjects(cwd, dir, config), {
        fromRules: config.fromRules,
        proofs: subjectProofs(cwd, dir, config),
      });
      const title = flags.get("--title");
      if (json) {
        // Every command takes --json; the markdown is the render, not the
        // payload. Structured consumers read the same numbers the comment
        // states, and the renderer stays a pure function of them.
        console.log(JSON.stringify({ results, report, yields, title }, null, 2));
      } else {
        console.log(renderComment({ results, report, yields, title }));
      }
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
          allowUnvalidated: bools.has("--allow-unvalidated"),
        }
      );
      const unhandled = rep.recurred.filter((r) => !r.reopened).length;
      if (json) {
        console.log(JSON.stringify(rep, null, 2));
      } else {
        for (const id of rep.added) console.log(`+ ${id}`);
        for (const s of rep.caught) console.log(`caught: ${s} — this row is enforcing and the bug came back anyway`);
        for (const s of rep.skipped) console.log(`skip: ${s}`);
        for (const s of rep.flaky) console.log(`flaky: ${s}`);
        for (const s of new Set(rep.unvalidated)) {
          console.log(
            `not captured: "${s}" has never been proven to fail on a known bug, so a row from it would be a` +
              ` green light over nothing.
` +
              `    prove it:  ratchet validate ${s} --known-bad <sha> --known-good HEAD
` +
              `    or adopt it against your own history:  ratchet adopt ${s} --good <old-ref>
` +
              `    first use of a brand-new subject:  re-run with --allow-unvalidated (journaled)`
          );
        }
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
            (rep.caught.length ? `, ${rep.caught.length} caught by an active row` : "") +
            (rep.flaky.length ? `, ${rep.flaky.length} flaky` : "") +
            (rep.recurred.length ? `, ${rep.recurred.length} recurred` : "") +
            (rep.unvalidated.length ? `, ${rep.unvalidated.length} refused (unvalidated subject)` : "") +
            (rep.unconfigured.length ? `, ${rep.unconfigured.length} unconfigured` : "")
        );
      }
      // A recurrence is a live regression against a decision someone already
      // made. It must not exit green.
      // A refused capture is a red build on purpose: the counterexample was
      // real and nothing recorded it, which is worse than a failing check.
      if (unhandled > 0 || rep.unconfigured.length > 0 || rep.unvalidated.length > 0) process.exit(1);
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
        // The one resolver, like every other command. Reading the raw flag
        // here was a second route to the same answer — the two agreed, but
        // nothing made them, and "a mechanism wired into some of its call
        // sites" is this codebase's most reliable defect.
        ratchetHome: homeDir(cwd),
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
      const event = {
        at: new Date().toISOString(),
        kind: "decision" as const,
        actor: flags.get("--actor") ?? "human",
        text,
      };
      appendJournal(path.join(homeDir(cwd), "journal.jsonl"), event);
      emit(json, event, "journal entry appended");
      break;
    }

    case "report": {
      const cwd = requireRoot();
      emit(json, reportData(cwd), report(cwd));
      break;
    }

    case "fsck": {
      const cwd = requireRoot();
      const result = fsck(homeDir(cwd), cwd);
      emit(json, result, formatFsck(result));
      if (!result.ok) process.exit(1);
      break;
    }

    case "fuzz": {
      // The fuzzer is self-contained: it builds a synthetic scratch home and
      // attacks that, so it needs no repository and touches nothing here.
      await fuzzMain({ flags, bools });
      break;
    }

    case "bisect": {
      const cwd = requireRoot();
      const id = positionals[0];
      // The refs are range endpoints in history order, and `--good`/`--bad`
      // are kept as aliases for the older and newer one. The names presumed a
      // direction the search no longer assumes: which side passes is measured,
      // not declared.
      const from = flags.get("--from") ?? flags.get("--good");
      const to = flags.get("--to") ?? flags.get("--bad");
      if (!id || !from || !to) {
        console.error('usage: ratchet bisect <id> --from <older-ref> --to <newer-ref> [--setup "npm ci"]');
        process.exit(1);
      }
      if (!json) console.log(`bisecting row ${id} between ${from} and ${to}...`);
      const result = await bisect(cwd, id, from, to, {
        setup: flags.get("--setup"),
        ratchetHome: homeDir(cwd),
      });
      emit(json, result, formatBisect(result, id));
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
        concurrency: flags.get("--jobs") ? Math.max(1, parseInt(flags.get("--jobs")!, 10)) : undefined,
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
        console.error(
          [
            "usage: ratchet validate <subject> --known-bad ref [--known-good ref] [--input json] [--crash-is-the-regression]",
            "  --known-bad is a commit where the check must fail. To find one:",
            "    ratchet replay --subjects --subject <subject> --good <an-old-ref>",
          ].join("\n")
        );
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
        crashIsTheRegression: bools.has("--crash-is-the-regression"),
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
