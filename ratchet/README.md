# Ratchet — v0.10 prototype

Regression memory for AI-assisted development. The design sketch is
[../docs/ratchet/RATCHET.md](../docs/ratchet/RATCHET.md); this folder is the working implementation.
Known defects and accepted trade-offs are in
[../docs/ratchet/ISSUES_RATCHET_V09.md](../docs/ratchet/ISSUES_RATCHET_V09.md).

> **Status.** All 21 issues from the v0 review
> ([../docs/ratchet/ISSUES_RATCHET.md](../docs/ratchet/ISSUES_RATCHET.md)) are closed, and v0.4 closed
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
> subject look flaky.
>
> **v0.9 stops the gate refusing the checks people most want.** Run against
> eight real subjects in two outside repositories, the capture gate turned
> away five of them for never having failed — and the five were the *standing
> invariants*: Monty Hall is 2/3, particle count equals capacity, the mode
> constants index their own table, the tree builds. History cannot tell a
> vacuous check from one whose property has simply never been violated here,
> and it is not the only available evidence. So a heuristic can now declare a
> reading its rules must refuse (`rejects`), the tool **checks** that
> declaration, and a heuristic proven that way enforces as a **standing
> invariant** with no corpus row behind it. History stays the stronger of two
> proofs and both are always named. Alongside: `replay` reports *every*
> transition in a range with its direction rather than the first pass→fail one;
> `guard` says when it is green over nothing and when an instrument lives
> inside the tree it measures; the vocabulary gained the nth match, comparisons
> between two measures, and `needs <path> exists` for "this environment cannot
> run the check here"; and an active row re-failing finally reaches the catch
> rate. 193 tests.
>
> **The cold-start run found the gate lying green.** v0.9's own README was
> read end to end against a throwaway repo, as a new team would read it, and
> the first heuristic written exposed the worst defect this tool has had: a
> bound written in ordinary English was checked as a *string* comparison.
> `latency is under 5` could never hold; `latency is not above 100` — two
> words this README documents — could never fail, so `guard` printed
> `✓ standing 1/1` over a ceiling exceeded by three orders of magnitude.
> Bounds now land on the four comparisons however they are spelled, a negation
> folds into the comparison it negates, and anything the table cannot resolve
> is **refused** with a line and a column rather than guessed. The same run
> found a fresh `ratchet init` warning about the file `init` had just written.
> Both are closed, with the accounts in
> [../docs/ratchet/OUTSTANDING_RATCHET.md](../docs/ratchet/OUTSTANDING_RATCHET.md)
> (R37, R38) and the run itself as experiment 5 in
> [../docs/ratchet/EXPERIMENTS_RATCHET.md](../docs/ratchet/EXPERIMENTS_RATCHET.md).
> 224 tests.
>
> **v0.10 closes the last false green: the subject nothing runs.** `verify`
> enforces active rows *union* standing invariants, so a subject in neither
> set was declared, configured, counted by `validation` as proven — and never
> executed once. It hid a real subject in this repository for four versions,
> and every number the gate printed was true. `guard` now says what is true —
> *nothing runs this* — with advice each kind of subject can actually take,
> and the proof line carries `(nothing runs it)` beside the name it used to
> affirm without qualification. A warning, not a failure: a subject can be
> legitimately between rows. The account is R31 in
> [../docs/ratchet/OUTSTANDING_RATCHET.md](../docs/ratchet/OUTSTANDING_RATCHET.md).
>
> **The same session found R39, one layer down.** Building that reproduction
> meant writing a config, and typing `command` where the schema says `check`
> produced `TypeError: command is not iterable` at the spawn site — which
> `validate` reported as the check *failing as required*, because an instrument
> that cannot run fails at every commit. Three more shapes were accepted in
> silence, and `owns` written as a bare string was walked one character at a
> time, sending the owning-rule hash scanning directories outside the
> repository. A subject's shape is now checked where it is loaded, with the
> subject, the key, the fix, and any near-miss key named. 237 tests.

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
([../docs/ratchet/EXPERIMENTS_RATCHET.md](../docs/ratchet/EXPERIMENTS_RATCHET.md)) found the check bugs
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
| `rejects <measure> <value>` | **checked**: a reading the rules must refuse |
| `rejects output "..."` | **checked**: a whole fabricated output they must refuse |
| `owns <path>` | a file whose contents are part of this rule's identity |
| `applies when <path> exists` | report n/a where that path is absent — *the subject* did not exist yet |
| `needs <path> exists` | report "could not run here" where that path is absent — *the environment* cannot |

Ways to read a value:

