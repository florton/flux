# Ratchet v0.9 — Issues

Recorded 2026-09-07, after building items 1–5 of
[NEXT_STEPS_V4.md](NEXT_STEPS_V4.md) (`ratchet/` at 8,328 lines of `src`, 193
tests, `ratchet guard` green on this repository). Numbered `R22..R25` to
continue the series in [ISSUES_RATCHET.md](ISSUES_RATCHET.md), whose `R1..R21`
are all closed.

**All defects here are now closed** — fixed later the same day, with R26 and
R27 added because fixing R25 walked through the clause they live in.

**Superseded in part, the same day.** Work that continued after this file was
written closed **K5** (see R29) and reproduced **O1**, which had been filed as
observed-but-unexplained (see R28 — it was a wall-clock assertion in the suite,
not anything in the tool). Both are marked in place below. Everything found
after this file, open and closed, is in
[OUTSTANDING_RATCHET.md](OUTSTANDING_RATCHET.md), which is the current answer to
"what is outstanding"; this file is the record of the v0.9 review itself.

**Method, unchanged.** Every defect below was reproduced by execution against a
scratch project, and each entry keeps the transcript that produced it. Nothing
here is inferred from reading alone. Where something was observed and could not
be reproduced, it is filed separately and labelled as such rather than written
up as a defect. The fixes were held to the same standard: each regression test
was run against the pre-fix build and confirmed to fail there before being
kept.

**Summary.** One critical finding: a `#` preceded by whitespace inside a quoted
clause value is stripped as a comment, silently truncating the rule. The
truncated rule usually fails red, which is the safe direction — but a
`does not contain` rule truncates into a *weaker* rule, and a subject whose
proof rests on a different clause then passes the gate while the property it
names is violated. That is a silent false pass, which is the one thing this
tool exists to prevent. The other five are small and none of them can green a
build.

| # | Severity | Status | Issue | Location |
|---|---|---|---|---|
| R22 | **critical** | **closed** | `#` inside a quoted clause value is stripped as a comment; the rule is silently truncated | `ratchet/src/heuristics.ts` (the comment stripper in `parseHeuristics`) |
| R23 | low | **closed** | `guard` tells a *scripted* subject to add a `rejects` line, which only prose supports | `ratchet/src/guard.ts` (validation step) |
| R24 | low | **closed** | The frozen-instrument detector misses an instrument that is not the first command of a shell-mode check | `ratchet/src/instrument.ts:instrumentPath` |
| R25 | low | **closed** | The error caret points into whitespace for column-aligned clauses — the form `ratchet fmt` itself writes | `ratchet/src/heuristics.ts` (`bodyColumn`) |
| R26 | low | **closed** | `rejects <measure>` with no value reports "not a measure (declared: *that measure*)" | `ratchet/src/heuristics.ts` (the `rejects` clause) |
| R27 | low | **closed** | `rejects output <unquoted>` reports "output is not a measure" instead of naming the real complaint | `ratchet/src/heuristics.ts` (the `rejects` clause) |

**Closed 2026-09-07.** All six fixed, each with a regression test that was
confirmed to fail against the pre-fix build and pass after it — the suite went
from 193 tests to 203, and `test-suite`'s floor was raised to match. R26 and
R27 were not in the original list: they were found by execution while fixing
R25, in the clause the caret work passed through. Details are under each entry
below; what changed for a user of an existing rules file is under R22.

Beyond the defects, this file also records the **accepted trade-offs** (K1–K5),
one **observation that could not be reproduced** (O1), and a pointer to the
plan work that is simply not built yet.

---

## R22 — critical — a `#` inside a quoted value truncates the rule silently

The clause-line comment stripper is `raw.replace(/(^|\s)#.*$/, "$1")`. It has no
notion of quoting, so a `#` that follows whitespace *inside* a double-quoted
value is taken as the start of a comment and everything after it is discarded.

The quote is then unbalanced, `unquote` fails, and the predicate falls back to
the raw text — which now begins with a `"` character that was never meant to be
part of the value.

**Reproduced.** A release check that forbids a debug banner:

```
$ cat .ratchet/heuristics.rules
heuristic release-banner
  run      node build.js
  measure  line   the output
  measure  count  count of lines matching "release"
  rule     count is 1
  rule     line does not contain "debug # verbose"
  rejects  count 0
  because  a release build must not ship the verbose debug banner

$ node build.js
release ok
debug # verbose tracing is ON

$ ratchet heuristics
release-banner  (rule 03e15ba7f1f461f2, heuristics.rules:1) — 0 rows, validated against a declared counterexample, enforcing as a standing invariant
  run  node build.js
  rule count is 1
  rule line does not contain "debug          <-- the rule the file declares is not the rule that runs
  rejects count 0  (checked: the rules must refuse this)

$ ratchet guard
✓ standing             1/1 standing invariants hold
guard passed with 2 warning(s)
```

The output plainly contains `debug # verbose`, the file plainly forbids it, and
the gate is green.

**Why it is critical.** `does not contain "debug # verbose"` truncates to
`does not contain "debug` — a *weaker* rule, because the value it now looks for
(`"debug`, with a leading quote) does not occur. Truncation makes `contains`,
`is`, `starts with` and `ends with` stricter, so those fail red and are noticed;
it makes the negated forms laxer, and those pass.

**What limits the blast radius.** Two things, both accidental rather than
designed:

- Since v0.9 an unproven prose subject enforces nothing at all, so a heuristic
  with a single mangled rule and no `rejects` clause never runs.
- A declared rejection is evaluated against the *mangled* rule, so it often
  stops holding and the file fails to parse. That is what happened on the first
  two attempts at this repro:

  ```
  heuristics.rules:5:11: you declared that "no-debug-banner" rejects line = release, and every rule accepts it ("line does not contain ""release"")
  ```

  The case above defeats that by proving the subject with a *different* clause
  (`rejects count 0`, judged by `count is 1`), which is the ordinary shape for a
  heuristic with more than one rule.

**Loud variants, for completeness.** With a space before the `#`, an *extractor*
value mangles into a parse error, which is safe but misleading — it blames the
extractor phrase rather than naming the real cause:

```
$ ratchet heuristics       # measure found  count of lines matching " #tag"
heuristics.rules:3:17: not a way to measure something: "count of lines matching ""
   3 |   measure  found  count of lines matching " #tag"
     |                 ^
     did you mean `count of`?
```

A `#` **not** preceded by whitespace is fine: `matching "#tag"` parses and works,
because the stripper requires `(^|\s)` before the `#`.

**The fix, as built.** `stripComment` in `heuristics.ts` scans the line and
pairs quotes the way `canonicalizeClause` already pairs them when it lifts
literals out — every `"` toggles — so the stripper and the rewriter cannot
disagree about where a literal is. A `#` still opens a comment only at the
start of a line or after whitespace, so `matching "#tag"` and a `run` command
containing `x#y` are untouched. The result is always a prefix of the input, so
caret columns still index the original line. Both call sites use it: the parse
loop and the `before` text `fmt` reports rewrites against.

The one form it cannot see is a backslash-escaped quote inside
`rejects output "a \" # b"`: pairing closes the span at the escaped quote and
strips from the `#`. That direction fails loudly — what is left is no longer
one double-quoted string and the clause is refused. The alternative,
escape-aware pairing, would swallow the rest of the line after any value ending
in a backslash, which an extractor label holding a Windows path does. Chosen
deliberately, in the safe direction, and written down in the function.

Regression tests, per the prescription above: one `does not contain` (the false
green), one `contains` (the false red), both asserting the parsed text *and*
the judgement; one that ` #tag` and `#tag` both survive as extractor labels;
and one that a real comment after a balanced quoted value is still stripped, so
the fix did not go the other way. All four fail against the pre-fix build.

**One thing this write-up missed.** `ratchet fmt` re-writes the file from the
parsed heuristics, so it wrote the *truncated* rule back to disk — the first
format after such a rule was authored destroyed the author's text, leaving no
evidence of the original intent. That was found by re-running the repro on a
project the first attempt had already formatted, and it means the blast radius
was larger than "the rule that runs is not the rule the file declares": after a
format, the file no longer declared it either.

