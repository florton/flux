# Ratchet — what is still outstanding

Recorded 2026-09-07, after every entry in [ISSUES_RATCHET.md](ISSUES_RATCHET.md)
(R1–R21) and [ISSUES_RATCHET_V09.md](ISSUES_RATCHET_V09.md) (R22–R27) was closed.
Numbering continues from those, so an entry can be cited across all three files.

**Method.** The standard the two registers before this one were held to: every
defect was reproduced by execution against a scratch project or this repository,
and no measurement appears here that was not taken. Where something was *not*
measured, the entry says so in those words.

**Summary.** Three defects were found and fixed on the day this file was
written; three remain open, one of them a false-green in the gate itself. The
rest of the file is the things that were never defects — costs accepted on
purpose, plan work not built, and decisions waiting on a human.

| # | Severity | Status | Issue |
|---|---|---|---|
| R28 | **high** | **closed** | Two wall-clock concurrency assertions flake under load, and the suite is this repo's own standing invariant — so the gate failed about one run in three on an untouched tree |
| R29 | medium | **closed** | `visual-diff-is-sound` was a scripted subject with no rows, so nothing ever ran it; the visual comparator was ungated |
| R30 | low | **closed** | The frozen-instrument detector skipped *every* command run by a shell, not just the `-c` form (the narrowing R24 left in place) |
| R31 | **medium** | **open** | A scripted subject with no rows is never run, and the gate affirms it by name anyway |
| R32 | low | **open** | A rule-failure witness names the count, not the cause: "failing measured 1" without which test |
| R33 | low | **open** | The `passing` floor counts non-test helper modules as tests |

---

## R28 — high — the gate failed one run in three, on a tree nobody touched — **closed**

`ratchet guard` on a clean checkout, three consecutive runs:

```
guard run 1: exit=1 | ✗ standing  0/1 standing invariants hold, 1 broken
guard run 2: exit=0 | ✓ standing  1/1 standing invariants hold
guard run 3: exit=0 | ✓ standing  1/1 standing invariants hold
```

```
✗ test-suite — failing measured 1, rule says "failing is 0";
               passing measured 202, rule says "passing is at least 203"
```

Whole-suite runs failed 3 times in 7. Every failure was a single test, and the
one captured was `replay --jobs probes commits on parallel worktrees`:

```
error: 'parallel 2558ms is not much faster than serial 4097ms'
```

**This is [O1](ISSUES_RATCHET_V09.md) reproduced.** That entry recorded
`pr-comment` calling `test-suite` broken minutes after `guard` called it green,
with nine green attempts afterward and no cause established. The cause is here.

**What it was.** `history.test.ts` timed a serial replay against a parallel one
and asserted `parMs < serialMs * 0.6`. Run that test alone and it passes 10 out
of 10 — the four workers have the machine to themselves and come in about four
times faster. Run it inside the suite and Node's runner is executing other test
files on the same cores; the workers compete, and the ratio drifts past the
threshold. `integrity.test.ts` had the same shape with no margin at all
(`parallelMs < serialMs`), one scheduling accident away from the same fate.

The test was not measuring the code. It was measuring the machine, and the
machine was busy running the rest of the suite.

Two things made it worse than an ordinary flaky test. The suite is this
repository's own standing invariant, so a third of pre-commit runs failed for a
reason unrelated to the commit — which is how a team learns to reach for
`--no-verify`. And the rules file declares `rejects passing 202` and
`rejects failing 1`: the flake produced *exactly* the readings the heuristic
names as the ones it must refuse.

**The fix.** Assert the property, not a proxy for it. Concurrency is a fact
about a run: each probe records the window it occupied and the directory it ran
in, and two windows that intersect can only have come from two probes running
at once. A slow machine cannot make that false — it can only make the windows
longer. The helper and the reasoning are in `ratchet/test/concurrency.ts`.

- `replay --jobs` now asserts eight probes over **four distinct worktrees** —
  fan-out, which is structural and has no clock in it — plus real overlap, plus
  the commit ordering it always checked. It no longer runs the replay twice, so
  it is also about three times faster.
- `verify runs rows concurrently` asserts overlap across its eight rows.
- A third test drives `pool` with hand-released promises and reads the
  saturation off directly — no clock at all — proving the limit is a ceiling,
  that a finished task is replaced immediately, and that results land at their
  input index.

All three were run against a deliberately serialized `pool` and fail there:

```
not ok - R9: pool holds exactly `limit` in flight, and starts one more as each finishes
  error: 'the pool must fill to the limit at once, not one at a time'
not ok - R9: verify runs rows concurrently
  error: 'rows were checked one at a time (most in flight at once: 1)'
not ok - replay --jobs probes commits on parallel worktrees, results in order
  error: 'probes never ran at the same time (most in flight at once: 1)'
```

The worktree assertion was proven separately by forcing `sessions` to 1:

```
error: '--jobs 4 must spread the probes over four distinct worktrees, one checkout each'
```

Six consecutive whole-suite runs are green afterward (205 then 206 tests as the
later fixes landed), and four consecutive `guard` runs pass.

---