| Extractor | Reads |
|---|---|
| `the number after "LABEL"` | the first number following that text in stdout |
| `the 2nd number after "LABEL"` | ...following its 2nd appearance. Any ordinal |
| `the json field a.b.c` | parse stdout as JSON, follow a dotted path |
| `the count of lines matching "TEXT"` | how many output lines contain it |
| `the exit code` | the instrument's own status |
| `the output` | all of stdout, trimmed |

Ways to check one: `is` · `is not` · `is one of A, B, C` · `is above N` ·
`is below N` · `is at least N` · `is at most N` · `is between N and M` ·
`is within P percent of N` · `contains "S"` · `does not contain "S"` ·
`starts with "S"` · `ends with "S"` · `is empty` · `is not empty` ·
`is a number` · `is the same as <other measure>`.

`is above` · `is below` · `is at least` · `is at most` each take **either a
number or another measure of the same run**, so the natural statement of a
Monty Hall check —

```
measure  keep    the first number after "Win percent:"
measure  change  the second number after "Win percent:"
rule     change is above keep
```

— says what it looks like it says. Before, the vocabulary had `is the same as`
and nothing else, so a comparison between two readings could only be written as
equality; the workaround was to band the raw counts and pin the denominator,
which couples a rule that is always true to an iteration count that is free to
change.

**Bounds written the ordinary way land on those four.** `under` and `over`,
`up to`, `at or above`, `no more than`, `exceeds`, `bigger than` — `fmt` snaps
them, and a negation folds into the comparison it negates, because on a total
order `not (x > n)` *is* `x ≤ n`:

```
rule  latency should never be above 100     ->  latency is at most 100
rule  latency must not exceed 100           ->  latency is at most 100
rule  precision is not below 0.75           ->  precision is at least 0.75
```

**What the table cannot resolve, it refuses** — with a line, a column, and the
vocabulary named. `is faster than 5` is refused on purpose: whether "faster"
means a ceiling or a floor depends on what is being measured, and a table that
picked one would be guessing at the only thing the clause is for. Quote a value
to mean it literally: `is "under 5"` compares against that text.

Through v0.9 this was wrong, and wrong in the direction that matters. There was
no `under`, and an unrecognized comparison fell through to the equality
catch-all: `latency is under 5` became a comparison against the *string*
`"under 5"`, which no number equals, so the rule failed forever. `latency is
not above 100` — two words this README documents — became an *in*equality
against `"above 100"`, which every number satisfies, so the rule **passed**
forever and the gate reported the subject green while checking nothing. Both
are now translated or refused; the full account is
[R37](../docs/ratchet/OUTSTANDING_RATCHET.md).

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

**Comments and quoting.** `#` starts a comment at the start of a line or after
whitespace, and a comment runs to the end of the line. Inside a double-quoted
value it is an ordinary character: `line does not contain "debug # verbose"`
names a value containing a `#`, and
`measure tagged count of lines matching " #tag"` matches a hash after a space.

> **Through v0.9 this was wrong, and it was the worst kind of wrong.** The
> stripper had no notion of quoting, so that rule truncated to
> `line does not contain "debug` — a *weaker* rule, which passed against output
> the file plainly forbids. Truncation makes `contains`, `is`, `starts with`
> and `ends with` stricter, so those failed red and got noticed; it made the
> negated forms laxer, and those went green. Worse, `ratchet fmt` wrote the
> truncation back into the file, so the author's original text was destroyed on
> the first format. Now fixed, with a regression test in each direction; the
> repro is R22 in [../docs/ratchet/ISSUES_RATCHET_V09.md](../docs/ratchet/ISSUES_RATCHET_V09.md).
>
> **If your rules file has a `#` inside a quoted value**, that clause is now
> read as written, so its text — and therefore its rule hash — changes. Rows
> armed against the truncated rule quarantine with "the heuristic moved", which
> is correct: the rule genuinely did change, to the one the file always said.
> Re-arm them once you have read the clause. Check with `ratchet heuristics`,
> which prints each rule as it will be enforced.

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
5. Prove it can fail. **Two routes, and which one applies is a fact about your
   repository, not a preference:**
   - Your history contains the bug this heuristic is about:
     `ratchet adopt <name> --good <an-old-ref>` arms it against that history in
     one step. The stronger proof — it failed where a real defect lived.
   - It does not — the property has simply always held here, which is the
     normal case for a *quality* number on a healthy codebase. Add a
     `rejects <measure> <a value the rules must refuse>` line. The tool
     **checks** the declaration, and the subject then enforces as a standing
     invariant with no corpus row behind it.

   Reaching for `adopt` on a repo with no such bug is the common first
   mis-step; it exits 1 (`no commits between HEAD and HEAD` on a young repo)
   and there is nothing to fix, because there was never a failure to arm
   against.
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

