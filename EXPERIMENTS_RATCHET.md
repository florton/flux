# Ratchet Field Experiments — Margin, Odds, Newportfolio, Particles

Four real repos, four different roles for the ratchet v0 prototype: margin
(QA-side heuristic drift), odds (retroactive bug replay), newportfolio (branch
gate), particles (sampled replay and a domain quality metric). Each repo got a
project-local `tools/ratchet-check.js` plus a `.ratchet/config.json`; no user
source code was touched.

These ran against **v0**. The defects that review later found in that version
are in [ISSUES_RATCHET.md](ISSUES_RATCHET.md); the readings below stand, but
the prototype they were taken with has since been rebuilt through v0.4.

Check contract everywhere: read one JSON object on stdin, exit 0 = pass,
nonzero = fail, stdout = the reason.

---

## Experiment 1: margin — the measuring instrument changed

Subjects: `read-invariants` (their core reader, fuzzed over 646 corpus inputs,
20k adversarial strings, and a 14-commit history replay — all clean),
`data-integrity`, `deck-integrity`, `engine-verdict`.

**The catch.** `engine-verdict` reads each deck's key, counts the distinct
engines the deck compares (from item `x.side`/`y.side`), and asserts the marks
sheet can settle a winner over that pool. `deck78-assertion` compares two
engines (`main@9d23d29` vs `working tree`) but its marks are line-by-line
only — zero whole-answer ratings, zero choices. The deck's one job (which
engine wins) is unmeasurable. The A/B verdict was dropped silently; the human
never asked for it. The first run of the check found drift that had happened
weeks earlier.

**What it says.**

- The highest-value ratchet catch is not a bug, it is *the heuristic itself
  changing with no decision recorded*. QA analysis moves with the heuristic;
  when the heuristic changes unrecorded, "are we improving?" stops being
  answerable.
- The journal/accept ceremony is the missing decision log: "line-by-line is
  the intended heuristic" becomes a dated entry instead of ambient drift.
- Invariants must encode *minimal common promises*, not the format's
  accidental shape — three divergent deck formats forced that separation.

**Caveat.** The ratchet catches the symptom (verdict unmeasurable)
deterministically; it cannot infer intent (expand the pool to N commits).
Intent is recorded by the ceremony, not guessed.

---

## Experiment 2: odds — retroactive replay over a real bug history

The commit `94405eb` "Fix three simulator bugs" documents ground truth: push
scored as loss (edge −0.0763), any 21 paid 3:2 (+0.0211), solved tables threw
a TypeError (−0.0103). Clean edge for these rules ≈ −0.005.

