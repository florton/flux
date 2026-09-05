# Flux v3 — A TypeScript Library With a Compile-Time Synthesis Step

> **Status:** proposal. This document is the current design in full; nothing here
> depends on reading an earlier one. [LANGUAGE_DESIGN_V2.md](LANGUAGE_DESIGN_V2.md)
> is retained as the reference for the standalone-language form.

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

Whole-program cost analysis does not require owning the language. A **builder API**
gives you a static graph inside a dynamic host:

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

### Why TypeScript

**Decided: TypeScript, both tiers.** One question settles it, and it is neither
audience nor terseness: **does the host have a build phase you can own?** TypeScript does, and `ts-patch` is the
hook. Python does not — you would need an import hook or an out-of-band codegen
step, which is the bespoke tool this design rejects everywhere else.

The tiers split cleanly on that question:

| Tier | Portable to Python? |
|---|---|
| 2 — `infer` | **yes, easily.** It is an ordinary runtime library. pydantic is already `type({...})`, Hypothesis is already fast-check |
| 1 — `derive` | **not without a build phase**, and the build phase *is* the determinism claim |

**On verbosity.** The objection is that TypeScript is already a heavy way to write
anything, so putting another layer over it is self-defeating. But Flux does not add
a layer above TypeScript. It **removes a function body** and puts a specification in
its place. The TypeScript you write is strictly less than you would have written,
not more — and the part that disappears is the part with the bugs in it.

Where the complaint is fair is Tier 2: type declarations and hand-written
arbitraries are genuinely verbose. Both shrink for the same reason — **deriving an
arbitrary from a declared type is already listed below as work that is ours**, and a
declared type that infers its TypeScript type is written once instead of twice. If
that does not land, the objection stands and is unaddressed.

Python is therefore not a target. Keeping the backend seam clean stays worth the
small cost of not hard-coding emit assumptions, but nothing in this document is
designed around a second backend arriving, and shipping Tier 2 separately in Python
is explicitly not the plan.

---

## Architecture

```
my-project/
├── src/
│   ├── shipping.ts            # your code — plain TypeScript
│   ├── shipping.rules         # your spec — prose, human-owned
│   └── shipping.test.ts       # your tests, including executable rules
├── fixtures/
│   └── shipping.jsonl         # real corpus + every counterexample ever found
├── derived/
│   ├── shippingTier.ts        # generated body — committed, reviewed
│   └── shippingTier.journal   # synthesis history — append-only
├── flux.lock                  # pins: spec hash, body hash, model, corpus
└── llms.txt                   # generated: how to review this codebase
```

**Three things you author, and one of them is a file you already have.** File types
are a tax paid by every reader of the repo, so the count is held down deliberately:

| You author | Generated |
|---|---|
| `.ts` — code, tests, executable rules, generators | `derived/*.ts` — one body per derive |
| `.rules` — the prose spec | `derived/*.journal` — append-only history |
| `fixtures/*.jsonl` — corpus rows | `flux.lock`, `llms.txt` |

There is **no `.rules.ts` file type**. An executable rule is a `rule()` call the
transformer finds wherever you already keep tests, and a generator is an
`Arbitrary<T>` exported from anywhere. Nothing is gained by giving either its own
extension, and a project with six naming conventions is a project nobody adopts
incrementally.

The open-decisions report is likewise **output of `flux check`, not a committed
file.** It is derivable from the spec and the body, and a derivable file checked
into a repo is a file that goes stale.

### Direction of flow

The spec is the source. The TypeScript is the artifact.

```
  src/*.rules          authored by humans          INPUT
  src/*.test.ts        executable rules            INPUT
        |
        |  flux derive        model runs, once, at build time
        v
  derived/*.ts         synthesized body            OUTPUT
                       reviewed, hash-pinned, committed
        |
        |  flux build         no model, ever
        |  flux verify        no model, ever
        v
      runtime          the pinned body runs        OUTPUT
```