So: one gate, one exit code.

```
$ ratchet guard
✓ heuristics canonical 3 heuristic(s), canonical
✓ integrity            corpus and journal readable, ids match their content
✗ rows                 0/1 rows pass, 1 failing
  ✗ c74c11d9f basic-edge — edge measured -0.0564, rule says "edge is between -0.03 and 0.015"
  run `ratchet verify` for the full witness, or `ratchet show <id>` for one row's history
✓ standing             1/1 standing invariants hold
! validation           1 subject(s) have no proof they can fail: screenshot-pins
    prove one against history:   ratchet validate screenshot-pins --known-bad <sha> --known-good HEAD
    or without it, in the rules: rejects <measure> <a value the rules must refuse>
    8 validated against history: cli-end-to-end, cli-errors-are-messages, ...
    1 validated against a declared counterexample: test-suite

guard failed: rows
```

| Step | Fails the build | Because |
|---|---|---|
| rules file parses | **yes** | a clause that stopped parsing is a check that stopped running; a `rejects` line the rules accept is one of the ways it can stop |
| rules file is canonical | warning | formatting is not a regression |
| every subject has a runnable shape | **yes** | a subject `config.json` cannot spawn is a check that has stopped enforcing; refused here so it does not reach the spawn site as a TypeError |
| corpus integrity | **yes** | a row hidden behind a parse error is a false pass |
| active rows hold | **yes** | this is the regression gate |
| standing invariants hold | **yes** | a property that has always held here does not any more |
| no armed rows at all | warning | green over nothing: subjects declared, none enforcing |
| a subject nothing runs | warning | declared, proven, and never executed: no active row and no declared rejection |
| a heuristic block that is shadowed | warning | `config.json` declares the same name and wins, so the prose parses, is counted, is listed — and never runs |
| an instrument no subject owns | warning | its contents are outside the rule hash, so rewriting it re-points every row it armed |
| gate is mostly `na` | warning | green while checking almost nothing |
| instrument inside the tree | warning | correct at HEAD, wrong under every history command |
| anything else `fsck` finds | warning | `guard` surfaces `fsck`'s warnings; a finding only one command prints is a finding nobody reads |
| every subject proven | warning (`--strict`: yes) | caught harder at `capture`, below |

The last five are the shapes of *green over nothing*, and each of them reads as
success while checking less than it appears to. None is hypothetical. A defect
in this repository was written down as "not a defect, the shape of one" because
the check that would have caught it ran against an empty corpus where the two
routes it compared both answer `0/0 rows pass`; one of the two field
experiments claimed a frozen instrument in its write-up while pointing at an
untracked script inside the tree it measured; and the newest of the five, in
v0.10, hid a subject of this repository's own for four versions — `verify`
enforces active rows *union* standing invariants, and a subject in neither set
was counted as proven while nothing ever ran it. That one is a warning rather
than a failure, because a subject can be legitimately between rows; what it
must not be is silent.

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

## Two proofs that a check can fail

> Every subject must be proven to fail before it can be captured from. A
> subject that passes through history's known bugs is too weak.

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

### The second tier: a declared counterexample

Until v0.9, proof meant proof *from history* — which turned away a check that
has never failed because the property it guards has never been violated. That
is the *standing invariant*, and it is the most valuable kind of check there
is. Re-running the field experiments against v0.8 refused **five of eight**
real subjects on those grounds: Monty Hall is 2/3 whatever a repository's
history says, particle count must equal capacity, the mode constants must index
their own table, the tree must build.

The proxy was measuring the wrong thing. The gate exists to refuse a *vacuous*
check — one with no power to discriminate — and "did it fail somewhere in
history" conflates that with a check that discriminates perfectly well and has
simply never been given the chance. History cannot tell them apart, and it is
not the only available evidence.

Since v0.7 a heuristic is *data*: the rules are pure predicates over named
measures, so they can be evaluated against a hypothetical reading with no
process, no git and no clock. So a declared rejection costs nothing:

```
heuristic monty-hall
  run      node deal.js
  measure  keep  the number after "Keep wins:"
  rule     keep is between 3200000 and 3500000
  rejects  keep 5000000
  because  Monty Hall is 1/3 keep and 2/3 switch, an outside truth that does
  because  not depend on any of this code being right
```

`rejects` is a **claim the tool checks**. Evaluate the rules against that
reading; if they accept it, that is a hard error naming the line and the
column:

```
heuristics.rules:5:11: you declared that "monty-hall" rejects keep = 3300000, and
every rule accepts it ("keep is between 3200000 and 3500000")
   5 |   rejects  keep 3300000
     |           ^
```

A proof that does not prove anything is caught the same way a clause that does
not parse is. There is a stronger optional form for when the extractor is the
risky part — `rejects output "Keep wins: 5000000"` runs the whole pipeline,
extraction and judgment both, against a fabricated instrument output — and a
fabricated output that the *extractors* cannot read is refused too, because
"the extractor found nothing" is not evidence that the band discriminates.

**What each proof establishes, and what it does not.** A declared rejection
proves the rule discriminates; any successful run proves the extraction works.
Together they refute vacuity without a bug ever having happened. What they do
**not** prove, and what history does, is that the check catches a mistake a
human actually made. So the two are *ordered*, not equivalent, and the tool
never prints a bare "validated" again:

```
$ ratchet yield
  cli-end-to-end   1 row  (1 active)  evidence today   [prose, validated against history]
  test-suite       0 rows (0 active)  no evidence yet  [prose, validated against a declared counterexample, standing]
  screenshot-pins  0 rows (0 active)  no evidence yet  [script, UNVALIDATED]
```

Neither does a declared rejection move the rule hash. It changes nothing about
what is measured or how a reading is judged, so folding it into the hash would
quarantine every row in a repository the moment somebody strengthened a proof —
punishing exactly the behavior the second tier exists to invite. It is re-checked
on *every* load instead, which is the stricter guarantee.

### The standing invariant

A heuristic proven by a declared rejection enforces **as itself**, with no
corpus row:

```
$ ratchet guard
✓ rows        8/8 rows pass
✓ standing    1/1 standing invariants hold
```

The corpus is memory of *counterexamples*: a row says "this exact input once
broke, and never again". A standing invariant is not a counterexample and is
not made into one. Minting a synthetic row from the declared rejection would be
less work and worse — it puts a line in the corpus that never happened, and the
corpus's whole value is that every line in it did.

So `verify` runs rows ∪ standing invariants, `guard` reports them as separate
steps, and the catch rate stays a statement about rows, because that is what it
measures. A subject with an active row carrying no input already runs the same
check, so the invariant stands aside for it rather than probing twice.

**What neither proof establishes**, and it is worth saying out loud: that the
instrument *exercised* anything. A rule can discriminate perfectly and an
extractor can read a real number out of a run that set nothing up. Building
v0.8's end-to-end subject produced a live example — a scenario passed while
comparing nothing at all, because the row it needed had not been armed. It was
fixed by asserting the precondition, which is a thing a human noticed and no
mechanism would have.

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

`--every N` samples, `--setup "npm ci"` prepares each sampled commit before it
is probed, `--dry-run` reports without writing.

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
2. **Prove it before you trust it.** A subject that passes through a known bug
   is too weak to watch anything, and **`capture` refuses to store rows from an
   unproven subject**. Which of the two proofs applies is a fact about your
   repository, not a preference. Your history contains the bug the heuristic is
   about: `ratchet adopt <subject> --good <ref>` runs it across that history,
   captures the oldest commit where it fails, and records the proof — one
   command; `ratchet validate <subject> --known-bad <sha> --known-good <sha>`
   is the same protocol when you already know the commit. It does not, because
   the property has simply always held here — the normal case for a *quality*
   number on a healthy codebase: declare `rejects <measure> <a value the rules
   must refuse>`, and the subject enforces as a standing invariant with no
   corpus row behind it (see "Two proofs that a check can fail").
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

## Agents reading a `.ratchet/` folder

`ratchet init` writes **`.ratchet/AGENTS.md`**, an operating guide that lives
where it is found. An agent opening a repository does not read a dependency's
README; it reads the files in front of it — so everything needed to not do
damage here was, in practice, nowhere. `init` is additive and overwrites
nothing, so an existing project picks the file up by re-running it:

```
$ ratchet init
.ratchet already exists; added 1 missing file(s):
  AGENTS.md

nothing existing was touched.
```

What it says, in short — the same loop for a person:

1. **`ratchet guard` before you start and after you finish.** `✗` fails the
   build, `!` is a warning. Running it first tells you what was already broken,
   which is the difference between a report and a guess.
2. **A failing row is a counterexample recurring.** Fix the code. If the
   expectation is genuinely wrong, `ratchet accept <id> --reason "..."` — never
   delete the row, never loosen the bound quietly.
