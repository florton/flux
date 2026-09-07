#!/usr/bin/env node
/**
 * Static uniformity checks — the class of defect a corpus row cannot catch.
 *
 * A corpus row is a counterexample: one input, one subject, one witness.
 * *Partial application of a mechanism* — a thing defined once and then wired
 * into some of its call sites — is a completeness property over a set of call
 * sites, and no single input exhibits it. This repository has produced that
 * defect four times across three versions:
 *
 *   v0    `--home` honored by 2 of 8 commands                        (R12)
 *   v0.7  `{home}` substituted in 1 of 2 spawn modes in runner.ts
 *   v0.7  `--setup` run without the carried home in all four callers
 *   v0.7  neither token substituted in probe.ts, so a prose heuristic
 *         could not reach a frozen instrument at all
 *
 * So: assertions over the *source*, not over a run. Each is a standing
 * invariant with no counterexample input, and each names the exact shape that
 * shipped broken.
 *
 * Contract. This is an *instrument*, not a check: it exits 0 whenever the
 * scan itself completed and reports what it found on stdout, because the
 * judgment lives in `.ratchet/heuristics.rules` where a human can read it.
 * Exit 125 when there is nothing here to scan (a commit that predates the
 * source tree), and exit 1 only when the scan itself could not run.
 *
 * Version-agnostic by construction, because `ratchet adopt` and
 * `ratchet replay` run it against old checkouts: a file an invariant needs
 * that does not exist at this commit makes that invariant *inapplicable*, and
 * an inapplicable invariant is reported as such rather than passed silently.
 * Where a mechanism has been refactored since, the invariant accepts both the
 * old shape and the new one — it is about coverage, not about spelling.
 */
const fs = require("fs");
const path = require("path");

const root = process.cwd();
const SRC = path.join(root, "ratchet", "src");

/**
 * The invariants this scanner knows how to check.
 *
 * Declared as a constant, and floored by a rule in `heuristics.rules`, so
 * that gutting the scanner — renaming a function until every invariant
 * quietly reports n/a — fails the gate instead of greening it. The count of
 * invariants that *applied* moves with the commit under test and cannot
 * serve as that floor: an invariant over a mechanism that did not exist yet
 * is honestly n/a, not honestly passing.
 */
const DECLARED = [
  "home-resolved-once",
  "spawn-substitutes-tokens",
  "setup-carries-the-home",
  "setup-runner-is-single",
  "setup-follows-every-checkout",
];

const violations = [];
const inapplicable = [];
const applied = new Set();

