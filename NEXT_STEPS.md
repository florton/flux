# Ratchet — Next Steps

> **Superseded as the plan by [NEXT_STEPS_V2.md](NEXT_STEPS_V2.md).** This
> file remains the v0-era record: requirements each backed by an observed
> failure.

Consolidates the four field experiments (margin, odds, newportfolio, particles),
the six questions they answer, and what the prototype must become next. The
experiment detail lives in `EXPERIMENTS_RATCHET.md`; this file is the plan.
Defects and findings from the v0 code review are in
[ISSUES_RATCHET.md](ISSUES_RATCHET.md), including gaps in this document.

**Built as of v0.4** (see [ratchet/README.md](ratchet/README.md)): the replay
sampler with halving, the `na`/`na(env)` distinction and environment recording,
owning-rule hashes with quarantine, the subject-validation protocol as
`ratchet validate`, history commands in worktrees, and self-hosting. What
remains from the list below is the bundled probe kind, corpus rows carrying a
numeric witness, per-commit artifact caching, and the journal's requirement
schema.

---

## Where the field stands

| repo | role | wired subjects | result |
|---|---|---|---|
| margin | QA-side heuristic drift | read-invariants, data-integrity, deck-integrity, engine-verdict | **caught the silently dropped A/B verdict** — a comparison deck whose marks can no longer settle a winner |
| odds | retroactive replay | basic-edge, solver-grade, monty-hall, texas-selfcheck | **replay caught the real push bug** (−0.0765) at every pre-fix commit, passes after the fix |
| newportfolio | branch gate | data-integrity, unit-tests, build | duplicate project title on both rejected branches; **main lacks the test suite the branches added**; visual/taste rejection reasons uncatchable by design |
| particles | physics + replay | physics-sanity, galaxy-structure, mode-table, build | dense replay clean (negative result); **sampled replay + bisect pinpointed `9f53b4d` as the commit where the galaxy gained its arms** — A(m=2) 2.8e-3 at the noise floor before, 4.1× above after |

The four together cover the ratchet's four roles: guard-the-guard, memory,
gate, and proof-of-absence.

## The questions, answered

See `EXPERIMENTS_RATCHET.md` for the full answers:

1. A/B / QA: alongside, in the guard-the-guard role — never over.
2. Testing frameworks: alongside — memory + replay + pinpointing are the three
   things suites don't do.
3. AI vs non-AI: mechanics are AI-agnostic; AI raises the rate of drift, so the
   memory/ceremony layer pays off faster there.
4. Testing the tests: differential truth, history-as-test-set, minimal custom
   code, checks-of-checks, loud failure.
5. vs. a naked AI agent: persistence, evidence over opinion, exhaustive vs.
   attentional coverage, pinpointing. Agent = sensor; ratchet = memory + alarm.

## Design requirements, each backed by an observed failure or measurement

### Replay at scale — sampling, then halving (NEW, from user review)
Real repos have 20+ minute builds and thousands of commits; particles measured
~35s/commit and odds pre-fix commits ran their own 10M-hand defaults. Full
dense replay does not scale. Required shape:

- `ratchet replay` takes a sampling policy: even stride (`--every N`), a
  timescale (`--every day|week`), or a user range — dense replay stays as the
  small-repo default.
- Any sampled failure triggers the existing halving bisect to pinpoint the
  introducing commit. Coarse-to-fine: sampler finds the window, bisect closes
  it.
- Cache compiled artifacts per commit (particles' tsc compile dominated the
  cost); run independent subjects in parallel.

