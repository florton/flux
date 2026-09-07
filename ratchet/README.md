# Ratchet — v0.8 prototype

Regression memory for AI-assisted development. The design sketch is
[../RATCHET.md](../RATCHET.md); this folder is the working implementation.

> **Status.** All 21 issues from the v0 review
> ([../ISSUES_RATCHET.md](../ISSUES_RATCHET.md)) are closed, and v0.4 closed
> the design gaps that remained after them: owning-rule hashes and quarantine,
> the second confirmation run, `ratchet replay` with sampling and halving,
> `ratchet validate`, and self-hosting. v0.5 added the first *behavior
> snapshot*: visual pins — screenshots become corpus rows, with a
> zero-dependency PNG diff as the check's witness. v0.6 worked the adoption
> gaps: the ratchet's own corpus is populated, capture gained a TAP source and
> a hardier JUnit parser, `replay` probes history on parallel worktrees, and
> `report` rates failure signals as caught-by-corpus vs. novel.
>
> **v0.7 makes the heuristic the cheap unit of work.** A heuristic is now
> *data* — prose in a closed vocabulary, in `.ratchet/heuristics.rules`, run by
> a bundled probe with a bundled seeded-RNG preload. Validation became a
> **capture gate** rather than a convention. `ratchet guard` and
> `ratchet hooks install` make the whole thing **self-enforcing**, the way a
> TypeScript build is. `ratchet adopt` arms a new heuristic against the history
> it was written for in one command. `ratchet heuristics log` reads a
> heuristic's change history out of git, and a quarantine now shows **which
> clause moved**. 153 tests.
>
> **v0.8 puts the corpus where the bugs are.** Measuring why the tool's own
> gate stayed green through ten of its own defects showed that all six
> self-hosted subjects checked a *data structure*, while sixteen of the
> twenty-one v0 defects sat at the process boundary, on the CLI surface or in
> an error path. Three new subjects cover those classes: an end-to-end CLI
> driver, an error-path prober over every command the binary lists, and static
> uniformity invariants over the source — the only mechanism that catches a
> mechanism wired into some of its call sites and not others. Writing them
> found four more defects, including one in `adopt` that made every buildable
> subject look flaky. 159 tests.

Zero runtime dependencies. Zero model calls. The corpus is plain JSONL; the
journal is plain JSONL; the heuristics are plain text; everything is a file git
already knows how to commit, diff and merge.

## A heuristic, in full

```
heuristic basic-edge
  run      node tools/simulate.js --hands 200000
  seed     20260906
  measure  edge  the number after "house edge:"
  rule     edge is between -0.03 and 0.015
  because  the published basic-strategy table puts this near -0.005
```

That is a complete, enforcing subject. There is no glue file, no script, no
reporter to wire up. When it fails, it says what it measured:

```
✗ c74c11d9f4cf1 basic-edge — edge measured -0.0564, rule says "edge is between -0.03 and 0.015"
    because: the published basic-strategy table puts this near -0.005
```

**Why prose is the default form.** Every subject through v0.6 was a
host-language script, and the field experiments
([../EXPERIMENTS_RATCHET.md](../EXPERIMENTS_RATCHET.md)) found the check bugs
living in exactly that hand-written plumbing: a `matchAll` off-by-one, a
character class that matched the "e" in "percent", a null stdout crash, a
`yarn` vs `yarn.cmd` spawn failure. None of those bugs were in the *heuristic*.
They were in the instrument built to express it. A band written as a sentence
has nowhere to put a bug of that class.

The second reason matters more: the person who knows that the house edge should
be near −0.005 is not always the person who writes Node. A specification only a
programmer can touch decays into a second copy of the code.

**Scripts remain the base case.** `.ratchet/config.json` still takes a check
command, exactly as before, and that is the right home for anything needing
arbitrary computation — the ratchet's own six self-hosted subjects are scripts,
because simulating a branch merge is not a sentence. Both forms produce
subjects that are indistinguishable to everything downstream.

### Writing one: authoring is loose, storage is canonical

