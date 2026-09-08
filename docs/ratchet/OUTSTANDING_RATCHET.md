# Ratchet — what is still outstanding

Recorded 2026-09-07 and updated 2026-09-08, after every entry in [ISSUES_RATCHET.md](ISSUES_RATCHET.md)
(R1–R21) and [ISSUES_RATCHET_V09.md](ISSUES_RATCHET_V09.md) (R22–R27) was closed.
Numbering continues from those, so an entry can be cited across all three files.

**Method.** The standard the two registers before this one were held to: every
defect was reproduced by execution against a scratch project or this repository,
and no measurement appears here that was not taken. Where something was *not*
measured, the entry says so in those words.

**Summary.** Five defects were found and fixed on the day this file was
written. The day after, R31 — the last false green in the gate itself — was
closed, and building its reproduction turned up R39, where a config typo
reached the spawn site as an internal TypeError that `validate` read as the
check working. Both shipped as v0.10. Two entries remain open, both low: a
witness that names the count rather than the cause, and a floor that counts
helper modules as tests. The most serious the tool has had is R37: a bound
written the way people write bounds was checked as a string comparison, in one
direction failing forever and in the other **passing** forever with the gate
reporting green. The rest of the file is the things that were never defects —
costs accepted on purpose, plan work not built, and decisions waiting on a
human.

| # | Severity | Status | Issue |
|---|---|---|---|
| R28 | **high** | **closed** | Two wall-clock concurrency assertions flake under load, and the suite is this repo's own standing invariant — so the gate failed about one run in three on an untouched tree |
| R29 | medium | **closed** | `visual-diff-is-sound` was a scripted subject with no rows, so nothing ever ran it; the visual comparator was ungated |
| R30 | low | **closed** | The frozen-instrument detector skipped *every* command run by a shell, not just the `-c` form (the narrowing R24 left in place) |
| R31 | medium | **closed** | A subject with no active row and no declared rejection is never run, and the gate affirmed it by name anyway |
| R32 | low | **open** | A rule-failure witness names the count, not the cause: "failing measured 1" without which test |
| R33 | low | **open** | The `passing` floor counts non-test helper modules as tests |
| R34 | medium | **closed** | `ratchet pr-comment --json` printed markdown with exit 0 — found by `ratchet fuzz` |
| R35 | low | **closed** | `ratchet note --json` printed plain text with exit 0 — found by `ratchet fuzz` |
| R36 | low | **closed** | `fmt` grew a blank line into an empty or comment-only rules file on every run — found by `ratchet fuzz` |
| R37 | **high** | **closed** | `latency is not above 100` was an inequality against the *text* "above 100" — always true, so the gate went green over a ceiling exceeded 2000x — found by the blind DX test |
| R38 | low | **closed** | A brand-new `ratchet init` produced a `guard` warning about its own scaffolding: the R36 fix dropped every preamble blank, and the shipped template has one |
| R39 | medium | **closed** | A subject keyed `command` instead of `check` reached the spawn site as `TypeError: command is not iterable`, and `validate` reported that crash as the check *failing as required*; `owns` as a bare string sent the hasher walking the filesystem |

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

## R31 — medium — a subject nothing runs, affirmed by name — **closed**

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

**The fix, and what it is derived from.** A `guard` step named `unrun subjects`
reports every declared subject that no mechanism will run, worded as what is
true: *nothing runs this*. A warning, not a failure — the reason stated above
still holds, and `--strict` does not promote it, because `--strict` is about
subjects with no proof and an unrun subject may be perfectly well proven.

The set is read off **what `verify` actually ran**, not re-derived from its
selection rule:

```ts
const ran = new Set(results.map((r) => r.subject));
const unrun = Object.keys(config.subjects).filter((n) => !ran.has(n)).sort();
```

That choice is the point. Restating "active rows union standing invariants" in
a second place is how the gate and the thing it describes drift apart, which is
the general shape of every defect in this file. A subject nothing reports on is
a subject nothing ran, and there is no second copy of the rule to fall behind.

