# Flux v3 — A TypeScript Library With a Compile-Time Synthesis Step

> **Status:** proposal. Supersedes [LANGUAGE_DESIGN_V2.md](LANGUAGE_DESIGN_V2.md),
> which is retained as the reference for the standalone-language form.
> v3 keeps every design decision from v2 and changes only the delivery vehicle.

---

## Thesis

An abstraction layer has to be a **function**. `compile(source) → binary` qualifies
because it is reproducible: you can pin it, diff it, and reason about the layer
below without reading it. `llm(prompt) → output` is a **distribution**, which is
why "AI is just another abstraction layer" rings false.

The move:

> **Push inference to compile time wherever the specification is knowable.
> Where it cannot move, bound it.**

Compile-time inference yields a reviewed, hash-pinned artifact. The *program* is
deterministic even though its *construction* was not — the same relationship a
compiler has to its optimizer, or Java to its garbage collector. Nobody calls
Java nondeterministic because the heap moves; the observable behavior doesn't.

The one place that analogy has a limit is the whole reason the rest of this
document exists. GC is behavior-preserving *by construction*. Synthesis is
behavior-preserving *only up to your specification*. GC earns invisibility from a
proof; `derive` has to earn it from evidence — which is what open decisions,
rules, and the counterexample corpus are for.

### What this is actually for

Not cheaper pipelines. The goal is that someone using Flux **consistently**
outperforms what a prompt engineer achieves at their best, because the model's
contribution is reviewed, pinned, and permanent rather than re-rolled every run.

The prevailing workflow is *prompt → plan → build*, and the failure is in the
middle. A plan is prose: nothing verifies it, so an error propagates silently
into the build and compounds even with a frontier model. `derive` replaces the
plan with a specification that **executes**. Examples run. Rules run. Open
decisions are enumerated. A bad spec is caught mechanically before code depends
on it.

Same three steps. The middle one stops being a guess.

### The ratchet

AI-assisted development today has no ratchet. Every session starts cold; a fix
found on Tuesday is not carried into Thursday's regeneration. You get different
code with different bugs, and hard-won understanding evaporates.

Flux is built so that **nothing ever moves backward**:

- Every counterexample ever found is written permanently into the spec corpus.
- Every synthesized body is pinned and never silently replaced.
- Every clarification is appended to a journal and fed forward.

The specification strengthens monotonically. That property, more than any single
feature, is the thing worth building.

---

## Why a library and not a language

v2 argued that whole-program cost analysis required owning the language, since
you cannot bound call counts in a Turing-complete host. That argument was too
strong, and the correction changes the recommendation.

A **builder API** gives you a static graph inside a dynamic host:

```ts
pipeline()
  .map(infer(extractInvoice))
  .pack(20, infer(classify))
  .budget({ calls: 3 * n, usd: 500 })
```

Airflow and dbt are built entirely on this. Most of the analysis survives.

| Capability | Survives as a library? |
|---|---|
| `derive` + lockfile + journal + behavioral diff | **Yes** — a codegen tool. Prisma and GraphQL Codegen are this shape |
| Open decisions | **Yes** — AST rewriting over generated TS via `ts-morph` |
| Provenance wrapper, failure classes, repair, circuits, cache, resume | **Yes** — ordinary good library design |
| Standard library | **Yes** — it is lodash |
| Cost bounds | **Yes at runtime** (metering), **best-effort statically** (builder graph) |
| Enforcement | **Weaker** — policy rather than syntax. See *Enforcement*, below |

And what the library gains is not small: `npm install` adoption, incremental use
in one function of an existing codebase, and — decisively — **LSP, debugger,
formatter, and test runner for free.** In v2's build order that tooling was the
final and most expensive step. Here it does not exist as work.

There is even an argument the generated code improves: reviewable TypeScript any
engineer on the team can read, rather than reviewable Flux only its author can.

**The language remains the right answer if enforcement is the product** — if a
buyer is paying specifically because no model call can escape the audit trail. It
is not the right answer for reaching people. The spec format designed here
becomes that language's syntax if it is ever needed; nothing is wasted.

---

## Architecture

```
my-project/
├── src/
│   ├── shipping.ts            # your code — plain TypeScript
│   └── shipping.rules         # your specs — human-readable
├── derived/
│   ├── shippingTier.ts        # generated body — committed, reviewed
│   ├── shippingTier.notes.md  # open decisions — generated
│   └── shippingTier.journal   # synthesis history — append-only
├── fixtures/
│   └── shipping.jsonl         # real-world corpus + found counterexamples
├── flux.lock                  # pins: spec hash, body hash, model, corpus
└── llms.txt                   # generated: how to review this codebase
```