You do not have to remember that the vocabulary says `is above` and not
`is greater than`. Write it however it comes out and run `ratchet fmt`:

```
$ ratchet fmt
2 clause(s) snapped to the vocabulary:
     5 | the edge should be greater than -0.03
       | edge is above -0.03
     6 | edge must be less than 0.015
       | edge is below 0.015

wrote heuristics.rules — commit it, so the clauses that are checked are the clauses that are reviewed
```

Every rewrite is a deterministic table lookup — synonyms, operator spellings,
modal verbs, articles. **Nothing is guessed and no model is consulted**, so
`fmt` runs unattended in a build (`ratchet fmt --check` exits nonzero when the
committed file is not canonical). What the table cannot resolve is a compiler-
style error, never a silent reinterpretation:

```
heuristics.rules:6:12: "is abov" is not a comparison
   6 |   rule     edge is abov -0.03
     |            ^
     did you mean `is above`?
```

A tool that quietly decides you meant `is above 5000` and guesses wrong is the
same failure as a model in the oracle: it changes what the spec says without
anyone reading a diff.

### The vocabulary

Fixed by the tool, not per project.

| Clause | Means |
|---|---|
| `run <command>` | the instrument: what produces the observation |
| `measure <name> <how>` | bind a name to a value read out of the output |
| `rule <name> <predicate>` | **checked**: what must be true of that value |
| `note <text>` | prose only, never checked, never counted as a rule |
| `because <text>` | why this matters — quoted back on every failure |
| `seed <n>` | seed `Math.random` in the instrument and anything it spawns |
| `timeout <ms>` | per-heuristic timeout. Default 30000 |
| `owns <path>` | a file whose contents are part of this rule's identity |
| `applies when <path> exists` | report n/a where that path is absent |

Ways to read a value:

| Extractor | Reads |
|---|---|
| `the number after "LABEL"` | the first number following that text in stdout |
| `the json field a.b.c` | parse stdout as JSON, follow a dotted path |
| `the count of lines matching "TEXT"` | how many output lines contain it |
| `the exit code` | the instrument's own status |
| `the output` | all of stdout, trimmed |

Ways to check one: `is` · `is not` · `is one of A, B, C` · `is above N` ·
`is below N` · `is at least N` · `is at most N` · `is between N and M` ·
`is within P percent of N` · `contains "S"` · `does not contain "S"` ·
`starts with "S"` · `ends with "S"` · `is empty` · `is not empty` ·
`is a number` · `is the same as <other measure>`.

**A `note` is not a rule.** It is prose the vocabulary cannot express, it is
never checked, and it is excluded from every rule count — listed as
`(prose only, never checked)` so it is never mistaken for a guarantee. A
heuristic with *no* rule is a parse error: a check that cannot fail is a green
light over nothing.

### What the tool refuses to let you get wrong

These are errors, not warnings, because each one is a heuristic that looks like
it is working and is not:

- **A clause that does not parse.** Every command refuses to run, naming the
  line and column. Carrying on with the heuristics that happened to parse would
  mean a mistyped clause silently stops enforcing while the build stays green.
- **A heuristic with no `rule`.** It can never fail.
- **A rule over a measure that does not exist**, or `is the same as` naming a
  measure the heuristic does not take.
- **An empty band** (`is between 5 and 1`).
- **A measure the instrument stopped producing.** The rule fails — loudly, once
  per broken instrument rather than once per rule — with what the command
  actually printed:
  `edge could not be measured: no "house edge:" in the output — the command printed: "all good"`.
- **A nonzero exit from the instrument**, unless the heuristic explicitly
  measures `the exit code`. Reading numbers out of a crashed command is reading
  noise.

### Determinism: `seed`

A band over an unseeded simulation is measuring noise. `seed 20260906` sets
`RATCHET_SEED` and injects a seeded `Math.random` into the instrument and
everything it spawns. Two honest limits, both worth knowing before trusting a
band: it seeds `Math.random` only (not `crypto`, not the clock, not a library's
own generator), and it reaches Node processes only — anything else gets
`RATCHET_SEED` in its environment and nothing more.