### Bundled probe kind + seeded execution
Command + capture-regex + band as config, with a bundled seeded-RNG preload.
Covers the 80% case (all of odds' subjects are this shape); eliminates the
class of check bugs that lived in hand-written plumbing.

### Third check outcome: `na`
"Not applicable at this commit" is not "pass". Proven necessary three times:
pre-fix odds ignored CLI args; newportfolio main has no test suite; particles'
bitecs-era first commit can't compile without its old deps.

### Environment drift is not in git history (NEW, from user review)
Old commits can fail on today's machine for reasons that were never committed:
node/toolchain upgrades, dependency registries, OS changes. Particles' bitecs-era
first commit is the canonical case — the code was fine, the environment can no
longer satisfy it. Replay must not report that as a bug:

- Record the environment each replay ran under (node, OS, toolchain) alongside
  the results, so failures are attributable.
- Triage the failure class before reporting: build/install crashes are
  environment candidates; invariant failures ("edge −0.0765 outside band")
  are code candidates. The loud-failure contract already separates these.
- Extend the third outcome: `na(code)` — the check does not apply at this
  commit — vs `na(env)` — the check cannot run in this environment.
- When the repo has CI images, prefer running replay inside the pinned image
  for its era; where it doesn't, document the observability limit: replay
  verifies "does this commit pass today's checks under today's environment,"
  not a faithful historical re-enactment.

### Corpus rows carry the witness
The measured value (−0.0765, A(m=2) = 4.9e-2), not just the reason. Accept and
report conversations cite numbers.

### History commands run in worktrees
Never the user's checkout. The margin detached-HEAD scare was the proof; the
worktree pattern in every subsequent repo is the fix.

### Subject-validation protocol
Every subject must be proven to fail on at least one known past bug (or known
bad state) before it can be captured from. A subject that passes through
history's known bugs is too weak — this is the answer to "who checks the
checkers" applied mechanically.

### Journal carries requirements and rejections
The newportfolio scope failure (agent misunderstood the prompt) is not an
invariant. But the requirement and the rejection reason belong in the journal,
so the next attempt starts from recorded intent. Same ceremony as the margin
A/B verdict.

## Next experiments, in priority order

1. **Spiral-arm quality subject on particles — DONE.** Sampled replay (every
   4th commit, 9 runs vs 25 dense) found the fixed-potential era failing
   (A(m=2) at the noise floor), halving pinpointed `9f53b4d` "widescreen
   refactor" as the commit where arms appeared. The subject now guards the
   structure against any future regression. Remaining: capture it as a corpus
   row and run it through the accept ceremony on feature/smoke.
2. **~/suss (next-signal-bridge)** — the alongside-a-structured-suite repo:
   78 tests, strict tsc. Replay their own suite across history, then add
   invariant subjects (contract shape, dedup semantics) on top. Tests what
   ratchet adds when the project already has discipline.
3. **A Godot game repo (MagicDuel `feature/doom`, or CrapCity — history
   contains "fixed some of the bets")** — game-balance and data invariants via
   static analysis of GDScript/scene files; the branch gate on `feature/doom`.
   Tests whether the pattern survives without a runnable test harness.
4. **Self-hosting — DONE.** Five subjects over this repository, each a check
   of the checker, all validated against `4abc1d5` where the bugs lived.
   Replayed over its own history: 0/5 passing at v0, 4/5 at v0.2, 5/5 at v0.3.
   Two subjects failed their own validation first and had to be rewritten to
   exercise the real capture path — the protocol earning its keep.

## Open product questions

- Sampling policy details: even stride vs. git-date timescale vs. random
  sample; how a sampled failure reports (window + bisect in one command).
- Per-branch corpora: does a branch gate share the main corpus or carry its
  own? The newportfolio work showed branches need their own verdicts.
- Journal schema for requirements: what a "requirement note" looks like so
  rejections and A/B methodology changes record consistently.
- How `na` renders in `ratchet verify` output (the gate must be able to say
  "untested" without failing the build) — and how `na(env)` vs `na(code)` are
  distinguished in report and replay tables.

## Conclusion for now

The experiment concludes here. Four repos validated the four roles (guard-the-
guard, memory, gate, proof-of-absence), the sampled-replay + halving pipeline
works (particles: 9 runs, one pinpointed commit), and the subject economics are
understood: AI-inferred subjects guard the floor cheaply, human-authored ones
guard the point, and the project's own docs are the best source for the latter.

The next concrete steps, in order: make `ratchet verify` first-class for the
staged-commit/agent-loop workflow (it is the same contract already proven
retroactively), implement the replay sampler with halving built in, and add the
`na(env)`/`na(code)` distinction to report output. Then self-hosting on the
ratchet's own repo.