Four commands:

| Command | Calls a model? | Purpose |
|---|---|---|
| `flux build` | **never** | resolve from lockfile, run the transformer, fail if synthesis needed |
| `flux derive` | yes | synthesize — explicit, local, never implicit |
| `flux verify` | **never** | run examples and rules against pinned bodies |
| `flux detach` | no | convert a derive to plain TypeScript, permanently |

`flux build` never synthesizing is the load-bearing rule. A clean checkout builds
with **zero API calls**, offline, reproducibly. This is `npm ci` versus
`npm install`, and it exists for the same reasons.

### The transformer

Synthesis and analysis hook in as a TypeScript compile-time transformer
(`ts-patch`), with `ts-morph` for AST work. This is the piece that makes the
library form nearly as strong as the language: TypeScript **does** have a build
phase you can own — the claim in v2 that it did not was wrong.

The transformer:

1. reads `.rules` files and resolves each `derive` against `flux.lock`
2. emits generated bodies into `derived/` when the lockfile already has them
3. walks the builder graph to compute static cost bounds
4. colors the call graph and flags unbounded constructs on colored paths
5. regenerates `llms.txt`

Steps 2–5 require no network. Only `flux derive` does.

---

## The three tiers

| Tier | Form | Model runs | Guarantee | Runtime cost |
|---|---|---|---|---|
| 0 | plain TypeScript | never | deterministic | free |
| 1 | `derive` | at **build**, once | deterministic after build | free |
| 2 | `infer` | at **runtime**, per record | bounded, typed, observable | metered |

The goal of any Flux program is to **push work down the tiers**. Tier 2 is the
escape hatch for genuinely unstructured input, not the centerpiece — v1's mistake
was making it the whole language, which is why it could not offer determinism.

---

## Tier 0 — plain TypeScript

Ordinary code, ordinary tooling. Two constraints, both narrow.

**No escape hatch to raw model SDKs.** This is deliberate and it raises the bar on
the standard library: an escape hatch begs the question of why this is a library
at all, while no escape hatch risks falling short of what real work demands.
Resolution: ship a **lodash-scale** standard library rather than v1's ~40
functions.

The stdlib is a **cost lever, not a convenience.** Every operation available in
Tier 0 is one nobody pays a model for. A rich stdlib directly shrinks Tier-2
usage, which puts it in the cost story rather than the ergonomics story.

**Control-flow restrictions are colored, not global.** Pure code gets everything —
closures, higher-order functions, recursion, unbounded loops. Only code that can
transitively reach an `infer` must be statically bounded.

This matters more than it sounds. A pure `.map()` callback costs zero calls no
matter how long it runs, so an infinite loop there is an ordinary bug your tests
catch, not a cost-analysis problem. **The undecidable case only bites on callbacks
that can reach a model**, which in practice is a small, heavily-scrutinized
fraction of a codebase.

---

## Tier 1 — `derive`

You write a signature and an acceptance specification. The transformer
synthesizes a Tier-0 body, verifies it, pins it by hash, and writes it to disk as
reviewable TypeScript.

### Spec syntax

Gherkin extended with one word. `a` introduces an example; **`any` introduces a
rule.** Same shape, and the quantifier is the only difference:

```
derive shippingTier(weight_g: int) -> Tier

  example  given a weight of 500 g
           when  classified
           then  the result is Standard

  rule     given any weight greater than zero
           when  classified
           then  the result is Standard or Heavy
```

Gherkin's step-definition indirection is deliberately **not** adopted — it is the
part every team that has lived with Cucumber complains about. `when` and `then`
take real expressions:

```
derive parseDuration(s: string) -> Seconds | Malformed

  examples
    "1h30m" => 5400
    "45s"   => 45
    ""      => Malformed

  examples from "fixtures/durations.jsonl"

  rule round-trip
    given any d: Seconds where d > 0
    when  parseDuration(formatDuration(d))
    then  result == d
```

Inline examples are the ones a human pinned deliberately and read as
documentation. File-sourced examples are the corpus. Both are part of `spec_hash`.

> **Open:** whether specs live in `.rules` files (better readability, reviewable
> by non-TypeScript readers, needs a small parser) or in tagged template literals
> inside `.ts` (no new file type, worse error locations). This document assumes
> `.rules`.