**Upgrading an existing rules file.** A clause with a `#` in a quoted value now
parses as written, so its text and its rule hash change. Rows armed against the
truncated rule quarantine as "the heuristic moved", which is correct — the rule
did move, to the one the file always said. `ratchet heuristics` prints each
rule as it will be enforced; read it before re-arming.

---

## R23 — low — `guard` gives a scripted subject advice it cannot take

`rejects` is a clause in `heuristics.rules`; a subject declared in `config.json`
has no rules file block and cannot have one. The validation step offers it
anyway.

**Reproduced.** A project with one scripted subject and one prose subject:

```
$ ratchet guard --strict
✗ validation           1 subject(s) have no proof they can fail: scripted
    prove one against history:   ratchet validate scripted --known-bad <sha> --known-good HEAD
    or without it, in the rules: rejects <measure> <a value the rules must refuse>
    1 validated against a declared counterexample: multi

guard failed: validation
```

`scripted` cannot take the second suggestion.

`ratchet capture`'s refusal is already correct here — it offers `validate` and
`adopt` and does not mention `rejects` — so this is one message, not a class.

**The fix, as built.** The `rejects` line is offered only when at least one
unproven subject came from the rules file, and when only some did it names
which — so the advice is never addressed to a subject that cannot take it.
History proof suits both kinds and is always offered.

```
$ ratchet guard --strict          # one scripted subject, unproven
✗ validation           1 subject(s) have no proof they can fail: scripted
    prove one against history:   ratchet validate scripted --known-bad <sha> --known-good HEAD
    1 validated against a declared counterexample: multi

$ ratchet guard --strict          # add an unproven prose subject
✗ validation           2 subject(s) have no proof they can fail: scripted, unproven-prose
    prove one against history:   ratchet validate scripted --known-bad <sha> --known-good HEAD
    or without it for unproven-prose, in the rules: rejects <measure> <a value the rules must refuse>
```

Visible on this repository: `visual-diff-is-sound` is the K5 scripted subject,
and `ratchet guard` no longer tells it to write a `rejects` line.

`formatHeuristicList` offers the same advice and was checked: it lists only
prose heuristics, so `rejects` is always available there. Unchanged.

---

## R24 — low — the frozen-instrument detector reads only the first command

`instrumentPath` inspects `argv[0]` and, when that is a known interpreter, the
first non-flag argument after it. A shell-mode check whose instrument is not the
first command is therefore missed.

**Reproduced.**

```
$ cat .ratchet/config.json
{ "subjects": { "chained": { "check": "cd . && node tools/check.js", "shell": true } } }

$ ratchet fsck
corpus: 0 events, 0 rows
[?] instrument-inside-tree: "multi" measures the tree through out.js, ...
no errors                      <-- "chained" is not reported
```

`tools/check.js` is inside the measured tree and untracked-by-default, which is
exactly the shape the check exists to name; the detector sees `cd`, which is not
an interpreter and contains no path separator, and returns nothing.

This is a **missed warning**, not a false pass: nothing about the gate's verdict
changes. The detector was written deliberately narrow — a *directory* argument
is also not treated as an instrument, so `node --test dist/test/` is correctly
silent — and this is the cost of that.

**The fix, as built — and the decision it required.** In shell mode the command
is split on `&&`, `||`, `;`, `|` and newline, and the existing rule runs over
each segment. `instrumentPath` became `instrumentPaths`, returning every
instrument in order, deduplicated; `instrumentPath` remains as the
first-result wrapper. Each instrument that resolves inside the tree is now its
own finding with its own fix, so a command reaching two of them names both.

The decision the write-up asked for: **the splitter is quote-aware and nothing
more.** `node -e "a && b"` is one segment, because the operator is inside a
string the shell never sees as one. Grouping (`(...)`, `$(...)`), redirection
and a trailing `&` are not modelled, and a script body passed to `sh -c` is
still not searched — it is a string, not a path. This reads far enough to find
program names, not far enough to be a shell. Both halves were done: the
limitation is also stated in the README, next to the warning it qualifies.

