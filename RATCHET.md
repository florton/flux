# Ratchet — Regression Memory for AI-Assisted Development

> **Status:** design sketch. Extracted from
> [DESIGN_V3.md](DESIGN_V3.md) (see issue D in [ISSUES.md](ISSUES.md)). The
> ratchet is the part of Flux worth shipping first, and it does not depend on
> any other part.

---

## Thesis

AI-assisted development has an easy first mile and a suspicious second one.
Agents produce value immediately, and a year later nobody can answer the only
question that matters: **are we actually improving, or are different agents
continually rewriting each other's work?**

The answer is measurable. It is not in the code — the code is whatever the last
agent left. It is in the artifacts the workflow throws away:

- the counterexample that failed CI on Tuesday and is gone by Thursday,
- the reasoning behind a decision, which no commit message carries,
- the behavior that changed, which a textual diff cannot show.

Ratchet makes those artifacts permanent, append-only, and version-controlled —
using **ordinary files and existing pipeline hooks, never git itself**. Git
reviews textual change; AI change is behavioral. Ratchet does not extend git. It
writes files git already knows how to version, and it hooks the points where
failures already surface: test runners, CI, and agent sessions.

**The ratchet works with zero model calls, for hand-written code too.** A
project that adopts it without ever running an AI agent still gets permanent
fuzz-failure memory and behavioral-diff review. That is the adoption wedge.

---

## What it answers

| Question you cannot answer today | Ratchet artifact | Mechanism |
|---|---|---|
| What changed, behaviorally? | **behavioral diff** | re-run corpus + sampled oracles against the new code |
| Why was this decision made? | **journal** | append-only decision log, keyed to commits |
| What did we already learn? | **corpus** | every counterexample ever found, permanent |
| Was this change intended? | **pins + accept ceremony** | QC artifacts keyed to the rule that justified them |

---

## The three artifacts

### 1. The corpus — counterexample memory

Append-only JSONL per subject (a function, a derive, a module seam):

```jsonl
{"id":"c0217","input":{"weight":1000},"expected":"Heavy","actual":"Standard",
 "rule":"shippingTier.rules:14","test":"tests/shipping.test.ts","commit":"a5cf273",
 "seed":"0x7f3a","captured_at":"2026-09-05T17:20Z","status":"active"}
```

Properties that matter:

- **Append-only, never edited.** Retirements are separate records, not
  deletions — the audit trail survives.
- **Provenance is part of the row.** Which rule caught it, which commit, which
  seed. A row with no provenance is a row nobody can retire.
- **Minimized at capture.** Property frameworks already shrink; for raw test
  failures, a local delta-debug (ddmin) pass runs at capture time. The row
  stores the minimal input that fails.
- **Discriminated.** A failure must reproduce twice to enter the corpus. Flakes
  are the fastest way to make a corpus untrustworthy.

### 2. The journal — reasoning history

Append-only JSONL, one decision per line:

```jsonl
{"id":"j0042","at":"2026-09-05T17:30Z","subject":"shippingTier",
 "kind":"decision","actor":"human:alice","evidence":"PR #118, commit a5cf273",
 "text":"threshold 1000 chosen to match carrier contract, not spec examples",
 "executable":"c0217"}
```

The rule that keeps the journal honest: **every clarification should try to
leave an executable artifact.** The `executable` field links the prose to a
corpus row or a rule that mechanically enforces it. Prose alone is advisory —
fed to agents as context, honored or not. Prose plus a row is enforced on every
CI run forever. Journals that carry only prose rot into narrative; the report
counts the ratio and says so.

Merge behavior is trivial because it is append-only: no conflicts, ever.

### 3. Pins and behavior snapshots — the oracle

A pin records what produced a body of code and under what justification:

```toml
[shippingTier]
body_sha256 = "9f1c..."
rule_hash = "c3a4..."        # hash of the rule/test source that justifies it
generator_version = "1.2.0"
model = "claude-sonnet-5"    # may be absent — hand-written code pins too
```

Behavior snapshots are stored expectations for a sampled input set
(`__snapshots__`-style), versioned by signature hash. Together they answer
"what behavior changed" without a model and without re-deriving anything.

---

## The accept ceremony — the load-bearing piece

The golden-master problem is real: a corpus row can become wrong because the
behavior legitimately changed. Without a ceremony for that, teams bulk-delete
the corpus and the ratchet dies.

Ratchet's answer is that **the quality-control analysis is versioned with the
heuristic that justified it:**