### Why rules and not just examples

Examples pin isolated points. Rules pin **relationships**.

A synthesized body can pass all five of your examples with a lookup table —
literally `if (s === "1h30m") return 5400; else if ...`. Every example green,
worthless on the first input you did not enumerate. The round-trip rule kills
that instantly, because it must hold for values you never listed.

Rules are what make synthesis *verified* rather than *fitted*. They are also what
makes open-decision analysis meaningful: a surviving variant only tells you
something if your rules were strong enough to have caught it.

### How rules are checked

A rule quantifies over a domain that cannot be exhaustively tested. Three
approaches exist — random sampling, bounded exhaustive enumeration, and symbolic
proof. Flux uses **random sampling, with two corrections that make it work.**

**1. Never sample uniformly.** Uniform random sampling is poor at sparse bugs: a
failure at exactly 86,400 out of a billion values is missed almost certainly.
Generators are boundary-biased, as QuickCheck and Hypothesis are — oversampling
0, ±1, min, max, powers of two, empty and single-element collections, and the
exact constants appearing in the synthesized body.

**2. Boundaries are not enough.** Boundary sampling finds the inputs a tester
would imagine and misses the ordinary case nobody specified. Generated cases and
a **real production corpus** are complementary; both run.

Every counterexample ever found is written permanently into the corpus. The spec
only strengthens.

```
rules 2/2 ✓   1,000 boundary-weighted · 340 corpus · 47 regression · seed 0x7f3a
```

The report states what was actually checked. A green check means *"survived these
cases,"* never *"proven,"* and the tooling must not imply otherwise.

Re-verification with a fresh seed is `flux verify --reseed`. It costs no model
calls, since it only runs generated code. **Scheduling it is devops' job, not the
library's** — Flux ships a command and an exit code, not a cron.

### Open decisions

The real failure mode of synthesis is not wrong logic. It is **free parameters** —
constants and comparators the model had to choose because your spec left them
open.

Given only `500 => Standard` and `5000 => Heavy`, a model writes:

```ts
export function shippingTier(weight_g: number): Tier {
  return weight_g < 1000 ? "Standard" : "Heavy"
}
```

Both examples pass. But **the model invented `1000` and it invented `<`.** In
production a 900g package is decided by a number nobody chose.

The transformer finds these mechanically: rewrite the body one small change at a
time (`<` → `<=`, `1000` → `999`, invert a condition, drop a branch), re-run
examples and rules against each variant, and report the ones that still pass.
Then narrow the range by binary search.

```
derive shippingTier — 2 open decisions
  ├ threshold   model chose 1000 · your spec permits any value in [501, 5000]
  └ comparator  model chose `<`  · your spec permits `<` or `<=`
```

Deliberately **not a coverage percentage.** It does not claim your spec is
complete; it enumerates where the model exercised discretion and the interval it
had. One example closes both:

```
    999  => Standard
    1000 => Heavy
```

*Implementation note:* this is mutation testing (Lipton 1971), the technique
behind Stryker and PIT. Fully deterministic, no model involved, and cheap —
variants run against pure Tier-0 code in milliseconds. The user-facing concept is
**open decisions**; "mutant" never appears in the API.

*What it does not do:* it finds decisions your spec leaves **open**, never ones
your spec gets **wrong**. A confidently incorrect example produces confidently
incorrect code with zero open decisions. And where enumerating behavior
approaches the complexity of implementing it, no analysis rescues the tier —
write the function. That boundary is real.

### Authoring: files, diagnostics, code actions

A workflow that exists only inside a bespoke CLI is not a serious authoring
environment. It cannot be scripted, diffed, or used from the editor where work
happens.

> **Everything is a file. The tool writes files, your editor edits files, git
> reviews files. No interactive mode does anything the files cannot.**

Open decisions surface as **ordinary editor diagnostics** on the spec, with code
actions that resolve them. Accepting a code action **writes examples into your
spec file** — a normal text edit, in your undo stack, in your diff.

This is the linter-with-autofix model, and it degrades cleanly: `flux check`
prints the same diagnostics in a terminal, `flux pin shippingTier.threshold 1000`
makes the identical edit from a script. `--watch` is a background daemon in the
`tsc --watch` category, not a menu.

Reviewing a resynthesis uses **snapshot semantics** — `flux accept` is `jest -u`.
Non-interactive, scriptable, produces a git diff.

