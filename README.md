# Flux

A proposal for making AI a real abstraction layer: push inference to **compile time**
wherever the specification is knowable, and bound it where it cannot move.

## Files

- **[DESIGN_V3.md](DESIGN_V3.md)** - **Current proposal.** TypeScript library with a
  compile-time synthesis step
- **[RATCHET.md](RATCHET.md)** - The ratchet extracted as a standalone library:
  regression memory for AI-assisted development, shipped first
- **[ratchet/](ratchet/)** - **v0.7 — built, tested, self-hosting, and
  self-enforcing.** Working CLI: heuristics written as prose in a closed
  vocabulary, capture with cause-preserving reduction and a validation gate,
  `guard` wired into pre-commit and CI, `adopt` to arm a heuristic against your
  own history, the accept ceremony, owning-rule hashes with quarantine that
  names the clause that moved, replay across history with sampling and halving,
  visual pins, bisect, fsck. See [ratchet/README.md](ratchet/README.md) and the
  [walkthrough](ratchet/demo/README.md).
- **[EXPERIMENTS_RATCHET.md](EXPERIMENTS_RATCHET.md)** - Four field experiments
  (margin, odds, newportfolio, particles) and the five questions they answer
- **[NEXT_STEPS_V4.md](NEXT_STEPS_V4.md)** - **Current plan.** What v0.8 closed,
  what re-running the field experiments against it found, and what is next.
- **[NEXT_STEPS_V3.md](NEXT_STEPS_V3.md)** - the v0.7-era record: what v0.7
  closed, and the measurement showing the self-host corpus covered one class of
  defect while the codebase produced four. Superseded as the plan
- **[NEXT_STEPS.md](NEXT_STEPS.md)** / **[NEXT_STEPS_V2.md](NEXT_STEPS_V2.md)** -
  What the experiments demanded of the design, and the v0.6 plan; both
  superseded, both kept as the record
- **[ISSUES_RATCHET.md](ISSUES_RATCHET.md)** - The v0 code review: 21 findings, each
  reproduced by execution, all closed
- **[EXPERIMENT_LEETCODE.md](EXPERIMENT_LEETCODE.md)** - LeetCode ceiling experiment:
  statement length vs. solution length, with results
- **[ISSUES.md](ISSUES.md)** - Open issues from design review, kept current
- **[LANGUAGE_DESIGN_V2.md](LANGUAGE_DESIGN_V2.md)** - Standalone-language form, retained
  for reference. Same design decisions, different delivery vehicle
- **[LANGUAGE_DESIGN.md](LANGUAGE_DESIGN.md)** - Original v1 language specification
- **[QUICK_REFERENCE.md](QUICK_REFERENCE.md)** - v1 syntax reference

## The idea

An abstraction layer has to be a *function*. `compile(source) -> binary` qualifies,
because it is reproducible. `llm(prompt) -> output` is a *distribution*, which is why
"AI is just another abstraction layer" rings false.

So Flux splits work into three tiers by what each can guarantee:

| Tier | Model runs | Guarantee | Runtime cost |
|---|---|---|---|
| plain TypeScript | never | deterministic | free |
| `derive` | at **build**, once | deterministic after build | free |
| `infer` | at **runtime**, per record | bounded, typed, observable | metered |

`derive` is the new part. You write a specification; a model writes the
implementation once at build time; the result is verified, hash-pinned, committed,
and reviewed like any other code. At runtime it is ordinary TypeScript - no model in
the hot path, identical output on every run.

```
derive parseDuration
  takes  text     a duration written like "1h30m"
  gives  seconds  a whole number of seconds, or Malformed
  uses   formatDuration  as "formatted"

  examples
    "1h30m" => 5400
    ""      => Malformed

  rule  given any seconds above zero
        when  formatted and then parsed
        then  the result is the same as the original
```

Specifications are plain structured English, so the person who owns the domain can
write and review them without writing TypeScript.

The compiler then reports what the model chose and you didn't - the constants and
comparators your specification left open - so underspecification surfaces before it
ships.

## Best for

**`derive`** — where stating the rule is less work than writing the code:

- Parsers and normalizers for messy real-world formats: durations, addresses,
  units, dates in forty variations