## Running against a local repo

1. Build once: `cd ratchet && npm install && npm run build`
2. `alias ratchet="node /path/to/ratchet/dist/src/index.js"`
3. In the target repo: `ratchet init`
4. Write a heuristic in `.ratchet/heuristics.rules` — a `run` command, a
   `measure`, and a `rule`. `ratchet fmt` snaps loose wording to the
   vocabulary. For anything needing arbitrary computation, add a scripted
   subject to `.ratchet/config.json` instead: a `check` command that reads one
   input as JSON on stdin and exits 0 (pass) or nonzero (fail).
5. `ratchet adopt <name> --good <an-old-ref>` — prove it against your own
   history and arm it in one step.
6. `ratchet hooks install` — make it enforce on every commit.
7. Optionally wire capture to your test runner: a fast-check reporter
   (`demo/setup.js` generates a working one), CI's JUnit XML, or a TAP stream.

Steps 4-6 are the loop. Everything else in this README is detail on one of
them.

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

## Self-enforcement: `ratchet guard`

Every guarantee up to v0.6 needed a human to remember a different command:
`verify` for rows, `fsck` for integrity, `fmt` for the rules file, `validate`
before trusting a subject. A guarantee that needs remembering is a guarantee
that lapses on the first busy afternoon. `tsc` does not ask you to remember to
typecheck.

So: one gate, one exit code, four questions.

```
$ ratchet guard
✓ heuristics canonical 3 heuristic(s), canonical
✓ integrity            corpus and journal readable, ids match their content
✗ rows                 0/1 rows pass, 1 failing
  ✗ c74c11d9f basic-edge — edge measured -0.0564, rule says "edge is between -0.03 and 0.015"
  run `ratchet verify` for the full witness, or `ratchet show <id>` for one row's history
✓ validation           all 3 subject(s) proven against a known bug

guard failed: rows
```

| Step | Fails the build | Because |
|---|---|---|
| rules file parses | **yes** | a clause that stopped parsing is a check that stopped running |
| rules file is canonical | warning | formatting is not a regression |
| corpus integrity | **yes** | a row hidden behind a parse error is a false pass |
| active rows hold | **yes** | this is the regression gate |
| gate is mostly `na` | warning | green while checking almost nothing |
| every subject validated | warning (`--strict`: yes) | caught harder at `capture`, below |

### Wire it into git

```
$ ratchet hooks install
pre-commit runs: ratchet guard --quiet
```

The installer never overwrites a hook it did not write — an existing
`pre-commit` is a colleague's work, and clobbering it to install a quality gate
would be its own small regression. It appends inside markers, and
`ratchet hooks uninstall` removes exactly that block. When `ratchet` is not on
PATH it pins the interpreter and entry point that are running, and says so, so
the hook does not die with "command not found" for reasons that have nothing to
do with your code.

A hook is advisory — `--no-verify` exists, and a fresh clone has no hooks — so
CI runs the same command. A committed workflow is in
[ci/github-actions.yml](ci/github-actions.yml).

## Validation is a gate, not a ritual

> Every subject must be proven to fail on at least one known past bug before it
> can be captured from. A subject that passes through history's known bugs is
> too weak.

`ratchet validate` has existed since v0.4, and nothing made anyone run it. Now
`capture` refuses:

```
$ ratchet capture junit.xml
not captured: "basic-edge" has never been proven to fail on a known bug, so a row
from it would be a green light over nothing.
    prove it:  ratchet validate basic-edge --known-bad <sha> --known-good HEAD
    or adopt it against your own history:  ratchet adopt basic-edge --good <old-ref>
    first use of a brand-new subject:  re-run with --allow-unvalidated (journaled)
```

Capture is the cheapest place to catch a vacuous check: after that the corpus
carries a permanent green light over nothing. It is also the load-bearing
safety mechanism for *generated* coverage heuristics, which arrive in bulk and
are exactly the kind that pass through every bug.