```
$ ratchet fsck            # all three now reported; `quoted` correctly is not
[?] instrument-inside-tree: "plain"   measures the tree through tools/check.js, ...
[?] instrument-inside-tree: "chained" measures the tree through tools/check.js, ...
[?] instrument-inside-tree: "piped"   measures the tree through tools/check.js, ...
[?] instrument-inside-tree: "semi"    measures the tree through tools/check.js, ...
```

Checked against this repository, which gains no new warnings from the change.

**One narrowing left in place, deliberately** — and closed later the same day
as [R30](OUTSTANDING_RATCHET.md), once it was clear the skip could be made
exactly as wide as its reason without reading any more shell. In shell mode a segment whose
program is `sh`, `bash` or `zsh` is skipped, because what follows `sh -c` is a
script body rather than a path. That predates the split and now applies per
segment, so `cd . && bash tools/setup.sh` is still silent while
`cd . && ./tools/setup.sh` is reported:

```
"cd . && bash tools/setup.sh"  -> []
"cd . && ./tools/setup.sh"     -> ["./tools/setup.sh"]
"sh -c \"node tools/check.js\"" -> []
"node a.js && node a.js"       -> ["a.js"]        # deduplicated
```

Narrowing it to "skip only when a `-c` flag is present" would catch the first
case, and the guard's own comment concedes it is mostly redundant — a script
body does not resolve to a file, so it produces no finding either way. It was
left alone because it is a deliberate decision by the original author, because
widening it means parsing more shell than the README has just committed to,
and because the common form (`./tools/setup.sh`) already works. Stated in the
README next to the warning it qualifies, rather than fixed quietly.

---

## R25 — low — the error caret points into whitespace

`bodyColumn` is `indent + keyword.length + 2`, which assumes exactly one space
between the keyword and its body. The canonical form `ratchet fmt` writes aligns
clause bodies into a column, so every caret in a formatted file points at
whitespace rather than at the text it is about.

**Reproduced.**

```
$ ratchet heuristics
heuristics.rules:4:8: "is abov" is not a comparison
   4 |   rule     v is abov 5
     |        ^                <-- the body starts at column 12
     did you mean `is above`?
```

The message and the suggestion are right; only the caret is misplaced. It has
been this way for every clause since v0.7 and is listed here because the tool
*itself* produces the alignment that makes it wrong.

**The fix, as built.** The body column is measured from where the body actually
starts — the keyword's end plus the whitespace run that follows it. With no
body there is nothing to point at, so the caret goes just past the keyword,
where the body should have been.

```
$ ratchet heuristics
heuristics.rules:4:12: "is abov" is not a comparison
   4 |   rule     v is abov 5
     |            ^
     did you mean `is above`?
```

**The same defect one level down, also fixed.** Carets *inside* a clause were
arithmetic over the parsed pieces — `bodyColumn + name.length + 1` for a
`measure`'s extractor, `bodyColumn + 7` for `rejects output`, `bodyColumn +
rejected.length + 1` for a `rejects` value. Each assumes one space, and the
`measure` case is worse than that: its body is canonicalized before it is
split, and canonicalization collapses runs of whitespace, so those lengths
describe a string the file does not contain. A `tokenColumn` helper counts
whitespace-separated tokens in the source line instead. Measured before and
after: the extractor caret on `  measure  v      count of lines mtaching "x"`
moved from column 14 to 19, which is where `count` is.

**Two tests changed rather than added.** `a declared rejection the rules
refuse...` and `...ACCEPT is a parse error with a line and a column` asserted
column 11 on `  rejects  keep 5000000`, with a comment stating the rule as *"the
keyword's end plus one, whatever the author's alignment"*. Column 11 is the
second space; `keep` is at 12. The tests had pinned the defect, so the fix
turned them red — they now assert 12, and the comment states the corrected
rule.

---

## R26 — low — `rejects <measure>` with no value denies the measure it names

Found by execution while checking R25's carets, in the clause the caret work
passed through. Not in the original list.

The measure lookup matched `name + " "`, so a body that was *only* the measure
name matched nothing and fell through to the unknown-measure branch. The
message then names the measure as unknown, lists it among the declared
measures, and suggests it:

```
$ ratchet heuristics
heuristics.rules:5:12: "ok" is not a measure of this heuristic (declared: ok)
   5 |   rejects  ok
     |            ^
     did you mean `ok`?