- Classification and bracketing where the shape is obvious and the *constants* are
  the real content: shipping tiers, risk bands, pricing brackets
- Business rules that change often and must be auditable: eligibility, tax bands,
  thresholds — a domain expert edits the spec and a programmer stops being the
  bottleneck
- Schema migration and adapter code, where examples are natural and the
  implementation is a long tail of tedium

**`infer`** — where the input is genuinely unstructured:

- Document intelligence pipelines
- Data extraction from unstructured sources
- Content classification at scale
- Any high-volume workload where cost, provenance, and resumability matter

## Not for

- Work where the specification is as long as the implementation — most CRUD, most glue
- Novel algorithms; you cannot specify what you cannot yet characterize
- Hot paths needing hand-tuned performance — a synthesized body optimizes for
  passing its rules, not for speed
- Anything whose acceptance criteria you cannot state, which is the general form of
  the other three

## Principles

- **Specifications, not plans** - a plan is prose that nothing verifies; a spec executes
- **The ratchet** - counterexamples, pinned bodies, and journals accumulate; nothing regresses
- **Review intent, not mechanism** - the spec diff is short and human; the body diff is generated
- **The body is the artifact** - a frozen derive never calls a model again, so deprecation costs nothing
- **Metered, not guessed** - the runtime meter is the budget guarantee; static analysis is the estimate

## Status

Two tracks, at different stages.

### Flux the language — design phase

See **[DESIGN_V3.md](DESIGN_V3.md)** for the current proposal. The design has moved
through three forms:

- **v1** — a standalone language with `infer` as the central runtime primitive
- **v2** — three determinism tiers (`func` / `derive` / `infer`), moving inference
  to compile time wherever the specification is knowable
- **v3** — the same three tiers delivered as a TypeScript library with a
  compile-time transformer, trading syntactic enforcement for ecosystem, tooling,
  and incremental adoption

None of it is built. Everything rests on one unmeasured assumption — that writing a
specification is genuinely less work than writing the code — and DESIGN_V3.md
closes with the experiment that settles it. That experiment is still ungated:
[EXPERIMENT_LEETCODE.md](EXPERIMENT_LEETCODE.md) measured the ceiling and found the
"spec is less work" pitch does not survive it, which rescopes the claim to "spec
costs about the same, but is verifiable, durable, and outlives the implementation".

### The ratchet — built

The ratchet was the part worth shipping first, and it does not depend on any other
part of Flux ([ISSUES.md](ISSUES.md) item D). [ratchet/](ratchet/) is a
zero-dependency TypeScript CLI at v0.7 with 153 tests, validated in four real repos
([EXPERIMENTS_RATCHET.md](EXPERIMENTS_RATCHET.md)) and hardened by a code review
that reproduced 21 defects by execution ([ISSUES_RATCHET.md](ISSUES_RATCHET.md)).

**A heuristic is prose.** The v0.7 change: a subject is five lines in a closed
vocabulary, not forty lines of hand-written plumbing — because that plumbing is
where the field experiments found every check bug, and because the person who
knows the domain is not always the person who writes Node.

```
heuristic basic-edge
  run      node tools/simulate.js --hands 200000
  seed     20260906
  measure  edge  the number after "house edge:"
  rule     edge is between -0.03 and 0.015
  because  the published basic-strategy table puts this near -0.005
```

**And it enforces itself.** `ratchet guard` is one command with one exit code —
the rules file parses, the corpus is intact, every active row still holds, every
subject has been proven able to fail. `ratchet hooks install` wires it into
pre-commit; the same command belongs in CI. Nothing depends on anyone
remembering to run a checker.

It runs under itself in both forms. [`.ratchet/`](.ratchet) configures six
scripted subjects over this repository — checks of the checker, each validated
against `4abc1d5`, the last v0 commit, where the corresponding bug actually
lived — plus one prose heuristic pinning its own test suite. Replayed across its
own history:

```
✗ 4abc1d5  ratchet experiments                    0 pass, 5 fail
✗ 0d710eb  fix the seven safety defects (v0.2)    4 pass, 1 fail
✓ f4a9f84  close the remaining issues (v0.3)      5 pass, 0 fail
```

The one still failing at v0.2 is the dedup-key aliasing bug, fixed in v0.3. The
replay reconstructs the fix history without being told it.
