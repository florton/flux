#!/usr/bin/env node
/**
 * The end-to-end CLI subject — the loop the README documents, driven against
 * the real binary in a real git repository.
 *
 * Why this exists. Classifying the twenty-one v0 review defects against the
 * six self-hosted subjects showed every subject was a check of a *data
 * structure*: fold order, id collision, reduction slippage, dedup
 * partitioning, stringify injectivity. Five of twenty-one defects, all in one
 * row. The other sixteen sat at the process boundary, on the CLI surface, in
 * the capture-path routing, or in packaging, and none of them had a subject —
 * because a scratch corpus and a `deepStrictEqual` cannot reach them. The
 * corpus was built where it was easy rather than where the bugs live, and the
 * v0.7 pass proved the point: eleven defects fixed, the gate green through
 * ten of them.
 *
 * So this instrument spawns the actual `ratchet` binary, in an actual
 * repository, with actual commits, and walks the loop end to end:
 *
 *     init -> write a heuristic -> fmt -> adopt -> verify green
 *          -> break the code -> verify red with the right witness
 *          -> widen the rule -> quarantine with the prose diff -> reaffirm
 *
 * Running that by hand is what found five of the v0.7 escapes. A ritual
 * performed once per release by whoever remembers is not a mechanism.
 *
 * Contract. This is an *instrument*, not a check: it exits 0 whenever the run
 * itself completed, and reports what it found on stdout, because the judgment
 * belongs in `.ratchet/heuristics.rules` where a human can read it. Exit 125
 * when there is no built binary at this commit; exit 1 only when the driver
 * itself could not run.
 *
 * Version-agnostic, because `adopt` and `replay` run it against old
 * checkouts: a scenario whose command the checked-out binary does not offer
 * reports `skip` rather than a failure. Manufacturing a regression out of a
 * feature that did not exist yet is exactly the dishonesty `na` exists to
 * prevent.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const root = process.cwd();
const BIN = path.join(root, "ratchet", "dist", "src", "index.js");

/**
 * Declared here, and floored by a rule, so that gutting the driver — leaving
 * every scenario skipped — reddens the gate instead of greening it. The
 * driver is a frozen instrument carried across history, so this count does
 * not move with the commit under test; the number that *ran* does.
 */
const DECLARED = [
  "init-scaffolds-a-clean-home",
  "fmt-snaps-wording-and-keeps-prose",
  "fmt-check-is-a-gate",
  "adopt-arms-against-history",
  "verify-is-red-with-a-witness",
  "quarantine-shows-the-clause-that-moved",
  "reaffirm-lifts-the-quarantine",
  "capture-refuses-an-unproven-subject",
  "home-flag-reaches-every-command",
  "instrument-is-reachable-through-home",
  "seed-reaches-the-instrument",
  "guard-is-one-gate-one-exit-code",
  "hooks-install-does-not-clobber",
];

const failures = [];
const skipped = [];
const ran = [];
const temps = [];

function fail(scenario, detail) {
  failures.push(`FAIL ${scenario} — ${detail}`);
}

class Skip extends Error {}
function skip(why) {
  throw new Skip(why);
}

/* ---------------------------------------------------------------- plumbing */

function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function cleanup() {
  for (const dir of temps) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* a leftover scratch directory is not a finding about the tool */
    }
  }
}

/**
 * Spawn the checked-out binary. Never a shell: argv is argv.
 *
 * RATCHET_HOME is *deleted*, not blanked: this driver is itself run by the
 * ratchet, which exports it, and inheriting the outer home would point every
 * scenario at this repository's own memory instead of the scratch one.
 */