```

The right message existed and was unreachable — `rejects ok` names no value, so
the "names no value" branch two lines below is the one that should fire.

**The fix.** Match the name against the whole body as well as against
`name + <whitespace>`. The longest-name-first ordering already in place keeps
`ok` from shadowing `okay`.

```
heuristics.rules:5:14: `rejects ok` names no value — say what reading of ok the rules must refuse
   5 |   rejects  ok
     |              ^
```

---

## R27 — low — `rejects output <unquoted>` reports the wrong complaint

Same clause, same session, also by execution.

Only the fully-quoted form `rejects output "..."` entered the fabricated-output
branch. An unquoted tail fell through to the measure lookup and reported that
`output` is not a measure — sending the author to declare one, which is not
what they meant:

```
heuristics.rules:6:12: "output" is not a measure of this heuristic (declared: ok)
   6 |   rejects  output not-a-quoted-string
```

The branch's own message — "the output after `rejects output` must be one
double-quoted string" — was reachable only when the quotes were already there
and merely unbalanced.

**The fix.** Enter the branch when the body opens with the word `output` and no
measure claims that name, then complain about the quoting. A heuristic that
*does* measure something called `output` still falls through to the measure
reading, which is the existing ambiguity rule and is unchanged.

```
heuristics.rules:6:19: the output after `rejects output` must be one double-quoted string
   6 |   rejects  output not-a-quoted-string
     |                   ^
```

---

## Accepted trade-offs

These are not defects. They are decisions with a cost, recorded so the cost is
visible rather than discovered.

**K1 — exit 126 is also the shell's "found but not executable".** v0.9 uses 126
for *"this environment cannot run the check here"*, the outcome that separates
dependency rot from a regression. On POSIX a shell reports 126 when a command is
found but not executable, so a `shell: true` subject with a non-executable entry
point reports "could not run here" instead of failing. The collision points the
same way — both mean the environment cannot run it — and it is loud rather than
silent, because a subject that returns no verdict at every commit trips the
coverage warning immediately:

```
$ ratchet verify           # a check that exits 126
∅ deadbeefdeadb notexec null — could not run here: this environment cannot run the check here

0/1 rows pass, 1 could not run here
1 of 1 rows returned no verdict (0 n/a, 1 could not run here) — most of this gate is not checking anything here
```

**K2 — `replay --subjects` runs subjects that `verify` refuses to run.** An
unproven prose heuristic enforces nothing at the gate, and `replay --subjects`
runs it anyway. That is deliberate: pointing an unproven check at history is how
you *find* the proof, and it is what `adopt` does internally. It is written down
here because the two commands giving different answers about the same subject
looks like a bug until you know why.

```
$ ratchet verify
0/0 rows pass
this repository declares 1 subject(s) and has no armed rows and no standing invariants — ...

$ ratchet replay --good HEAD~1 --subjects
  ✗ 761dedd3  2026-09-07  0 pass, 1 fail  c2