3. **Add a check with `ratchet heuristics new <name>`**, put its instrument in
   `.ratchet/tools/`, run it as `{home}/tools/...`, and declare `owns`.
4. **Prove it can fail.** Either against history (`ratchet adopt`, or
   `ratchet validate` with a ref found by `ratchet replay --subjects
   --subject <name>`), or with a `rejects` line for a standing invariant that
   has never been violated here.
5. **Never hand-edit `corpus.jsonl` or `journal.jsonl`.** Ids are
   content-addressed; `fsck` detects it, and a synthetic row is a lie about the
   past.
6. **Report what you measured.** Which subjects enforce, which proof tier each
   has, what you left red and why.

And the two things worth knowing before trusting a green tick, which the file
states out loud because the gate cannot: a declared rejection proves the *rule*
discriminates, not that the instrument exercised anything — a check whose script
prints three hardcoded constants passes every gate here — and a warning is not
nothing, it is one of the ways a gate is green over nothing.

## Commands

```
ratchet init                      create .ratchet/ (rules, config, AGENTS.md).
                                  Safe to re-run: adds missing files, overwrites none.
ratchet guard [--strict] [--quiet] [--jobs N]
                                  the one command a build runs: parse, integrity,
                                  rows, validation. Nonzero on any failure.
ratchet hooks install|uninstall|status [--pre-push] [--command "..."]
ratchet heuristics                list the prose subjects, their rules and rows
ratchet heuristics show <name>
ratchet heuristics log <name>     every commit that changed this heuristic
ratchet heuristics new <name> [--run "<cmd>"]
                                  append a commented skeleton, with both name
                                  collisions refused before anything is written
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
ratchet fuzz [--seed N] [--iterations N] [--targets state,cli,rules]
                                   the secondary verifier: mutate the gate's state,
                                   fuzz the CLI surface, and fuzz the rules grammar
ratchet bisect <id> --from <older-ref> --to <newer-ref> [--setup "npm ci"]
                                  names the boundary and which way it runs
ratchet replay --good ref [--bad ref] [--every N|day|week] [--subjects] [--jobs N]
               [--subject name] [--row id] [--setup "npm ci"] [--no-pinpoint]
                                  every transition in the range, with its direction.
                                  --subjects --subject <name> answers "where in my
                                  history does this subject fail" — which is where
                                  validate's --known-bad comes from
ratchet validate <subject> --known-bad ref [--known-good ref] [--input json]
                          [--crash-is-the-regression]
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

Since v0.9 the tool says so rather than leaving it to be discovered. `fsck` and
`guard` warn when a subject's instrument resolves inside the tree it measures
and does not go through a token:

```
! frozen instrument   "physics-sanity" measures the tree through tools/check.cjs,
                      which is inside that tree and untracked: in a worktree the
                      file is simply absent, so replay, adopt, bisect and
                      validate cannot run it at all
    fix: move it under the ratchet home and reach it through the token, as in:
         node {home}/check.cjs
```

This is not hypothetical. One of the two field experiments pointed its config
at an untracked script in the tree while its write-up listed *"Frozen
instrument. The check script is pinned across every commit"* as one of three
guards on instrument integrity. That was true of the other repository and false
of this one, and nothing said so — because in v0 the history commands checked
commits out in place and the distinction could not bite. v0.4 moved history
into worktrees and made it bite. A *directory* argument is deliberately not an
instrument: `node --test dist/test/` measures the tree it points at, and reading
the checked-out commit's tests is the whole point of that subject.

**How much of the command it reads.** For a `"shell": true` subject the command
is split on `&&`, `||`, `;` and `|` — outside quotes, so the operator in
`node -e "a && b"` stays part of the argument — and every segment is examined.
Each instrument found inside the tree is its own warning with its own fix.
Through v0.9 only the first command was read, so `cd . && node tools/check.js`
was silent on exactly the shape this check exists to name (R24). Grouping
(`(...)`, `$(...)`), redirection and a trailing `&` are not modelled: this
reads far enough to find program names, not far enough to be a shell.

One narrowing remains, and it is now only as wide as its reason: a segment is
skipped when its program is `sh`, `bash` or `zsh` **and it carries a `-c` flag**,
because what follows `sh -c` is a script *body*, not a path. Every other way of
invoking a shell names a file like anything else, so `bash tools/setup.sh` is
reported exactly as `./tools/setup.sh` is. Through v0.9 the skip applied to any
segment run by a shell, which hid that shape entirely.

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

## The four outcomes

A check exits 0 to pass and nonzero to fail. It may also exit **125** for *not
applicable at this commit* (borrowed from `git bisect skip`) or **126** for
*this environment cannot run me here*:

```
✓ c87cb67944d6f s
✗ cfd1f483d53bf s 13 — unlucky
− c74cef33855a7 s 7 — n/a: feature absent at this commit
∅ b1993ac02f4e1 s 9 — could not run here: no compiler on this machine