Nothing reads a spec at runtime. Nothing calls a model after `flux derive`. The
`.rules` file is never generated — it is the thing a human writes and keeps
editing, and it is what the ratchet accumulates into.

**The opposite direction is a different tool.** Reading existing TypeScript and
proposing a spec for it is *extraction*, and it is genuinely useful — it is how you
adopt Flux in a codebase that already exists, and it is step 2 of the viability
experiment run backwards. But it is a migration aid, not the pipeline. A spec
extracted from code inherits whatever that code already gets wrong, so it must be
reviewed as a proposal rather than trusted as a specification.

`flux detach` is the one place the arrow terminates: a derived body becomes ordinary
TypeScript, permanently, and the spec stops governing it.

### Who writes the TypeScript

**You do, almost all of it.** Exactly one directory is generated:

| Path | Author | Notes |
|---|---|---|
| `src/*.ts` | **you** | Tier 0 — logic, control flow, glue, I/O, tests, executable rules, generators. The bulk of any real program. Never generated, never seen by a model. |
| `src/*.rules` | **you** | the spec |
| `fixtures/*.jsonl` | **you, then the ratchet** | rows you supply, plus every counterexample ever found |
| `derived/*` | **generated** | one body per `derive`, reviewed and committed |

**`derive` is opt-in, per function.** A project with zero derives is a TypeScript
project using a pipeline library, and that is a legitimate way to use this. You
reach for a derive where writing the spec is genuinely less work than writing the
code — a judgment made function by function, and the thing the viability experiment
is trying to measure.

This ratio is not incidental, it is load-bearing. **The review story only works if
generated code is a small, concentrated minority of the codebase.** Nobody reviews
50,000 lines of synthesized TypeScript, and "you can inspect the exact logic before
it ships" — the entire enterprise argument — is false the moment synthesis is the
default rather than the exception.

And nothing is one-way except by choice: `flux detach` converts any derived body
into ordinary TypeScript you own outright. Editing a pinned body without detaching
fails the build rather than silently drifting, so taking ownership is deliberate,
but it is always available.

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
(`ts-patch`), with `ts-morph` for AST work. TypeScript has a build phase you can own, and owning it is what makes the library
form nearly as strong as the language.

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

The goal of any Flux program is to **push work down the tiers**. Tier 2 is for
genuinely unstructured input, not the centerpiece. A design in which everything is
Tier 2 has no determinism to offer at all.

---

## Tier 0 — plain TypeScript

Ordinary code, ordinary tooling. Two constraints, both narrow.

**No escape hatch to raw model SDKs.** This is deliberate and it raises the bar on
the standard library: an escape hatch begs the question of why this is a library
at all, while no escape hatch risks falling short of what real work demands.
Resolution: ship a **lodash-scale** standard library, not the few dozen functions
a minimal one would carry.

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
rule.** Same Given/When/Then shape, and the quantifier is the only difference.

Gherkin's step-definition indirection is deliberately **not** adopted — it is the
part every team that has lived with Cucumber complains about. There is no glue
file: the vocabulary is fixed by the language, and the header binds the nouns and
verbs that clauses may use.

Inline examples are the ones a human pinned deliberately and read as
documentation. File-sourced examples are the corpus. Both feed `spec_hash`.

> **Why a separate file type.** A `.rules` file costs a small
> parser and slightly worse error locations than tagged template literals inside
> `.ts` would give, and buys the thing that matters more: **a domain expert who
> does not write TypeScript owns the spec end to end.** That is not a nicety. The
> spec is what the ratchet accumulates into, and if only programmers can touch it,
> it decays into a second copy of the code.

### TypeScript is the foundation; `.rules` is a layer on top

TypeScript is not an escape hatch from the spec. It is the substrate. Everything
that executes is TypeScript — Tier 0 code, synthesized bodies, generators,
executable rules — and `.rules` earns a file type of its own by adding exactly one
thing on top: **a form of specification a domain expert can own end to end.**

A rule therefore has two forms, and neither is a fallback from the other:

