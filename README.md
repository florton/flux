# Flux

A proposal for making AI a real abstraction layer: push inference to **compile time**
wherever the specification is knowable, and bound it where it cannot move.

## Files

All design and record documents live under [docs/](docs/), split by track.
Superseded files are kept as the record, exactly as they were; each plan names
its successor.

### Flux the language — [docs/flux/](docs/flux/)

- **[docs/flux/DESIGN_V3.md](docs/flux/DESIGN_V3.md)** - **Current proposal.**
  TypeScript library with a compile-time synthesis step
- **[docs/flux/EXPERIMENT_LEETCODE.md](docs/flux/EXPERIMENT_LEETCODE.md)** -
  LeetCode ceiling experiment: statement length vs. solution length, with
  results
- **[docs/flux/ISSUES.md](docs/flux/ISSUES.md)** - Open issues from design
  review, kept current
- **[docs/flux/LANGUAGE_DESIGN_V2.md](docs/flux/LANGUAGE_DESIGN_V2.md)** -
  Standalone-language form, retained for reference. Same design decisions,
  different delivery vehicle
- **[docs/flux/LANGUAGE_DESIGN.md](docs/flux/LANGUAGE_DESIGN.md)** - Original
  v1 language specification
- **[docs/flux/QUICK_REFERENCE.md](docs/flux/QUICK_REFERENCE.md)** - v1 syntax
  reference

### The ratchet — [docs/ratchet/](docs/ratchet/)

- **[ratchet/README.md](ratchet/README.md)** - The working implementation.
  v0.10: CLI, walkthrough, commands
- **[docs/ratchet/RATCHET.md](docs/ratchet/RATCHET.md)** - The ratchet
  extracted as a standalone library: regression memory for AI-assisted
  development, shipped first
- **[docs/ratchet/NEXT_STEPS_V5.md](docs/ratchet/NEXT_STEPS_V5.md)** -
  **Current plan.** The fuzzer is built; what closed, what is next
- **[docs/ratchet/NEXT_STEPS_V4.md](docs/ratchet/NEXT_STEPS_V4.md)** - the
  v0.9 plan and its record; superseded by V5, kept as the measurement that
  shaped it
- **[docs/ratchet/NEXT_STEPS_V3.md](docs/ratchet/NEXT_STEPS_V3.md)** - the
  v0.7-era record: the coverage finding and the self-host corpus lesson
- **[docs/ratchet/NEXT_STEPS.md](docs/ratchet/NEXT_STEPS.md)** /
  **[docs/ratchet/NEXT_STEPS_V2.md](docs/ratchet/NEXT_STEPS_V2.md)** - the
  v0.6 plan and what the experiments demanded of the design
- **[docs/ratchet/OUTSTANDING_RATCHET.md](docs/ratchet/OUTSTANDING_RATCHET.md)** -
  the live issue register: R28 onward, open and closed, one file for "what is
  outstanding"
- **[docs/ratchet/ISSUES_RATCHET_V09.md](docs/ratchet/ISSUES_RATCHET_V09.md)** -
  the v0.9 code review: R22–R27, each reproduced by execution, all closed
- **[docs/ratchet/ISSUES_RATCHET.md](docs/ratchet/ISSUES_RATCHET.md)** - the
  v0 code review: 21 findings (R1–R21), each reproduced by execution, all
  closed
- **[docs/ratchet/EXPERIMENTS_RATCHET.md](docs/ratchet/EXPERIMENTS_RATCHET.md)** -
  the field experiments (margin, odds, newportfolio, particles) and the
  questions they answer

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

See **[docs/flux/DESIGN_V3.md](docs/flux/DESIGN_V3.md)** for the current proposal. The design has moved
through three forms:

- **v1** — a standalone language with `infer` as the central runtime primitive
- **v2** — three determinism tiers (`func` / `derive` / `infer`), moving inference
  to compile time wherever the specification is knowable
- **v3** — the same three tiers delivered as a TypeScript library with a
  compile-time transformer, trading syntactic enforcement for ecosystem, tooling,
  and incremental adoption

None of it is built. Everything rests on one unmeasured assumption — that writing a
specification is genuinely less work than writing the code — and docs/flux/DESIGN_V3.md
closes with the experiment that settles it. That experiment is still ungated:
[docs/flux/EXPERIMENT_LEETCODE.md](docs/flux/EXPERIMENT_LEETCODE.md) measured the ceiling and found the
"spec is less work" pitch does not survive it, which rescopes the claim to "spec
costs about the same, but is verifiable, durable, and outlives the implementation".

### The ratchet — built

The ratchet was the part worth shipping first, and it does not depend on any other
part of Flux ([docs/flux/ISSUES.md](docs/flux/ISSUES.md) item D). [ratchet/](ratchet/) is a
zero-dependency TypeScript CLI with 237 tests and a shipped adversarial fuzzer,
validated in four real repos
([docs/ratchet/EXPERIMENTS_RATCHET.md](docs/ratchet/EXPERIMENTS_RATCHET.md)) and hardened by code reviews
that reproduced every defect by execution
([docs/ratchet/ISSUES_RATCHET.md](docs/ratchet/ISSUES_RATCHET.md),
[docs/ratchet/OUTSTANDING_RATCHET.md](docs/ratchet/OUTSTANDING_RATCHET.md)).

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

It runs under itself in both forms. [`.ratchet/`](.ratchet) configures five
scripted subjects over this repository — checks of the checker, each validated
against `4abc1d5`, the last v0 commit, where the corresponding bug actually
lived — plus six prose heuristics, three of them standing invariants pinning
the test suite, the fuzzer, and the visual comparator. Replayed across its
own history:

```
✗ 4abc1d5  ratchet experiments                    0 pass, 5 fail
✗ 0d710eb  fix the seven safety defects (v0.2)    4 pass, 1 fail
✓ f4a9f84  close the remaining issues (v0.3)      5 pass, 0 fail
```

The one still failing at v0.2 is the dedup-key aliasing bug, fixed in v0.3. The
replay reconstructs the fix history without being told it.
