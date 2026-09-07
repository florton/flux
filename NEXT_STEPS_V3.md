# Ratchet — Next Steps v3

> Supersedes [NEXT_STEPS_V2.md](NEXT_STEPS_V2.md) as the plan. That file
> remains the v0.6-era record. This file is the v0.7 plan. What exists is in
> [ratchet/README.md](ratchet/README.md).

## What v0.7 closed

All five priorities from v2 are built, tested, and running under the ratchet
itself. v0.7.0: 7,006 lines of `src`, 153 tests passing in 14.7 s, up from 70.

| v2 item | Built |
|---|---|
| 1. Heuristics as data | `.ratchet/heuristics.rules` — closed-vocabulary prose, a bundled probe, a bundled seeded-RNG preload, `ratchet fmt` |
| 2. Validation as a capture gate | `capture` refuses unproven subjects; `--allow-unvalidated` is journaled; a proof dies with the rule it was proven under |
| 3. `ratchet adopt` | one command: run across history, capture the oldest failure, record the proof, pin to today's rule |
| 4. Yield reporting | `ratchet yield`, staleness and never-fired in `report`, the n/a share in `verify` and `guard` |
| 5. Distribution | `ratchet pr-comment`, a committed CI workflow, `base..merge` replay documented |

Two things were added that v2 did not ask for, both of which turned out to be
load-bearing.

**`ratchet guard` and `ratchet hooks install`.** Every guarantee the tool
offered needed a human to remember a different command. That is not a
mechanism, it is a habit, and habits lapse. One gate, one exit code, wired into
pre-commit and CI.

**The prose diff on quarantine.** `ratchet heuristics log` reads a heuristic's
change history out of `git log` over the rules file — no ledger to keep in
sync, and it works retroactively. When a row quarantines, `verify` now prints
the clause that moved and the commit that moved it. "rule fd59… became a3b1…"
was never going to be read by anyone.

## The thesis, unchanged

The unit of work is the **human-authored characteristic** — named,
decomposable, measurable. The ratchet's four verbs are prove, arm, tend,
report. What it never does is invent the characteristic.

v0.7's contribution to that thesis is that the characteristic is now *cheap*.
A band that took forty lines of hand-written plumbing — which is where the
field experiments found every check bug — is five lines of prose that a domain
expert can write and review. That is the difference between the human writing
characteristics and writing instruments.

## The finding that should shape v0.8: the corpus is in the wrong place

Recorded 2026-09-06, after a pass that fixed eleven defects in this tool while
the tool's own gate stayed green through ten of them. The question worth
answering was not "why are there bugs" but **"why did the ratchet not catch
them, since that is the one thing it exists to do."**

Ten of the eleven were first occurrences in code written the same day.
Regression memory has nothing to say about a defect's first appearance — that
is the mechanism working as designed, not failing. But the eleventh is the
interesting one, and so is the shape of the ten.

**The self-host corpus covers one class of defect, and it is not the class
this codebase produces.** Classifying the twenty-one v0 review defects
([ISSUES_RATCHET.md](ISSUES_RATCHET.md)) against the six subjects in
`.ratchet/config.json`:

| Class | v0 defects | Subjects covering it |
|---|---|---|
| Corpus & data-structure semantics | R2, R3, R4, R5, R20 | **5** |
| Process boundary — spawn, env, path, worktree | R1, R6, R9, R10, R14 | **0** |
| CLI surface & error paths | R8, R11, R12, R13, R15, R18 | **0** |
| Capture-path routing | R7, R17 | **0** |
| Packaging & hygiene | R16, R19, R21 | **0** |

Five of twenty-one, all in one row. Those five are the pure-function-shaped
defects: fold order, id collision, reduction slippage, dedup partitioning,
stringify injectivity. They got subjects because they were the ones a scratch
corpus and a `deepStrictEqual` could reach. The other sixteen needed a real
process, a real git repository, or a real command line, and none of them got
anything.

That is the finding, stated plainly: **the corpus was built where it was easy,
not where the bugs live.** Every subject the tool ships is a check of a data
structure. Every defect this pass found — outside the brand-new prose parser —
was at a process boundary.

**The escapes land exactly in the empty rows.** Of this pass's eleven:

| # | Defect | Class | Covered? |
|---|---|---|---|
| 1 | `NODE_OPTIONS` preload path mangled on win32 | process boundary | no |
| 2 | `guard` threw a stack trace on a corrupt corpus | CLI error path | no |
| 3 | `--setup` could not reference `{home}` | process boundary | no |
| 4 | `{home}` unsubstituted in shell mode | process boundary | no |
| 5–10 | `fmt` data loss, `init` phantom subject, four parser defects | new surface, no prior version | n/a |
| 11 | the capture gate broke two self-checks | corpus semantics | **yes — caught** |