| Form | Lives in | Author | Why it exists |
|---|---|---|---|
| **executable rule** | any `.ts` | programmers | arbitrary computation, no vocabulary needed. The base case |
| **prose rule** | `.rules` | anyone who knows the domain | the spec must not be programmer-only, or it decays into a second copy of the code |

An executable rule is a fast-check property, discovered and hashed by the
transformer exactly like a prose clause:

```ts
import { rule } from "flux"
import * as fc from "fast-check"
import { parseDuration, formatDuration } from "./duration"

rule("round-trip", fc.integer({ min: 1 }), (d) =>
  parseDuration(formatDuration(d)) === d
)
```

It contributes to `spec_hash`, appears in the same verification report, and its
counterexamples enter the same corpus.

**`.rules` holds prose only** — there is no expression register in it. An expression
parser there would mean precedence, calls and type annotations, which is a small
TypeScript with worse error spans than `tsc`, no go-to-definition, no rename and no
typechecking, bought in exchange for co-location.

### The prose form

Closed vocabulary, no parentheses, no operators. A non-programmer writes and reviews
this:

```
derive shippingTier
  takes  weight   a whole number of grams
  gives  tier     one of: Standard, Heavy, Freight

  example  given a weight of 500
           when  classified
           then  the tier is Standard

  example  given a weight of 5000
           when  classified
           then  the tier is Heavy

  rule     given any weight of 1 or more
           when  classified
           then  the tier is one of Standard, Heavy, Freight

  rule     given any weight above 5000
           when  classified
           then  the tier is not Standard

  rule     given any two weights where the first is lighter than the second
           when  both are classified
           then  the first tier is not heavier than the second
```

The header is what makes the prose parseable. `takes` and `gives` bind the names
`weight` and `tier`, so "the tier is Standard" resolves without ambiguity, and
declaration order in `one of:` defines the ordering that "heavier than" uses. A
programmer writes the header once; everything below it is open to anyone.

That last rule is monotonicity, stated in English. Prose is not restricted to
example-shaped statements — relational rules are the reason it earns its place.

**The closed vocabulary.** Fixed by the language, not per project:

| Phrase | Means |
|---|---|
| `is X` / `is not X` | equality, inequality |
| `is one of X, Y, Z` | membership |
| `is above N` / `is below N` | strict comparison |
| `is at least N` / `is at most N` | inclusive comparison |
| `is between N and M` | inclusive range |
| `contains X` | substring or element |
| `starts with X` / `ends with X` | string prefix, suffix |
| `is empty` / `is missing` | emptiness, absence |
| `looks like <format>` | a named format declared in the header |
| `is the same as <name>` | round-trip and relational equality |

Quantifiers: `a` for an example, `any` for a rule, `any two ... where ...` for a
relational rule. Clause keywords: `example`, `rule`, and `note`.

### You do not have to know the vocabulary to write a rule

The table above constrains what the **verifier accepts**, not what you **type**.
Those are different problems, and conflating them would hand the spec file back to
programmers by another route — anyone who has to remember that it is `is above` and
not `is greater than` is reading a manual, and a domain expert reading a manual is a
domain expert who stops contributing.

So **authoring is loose and storage is canonical**, exactly the way a code formatter
works:

1. Write the rule however it comes out. *"heavier than 5 kg should never come back
   as Standard."*
2. `flux fmt` snaps it to canonical form. Most of this is deterministic — a synonym
   table, unit normalization, fuzzy match against the vocabulary and the names the
   header bound.
3. What the table cannot resolve is offered as a **suggested rewrite** in the editor,
   accepted or rejected as an ordinary code action. That suggestion may come from a
   model. It is author-time only: `flux build` and `flux verify` still never call one.
4. What genuinely cannot be said in the vocabulary stays a `note`, and is counted as
   one.

The file on disk always holds canonical clauses, so `spec_hash`, the verifier, the
diff and the review are unchanged. What changes is that contributing a rule no
longer requires memorizing a table.

