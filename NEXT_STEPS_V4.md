# Ratchet — Next Steps v4

> Supersedes [NEXT_STEPS_V3.md](NEXT_STEPS_V3.md) as the plan. That file
> remains the v0.7-era record and the place the coverage finding is written
> down; its item 1 is built and is v0.8. This file is the v0.9 plan. What
> exists is in [ratchet/README.md](ratchet/README.md).

## What v0.8 closed

One item from v3, the one that outranked the rest: **cover the class where the
defects actually are.** v0.8.0: 7,111 lines of `src`, 159 tests.

| v3 item | Built |
|---|---|
| 1a. An end-to-end CLI subject | `cli-end-to-end` — 13 scenarios spawning the real binary in real scratch git repositories, through the whole README loop |
| 1b. Uniformity checks, the static half | `source-uniformity` — five invariants over the source, plus `cli-errors-are-messages` over every command the binary lists, against three broken homes |

The self-host corpus went from five rows in one class to eight rows across
four. Writing the subjects found four defects in the previously empty rows,
including one in `adopt` that made every buildable subject report as flaky —
found by the new subject on its first run against history, while `adopt` was
in the act of arming it.

Then Experiments 2 (odds) and 4 (particles) were re-run against v0.8. Both are
recorded in [EXPERIMENTS_RATCHET.md](EXPERIMENTS_RATCHET.md); their readings
reproduce the v0 ones exactly, and they are the evidence base for everything
below.

## The finding that should shape v0.9: the gate refuses the checks people most want

**Five of the eight field subjects could not be armed.**

| Repo | Subject | Armed? | Why not |
|---|---|---|---|
| odds | `basic-edge` | yes | fails at `d329872`, passes from `94405eb` |
| odds | `solver-grade` | yes | same bug, same boundary |
| odds | `monty-hall` | **no** | passes at every commit in the range |
| odds | `texas-selfcheck` | **no** | passes at every commit in the range |
| particles | `galaxy-structure` | yes | fails through the fixed-potential era |
| particles | `physics-sanity` | **no** | passes at all 25 commits — v0 recorded this as a *negative result*, correctly |
| particles | `mode-table` | **no** | never violated |
| particles | `build` | **no** | never broken in this history |

Every refusal is the capture gate working exactly as designed:

> "a heuristic that cannot fail anywhere in your history has not been proven to
> catch anything."

And every refusal is wrong about the subject it refused. Monty Hall is 2/3 —
arithmetic, not a matter of this repository's history. Particle count must
equal capacity. The mode constants must index their own table. The tree must
build. These are the checks a team most wants standing, and *the reason they
have never failed is that they are worth having*.

**The proxy is measuring the wrong thing.** The protocol exists to refuse a
**vacuous** check — one with no power to discriminate, `process.exit(0)` or a
band so wide nothing violates it. It tests for that with "did it fail somewhere
in history", which conflates two situations that could not be more different:

- *vacuous* — the check cannot fail against **any** input. Refuse it.
- *standing invariant* — the check discriminates perfectly well; the property
  has simply never been violated **here**. This is the most valuable kind of
  check there is.

History cannot tell them apart, and it is not the only available evidence.

**So the requirement is wrong, not merely incomplete.** "Prove it failed on a
past bug" was adopted in v0.7 as *the* gate because it was the strongest proof
available at the time and because a convention that nothing enforces erodes —
both true, and neither an argument that it should be the only proof accepted.
A library whose stated purpose includes stopping regressions cannot require
that a regression have already happened. The v0.9 change is therefore a
correction: history-based proof stops being the gate and becomes the
*strongest tier* of proof, alongside a second tier that any honest check can
reach. The gate itself stays — a vacuous check must still be refused — but it
starts asking a question that a standing invariant can answer.

**And the hole is structural, not a matter of strictness.** It is not that an
unproven subject is merely warned about. `verify` enforces **rows**; `adopt`
refuses to capture a row when nothing in the range fails; and `capture` skips
any counterexample whose check passes now — *"not reproducible — check passes
now"*. So there is no path by which a never-failed invariant acquires a row,
and a subject with no rows never runs at the gate at all. It sits in
`heuristics.rules`, is listed `UNVALIDATED` by `ratchet yield`, and enforces
nothing. `guard --strict` would make that a build failure rather than a
warning, which is the wrong direction entirely: the answer to "this check has
never caught anything" cannot be "so fail the build until you delete it".