## R29 — medium — a subject that was never run by anything — **closed**

`visual-diff-is-sound` was the one subject `ratchet guard` warned about, and the
warning read like paperwork: *no proof they can fail*. The real problem was one
level down.

```
$ ratchet list
● c8dc508d99fbe  corpus-merge-safe         ...
  (eight rows, none of them visual-diff-is-sound)

8 rows — 8 active (●), 0 archived (○)
```

**It had no rows, and a scripted subject with no rows is never run.** `verify`
runs corpus rows and standing invariants; a script cannot be a standing
invariant, so the PNG codec and the pixel comparator were sitting in
`config.json` looking like coverage while nothing exercised them at the gate.

It could not be armed either, and that was not fixable by trying harder:
`ratchet/src/visual.ts` has exactly one commit in this repository's history and
was correct in it, so `adopt` had no failure to arm a row with. `dist/` is not
committed, so even a history probe needs a build at every commit.

**The fix.** Keep the script as the instrument, move the judgment into prose —
the shape `test-suite` already had, and the thing the prose form is for. The
check is unchanged and still runs out of `{home}`; the heuristic owns it, so
editing it re-opens the proof.

```
heuristic visual-diff-is-sound
  run      node {home}/tools/selfcheck.js visual-diff-is-sound
  owns     .ratchet/tools/selfcheck.js
  applies  when ratchet/dist/src/visual.js exists
  measure  status  exit code
  measure  verified  count of lines matching "verified on"
  rule     status is 0
  rule     verified is 1
  rejects  status 1
  rejects  verified 0
```

`rejects verified 0` is the one that earns its place: a check can exit 0 without
having asserted anything, and then the green means only that the process ran.
The line is printed last, after every assertion.

Proven non-vacuous by mutation rather than by argument — `compareImages` was
changed to always report `equal`, the classic false negative that makes a visual
pin pin nothing:

```
✗ standing             0/2 standing invariants hold, 2 broken
  ✗ visual-diff-is-sound — status measured 1, rule says "status is 0";
                           verified measured 0, rule says "verified is 1"
```

Both declared counterexamples are the readings a real break actually produces.
The mutation was reverted; `git diff` on `ratchet/src/` is empty.

The gate now reads, for the first time, with no warnings at all:

```
✓ standing             2/2 standing invariants hold
✓ validation           all 10 subject(s) have a proof they can fail
guard passed
```

This closes **K5**. The general problem K5 named — "the declared-rejection idea
needs a form that scripted subjects can express" — is *not* solved, and is
restated as R31 below, which is the part that actually bites.

---

## R30 — low — every shell invocation was skipped, not just `sh -c` — **closed**

The residue [R24](ISSUES_RATCHET_V09.md) documented and deliberately left in
place. In shell mode a segment whose program was `sh`, `bash` or `zsh` was
skipped entirely, on the reasoning that what follows `sh -c` is a script body
rather than a path. True of `-c`, and of nothing else:

```
"cd . && bash tools/setup.sh"     -> []            # before
"cd . && ./tools/setup.sh"        -> ["./tools/setup.sh"]
```

The skip is now as wide as its reason — the program must be a shell *and* carry
a `-c` flag:

```
"sh -c \"node tools/check.js\""   -> []
"bash -c \"node tools/check.js\"" -> []
"bash -lc \"node tools/check.js\""-> []            # combined flags too
"cd . && bash tools/setup.sh"     -> ["tools/setup.sh"]
"bash --norc tools/setup.sh"      -> ["tools/setup.sh"]
"node a.js && node a.js"          -> ["a.js"]      # deduplicated
```

This reads no more shell than before; it only stops throwing away a segment it
had already parsed. The regression test fails against the old condition. The
README passage that documented the narrowing as a known cost now documents the
narrowing as it is.

---

## R31 — medium — **open** — a subject nothing runs, affirmed by name

R29 fixed one instance. The mechanism that hid it is untouched, and it is a
false green rather than a missing warning.

A scratch project with two scripted subjects, one holding a corpus row and one
not, both given a history proof. The checks leave a mark on disk when they run,
so "did it run" is a fact rather than an inference:

```
$ ratchet guard
✓ rows                 1/1 rows pass
✓ validation           all 2 subject(s) have a proof they can fail
    2 validated against history: has-a-row, has-no-row

guard passed

$ ls marks/
has-a-row
```

`has-no-row` never executed. The gate does not merely fail to warn about it —
the validation line **names it as proven**, and the row line counts 1/1 without
saying that one of the two declared subjects contributed nothing to that number.
Every green here is accurate on its own terms and the whole is misleading.

`ratchet yield` does show it (`0 rows (0 active) no evidence yet`), which is
where the information lives today. Nothing at the gate consults it.

**Why it matters.** This is the same family as the two green-over-nothing shapes
v0.9 learned to report, and it hid a real subject in the ratchet's own
repository for four versions. Any repository that arms a subject, later archives
its last row, and keeps the history proof lands here silently.