**The rule that keeps this honest: a rewrite is never applied silently.** A model
guessing "you probably meant `is above 5000`" and guessing wrong is the same class of
failure as a model in the oracle — it quietly changes what the spec says — unless a
human reads the diff. Suggested, shown, accepted. Never inferred at build time.

**What `.rules` contains, precisely:** prose clauses, and literal example tables.
Literals are not expressions — no operators, no calls, no precedence — so the
tabular form survives without reintroducing a parser:

```
derive parseDuration
  takes  text      a duration written like "1h30m"
  gives  seconds   a whole number of seconds, or Malformed
  uses   formatDuration  as "formatted"

  examples
    "1h30m" => 5400
    "45s"   => 45
    ""      => Malformed

  examples from "fixtures/durations.jsonl"

  rule  given any seconds above zero
        when  formatted and then parsed
        then  the result is the same as the original
```

That last clause is the round-trip rule, in prose. It works because `uses` binds a
verb to an existing function, and `when` composes declared operations. **Relational
rules are not the boundary between the two forms** — the boundary is arbitrary
computation in `then`, which is rarer than it first appears.

### Where the line actually falls

| Expressible in prose | Needs a property test |
|---|---|
| examples, including tabular and file-sourced | arbitrary computation in `then` |
| single- and multi-field conditions | rules over types with no declared vocabulary |
| relational rules over declared operations (round-trip, monotonicity, idempotence) | rules quantifying over functions rather than values |

Prose covers most of what constrains synthesis, which is the point — the strongest
class of rule must not be a programmer-only privilege, or the domain expert is left
writing examples while someone else writes the constraints that actually matter.

**The failure mode to watch:** if executable rules are too comfortable, programmers
skip prose, `.rules` becomes a file only non-programmers touch, and it rots. The
counter-pressure is a **lint warning, escalatable to an error in config** — a
derive carrying property tests and no prose rules warns by default, and a team that
cares sets it to error in CI. Enforcement is a team decision, not a language one.
Both sources also appear in one report under one naming scheme, so neither is easier
to ignore than the other.

#### Neither source has precedence over the other

Prose rules and executable rules are **both inputs**. Neither is generated from the
other, and there is no precedence order between them, because precedence would mean
silently discarding a constraint someone wrote — which is the rot failure above,
mechanised.

Two situations get confused with each other here:

**Contradiction is unsatisfiability, not a conflict to resolve.** If a prose rule
and a property test cannot both hold, no body satisfies the spec, and synthesis
fails naming both clauses and their file positions. This surfaces at `flux derive`,
not at runtime — the contradiction is caught before a body exists, which is one of
the better properties of pinning behavior before generating it.

**A rule can be useless without contradicting anything**, and that is the case worth
reporting. Two kinds:

| Kind | Meaning | Detected by |
|---|---|---|
| vacuous | its `given` matched no generated or corpus value | sampling instrumentation |
| dead | it passes against deliberately perturbed bodies | the open-decisions pass |

Both are reported. A rule nobody can fail is a rule nobody should trust, and the
machinery to find them already exists for another purpose.

### Prose does not exist outside `.rules`

Tier 0 code is plain TypeScript. The synthesized body in `derived/` is plain
TypeScript. Fixtures are data. Generators are `Arbitrary<T>`. Property rules are
fast-check. **No prose appears in any executable artifact**, and prose is not
permitted to grow into a programming language — the moment a spec needs control
flow it is a property test, or it is not a spec. When a derive is detached, nothing
prose-shaped travels with it: the body was always TypeScript.

### Checked clauses and notes

Extended Gherkin is the preferred form, and **free plaintext is allowed** — but the
distinction between them must be impossible to miss, because it is not cosmetic.

A clause that parses against the vocabulary compiles to an executable predicate. It
runs at `flux verify` with zero model calls, produces counterexamples, and feeds the
ratchet. Free plaintext cannot do any of that. A model reads it at synthesis time
and it genuinely influences the body — but it **never executes, never fails, and
never enters the corpus.**

That is the dangerous part. An unverifiable clause sitting in the same file, in the
same shape, as a verified one is the green-check-that-means-nothing problem moved up
into the spec. So plaintext is a different keyword:

```
  rule  given any weight above 5000
        when  classified
        then  the tier is not Standard

  note  freight carriers in the EU treat pallets differently below 30 kg;
        prefer the conservative classification when the origin is ambiguous
```

`note` is guidance to the synthesizer. `rule` is a constraint on the body. The
report never conflates them:

```
rules 4/4 ✓   notes 2 (unverified, synthesis guidance only)
```

Notes are part of `spec_hash` — changing one changes the body it produced — and
they are **excluded from every rule count.** An LSP code action offers to promote a
note to a checked rule when the vocabulary can express it, which is the ratchet
applied to the spec file itself.

**Who the vocabulary is for.** The **verifier**, not the model — a model would
happily read anything. And the model reads the spec at `derive` time, never at
execution: at runtime nothing reads it, the pinned body runs, and that is the whole
determinism claim.

### Parsing guarantees

Three properties, which together make a silent misparse impossible:

1. **`note` is explicit.** A clause written as `rule` that fails to parse is a hard
   error with a suggestion and a code action, never silently demoted to a note.
2. **No expressions are admissible**, so there is nothing expression-shaped to
   misread.
3. **`flux fmt` canonicalizes before hashing**, so alignment and whitespace cannot
   move `spec_hash`.

**Division of labor:**

| Who | Writes | Cannot |
|---|---|---|
| Programmer | the header (`takes` / `gives` / `uses`), named formats, property tests, generators | — |
| Domain expert | examples, prose rules including relational ones, fixture rows | invent predicates, name types, bind verbs |

The honest limit: a non-programmer can say a great deal but cannot invent
vocabulary. That is Gherkin's trade minus the step-definition file — the vocabulary
is fixed by the language, so there is no per-project glue layer to maintain and no
indirection to chase.

### Why rules and not just examples

Examples pin isolated points. Rules pin **relationships**.

A synthesized body can pass all five of your examples with a lookup table —
literally `if (s === "1h30m") return 5400; else if ...`. Every example green,
worthless on the first input you did not enumerate. The round-trip rule kills
that instantly, because it must hold for values you never listed.

Rules are what make synthesis *verified* rather than *fitted*. They are also what
makes open-decision analysis meaningful: a surviving variant only tells you
something if your rules were strong enough to have caught it.

**Rules are not mandatory.** A derive with examples and no rules warns; it does not
fail. Forcing a rule produces rules written to satisfy the compiler, and a spec
gamed to pass is worth less than an honest one that admits it is thin. The
open-decisions report already exposes exactly what an examples-only spec left free,
which is the visibility that matters — the warning points at that report rather
than blocking the build.

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

### Generating values for rules

A rule says *"for any X."* Something has to produce the X.

**Flux does not build a generator framework.** Property-based generation is solved
work — fast-check has boundary-biased arbitraries, composition, seeded replay, and
shrinking; Hypothesis's `@composite` is the construct strategy already shipped. A
user-written generator is an `Arbitrary<T>`, not a Flux DSL: nothing new to learn,
existing skills transfer, and none of it is ours to maintain.

Four things are genuinely ours, and none of them are generation:

1. **Deriving an arbitrary from a declared type**, where that is mechanical.
2. **Owning the corpus and the ratchet** — permanent counterexamples, fixtures as a
   sampling source, the journal. No framework does this.
3. **Detecting the tautology trap.** No framework does this either.
4. **Deciding, mechanically, when the user must supply values.**

#### Who supplies values: a decidable triage

The split is not a policy or a judgment call. It is a property of the type, visible
to the compiler:

| Constraint shape | Who supplies | Why |
|---|---|---|
| primitives, enums, unions | **auto** | boundary catalogue applies directly |
| single-field refinement (`int where x > 0`) | **auto** | bound is decidable from one field |
| arrays, options, records of the above | **auto** | composes |
| regex-matched string | **auto, weakened** | automaton walk; caveat below |
| **any cross-field invariant** | **user** | not derivable from field declarations |