The proof is recorded against the rule hash it was proven under, so **editing a
check invalidates its own validation**. "Validated once" never means "trusted
forever".

`--allow-unvalidated` is the escape hatch for a subject's very first use, and
it is journaled once per subject — the exception goes on the record rather than
into somebody's shell history.

## `ratchet adopt` — arming a heuristic against the history it was written for

A heuristic is born the moment somebody notices something worth watching, which
is almost always *after* the bug it describes. Arming it used to mean a manual
worktree dance: check out the bad commit, build it, capture against a carried
home, come back, reaffirm. That was six commands, and it was the actual
procedure used to populate this repository's own corpus.

```
$ ratchet adopt basic-edge --good v1.0
subject: basic-edge  (rule a52368a31f69b838)
  ✗ 9b719276  score pushes as losses (the bug)   edge measured -0.0564, rule says "edge is above -0.03"
  ✗ 1ab36ae8  tidy                               edge measured -0.0564, rule says "edge is above -0.03"
  ✓ e4a39171  fix push scoring
  ✓ dcc825e5  adopt the basic-edge heuristic

first failing probed commit: 9b719276 "score pushes as losses (the bug)"
  witness: edge measured -0.0564, rule says "edge is above -0.03"
captured c74c11d9f4cf1 pinned to the current rule — `ratchet verify` enforces it from now on
validated: it fails where the bug lived and passes where it was fixed
```

One command, and the heuristic is born validated, immediately enforcing, with
its fix history already drawn. Failing where the bug lived and passing where it
was fixed *is* the validation protocol, observed rather than asserted, so the
proof is written and the capture gate opens.

It refuses to store a heuristic that fails once and passes on the confirmation
run — a flaky row reddens every future build — and it tells you when a
heuristic passes at every commit in the range, which means either the history
never had the problem or the heuristic is too weak to see it.

`--every N` samples, `--setup "npm ci"` prepares each worktree, `--dry-run`
reports without writing.

## Editing a heuristic

An edit is an ordinary text edit: open the file, change the band, commit. The
consequences are already handled by the quarantine rule — a row pinned to the
old rule stops enforcing until someone decides. What v0.7 adds is the sentence:

```
$ ratchet verify
? c74c11d9f4cf1 basic-edge — quarantined: edge measured -0.0564, rule says "edge is above -0.01"
    the heuristic changed since this row was captured (dcc825e "adopt the basic-edge heuristic"):
    - rule edge is above -0.03
    + rule edge is above -0.01
    review, then `ratchet reaffirm c74c11d9f4cf1 --reason "..."` (the expectation stands)
    or `ratchet accept c74c11d9f4cf1 --reason "..."` (it does not)
```

"rule fd59… became a3b1…" tells a reviewer nothing. The clause that moved, and
the commit that moved it, tells them everything.

The history comes from git, not from a ledger the ratchet has to keep in sync:

```
$ ratchet heuristics log basic-edge
29aa612  2026-09-06  Alice  widen the edge band: -0.03 was tighter than the table justifies
  rule e9b80de087dd26e8
  - rule edge is above -0.03
  + rule edge is above -0.08

dcc825e  2026-09-06  Alice  adopt the basic-edge heuristic
  rule a52368a31f69b838
  + heuristic basic-edge
  + rule edge is above -0.03
  ...
```

Commits that touched the file without changing *this* heuristic are collapsed
away, so the list is the times it actually moved. It works retroactively on
history recorded before the command existed, because the source is the
repository.

**A cosmetic edit is not a change of expectation.** The rule hash is taken over
canonical *content*, not layout, so re-aligning the file or running `fmt`
quarantines nothing. If it did, people would stop touching the file.

## Which heuristics still earn their keep

The caught/new split says what *did* fail. Nothing said which heuristic stopped
producing evidence — and a heuristic guarding a stable invariant looks
identical, from outside, to one that broke six months ago.