Two smaller pieces came with it. The advice follows the discipline the
validation step already had: `rejects` is a clause in the rules file, so it is
offered only to a subject that has a block there, and a subject from
`config.json` is instead told the route R29 took — re-spell it as a heuristic
with a `run` line. And the proof listing, the line that did the affirming, now
carries the qualifier beside the name:

```
✓ validation           all 2 subject(s) have a proof they can fail
    2 validated against history: has-a-row, has-no-row (nothing runs it)
```

The warning is suppressed when the empty-gate warning already covers the same
situation. Two warnings for one cause is how a gate teaches people to skim it,
which is R38's lesson.

**Reproduced, and fixed, by execution.** The scratch project this entry opened
with, rebuilt: two scripted subjects, one armed by `adopt` and one not, both
proven against history by `ratchet validate`, with each check writing a mark to
disk when it runs. Before:

```
✓ rows                 1/1 rows pass
✓ validation           all 2 subject(s) have a proof they can fail
    2 validated against history: has-a-row, has-no-row
guard passed

$ ls marks/
has-a-row
```

After:

```
! unrun subjects       nothing runs 1 of 2 declared subject(s): has-no-row
    arm one against your own history:  ratchet adopt has-no-row --good <an-old-ref>
    has-no-row declared in config.json, with no rules block to declare a
    rejection in: to enforce without a row, re-spell as a heuristic with a run line
✓ validation           all 2 subject(s) have a proof they can fail
    2 validated against history: has-a-row, has-no-row (nothing runs it)
guard passed with 2 warning(s)

$ ls marks/
has-a-row
```

Then the two controls, on the same project. Arming `has-no-row` with `adopt`
silences the warning and the mark appears, so the warning tracks the fact
rather than a proxy for it. Retiring that row again with `ratchet accept` —
the silent path this entry named, *arms a subject, later archives its last row,
keeps the history proof* — brings the warning back:

```
✓ rows                 1/1 rows pass
! unrun subjects       nothing runs 1 of 2 declared subject(s): has-no-row
    2 validated against history: has-a-row, has-no-row (nothing runs it)
```

**Five regression tests**, in `test/guard.test.ts`. Each check leaves a mark on
disk, because a claim about what the gate *runs* cannot be tested against the
gate's own bookkeeping without assuming the thing in question — this defect
survived four versions precisely because every number `guard` printed was true.
Three of the five fail against the unfixed `guard` with the messages they were
written for; the other two are the controls, which must pass in both directions
or the gate has merely learned to warn about everything:

```
not ok - a subject with no row and no declared rejection is named as run by nothing
  error: 'the gate must say so out loud'
not ok - archiving a subject's last row brings the warning back
  error: 'retiring the last row must not be silent'
not ok - an unrun prose subject is offered the rejects route instead
```

229 tests. This repository's own gate has no unrun subjects — R29 closed the
one instance by hand — so the new step is correctly silent here, and the
mechanism is now what keeps it that way.

**The design question K5 raised is still open**, and is not a defect: whether a
scripted subject should be able to declare a rejection at all, or whether "a
standing property, checked by a script" should always be spelled as a prose
heuristic with a `run` line. The warning now makes the choice visible at the
moment it matters instead of leaving it to be discovered, which is as far as a
gate can take it.

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

## R34 — medium — `pr-comment --json` was not JSON — **closed**

Found by `ratchet fuzz` on its first real run, minimized to `ratchet
pr-comment --json`: exit 0, stdout was the markdown comment. Every command is
documented to take `--json`, and `pr-comment` had never wired it — `--json`
existed since v0.3 and the case simply called `renderComment` and printed.

**The fix.** The payload is built first — `results`, `report`, `yields` — and
the markdown is a pure render of it. With `--json` the payload is emitted;
without it, the render. Structured consumers read the same numbers the comment
states, and the renderer stays a pure function.

---

## R35 — low — `note --json` was not JSON — **closed**

Same run, minimized to `ratchet note --text --json`: exit 0, stdout "journal
entry appended". The note case printed a fixed string and never consulted the
`json` flag at all.

**The fix.** The appended journal event is now built as a value, appended, and
emitted through the same `emit(json, ...)` path every other command uses.

---

