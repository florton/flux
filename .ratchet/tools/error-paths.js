#!/usr/bin/env node
/**
 * Every command exits with a message, not a stack trace.
 *
 * The CLI surface and its error paths were the largest empty row in the
 * coverage table: six of the twenty-one v0 review defects (R8, R11, R12, R13,
 * R15, R18) and one of the v0.7 escapes — `guard` throwing a raw stack on a
 * corrupt corpus — and not one subject reached any of them. They were
 * unreachable from a scratch corpus and a `deepStrictEqual`, so they got
 * nothing.
 *
 * This is a *completeness* property over the set of commands, not a
 * counterexample: no single input exhibits "some command, somewhere, dies
 * badly". So the command list is read out of the binary's own usage rather
 * than written down here — a command added next year is covered the day it
 * ships, and one that predates the commit under test is simply absent.
 *
 * Three broken homes, because these are the three ways a home is broken in
 * the field: a corpus that took a bad merge, a rules file with a typo in it,
 * and a home that was never initialized.
 *
 * A stack trace is not a cosmetic complaint. It means the failure reached the
 * top of the program unhandled, so nothing decided what it meant — and the
 * person reading it learns the line number of a `JSON.parse` instead of which
 * file to fix.
 *
 * Contract, as for every instrument here: exit 0 when the probe ran, 125 when
 * there is no binary to probe, 1 only when the probe itself could not run.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const root = process.cwd();
const BIN = path.join(root, "ratchet", "dist", "src", "index.js");

/**
 * A stack frame, which always carries a `file:line:column`. Anchored on that
 * shape rather than on the word "at", because a `because` clause is prose and
 * prose says "at" all the time.
 */
const STACK_FRAME = /(^|\n)\s+at\s+.*:\d+:\d+\)?/;

const findings = [];
const temps = [];
let probes = 0;

function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

function ratchet(cwd, args) {
  const env = { ...process.env };
  delete env.RATCHET_HOME;
  delete env.RATCHET_PROJECT_ROOT;
  delete env.RATCHET_INPUT;
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    env,
  });
  if (r.error) throw new Error(`could not spawn the ratchet: ${r.error.message}`);
  return { status: r.status, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

/* ------------------------------------------------------------ broken homes */

/** A corpus that took a bad merge: a truncated line and a conflict marker. */
function corruptCorpus() {
  const home = path.join(tmp("ratchet-errs-"), ".ratchet");
  write(path.join(home, "config.json"), JSON.stringify({ subjects: {} }));
  write(
    path.join(home, "corpus.jsonl"),
    '{"op":"capture","id":"c0001","at":"2026-01-01T00:00:00.000Z","subject":"s","input":1}\n' +
      "<<<<<<< HEAD\n" +
      '{"op":"capture","id":"c0002","at":"2026-01-01T00:00:00.000Z","subje\n' +
      "=======\n" +
      "not json at all\n" +
      ">>>>>>> branch\n"
  );
  write(path.join(home, "journal.jsonl"), "{oops\n");
  return { kind: "corrupt-corpus", home };
}

/** A rules file with a clause that does not parse. */
function unparseableRules() {
  const home = path.join(tmp("ratchet-errs-"), ".ratchet");
  write(path.join(home, "config.json"), JSON.stringify({ subjects: {} }));
  write(path.join(home, "corpus.jsonl"), "");
  write(path.join(home, "journal.jsonl"), "");
  write(
    path.join(home, "heuristics.rules"),
    `heuristic widgets-shipped
  run      node tools/measure.js
  measure  shipped  number after "widgets shipped:"
  rule     shipped is abov 10
  frobnicate  whatever this is
`
  );
  return { kind: "unparseable-rules", home };
}

/** A home that was never initialized: the directory exists and nothing else. */
function absentConfig() {
  const home = path.join(tmp("ratchet-errs-"), ".ratchet");
  fs.mkdirSync(home, { recursive: true });
  return { kind: "absent-config", home };
}

/* -------------------------------------------------------------------------- */

/**
 * Arguments that get a command past its own usage check and into the code
 * that reads the home. A command absent from this table is probed bare, which
 * exercises the usage path instead — also an error path, and also required
 * not to throw.
 */
const ARGS = {
  show: ["c0001"],
  accept: ["c0001", "--reason", "probing the error path"],
  reopen: ["c0001", "--reason", "probing the error path"],
  reaffirm: ["c0001", "--reason", "probing the error path"],
  note: ["--text", "probing the error path"],
  heuristics: ["show", "widgets-shipped"],
  fmt: ["--check"],
  guard: ["--quiet"],
  verify: ["--quiet"],
  hooks: ["status"],
  // fuzz is self-contained — it builds its own scratch state and never reads
  // the home — so probing it at its default budget would only measure its
  // runtime against this instrument's spawn timeout, not its error paths.
  // One rules iteration exercises the same machinery in a fraction of it.
  fuzz: ["--iterations", "1", "--targets", "rules"],
};

/** Commands that would leave the scratch tree or the clock somewhere else. */
const SKIP = new Set(["init", "visual"]);

function commands(cwd) {
  const usage = ratchet(cwd, []);
  return (usage.out.match(/^\s{2}ratchet\s+([a-z][a-z-]*)/gm) ?? [])
    .map((l) => l.trim().split(/\s+/)[1])
    .filter((c) => !SKIP.has(c));
}

if (!fs.existsSync(BIN)) {
  console.log(`n/a: no built ratchet at this commit (looked for ${path.relative(root, BIN) || BIN})`);
  process.exit(125);
}

const homes = [corruptCorpus(), unparseableRules(), absentConfig()];

try {
  // A working tree with a `.ratchet` of its own, so `--home` is the thing
  // under test rather than the root walk.
  const cwd = tmp("ratchet-errs-cwd-");
  fs.mkdirSync(path.join(cwd, ".ratchet"), { recursive: true });
  write(path.join(cwd, ".ratchet", "config.json"), JSON.stringify({ subjects: {} }));
  write(path.join(cwd, ".ratchet", "corpus.jsonl"), "");
  write(path.join(cwd, ".ratchet", "journal.jsonl"), "");

  const list = commands(cwd);
  for (const { kind, home } of homes) {
    for (const command of list) {
      probes++;
      const r = ratchet(cwd, [command, ...(ARGS[command] ?? []), "--home", home]);
      if (STACK_FRAME.test(r.out)) {
        const frame = (r.out.match(/(^|\n)(\s+at\s+.*:\d+:\d+\)?)/) ?? [])[2] ?? "";
        findings.push(
          `STACK ${kind} — \`ratchet ${command}\` threw instead of explaining:${frame.trim().slice(0, 120)}`
        );
        continue;
      }
      if (r.status !== 0 && r.out.trim() === "") {
        findings.push(
          `SILENT ${kind} — \`ratchet ${command}\` exited ${r.status} and printed nothing, ` +
            `which is a failure nobody can act on`
        );
      }
    }
  }
} catch (err) {
  console.log(`error-path probe crashed: ${err && err.stack ? err.stack : String(err)}`);
  process.exit(1);
} finally {
  for (const dir of temps) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* a leftover scratch directory is not a finding about the tool */
    }
  }
}

for (const f of findings) console.log(f);

if (probes === 0) {
  console.log("n/a: this binary lists no commands to probe");
  process.exit(125);
}

console.log(`broken homes: ${homes.length}`);
console.log(`commands probed: ${probes}`);