That is item 1 below, and it is the largest single adoption blocker the field
experiments have produced — larger than anything in v3, because it is not a
gap in coverage or vocabulary but the gate declining the majority of what it
is pointed at.

## Next pieces, in priority order

### 1. Proof without history, and a home for the standing invariant

Two changes, and the second is the one that makes the first useful. Together
they retire "prove it failed on a past bug" as the sole gate — it stays as the
strongest tier, and stops being the only one.

**1a. A second way to prove a check can fail.** Since v0.7 a heuristic is
*data*: the rules are pure predicates over named measures, so they can be
evaluated against a hypothetical reading with no process, no git, and no
clock. A declared rejection is therefore nearly free:

```
heuristic monty-hall
  run      node deal.js
  measure  keep  number after "Keep wins:"
  rule     keep is between 3200000 and 3500000
  rejects  keep 5000000
  because  Monty Hall is 1/3 keep and 2/3 switch, an outside truth that does
  because  not depend on any of this code being right
```

`rejects <measure> <value>` is a claim the tool checks: evaluate the rules
against that reading, and if they **accept** it, that is a hard error naming
the line — *"you declared that this heuristic rejects keep = 5000000, and every
rule accepts it"*. A proof that does not prove anything is caught the same way
a clause that does not parse is.

What this establishes and what it does not:

- the declared rejection proves the **rule discriminates**;
- any successful run of the instrument proves the **extraction works** — that
  `Keep wins:` is really in the output and really yields a number;
- together they refute vacuity without a bug ever having happened;
- what they do **not** prove, and what history does, is that the check catches
  a mistake a human actually made.

So the two proofs are *ordered*, not equivalent, and both must be visible.
`yield`, `report` and `guard` should say `validated against history` or
`validated against a declared counterexample`, never a bare "validated". A
reviewer who wants to know which subjects have only the weaker proof must be
able to see it at a glance — the entire argument for the capture gate was that
"validated once" must never quietly mean "trusted forever".

A stronger optional form, for when the extractor itself is the risky part:
`rejects output "Keep wins: 5000000"` runs the whole pipeline — extraction and
judgment — against a fabricated instrument output. More general, more verbose;
the measure-and-value form is the cheap default.

**What neither form proves, and should be said out loud:** that the instrument
*exercised* anything. A rule can discriminate perfectly and an extractor can
read a real number out of a run that set nothing up. Building v0.8's own
end-to-end subject produced a live example — the `home-flag-reaches-every-command`
scenario passed while comparing nothing at all, because the row it needed had
not been armed and `--home` resolves identically on an empty corpus either way.
It was fixed by asserting the precondition, which is a thing a human noticed
and no mechanism would have. Item 3 covers the shapes of this that *are*
mechanically detectable; this residue is not one of them.

**1b. Name the second category.** The corpus is memory of *counterexamples*: a
row says "this exact input once broke, and never again". A standing invariant
is not a counterexample and should not be forced to impersonate one. The tool
already has both natures — `verify` runs rows, `guard` is a gate, `replay
--subjects` already runs subject checks with no rows at all — and has simply
never named the second.

So: a heuristic proven by declared rejection enforces **as itself**, without a
row. `verify` runs rows ∪ standing invariants; `guard`'s rows step reports the
two separately; the catch rate stays a statement about rows, because that is
what it measures.

The alternative — minting a synthetic row from the declared rejection — is
less work and worse: it puts a counterexample in the corpus that never
happened, and the corpus's value is that every line in it is a thing that
really occurred.

*Acceptance.* `monty-hall`, `physics-sanity`, `mode-table` and `build` all
enforce on every commit in their own repositories, with no invented history,
and `ratchet yield` distinguishes their proof from `basic-edge`'s. A rule
whose declared rejection is accepted by the rule is a parse-time error with a
line and a column.

### 2. A transition has a direction, and a range can hold more than one

Experiment 4's headline result in v0 was that even-stride sampling plus
halving pinpoints the commit where the galaxy gained its arms, for 36% of the
dense cost. v0.8 does not reproduce it:

```
no pass -> fail transition inside this range (the earliest sample already fails)
```

`replay` searches for a `pass` followed by a `fail` and halves that window
only — the code says so outright (*"Only a pass -> fail transition is
pinpointed"*). Particles' boundary runs the other way: the arms *appeared*, so
the transition is fail → pass. `bisect` has the same orientation, and it
additionally requires `--good` to be an ancestor of `--bad`, which the
good side of a fix is not. Closing the window by hand took two probes and
confirmed v0's answer, `9f53b4d` — which is exactly the manual work `replay`
exists to remove.

"When did we lose the arms" and "when did we get them back" are the same
question asked twice, and a tool that answers only one of them answers it half
the time. Worse, a range that contains **both** a break and a fix — the
ordinary case for any bug that was found and fixed — reports at most the first
of them, labelled `first bad commit` whichever it is.

The fix is to stop looking for *the* transition and report *every* one: walk
the sampled verdict sequence, take each adjacent pair whose status differs,
halve each window independently, and label each by direction.

```
transitions (2):
  broke  at 3b89381  "Update README.md"           pass -> fail, halved in 2 probes
  fixed  at 9f53b4d  "widescreen refactor"        fail -> pass, halved in 2 probes
```

Monotonicity is still assumed *within* a window, exactly as today; sampling is
what finds the windows, and that assumption is per-window rather than
per-range. `bisect` takes the same generalization: name the boundary and its
direction rather than presuming which side is "bad". `na` and `na-env` samples
continue to be skipped over rather than treated as either side of a boundary.

*Acceptance.* `replay --good 3982e36 --every 4 --subjects --subject
galaxy-structure` on particles names `9f53b4d` as a fix with no hand-probing,
and a synthetic range containing a break and a later fix reports both.

### 3. "Green over nothing" has two more shapes, and both are detectable

`verify` already says when most of the gate reported `na` — *"most of this gate
is not checking anything here"* — because a gate that is green while checking
nothing is the quietest way for this tool to become theatre. Two more shapes of
exactly that turned up this session, and both are cheaper to detect than the
one already handled.

**3a. Zero rows is green and silent.** `ratchet verify` on an empty corpus
prints `0/0 rows pass` and exits 0; `guard` passes. That is right for a
freshly initialized home and wrong for a repository that declares subjects and
has armed none of them — which, after item 1, is the state every project will
pass through. It is not hypothetical: the v0.7 note recorded that `verify` and
the other twenty-one commands resolved `--home` identically when checked by
hand, and they *did*, because that check ran against an empty corpus where
both routes answer `0/0 rows pass`. With one row they disagree, and the
disagreement reddened every row in the corpus. A defect was written down as
"not a defect, the shape of one" because the gate was green over nothing.

**3b. An instrument that lives inside the tree it measures.** A check
configured as `node tools/check.js` runs the *checked-out commit's* copy of
that script — or, if the file is untracked, does not run at all in a worktree.
Both are silent at HEAD and wrong under `replay`, `adopt`, `bisect` and
`validate`, which is to say wrong exactly where the readings are supposed to be
comparable by construction.

This is not a hypothetical either: it is what the particles experiment did.
Its config pointed at `tools/ratchet-check.cjs`, which is untracked, while the
write-up listed *"Frozen instrument. The check script is pinned across every
commit"* as one of three guards on instrument integrity. It was true of odds
and false of particles, and nothing said so, because in v0 history commands
checked commits out in place and the distinction could not bite. v0.4 moved
history into worktrees and made it bite.

The tool has everything it needs to catch this: it knows the project root, it
knows the check command, and it knows whether the command reached its
instrument through `{home}` or `{ratchet}`. A check whose executable resolves
inside the measured tree and does not go through a token should say so — in
`fsck` and in `guard`, as a warning naming the subject and the one-line fix.

*Acceptance.* `guard` warns on a subject configured as `node tools/check.js`
and does not warn on `node {home}/tools/check.js`; `verify` and `guard` say
when a repository declares subjects and has no armed rows at all.

### 4. The measure vocabulary, with the gaps now named by name

Carried from v3 item 2, and no longer hypothetical — the odds re-run produced
two concrete failures to express, in the *only* subject of the four that did
not translate cleanly:

- **The nth match.** `monty-hall`'s natural reading is the *second*
  `Win percent:` in `deal.js`'s output. An extractor anchored to a label takes
  the first match and there is no way to say otherwise. The workaround was to
  anchor on `Keep wins:` and `Change wins:`, band the raw counts instead of
  the percentages, and pin the denominator with `total is 10000000` — which
  works, and couples the band to the instrument's iteration count, so
  changing the simulation's size would falsify a rule that is still true.
- **Comparing two measures.** The natural rule is `change is above keep`. The
  vocabulary has `is the same as <measure>` and nothing else, so a comparison
  between two readings of the same run can only be expressed as equality.
  `is above`, `is at least`, `is below`, `is at most` should all take a
  measure where they take a number.

Still outstanding from v3, unchanged and still real:

- **A baseline that moves.** `is within 5 percent of 0.5` works against a
  constant; the metric-budget shape is relative to the previous run or a named
  ref, and nothing expresses it.
- **Repeated structure.** A `for each` over rows of the output, so "every card
  has an image" stops needing someone to write a command that counts.
- **Two-sided readings.** Comparing across two runs — the round-trip shape.

*Acceptance.* `monty-hall` expressible as it is meant to be read: two `Win
percent:` readings and `change is above keep`, with no dependence on the
iteration count.

### 5. `na` is still doing two jobs

Unchanged from v3 item 3. `applies when <path> exists` covers "this feature did
not exist yet"; it does not cover "the instrument cannot run here", which
reports as a hard failure and manufactures a regression out of dependency rot.
`replay --setup` distinguishes these as `na-env`; the probe does not.

The particles re-run made this concrete: `.ratchet/tools/metrics.cjs` had to
grow its own three-way split — `na` for a commit with no sim, `broken` for an
instrument that could not compile, `report` for a real measurement — because
the vocabulary offers only the first. Every scripted instrument re-invents
that distinction; it belongs in the tool.

### 6. The catch rate still undercounts

Unchanged from v3 item 4, and now with an extra reason to care: `ratchet
report` on this repository reads `all-time: 0 caught, 8 new (0%)`, and will
keep reading 0% no matter how well the tool works, because the rate counts
**retired-row recurrences** only. A known bug re-failing while its row is
still *active* — the common case, the case the whole tool is for — is not
journaled and never reaches the numerator.

The fix is a decision, not a mechanism: journal active-row failures as catches
and accept the journal noise, or add a second counter. Decide, then do it. It
is item 6 rather than item 1 because it is a reporting honesty gap rather than
a functional one, but it is the number a reader looks at first.

### 7. Mode 2, mine

Unchanged from v3 item 5. `ratchet history` walking test-file history to
resurrect deleted and weakened assertions as corpus rows — the one remaining
mode from [RATCHET.md](RATCHET.md) with a clear shape and no implementation,
and the highest-leverage source of rows for a repository adopting the tool
with no recent bug history to `adopt` against.

Note the interaction with item 1: a repository with no bug history is exactly
where the capture gate bites hardest today, and mode 2 and declared rejections
are the two independent answers to it.

### 8. The agent attach

Unchanged from v3 item 6. **Proposal**: a documented shape for an agent
emitting candidate `heuristic` blocks, which then go through the same gate as
a human's — and declared rejections (item 1) are what make bulk generation
safe, since a generated heuristic that cannot state a reading it rejects is
exactly the vacuous kind. **Dispatch**: on a red row, hand the agent the
witness, the input, the bisected commit and the journal entry. Neither
requires the ratchet to call a model.

### 9. Design debt

Numeric witnesses on *scripted* rows, mode 3 semantic history, sampled
behavioral diffs beyond visual pins, per-commit artifact caching for replay.
Unchanged, but the last one now has numbers on it: arming one subject took
**3m44s over 9 commits** on odds and **2m18s over 6** on particles, and almost
all of it is setup and build repeated per commit — `physics-sanity` alone is
48 s a probe, of which the measurement is a fraction. Caching a commit's build
across the probes that need it is the difference between a replay someone runs
and one they mean to.

Adjacent, and the same shape as "bundle the probe" was in v3: **every project
hand-rolls its worktree setup.** This repository has `.ratchet/tools/build.js`;
particles needed `.ratchet/tools/prepare.cjs`; both do the same two things —
supply `node_modules` without hitting the network once per commit, then build.
Neither is interesting, both are load-bearing, and a project cannot replay
anything until it has written one.

## What the two re-runs said about the prose form

Worth stating as a finding in its own right, because the README currently
makes the claim unconditionally: **the economics of prose depend on the shape
of the subject.**

| | odds | particles |
|---|---|---|
| subject shape | run something, read a number, band it | compile a sim, integrate 65,536 particles, take a Fourier amplitude |
| before | 86 lines of JavaScript | 132 lines of JavaScript |
| after | **0** | 174 lines of JavaScript + 61 of prose |
| what prose bought | the plumbing, entirely | separation of judgment from instrument; a genuinely frozen instrument; every failing clause in the witness instead of the first |

Prose removes *all* of the code where the subject is a reading and a band, and
that is the common case — it is what the field experiments found check bugs
inside, every time. Where the subject needs arbitrary computation it adds a
layer instead, and the return is reviewability rather than size: eighteen
`if` statements became fourteen sentences a physicist can change without
touching JavaScript. Both are worth having. Only one of them is a saving, and
the README should say so.

The particles number also carries a cost that is nobody's fault and should be
disclosed: 26 of those lines are a setup script that exists **only** because
history commands run in an isolated worktree — the right design, adopted in
v0.4, which happens to mean a project's instrument can no longer assume its
dependencies are simply there.

## Limitations to keep disclosed

- **A check that has never failed cannot be armed** (item 1). Five of eight
  field subjects. Until that is fixed, the honest description of the tool is
  "regression memory for bugs you have already had", not "a gate".
- **`replay` and `bisect` only find regressions**, not fixes (item 2).
- **The catch rate undercounts** (item 6); `report` reads 0% and will continue
  to.
- **A green gate can still be checking nothing** (item 3): zero armed rows
  passes silently, and an instrument living inside the measured tree is
  correct at HEAD and wrong across history.
- **The self-host corpus covers four classes, not five.** Packaging and
  hygiene — R16, R19, R21 — still have no rows, and unlike the three classes
  v0.8 covered, this one has no obvious instrument: "the published package
  contains what it should" is checkable, but only against a `npm pack` whose
  output nothing currently reads.
- `seed` seeds `Math.random` in Node processes only. A `crypto`- or
  clock-driven instrument, or a non-Node one, is not made deterministic.
- A pre-commit hook is advisory; CI is the authoritative gate.
- `ratchet heuristics log` needs real git history; a shallow clone degrades to
  the hashes.
- **The end-to-end subject is the slowest thing in the gate** — about 17 s,
  against 6 s for the error-path prober and 0.1 s for the static scanner.

## Open product questions

- **Should `guard --strict` be the default?** Item 1 changes this question's
  shape: with declared rejections, "every subject is proven" becomes a
  reachable state rather than an unreachable one, and `--strict` becomes
  arguable rather than punitive. Revisit after item 1, not before.
- **Per-branch corpora** — open since v1.
- **Does a validation proof expire** when the rule hash changes, or merely
  quarantine? Current behavior ties the proof to the hash, so an edit closes
  the capture gate again. That is the strict reading; it may be too strict for
  a typo fix, and it applies to declared rejections too — where it is more
  clearly right, since editing a band is exactly when its rejection should be
  re-checked.
- **Where do generated heuristics land?** A separate file, a marked block, or
  indistinguishable from human ones once they pass the gate? The review-ratio
  argument says the provenance should stay visible.

## Conclusion

v0.8 put the tool's own corpus where its own bugs are, and the two field
re-runs say the mechanisms built since v0 hold up: the readings reproduce
exactly, the plumbing that used to hold every check bug is gone where the
subject shape allows it, and one command now does what was hand-rolled bash.

What the re-runs also say is that the gate is turning away most of what it is
offered. Five of eight real subjects were refused for never having failed,
and the refusals were unanimous in one direction: they were the *standing
invariants* — the arithmetic, the conservation law, the table that indexes
itself, the build. The tool is currently very good at remembering bugs a
project has already had and structurally incapable of guarding against one it
has not. Item 1 is that, and everything else on this list is smaller.
