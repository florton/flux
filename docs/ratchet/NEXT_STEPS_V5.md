# Ratchet — Next Steps v5

> Supersedes [NEXT_STEPS_V4.md](NEXT_STEPS_V4.md) as the plan. That file stays
> as the v0.9-era record; its items 1–5 are built, item 6 is partly built, and
> items 7–9 are carried forward here. What exists is in
> [../../ratchet/README.md](../../ratchet/README.md); what is broken or open is in
> [OUTSTANDING_RATCHET.md](OUTSTANDING_RATCHET.md).

> **Update, 2026-09-08 — item 1 is done, it found R39, and the tool is v0.10.**
> The last false green in the gate is closed: a subject with no active row and
> no declared rejection was counted as proven and never executed, and `guard`
> now names it. Building that reproduction meant writing a config by hand, and
> a one-word typo — `command` for `check` — turned out to reach the spawn site
> as `TypeError: command is not iterable`, which `validate` then reported as
> the check *failing as required*. Both closed, each reproduced by execution
> and each part reverted on its own to prove its tests are not vacuous. The
> accounts are [R31 and R39](OUTSTANDING_RATCHET.md). Two entries remain open,
> both low (R32, R33), and neither is a false green. 237 tests.

> **Update, 2026-09-07 (later) — item 3 is done, and it found R37.** The blind
> DX test ran against a throwaway ranking repo and hit a **false green** on the
> first heuristic written: a bound written in ordinary English was checked as a
> string comparison, so `latency should never be above 0.0001` passed forever
> while the real reading was 0.21. Fixed, with six regression tests; the
> account is [R37](OUTSTANDING_RATCHET.md) and the run is experiment 5 in
> [EXPERIMENTS_RATCHET.md](EXPERIMENTS_RATCHET.md). Two usability findings from
> the same run are left open under item 3 below. It also found R38: a brand-new
> `ratchet init` opened its first `guard` with a warning about the file `init`
> had just written. 224 tests.

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

### 1. Close R31 — the gate affirms a subject that nothing runs — **done**

Closed, and shipped as v0.10. `guard` grew an `unrun subjects` step: every
declared subject that no mechanism will run, named and worded as what is true —
*nothing runs this* — with advice each kind of subject can actually take, and
the proof line now carries `(nothing runs it)` beside the name it used to
affirm without qualification.

The one design choice worth recording: the set is read off **what `verify`
actually ran**, not re-derived from its selection rule. Restating "active rows
union standing invariants" in a second place is how a gate and the thing it
describes drift apart — the general shape of most of the defects in
[OUTSTANDING_RATCHET.md](OUTSTANDING_RATCHET.md) — so a subject nothing
reports on is a subject nothing ran, with no second copy of the rule to fall
behind.

Reproduced and re-run by execution against a scratch project whose checks leave
marks on disk, with the arm and archive controls both driven; five regression
tests, three of which fail against the unfixed gate. The account is
[R31](OUTSTANDING_RATCHET.md). 229 tests.

**Still open, and not a defect:** the design question K5 raised — whether a
scripted subject should be able to declare a rejection at all, or whether "a
standing property, checked by a script" should always be spelled as a prose
heuristic with a `run` line, as this repository now does everywhere. The
warning makes the choice visible at the moment it matters; it does not make it.

### 2. The semgrep pass (the selling-point half of the checklist)

Run `semgrep` (`p/security-audit` + `p/javascript`) over `ratchet/src`, triage
real findings into the R-series with execution repros, commit a suppression
config for false positives. Zero runtime dependencies makes this a short pass,
and the README gets the sentence that sells: zero-dependency, statically
clean, gate-fuzzed. Also `npm audit` (trivially clean with no deps) and a
tsconfig-strictness check.

### 3. The blind DX test — **run**; two findings still open

Done. 27 minutes against the 10-minute target, written up as experiment 5 in
[EXPERIMENTS_RATCHET.md](EXPERIMENTS_RATCHET.md). The overrun was one defect
(R37); a second (R38) turned up before the first heuristic was even written.
Both closed. What it left open is small and specific:

- **README step 5 does not fit a healthy repo** — **closed 2026-09-08.** The
  finding turned out to describe *two* step lists, not one. "Running against a
  local repo" step 5 had already been fixed: it presents both routes as peers
  and names the mis-step outright ("Reaching for `adopt` on a repo with no such
  bug is the common first mis-step; it exits 1"). "The workflow" step 2 had
  not, and that is the list billed as *the order of leverage* — it offered
  `adopt --good <ref>` and `validate --known-bad <sha>`, both of which need a
  known-bad commit, and never mentioned the `rejects` route at all. Rewritten
  to carry both, in the same "a fact about your repository, not a preference"
  framing the other list uses. The same step also carried a **dangling
  cross-reference** — `(see "Validation is a gate, not a ritual")`, a section
  that does not exist — now pointing at "Two proofs that a check can fail". A
  sweep of every `(see "...")` in the README confirms the remaining seven all
  resolve to real headings.
- **The frozen-instrument warning fires on the natural layout.**
  `node tools/eval.js` from inside the repo it measures is how everyone writes
  it first, and the warning only bites once a *history* command runs. Correct,
  but shown on day one next to warnings the reader can act on. Worth gating on
  whether the repository has ever run `replay`, `bisect` or `adopt`.
- The quickstart/reference split still stands as the likely shape: 1,363 lines
  of detail around a seven-step loop, and the cold reader reached step 4 fast
  and then had one long detour.

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
  hand-rolls. **Designed, not built:**
  [DESIGN_ARTIFACT_CACHE.md](DESIGN_ARTIFACT_CACHE.md) works the problem and
  recommends *against* the artifact store as a first move — the per-commit cost
  is setup re-run inside a reused worktree, not a cold install, and the cache
  as usually imagined is a deliberate policy of checking a commit out without
  preparing it, which is the v0.8 `adopt` defect made systematic. Three staged
  options there, cheapest first.
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
