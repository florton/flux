# Ratchet — the per-commit artifact cache, before anyone builds it

> **Status: design note. Nothing here is built, and the recommendation is that
> stage 3 not be built until the question in §3 has an answer.** This is item 9
> of [NEXT_STEPS_V5.md](NEXT_STEPS_V5.md), written 2026-09-08 while the context
> was in someone's head rather than after it had drained out.

The reason to write this down rather than build it: coming back cold to the
line "add a per-commit artifact cache" is how the *dangerous* version gets
built. The dangerous version is not hypothetical or exotic. It is the default
one — the one anybody would write first — and this repository has already
shipped its failure mode once, in `adopt`, and now carries a static invariant
whose only job is to prevent it. A cache is that bug, made deliberate and
systematic. That is not a reason never to build it. It is a reason the
correctness argument has to exist before the code does.

## 1. The cost, as recorded

From [`../../ratchet/README.md`](../../ratchet/README.md), measured by an
earlier session and **not re-measured here**:

> arming one subject costs 3m44s over 9 commits on one field repository and
> 2m18s over 6 on another, almost all of it setup and build repeated per
> commit.

That is ~24.9s and ~23.0s per commit respectively — consistent enough between
two unrelated repositories to look like a structural cost rather than one
project's bad luck.

It is worth being clear about the size of the prize. This is a slow afternoon,
not a blocker. Nothing is unusable at 25s/commit; a `replay --every week` over
a year is a coffee break. The feature is a convenience, and it should be held
to the standard of a convenience: **it may not cost correctness at any price.**

## 2. What that number is actually made of

The README sentence conflates two different costs, and they have different
fixes. Two facts, both established rather than assumed:

**Fact 1 — worktrees are pooled and reused, so setup re-runs per commit.**
`replay` allocates `min(concurrency, commits)` worktrees
([`replay.ts`](../../ratchet/src/replay.ts)) and its `probe()` does
`session.checkout(sha)` followed by `runSetup(session, opts.setup)` for **every
commit**, into a worktree that is not recreated between commits.

**Fact 2 — untracked build output survives the checkout.** Measured by
execution today, in a scratch repository: with `node_modules/marker` and
`dist/out.js` present and untracked, `git checkout --detach --force <newer>`
moved the tracked file (`a.txt`: `one` → `two`) and left **both** untracked
artifacts byte-identical.

Put together: the per-commit cost is **not** a cold reinstall forced by a fresh
directory. The directory still has last commit's `node_modules` and `dist` in
it. The cost is whatever the project's own `--setup` string chooses to do when
run again — and `npm ci`, the line everyone writes first and the one this
repository's own docs use as the example, *deletes `node_modules` and
reinstalls from scratch every time.*

So a material share of that 25s/commit may be a **documentation problem**, not
a missing cache: nobody is told what a good `--setup` line looks like, so
everybody writes the most destructive one. `npm ci` → `npm install
--prefer-offline --no-audit --fund=false` is a one-line change to a string the
project already owns, needs no new machinery, and cannot corrupt a verdict.

**And the docs hid this — fixed 2026-09-08.** The README described the flag as
`--setup "npm ci"` *prepares each worktree*, twice: at the `adopt` summary and
in the `replay` reference. It does not prepare each worktree. It prepares each
**commit**, which on a nine-commit replay is nine `npm ci` runs against a
directory that already has `node_modules` in it — so a reader costing out a
replay from the documentation underestimated it by the number of commits
sampled. Both now say so, and the `replay` bullet names the pooling and the
surviving build output that make it true. (The `bisect` reference was already
correct: "runs a command in the worktree before each probe.")

**This is a hypothesis, not a finding.** Nobody has measured the split between
"cold install" and "setup re-run" on either field repository. The experiment
that settles it is small and should run before any cache is designed:

> On one field repository, time `replay --every week` three ways — `npm ci &&
> build`, `npm install --prefer-offline && build`, and setup run once by hand
> with a no-op `--setup` — and report the three numbers. If the middle number
> is close to the third, the cache is mostly unnecessary and the remaining work
> is §5 stage 1. If it is close to the first, the cache has a real case.

Note this also settles half of the *other* part of item 9 — the hand-rolled
worktree setup. If a recommended setup line is most of the win, then what
projects need is a documented recipe, which is much less than a helper.

## 3. The hazard, which is the whole point of this note

`.ratchet/tools/uniformity.js` carries a static invariant,
`setup-follows-every-checkout`, that fires when a file checks out a probed
commit more times than it prepares one. Its message:

> a probe after the unprepared checkout measures the build left behind by the
> previous one

That invariant is not speculative hygiene. It exists because the bug happened.
From the README's own account of the v0.8 findings:

> `adopt` confirmed a failure by checking the bad commit out a second time and
> *did not re-run `--setup`*. Build output is untracked, so the confirmation
> measured whichever commit was built last — every subject with a build step
> was reported flaky and refused, and a failure caused by stale artifacts would
> have been confirmed and stored.

§2 Fact 2 is the mechanism of that bug, reproduced. And now read what a cache
is: **a deliberate, systematic policy of checking a commit out and not
preparing it.** Building it means weakening or rewriting the one static check
standing guard over this exact class.

So the central design question, ahead of any code:

> **What replaces `setup-follows-every-checkout`?**

