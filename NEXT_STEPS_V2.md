# Ratchet — Next Steps v2

> Supersedes [NEXT_STEPS.md](NEXT_STEPS.md) as the plan. That file remains
> the v0-era record: requirements each backed by an observed failure. This
> file is the v0.6 plan. What exists is in [ratchet/README.md](ratchet/README.md);
> the workflow section there is the adopted loop.

**Where v0.6 landed.** The churn number the original design promised —
failure signals split into *caught by corpus* vs. *new counterexamples* — is
built (`ratchet report`), alongside the TAP capture source, the hardened
JUnit parser, parallel replay (`--jobs`), and a populated self-host corpus
(the five v0 defects captured at the commit where they lived, enforcing on
every commit of this repository).

## The thesis, sharpened

The margin experience settled the unit of work: **subjective asks fail, and
decomposable characteristics succeed.** "Quality" cannot be checked; "variety,
coherence, imagery" can. That makes the ratchet's unit the *human-authored
characteristic* — named, decomposable, measurable.

Machine- or agent-generated heuristics are welcome, but only for *coverage*,
and only through the same gate as human ones. A heuristic that has not been
proven against a known failure is noise with a green light, and generated
heuristics arrive in bulk.

The ratchet's role in that model is four verbs, all built or buildable
without any model calls:

1. **Prove** — a characteristic must fail on a known bad state before it is
   trusted (`ratchet validate`).
2. **Arm** — once trusted, it enforces forever; its rows, their witnesses,
   and every retirement stay on the record.
3. **Tend** — edits to the characteristic itself quarantine its rows instead
   of pretending nothing moved; the ceremony records the intent.
4. **Report** — the caught/new split says whether failures are known
   regressions or genuinely novel bugs.

What the ratchet never does is invent the characteristic. That is the
human's (or the human-supervised agent's) job — and the tool makes that job
persistent, which is the exact property a merging, agent-driven landscape
destroys fastest.

## Next pieces, in priority order

### 1. Heuristics as data, not programs — the bundled probe kind

The field experiments demanded this first ("bundle the probe check kind +
seeded-RNG preload into ratchet — config-only checks for the 80% case") and
it is still unbuilt. Every subject today is a host-language script, and the
experiments found the check bugs *lived in that hand-written plumbing*.

Shape: a subject config of `command` + a parsed output field + a band (or a
count), with a bundled seeded-RNG preload. `"imagery: every card has an
image"` should be a config line, not forty lines of glue. This is the
difference between the human writing characteristics and writing instruments,
and it is the adoption wedge for the non-programmer domain expert the whole
design was written for.

Acceptance: all four field-experiment subject sets re-expressible as config;
a regression test that a band subject catches a seeded counterexample and
reports the measured number as its witness.

### 2. Validation as a capture gate, not a ritual

`ratchet validate` exists, but nothing stops capture from trusting a subject
that was never validated. Make it mechanical:

- `ratchet capture` refuses bindings whose subject has no validation proof
  in the journal, naming the command to run.
- `--allow-unvalidated` as the explicit escape hatch for a subject's very
  first use, journaled as such.

This is the safety mechanism for bulk *generated* coverage heuristics — the
cheapest place to catch a vacuous check that passes through every bug — and
it is what turns "who checks the checkers" from a convention into a gate.

Acceptance: a capture against an unvalidated subject is refused with the
`ratchet validate` invocation printed; `--allow-unvalidated` journals the
exception; the self-check suite gains a subject for the gate.

### 3. `ratchet adopt <subject> --good <ref>` — heuristic onboarding

Adopting a new characteristic on an existing repo currently means the manual
worktree dance: check out a bad commit, build it, capture, reaffirm. It
should be one command: run the subject across history from a known-good ref,
and promote every failing commit into a corpus row with provenance, then
re-pin to today's instrument.

This is the natural lifecycle of a human-authored characteristic: born
validated, immediately enforcing, with its fix history already drawn. The
self-host corpus was populated this way by hand; the command removes the
manual part.

Acceptance: `adopt` over the ratchet's own history reproduces the five
self-host rows without the shell dance.

### 4. Yield reporting — silence detection

The caught/new split says what *did* fail; nothing says which characteristic
has stopped producing evidence. Add per-subject staleness to `ratchet
report` ("`imagery`: 1 row, last capture 8 months ago") and surface the
n/a-share of recent verifies — a gate that is mostly `na` is green while
checking little.

Humans own the portfolio of characteristics; they need to know which ones
stopped earning their keep.

Acceptance: `report` flags subjects with no new captures or failures in N
days; `verify` summaries name the n/a share when it is high.

### 5. Distribution for the merging landscape

The merge *mechanics* are proven (content-addressed ids, union merge,
timestamp fold — all self-tested). What is missing is the signal arriving
where merges are reviewed:

- CI glue: `ratchet verify --json` on agent PRs, posting the caught/new
  split as a PR comment. `--json` exists; nothing consumes it.
- Merge verification: run the corpus against `base..merge` (already
  composable — `ratchet replay --good base --bad merge`); both branches can
  be green while their union is not.

Acceptance: a committed CI snippet and a documented PR-comment shape;
one paragraph in the README showing both.

### 6. Then the older design debt, unchanged from v1

Numeric witnesses on rows (the −0.0765, not just the reason), baseline-relative
metric budgets, mode 2 mining of deleted tests, static checks, and per-commit
artifact caching for replay.

## Limitations to disclose in the docs

Not defects, but semantics a reader should not have to discover:

- The catch-rate counts **retired-row recurrences** as "caught". A known bug
  re-failing while its row is still active is not journaled, so the rate
  undercounts catches in that common case. Decide later whether active-row
  repeats journal (completeness vs. journal noise).
- A gate that is mostly `na` reads green in the summary. See item 4.

## Open product questions

- Should a validation proof *expire* when the subject's rule hash changes,
  or merely quarantine (current behavior)?
- Per-branch corpora — still open from v1: does a branch gate share the main
  corpus or carry its own?
- PR-comment format: what a caught/new comment should look like so reviewers
  read it and the ceremony entries link to it.

## Conclusion

The ratchet is no longer missing its number. The next phase is making the
characteristic the cheap unit of work — data, not programs (1) — making
validation a gate rather than a ritual (2), onboarding new characteristics
in one command (3), keeping the portfolio honest (4), and shipping the
signal to where merges are reviewed (5). All five are deterministic,
testable, and model-free — the same property every working piece of the
ratchet has had.