**What a fix looks like.** A `guard` step that reports a subject which no
mechanism will run: scripted, zero active rows, not a standing invariant. It is
a warning rather than a failure — a subject can be legitimately between rows —
but it belongs in the same list as the frozen instrument, and the wording should
say what is true: *nothing runs this*. The harder half is the design question
K5 raised and R29 side-stepped: whether a scripted subject should be able to
declare a rejection at all, or whether "a standing property, checked by a
script" should always be spelled as a prose heuristic with a `run` line, as it
now is here.

---

## R32 — low — **open** — the witness names the count, not the cause

When `test-suite` breaks, the gate says:

```
✗ test-suite — failing measured 1, rule says "failing is 0";
               passing measured 202, rule says "passing is at least 203"
```

Which test failed is not in there. Finding R28 meant re-running the suite by
hand until it went red again and reading the TAP.

O1 predicted this would be better by now, and it is half right: the heuristic
now measures the exit code, so the witness reads `failing measured 1` instead of
the old `exited 1 before any rule could be checked`, which is a real
improvement. But the excerpt that O1 credited belongs to the *instrument-crash*
path in `probe.ts`. When the rules are judged normally, no output reaches the
witness at all.

**Why the obvious fix does not work.** Attaching `excerpt(output)` to a rule
failure would not have helped here, and this was measured rather than assumed:
in the captured failing run, `not ok 142` sat at **line 708 of 1038**. `excerpt`
shows both ends with a dropped-line count, so a head-and-tail excerpt of that
stream shows the TAP banner and the summary and misses the failure by hundreds
of lines.

The witness a reader wants is the lines that explain the number — `not ok` for
TAP, `VIOLATION` for the uniformity scanner, `FAIL ` for the end-to-end driver.
The heuristic already names those strings in its `measure` clauses; it has no
way to say *this is also the witness*. A `witness lines matching "not ok"`
clause would be the smallest thing that works, and it is a vocabulary addition
rather than a bug fix, which is why it is filed here rather than done.

---

## R33 — low — **open** — the floor counts things that are not tests

`node --test <dir>` treats every `.js` file under the directory as a test file,
including helper modules that declare no tests, and reports each as one passing
entry:

```
ok 2 - ...\dist\test\concurrency.js
ok 7 - ...\dist\test\proof.js
```

So `passing is at least 206` is two higher than the number of real tests. This
predates today — `proof.js` has always been counted — and today's helper added
the second.

It is harmless to the property the rule defends: the count is a floor, it only
ever inflates by adding a helper, and it still catches a suite that shrinks. It
is worth knowing before someone reads the number as a test count, and worth
remembering if the floor is ever raised to a number that has to mean something.

The obvious fix is worse than the defect: naming test files explicitly in the
`run` line would mean a newly added test file is silently not run, which is the
exact failure this heuristic exists to prevent.

---

## Decisions waiting on a human

**The version.** `ratchet/package.json` says `0.9.0` and the README is titled
"v0.9 prototype". Version bumps in this repository ride with feature commits
(0.1 → 0.2 → 0.3 → 0.4 → 0.7 → 0.9), and no release was asked for, so none was
invented — the README says "through v0.9 this was wrong… now fixed" instead.
There is now an argument for 0.10.0 that did not exist before: the R22 fix
changes rule hashes for any rules file with a `#` inside a quoted value, which
quarantines armed rows on upgrade, and a subject changed shape from script to
prose. Both are the kind of thing a version number exists to announce.

**The rest** is unchanged from [NEXT_STEPS_V4.md](NEXT_STEPS_V4.md): whether
`guard --strict` should be the default, per-branch corpora, whether a validation
proof expires or merely quarantines when a rule is edited, and where generated
heuristics should land.

---

## Accepted trade-offs still standing

K1–K4 in [ISSUES_RATCHET_V09.md](ISSUES_RATCHET_V09.md) are unchanged and are
costs taken on purpose, not defects: exit 126 colliding with the shell's "found
but not executable", `replay --subjects` running subjects `verify` refuses,
`verify --row` skipping standing invariants, and the residue no mechanism can
see — a rule can discriminate perfectly and an extractor can read a real number
out of a run that set nothing up.

**K5 is closed** by R29 above.

---

## Plan work simply not built

Tracked in [NEXT_STEPS_V4.md](NEXT_STEPS_V4.md), listed so this file is a
complete answer to "what is outstanding":

- **Item 6, the rest of the catch rate.** `report` reads 0% and will keep
  reading 0%: a row that goes red under `verify` and is fixed without anyone
  running `capture` never reaches the numerator.
- **Item 4, the rest of the vocabulary.** Baselines that move, repeated
  structure over rows of output, two-sided readings across two runs — and now
  R32's witness clause.
- **Item 7, mode 2** — `ratchet history` mining test-file history for deleted
  and weakened assertions.
- **Item 8, the agent attach** — a documented shape for generated heuristics,
  and dispatch on a red row.
- **Item 9, design debt** — per-commit artifact caching (arming one subject cost
  3m44s over 9 commits on one field repository), and the worktree setup script
  every project still hand-rolls.
- **The fifth coverage class.** Packaging and hygiene — R16, R19, R21 — still
  have no rows and no obvious instrument.
