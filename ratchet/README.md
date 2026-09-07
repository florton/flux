# Ratchet — v0.6 prototype

Regression memory for AI-assisted development. The design sketch is
[../RATCHET.md](../RATCHET.md); this folder is the first working slice.

> **Status.** All 21 issues from the v0 review
> ([../ISSUES_RATCHET.md](../ISSUES_RATCHET.md)) are closed, and v0.4 closes
> the design gaps that remained after them: owning-rule hashes and quarantine,
> the second confirmation run, `ratchet replay` with sampling and halving,
> `ratchet validate`, and self-hosting. The ratchet now runs under itself —
> its own invariants are validated against the commits where its own bugs
> lived. v0.5 added the first *behavior snapshot*: visual pins — screenshots
> become corpus rows, with a zero-dependency PNG diff as the check's witness.
> v0.6 works the adoption gaps: the ratchet's **own corpus is populated** (the
> five v0 defects captured at the commit where they lived and re-pinned to
> today's instrument), capture gains a **TAP source** and a hardier JUnit
> parser, `replay` probes history on **parallel worktrees** (`--jobs`), and
> `report` rates failure signals as **caught-by-corpus vs. novel**. 70 tests.

Zero runtime dependencies. Zero model calls. The corpus is plain JSONL; the
journal is plain JSONL; everything is a file git already knows how to commit.

## Running against a local repo

1. Build once: `cd ratchet && npm install && npm run build`
2. `alias ratchet="node /path/to/ratchet/dist/src/index.js"`
3. In the target repo: `ratchet init`, then edit `.ratchet/config.json` — for
   each subject, a `check` command that reads one input as JSON on stdin and
   exits 0 (pass) or nonzero (fail).
4. Wire a fast-check reporter into your property tests (`demo/setup.js`
   generates a working one), or point `ratchet capture` at CI's JUnit XML.

The CLI finds `.ratchet/` by walking up from the working directory, so run it
from anywhere inside the repo. `--home <dir>` overrides that for every
command.

**Checked out an old commit and want today's memory?** The corpus travels with
the commit, like tests do. Carry it over explicitly:

```
$ MEM=$(mktemp -d); cp -r .ratchet "$MEM/"
$ git checkout <old-commit>
$ ratchet verify --home "$MEM/.ratchet"   # today's corpus, old code
```

`ratchet bisect` does the carrying for you.

## The workflow — preventing regressions with the ratchet

The ratchet is a loop, not a one-time setup. The order below is the order of
leverage; each step names the section that details it.

1. **Wire once, keep the instrument frozen.** `ratchet init`, then write
   checks as `node {home}/tools/probe.js <subject>` — `{home}` resolves to
   the ratchet home, which history commands carry out of the working tree,
   so `replay` and `bisect` measure every commit with the same script (see
   "The frozen instrument"). Declare `owns` for the measuring scripts; a
   subject without `owns` cannot tell you when its instrument was edited
   (see "The owning rule, and quarantine").
2. **Validate before you trust.** `ratchet validate <subject> --known-bad
   <sha> --known-good <sha>` — a subject that passes through a known bug is
   too weak to watch anything, and the proof is journaled against the rule
   hash it was proven under (see "Validating a subject").
3. **Capture rides the same PR as the fix.** Point a fast-check reporter,
   JUnit XML, or TAP at `ratchet capture` on red CI runs and commit the new
   rows alongside the fix. Discrimination, the confirmation runs, and
   cause-preserving minimization happen at capture — flakes never enter the
   corpus (see "Capture sources").
4. **Gate every merge with `ratchet verify`.** Rows are checked in parallel
   by default (`--jobs N` to tune). Rule unchanged and row fails → hard
   block. Rule edited and row fails → quarantine → review, then `reaffirm`
   (the expectation stands under the new instrument) or `accept` (it does
   not).
5. **Never re-derive an expectation silently.** Intended behavior changes go
   through the ceremony: `accept <id> --reason "..."`, then re-`record` the
   visual baseline if there is one. The recurrence gate means a retired
   expectation that fails again is loud and red, not deduplicated away (see
   "The accept ceremony").