A constraint that mentions more than one field is syntactically visible. So the last
row is a **compile error with a precise trigger**, not a warning nobody reads:

```
error: rules over Booking need a value source
       Booking has a cross-field invariant:
         nights == daysBetween(checkIn, checkOut)      booking.rules:14
       supply either:
         fixtures/booking.jsonl       (>= 50 rows)  -- preferred
         an exported Arbitrary<Booking>              (any .ts file)
```

#### The ladder is a ratio, not a choice

Fixtures and constructors are not alternatives. **They are a blend whose weighting
shifts with corpus size**, because the honest answer changes over a project's life:

| Corpus | Sampling budget | Why |
|---|---|---|
| zero rows (greenfield) | 100% constructor | a new project has no data by definition |
| thin | mostly constructor | real rows are clustered; they cover the common case and nothing else |
| dense | mostly fixtures | reality satisfies every invariant and carries no tautology risk |

A constructor is therefore required the first time a cross-field invariant appears,
and progressively demoted rather than deleted. **The verification report always
prints the actual mix**, because "which values ran" must never be a thing the user
has to infer:

```
rules 3/3 ✓   420 constructed · 1,180 corpus · 47 regression · seed 0x7f3a
```

**Fixtures are still preferred where they exist**, for two reasons that do not
weaken: reality satisfies invariants by construction, and it carries no tautology
risk because reality wrote it. The weighting exists because "prefer fixtures" is
unimplementable advice for a project that has none.

**When is a corpus dense enough?** Not a constant, and not a guess. It scales with
field count and body branchiness — three fields and two branches may need 50 rows;
twelve fields with a four-field invariant may need thousands before every branch is
exercised once. It is measurable directly: run the open-decisions pass with the
corpus alone. If perturbed variants survive that the constructor would have killed,
the corpus is too thin, and that is a number printed per function rather than a
rule of thumb.

Filtering remains available and is almost never right: it collapses when the
invariant admits one tuple in a million, and frameworks then report *"could not
generate enough values,"* which a tired human reads as a pass. **Failing to meet the
sample count fails the run.**

#### The tautology trap is detectable, not merely avoidable

If a constructor computes `nights` with the same formula the synthesized body uses,
no rule over `Booking` can ever catch a bug in that formula. Test and code agree
because they share the mistake.

Three defenses, and the third is the one that matters:

1. **A constructor that calls the function under test is a compile error.** Static
   call-graph check — cheap and sound.
2. **A synthesized constructor is a separate `derive`** with its own examples, and
   the lockfile records both model ids.
3. **The open-decisions pass already detects it.** Perturb the pinned body — flip a
   constant, swap a comparator — and re-run the rules. If a rule ranging over
   `Booking` *still passes* against a deliberately broken body, that rule is testing
   nothing, and a shared formula is the most likely reason. The machinery that finds
   free parameters finds dead rules with no additional apparatus.

That converts *"we hope you did not write a tautology"* into a report naming which
rules are load-bearing and which are decorative.

#### Shrinking: shrink the preimage, not the value

When a rule fails at `weight = 8347`, the counterexample worth keeping is `5001`.

The mathematics is clean once a constructor is written in terms of free parameters:
**never shrink the constructed value — shrink its preimage and re-run the
constructor.** Shrink `(checkIn, nights)`, both primitives, both trivially
shrinkable, and every intermediate candidate satisfies the invariant *because it was
constructed*. This is the second reason to prefer construction over filtering, and
it is why the ladder is ordered as it is.

The honest residue: preimage shrinking gives *useful* results only when the constructor is roughly continuous in its parameters.
A constructor that hashes its input yields shrinks that are valid but not smaller.
That degrades to "no shrink" — unhelpful, never unsound.

**Where a model may and may not participate.** A model must never judge whether a
counterexample is correct. That is the oracle, and a model in the oracle destroys
the determinism the entire thesis rests on. A model may **nominate**: propose a
smaller candidate, which the deterministic runner re-executes. Still fails, keep it;
passes, discard it. The model never decides, it only suggests, and every suggestion
is checked by running code. This is the same division as `derive` itself — **the
model proposes, deterministic machinery disposes** — and it is the only shape in
which a model call is admissible anywhere in the verification path.