1. Every corpus row is owned by the rule or test that produced it, identified
   by a content hash of that rule's source.
2. On each verify, ratchet hashes the owning rule. **Rule unchanged and row
   fails → hard block.** This is a regression, full stop.
3. **Rule changed and row fails → quarantine, not block.** The heuristic moved,
   so the QC analysis moves with it. The failure is reported as "behavior
   changed under an edited rule" and routed to review.
4. `ratchet accept <row-id> --reason "..."` is the ceremony: the new output
   becomes the oracle, the old one is retained in the audit trail, and a
   journal entry links it to the commit and PR.

Change the heuristic, re-run the analysis, review the delta. What is never
allowed is re-deriving expectations silently — that is the exact failure mode
of trusting the last agent that ran.

---

## Defining heuristics

A heuristic is anything a user asserts that a body must satisfy, beyond the
examples it passes. Four kinds, each with exactly one checking mechanism. They
differ in what they observe; they share the contract that matters: **every
heuristic yields a deterministic pass/fail verdict and a machine-readable
counterexample that enters the corpus.** A heuristic that cannot produce a
counterexample is a note, not a heuristic — prose nothing enforces (the `note`
category, verbatim from DESIGN_V3.md).

| Kind | Observes | Expressed as | Example |
|---|---|---|---|
| **predicate** | input → output values | examples, rules, corpus rows | `rule given any weight above 5000 then the tier is not Standard` |
| **metric** | measured quantities over runs | budget: threshold + window + baseline | `p95(parseDuration, 10k runs) within 20% of baseline` |
| **static** | the code itself | catalog + custom AST/call-graph patterns | `no network from pure code`, `no eval`, `bounded loops only` |
| **custom** | anything the host language computes | a check function returning a counterexample | `rule("monotone", x => classify(x) <= classify(x + 1))` |

**Metric budgets** (speed, error rate) are the noisy ones. Absolute thresholds
fail on shared CI runners — a 100µs budget measured on a loaded machine is a
coin flip — so the primary form is **baseline-relative**: the pinned body
stores its measured profile, and the budget is "not slower than the previous
body by 20%". That is the behavioral-diff machinery reading a different
channel. Error-rate heuristics (repair rate, refusal rate, bucket
distribution) are metric budgets over the corpus, and they are where Tier 2
quality control lives.

**Static checks** (security, structure) are the cheapest and most decisive:
deterministic, no sampling, no flakiness. The catalog ships built-ins —
no-eval, no-shellout, no-network-from-pure, bounded-loops, no-input-mutation —
and accepts custom patterns in the host language. Security heuristics are
overwhelmingly of this kind: expressible and checkable with zero model calls.

**Custom targeting logic** is not a new language. Anything the other kinds
cannot say is a host-language function that returns pass or a counterexample.
The prose vocabulary is for what domain experts must be able to own; the
function form is the general case. The rule from DESIGN_V3.md stands: prose
rules and executable rules are peers — neither is generated from the other,
neither has precedence.

Every heuristic is versioned like a rule: content-hashed, its corpus rows keyed
to it. Editing a heuristic quarantines its rows and demands the accept
ceremony. Raising a performance budget is a ceremony too — the ratchet never
lets the analysis drift off the justification that produced it.

A model may **suggest** heuristics. It may never judge whether one passed. Same
division as everywhere else in the design: the model proposes, deterministic
machinery disposes.

---

## The pipeline hooks

Everything is one binary plus files. No git extension, no daemon.

| Point | Command | What happens |
|---|---|---|
| CI, after tests | `ratchet capture junit.xml` | parse standard test output, shrink, stage new corpus rows |
| CI, gate | `ratchet verify --base $BASE_REF` | run corpus + snapshots, emit behavioral diff, exit code |
| PR | bot posts the behavioral diff | "37/38 rows identical; row c0217 `weight=1000` changed" |
| pre-push | `ratchet verify --quick` | corpus-only, milliseconds, no snapshot sampling |
| agent session start | `ratchet attach --subject X` | emit the journal+corpus slice as context for the agent |

**Capture rides the same PR as the fix.** The counterexample file is staged
alongside the code change that resolves it — one diff, one review, provenance
by construction. Nothing is auto-committed out of band.

**JUnit/TAP parsing makes capture language-agnostic.** The core reads the
formats every test runner emits. Property-test integration (fast-check,
Hypothesis) is a thin adapter on top, because those frameworks already produce
minimal counterexamples with seeds.