```
$ ratchet yield
  basic-edge          3 rows (2 active)  last evidence 4d ago     [prose, validated]
  galaxy-structure    1 row  (1 active)  last evidence 240d ago   [prose, validated]
  deck-integrity      0 rows (0 active)  no evidence yet          [script, UNVALIDATED]

1 subject(s) have never produced a counterexample: deck-integrity
  That is fine for a standing invariant and a warning sign for a heuristic adopted to catch something specific.
1 subject(s) quiet for over 90 days: galaxy-structure (240d)
```

`ratchet report` surfaces the same signals alongside the churn numbers, and
`verify` says out loud when most of the gate reported `na` — a gate that is
mostly not-applicable is green while checking nothing.

## CI: the signal where merges are reviewed

`--json` existed since v0.3 and nothing consumed it. `ratchet pr-comment`
renders the gate as markdown on stdout:

```
$ ratchet pr-comment | gh pr comment --body-file -
```

Rendering and posting stay separate on purpose: a tool that posts needs a
token, a host, an API version and a retry policy; a tool that prints markdown
works on every forge and pipes into a file, a chat webhook, or a build summary.

The comment states the verdict, the failing rows with their witnesses, the
quarantined rows with the command that resolves each, and the caught/new split.
[ci/github-actions.yml](ci/github-actions.yml) also runs the corpus across
`base..merge` — both branches of a merge can be green while their union is not.


## The workflow — preventing regressions with the ratchet

The ratchet is a loop, not a one-time setup. The order below is the order of
leverage; each step names the section that details it.

1. **Write the heuristic, not the instrument.** `ratchet init`, then a
   `heuristic` block in `.ratchet/heuristics.rules` — a `run` command, a
   `measure`, a `rule`. The bundled probe is the instrument, and it lives
   outside the tree it measures, so `replay` and `bisect` measure every commit
   with the same one. Reach for a scripted subject only when the check needs
   arbitrary computation; write it as `node {home}/tools/probe.js <subject>`
   and declare `owns` for the measuring scripts, or it cannot tell you when its
   instrument was edited (see "The frozen instrument" and "The owning rule").
2. **Prove it before you trust it.** `ratchet adopt <subject> --good <ref>`
   runs it across your history, captures the oldest commit where it fails, and
   records the proof — one command. `ratchet validate <subject> --known-bad
   <sha> --known-good <sha>` is the same protocol when you already know the
   commit. A subject that passes through a known bug is too weak to watch
   anything, and **`capture` refuses to store rows from an unproven subject**
   (see "Validation is a gate, not a ritual").
3. **Capture rides the same PR as the fix.** Point a fast-check reporter,
   JUnit XML, or TAP at `ratchet capture` on red CI runs and commit the new
   rows alongside the fix. Discrimination, the confirmation runs, and
   cause-preserving minimization happen at capture — flakes never enter the
   corpus (see "Capture sources").
4. **Gate every commit and every merge with `ratchet guard`.**
   `ratchet hooks install` wires it into pre-commit; the same command belongs
   in CI, because a hook is advisory. Rows are checked in parallel by default
   (`--jobs N` to tune). Rule unchanged and row fails → hard block. Rule edited
   and row fails → quarantine → review, then `reaffirm` (the expectation stands
   under the new instrument) or `accept` (it does not); the quarantine names
   the clause that moved.
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
ratchet init                      create .ratchet/ with a rules and config template
ratchet guard [--strict] [--quiet] [--jobs N]
                                  the one command a build runs: parse, integrity,
                                  rows, validation. Nonzero on any failure.
ratchet hooks install|uninstall|status [--pre-push] [--command "..."]
ratchet heuristics                list the prose subjects, their rules and rows
ratchet heuristics show <name>
ratchet heuristics log <name>     every commit that changed this heuristic
ratchet fmt [--check]             snap heuristics.rules to the canonical vocabulary
ratchet adopt <subject> --good ref [--bad ref] [--every N] [--setup "..."] [--dry-run]
ratchet yield [--stale-after N]   which heuristics still produce evidence
ratchet pr-comment [--title "..."]  the gate as markdown, for CI
ratchet capture <file...>         add counterexamples (fast-check capture JSON, junit.xml, or .tap)
                                  [--reopen] put retired rows back when they recur
                                  [--allow-unvalidated] first use of a new subject
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