## R36 — low — `fmt` was not a fixpoint on an empty rules file — **closed**

Found by the rules target, minimized to the empty string: `parseHeuristics("")`
returned a preamble of one blank line, `formatHeuristics` rendered it as
`"\n"`, and re-parsing yielded *two* blanks — every `ratchet fmt` grew the
file by one line, forever. The same applied to any comment-only file with a
blank line in it.

**The fix.** Blank lines in a preamble are cosmetic and are dropped when
rendering; comments are the author's reasoning and are preserved. `fmt` is now
a fixpoint for empty, blank, and comment-only files, with a regression test
that cycles each through parse → format twice and asserts stability. The
rules-target oracle (`fmt-not-idempotent`, `fmt-changed-semantics`) keeps the
property enforced from now on.

All three were found by the first two runs of `ratchet fuzz`, a command that
did not exist when this file's other entries were written. It is now a
standing invariant in this repository's own gate (`fuzz-clean`), wired into
CI with a fixed seed.

---

## R37 — high — a bound in ordinary English was not a bound — **closed**

Found by the blind DX test ([NEXT_STEPS_V5.md](NEXT_STEPS_V5.md) item 3), on
the *first heuristic written*, before any of the usability findings that
exercise was looking for.

The vocabulary had `is below` and no `under`. Anything it did not recognize
fell through to the equality catch-all, which compared the measure against the
unrecognized text as a **string**. Two directions, and the second is the one
that matters:

```
rule  latency is under 5          ->  is "under 5"   no number equals it   always red
rule  latency is not above 100    ->  is not "above 100"  every number differs   always GREEN
```

`is not above` is built from two words this tool documents, and
`should never be above` is named in `heuristics.ts` as a supported phrasing —
its own source comment cites it. Reproduced end to end against the real binary
on a scratch project whose measured latency was 0.21 ms:

```
$ cat .ratchet/heuristics.rules
  rule     precision is at least 0.75
  rule     latency should never be above 0.0001     # violated by ~2000x

$ ratchet fmt
    6 | latency should never be above 0.0001
      | latency is not above 0.0001

$ ratchet guard
✓ heuristics canonical 1 heuristic(s), canonical
✓ standing             1/1 standing invariants hold
✓ validation           all 1 subject(s) have a proof they can fail
guard passed
```

A green gate over a ceiling exceeded by three orders of magnitude, from a
documented phrasing, with `fmt` reporting the snap as a success.

**Why neither existing safeguard caught it.** The `rejects` check tests that
some rule refuses a declared reading; a heuristic with one working rule and one
dead one is certified on the strength of the working one. And in the
always-red direction `rejects` actively *certifies* the defect: a rule that
refuses everything trivially refuses the declared counterexample.

**Measured blast radius.** Of 37 comparison-shaped phrasings, 33 parsed clean
as an equality with a constant answer. After the fix, 0.

**The fix, in three parts.** A comparator table that carries an optional `not`
through, so the negated half of the language is translated too; De Morgan
folding, `is not above` → `is at most`, exact on a total order; and the
catch-all closed — a value that opens with a comparison word, ends in a number,
or ends in a comparison word is refused with a line, a column and the
vocabulary named. Quoting stays the escape hatch for a literal. One more check
runs where the extractor is known: an exit code compared for equality against
`"positive"` has a constant answer, and a bare word is invisible to the clause
parser but obvious here.

**Deliberately still refused rather than guessed:** `faster than`, `slower
than`, `no worse than`, `close to`, `roughly`. Whether those mean a ceiling or
a floor depends on what is measured, and the tool does not know.

Six regression tests, one per direction plus the equality the catch-all exists
for. The fuzzer's rules generator learned the same constraint — it had been
generating `m1 is f5e427` over a line-count measure, which the new check
correctly refuses. 223 tests; `fuzz` clean over 6 runs and 2,000 iterations.

---

## R38 — low — a fresh `init` warned about its own scaffolding — **closed**

Found in the same cold-start run as R37, one step earlier: before writing
anything, on a repository that was two commands old.

```
$ ratchet init
$ ratchet guard
! heuristics canonical heuristics.rules is not in canonical form — run `ratchet fmt` so the committed clauses are the checked clauses
guard passed with 1 warning(s)
```