---

## The number that ends the argument

The churn report, per week or per release:

```
corpus: 1,204 rows (monotone, +37 this week)
failures this week: 12
  caught by corpus:  9   — known regressions, the ratchet worked
  new counterexamples: 3 — novel bugs
retirements: 1 (accepted, see j0091)
```

Two metrics, both meaningful:

- **Corpus-catch rate** — what fraction of failures were already known. If
  every failure is new, agents are churning; if the corpus catches most,
  memory is working.
- **New-counterexample rate** — the actual rate of novel bugs. This is the
  answer to "are we improving." It is a number, not a feeling.

---

## Retroactive application

The ratchet is designed to start today, but it does not need to start empty. It
can be pointed at the commit tree it was born into, in three modes with
different costs and payoffs:

**Mode 1 — replay.** Run today's corpus against historical commits. Every row
is a regression test with provenance, so this is `git bisect` with an
automatically grown test set: it dates the introduction of every known bug and
draws the corpus pass-rate curve over the project's life. `ratchet bisect
<c0217>` finds the commit that first failed the row. Cheap, mechanical, works
wherever the old tree builds.

**Mode 2 — mine.** The commit tree contains discarded knowledge. Tests that
were deleted, and assertions that were weakened, are counterexamples that fell
out of memory; a commit that weakened a test to make CI pass is exactly the
place an accept ceremony should have happened. `ratchet history` walks
test-file history, resurrects deleted and weakened assertions, re-runs them
against current code, and promotes the failing ones to corpus rows — with
provenance pointing at the commit that discarded them. This is the entry point
for a repo adopting the ratchet: the first run produces a *report*, not a
requirement.

**Mode 3 — semantic history.** Behavioral diff between any two commits, using
the same machinery as PR review. A semantic `git blame`: which commit changed
what these inputs do.

### Limits of retroactivity

- Replay is bounded by reproducibility. Old trees fail to build — dependencies,
  lockfiles, toolchains. The horizon is where the build breaks.
- Mined rows inherit their era's weaknesses: a test deleted for good reason
  (behavior intentionally changed) becomes a quarantine, not a block. The
  accept ceremony applies to archaeology too.
- The corpus is *today's* knowledge. Replay dates known bugs; it cannot recover
  the bugs no test ever recorded. Mining narrows this gap and does not close it.
- Journal reconstruction from commit messages is synthetic provenance, marked
  as such, and never trusted over recorded history.

---

## Relationship to Flux v3

The ratchet is the v1. It is deterministic, testable, and useful before any
model enters the picture — which makes it the piece that de-risks everything
else. Flux's `derive` becomes a consumer:

- `flux derive` writes pins and consumes the corpus (it already does, in
  DESIGN_V3.md — this is that machinery, generalized and extracted).
- The behavioral diff on resynthesis *is* `ratchet verify`.
- Tier 2 `infer` gains corpus-driven repair prompts and counterexample replay
  for cached determinism.

Building Flux without building the ratchet first means building the hard part
(model-dependent synthesis) before the dependable part. The order should be
reversed.

---

## Honest limits

- **Behavioral diff needs seams.** Pure functions diff cleanly; impure code
  needs the call-graph coloring Flux already defines to mark the comparable
  region. Some code never diffs.
- **Capture is incomplete at the edges.** A failure that depends on database
  state or wall-clock time yields a partial row — marked advisory, not
  enforced. Better than nothing, never trusted as proof.
- **Dual-run discrimination is not perfect.** Some flakes reproduce twice.
- **The corpus is only as good as the rules that own it.** A vacuous rule
  catches nothing; the tautology-detection machinery from DESIGN_V3.md
  (mutant pass) is what keeps rows load-bearing. It belongs in this library,
  not in Flux.

## Open questions

1. **Host language.** Rust single binary (any pipeline, zero deps) vs.
   TypeScript (the target market's ecosystem). The capture core parses JUnit
   and TAP — it is language-agnostic either way.
2. **Snapshot sampling strategy.** Which input set backs the behavior
   snapshot: corpus rows only, or corpus + boundary catalogue? Corpus-only is
   free and honest; boundary sampling catches change where the corpus is
   sparse, at the cost of signature-versioned snapshot churn.
3. **Agent attach format.** What exactly does an agent session receive from
   `ratchet attach` — the full journal, or the N rows nearest the subject?
4. **Retirement vs. archival.** Rows are never deleted, but at some size the
   archived tail stops running. What is the demotion curve?