6. **Start retroactively, don't grow from zero.** On adoption, run
   `ratchet replay --good v1 --subjects --every week --jobs 8` to draw the
   pass/fail curve of today's checks over your own history, and `ratchet
   bisect` the transitions worth a name. The first run produces a report,
   not a requirement — the corpus compounds from every fix after that (see
   "Replay across history" and "Bisect").
7. **Watch the number that ends arguments.** `ratchet report` splits every
   failure signal that reached capture into what the corpus already knew
   (recurrences of retired rows — memory working) and genuinely novel
   counterexamples:

   ```
   failure signals this week: 12
     caught by corpus: 9  (75%) — known regressions, the ratchet worked
     new counterexamples: 3 — novel bugs
   all-time: 21 caught, 9 new (70%)
   ```

   If the caught share is high, memory is working; if every failure is new,
   the code is churning faster than it is learning.

The meta-rule behind all seven: humans and models *propose* — heuristics,
pins, accepts — and deterministic machinery *disposes* — discrimination,
verification, replay. The division is the product.

## Commands

```
ratchet init                      create .ratchet/ with a config template
ratchet capture <file...>         add counterexamples (fast-check capture JSON, junit.xml, or .tap)
                                  [--reopen] put retired rows back when they recur
ratchet verify [--row id] [--subject name] [--quiet] [--jobs N]
ratchet list [--status active|archived] [--subject name]
ratchet show <id>                 a row's input, witness, history and journal
ratchet accept <id> --reason "..." [--actor name]
ratchet reopen <id> --reason "..." [--actor name]
ratchet note --text "..." [--actor name]
ratchet report                    corpus stats and churn summary
ratchet fsck                      corpus and journal integrity check
ratchet bisect <id> --good ref --bad ref [--setup "npm ci"]
ratchet replay --good ref [--bad ref] [--every N|day|week] [--subjects] [--jobs N]
               [--setup "npm ci"] [--no-pinpoint]
ratchet visual diff <a.png> <b.png> [--tolerance N] [--max-percent P] [--out file]
ratchet visual record <subject> --route <url> [--file <png>] [--viewport WxH]
                       [--tolerance N] [--max-percent P] [--wait-ms ms]
```

Every command accepts `--home <dir>` and `--json`. Row ids are
content-addressed; any unambiguous prefix works where an id is expected.

## Visual regression — behavior snapshots in pixels

Visual pins are the first live behavior snapshot. A subject whose check ends
in `node {path}/dist/src/visual-cli.js <subject>` treats whatever the check
pushed to the corpus as pixels to be reproduced:

```json
{
  "subjects": {
    "home-page": {
      "check": "node C:/dev/app/ratchet/dist/src/visual-cli.js home-page",
      "owns": ["test/ui/screenshot.js"],
      "timeoutMs": 120000
    }
  }
}
```

A visual row's input is a spec like
`{"file":".ratchet-visual/home.png"}` (your own screenshot tool wrote it) or
`{"route":"http://localhost:5173/","viewport":1280x800}` (the probe shoots it
itself with whatever Playwright **or** Puppeteer the project installed — the
first one wins, and neither is a ratchet dependency). The row's baseline is
the PNG at `.ratchet/visual/<row-id>.png`; the check, on every `verify`,
shoots again and pixel-diffs:

- **Zero runtime dependencies.** The PNG codec + diff is
  [src/visual.ts](src/visual.ts) — Node's `zlib` is the only primitive.
  8-bit RGBA/grayscale/palette/16-bit input is decoded; the diff reports
  changed pixels, percent, bounding box, and max channel delta; a review
  render is written at `.ratchet/visual/<id>-diff.png` (plus `<id>-actual.png`)
  whenever a row goes red. Both are gitignored by `init`.
- **The witness is the diff.** "visual diff: 1.37% of 307,200 pixels (9,432,
  bbox 96x34 at (220,158), max delta 187)" — normalized, it is just another
  failure signature, so cause-preservation and drift detection work for
  pixels exactly as they do for values.
- **The ceremony is unchanged.** The baseline goes red when the UI moves. If
  the move was intended: `ratchet accept <id> --reason "..."` retires the
  row, `ratchet visual record <subject> ...` re-pins it — a capture that
  re-activates the row, keeping the old baseline's hash in the audit trail.
- **Integrity is mechanical.** `ratchet fsck` hashes each `visual/` baseline
  against the hash recorded in the corpus and complains about a missing or
  edited file — a pin that drifted without a ceremony is corruption, not a
  design decision.
- **A pin has no witness until it goes red.** Recording captures the pixels,
  not a failure message — the row is born without a `signature`, so drift
  reporting starts at the first real diff. That is the honest shape of an
  expectation that was never observed failing.

`ratchet visual diff <a> <b>` is the same comparison, standalone — useful
in CI scripts and for reviewing that diff artifact everywhere.

## Config

`.ratchet/config.json` maps subjects to check commands:

```json
{
  "subjects": {
    "roundtrip": {
      "check": "node check.js roundtrip",
      "captureProperty": "roundtrip"
    },
    "suite": {
      "check": "npm test",
      "shell": true
    }
  }
}
```

- `check` — a command that reads one input as JSON on stdin and exits 0
  (pass) or nonzero (fail). **Stdout is the failure reason, and it is load-
  bearing** — see "The witness" below.
- `captureProperty` — binds a fast-check property name to this subject.
- `shell` — run `check` through a shell. Off by default.
- `timeoutMs` — per-subject timeout. Default 30000.
- `owns` — files whose contents define this subject's rule (see below).

### How checks are executed

By default the command is tokenized (quotes group, backslashes stay literal)
and spawned directly with no shell, so nothing substituted into it can become
syntax. A check containing `{test}` gets the test name as **exactly one argv
element**; the name is also exported as `RATCHET_TEST`.

Set `"shell": true` for pipes, `&&`, or a `.cmd`/`.bat` entry point. The
command string is then your own committed config, at the same trust level as
a Makefile target — but the test name is still never interpolated into it, so
`{test}` is refused in shell mode and the check must read `RATCHET_TEST`.

### The frozen instrument

A check written as `node check.js` runs whatever `check.js` the checked-out
tree contains — which means replay measures each commit with that commit's own
instrument, and readings across history are not comparable. Writing it as
`node {home}/tools/probe.js` instead resolves `{home}` to the ratchet home,
which history commands carry *out* of the working tree. The same script then
measures every commit. `RATCHET_HOME` is exported to every check for the same
purpose.

## Capture sources

- **fast-check** — a custom reporter writes `ratchet-capture.json` on failure
  (`demo/setup.js` generates a working one); `ratchet capture` reads it.
- **JUnit XML** — `<failure>` and `<error>` test cases become rows keyed by
  test name. CDATA bodies, message-less failures, entity references, and
  single- or double-quoted attributes all parse; `classname` no longer
  shadows `name`.
- **TAP** — `ratchet capture results.tap` reads TAP v12/v13 (what
  `node --test --test-reporter=tap` and most Perl-family runners emit).
  The failure's diagnostics (`error:`/`message:` keys) become the row's
  displayed reason; `# SKIP`/`# TODO` directives are not failures.