Subjects come from two files, merged into one map. `.ratchet/heuristics.rules`
holds the prose ones (above); `.ratchet/config.json` maps the scripted ones to
check commands. A name declared in both is reported by `ratchet fsck` rather
than silently resolved — config.json wins, so adding a rules file never changes
an existing project's behavior underneath it.

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

The ratchet runs under itself, in both forms.

**Six scripted subjects**, each a check of the checker, each invoked through
`{home}` so it is carried across history rather than read from the tree it
measures. These stay scripts on purpose: simulating a branch merge or a PNG
codec round-trip is not a sentence, and pretending otherwise would be the
contortion the prose form exists to avoid.

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

**What those five rows did not cover.** All five are corpus and
data-structure semantics — fold order, id collision, reduction slippage, dedup
partitioning, stringify injectivity. They are the defects a scratch corpus and
a `deepStrictEqual` can reach. Of the twenty-one defects in the v0 review,
sixteen sat at the process boundary, on the CLI surface, or in the error
paths, and none of those had a row: the corpus had been built where it was
easy rather than where the bugs live. The measurement is in
[NEXT_STEPS_V3.md](../NEXT_STEPS_V3.md#the-finding-that-should-shape-v08-the-corpus-is-in-the-wrong-place).
v0.8 closes it with three more subjects, below.

### Covering the classes the corpus was missing

Three subjects, all prose, each running a *frozen instrument* out of `{home}`
so `replay` and `adopt` measure every commit with today's driver rather than
whatever that commit happened to contain.

| Subject | What it drives | Adopted against |
|---|---|---|
| `cli-end-to-end` | 13 scenarios spawning the real binary in real scratch git repositories — `init`, `fmt`, `adopt`, `verify` red with the right witness, quarantine and its prose diff, `reaffirm`, the capture gate, `--home` from a nested directory, `seed`, `guard`, the hook installer | `7a5b36c` (v0.7) |
| `cli-errors-are-messages` | every command in the binary's *own usage*, against a corpus that took a bad merge, an unparseable rules file, and a home that was never initialized | `76865c4` (v0) |
| `source-uniformity` | five static invariants over `ratchet/src` — the only mechanism that catches partial application | `7a5b36c` (v0.7) |

Each was adopted with `ratchet adopt`, so each is validated the same way the
five scripted subjects are: observed failing where a defect actually lived and
passing where it was fixed.

```
$ ratchet adopt cli-errors-are-messages --good 76865c4^ --bad 0d710eb --setup "node {home}/tools/build.js"
  ✗ 76865c48  ratchet v0                              traces measured 12, rule says "traces is 0"
  ✗ 4abc1d54  ratchet experiments                     traces measured 12, rule says "traces is 0"
  ✓ 0d710eb0  Review ratchet v0, then fix the seven safety defects (v0.2)
```

Twelve stack traces across twenty-one command probes at v0, none from v0.2 on:
the R8/R11/R13/R15/R18 error-path defects, reconstructed from history by a
subject written years later.

**Writing them found four more defects, all in the empty rows** — which is the
argument for the whole exercise:

- `verify --home <relative>` from a nested directory reddened *every* row
  (`no heuristics.rules in ../../.ratchet`), because `verify` passed the raw
  flag to a child process with a different working directory while the other
  twenty-one commands resolved it through the one resolver. v0.7's notes had
  called this "not a defect, the shape of one" — checked by hand on an empty
  corpus, where both routes answer `0/0 rows pass` and agree.
- `probe.ts` substituted neither `{home}` nor `{ratchet}`, so a prose
  heuristic could not reach a frozen instrument at all. The mechanism was
  available in `config.json` and nowhere in prose.
- `RATCHET_HOME=""` counted as a home, so `export RATCHET_HOME=` made every
  command fail with a blank where the path should be.
- `adopt` confirmed a failure by checking the bad commit out a second time and
  *did not re-run `--setup`*. Build output is untracked, so the confirmation
  measured whichever commit was built last — every subject with a build step
  was reported flaky and refused, and a failure caused by stale artifacts
  would have been confirmed and stored. Found by `cli-end-to-end` on its first
  run against history, when `adopt` refused to store its row.

The last one is the pattern this repository keeps producing: a mechanism
defined once and wired into some of its call sites. `--setup` had five call
sites and the fifth forgot it entirely. That class has no counterexample —
it is a completeness property over a set of call sites — so it is checked
statically instead:

```
$ node .ratchet/tools/uniformity.js        # at 7a5b36c
VIOLATION home-resolved-once — index.ts reads --home directly in 2 places
VIOLATION spawn-substitutes-tokens — probe.ts observe() does not substitute {home} or {ratchet} in shell mode
VIOLATION spawn-substitutes-tokens — probe.ts observe() does not substitute {home} or {ratchet} in direct mode
VIOLATION setup-runner-is-single — 4 places construct a --setup run (adopt.ts, bisect.ts, replay.ts, validate.ts)
VIOLATION setup-follows-every-checkout — adopt.ts checks out a probed commit 2 time(s) but prepares it 1 time(s)
```

`src/substitution.ts` is now the token vocabulary in one place, `runner.ts`
and `probe.ts` both delegate to it, and `worktree.ts` owns the single
`--setup` runner. The scanner is version-agnostic — an invariant whose
mechanism did not exist at a commit reports `n/a` rather than passing
silently — which is what lets it run across history at all.

**And one prose heuristic more**, in [`../.ratchet/heuristics.rules`](../.ratchet/heuristics.rules):

```
heuristic test-suite
  run      node --test ratchet/dist/test/
  timeout  600000
  applies  when ratchet/dist/test exists
  measure  failing  number after "# fail"
  measure  passing  number after "# pass"
  rule     failing is 0
  rule     passing is at least 159
  because  a suite that shrinks silently is how a ratchet stops ratcheting: the
  because  count is a floor, raised deliberately, never lowered by accident
```

Two measures, two rules, no plumbing. The `passing` floor is the ratchet
applied to the ratchet's own coverage — adding tests keeps it satisfied,
quietly deleting them does not. `applies when` makes it report `na` at commits
that predate the build rather than manufacturing a failure there.

If the prose form could not express the standing invariants of the tool that
ships it, there would be no honest way to claim it expresses anyone else's.

## Build & test

```
npm install
npm run build
npm test
```

159 tests: one regression test per defect closed from the v0 review, the visual
codec/diff/loop tests, the v0.7 additions — canonicalization and its
failure modes, every extractor and predicate, the probe's three outcomes and
its seeding, the capture gate, `guard`, the hook installer, and the
git-sourced heuristic history — and the v0.8 additions: the token vocabulary,
a prose heuristic reaching an instrument that lives only in the home, and
`adopt` preparing its confirmation probe. The demo is generated by
`node demo/setup.js`; see [demo/README.md](demo/README.md).

## What this prototype still leaves out

From the design in [../RATCHET.md](../RATCHET.md), still absent:

- **Mode 2, mine** — `ratchet history` walking test-file history to resurrect
  deleted and weakened assertions as corpus rows.
- **Mode 3, semantic history** — behavioral diff between any two commits.
- **Sampled behavioral diffs** beyond the visual pins (corpus + boundary
  catalogue snapshot sets).
- **Metric budgets** in their baseline-relative form, and static checks.
- The agent attach: dispatching an investigation when a row goes red.

The v0.6 plan — heuristics as data, validation as a capture gate, `ratchet
adopt`, yield reporting, and the merge-landscape glue — is
[../NEXT_STEPS_V2.md](../NEXT_STEPS_V2.md); all five are built in v0.7. What
comes after is [../NEXT_STEPS_V3.md](../NEXT_STEPS_V3.md).