2/5 rows pass, 1 failing, 1 n/a, 1 could not run here
```

Neither is a pass or a failure, and neither fails the build — which is what
replay across history needs: a check that cannot apply to a 2019 commit should
not be scored as a bug there.

**They are two different claims and were one outcome until v0.9.** "This
feature did not exist yet" is a fact about the commit; "today's toolchain
cannot prepare that commit" is a fact about the machine, and reporting the
second as a failure manufactures a regression out of dependency rot. `replay
--setup` had already made the distinction for setup failures and nothing let a
*check* make it, so every scripted instrument grew its own three-way split by
hand. In prose:

```
applies  when src/sim.c exists    n/a here: the subject did not exist yet
needs    node_modules exists      could not run here: the environment cannot
```

A check that cannot be *spawned at all* stays a failure — that is
indistinguishable from a broken config, and silently greening it would be the
false pass this tool exists to prevent. One caveat on 126: it is also the
shell's own code for "found but not executable", so a `shell: true` subject
whose command is not executable reports "could not run here" rather than
failing. That is the same claim, and it is loud rather than silent — a subject
returning no verdict at every commit trips the "most of this gate is not
checking anything here" warning on its first run.

## Integrity

`ratchet fsck` reports unreadable lines, orphaned accept/reopen events,
subjects with no configured check, and rows whose id does not match their own
content. That last one is only possible because ids are content-addressed: a
hand-edited or corrupted row is mechanically detectable.

`verify` refuses to run at all against a corpus with unreadable lines — a row
hidden behind a parse error is a false pass — and names the line.

## The secondary verifier: `ratchet fuzz`

`guard` proves the *rows hold*. `fuzz` attacks the *machinery that produces
rows* — the parsers, the fold, the judges, the CLI surface. It is a shipped
command rather than a test file because a check that lives in the test suite
only runs where the tests run.

Three targets, each aimed at a measured defect class (of the twenty-one v0
review defects, sixteen sat at the process boundary — on the CLI surface or in
an error path — and not one in a data structure):

| Target | What it mutates | The invariants it checks |
|---|---|---|
| `state` | synthetic corpus/journal/config/rules files | `guard` never throws; `fsck` detects exactly the rows whose id does not match their content; unreadable lines are named by line number; the gate is deterministic |
| `cli` | random argv against the real binary | exit 0 or 1 with a first-class message, never a stack trace; `--json` with exit 0 emits JSON |
| `rules` | grammar-generated and mutated heuristics.rules | the parser never throws; problems carry line and column; `fmt` is a fixpoint and never changes a heuristic's canonical text |

```
$ ratchet fuzz --seed 20260907 --iterations 300
fuzz: state,cli,rules · 300 iteration(s) each · seed 20260907
✓ state    clean
✓ cli      clean
✓ rules    clean

fuzz passed — no oracle violated
```

Determinism is the ratchet's own standard: one seed, one stream, findings
reproduced from seed + iteration. The state target mutates a *synthetic*
scratch home, never the repository's own — fuzzing your real corpus would mean
rewriting your memory. A finding is minimized the way `capture` minimizes a
counterexample, so the report shows the smallest repro rather than a different
bug that happened to also crash:

```
✗ cli      1 finding(s)
  [invalid-json] iteration 93: --json stdout does not parse (Unexpected token 'j', "journal en"...):
  repro: ratchet note --text c5ba326 --json
```

Exit 1 when any invariant is violated, 0 when all hold; `--json` emits the
full report for CI. Honest limits, stated the way this tool states them: no
oracle can detect a mutation that preserves every property it checks — a
fuzzer is evidence, not a proof — and the PNG decoder, the worktree machinery,
and instrument execution are covered by the test suite instead.

The fuzzer already paid for itself in this repository: its first runs found
that two commands ignored `--json` while exiting 0, and that `fmt` grew a
blank line into an empty rules file on every run.

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

`owns` is not optional decoration. Without it only the command *string* is
hashed, and `node {home}/tools/probe.js` is the same string whatever that file
now contains — so rewriting the instrument re-points every row it armed
instead of quarantining them. Measured, in a scratch project: a row armed by
`adopt` from a real regression, the bug still in the tree, the un-owned
instrument gutted to `process.exit(0)` — `0/1 rows pass` became `1/1 rows
pass`, no quarantine, no warning, the validation still on the books. `ratchet
fsck` and `ratchet guard` now report a `{home}` instrument that no subject
owns, as `instrument-unowned`.

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
transitions (2):
  broke  at 3b89381e  "Update README.md"     pass -> fail, halved in 2 probes (between 4abc1d54 and 9f53b4d2)
  fixed  at 9f53b4d2  "widescreen refactor"  fail -> pass, halved in 2 probes (between 9f53b4d2 and c1177ee0)
  first bad commit: 3b89381e  Update README.md
```