- Anything else: hand-write the capture JSON shape and capture it.

The witness that *enforces* a row always comes from the check's own output —
that is what `verify` compares against. When a check prints nothing (its
reason degrades to `exit <n>`), the parsed JUnit/TAP text still fills the
row's displayed reason, while the signature stays check-derived so drift
detection stays honest.

Every capture, from every source, goes through the same gate:

1. **Discrimination.** The counterexample must reproduce against the current
   code. One that already passes is skipped, never stored.
2. **Configured subject required.** A binding whose subject has no `check`
   is reported and dropped, not stored — an unverifiable row would otherwise
   fail forever with "no subject config", reddening the build over a config
   gap rather than a regression.
3. **Cause-preserving reduction.** Array, string, and number inputs are
   minimized (ddmin), but a smaller input is only accepted if it fails the
   *same way*; the reduced input is re-confirmed before storage.
4. **Dedup by content, split by status.** An identical active row is a
   duplicate. An identical *archived* row is a recurrence, and is reported
   loudly with a nonzero exit — see the ceremony below.

## The witness

Each row stores a normalized signature of the failure it was captured for
(`exit:1|expected <n>, got <n>`). It is what keeps reduction honest, and
`verify` uses it to flag a row that is failing for a reason other than the
one it was created to watch:

```
✗ c398849eeeec4 s 1000 — divide by zero  [!] different failure than the one captured
```

A check that prints nothing on failure degrades to `exit:<code>`, which is a
much weaker guarantee. Printing why you failed is what buys the strong one.

## The three outcomes

A check exits 0 to pass and nonzero to fail. It may also exit **125** to say
*not applicable at this commit* — the third outcome, borrowed from
`git bisect skip`:

```
✓ c87cb67944d6f s
✗ cfd1f483d53bf s 13 — unlucky
− c74cef33855a7 s 7 — n/a: feature absent at this commit

2/4 rows pass, 1 failing, 1 n/a
```

