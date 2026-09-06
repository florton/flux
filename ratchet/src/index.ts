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
  ratchet verify [--row id] [--subject name] [--quiet]
  ratchet accept <id> --reason "..." [--actor name]
  ratchet reopen <id> --reason "..." [--actor name]
  ratchet note --text "..." [--actor name]
  ratchet report                   corpus stats and churn summary
  ratchet bisect <id> --good ref --bad ref
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

function argPairs(args: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--") && a.includes("=")) {
      map.set(a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1));
    } else if (a.startsWith("--") && i + 1 < args.length && !args[i + 1].startsWith("--")) {
      map.set(a, args[i + 1]);
      i++;
    }
  }
  return map;
}

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0];
  const rest = args.slice(1);
  const opts = argPairs(rest);

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
      console.log("created .ratchet/ — configure subjects in .ratchet/config.json");
      break;
    }

    case "capture": {
      const cwd = requireRoot();
      const files = rest.filter((a) => !a.startsWith("--"));
      if (files.length === 0) {
        console.error("usage: ratchet capture <file...>");
        process.exit(1);
      }
      const rep = capture(cwd, files.map((f) => path.resolve(cwd, f)));
      for (const id of rep.added) console.log(`+ ${id}`);
      for (const s of rep.skipped) console.log(`skip: ${s}`);
      console.log(`${rep.added.length} added, ${rep.skipped.length} skipped`);
      break;
    }

    case "verify": {
      const cwd = requireRoot();
      verifyAndExit(cwd, {
        row: opts.get("--row"),
        subject: opts.get("--subject"),
        quiet: rest.includes("--quiet"),
        ratchetHome: opts.get("--home"),
      });
      break;
    }

    case "accept": {
      const cwd = requireRoot();
      const id = rest.find((a) => !a.startsWith("--"));
      const reason = opts.get("--reason");
      if (!id || !reason) {
        console.error("usage: ratchet accept <id> --reason \"...\"");
        process.exit(1);
      }
      accept(cwd, id, reason, opts.get("--actor") ?? "human");
      console.log(`accepted ${id} — expectation retired, audit trail retained`);
      break;
    }

    case "reopen": {
      const cwd = requireRoot();
      const id = rest.find((a) => !a.startsWith("--"));
      const reason = opts.get("--reason");
      if (!id || !reason) {
        console.error("usage: ratchet reopen <id> --reason \"...\"");
        process.exit(1);
      }
      reopen(cwd, id, reason, opts.get("--actor") ?? "human");
      console.log(`reopened ${id} — row is enforcing again`);
      break;
    }

    case "note": {
      const cwd = requireRoot();
      const text = opts.get("--text");
      if (!text) {
        console.error("usage: ratchet note --text \"...\"");
        process.exit(1);
      }
      appendJournal(path.join(process.env.RATCHET_HOME ?? path.join(cwd, ".ratchet"), "journal.jsonl"), {
        at: new Date().toISOString(),
        kind: "decision",
        actor: opts.get("--actor") ?? "human",
        text,
      });
      console.log("journal entry appended");
      break;
    }

    case "report": {
      const cwd = requireRoot();
      if (opts.get("--home")) process.env.RATCHET_HOME = opts.get("--home")!;
      console.log(report(cwd));
      break;
    }

    case "bisect": {
      const cwd = requireRoot();
      const id = rest.find((a) => !a.startsWith("--"));
      const good = opts.get("--good");
      const bad = opts.get("--bad");
      if (!id || !good || !bad) {
        console.error("usage: ratchet bisect <id> --good ref --bad ref");
        process.exit(1);
      }
      if (!process.env.RATCHET_HOME) {
        process.env.RATCHET_HOME = path.join(cwd, ".ratchet");
      }
      console.log(`bisecting row ${id} (good=${good}, bad=${bad})...`);
      const result = bisect(cwd, id, good, bad);
      console.log(`first bad commit: ${result.trim().split("\n")[0]}`);
      break;
    }

    default:
      console.log(usage());
      process.exit(command ? 1 : 0);
  }
}

main();
