# Ratchet — Next Steps v5

> Supersedes [NEXT_STEPS_V4.md](NEXT_STEPS_V4.md) as the plan. That file stays
> as the v0.9-era record; its items 1–5 are built, item 6 is partly built, and
> items 7–9 are carried forward here. What exists is in
> [../../ratchet/README.md](../../ratchet/README.md); what is broken or open is in
> [OUTSTANDING_RATCHET.md](OUTSTANDING_RATCHET.md).

> **Status, 2026-09-07 — the secondary verifier is built and self-hosting.**
> `ratchet fuzz` exists, is wired into the gate and CI, and has already found
> three real defects (R34–R36). 9,707 lines of `src`, 217 tests, and the
> repository's own gate runs the fuzzer as a standing invariant — the strongest
> self-hosting claim the tool has: the fuzzer attacks the machinery that
> enforces the gate that is running the fuzzer.

## What this session built: `ratchet fuzz`

`guard` proves the *rows hold*. `fuzz` attacks the *machinery that produces
rows*. Three targets, each aimed at the measured defect class (sixteen of the
twenty-one v0 defects sat at the process boundary):

| Target | Mutates | Oracle invariants |
|---|---|---|
| `state` | synthetic corpus/journal/config/rules | `guard` never throws; `fsck` detects exactly the content-addressed id mismatches; unreadable lines named by line number; the gate is deterministic |
| `cli` | random argv against the real binary | exit 0 or 1 with a first-class message, never a stack trace; `--json` with exit 0 emits JSON |
| `rules` | grammar-generated + mutated rules text | parser never throws; problems carry line and column; `fmt` is a fixpoint and never changes canonical text |

Design properties worth keeping: mulberry32 seeded determinism (findings
reproduce from seed + iteration), collect-all reporting with one exit code,
cause-preserving minimization reusing the capture pipeline's ddmin, and
honest non-coverage stated in the README (PNG decoder, worktree machinery,
instrument execution).

**It paid for itself on its first two runs**, minimized findings and all:

| # | What it found | Severity |
|---|---|---|
| R34 | `pr-comment --json` printed markdown with exit 0 | medium |
| R35 | `note --json` printed plain text with exit 0 | low |
| R36 | `fmt` grew a blank line into an empty rules file on every run | low |

Closed in the usual way: fix plus regression test, entries in
[OUTSTANDING_RATCHET.md](OUTSTANDING_RATCHET.md). The instrument that probes
every command the binary lists now probes `fuzz` at a one-iteration budget, so
the new command's error path is covered without measuring its runtime.

## Next pieces, in priority order

### 1. Close R31 — the gate affirms a subject that nothing runs

The one remaining false green: a *scripted* subject with zero active rows is
never run by anything, and `guard`'s validation line names it as proven
anyway. `ratchet yield` shows it; nothing at the gate consults it.

**Shape of the fix.** A `guard` step that reports subjects which no mechanism
will run — scripted, zero active rows, not a standing invariant. A warning,
not a failure: a subject can be legitimately between rows. It belongs in the
same list as the frozen-instrument warning, worded as what is true: *nothing
runs this*. The harder half is the design question R29 side-stepped: whether a
scripted subject should be able to declare a rejection at all, or whether
"a standing property, checked by a script" should always be spelled as a prose
heuristic with a `run` line, as this repository now does everywhere.

### 2. The semgrep pass (the selling-point half of the checklist)

Run `semgrep` (`p/security-audit` + `p/javascript`) over `ratchet/src`, triage
real findings into the R-series with execution repros, commit a suppression
config for false positives. Zero runtime dependencies makes this a short pass,
and the README gets the sentence that sells: zero-dependency, statically
clean, gate-fuzzed. Also `npm audit` (trivially clean with no deps) and a
tsconfig-strictness check.

### 3. The blind DX test (the usability half)

Cold-start the README's core loop — install, `init`, write a heuristic, `fmt`,
`adopt`, `guard` — against a throwaway repo, from the README alone, logged and
timed against the 10-minute rule. Findings become the fifth field experiment
in [EXPERIMENTS_RATCHET.md](EXPERIMENTS_RATCHET.md), and the likely outcome is
a quickstart/reference split of the README: it is currently 1,100+ lines of
detail around a seven-step loop.

### 4. Fuzz v2 — the deferred half of the design

Named follow-ups from the v1 design, in the order they'd bite:

- **Parallelism.** v1 is deliberately sequential for stream determinism.
  `replay` already proves the report can come back in commit order from
  parallel probes; the same shape applies to fuzz iterations.
- **The visual target.** Mutated PNGs against the zero-dependency decoder and
  the pixel diff — the only shipped code with no oracle anywhere near it.
- **Config-aware state.** v1 mutates a synthetic home; borrowing the *shapes*
  of the real repository's config (command strings, owns paths) would aim the
  fuzzer at each project's own boundaries.
- **Output-rejects in the rules generator.** The grammar currently generates
  only reading-form rejections; `rejects output "..."` is a whole pipeline
  the fuzzer should generate against too.

### 5. R32 — the witness clause

A rule-failure witness names the count, not the cause: `failing measured 1`
without which test. The smallest fix is a vocabulary addition —
`witness lines matching "not ok"` — which the heuristic already names in its
`measure` clauses and has no way to promote to the witness.

### 6. Carried forward from v4, unchanged

- **Item 6 residue** — the catch-rate numerator still misses a row that goes
  red under `verify` and is fixed without `capture`.
- **Item 7** — mode 2: `ratchet history` mining test-file history for deleted
  and weakened assertions.
- **Item 8** — the agent attach: a documented shape for generated heuristics,
  and dispatch on a red row.
- **Item 9** — per-commit artifact caching for replay (armed with numbers:
  3m44s for nine commits), and the worktree setup script every project still
  hand-rolls.
- **Vocabulary residue** — a baseline that moves, repeated structure
  (`for each`), two-sided readings across two runs.
- **The fifth coverage class** — packaging and hygiene (R16, R19, R21) still
  has no rows and no obvious instrument.

### 7. The version decision — for a human

`package.json` says `0.9.0`. The case for `0.10.0` now has three legs: the R22
fix changes rule hashes for rules files with a `#` in a quoted value
(quarantining armed rows on upgrade), a subject changed shape from script to
prose, and now a new command plus two CLI contract fixes (`--json`). A version
bump rides with the feature commit that announces these; none was asked for,
so none is invented here.

## Open product questions, carried forward

`guard --strict` as the default, per-branch corpora, whether a validation
proof expires or merely quarantines on a rule edit, and where generated
heuristics land — all unchanged from v4, still waiting on a human.

## Limitations to keep disclosed

- **A fuzzer is evidence, not a proof.** No oracle can detect a mutation that
  preserves every property it checks; `fuzz` is a budgeted adversary, not a
  guarantee.
- **The state target mutates a synthetic home**, never the repository's own —
  fuzzing your real corpus would mean rewriting your memory.
- The PNG decoder, the worktree machinery, and instrument execution are not
  fuzzed (items 2 and 4 of the plan above close two of those three).
- The catch rate still undercounts; `seed` still seeds Node processes only; a
  pre-commit hook stays advisory with CI authoritative.