**Every** boundary is reported, with its direction. Until v0.9 `replay` looked
for a `pass` followed by a `fail` and halved that window only, so a range whose
boundary ran the other way answered *"no pass -> fail transition inside this
range"* and had to be closed by hand — which is exactly the work the command
exists to remove. "When did we lose the arms" and "when did we get them back"
are the same question asked twice, and a range holding both a break and a later
fix — the ordinary case for any bug that was found and fixed — used to report
at most the first of them, labelled `first bad commit` whichever it was.
Monotonicity is still assumed *within* a window; sampling is what finds the
windows, and that assumption is now per-window rather than per-range.

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
- `--setup "npm ci"` runs before **each commit** probed, not once per worktree.
  Worktrees are pooled and reused, and a checkout leaves the previous commit's
  untracked build output in place, so every commit has to be prepared again —
  budget a setup line that reinstalls from scratch at once per sample, not once
  per run. A setup failure is reported as `na-env`, not as a failure: an old
  tree that today's toolchain can no longer build is dependency rot, not a
  regression. The environment each run happened under is recorded alongside the
  results.

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

**Where a `--known-bad` ref comes from.** Not from reading `git log`, and not
from a sweep script written for the occasion:

```
$ ratchet replay --subjects --subject galaxy-structure --good <an-old-ref>
```

**A crash is not a proof.** An instrument that cannot *run* at a commit exits
nonzero there, and it does so at every commit it cannot run at — which is
shaped exactly like a check that discriminates perfectly. A pinned instrument
replayed across history hits this the moment it reaches commits predating the
file it loads:

```
$ ratchet validate quality --known-bad e9775c86 --known-good HEAD
  ? known-bad e9775c86 "before the engine existed" — did not measure anything
    — it died with an uncaught exception (a stack frame): Error: Cannot find
      module '…/src/engine.js'
  ✓ known-good 70085d2f "add engine" — passes as required

NOT validated — the known-bad run did not measure anything …
```

Nothing reaches the journal. The honest fix is usually the mechanism that
already exists: exit **125** where the check does not apply to that commit, or
**126** where the environment cannot run it there. If the crash genuinely *is*
the regression — a bug whose symptom is a stack trace is a fine known-bad —
say so with `--crash-is-the-regression`, and the proof records that a person
made that claim. The same refusal guards `ratchet adopt`, which writes the
same proof and would otherwise mint a row whose expectation is a stack trace.

## Bisect (retroactive replay)

`ratchet bisect <id> --from <older-ref> --to <newer-ref>` binary-searches the
commit range and reports the boundary **and which way it runs**:

```
row 3f2a91c first passes at 9f53b4d2ab...
  fail -> pass, found in 5 probes
```

The two refs are range endpoints in history order, not verdicts. Naming them
`--good`/`--bad` presumed the older one passes, which made the command answer
only half the question it is asked — the passing side of a *fix* is the newer
commit, and `--good` has to be an ancestor of `--bad`. The old flags still work
as aliases for the older and newer ref. A range whose endpoints agree is
refused as having no boundary in it, rather than as "`--bad` must be a failing
commit".

It runs entirely inside a
detached `git worktree`: your checkout never moves, a dirty working tree is
fine, and the worktree is torn down even when a probe throws. When the range
contains merges the search follows first-parent, because a binary search over
a non-linear list is not sound. `--setup "npm ci"` runs a command in the
worktree before each probe.

## Layout