Subjects: `basic-edge` (seeded run, band [−0.03, 0.015] against the published
basic strategy table), `solver-grade`, `monty-hall` (2/3 band), `texas-selfcheck`
(their own suite's exit code).

**What happened, in plain terms.** While the bugs lived, the simulator
reported a player edge of −0.0763 per hand — about fifteen times the real
house edge for those rules (≈ −0.005, a figure published by every blackjack
reference table). We wrote one check that runs the simulator with a fixed
random seed and asserts the measured edge lands in a band around the published
value. The check was written *after* the fix, with no knowledge of the buggy
code — only of blackjack's published odds. Then we ran that single check at
each commit of the repo's history:

| commit | measured edge | check |
|---|---|---|
| d329872, 2f0e313 (before the fix) | −0.0765 | **FAIL** |
| 94405eb (the fix) and every later commit | in band | pass |

It catches every pre-fix commit and passes every post-fix one. That is the
retroactive promise: today's checks, replayed, recover yesterday's bugs —
including the years the bugs sat unnoticed.

**What it says.**

- *Calibrate against an outside truth, not the code.* The band came from the
  published strategy table, which exists independently of the simulator and of
  the ratchet. A check that merely re-encoded the fix would have proved
  nothing.
- *Seeded runs make the reading reproducible.* The same seed gives the same
  −0.0765 every time; anyone can re-derive the table with one command.
- *Start by adopting the project's own checks.* `texas-selfcheck` is just
  their test suite's exit code — no new assertions needed, and it rides along
  the replay for free.
- *Old code is not current code.* Pre-fix blackjack.js ignored CLI arguments
  (running 10M hands instead of 300k), and pre-fix `solver-grade` failures
  were the push bug again, not the TypeError. Replay has to know when a check
  does not apply at a given commit rather than scoring it as failed.

**Instrument integrity across history.** The per-commit readings are only as
good as the instrument making them, and the instrument is itself software —
this is the objection that the yardstick may be wrong or drift. Three guards
hold it in place:

1. *Frozen instrument.* The check script is pinned across every commit — an
   artifact of the corpus, not of the project — so readings are comparable by
   construction, and project drift cannot silently change the yardstick.
2. *External anchor.* The band is set from the published table, which is
   outside both the project and the ratchet. If the simulator or the check
   drifts, the anchor is what catches it.
3. *Loud failure on unparseable output.* If the simulator ever changes its
   output format, the check reports "no edge reported" and fails — a misread
   cannot masquerade as a pass.

What remains is the residual risk that the instrument itself is wrong (a bad
band, a wrong anchor): every reading would share the same error. That is the
bootstrapping problem from question 4 applied to history — mitigated by the
subject-validation protocol (a subject that passes through a known bug is too
weak) and the checks-of-checks layer.

---

## Experiment 3: newportfolio — the branch gate

Two rejected branches, `feature/v2` (11 tests) and `feature/offrails`
(56 tests, the "ai psychosis" redesign). Subjects: `data-integrity`
(portfolio.ts shape checks), `unit-tests`, `build`.

| gate | main | feature/v2 | feature/offrails |
|---|---|---|---|
| data-integrity | OK — 19 projects, 7 categories | FAIL: duplicate "Handcrafted Industries" | FAIL: same duplicate |
| unit-tests | N/A — no suite | OK — 11 tests | OK — 56 tests |
| build | OK — 119 kB shared | OK — 119 kB shared | OK — 119 kB shared |

**Corrections after review.** The duplicate title also existed on main until
recently — transient, not the interesting result. The real finding: **main
has no test suite, while both rejected branches added one** (plus CI, sitemap,
robots, OG). The rejected branches are engineering-sound; the ratchet caught
none of the visual changes, which are the actual rejection reason.

**The rejection the ratchet cannot see.** At least one of those branches was
rejected because the agent got carried away and misunderstood the prompt — a
scope failure, not a quality failure. The ratchet is the wrong instrument for
prompt fidelity: "did the work match what was asked" is not an invariant
unless the requirement itself is encodable, and "keep the visual design
unchanged" is not. What the ratchet *can* do is carry the requirement: the
prompt and the rejection reason go in the journal, so the next attempt starts
from the recorded intent rather than the agent's re-reading of it — the same
ceremony that records the margin A/B decision records scope decisions.

**What it says.**

- The branch gate guards the *objective floor* (build, tests, data shape). It
  found the one mechanical defect on the branches and, more usefully, exposed
  that main is behind its own floor — the test-suite loss is the durable
  finding.
- Taste is not encodable as an invariant. The rejection decision belongs in
  the journal with its reason, exactly like the margin A/B verdict.
- Third-outcome gap confirmed: "N/A: no test suite" renders as *pass*, so the
  gate cannot tell "tested and green" from "untested".

---

## Experiment 4: particles — the sampled replay and the spiral-arm metric

A WebGPU galaxy simulator (1M particles, seven force-law modes) whose README
carries its own quality instrument: A(m=2), the normalized Fourier amplitude of
surface density at the m=2 angular harmonic over the annulus 0.15 < r < 0.8 —
"nonzero means arms; a purely axisymmetric disc sits at the shot-noise floor,"
with published values for the fixed-potential era (never left the floor) and
the self-gravitating era (4.9e-2 at t=6s).

Subjects: `physics-sanity` (headless CPU sim — count conservation, finiteness,
wall-box bounds, speed cap, bit-for-bit determinism), `galaxy-structure`
(A(m=2) above the measured shot-noise floor after 6s of simulated time),
`mode-table`, `build`.

**Dense replay: the negative result.** All 25 commits passed physics-sanity;
the wall-box contract read correctly across four generations (0.37 → 0.515 →
1.0 → 2.0). The ratchet reported no bugs where none lived.

**Sampled replay: the positive result.** The galaxy-structure subject at every
4th commit (7 samples instead of 25):

| sample | commit | A(m=2) at 6s | verdict |
|---|---|---|---|
| 4–12 | fixed-potential era | 2.8e-3 | **FAIL — at the noise floor, no arms** |
| 16–24 | self-gravitating era | 1.05e-2 (4.1× floor) | pass |

Halving the 3-commit window between the last failing and first passing sample
pinpointed the boundary: `9f53b4d` "widescreen refactor" is the commit where
the galaxy gained its arms. Total cost: 9 runs vs. 25 dense — 36% of the work,
the same exact answer.

**What it says.**

- "The spiral arms aren't as evident as they used to be" is encodable — when
  the project already measures it. The subject is their own README metric,
  computed from the sim state and banded against a *measured* floor (A(m=2) at
  t=0), not a hard-coded number — so it adapts across history's changing
  physics.
- The sampling→halving pipeline works as designed: even-stride sampling finds
  the transition window, bisect closes it to one commit. This is the pattern
  for the 20-minute-build, thousand-commit repos.
- The subject's true role is forward-looking: any future commit that weakens
  the arms fails it at that commit, and bisect names the commit — the
  "regression between versions" question answered with the project's own
  instrument.

---

## The five questions

### 1. Helpful for A/B / QA testing over/alongside a project's custom A/B / QA?

Alongside, in the *guard-the-guard* role — never over. Margin has a real
A/B+QA pipeline (decks, marks sheets, sign tests) and the ratchet's best
subject there (`engine-verdict`) checks that the QA machinery itself keeps
measuring what it claims. The judgments stay human; the ratchet asserts the
instrument exists and is settleable. Custom QA is project code, so it is
subject to the same silent drift the ratchet exists to catch — the margin
finding is the proof. The journal turns A/B methodology changes into
recorded decisions.

### 2. Helpful over/alongside a structured testing framework?

Alongside, with three things a framework does not do: *memory* (a corpus of
past failures that stays enforcing after the bug is fixed), *replay* (run
today's checks against history), and *pinpointing* (bisect to the commit
that introduced a failure). Odds is the demonstration: the suite the project
already had never would have replayed itself across nine commits. The
framework asserts; the ratchet remembers and pinpoints. Suites also cannot do
calibration-against-external-truth without building that machinery — the
ratchet's band subjects are one-liners over it.

### 3. Non-AI pipelines, or best in AI-driven ones?

The core mechanics — invariants + replay + bisect + corpus — are AI-agnostic:
the odds bugs were written by humans over years and replay still caught them,
so a classic CI pipeline gains real regression memory. What AI changes is the
*rate of drift*. AI agents change heuristics and pipelines faster and more
silently (the margin story: the A/B test vanished without anyone asking), so
the memory + accept-ceremony layer earns its keep far sooner there. Best in
AI-driven pipelines; still useful as a regression-memory layer in any CI.

### 4. How do we test when a test framework is only as good as its tests?

The checks themselves are code, and during these experiments they had real
bugs: a matchAll destructuring off-by-one, a regex character class that
matched the "e" in "percent", a `yarn` vs `yarn.cmd` spawn failure, a null
stdout crash, a mailto scheme rejected as invalid, an ANSI-colored test-count
regex. Every one was found because a failing check *fails loudly* — nonzero
exit plus a reason on stdout — and the failure was inspectable. The layers
that make that tolerable:

1. **Differential truth.** Bind checks to domain ground truth (published
   tables, 2/3 theory, human marks), not to the implementation. A check that
   re-encodes the code it checks is the real hazard.
2. **History is the checkers' test set.** Every subject must be *validated*:
   run it across a commit range containing a known bug; if it passes through
   the bug, it is too weak. The odds bands were validated against −0.0765.
3. **Minimize custom code.** Every one of the check bugs above lived in
   hand-written plumbing. The probe kind (command + capture + band, all in
   config) shrinks the attack surface to near zero; custom subjects keep
   the same loud-failure contract.
4. **Checks of checks.** The ratchet can run under itself: config parses,
   checks terminate within timeout, the corpus stays enforce-able. Turtles
   all the way down — the goal is a small, inspected foundation that
   everything above inherits.

The honest limit: false-pass is the worst failure mode a check can have, and
conspicuous, inspectable failure is the mechanism that converts bad checks
into visible ones.

---

### 5. Advantageous for finding regressions vs. just asking an AI agent?

Yes, in four specific regimes — and the agent is a component of the framework,
not a competitor to it.

The empirical baseline: an agent *can* find these bugs by inspection. The odds
commit was co-authored by an agent that found all three. But the bugs sat for
years until someone asked, and the margin A/B loss is not findable by
point-in-time review at all — the code at every step looked plausible; the
defect is a *change over time*, visible only in history.

Where the framework wins over the naked agent:

1. **Persistence.** An agent's review decays the moment the conversation ends;
   the same bug can be re-introduced tomorrow and re-paid-for forever. The
   corpus keeps enforcing after the finding — a past finding costs nothing
   ever again. In AI-driven pipelines where agents commit daily, per-commit
   re-review at model prices does not scale.
2. **Evidence over opinion.** "edge is −0.0765, band is [−0.03, 0.015]" is a
   reproducible number; "looks like a push bug" is a claim a human must
   re-derive. The ratchet's output is a witness, not a suspicion.
3. **Exhaustive vs. attentional coverage.** An agent reviewing nine commits
   spots the salient bug; replay asserts every subject against every commit,
   mechanically. The three odds bugs "each hiding the next" cost the agent
   real effort; the aggregate edge signature betrays them in one run.
4. **Pinpointing.** The agent says a bug exists; the ratchet says *introduced
   at commit X*, which is what makes a revert or a blame actionable.

Where the naked agent wins: open-ended discovery outside the
invariant-expressible class, visual/taste regressions (the newportfolio
rejection reasons — unless visual snapshotting is added), and one-off hunts
where setup cost outweighs the payoff.

The intended composition is not either/or: the agent is the *sensor*, the
ratchet is the *memory and alarm*. The agent's broad read of a codebase
generates candidate invariants; the human accepts the ones that matter, and
the ratchet institutionalizes them. On failure, the ratchet dispatches the
agent to investigate — the loop that happened naturally in these experiments
(the agent fixed its own buggy checks) becomes the designed workflow.

## Design changes these experiments demand

- Bundle the probe check kind + seeded-RNG preload into ratchet (config-only
  checks for the 80% case).
- `ratchet replay <range>` as a first-class command (was hand-rolled in bash).
- A third check outcome: `na` (not applicable at this commit) distinct from
  pass — replay and branch gates need it.
- Corpus rows carry the measured witness (the −0.0765), not just the reason.
- History commands operate in a worktree, never the user's checkout.
- Subject-validation protocol: prove each subject fails on one known past bug.

## Caveats

- Three repos is a sample of three. All three had conveniently measurable
  ground truth (published tables, known bug signatures, data shapes); domains
  without external references get weaker subjects.
- **Low-documentation environments.** The ratchet assumes some discipline —
  commit messages as ground truth, requirements recorded in the journal — and
  not every amateur workflow has it (the odds history itself contains
  "tweaks" and "updates"). But the dependence is thinner than it looks:
  replay, bisect, and the corpus need *no* commit-message quality at all —
  they only need the check to fail somewhere and pass somewhere; the odds
  experiment worked with an unannotated history. The validation protocol has
  a fallback that needs no history either: external anchors (published
  tables) and mechanical fuzzing (margin's 646-input corpus was generated,
  not mined from documentation). What bad documentation actually costs is the
  *narrative* — why things changed — and the journal is the low-friction
  substitute: one line, forced at the moment of decision, instead of ongoing
  commit hygiene.
- The newportfolio branches were checked in isolated worktrees with their
  own lockfiles; results reflect those trees, not the current working state
  of the branches.
- The ratchet prototype's bisect is a manual binary search over `git rev-list`
  (Windows `git bisect run` is broken); it was not exercised in these runs.

---

## Closing note — generic vs. domain subjects, retroactive vs. prospective

**Why the first particles replay didn't catch what the second did.** The
original subject set was *generic*: conservation, finiteness, determinism,
wall bounds. Those held through all 25 commits — and correctly so: no
regression of that class had ever happened in that history. The
galaxy-structure subject is *domain-specific*: it encodes the human insight
that the spiral arms are the point of the galaxy, in the project's own terms
(A(m=2) from its README). The two classes have different economics:

- *AI-inferred subjects* (valid, cheap, generic) guard the floor. They can be
  generated mechanically and mostly land in the config-probe class.
- *Human-authored subjects* (knowledge of what to watch for, what may have
  regressed) guard the point. The best source for them is the project's own
  documentation and measurements — the README is where particles told us what
  mattered.

The ratchet's job is to make both cheap to *keep*: the generic class shrinks
to config, the domain class is a five-line custom subject, and both are
validated against history before they're trusted.

**Retroactive vs. prospective is the same instrument facing different
directions.** Everything in these experiments ran against history or existing
checkouts. A staged commit or the working tree runs through the identical
check contract — verify does not know or care whether a change is staged,
committed, or hypothetical. The staged-commit workflow is the same subject
facing forward; replay and bisect are the same subject facing backward. One
asymmetry worth carrying: a subject only catches a regression at the moment it
lands if the subject existed first — which is what the accept ceremony and the
journal are for: they record that a subject was installed, and why.