Number 11 was caught, loudly, by `verify`: *"a different failure than the one
captured."* It was caught because it landed on covered ground. Nothing else
did.

**The recurring shape is partial application of a mechanism.** This is the part
that should worry us most, because it has now happened three times across three
versions:

- **v0 (R12)** — `--home` honored by 2 of 8 commands.
- **v0.7** — `{home}` substituted in 1 of 2 spawn modes.
- **v0.7** — `homeDir` passed to the check but not to `--setup`.

Same defect, three instances: a mechanism defined once and then wired into some
of its call sites. **A corpus row cannot catch this class.** A row is a
counterexample — one input, one subject — and partial application is a
*completeness* property over a set of call sites. It needs a static check,
which has sat unbuilt on the design-debt list since v1 and is promoted to
item 1b below for exactly this reason.

Uniformity is currently maintained by convention, and the convention is already
frayed. `--home` reaches all twenty-two commands today, but by two different
routes: twenty-one call `homeDir(cwd)`, while `verify` passes the raw flag and
re-resolves it itself. Both were checked against a relative `--home` from a
nested directory and they agree — so this is not a defect, it is the *shape* of
one, sitting in the codebase unremarked. Nothing fails when the twenty-third
command picks a third route.

**On the feeling that every pass finds more bugs.** Measured rather than felt:
v0 was 868 lines of `src` with 21 recorded defects (~24 per 1,000 lines). This
pass added ~2,700 lines against a 7,006-line `src` and found ~10 (~3.7 per
1,000). Density fell roughly sixfold. The absolute count holds steady because
the codebase grew eightfold, and because this pass looked harder than any
before it — it ran the actual binary against real scratch git repositories,
which no prior pass had done. Different reviewers and different methods make
that suggestive, not rigorous; the honest summary is that the count is flat and
the rate is falling.

**`ratchet report` has been saying this the whole time.** It reads
`all-time: 0 caught, 5 new (0%)`. That number is not a bug in the reporting —
it is the tool correctly stating that its corpus is not yet earning its keep on
this repository, because that corpus is five rows drawn from one review of one
module, enforcing over seven thousand lines. The response is to act on the
reading, not to explain it away. Item 1 below is that response.

## Next pieces, in priority order

### 1. Cover the class where the defects actually are

The diagnosis above says the six self-host subjects are all one shape. Two
subjects would close most of the gap, and both are cheap now — which they were
not before prose heuristics, and that is a large part of why they do not exist.

**1a. An end-to-end CLI subject.** Drive the real binary against a scratch git
repository: `init` → write a heuristic → `fmt` → `adopt` → `verify` green →
break the code → `verify` red with the right witness → widen the rule →
quarantine with the prose diff. That is the loop the README documents, and
running it by hand is what found five of this pass's ten escapes. It should be
one subject with a handful of prose rules over a driver's output, not a manual
ritual performed once per release by whoever remembers.

Acceptance: the subject fails at a commit where any one of the eleven defects
above is reintroduced, and each of those eleven is captured as a corpus row.

**1b. Uniformity checks — the static half.** Assertions over the *source*, not
over a run, each one a standing invariant with no counterexample input:

- every command in `index.ts` resolves its home through the one resolver
  (`verify` does not today — see the finding above);
- every spawn path substitutes both `{home}` and `{ratchet}`;
- every command exits with a message rather than a stack trace against a
  corrupt corpus, an absent config, and an unparseable rules file.

These are grep-shaped, which means they are expressible as prose heuristics
today (`the count of lines matching ... is 0`) with no new vocabulary. This is
"static checks" from the debt list, finally given a reason more concrete than
completeness: it is the only mechanism that catches partial application, and
partial application is this codebase's most reliable defect.

Acceptance: reverting the `{home}` shell-mode substitution turns the uniformity
subject red, and it is validated against the commit where that hole existed.

**Why this outranks reach.** Items 2 and 3 make the tool say more about other
people's code. Item 1 makes it true of its own. A tool whose own gate stayed
green through ten of its own defects has not earned the reach yet, and
`report`'s 0% is the number that says so.

### 2. The measure vocabulary is thinner than the domains it is aimed at

Five extractors and seventeen predicates cover the field experiments'
subjects, but three real shapes have no expression yet, and each one currently
forces a script:

- **Comparison against a baseline that moves.** `is within 5 percent of 0.5`
  works against a constant. The design's *metric budget* is relative to the
  previous run or to a named ref, and nothing expresses it. This is the single
  most-requested shape in any performance or quality gate.
- **Repeated structure.** "every card has an image" is currently "the count of
  cards without images is 0", which works only because someone wrote a command
  that counts. A `for each` over rows of the output would remove that step.
- **Two-sided readings.** `is the same as <measure>` compares within one run.
  Comparing *across* two runs (before/after a transformation) is the
  round-trip shape, and it is common.