Specification is the primary activity, and the tooling should say so. A build
runs once plus iterations; the program runs millions of times. Effort spent at
spec time is recovered on every execution, so the right thing to optimize is how
fast you converge on a spec you trust. This is most obvious where requirements
are cheap to state and expensive to get wrong — a game-design bullet takes five
seconds to write and contains a dozen decisions that determine whether it ships.

### Spec durability

If refining a spec gets wiped whenever something upstream changes, nobody invests
in specs and the tier collapses into a novelty. Four mechanisms prevent it.

**1. Spec and body are versioned separately.** `spec_hash` and `body_sha256` are
independent. A type change invalidates the body, not the spec — resynthesis runs
against your full accumulated examples and rules. Zero clarification lost.

**2. Type changes give guided migration.** *"12 of 14 examples still typecheck; 2
need updating"* — accept, edit, or drop each.

**3. A committed journal** logs every round: what was open, what you pinned, when,
and why. On resynthesis it is fed to the model as context, so the next body
inherits the reasoning rather than rediscovering it.

**4. Resynthesis produces a behavioral diff, never a silent replacement.** Old
bodies are retained as oracles:

```
derive shippingTier — resynthesis (Tier changed upstream)
  spec:     14 examples, 3 rules — all preserved, all passing
  behavior: 998/1000 sampled inputs identical to previous body
  ⚠ weight_g = 1000 · was Heavy, now Standard (open decision ①, uncovered)
```

**Resynthesis cannot silently change behavior.** A model swap or type change
surfaces as a reviewable delta.

### The body is the artifact; the model is only provenance

This answers the largest objection to putting a model in the build path: *what
happens when the model we depend on disappears?*

**Nothing.** A frozen derive never calls its model again. The pinned body is
ordinary TypeScript, committed, running deterministically. Deprecation forces no
resynthesis and no behavioral risk. The `model` field records what produced the
body; it is not a dependency.

Resynthesis happens when **you** change the spec. Never because the world moved.

---

## Tier 2 — `infer`

For input genuinely never seen before. Irreducibly probabilistic, so it gets the
only guarantees honest for a distribution: typed output, metered cost, structured
failure handling, provenance, and content-addressed caching.

### Types carry semantic constraints

```ts
const Invoice = type({
  number:   text.matches(/^INV-\d{6}$/),
  vendor:   text.len(1, 200),
  currency: text.in(ISO4217),
  total:    cents.where(v => v > 0),
  lines:    list(LineItem).len(1, 500),
}).invariant(inv => sum(inv.lines.map(l => l.amount)) === inv.total)
```

Constraints are part of the type, not separate validators. They compile into the
JSON schema and prompt, are checked on every result, and **drive repair** — the
failing constraint is the feedback the model receives.

### Failure is the diff from expected

There is no error channel. `Malformed` is an ordinary variant of a return union,
and `"" => Malformed` says the expected result for empty input *is* `Malformed`.
Failure is not a type-system concept; it is a verification one — actual did not
match expected.

Which exposes the axis that actually predicts the right remedy: **repair is only
possible when there is a diff to feed back.**

| Class | Diff exists? | Remedy |
|---|---|---|
| `mismatch` | yes — got a value, it violates the type | **repair** — feed the specific failure back |
| `transport` | no — nothing came back (429, 500, timeout) | **retry** with backoff and jitter |
| `refusal` | no — the model declined | **none** — retrying loops forever and never succeeds |

Three classes split by remedy, not four arbitrary categories. `repair` is not
`retry`: a model that omitted a field is far likelier to supply it when told which
field failed and why than when handed the identical prompt again.

### Four outcome buckets, summing to 100%

Binary quarantine throws away usable data. Every record lands in exactly one
bucket, and the run reports the distribution:

| Bucket | Destination |
|---|---|
| **correct** | flows to the end of the pipeline |
| **partial** | flows to the user, **flagged with its conformance score** |
| **failed** | written to a log, reported as a rate |
| **refused** | no data at all, reported as a rate |

The conformance score falls out of machinery already present. An `Invoice` has six
field constraints plus two invariants — eight checks. Six pass, and the record is
75% conformant.

```ts
infer(extract, {
  acceptAbove: 0.90,   // → correct
  flagAbove:   0.60,   // → partial, flagged
                       // → failed
})
```

Partially correct data reaches the user **with the caveat attached**, never
silently dropped and never silently passed off as clean. The four rates summing
to 100% is the invariant that makes the report trustworthy.