```

**K3 — `verify --row <id>` reports no standing invariants.** Asking about one
counterexample is not asking about the gate, so the standing invariants are
skipped and the summary says `1/1 rows pass` with no mention of them. Correct,
and easy to misread as "the gate is green".

**K4 — neither proof shows the instrument exercised anything.** A rule can
discriminate perfectly and an extractor can read a real number out of a run that
set nothing up. v0.8 produced a live example: an end-to-end scenario passed
while comparing nothing at all, because the row it needed had not been armed and
`--home` resolves identically on an empty corpus either way. It was fixed by
asserting the precondition — a thing a human noticed and no mechanism would
have. This is the residue after R22 is fixed and after item 3's two shapes are
detected, and it is not mechanically detectable.

**K5 — `visual-diff-is-sound` has no proof and cannot get a cheap one.**
**Closed the same day — see [R29](OUTSTANDING_RATCHET.md).** It is a scripted
subject, so `rejects` is unavailable to it, and it has never failed in this
repository's history, so `adopt` has nothing to arm it with. It is the one
subject `ratchet guard` still warns about here. Either it gets a history proof
from a commit where the diff was wrong, or the declared-rejection idea needs a
form that scripted subjects can express.

The diagnosis was right and understated the problem: the subject had no rows
either, and a scripted subject with no rows is never run at all, so the
comparator was ungated rather than merely unproven. It is now a prose heuristic
that keeps the same script as its instrument, which is the third option this
entry did not consider. The general question — whether a *scripted* subject
should be able to declare a rejection — is still open, as R31.

---

## O1 — observed once, not reproduced — **reproduced later the same day, see [R28](OUTSTANDING_RATCHET.md)**

> The cause was a test, not the tool: `replay --jobs probes commits on parallel
> worktrees` asserted that a parallel replay beat a serial one by 40%, which is
> a measurement of the machine. Node runs test files in parallel, so under
> whole-suite load the ratio drifted and the suite went red about one run in
> three — which is why nine deliberate retries all came back green and no cause
> was found. The prediction below that "the witness will now say which test
> failed" turned out to be half right, and the other half is R32. Everything
> after this line is as it was written.

`ratchet pr-comment` reported the `test-suite` standing invariant broken,
minutes after `ratchet guard` had reported it green, with no edit in between:

```
$ ratchet pr-comment
### Ratchet

**1 standing invariant broken** — a property that has always held here does not any more.

| standing invariant | witness |
|---|---|
| test-suite | `node --test ratchet/dist/test/` exited 1 before any rule could be checked: TAP version 13 \| # Subtest: junit: CDATA, ... |
```

**Not reproduced.** Nine subsequent attempts were green: three `pr-comment`,
three `verify`, three `verify --jobs 8`, plus four standalone runs of the suite
itself. No test writes to a fixed shared path — every fixture is `mkdtempSync` —
and no cause was established. It is recorded rather than explained.

Two things about it are worth keeping:

- It happened while `test-suite` did **not** measure its exit code, so any
  nonzero exit short-circuited before the rules ran. The heuristic now measures
  it, so the same event today would report `failing measured 1, rule says
  "failing is 0"` rather than "exited 1 before any rule could be checked".
- The witness was truncated to the TAP banner, naming no failing test. That was
  a real defect and is fixed: excerpts now show both ends of the output with the
  dropped-line count, so the failing line survives.

If it recurs, the witness will now say which test failed. Until then there is
nothing honest to write beyond this.

---

## Not defects — plan work that is simply not built

Tracked in [NEXT_STEPS_V4.md](NEXT_STEPS_V4.md); listed here so this file is a
complete answer to "what is outstanding".

- **Item 6, the rest of the catch rate.** A red run fed to `capture` whose input
  matches an *active* row now counts. A row that goes red under `ratchet verify`
  and is fixed without anyone running `capture` still does not. Journaling from
  the gate was rejected: `guard` runs in pre-commit hooks and appending to a
  committed file mid-commit dirties the tree.
- **Item 4, the rest of the vocabulary.** A baseline that moves (metric budgets
  relative to a previous run or a named ref), repeated structure (`for each`
  over rows of the output), and two-sided readings across two runs.
- **Item 7, mode 2** — `ratchet history` mining test-file history for deleted
  and weakened assertions.
- **Item 8, the agent attach** — a documented shape for generated heuristics,
  and dispatch on a red row.
- **Item 9, design debt** — per-commit artifact caching (arming one subject cost
  3m44s over 9 commits on one field repository and 2m18s over 6 on another,
  almost all of it setup and build repeated per commit), and the fact that every
  project still hand-rolls its own worktree setup script.
- **The fifth coverage class.** Packaging and hygiene — R16, R19, R21 — still
  have no corpus rows. Unlike the three classes v0.8 covered, this one has no
  obvious instrument: "the published package contains what it should" is
  checkable, but only against an `npm pack` whose output nothing currently reads.