```
.ratchet/
  config.json      # subjects → check commands (authored)
  heuristics.rules # prose subjects, in the closed vocabulary (authored)
  tools/           # instruments, reached as {home}/tools/... (authored)
  corpus.jsonl     # append-only capture/accept/reopen events (committed)
  journal.jsonl    # append-only decisions (committed)
  AGENTS.md        # how to work in this folder, for people and agents (committed)
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

**Five scripted subjects**, each a check of the checker, each invoked through
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

A sixth, `visual-diff-is-sound`, was a scripted subject and is now a prose
heuristic. It could not be armed — the visual diff is new in v0.5 and has never
been wrong here, so `adopt` had no failure to arm a row with — and **a scripted
subject with no row is never run by anything**. It sat in `config.json` looking
like coverage while the comparator went ungated. The script is unchanged and
still does the PNG round-trip; only the judgment moved into rules that can say
what they refuse, which is a proof a subject can earn without a bug ever having
happened. That is the shape to reach for when a check is a standing property
rather than a counterexample: keep the script as the instrument, and put the
verdict in prose.

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
[NEXT_STEPS_V3.md](../docs/ratchet/NEXT_STEPS_V3.md#the-finding-that-should-shape-v08-the-corpus-is-in-the-wrong-place).
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
  measure  status  exit code
  rule     failing is 0
  rule     passing is at least 193
  rule     status is one of 0, 1
  rejects  failing 1
  rejects  passing 192
  rejects  status 7
  because  a suite that shrinks silently is how a ratchet stops ratcheting: the
  because  count is a floor, raised deliberately, never lowered by accident
```

Two measures, two rules, no plumbing. The `passing` floor is the ratchet
applied to the ratchet's own coverage — adding tests keeps it satisfied,
quietly deleting them does not. `applies when` makes it report `na` at commits
that predate the build rather than manufacturing a failure there.

**And it is the worked example of item 1.** This heuristic has never failed in
this repository's history and never will while the suite is green, so `adopt`
had nothing to arm it with: it sat in `heuristics.rules` listed `UNVALIDATED`,
enforcing nothing at all, through three versions. The two `rejects` lines are
its proof, and the moment they were added it became a standing invariant and
started enforcing — and caught a red suite on its first run.

If the prose form could not express the standing invariants of the tool that
ships it, there would be no honest way to claim it expresses anyone else's.

## Build & test

```
npm install
npm run build
npm test
```

237 tests: one regression test per defect closed from the v0 review, the visual
codec/diff/loop tests, the v0.7 additions — canonicalization and its
failure modes, every extractor and predicate, the probe's outcomes and
its seeding, the capture gate, `guard`, the hook installer, and the
git-sourced heuristic history — the v0.8 additions: the token vocabulary,
a prose heuristic reaching an instrument that lives only in the home, and
`adopt` preparing its confirmation probe — and the v0.9 additions: declared
rejections and every way one can fail to be a proof, standing invariants and
their separation from rows, the nth match and measure-to-measure comparisons,
both directions of a transition in `replay` and `bisect`, the instrument-inside-
the-tree detector, and the two kinds of "no verdict" — and the v0.10 additions:
the subject nothing runs, with each check leaving a mark on disk so that "it
never executed" is a fact outside the gate's own bookkeeping, and every shape a
config.json subject can be wrong in, asserted to name the subject and never to
leak a TypeError. The demo is generated by
`node demo/setup.js`; see [demo/README.md](demo/README.md).

## What this prototype still leaves out

From the design in [../docs/ratchet/RATCHET.md](../docs/ratchet/RATCHET.md), still absent:

- **Mode 2, mine** — `ratchet history` walking test-file history to resurrect
  deleted and weakened assertions as corpus rows.
- **Mode 3, semantic history** — behavioral diff between any two commits.
- **Sampled behavioral diffs** beyond the visual pins (corpus + boundary
  catalogue snapshot sets).
- **Metric budgets** in their baseline-relative form, and static checks.
- The agent attach: dispatching an investigation when a row goes red.

Still outstanding in the measure vocabulary, unchanged by v0.9:

- **A baseline that moves.** `is within 5 percent of 0.5` works against a
  constant; the metric-budget shape is relative to the previous run or a named
  ref, and nothing expresses it.
- **Repeated structure.** A `for each` over rows of the output, so "every card
  has an image" stops needing someone to write a command that counts.
- **Two-sided readings.** Comparing across two runs — the round-trip shape.

And two costs v0.9 did not touch: **every project hand-rolls its worktree
setup** (supply `node_modules` without hitting the network once per commit,
then build — nobody's idea of interesting, and a project cannot replay anything
until it has written one), and **there is no per-commit artifact cache**, so
arming one subject costs 3m44s over 9 commits on one field repository and
2m18s over 6 on another, almost all of it setup and build repeated per commit.

The v0.6 plan — heuristics as data, validation as a capture gate, `ratchet
adopt`, yield reporting, and the merge-landscape glue — is
[../docs/ratchet/NEXT_STEPS_V2.md](../docs/ratchet/NEXT_STEPS_V2.md); all five are built in v0.7. What
comes after is [../docs/ratchet/NEXT_STEPS_V4.md](../docs/ratchet/NEXT_STEPS_V4.md).