### Provenance is in the type

```ts
const r = await extract(doc)   // Inferred<Invoice>

r.value          // Invoice — must be unwrapped explicitly
r.meta.model     // "claude-sonnet-5"
r.meta.attempts  // 2
r.meta.repairs   // 1
r.meta.conformance // 0.75
r.meta.costUsd   // 0.0041
r.meta.cached    // false
```

`Inferred<T>` is distinct from `T`. Unwrapping is explicit, which makes "a model
produced this" visible at every use site and impossible to discard by accident.

### Model profiles, pinned

Named tiers rather than model ids in code — but bound in a **versioned lockfile,
not the environment.** Env vars are not reviewed or committed, so two machines
silently produce different programs, which is the exact failure this design
exists to eliminate.

```toml
[model.extract]
id = "claude-sonnet-5"
[model.extract.fallback]
id = "claude-opus-5"
```

`temperature` defaults to 0 everywhere and is a declared field.

### Concurrency, circuits, batching

Circuits are **rate-over-window**, not consecutive-failure streaks — a rate is
well-defined under concurrency, a streak is not. Scope is the model profile, so
call sites sharing an endpoint share the breaker.

Three distinct batching mechanisms, not one conflated knob:

```ts
.map(infer(extract))            // 1 call per item, bounded concurrency
.pack(20, infer(classify))      // 20 items per prompt
.submit(infer(extract))         // provider batch API: async, ~50% cost
```

`pack` gives every item a **correlation id** and matches results by id, **never
positionally.** Unmatched or duplicated ids are quarantined individually rather
than failing the batch — a pack returning 19 results for 20 inputs loses exactly
one record, identifiably. At scale this happens constantly and v1 left it
undefined.

### Caching, checkpointing, resume

Every result is content-addressed on
`(input, prompt, schema, model id, temperature, library version)`.

- Re-running over overlapping input is a cache hit — no model call.
- `checkpoint({ every: 1000 })` persists cursor, cache, and circuit state.
- `--resume` restarts where it stopped.
- **A cached replay is fully deterministic**, so one bad record can be debugged
  without re-inferring the run.

---

## Cost: metered guarantee, analyzed estimate

The budget does not need static analysis to be enforced. Ethereum's gas model
settles this: you do not prove termination, you **meter execution and halt when
the budget is exhausted.** Undecidability becomes irrelevant because the proof was
never required.

| Layer | Strength |
|---|---|
| **Runtime meter** | **guarantee** — hard stop, cannot be exceeded |
| **Static estimate** | sound where it applies; reports `unbounded` where it does not |
| **Model-estimated complexity** | heuristic — informs the *expected* column only |

```
worst case   405,000 calls  $1,936   ← structural, from the builder graph
expected     118,000 calls  $  487   ← observed repair rates + model estimate
metered      hard stop at 300,000 calls / $500
```

Structure gives the guarantee; the model gives the useful number. A
model-estimated complexity can never back a hard failure — you would be failing
builds on a guess.

Where static analysis cannot bound a colored callback, it says so rather than
guessing. Precedent for refusing what you cannot bound: the eBPF verifier rejects
programs it cannot prove terminate; Coq, Agda and Idris ship structural recursion
checkers; DO-178B effectively mandates bounded loops. Sound and incomplete beats
complete and wrong.

---

## Enforcement

The honest gap between the library and the language. In a language, bypassing the
guarantees is **unrepresentable**. In a library, it is **detectable and blocked by
policy** — which is how essentially every real architectural constraint works. No
type system stops you writing raw SQL beside your ORM; lint rules and review do.

| Layer | Strength |
|---|---|
| Runtime meter | guarantee — cannot be bypassed |
| `fetch` interception | rejects model calls not originating in the framework |
| Network egress policy | only the framework's proxy reaches model APIs |
| Lint + package allowlist | CI fails on raw SDK imports |
| AI review + `llms.txt` | catches idiom and style — **no guarantee** |

The last row is a mitigation, never the answer to "what enforces the budget."
Stack them and the practical gap to the language is small — egress policy is
arguably *stronger* than anything a compiler could do, since it survives someone
shelling out to curl.

### `llms.txt`

Generated from library source so it cannot drift: the builder API surface, which
constructs are bounded, the four-bucket model, common mistakes. Reviewers — human
or model — have not seen this syntax before, and pointing them at a current
description is cheap.