"Delete it" is not an answer. Neither is "narrow it to files that do not use
the cache," because the whole point of the invariant is that it is a
completeness property over call sites — the v0.8 defect was the *fifth* call
site forgetting what four others remembered, and the scanner exists because
that class has no counterexample to catch it. A cache adds a sixth path, and
"was this commit prepared, or is the directory dirty from a previous one?"
stops being answerable by counting checkouts against setups. It becomes a
question about a key.

A candidate replacement, offered as a starting point rather than a conclusion:
the invariant becomes *every checkout is followed by setup **or** by a cache
hit whose key includes the commit sha*, checked statically the same way, with
the cache lookup as a recognized preparation. That is strictly weaker than
today's check — it trusts the key — which is why §4 matters as much as this
section does.

## 4. What a sound key looks like, and the primitive that already exists

A cache entry is only sound if its key covers everything the build output
depends on. Enumerated:

| Term | Available today? |
|---|---|
| Commit sha | yes |
| The `--setup` command string | yes, it is a CLI argument |
| Toolchain identity (node, platform, arch) | **yes** — `Environment` in [`worktree.ts`](../../ratchet/src/worktree.ts) already records exactly `{node, platform, arch, at}`, for attributing history failures to environment rot |
| Untracked / ignored inputs the setup reads | **no, and not computable in general** |

The last row is the one that decides the design. A setup that reads a `.env`, a
global npm cache, a `~/.m2`, or a network registry has inputs ratchet cannot
see, and a key that ignores them is a key that will eventually serve one
commit's artifacts for another. That is the false green this tool exists to
prevent, arriving through the back door.

**The way out is to stop trying to compute the key and make the project declare
it** — and ratchet already has this exact mechanism, pointed at a different
problem. `SubjectConfig.owns` is *"files whose contents define this subject's
rule... hashed with the check command into the owning-rule hash... Paths are
relative to the repository root; directories are walked"*
([`types.ts`](../../ratchet/src/types.ts)), implemented by `ruleHash()` and
`collectOwned()` in [`rule.ts`](../../ratchet/src/rule.ts).

That is precisely the primitive a setup key needs: hash a declared set of
tracked paths at a commit. A setup declaring `owns package-lock.json` gets a
sound key over the thing that actually decides whether `npm ci` would produce
different output — and it is sound because the inputs are *tracked*, so
ratchet can read them at any commit rather than guessing about the filesystem.

The shape this suggests is not a content-addressed artifact store at all. It is
narrower and much safer:

> **Skip the setup re-run when the declared inputs are unchanged since the last
> commit prepared in this worktree.** No artifact store, no eviction, no
> cross-run persistence, no cache directory to corrupt — just "the inputs to
> `npm ci` are byte-identical to what is already installed here, so do not
> reinstall." Scoped to one worktree within one `replay` run, it cannot leak
> across runs, across machines, or across toolchains, because it never outlives
> the process.

Most of the win, a fraction of the blast radius. It fails safe: an undeclared
input means the skip does not happen, which costs time and nothing else —
whereas an undeclared input in a persistent artifact cache means a wrong
verdict.

## 5. Recommendation — three stages, cheapest and safest first

1. **Document the setup line.** A recommended `--setup` recipe per ecosystem,
   and a sentence in the README saying why `npm ci` is the expensive choice
   inside a reused worktree. Zero machinery, zero risk. Run the §2 experiment
   first so the sentence carries a number.
2. **In-run setup skipping, keyed on declared tracked inputs** (§4). Reuses
   `collectOwned`/`ruleHash`, never outlives the process, fails safe toward
   re-running. This is the piece worth building.
3. **A persistent per-commit artifact cache.** Only after §3's question has a
   written answer and stage 2 has shipped and been lived with. If stage 1 and 2
   together close most of the 25s/commit — which §2 suggests is plausible —
   stage 3 may never be worth its risk, and that is a fine outcome.

## 6. What must be true before stage 3 ships

- `setup-follows-every-checkout` has a stated successor, and the successor is
  itself checked statically.
- The key includes the toolchain triple (`Environment` already has it).
- Undeclared inputs fail *closed* — toward re-running setup, never toward a
  hit.
- There is a verification mode that runs both paths across a range and asserts
  identical verdicts, and it runs in this repository's own gate. A cache whose
  correctness is not itself a standing invariant does not belong in a tool
  whose entire claim is that it catches false greens.
- The field-repository numbers are re-measured after stage 2, so stage 3 is
  argued against a real remaining cost rather than the original 3m44s.

## 7. Open questions for a human

- Does a setup declare its inputs in `config.json`, or as a new clause in the
  prose rules? Setup is a CLI argument today and belongs to no subject, which
  means it currently has nowhere to declare anything. That is a small design
  hole worth naming before it gets filled by accident.
- Is `--setup` even the right home for this, or should a project's preparation
  become a declared, named thing that `replay`, `bisect`, `adopt` and
  `validate` all refer to by name? Four commands take the flag today and each
  one's caller decides what a failure means; a named setup would let the
  *project* say once.
- Does the cache belong to the ratchet home (travels with the repo, gets
  committed, is subject to `fsck` and the fuzzer) or to a machine-local scratch
  directory (never committed, never inspected, never merged)? The home is where
  everything else lives, and is exactly where a stale cache would do the most
  damage.