`na` is neither a pass nor a failure and does not fail the build, which is
what replay across history needs: a check that cannot apply to a 2019 commit
should not be scored as a bug there. A check that cannot be *spawned* stays a
failure — that is indistinguishable from a broken config, and silently
greening it would be the false pass this tool exists to prevent.

## Integrity

`ratchet fsck` reports unreadable lines, orphaned accept/reopen events,
subjects with no configured check, and rows whose id does not match their own
content. That last one is only possible because ids are content-addressed: a
hand-edited or corrupted row is mechanically detectable.

`verify` refuses to run at all against a corpus with unreadable lines — a row
hidden behind a parse error is a false pass — and names the line.

## The owning rule, and quarantine

A corpus row is only meaningful relative to the instrument that produced it.
Each row records the hash of its owning rule — the check command plus the
contents of whatever files the subject declares it `owns`:

```json
"galaxy-structure": {
  "check": "node {home}/tools/probe.js galaxy-structure",
  "owns": [".ratchet/tools/probe.js"]
}
```

| | row fails |
|---|---|
| rule unchanged | **hard block** — this is a regression |
| rule edited since capture | **quarantine** — routed to review, does not fail the build |

When the heuristic moves, the quality-control analysis moves with it, and a
failure no longer cleanly means the code regressed. Two ways out, both on the
record: `ratchet reaffirm <id>` re-pins the row to the current rule (the
expectation still stands), and `ratchet accept <id>` retires it (it does not).
What is never allowed is re-deriving the expectation silently.

## The accept ceremony

A failing active row is a hard block — `ratchet verify` exits 1. When the
behavior changed on purpose, `ratchet accept <id> --reason "..."` retires the
row: it stops enforcing, the audit trail keeps every event, and the reason is
journaled.

Accepting says "this behavior is intended *now*", not "never mention this
input again". If the same counterexample fails again later, `capture` reports
it as a recurrence — citing who retired it and why — and exits nonzero.
`--reopen` puts it back into enforcement and journals that decision.

## Replay across history

`ratchet replay --good <ref> [--bad <ref>]` runs today's checks against
historical commits and reports the pass/fail curve. Dense replay does not
scale past small repositories, so a sampling policy comes first and halving
closes the window:

```
$ ratchet replay --good v1.0 --every week --subjects --setup "npm ci"
replay: 14 of 312 commits (one per week)
environment: node v20.9.0 on win32/x64

  ✓ 4abc1d54  2026-03-01  5 pass, 0 fail  ...
  ✗ 9f53b4d2  2026-03-08  4 pass, 1 fail  widescreen refactor
  ...
transition between 4abc1d54 and 9f53b4d2, halved in 3 probes:
  first bad commit: 9f53b4d2  widescreen refactor
```

- `--every N` samples every Nth commit; `--every day|week` takes the first
  commit in each period; dense is the default.
- `--jobs N` probes up to N commits concurrently, each on its own worktree
  (one checkout per worktree, so probes on a session are serialized while
  sessions run in parallel). The report comes back in commit order either
  way.
- `--subjects` replays the configured subjects rather than the corpus rows.
  A corpus row is a counterexample that must not fail again; a subject is a
  standing invariant, which has no counterexample while it holds. Both are
  the same check contract pointed at history.
- `--setup "npm ci"` prepares each worktree. A setup failure is reported as
  `na-env`, not as a failure: an old tree that today's toolchain can no
  longer build is dependency rot, not a regression. The environment each run
  happened under is recorded alongside the results.

The honest limit: replay answers "does this commit pass today's checks under
today's environment", not "what did this commit do at the time". Run it inside
a pinned CI image for its era if you need the latter.

## Validating a subject

> Every subject must be proven to fail on at least one known past bug before
> it can be captured from. A subject that passes through history's known bugs
> is too weak.

```
$ ratchet validate galaxy-structure --known-bad 9f53b4d --known-good HEAD
subject: galaxy-structure  (rule fd592028262960d5)
  ✓ known-bad 9f53b4d2 "widescreen refactor" — fails as required: A(m=2) 2.8e-3 at the noise floor
  ✓ known-good f4a9f846 "..." — passes as required

validated — proof recorded in the journal against this rule hash
```

The proof is tied to the rule hash it was proven under, so editing the check
invalidates its own validation. This is the mechanical answer to "who checks
the checkers"; as a convention rather than a command it erodes on the first
busy afternoon.