#### The caveat that survives all of this

Regex generation produces **valid** values, and most bugs live at the edge of
validity. There is no "boundary" of a regex the way there is a boundary of an
integer range, so you get `a@b.cd` a thousand different ways and never a leading
space, a 10 KB local part, a homoglyph, or a trailing dot. Lookaheads and
backreferences are not regular at all and fall back to filtering. For
format-constrained types the fixture corpus does more of the work than the generator
does — the same conclusion the ladder reaches from the other direction.

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

#### Two derives, one decision

One file per derive is the **unit of pinning**: a body is hashed, reviewed,
resynthesized and detached as a whole, and a derive split across files leaves
nothing coherent to pin. That granularity is not negotiable, but its cost is real
and it is not the one usually named.

The cost is not that a derive cannot be large enough. It is that **two derives
depending on the same quantity will each invent it, and they will not agree.**
`shippingTier` picks 1000 g, `shippingCost` picks 1100 g, both pass all their own
examples, both report zero open decisions, and the inconsistency reaches production
without ever failing a rule. Neither body is wrong on its own terms. The system is
wrong.

So shared quantities are **named in the spec and pinned once**:

```
domain shipping
  value heavyThreshold   a whole number of grams

derive shippingTier
  takes weight   a whole number of grams
  gives tier     one of: Standard, Heavy, Freight
  uses  heavyThreshold
  ...

derive shippingCost
  takes weight   a whole number of grams
  gives cost     an amount in cents
  uses  heavyThreshold
  ...
```

`heavyThreshold` becomes **one open decision reported once**, and the interval it
reports is the *intersection* of what every derive using it permits — which is
strictly more informative than either derive alone, because a constraint stated in
one spec now narrows the other. Pinning it is a single edit that invalidates every
body reading it.

The general rule follows: **anything two derives both need is hoisted — into a named
value, a Tier-0 function, or its own derive — and never synthesized twice.** A
helper duplicated across two derived files is a lint error, because two copies of a
formula are two formulas, and only one of them will get fixed.

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

## Rejected alternatives

Kept short deliberately: each of these was considered and closed, and the reasoning
lives in the section named beside it. They are listed so a reader does not have to
rediscover them, not to narrate how the design got here.

| Rejected | Instead | Where |
|---|---|---|
| an expression register inside `.rules` | executable rules in `.ts` | *TypeScript is the foundation* |
| Gherkin step definitions | vocabulary fixed by the language | *Spec syntax* |
| an escape hatch to raw model SDKs | lodash-scale stdlib as a cost lever | *Tier 0* |
| `.gitignore`-ing `derived/` | always commit, mark `linguist-generated` | *Workflow decisions* |
| model ids in environment variables | versioned lockfile | *Model profiles, pinned* |
| consecutive-failure circuit breakers | rate-over-window | *Concurrency, circuits, batching* |
| positional matching of packed results | correlation ids, individual quarantine | *Concurrency, circuits, batching* |
| a spec-coverage percentage | open decisions with intervals | *Open decisions* |
| an interactive CLI workbench | files, diagnostics, code actions | *Authoring* |
| scheduled re-verification in the library | a command and an exit code | *How rules are checked* |
| a model deciding whether a counterexample is valid | a model nominating, code adjudicating | *Shrinking* |

---

## Open questions

1. **Prose coverage, and note drift.** How often does a real spec fall out of the
   vocabulary? Rarely means the design works. The sharper risk is notes: they are
   the path of least resistance, they influence the body, and they verify nothing.
   A project whose `.rules` files are mostly notes has a spec that reads well and
   checks nothing, and the report is the only thing standing against it.
2. **Does a detached body record that it was synthesized?** Publishers keeping
   specs proprietary may not want the marker; regulated consumers may require it.