Acceptance: each of the four field-experiment subject sets expressible with no
project-local script beyond the instrument itself.

### 3. `na` is doing two jobs

`applies when <path> exists` covers "this feature did not exist yet". It does
not cover "the instrument cannot run here" (a toolchain that no longer builds
this commit), which currently reports as a hard failure and manufactures a
regression out of dependency rot. `replay --setup` distinguishes these as
`na-env`; the probe does not.

Acceptance: a heuristic can declare the difference, and `replay` reports the
two separately.

### 4. The catch-rate still undercounts

Unchanged from v2, and now the most visible remaining honesty gap: the rate
counts **retired-row recurrences** as caught. A known bug re-failing while its
row is still *active* is not journaled, so the common case is missing from the
numerator. `ratchet report` therefore understates the tool's own value, which
is a strange place to leave it.

The fix is a decision, not a mechanism: journal active-row failures as catches
and accept the journal noise, or add a second counter. Decide, then do it.

### 5. Mode 2, mine

Still absent: `ratchet history` walking test-file history to resurrect deleted
and weakened assertions as corpus rows. This is the one remaining mode from
[RATCHET.md](RATCHET.md) with a clear shape and no implementation, and it is
the highest-leverage source of rows for a repository adopting the tool with no
recent bug history to `adopt` against.

### 6. The agent attach

The field experiments named the intended composition: the agent is the
*sensor*, the ratchet is the *memory and alarm*. An agent's broad read of a
codebase generates candidate heuristics; the human accepts the ones that
matter; the ratchet institutionalizes them. Two halves are missing:

- **Proposal.** A documented shape for an agent emitting candidate
  `heuristic` blocks, which then go through `adopt` — the same gate as a
  human's. Prose is a far better proposal format than a script, and the
  capture gate is what makes bulk generation safe.
- **Dispatch.** On a red row, hand the agent the witness, the input, the
  bisected commit, and the journal entry. Everything needed is already
  captured; nothing assembles it.

Neither requires the ratchet to call a model.

### 7. Design debt, still open

Numeric witnesses on *scripted* rows (prose rows now carry them), mode 3
semantic history, sampled behavioral diffs beyond visual pins, and per-commit
artifact caching for replay. *Static checks have left this list* — they are
item 1b, promoted because they are the only mechanism that catches partial
application.

## Limitations to keep disclosed

- **The self-host corpus covers one class of defect.** Its five rows are all
  corpus and data-structure semantics; the process boundary, the CLI surface
  and the error paths have no rows at all. `ratchet guard` passing on this
  repository means the five known data-structure bugs have not returned — it
  does not mean the tool works. See the finding above and item 1.
- The catch rate undercounts (item 4).
- `seed` seeds `Math.random` in Node processes only. A `crypto`- or
  clock-driven instrument, or a non-Node one, is not made deterministic —
  `RATCHET_SEED` is exported and the rest is the project's business.
- A pre-commit hook is advisory: `--no-verify` exists, and a fresh clone has no
  hooks. CI is the authoritative gate; the hook is the fast one.
- `ratchet heuristics log` needs real git history. A shallow clone has none,
  and the quarantine explanation silently degrades to the hashes.

## Open product questions

- **Should `guard --strict` be the default?** An unvalidated subject is a
  warning today and a refusal at capture. Making it fatal at the gate is the
  stricter reading of "who checks the checkers", and it would break every
  project on adoption day.
- **Per-branch corpora** — open since v1. Does a branch gate share the main
  corpus or carry its own?
- **Does a validation proof expire** when the rule hash changes, or merely
  quarantine? (Current behavior: the proof is tied to the hash, so an edit
  closes the capture gate again. That is the strict reading; it may be too
  strict for a typo fix.)
- **Where do generated heuristics land?** A separate file, a marked block, or
  indistinguishable from human ones once they pass the gate? The review-ratio
  argument says the provenance should stay visible.

## Conclusion

The ratchet has its number, its memory, and now its unit of work. A heuristic
is five lines of prose, it cannot enter the corpus without proving it can fail,
and it enforces on every commit without anyone remembering to ask.

What is left is not mostly reach. The pass that produced this document fixed
eleven defects in the tool while the tool's own gate stayed green through ten
of them, and the reason is not that regression memory failed — it is that the
corpus was built where it was easy rather than where the bugs live. That makes
item 1 the first piece of work: cover the process boundary and the CLI surface,
and add the static checks that catch a mechanism wired into some of its call
sites but not all of them.

Then the reach: a vocabulary that covers more domains without falling back to
scripts (2, 3), one honesty fix in the reporting (4), the unmined half of the
design (5), and the agent loop the experiments described but nobody built (6).
All of it is deterministic, testable, and model-free — the same property every
working piece of this tool has had.
