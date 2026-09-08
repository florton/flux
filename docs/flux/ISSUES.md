# Open Issues

Recorded 2026-09-05 from review of [DESIGN_V3.md](DESIGN_V3.md). None resolved;
all open. Numbered in the order they were raised.

## 1. LeetCode ceiling experiment

**Status: DONE — see [EXPERIMENT_LEETCODE.md](EXPERIMENT_LEETCODE.md).**

Result: full statement ≈ 1.4–1.7× code; statement minus constraints ≈ 1.15×;
narrative core ≈ 0.52×. The pitch "spec is less work than code" does not survive
at the ceiling; it rescopes to "spec costs about the same, but is verifiable,
durable, reusable — and outlives the implementation." Baseline-set scoring in
DESIGN_V3.md should reweight away from "meaningfully shorter."

## 2. The prose spec layer — direction and syntax matching

The `.rules` layer is the highest-effort, lowest-proof component. Working
direction (per maintainer): keep a plaintext / modified-Gherkin form so
business logic and non-programmers can own the spec. The open problem is not
"which English syntax" — it is **matching the spec syntax to hard software
requirement specification language**: mapping how real requirement documents,
standards (e.g., RFCs, ISO specs), and regulatory rules express constraints onto
the closed vocabulary + `flux fmt` canonicalization pipeline. Until that mapping
exists, the vocabulary table is a guess.

Open sub-questions:
- Does the loose-authoring/canonical-storage mechanism actually converge, or do
  notes become the path of least resistance (DESIGN_V3.md open question 1)?
- Should prose ship at v1, or gate on the baseline experiment?

## 3. Delivery vehicle: ts-patch vs. standalone

ts-patch is fringe: most modern TS builds go through esbuild/swc/Vite, which
ignore tsc transformers. Make the `flux` CLI primary and any transformer
optional. Maintainer note: general interest in TypeScript transpilers as a
possibly separate project; the build-phase-hook question stays open.

## 4. Open-decisions analysis needs a coverage report

Mutation analysis only finds decisions the examples discriminate. An uncovered
branch means a mutant there passes silently, and "0 open decisions" becomes
false confidence. Add a coverage report for the mutant pass: which branches /
variants were exercised, per derive. (Counterpart to DESIGN_V3.md's
corpus-density measure.)

## 5. Supply chain: verifying model-generated code

`flux verify` executes model-generated bodies; synthesis and verification need a
sandbox, timeouts, and non-termination handling. DESIGN_V3.md has no section on
this. A body that hangs or exfiltrates during `derive`/`verify` is a supply-chain
incident, and the review story implies trust in the tool.

## 6. Escape hatch

"No raw model SDKs" is too rigid for incremental adoption and is only
lint-enforceable anyway (Enforcement section concedes this). Proposal: allow a
metered, provenance-tagged escape hatch under the same circuit/meter machinery,
preserving the cost-lever argument without prohibition.

## Earlier issues from the same review (kept open)

- **A. Journal is advisory, not binding.** Corpus and lockfile are mechanical;
  the journal only feeds the model as context. Proposal: structured journal
  entries that are mechanically re-applied on resynthesis. "Nothing ever moves
  backward" (DESIGN_V3.md thesis) oversells; the behavioral diff is the real
  guarantee — restate the thesis accordingly.
- **B. Corpus traceability.** Corpus rows are not linked to the rule that
  produced them. A counterexample that enters the corpus should record its
  originating rule, derive, and seed.
- **C. Corpus sharing.** The ratchet is per-project. Shared/published corpora
  (phone-number counterexamples from project A helping project B) would compound
  value; not addressed in DESIGN_V3.md.
- **D. Ratchet as its own library.** The doc names the ratchet as "the thing
  worth building" but packages it as three file formats inside Flux. Consider
  extracting corpus store + journal + lockfile + behavioral-diff + mutation
  runner as a standalone library with Flux as flagship consumer.
  **Direction settled 2026-09-05:** extraction is the plan — see
  [../ratchet/RATCHET.md](../ratchet/RATCHET.md). Git is not extended; the ratchet hooks existing
  pipeline points (test output, CI, pre-push, agent sessions) via plain files.
  Also settled: **tautology detection (the mutant pass over bodies vs. rules)
  moves to the ratchet library** — it governs rule quality, not synthesis.
  Flux keeps only open-decisions analysis (free-parameter enumeration), which
  is synthesis-specific. Retroactive application of the ratchet to a commit
  tree (replay / mine / semantic history) is specified in ../ratchet/RATCHET.md.
  **v0 prototype built 2026-09-06:** see [../../ratchet/](../../ratchet/) — CLI with
  capture (fast-check reporter + JUnit), dual-run discrimination, ddmin
  shrinking, verify, accept/reopen ceremony, churn report, and manual binary
  bisect (`git bisect run` is unreliable on Windows git). Demo with a seeded
  git history at [../../ratchet/demo/](../../ratchet/demo/).
  **v0 reviewed 2026-09-05:** 21 open defects and findings recorded in
  [../ratchet/../ratchet/ISSUES_RATCHET.md](../ratchet/../ratchet/ISSUES_RATCHET.md) — two critical (shell injection via
  `{test}` substitution; an accepted row can never re-catch its own regression),
  five high. The design holds; the corpus-integrity seams do not.
  **v0.2 built 2026-09-06:** the seven critical/high defects are fixed with a
  regression test each — checks spawn without a shell, recurrence after accept
  is reported instead of swallowed, reduction preserves the failure cause, row
  ids are content-addressed, and bisect runs in a worktree.
  **v0.3 and v0.4 built 2026-09-06:** all 21 findings closed, then the design
  gaps behind them — owning-rule hashes with quarantine, the frozen instrument
  (`{home}`), the second confirmation run, `ratchet replay` with sampling and
  halving, and `ratchet validate`. The ratchet now self-hosts: `.ratchet/` runs
  five subjects over this repository, each validated against the commit where
  its bug lived. This closes the "corpus traceability" half of issue B — rows
  carry their originating rule hash, seed, and commit.
- **E. Spec-wrongness is unreachable.** Open-decision analysis finds what the
  spec leaves open, never what it gets wrong (already DESIGN_V3.md open question
  5). The mutant-coverage report (issue 4) shrinks but does not close this.
- **F. Tier 2 positioning.** Don't out-feature BAML/instructor/outlines;
  differentiate on the ratchet (corpus-driven repair prompts, counterexample
  replay for cached determinism) and the pipeline (correlation-id packing,
  rate-over-window circuits).
- **G. Stdlib scope.** A lodash-scale stdlib is a large surface bought to
  justify the no-escape-hatch rule. With issue 6 softening that rule, revisit
  whether the stdlib must be that large.