3. **Corpus density thresholds.** The blend is measurable per function, but the
   demotion curve is not yet specified: at what measured density does constructor
   weight actually drop, and does a stale constructor left at low weight rot
   unnoticed because almost nothing runs it?
4. **The compiler's own host language.** TypeScript for cohesion, or Rust for the
   AST-heavy analysis work. Independent of the emit target.
5. **Synthesis is bounded by spec tightness.** Open-decision analysis finds what a
   spec leaves *unconstrained*, never what it gets *wrong*. There is no mechanical
   answer — only review of the generated body. This is the central risk.
6. **Tier 1 may not carry its weight.** If `derive` pays off only for a narrow band
   of problems, v3 reduces to a good pipeline library. Untested.

---

## The viability experiment

Everything above rests on one unmeasured assumption: **that writing a spec is
genuinely less work than writing the code.** For `parseDuration`, five examples and
two rules beat a real duration parser easily. There is also a category where pinning
behavior takes more effort than implementing it, and nobody knows which category
most real functions fall into.

### A free ceiling: LeetCode

Before hand-writing a single spec there is a corpus that already has the shape of
the experiment. A LeetCode problem is a statement written without reference to any
particular solution, carrying worked examples and explicit constraints — which is
very nearly a `.rules` file already — paired with thousands of accepted
implementations. **Statement length against solution length is a scrape and an
afternoon, and it produces a number today.**

It is a **ceiling, not a sample.** Those statements are unusually complete because a
paid editor wrote them and ambiguity is a filed bug; a Jira ticket is not that, and
a conversation with a stakeholder is much less that. So an unfavorable ratio there
kills the thesis outright, while a favorable one bounds the best case and says
nothing about the median. Worth running first precisely because it is the cheapest
way to be told no.

### The baseline set

The real measurement needs concrete functions **chosen before any specs are
written**, so the result cannot be selected after the fact. A starting set, with the
prediction recorded in advance so the scoring is honest:

| Function | Spec shape | Predicted |
|---|---|---|
| `parseDuration("1h30m")` | ~6 examples, round-trip rule | favorable |
| `formatBytes(n)` | ~6 examples, monotonicity | favorable |
| `slugify(s)` | ~8 examples, idempotence, charset rule | favorable |
| `compareSemver(a, b)` | examples, total-order rules | favorable |
| `shippingTier(g)` | examples; the constants **are** the content | favorable |
| `truncateWords(s, n)` | examples, length bound, prefix rule | favorable |
| `binarySearch(sorted, x)` | postcondition in one line | favorable |
| `topologicalSort(graph)` | every edge points forward; output is a permutation of input | favorable |
| `normalizePhone(s)` | examples plus a format; regex generation is weak here | uncertain |
| `csvParse(s)` (RFC 4180) | the spec is the RFC — long, but it already exists | uncertain |
| `deepMerge(a, b)` | spec approaches the implementation in size | unfavorable |
| `debounce(fn, ms)` | quantifies over functions and over time | unfavorable |

Then, per function: write only the spec without looking at the implementation,
synthesize, check against the real implementation and its existing tests, and score
two things — **did it pass**, and **was the spec meaningfully shorter.**

- **≥12/20** → Tier 1 is real; the architecture above is worth building.
- **~5/20** → `derive` is a useful tool, not a tier. Ship the Tier-2 runtime alone.
- **≤3/20** → the thesis is wrong, and it cost an afternoon to find out.

### What the set already predicts

`binarySearch` and `topologicalSort` are algorithms, and they sit near the top of
the list rather than the bottom, because their acceptance criteria are one line
while their implementations are fiddly enough to have famous bugs. So the boundary
is **not** algorithmic versus business logic. It is whether **the acceptance criteria
are shorter than the mechanism**, which is a different cut through the same set.

The word carrying the weight in "not for novel algorithms" is therefore *novel*: you
cannot specify what you cannot yet characterize. A textbook algorithm is the exact
opposite of novel, and may be among the best cases there is.

Every other question in this document is downstream of that number.