## Bisect (retroactive replay)

`ratchet bisect <id> --good ref --bad ref` binary-searches the commit range
and reports the first commit where the row fails. It runs entirely inside a
detached `git worktree`: your checkout never moves, a dirty working tree is
fine, and the worktree is torn down even when a probe throws. When the range
contains merges the search follows first-parent, because a binary search over
a non-linear list is not sound. `--setup "npm ci"` runs a command in the
worktree before each probe.

## Layout

```
.ratchet/
  config.json      # subjects → check commands (authored)
  corpus.jsonl     # append-only capture/accept/reopen events (committed)
  journal.jsonl    # append-only decisions (committed)
  .gitattributes   # merge=union for the two JSONL files
  .gitignore       # visual artifacts (*-actual.png, *-diff.png) stay local
  visual/<id>.png  # pin baselines, content-addressed like rows (committed)
```

Row ids are `c` + the first 12 hex of `sha256(subject + input)`. Sequential
ids were allocated from local file state, so two branches both minted `c0001`
and the merge silently dropped one row; content addressing makes id
allocation and dedup the same operation. Events are replayed in timestamp
order, not file order, so a merge that lands an `accept` above its `capture`
still retires the row.

## Self-hosting

The ratchet runs under itself. [`../.ratchet/`](../.ratchet) configures six
subjects over this repository, each a check of the checker, each invoked
through `{home}` so it is carried across history rather than read from the
tree it measures:

| subject | asserts | catches |
|---|---|---|
| `corpus-merge-safe` | two branches' captures both survive a merge | R3 |
| `fold-is-order-independent` | an accept above its capture still retires the row | R4 |
| `reduction-preserves-cause` | a stored row reproduces the bug that was captured | R5 |
| `recurrence-is-visible` | an accepted row's return is surfaced, not deduplicated | R2 |
| `stringify-injective` | distinct values never share a dedup key | R20 |
| `visual-diff-is-sound` | codec round-trip, 1-px diff at the right place, deterministic render | — |

The sixth subject has no historical bug — the visual diff is new in v0.5 —
so its validation comes from the codec cross-checks in the test suite instead.

All five are validated against `4abc1d5`, the last v0 commit, where those bugs
actually lived. Replayed across this repository's own history:

```
$ ratchet replay --good 4abc1d5^ --subjects --setup "node .ratchet/tools/build.js"
  ✗ 4abc1d54  ratchet experiments                     0 pass, 5 fail
  ✗ 0d710eb0  fix the seven safety defects (v0.2)     4 pass, 1 fail
  ✓ f4a9f846  close the remaining issues (v0.3)       5 pass, 0 fail
```

The one still failing at v0.2 is `stringify-injective`, which is R20 — fixed in
v0.3. The replay reconstructs the fix history without being told it.

**And the corpus is not empty anymore.** Those five defects are captured as
rows: checked out `4abc1d5` in a worktree, ran `ratchet capture` against the
carried home (discrimination reproduced each failure twice at the commit
where it lived), then `reaffirm`ed the rows to today's instrument — so
`ratchet verify` runs five rows against this repository on every commit, and
a re-introduced R2/R3/R4/R5/R20 is a hard block. `ratchet report` shows the
memory: five rows, all active, all passing at HEAD. Capturing the same
counterexamples at `0d710eb` produced four "not reproducible — check passes
now" skips and one "already in corpus" — the same gate that built the corpus
verifies its own fix history.

Two of these five subjects failed their own validation on the first attempt:
they tested `minimize` and `foldRows` in isolation, while the defects lived in
the *capture* path that calls them, so they passed straight through the bug.
That is the protocol working as intended.

## Build & test

```
npm install
npm run build
npm test
```

62 tests, including one regression test per defect closed from the v0 review
plus the visual codec/diff/loop tests. The demo is generated by
`node demo/setup.js`; see [demo/README.md](demo/README.md).

## What this prototype still leaves out

From the design in [../RATCHET.md](../RATCHET.md), still absent:

- **Mode 2, mine** — `ratchet history` walking test-file history to resurrect
  deleted and weakened assertions as corpus rows.
- **Mode 3, semantic history** — behavioral diff between any two commits.
- **Sampled behavioral diffs** beyond the visual pins (corpus + boundary
  catalogue snapshot sets).
- **Metric budgets** in their baseline-relative form, and static checks.
- The PR bot and agent attach. `--json` exists; nothing consumes it yet.
