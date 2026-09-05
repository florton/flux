# Flux

A proposal for making AI a real abstraction layer: push inference to **compile time**
wherever the specification is knowable, and bound it where it cannot move.

## Files

- **[DESIGN_V3.md](DESIGN_V3.md)** - **Current proposal.** TypeScript library with a
  compile-time synthesis step
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
derive parseDuration(s: string) -> Seconds | Malformed

  examples
    "1h30m" => 5400
    ""      => Malformed

  rule round-trip
    given any d: Seconds where d > 0
    when  parseDuration(formatDuration(d))
    then  result == d
```

The compiler then reports what the model chose and you didn't - the constants and
comparators your specification left open - so underspecification surfaces before it
ships.

## Best for

- Document intelligence pipelines
- Data extraction from unstructured sources
- Content classification at scale
- Any high-volume workload where cost, provenance, and resumability matter

## Principles

- **Specifications, not plans** - a plan is prose that nothing verifies; a spec executes
- **The ratchet** - counterexamples, pinned bodies, and journals accumulate; nothing regresses
- **Review intent, not mechanism** - the spec diff is short and human; the body diff is generated
- **The body is the artifact** - a frozen derive never calls a model again, so deprecation costs nothing
- **Metered, not guessed** - the runtime meter is the budget guarantee; static analysis is the estimate

## Status

Design phase. See **[DESIGN_V3.md](DESIGN_V3.md)** for the current proposal.

The design has moved through three forms:

- **v1** — a standalone language with `infer` as the central runtime primitive
- **v2** — three determinism tiers (`func` / `derive` / `infer`), moving inference
  to compile time wherever the specification is knowable
- **v3** — the same three tiers delivered as a TypeScript library with a
  compile-time transformer, trading syntactic enforcement for ecosystem, tooling,
  and incremental adoption

Nothing is built yet. Everything rests on one unmeasured assumption — that writing
a specification is genuinely less work than writing the code — and DESIGN_V3.md
closes with the experiment that settles it.