function read(file) {
  const p = path.join(SRC, file);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

/**
 * Drop whole-line comments.
 *
 * Line-level rather than a real lexer on purpose: this scanner runs against
 * source it did not write and must never mistake a regex literal containing a
 * quote for the start of a string. Every token mention this file looks for
 * sits on its own line in both the code and the prose around it, so the
 * cheap rule is the honest one — and a *trailing* comment that happened to
 * name a token would only ever make a check more lenient, never green
 * something that is broken.
 */
function code(source) {
  return source
    .split(/\r?\n/)
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");
}

/**
 * The body of `<keyword> name(...)`, brace-matched from its opening `{`.
 *
 * The opening brace is the first one that ends a line. A parameter default
 * (`paths: Substitutions = {}`) and a structural return type
 * (`: Observation | { spawnError: string }`) both put braces before the body,
 * so "the first `{`" finds the wrong one; the body brace is the one the
 * formatter leaves at the end of the signature line.
 */
function functionBody(source, name) {
  const re = new RegExp(`(?:function|const)\\s+${name}\\b`);
  const m = re.exec(source);
  if (!m) return null;
  const open = /\{[ \t]*(?:\r?\n|$)/.exec(source.slice(m.index));
  if (!open) return null;
  return braceSpan(source, m.index + open.index);
}

/** The `{ ... }` span starting at `open`, inclusive, or null if unbalanced. */
function braceSpan(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

/** The `if (<test>) { ... }` block whose test matches, and the rest around it. */
function splitBranch(body, testRe) {
  const m = testRe.exec(body);
  if (!m) return null;
  const open = body.indexOf("{", m.index);
  if (open === -1) return null;
  const block = braceSpan(body, open);
  if (block === null) return null;
  return { branch: block, rest: body.slice(0, m.index) + body.slice(open + block.length) };
}

function violate(invariant, detail) {
  violations.push(`VIOLATION ${invariant} — ${detail}`);
}

function apply(invariant) {
  applied.add(invariant);
}

function skip(invariant, why) {
  inapplicable.push(`n/a ${invariant} — ${why}`);
}

/* -------------------------------------------------------------------------- */

/**
 * I1. Every command resolves the ratchet home through the one resolver.
 *
 * `--home` reaches all twenty-two commands, but until now by two routes:
 * twenty-one called `homeDir(cwd)` while `verify` passed the raw flag and
 * re-resolved it itself. Both were checked against a relative `--home` from a
 * nested directory and they agreed — so this was not a defect, it was the
 * *shape* of one, sitting in the codebase unremarked. Nothing failed when the
 * twenty-third command picked a third route. Now something does.
 */
function homeResolvedOnce() {
  const source = read("index.ts");
  if (source === null) return skip("home-resolved-once", "ratchet/src/index.ts does not exist at this commit");
  apply("home-resolved-once");
  const reads = code(source).split('flags.get("--home")').length - 1;
  if (reads > 1) {
    violate(
      "home-resolved-once",
      `index.ts reads --home directly in ${reads} places; the flag is resolved once, at the top of main(), ` +
        `and every command asks homeDir(cwd) — a second route is a mechanism that can drift`
    );
  }
}

/**
 * I2. Every spawn path substitutes every path token.
 *
 * `{home}` and `{ratchet}` are the frozen-instrument mechanism: they let a
 * check reach an instrument that lives outside the tree being measured. A
 * spawn path that does not fill them in runs whatever the *checked-out
 * commit* happened to contain, which is exactly the comparison replay exists
 * to prevent — and it fails as a missing file, months later, in someone
 * else's repository.
 *
 * Two shapes count as handling the vocabulary: naming every token inline (how
 * runner.ts did it before the tokens had a module) or delegating to the
 * shared substituter. Both are coverage; neither is a spelling.
 */
const TOKENS = ["{home}", "{ratchet}"];
const DELEGATES = /substitute(Argv|Shell)\s*\(/;

const SPAWN_PATHS = [
  { file: "runner.ts", fn: "invocation", shellTest: /if\s*\(\s*opts\.shell\s*\)/ },
  { file: "probe.ts", fn: "observe", shellTest: /if\s*\(\s*h\.shell\s*\)/ },
];

function spawnPathsSubstitute() {
  for (const { file, fn, shellTest } of SPAWN_PATHS) {
    const source = read(file);
    if (source === null) {
      skip("spawn-substitutes-tokens", `ratchet/src/${file} does not exist at this commit`);
      continue;
    }
    const body = functionBody(code(source), fn);
    if (body === null) {
      skip("spawn-substitutes-tokens", `${file} has no ${fn}() at this commit`);
      continue;
    }
    const split = splitBranch(body, shellTest);
    if (split === null) {
      skip("spawn-substitutes-tokens", `${file} ${fn}() has no shell branch at this commit`);
      continue;
    }
    apply("spawn-substitutes-tokens");
    for (const [where, region] of [["shell mode", split.branch], ["direct mode", split.rest]]) {
      if (DELEGATES.test(region)) continue;
      const missing = TOKENS.filter((t) => !region.includes(t));
      if (missing.length > 0) {
        violate(
          "spawn-substitutes-tokens",
          `${file} ${fn}() does not substitute ${missing.join(" or ")} in ${where} — ` +
            `an instrument reached through that token would resolve inside the tree being measured`
        );
      }
    }
  }
}

/**
 * I3. Every `--setup` run carries the ratchet home.
 *
 * A build script added last month does not exist in a worktree checked out at
 * a commit from last year, so a setup command written as
 * `node {home}/tools/build.js` must resolve outside the tree. Four history
 * commands need setup, and each one used to build the call itself; the copies
 * agreed, but nothing made them, and the shipped version omitted `homeDir`
 * from all four — `--setup` simply could not say `{home}`.
 */
function setupCarriesHome() {
  const files = fs.existsSync(SRC) ? fs.readdirSync(SRC).filter((f) => f.endsWith(".ts")) : [];
  if (files.length === 0) return skip("setup-carries-the-home", "ratchet/src does not exist at this commit");

  const sites = [];
  for (const file of files) {
    const source = code(read(file));
    const re = /runCheckAsync\s*\(\s*([A-Za-z_.]*setup)\b/g;
    for (const m of source.matchAll(re)) {
      const open = source.indexOf("{", m.index);
      const options = open === -1 ? null : braceSpan(source, open);
      sites.push({ file, argument: m[1], options: options ?? "" });
    }
  }

  if (sites.length === 0) {
    skip("setup-carries-the-home", "nothing in this tree runs a --setup command");
    return skip("setup-runner-is-single", "nothing in this tree runs a --setup command");
  }
  apply("setup-carries-the-home");
  for (const site of sites) {
    if (!/\bhomeDir\s*:/.test(site.options)) {
      violate(
        "setup-carries-the-home",
        `${site.file} runs \`${site.argument}\` without homeDir — {home} in a setup command ` +
          `would resolve inside the worktree, where an instrument added later does not exist`
      );
    }
  }

  // The same mechanism, one definition. Four copies of five options is how
  // the omission above reached all four callers at once.
  apply("setup-runner-is-single");
  if (sites.length > 1) {
    violate(
      "setup-runner-is-single",
      `${sites.length} places construct a --setup run (${sites.map((s) => s.file).join(", ")}); ` +
        `one helper means the next caller cannot forget an option`
    );
  }
}

/**
 * I5. Every checkout of a probed commit is followed by the setup that
 * prepares it.
 *
 * `adopt` checked out the failing commit a second time to confirm the
 * failure, and did not re-run setup. Build output is not tracked, so
 * `git checkout --force` leaves the previous probe's artifacts in the
 * worktree: the confirmation measured whichever commit had been built last.
 * Every subject that needs a build was therefore reported flaky and refused —
 * and in the other direction a failure caused by stale artifacts would have
 * been confirmed and stored as a row.
 *
 * A file that runs setup at all has said its probes need preparing; a
 * checkout in that file with no setup after it is a probe running against
 * whatever was left behind.
 */
function setupFollowsEveryCheckout() {
  const files = fs.existsSync(SRC) ? fs.readdirSync(SRC).filter((f) => f.endsWith(".ts")) : [];
  let sawAny = false;
  for (const file of files) {
    const source = code(read(file));
    const setups = (source.match(/runSetup\s*\(|runCheckAsync\s*\(\s*[A-Za-z_.]*setup\b/g) ?? []).length;
    if (setups === 0) continue;
    sawAny = true;
    const checkouts = (source.match(/\.checkout\s*\(/g) ?? []).length;
    if (checkouts > setups) {
      violate(
        "setup-follows-every-checkout",
        `${file} checks out a probed commit ${checkouts} time(s) but prepares it ${setups} time(s) — ` +
          `a probe after the unprepared checkout measures the build left behind by the previous one`
      );
    }
  }
  if (!sawAny) return skip("setup-follows-every-checkout", "nothing in this tree runs a --setup command");
  apply("setup-follows-every-checkout");
}

/* -------------------------------------------------------------------------- */

if (!fs.existsSync(SRC)) {
  console.log(`n/a: no ratchet/src at this commit (looked in ${path.relative(root, SRC) || SRC})`);
  process.exit(125);
}

try {
  homeResolvedOnce();
  spawnPathsSubstitute();
  setupCarriesHome();
  setupFollowsEveryCheckout();
} catch (err) {
  console.log(`uniformity scan crashed: ${err && err.stack ? err.stack : String(err)}`);
  process.exit(1);
}

for (const v of violations) console.log(v);
for (const s of inapplicable) console.log(s);

// Nothing applied means this commit predates every mechanism these invariants
// are about. That is not-applicable, and reporting it as a pass would be a
// green light over nothing — the exact failure the capture gate exists for.
if (applied.size === 0) {
  console.log("n/a: this commit predates every mechanism these invariants describe");
  process.exit(125);
}

console.log(`invariants declared: ${DECLARED.length}`);
console.log(`invariants checked: ${applied.size}`);
console.log(`invariants inapplicable: ${DECLARED.length - applied.size}`);
