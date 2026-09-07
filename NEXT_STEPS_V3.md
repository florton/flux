# Ratchet — Next Steps v3

> Supersedes [NEXT_STEPS_V2.md](NEXT_STEPS_V2.md) as the plan. That file
> remains the v0.6-era record. This file is the v0.7 plan. What exists is in
> [ratchet/README.md](ratchet/README.md).

## What v0.7 closed

All five priorities from v2 are built, tested, and running under the ratchet
itself. 153 tests, up from 70.

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

## Next pieces, in priority order

### 1. The measure vocabulary is thinner than the domains it is aimed at

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

### 2. `na` is doing two jobs

`applies when <path> exists` covers "this feature did not exist yet". It does
not cover "the instrument cannot run here" (a toolchain that no longer builds
this commit), which currently reports as a hard failure and manufactures a
regression out of dependency rot. `replay --setup` distinguishes these as
`na-env`; the probe does not.

Acceptance: a heuristic can declare the difference, and `replay` reports the
two separately.

### 3. The catch-rate still undercounts

Unchanged from v2, and now the most visible remaining honesty gap: the rate
counts **retired-row recurrences** as caught. A known bug re-failing while its
row is still *active* is not journaled, so the common case is missing from the
numerator. `ratchet report` therefore understates the tool's own value, which
is a strange place to leave it.

The fix is a decision, not a mechanism: journal active-row failures as catches
and accept the journal noise, or add a second counter. Decide, then do it.

### 4. Mode 2, mine

Still absent: `ratchet history` walking test-file history to resurrect deleted
and weakened assertions as corpus rows. This is the one remaining mode from
[RATCHET.md](RATCHET.md) with a clear shape and no implementation, and it is
the highest-leverage source of rows for a repository adopting the tool with no
recent bug history to `adopt` against.

### 5. The agent attach

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

### 6. Design debt, still open

Numeric witnesses on *scripted* rows (prose rows now carry them), mode 3
semantic history, sampled behavioral diffs beyond visual pins, static checks,
and per-commit artifact caching for replay.

## Limitations to keep disclosed

- The catch rate undercounts (item 3).
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

What is left is mostly reach: a vocabulary that covers more domains without
falling back to scripts (1, 2), one honesty fix in the reporting (3), the
unmined half of the design (4), and the agent loop the experiments described
but nobody built (5). All of it is deterministic, testable, and model-free —
the same property every working piece of this tool has had.