`ratchet fmt` then deleted exactly one line: the blank separating the header
reference from the commented example, in the file `init` had just written.

**Where it came from.** The R36 fix. `fmt` had been growing an empty file by a
line per run, and the fix was to drop *every* blank line in a preamble —
a fixpoint, and the shipped template has a paragraph break, so the template
stopped being canonical. `formatHeuristics` even carries the comment "it must
not be reported as non-canonical on a brand-new project"; the intent was right
and the implementation contradicted it.

**Why it matters more than one blank line.** `src/templates.ts` states the
principle in its own words, about the config template that used to ship a
subject pointing at a nonexistent script: *a tool whose first run complains
about its own scaffolding teaches people to ignore its warnings.* This is a
gate whose value rests entirely on its warnings being worth reading, and the
first one every new user saw was noise about a file they had not touched. The
same fix also flattened any commented rules file — an author's paragraph
breaks were deleted on the first `fmt`.

**The fix.** Normalize instead of delete: runs of blanks collapse to one, the
ends are trimmed. Still a fixpoint — a second pass has nothing left to change
— and the author's paragraphing survives. A regression test cycles the shipped
`RULES_TEMPLATE` through parse → format and asserts it comes back byte-identical,
so the template and the formatter cannot drift apart again. R36's own cases
(empty, blank-only, comment-only) are unchanged and still pass.

---

## R39 — medium — a config typo was an internal TypeError, and `validate` read it as the check working — **closed**

Found while building the R31 reproduction, by typing `command` where the schema
says `check`. It is the obvious name for the thing, and nothing reads it.

```
$ cat .ratchet/config.json
{ "subjects": { "s": { "command": "node x.js" } } }

$ ratchet validate s --known-bad HEAD~1 --known-good HEAD
  ✓ known-bad e56fc0e5 "one" — fails as required: TypeError: command is not iterable
  ✗ known-good db343330 "two" — FAILS here too: TypeError: command is not iterable
```

**"fails as required" is the part that matters.** `check: string` is a promise
the type system makes and JSON does not keep. Nothing validated a subject's
shape at load, so `undefined` travelled all the way to `tokenize(command)` and
died there — and an instrument that cannot run fails at *every* commit, which
is shaped exactly like a check that discriminates perfectly. Here the crash at
known-good refused the validation, so the outcome was right by accident; the
mechanism that made it right is "it also crashed on the other side", not
anything that understood the config was broken.

**Measured blast radius.** Nine malformed shapes were run against the real
binary. Four crashed, two produced messages naming internals, and — worse —
three were accepted in silence:

| shape | before |
|---|---|
| `"command"` instead of `"check"` | `TypeError: command is not iterable` |
| `"check": null` / `42` | `TypeError: command is not iterable` |
| subject is a bare string | `TypeError: command is not iterable` |
| `"owns": ".ratchet/x.js"` (string) | `EPERM: operation not permitted, scandir 'C:\Documents and Settings'` |
| `"owns": [1, 2]` | `The "paths[1]" argument must be of type string` |
| subject is `null` | `Cannot read properties of null (reading 'heuristic')` |
| `"check": ["node", "x.js"]` | **accepted**, `0/0 rows pass` |
| `"check": "   "` | **accepted**, `0/0 rows pass` |
| `"timeoutMs": "soon"` | **accepted**, `0/0 rows pass` |

The `owns` row is the one worth pausing on. A string is iterable, so a bare
string was walked one character at a time and the owning-rule hash went
scanning directories that have nothing to do with the repository. A shape error
in a config file should not be able to send a hash walking the filesystem.

The three silent ones are the familiar failure: a subject that is declared,
counted, and cannot run. They are R31's shape reached by a different road, and
neither the gate nor `yield` had anything to say about them.

**The fix, in three parts.**

*One — validate the shape where it is loaded.* `subjectProblems` in
`src/paths.ts` checks every subject in config.json against the schema its type
already claims, and `loadSubjects` refuses with the list. Problems are
collected, not raised one at a time, for the reason the rules file collects
them: someone fixing a config wants the list rather than a conversation. Every
message names the subject, the key, and the shape it should have — and a
near-miss key is named too, because that is the whole search:

```
ratchet: 1 problem in .../.ratchet/config.json:

  subjects."s".check is missing; a subject needs the command that measures it,
  as in "check": "node tools/check.js" — this subject has "command", which
  nothing reads

Nothing was checked. A subject that cannot run is a check that has stopped enforcing.
```

*Two — stop `fsck` calling it a corpus problem.* Every `loadSubjects` failure
was pushed as `corpus-unreadable-line`, which sends a reader to the one file
that is fine. The kind is now `subjects-unreadable`.

*Three — refuse once.* `fsck` and `verify` each rediscovered the broken config
and each printed the whole paragraph, so the gate arrived as
`guard failed: integrity, rows` with one cause stated twice. A config that will
not load is the same class of failure as a rules file that will not parse —
every subject in it has stopped enforcing — so it is now refused where that one
is, as an early `subjects` step that returns:

```
✗ subjects             1 problem in .../.ratchet/config.json:
  subjects."s".check is missing; ... — this subject has "command", which nothing reads
guard failed: subjects
```

The step exists only when there is something to say; a well-formed config adds
no step, which is why the clean-project step list is unchanged.

**The fuzzer had already generated one of these and could not see it.** The
`state` target's config mutations were `junk`, `no-subjects` and `empty-check`
— and `empty-check` is `{"check": ""}`, one of the three silently-accepted
shapes above. No oracle was violated, because a subject that cannot run
produces `0/0 rows pass` and breaks nothing the oracles ask about. This is the
README's own disclosure holding: *a fuzzer is evidence, not a proof*. The
generator now emits the shapes this entry found as well — `no-check`,
`owns-string`, `subject-scalar` — and all six appear over the gate's own seed
(21 junk, 20 owns-string, 17 subject-scalar, 15 no-check, 14 empty-check,
12 no-subjects in 500 iterations), clean.

**Eight regression tests**, and each part was reverted on its own to prove its
tests are not vacuous:

```
# revert the shape validation
not ok - every malformed subject shape is refused by name, not by TypeError
not ok - a near-miss key is named, because that is the whole search
not ok - every problem in a config is reported at once, not one per run
not ok - subjects given as an array is a top-level error, not fourteen subject errors
not ok - a malformed config is reported as a subjects problem, not a corpus one
not ok - a config that will not load is one refusal, not the same paragraph twice

# revert only the fsck relabel
not ok - a malformed config is reported as a subjects problem, not a corpus one

# revert only guard's early step
not ok - a config that will not load is one refusal, not the same paragraph twice
```

The table-driven test asserts, for all fourteen shapes, both that the message
names the subject and file *and* that it never contains `is not iterable` or
`Cannot read properties`. Two controls hold the other direction: a well-formed
subject with every optional key still loads, and a valid config adds no
`subjects` step — a validator that refuses valid configs is worse than none.

237 tests; `fuzz` clean at 500 iterations on the gate's seed.

**Not validated, on purpose:** whether the `check` command names a program that
exists. That is a runtime fact about a machine, it changes between commits and
between checkouts, and the frozen-instrument warning and the probe's own
`na-env` outcome already speak to it. This entry is about shapes JSON can be
wrong in, not about the world the command runs in.

---


## Decisions waiting on a human

**The version — decided: 0.10.0.** `ratchet/package.json` and the README title
now say v0.10. Version bumps in this repository ride with feature commits
(0.1 → 0.2 → 0.3 → 0.4 → 0.7 → 0.9 → 0.10), and this one carries what a version
number exists to announce: the R22 fix changes rule hashes for any rules file
with a `#` inside a quoted value, which quarantines armed rows on upgrade; a
subject changed shape from script to prose; `fuzz` is a new command; `--json`
became real on two commands that had ignored it; and `guard` grew a step, so a
repository that upgrades may see a warning on a tree it did not touch. That
last one is the point of the release rather than a side effect of it.

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

Tracked in [NEXT_STEPS_V5.md](NEXT_STEPS_V5.md), listed so this file is a
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
