#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { findRoot } from "./paths";
import { capture } from "./capture";
import { verify, verifyAndExit } from "./verify";
import { accept, reopen } from "./accept";
import { report } from "./report";
import { bisect } from "./bisect";
import { appendJournal } from "./journal";

function usage(): string {
  return `ratchet — regression memory for AI-assisted development

  ratchet init                     create .ratchet/ with a config template
  ratchet capture <file...>        add counterexamples (fast-check capture JSON or junit.xml)
                                   [--reopen] put retired rows back when they recur
  ratchet verify [--row id] [--subject name] [--quiet]
  ratchet accept <id> --reason "..." [--actor name]
  ratchet reopen <id> --reason "..." [--actor name]
  ratchet note --text "..." [--actor name]
  ratchet report                   corpus stats and churn summary
  ratchet bisect <id> --good ref --bad ref [--setup "npm ci"]

Row ids are content-addressed; any unambiguous prefix works.
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
const VALUE_FLAGS = new Set(["--row", "--subject", "--home", "--reason", "--actor", "--good", "--bad", "--setup", "--text"]);

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

function main(): void {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const { flags, bools, positionals } = parseArgs(argv.slice(1));
  const home = flags.get("--home");
  if (home) process.env.RATCHET_HOME = path.resolve(home);

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
      fs.writeFileSync(
        path.join(dir, ".gitattributes"),
        "corpus.jsonl merge=union\njournal.jsonl merge=union\n",
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
        { reopen: bools.has("--reopen"), actor: flags.get("--actor") ?? "human" }
      );
      for (const id of rep.added) console.log(`+ ${id}`);
      for (const s of rep.skipped) console.log(`skip: ${s}`);
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
          (rep.recurred.length ? `, ${rep.recurred.length} recurred` : "") +
          (rep.unconfigured.length ? `, ${rep.unconfigured.length} unconfigured` : "")
      );
      // A recurrence is a live regression against a decision someone already
      // made. It must not exit green.
      const unhandled = rep.recurred.filter((r) => !r.reopened).length;
      if (unhandled > 0 || rep.unconfigured.length > 0) process.exit(1);
      break;
    }

    case "verify": {
      const cwd = requireRoot();
      verifyAndExit(cwd, {
        row: flags.get("--row"),
        subject: flags.get("--subject"),
        quiet: bools.has("--quiet"),
        ratchetHome: flags.get("--home"),
      });
      break;
    }

    case "accept":
    case "reopen": {
      const cwd = requireRoot();
      const id = positionals[0];
      const reason = flags.get("--reason");
      if (!id || !reason) {
        console.error(`usage: ratchet ${command} <id> --reason "..."`);
        process.exit(1);
      }
      const actor = flags.get("--actor") ?? "human";
      if (command === "accept") {
        const full = accept(cwd, id, reason, actor);
        console.log(`accepted ${full} — expectation retired, audit trail retained`);
      } else {
        const full = reopen(cwd, id, reason, actor);
        console.log(`reopened ${full} — row is enforcing again`);
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
      appendJournal(path.join(process.env.RATCHET_HOME ?? path.join(cwd, ".ratchet"), "journal.jsonl"), {
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
      console.log(report(cwd));
      break;
    }

    case "bisect": {
      const cwd = requireRoot();
      const id = positionals[0];
      const good = flags.get("--good");
      const bad = flags.get("--bad");
      if (!id || !good || !bad) {
        console.error("usage: ratchet bisect <id> --good ref --bad ref [--setup \"npm ci\"]");
        process.exit(1);
      }
      console.log(`bisecting row ${id} (good=${good}, bad=${bad})...`);
      const result = bisect(cwd, id, good, bad, {
        setup: flags.get("--setup"),
        ratchetHome: process.env.RATCHET_HOME ?? path.join(cwd, ".ratchet"),
      });
      for (const n of result.notes) console.log(`note: ${n}`);
      console.log(`first bad commit: ${result.firstBad}  (${result.probes} probes)`);
      break;
    }

    default:
      console.log(usage());
      process.exit(command ? 1 : 0);
  }
}

try {
  main();
} catch (err) {
  console.error(`ratchet: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