---

## Workflow decisions

Tier 1 puts a model in the build path. These determine adoption more than any
syntax choice, and several are irreversible once shipped. **⛔** marks where
getting it wrong ends the use case.

| Decision | Personal | Enterprise | Verdict |
|---|---|---|---|
| Commit generated bodies? | diff noise | audit requirement | **always commit** ⛔ |
| Can `flux build` synthesize? | convenient | unacceptable | **never implicitly** ⛔ |
| Where does the spec go? | don't care | may not leave the network | **pluggable, inspectable** ⛔ |
| Two devs, same spec | mild churn | constant conflicts | **lockfile wins** ⛔ |
| Model deprecated | resynthesize | 400 pinned derives | **body is the artifact** ⛔ |
| Hand-edit a body? | tempting | breaks the audit trail | **explicit detach** |
| PR review focus | skim it | rubber-stamp risk | **spec diff foregrounded** |
| Who pays for synthesis? | your key | needs a budget | **build-time budget** |

**Generated bodies are always committed.** `.gitignore`-ing `derived/` kills the
entire pitch — no artifact to review, no audit trail, no answer to *what code ran
in production*. Friction is paid down instead: stable formatting, deterministic
ordering, and `.gitattributes` marking `derived/**` as `linguist-generated` so it
collapses by default in review. Committed but quiet.

**The lockfile decides, so bodies don't thrash.** Synthesis is nondeterministic;
two engineers on one spec would produce two valid bodies and churn every branch.
A body is produced only when **no valid body exists for that `spec_hash`.** First
synthesis wins. Examples are canonically ordered before hashing, so reformatting
does not invalidate a body. The journal is append-only and merges cleanly.

**Detachment is explicit and permanent.** A body whose hash no longer matches
fails the build until you revert or run `flux detach`, which converts it to normal
source and records the detachment. No half-states.

**Publishing is the publisher's choice.** A derive is like source code — some will
share it, some will keep it proprietary. Share the derive (spec, body, journal)
and consumers can *run your contract*, which is machine-checkable documentation no
README offers. Or `flux detach` before packaging and ship a plain function. Same
tool, two intents.

**Review intent, not mechanism.** A 200-line generated body gets an LGTM;
assuming otherwise is this design's naive failure mode. Tooling foregrounds the
**spec diff** (short, human-written, intent) and collapses the **body diff**
(long, generated, mechanism). What gates the merge is the open-decisions delta and
the behavioral diff. *You review the intent; the transformer verifies the
mechanism matches.*

---

## Open questions

1. **Spec file format** — `.rules` files versus tagged template literals in `.ts`.
   This document assumes the former.
2. **Does a detached body record that it was synthesized?** Publishers keeping
   specs proprietary may not want the marker; regulated consumers may require it.
3. **Generators for user types.** Rules are only as good as the values fed them.
   Constrained generation for `matches(/regex/)` and cross-field invariants is the
   hard case.
4. **The compiler's own host language.** TypeScript for cohesion, or Rust for the
   AST-heavy analysis work. Independent of the emit target.
5. **Additional backends.** TypeScript is the target; keep a clean backend seam so
   Python or R stay possible without a rewrite. Cheap now, expensive to retrofit.
6. **Synthesis is bounded by spec tightness.** Open-decision analysis finds what a
   spec leaves *unconstrained*, never what it gets *wrong*. There is no mechanical
   answer — only review of the generated body. This is the central risk.
7. **Tier 1 may not carry its weight.** If `derive` pays off only for a narrow band
   of problems, v3 reduces to a good pipeline library. Untested.

---

## The viability experiment

Everything above rests on one unmeasured assumption: **that writing a spec is
genuinely less work than writing the code.** For `parseDuration`, five examples
and two rules beat a real duration parser easily. There is also a category where
pinning behavior takes more effort than implementing it — and nobody knows which
category most real functions fall into.

This is testable without building anything:

1. Take 20 real utility functions from an existing codebase.
2. For each, write only the spec — without looking at the implementation.
3. Synthesize.
4. Check against the real implementation and its existing tests.
5. Score two things: did it pass, and was the spec meaningfully shorter?

- **≥12/20** → Tier 1 is real; the architecture above is worth building.
- **~5/20** → `derive` is a useful tool, not a tier. Ship the Tier-2 runtime alone.
- **≤3/20** → the thesis is wrong, and it cost an afternoon to find out.

Every other question in this document is downstream of that number.