function ratchet(cwd, args, extraEnv) {
  const env = { ...process.env, ...extraEnv };
  delete env.RATCHET_HOME;
  delete env.RATCHET_PROJECT_ROOT;
  delete env.RATCHET_INPUT;
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 32 * 1024 * 1024,
    env,
  });
  if (r.error) throw new Error(`could not spawn the ratchet: ${r.error.message}`);
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  return { status: r.status, stdout, stderr, out: `${stdout}\n${stderr}` };
}

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 120_000 });
  if (r.error) throw new Error(`git ${args[0]} could not run: ${r.error.message}`);
  return { status: r.status, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

/** A scratch repository with an identity, so commits do not need the user's. */
function repo() {
  const dir = tmp("ratchet-e2e-");
  if (git(dir, ["init", "-q"]).status !== 0) throw new Error("git init failed in the scratch repository");
  git(dir, ["config", "user.email", "e2e@ratchet.invalid"]);
  git(dir, ["config", "user.name", "ratchet e2e"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

function commit(dir, message) {
  git(dir, ["add", "-A"]);
  const r = git(dir, ["commit", "-q", "-m", message]);
  if (r.status !== 0) throw new Error(`commit "${message}" failed: ${r.stderr || r.stdout}`);
  return git(dir, ["rev-parse", "HEAD"]).stdout;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

/**
 * The commands this binary offers, read out of its own usage.
 *
 * Derived rather than listed, so a scenario is skipped when its command
 * genuinely predates the commit under test, and so a command added later is
 * covered without editing this file.
 */
let commandCache = null;
function commands() {
  if (commandCache) return commandCache;
  const usage = ratchet(root, []);
  commandCache = new Set(
    (usage.stdout.match(/^\s{2}ratchet\s+([a-z][a-z-]*)/gm) ?? []).map((l) => l.trim().split(/\s+/)[1])
  );
  return commandCache;
}

function needs(...names) {
  const have = commands();
  for (const n of names) if (!have.has(n)) skip(`this binary has no \`ratchet ${n}\``);
}

/* ------------------------------------------------------- a measured project */

const MEASURE = (value) => `#!/usr/bin/env node
// The project's own instrument: prints one number the heuristic reads.
console.log("widgets shipped: ${value}");
`;

const HEURISTIC = (predicate) => `heuristic widgets-shipped
  run      node tools/measure.js
  measure  shipped  the number after "widgets shipped:"
  rule     shipped ${predicate}
  because  a shipping count that jumps is a counting bug, not a good quarter
`;

/**
 * A repository whose history contains a real bug and a real fix, so `adopt`
 * has something to find: good -> bad -> fixed.
 */
function measuredProject(predicate) {
  const dir = repo();
  write(path.join(dir, "tools", "measure.js"), MEASURE(5));
  const good = commit(dir, "ship the counter");
  write(path.join(dir, "tools", "measure.js"), MEASURE(4200));
  const bad = commit(dir, "count every widget twice (the bug)");
  write(path.join(dir, "tools", "measure.js"), MEASURE(5));
  const fixed = commit(dir, "count each widget once");

  const init = ratchet(dir, ["init"]);
  if (init.status !== 0) throw new Error(`ratchet init failed: ${init.out.trim()}`);
  write(path.join(dir, ".ratchet", "heuristics.rules"), HEURISTIC(predicate ?? "is below 10"));
  return { dir, good, bad, fixed };
}

/* --------------------------------------------------------------- scenarios */

const scenarios = {
  /**
   * `init` writes a home that is immediately usable and immediately quiet.
   * The old template shipped an `example` subject pointing at a check.js
   * nobody wrote, so a fresh `guard` opened by warning about the tool's own
   * scaffolding — which is how people learn to ignore warnings.
   */
  "init-scaffolds-a-clean-home"() {
    needs("init");
    const dir = repo();
    const r = ratchet(dir, ["init"]);
    if (r.status !== 0) return fail("init-scaffolds-a-clean-home", `init exited ${r.status}: ${r.out.trim()}`);

    for (const f of ["config.json", "heuristics.rules", "corpus.jsonl", "journal.jsonl"]) {
      if (!fs.existsSync(path.join(dir, ".ratchet", f))) {
        return fail("init-scaffolds-a-clean-home", `init did not write .ratchet/${f}`);
      }
    }
    const config = JSON.parse(fs.readFileSync(path.join(dir, ".ratchet", "config.json"), "utf8"));
    const phantom = Object.entries(config.subjects ?? {}).filter(([, s]) => {
      const m = /(?:^|\s)([\w./\\{}-]+\.(?:js|ts|sh|py))/.exec(String(s && s.check));
      return m && !fs.existsSync(path.resolve(dir, m[1].split("{home}").join(path.join(dir, ".ratchet"))));
    });
    if (phantom.length > 0) {
      return fail(
        "init-scaffolds-a-clean-home",
        `init declared subject(s) whose check does not exist: ${phantom.map(([n]) => n).join(", ")} — ` +
          `a fresh guard warns about the tool's own scaffolding`
      );
    }
    if (!commands().has("guard")) return;
    const g = ratchet(dir, ["guard"]);
    if (g.status !== 0) {
      fail("init-scaffolds-a-clean-home", `guard on a freshly initialized home exited ${g.status}: ${g.out.trim()}`);
    }
  },

  /**
   * `fmt` rewrites wording and keeps everything it is not rewriting. The
   * shipped version dropped the comments and `because` lines written beside
   * a clause — a formatter that eats the reasoning is one nobody runs twice.
   */
  "fmt-snaps-wording-and-keeps-prose"() {
    needs("init", "fmt");
    const dir = repo();
    ratchet(dir, ["init"]);
    const rules = path.join(dir, ".ratchet", "heuristics.rules");
    write(
      rules,
      `# why this heuristic exists, in a comment nobody should lose
heuristic widgets-shipped
  run      node tools/measure.js
  measure  shipped  the number after "widgets shipped:"
  rule     shipped should be greater than 2
  note     the counter is sampled hourly, which the vocabulary cannot say
  because  a shipping count that jumps is a counting bug
`
    );
    const r = ratchet(dir, ["fmt"]);
    if (r.status !== 0) return fail("fmt-snaps-wording-and-keeps-prose", `fmt exited ${r.status}: ${r.out.trim()}`);

    const after = fs.readFileSync(rules, "utf8");
    if (!/rule\s+shipped is above 2/.test(after)) {
      return fail(
        "fmt-snaps-wording-and-keeps-prose",
        `fmt did not snap "should be greater than" to "is above"; the file now reads:\n${after.trim()}`
      );
    }
    for (const [what, needle] of [
      ["the leading comment", "why this heuristic exists"],
      ["the note", "sampled hourly"],
      ["the because", "a counting bug"],
      ["the measure", 'number after "widgets shipped:"'],
    ]) {
      if (!after.includes(needle)) {
        return fail("fmt-snaps-wording-and-keeps-prose", `fmt dropped ${what} — data loss in a formatter`);
      }
    }
  },

  /** `fmt --check` is the CI form: nonzero when the committed file is not canonical. */
  "fmt-check-is-a-gate"() {
    needs("init", "fmt");
    const dir = repo();
    ratchet(dir, ["init"]);
    write(path.join(dir, ".ratchet", "heuristics.rules"), HEURISTIC("must be less than 10"));

    const loose = ratchet(dir, ["fmt", "--check"]);
    if (loose.status === 0) {
      return fail("fmt-check-is-a-gate", "fmt --check exited 0 on a file that is not canonical — CI would never notice");
    }
    ratchet(dir, ["fmt"]);
    const canonical = ratchet(dir, ["fmt", "--check"]);
    if (canonical.status !== 0) {
      fail("fmt-check-is-a-gate", `fmt --check exited ${canonical.status} on a file fmt had just written: ${canonical.out.trim()}`);
    }
  },

  /**
   * The load-bearing one: `adopt` runs the heuristic across real history in
   * real worktrees, finds the commit where the bug lived, captures the row,
   * and records the validation proof. Every process boundary the tool has is
   * on this path.
   */
  "adopt-arms-against-history"() {
    needs("init", "adopt", "verify");
    const { dir, good, bad } = measuredProject();
    const r = ratchet(dir, ["adopt", "widgets-shipped", "--good", good]);
    if (r.status !== 0) {
      return fail("adopt-arms-against-history", `adopt exited ${r.status}: ${r.out.trim()}`);
    }
    if (!r.out.includes(bad.slice(0, 8))) {
      return fail(
        "adopt-arms-against-history",
        `adopt did not name ${bad.slice(0, 8)} "count every widget twice" as the first failing commit; it said:\n${r.out.trim()}`
      );
    }
    if (!/captured\s+c[0-9a-f]+/.test(r.out)) {
      return fail("adopt-arms-against-history", `adopt captured no row:\n${r.out.trim()}`);
    }
    if (!/validated/.test(r.out)) {
      return fail("adopt-arms-against-history", `adopt recorded no validation proof:\n${r.out.trim()}`);
    }
    const corpus = fs.readFileSync(path.join(dir, ".ratchet", "corpus.jsonl"), "utf8").trim();
    if (corpus === "") return fail("adopt-arms-against-history", "adopt reported a capture but the corpus is empty");

    const v = ratchet(dir, ["verify"]);
    if (v.status !== 0) {
      fail("adopt-arms-against-history", `verify is red at the fixed commit adopt just armed against:\n${v.out.trim()}`);
    }
  },

  /**
   * A red row says what it measured, in the words of the rule that rejected
   * it. "check failed" is not a witness anyone can act on.
   */
  "verify-is-red-with-a-witness"() {
    needs("init", "adopt", "verify");
    const { dir, good } = measuredProject();
    const a = ratchet(dir, ["adopt", "widgets-shipped", "--good", good]);
    if (a.status !== 0) return fail("verify-is-red-with-a-witness", `adopt exited ${a.status}: ${a.out.trim()}`);

    write(path.join(dir, "tools", "measure.js"), MEASURE(4200));
    const v = ratchet(dir, ["verify"]);
    if (v.status === 0) {
      return fail("verify-is-red-with-a-witness", `verify stayed green after the bug was reintroduced:\n${v.out.trim()}`);
    }
    if (!v.out.includes("4200")) {
      return fail("verify-is-red-with-a-witness", `the witness does not carry the measured value 4200:\n${v.out.trim()}`);
    }
    if (!/is below 10/.test(v.out)) {
      return fail("verify-is-red-with-a-witness", `the witness does not quote the rule that rejected it:\n${v.out.trim()}`);
    }
    if (!/a counting bug/.test(v.out)) {
      fail("verify-is-red-with-a-witness", `the witness does not quote the \`because\`:\n${v.out.trim()}`);
    }
  },

  /**
   * Editing a rule quarantines the rows pinned to the old one, and says which
   * clause moved and which commit moved it. "rule fd59... became a3b1..." was
   * never going to be read by anyone.
   */
  "quarantine-shows-the-clause-that-moved"() {
    needs("init", "adopt", "verify");
    const { dir, good } = measuredProject();
    const a = ratchet(dir, ["adopt", "widgets-shipped", "--good", good]);
    if (a.status !== 0) return fail("quarantine-shows-the-clause-that-moved", `adopt exited ${a.status}: ${a.out.trim()}`);
    commit(dir, "adopt the widgets-shipped heuristic");

    // Tighter, so the row would redden under the new rule: a quarantine is
    // "fails, but the rule moved". A widening leaves the row passing and is
    // only a re-pin note — a different sentence, for a different case.
    write(path.join(dir, ".ratchet", "heuristics.rules"), HEURISTIC("is below 3"));
    commit(dir, "tighten the band: 10 was looser than the counter justifies");

    const v = ratchet(dir, ["verify"]);
    if (!/quarantin/i.test(v.out)) {
      return fail(
        "quarantine-shows-the-clause-that-moved",
        `an edited rule did not quarantine its row — a failure was reported against a rule nobody is ` +
          `enforcing any more:\n${v.out.trim()}`
      );
    }
    if (v.status !== 0) {
      fail(
        "quarantine-shows-the-clause-that-moved",
        `verify exited ${v.status} on a quarantined row — a quarantine routes to review, it does not block the build`
      );
    }
    if (!/-\s*rule\s+shipped is below 10/.test(v.out) || !/\+\s*rule\s+shipped is below 3/.test(v.out)) {
      fail(
        "quarantine-shows-the-clause-that-moved",
        `the quarantine did not show the clause that moved, only hashes:\n${v.out.trim()}`
      );
    }
  },

  /**
   * `reaffirm` says the edited expectation stands. The row is re-pinned, so
   * the next failure is a plain regression again rather than a quarantine —
   * which is the whole point of making someone decide.
   */
  "reaffirm-lifts-the-quarantine"() {
    needs("init", "adopt", "verify", "reaffirm");
    const { dir, good } = measuredProject();
    const a = ratchet(dir, ["adopt", "widgets-shipped", "--good", good]);
    if (a.status !== 0) return fail("reaffirm-lifts-the-quarantine", `adopt exited ${a.status}: ${a.out.trim()}`);
    commit(dir, "adopt the widgets-shipped heuristic");
    write(path.join(dir, ".ratchet", "heuristics.rules"), HEURISTIC("is below 3"));
    commit(dir, "tighten the band");

    const before = ratchet(dir, ["verify"]);
    const id = /c[0-9a-f]{8,}/.exec(before.out);
    if (!id) return fail("reaffirm-lifts-the-quarantine", `verify named no row id to reaffirm:
${before.out.trim()}`);

    const r = ratchet(dir, ["reaffirm", id[0], "--reason", "the tighter band is the expectation now"]);
    if (r.status !== 0) return fail("reaffirm-lifts-the-quarantine", `reaffirm exited ${r.status}: ${r.out.trim()}`);

    const after = ratchet(dir, ["verify"]);
    if (/quarantin/i.test(after.out)) {
      return fail("reaffirm-lifts-the-quarantine", `the row is still quarantined after reaffirm:
${after.out.trim()}`);
    }
    if (after.status === 0) {
      return fail(
        "reaffirm-lifts-the-quarantine",
        `a re-pinned row that still fails exited 0 — reaffirm turned a quarantine into a green light:
${after.out.trim()}`
      );
    }
    // And the row goes green when the code meets the expectation it now names.
    write(path.join(dir, "tools", "measure.js"), MEASURE(2));
    const green = ratchet(dir, ["verify"]);
    if (green.status !== 0) {
      fail("reaffirm-lifts-the-quarantine", `verify is still red once the code satisfies the re-pinned rule:
${green.out.trim()}`);
    }
  },

  /**
   * The capture gate: a subject that has never been proven able to fail
   * cannot enter the corpus, because a row from it is a green light over
   * nothing.
   */
  "capture-refuses-an-unproven-subject"() {
    needs("init", "capture");
    const dir = repo();
    ratchet(dir, ["init"]);
    write(path.join(dir, ".ratchet", "heuristics.rules"), HEURISTIC("is below 10"));
    write(path.join(dir, "tools", "measure.js"), MEASURE(4200));
    commit(dir, "a project with a failing counter");

    const junit = path.join(dir, "results.xml");
    write(
      junit,
      `<testsuite><testcase name="widgets-shipped"><failure message="shipped measured 4200"/></testcase></testsuite>\n`
    );
    const r = ratchet(dir, ["capture", "results.xml"]);
    if (r.status === 0) {
      return fail(
        "capture-refuses-an-unproven-subject",
        `capture accepted a row from a subject with no validation proof:\n${r.out.trim()}`
      );
    }
    if (!/never been proven to fail|unvalidated/i.test(r.out)) {
      return fail("capture-refuses-an-unproven-subject", `capture refused for an unexplained reason:\n${r.out.trim()}`);
    }
    const allowed = ratchet(dir, ["capture", "results.xml", "--allow-unvalidated"]);
    if (allowed.status !== 0) {
      return fail(
        "capture-refuses-an-unproven-subject",
        `--allow-unvalidated did not let the first use through:\n${allowed.out.trim()}`
      );
    }
    const journal = fs.readFileSync(path.join(dir, ".ratchet", "journal.jsonl"), "utf8");
    if (!/unvalidated/i.test(journal)) {
      fail(
        "capture-refuses-an-unproven-subject",
        "the escape hatch was not journaled — the exception went into somebody's shell history instead of onto the record"
      );
    }
  },

  /**
   * `--home` reaches every command, from a nested directory, spelled
   * relatively. This is the runtime half of the uniformity invariant: v0
   * honored the flag in two of eight commands, and nothing failed.
   */
  "home-flag-reaches-every-command"() {
    needs("init", "adopt");
    const { dir, good } = measuredProject();

    // The precondition, asserted rather than assumed. `--home` resolves the
    // same either way on an *empty* corpus — both routes answer "0/0 rows
    // pass" — so a scenario that let the row go missing would report a pass
    // having compared nothing. That is the green light over nothing this
    // whole tool exists to refuse, and it belongs least of all in its own
    // driver.
    const armed = ratchet(dir, ["adopt", "widgets-shipped", "--good", good]);
    const corpus = path.join(dir, ".ratchet", "corpus.jsonl");
    if (!fs.existsSync(corpus) || fs.readFileSync(corpus, "utf8").trim() === "") {
      return fail(
        "home-flag-reaches-every-command",
        `could not arm a row to compare with, so nothing was compared: adopt exited ${armed.status}:\n${armed.out.trim()}`
      );
    }

    const nested = path.join(dir, "tools", "deep");
    fs.mkdirSync(nested, { recursive: true });
    const relative = path.relative(nested, path.join(dir, ".ratchet"));

    // Read-only commands: each must address the home the flag names, from a
    // directory that is not the repository root, given a relative path.
    const reads = [
      ["list", []],
      ["report", []],
      ["fsck", []],
      ["yield", []],
      ["heuristics", []],
      ["verify", ["--quiet"]],
      ["guard", ["--quiet"]],
    ].filter(([c]) => commands().has(c));

    for (const [command, args] of reads) {
      const here = ratchet(nested, [command, ...args, "--home", relative]);
      const there = ratchet(dir, [command, ...args, "--home", path.join(dir, ".ratchet")]);
      if (here.status !== there.status) {
        fail(
          "home-flag-reaches-every-command",
          `\`ratchet ${command} --home\` exited ${here.status} from a nested directory with a relative path, ` +
            `${there.status} from the root with an absolute one — the flag does not reach this command the same way`
        );
        continue;
      }
      if (!/widgets-shipped/.test(here.stdout) && /widgets-shipped/.test(there.stdout)) {
        fail(
          "home-flag-reaches-every-command",
          `\`ratchet ${command}\` saw the home's subjects with an absolute --home and not with a relative one`
        );
      }
    }
  },

  /**
   * A prose heuristic must be able to reach an instrument that lives in the
   * ratchet home rather than in the tree being measured. That is the whole
   * frozen-instrument mechanism, and until v0.8 the probe substituted neither
   * `{home}` nor `{ratchet}` — so `run node {home}/tools/audit.js` was
   * expressible in config.json and nowhere in prose.
   */
  "instrument-is-reachable-through-home"() {
    needs("init", "verify");
    const dir = repo();
    ratchet(dir, ["init"]);
    // The instrument exists ONLY in the home. If {home} is not substituted,
    // the spawn fails with ENOENT and the heuristic cannot run at all.
    write(
      path.join(dir, ".ratchet", "tools", "audit.js"),
      `console.log("audited findings: 0");\n`
    );
    write(
      path.join(dir, ".ratchet", "heuristics.rules"),
      `heuristic carried-audit
  run      node {home}/tools/audit.js
  measure  findings  the number after "audited findings:"
  rule     findings is 0
  because  an instrument that only exists in the working tree cannot measure history
`
    );
    write(path.join(dir, "README.md"), "a project\n");
    commit(dir, "a project with a carried instrument");

    const v = ratchet(dir, ["verify", "--subject", "carried-audit"]);
    if (/could not run|ENOENT|no such file/i.test(v.out)) {
      return fail(
        "instrument-is-reachable-through-home",
        `a prose heuristic cannot reach {home}: the probe did not substitute the token:\n${v.out.trim()}`
      );
    }
    if (!commands().has("validate")) return;
    // The real test of a frozen instrument: it must run at a commit that
    // predates it. The home is carried out of the tree; the tool is not in
    // the tree at all.
    const first = git(dir, ["rev-parse", "HEAD"]).stdout;
    write(path.join(dir, "README.md"), "a project, later\n");
    commit(dir, "later work");
    const r = ratchet(dir, ["validate", "carried-audit", "--known-bad", first]);
    if (/could not run|ENOENT|no such file/i.test(r.out)) {
      fail(
        "instrument-is-reachable-through-home",
        `the carried instrument was not reachable in a worktree checked out at an older commit:\n${r.out.trim()}`
      );
    }
  },

  /**
   * `seed` must reach the instrument. It is injected through NODE_OPTIONS,
   * and the shipped version passed a win32 path with backslashes — which
   * Node's parser treats as escapes, so the preload silently failed and the
   * band went back to measuring noise while still reporting a number.
   */
  "seed-reaches-the-instrument"() {
    needs("init", "verify");
    const dir = repo();
    ratchet(dir, ["init"]);
    const log = path.join(dir, "rolls.txt");
    write(
      path.join(dir, "tools", "roll.js"),
      `const fs = require("fs");
const value = Math.random();
fs.appendFileSync(${JSON.stringify(log)}, value + "\\n");
console.log("roll: " + value);
console.log("seed seen: " + (process.env.RATCHET_SEED ? 1 : 0));
`
    );
    write(
      path.join(dir, ".ratchet", "heuristics.rules"),
      `heuristic seeded-roll
  run      node tools/roll.js
  seed     20260906
  measure  seen  the number after "seed seen:"
  rule     seen is 1
  because  a band over an unseeded simulation is measuring noise
`
    );
    const first = commit(dir, "a seeded instrument");

    // `verify` enforces rows, and this subject has none yet, so `validate` is
    // what runs the check: two invocations, two runs of the instrument. Its
    // verdict is beside the point — what is measured here is whether the two
    // runs drew the same number.
    let last = null;
    for (let i = 0; i < 2; i++) {
      last = ratchet(dir, ["validate", "seeded-roll", "--known-bad", first]);
    }
    if (!fs.existsSync(log)) {
      return fail(
        "seed-reaches-the-instrument",
        `the instrument never ran: ${last ? last.out.trim() : "validate produced no output"}`
      );
    }
    const rolls = fs.readFileSync(log, "utf8").trim().split(/\r?\n/);
    if (rolls.length < 2) {
      return fail("seed-reaches-the-instrument", `the instrument ran ${rolls.length} time(s), not twice`);
    }
    if (rolls[0] !== rolls[1]) {
      fail(
        "seed-reaches-the-instrument",
        `two seeded runs drew ${rolls[0]} and ${rolls[1]} — Math.random is not seeded in the instrument, ` +
          `so every band over it is measuring noise`
      );
    }
  },

  /** One gate, one exit code: green when the rows hold, nonzero when they do not. */
  "guard-is-one-gate-one-exit-code"() {
    needs("init", "adopt", "guard");
    const { dir, good } = measuredProject();
    const a = ratchet(dir, ["adopt", "widgets-shipped", "--good", good]);
    if (a.status !== 0) return fail("guard-is-one-gate-one-exit-code", `adopt exited ${a.status}: ${a.out.trim()}`);

    const green = ratchet(dir, ["guard"]);
    if (green.status !== 0) {
      return fail("guard-is-one-gate-one-exit-code", `guard is red on a green repository:\n${green.out.trim()}`);
    }
    write(path.join(dir, "tools", "measure.js"), MEASURE(4200));
    const red = ratchet(dir, ["guard"]);
    if (red.status === 0) {
      return fail("guard-is-one-gate-one-exit-code", `guard exited 0 with a failing row — the gate does not gate:\n${red.out.trim()}`);
    }
    const quiet = ratchet(dir, ["guard", "--quiet"]);
    if (quiet.status === 0) {
      fail("guard-is-one-gate-one-exit-code", "guard --quiet, the form a hook runs, exited 0 with a failing row");
    }
  },

  /**
   * The hook installer never overwrites a hook it did not write: an existing
   * pre-commit is a colleague's work, and clobbering it to install a quality
   * gate would be its own small regression.
   */
  "hooks-install-does-not-clobber"() {
    needs("init", "hooks");
    const dir = repo();
    ratchet(dir, ["init"]);
    const hook = path.join(dir, ".git", "hooks", "pre-commit");
    write(hook, "#!/bin/sh\necho \"a colleague's hook\"\nexit 0\n");

    const r = ratchet(dir, ["hooks", "install"]);
    const after = fs.existsSync(hook) ? fs.readFileSync(hook, "utf8") : "";
    if (!after.includes("a colleague's hook")) {
      return fail("hooks-install-does-not-clobber", `hooks install destroyed an existing pre-commit (exit ${r.status})`);
    }
    if (!/ratchet/.test(after)) {
      return fail("hooks-install-does-not-clobber", "hooks install left the existing hook alone but installed nothing");
    }
    const un = ratchet(dir, ["hooks", "uninstall"]);
    const restored = fs.readFileSync(hook, "utf8");
    if (!restored.includes("a colleague's hook")) {
      fail("hooks-install-does-not-clobber", `hooks uninstall (exit ${un.status}) removed more than its own block`);
    }
  },
};

/* -------------------------------------------------------------------------- */

if (!fs.existsSync(BIN)) {
  console.log(`n/a: no built ratchet at this commit (looked for ${path.relative(root, BIN) || BIN})`);
  process.exit(125);
}
if (spawnSync("git", ["--version"]).status !== 0) {
  console.log("n/a: git is not available, and every scenario here needs a repository");
  process.exit(125);
}

const only = (() => {
  const raw = process.env.RATCHET_INPUT;
  if (!raw || raw === "null") return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
})();

if (only && !Object.prototype.hasOwnProperty.call(scenarios, only)) {
  console.log(`FAIL ${only} — no such scenario in this driver; it declares: ${DECLARED.join(", ")}`);
  console.log(`scenarios declared: ${DECLARED.length}`);
  console.log(`scenarios run: 0`);
  process.exit(0);
}

try {
  for (const name of DECLARED) {
    if (only && name !== only) continue;
    const scenario = scenarios[name];
    if (!scenario) {
      fail(name, "declared but not implemented — the driver is out of step with its own list");
      continue;
    }
    try {
      scenario();
      ran.push(name);
    } catch (err) {
      if (err instanceof Skip) {
        skipped.push(`skip ${name} — ${err.message}`);
        continue;
      }
      ran.push(name);
      fail(name, `the scenario itself crashed: ${err && err.message ? err.message : String(err)}`);
    }
  }
} finally {
  cleanup();
}

for (const f of failures) console.log(f);
for (const s of skipped) console.log(s);

if (ran.length === 0) {
  console.log("n/a: this binary offers none of the commands these scenarios drive");
  process.exit(125);
}

console.log(`scenarios declared: ${DECLARED.length}`);
console.log(`scenarios run: ${ran.length}`);
console.log(`scenarios skipped: ${skipped.length}`);
