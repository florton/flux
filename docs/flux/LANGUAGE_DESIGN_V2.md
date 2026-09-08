# Flux v2: A Language With Three Determinism Tiers

## Thesis

An abstraction layer must be a **function**. `compile(source) → binary` is an
abstraction because it is reproducible; you can pin it, diff it, and reason
about the layer below without looking at it.

`llm(prompt) → output` is a **distribution**, not a function. That is the whole
reason "AI is just another abstraction layer" rings false today.

Flux v2 is built on one move:

> **Push inference to compile time wherever the specification is knowable.
> Where it cannot move, bound it.**

Compile-time inference produces a reviewed, hash-pinned artifact. The *program*
is then deterministic even though its *construction* was not — exactly the
relationship a compiler has to its optimizer. Runtime inference remains
irreducibly probabilistic, so it gets the only guarantees that are honest for a
distribution: a typed output, a proven cost bound, a structured failure
taxonomy, and per-record provenance.

This is where "complex programming in less code" actually comes from. Not from
making runtime LLM calls terser — from **writing specifications instead of
implementations** and having the compiler produce, verify, and pin the
implementation.

---

## What changed from v1, and why

| v1 | v2 | Reason |
|---|---|---|
| One `infer` primitive for everything | Three tiers: `func` / `derive` / `infer` | v1 conflated "extract from an unseen PDF" (irreducible) with "figure out this transformation" (should be compile-time) |
| `complexity 1..3` | Named profiles pinned in `flux.lock` | Env config isn't versioned; two machines produce different programs. Keeps your abstraction, restores reproducibility |
| One `retry N` | `on <failure-class> <policy>`, 4 classes | Blind replay of an identical prompt is the weakest possible repair strategy |
| `error return <value>` | `repair` / `retry` / `quarantine` / `fail` | Silent substitution corrupts datasets at volume |
| `infer` returns the bare value | Returns `Inferred of T` with provenance | You cannot audit a 100k-record run whose model and attempt history was discarded |
| `define f with a, b` | `func f(a: T, b: U) -> V` | The `with` syntax is why `map`/`filter` were unimplementable in v1. Spend the novelty budget on the tiers, not the surface |
| No closures (framed as simplicity) | Inline-only lambdas, no first-class functions | Same static-graph guarantee, but `map`/`filter` now work |
| Cost awareness as a feature | Cost as an inferred **effect** in the type, with `budget` as a compile error | Falls out of the static graph Tier 1 already requires |
| Mode 2: whole program as a prompt | Cut | Directly contradicts the thesis |

---

## The three tiers

Every callable sits in exactly one tier, and the tier is visible in the keyword.
This is the entire language.

| Tier | Keyword | LLM runs | Guarantee | Runtime cost |
|---|---|---|---|---|
| 0 | `func` | never | Deterministic | Free |
| 1 | `derive` | at **build**, once | Deterministic after build | Free |
| 2 | `infer` | at **runtime**, per record | Bounded, typed, observable | Metered |

The design goal for any Flux program is to **push work down the tiers**. Tier 2
is the escape hatch you reach for only when the input is genuinely unstructured.
v1 made Tier 2 the whole language; that is why it could not offer determinism.

---

## Tier 0 — `func`

Ordinary, pure, deterministic code.

```flux
func total_cents(items: list of LineItem) -> cents
  items |> map(i => i.qty * i.unit_cents) |> sum

func high_value(items: list of Item) -> list of Item
  items |> filter(i => i.price > 100)
```

**Lambdas are inline-only.** They may be passed to a higher-order stdlib
function and nowhere else — never stored in a variable, never returned, never
placed in a structure. The compiler inlines them at the call site. This fixes
v1's broken `map`/`filter` while keeping the call graph fully static, which is
what makes Tier-2 cost analysis decidable.

No globals. No recursion without a declared bound (`func f(..) -> T depth 8`).
These restrictions are not aesthetic minimalism — they are precisely the
conditions under which whole-program cost analysis terminates.

---

## Tier 1 — `derive` (the actual new idea)

You write a signature and an **acceptance specification**. The compiler
synthesizes a Tier-0 body, verifies it against your spec, pins it by hash, and
writes it to disk as ordinary reviewable Flux source.

```flux
derive parse_duration(s: text) -> seconds
  examples
    "1h30m" => 5400
    "45s"   => 45
    "2d"    => 172800
    "1h30"  => error Malformed
    ""      => error Malformed
  laws
    forall d: seconds where d > 0 .
      parse_duration(format_duration(d)) == d
    forall s: text .
      parse_duration(s) is error or parse_duration(s) >= 0
```

### What the compiler does

```
$ flux build

derive parse_duration
  cache miss (spec changed: added law #2)
  synthesizing · profile synth → claude-opus-5 · temperature 0
    attempt 1 · examples 4/5 · counterexample: "1h30" => 5400, expected error
    attempt 2 · examples 5/5 · laws 2/2 (1000 generated cases) ✓
  1 open decision
    └ comparator at derived/parse_duration.flux:9
        model chose `>=` · your spec permits `>` or `>=`
        no example covers the zero case
  wrote derived/parse_duration.flux  (body sha256:9f2c8a…)
  pinned in flux.lock

1 derived, 0 cached, 1 open decision
```

### The lockfile

```toml
[derive.parse_duration]
spec_hash       = "sha256:1a4f7c…"  # signature + examples + laws, canonicalized
body_sha256     = "sha256:9f2c8a…"  # the synthesized implementation
model           = "claude-opus-5"
compiler        = "flux 0.4.1"
synthesized     = "2026-09-05T18:22:11Z"
open_decisions  = 1
```

- Spec unchanged → **hash lookup, zero LLM calls, byte-identical output.**
- Spec changed → resynthesis against your accumulated spec, reviewed as a diff.
- `flux build --frozen` fails if anything *would* need synthesis. This is what CI runs.

`spec_hash` and `body_sha256` are tracked **separately**, and that separation is
what makes the spec durable across change. See *Spec durability* below.

The generated source is **committed**. It is not a black box or a cache artifact;
it is Flux code you read and review. It is not, however, code you quietly edit —
a body whose hash no longer matches fails the build until you either revert it or
run `flux detach` (see *Workflow decisions*).

### Open decisions: finding what the model chose and you didn't

The obvious objection to synthesis is *the model writes something that passes
your three examples and fails on the fourth input.* That objection is correct,
and the mechanism below is a **partial** answer to it. Its limits are stated at
the end of this section, because they define the boundary of the whole tier.

Start from what actually goes wrong. Given:

```flux
derive shipping_tier(weight_g: int) -> Tier
  examples
    500  => Standard
    5000 => Heavy
```

the compiler synthesizes something like:

```flux
func shipping_tier(weight_g: int) -> Tier
  if weight_g < 1000 then Standard else Heavy
```

Both examples pass. But **the model invented `1000` and it invented `<`.**
Nothing in your spec chose either one. In production a 900g package is decided
by a number no human ever picked.

That is the real failure mode of synthesis: not wrong logic, but **free
parameters** — constants, comparators, and branch boundaries the model had to
choose and your spec left open.

The compiler finds them mechanically. It rewrites the generated body one small
change at a time (`<` → `<=`, `1000` → `999`, invert a condition, drop a branch)
and re-runs your examples and laws against each variant. A variant that still
passes everything marks a decision your spec does not constrain. Then it
narrows the range by binary search:

```
derive shipping_tier
  examples 2/2 ✓   laws 0/0

  2 open decisions
    ├ threshold at derived/shipping_tier.flux:2
    │   model chose 1000 · your spec permits any value in [501, 5000]
    └ comparator at derived/shipping_tier.flux:2
        model chose `<` · your spec permits `<` or `<=`

  resolve with: flux derive --pin shipping_tier
```

This is not a coverage percentage, and deliberately so. **It does not claim your
spec is complete.** It enumerates the specific points where the model exercised
discretion, with the interval it was free to choose within. One example closes
both of these:

```flux
    999  => Standard      # pins the boundary
    1000 => Heavy
```

This is the tuning mechanism for unknown coefficients you identified — and it is
the more valuable reading of the technique. Framing it as "coverage" invites
exactly the false confidence you objected to.

**Implementation note.** This is mutation testing (Lipton 1971; DeMillo–Lipton–
Sayward 1978), the technique behind Stryker, PIT, and `cargo-mutants`. It is
fully deterministic — the same syntactic rewrites every build, no model
involved — and cheap, because the variants run against examples and laws that
are pure Tier-0 code. Milliseconds, not tokens. The user-facing concept is
**open decisions**; "mutant" never appears in the language.

**What it does not do.** It finds decisions your spec leaves *open*. It cannot
find decisions your spec gets *wrong* — a confidently incorrect example produces
confidently incorrect code with zero open decisions. And for functions where
enumerating the behavior approaches the complexity of implementing it, no
analysis rescues the tier; you should write the function. That boundary is real
and it is where `derive` stops being the right tool.

### Authoring: specification is the primary activity

`derive` is not an annotation you sprinkle on a function. It is where the
engineering effort in a Flux program is *supposed* to go, and the tooling should
reflect that.

The amortization argument is decisive. A build runs once, plus however many
iterations you spend refining it. The compiled program runs thousands or millions
of times. Effort spent at spec time is paid once and recovered on every
execution — so the correct place to be slow and careful is the spec, and the
correct thing for the compiler to optimize is **how fast you converge on a spec
you trust.**

This is most obvious where the requirement is easy to state and expensive to get
wrong. A game design bullet — *"enemies should retreat when outnumbered"* — takes
five seconds to write and contains a dozen decisions that determine whether the
game is any good and whether it ships on time. That bullet is not a
specification. The work of turning it into one is the actual work, and `derive`
should be the place you do it, with the compiler surfacing every decision you
have not yet made.

So synthesis is an interactive loop rather than a one-shot build step — but
"interactive" must not mean a terminal menu. **A workflow that only exists inside
a bespoke CLI is not a serious authoring environment.** It cannot be scripted,
reviewed, diffed, or used from the editor where the work actually happens, and it
signals a toy.

The rule instead:

> **Everything is a file. The compiler writes files, your editor edits files,
> git reviews files. There is no interactive mode that can do anything the files
> cannot.**

Three files per derive, with unambiguous ownership:

| File | Owner | Committed | Purpose |
|---|---|---|---|
| `src/shipping.flux` | **you** | yes | the spec — signature, examples, laws |
| `derived/shipping_tier.flux` | compiler | yes | the synthesized body |
| `derived/shipping_tier.notes.toml` | compiler | yes | open decisions + journal |

The compiler never edits your spec file on its own. You never hand-edit a
generated file (see *detachment*, below).

**Open decisions surface as ordinary LSP diagnostics on your spec**, with code
actions that resolve them:

```
shipping.flux:4:3  info  derive `shipping_tier` — 2 open decisions
  ① threshold   model chose 1000 · your spec permits [501, 5000]
  ② comparator  model chose `<`  · your spec permits `<` or `<=`

  quick fix ▸ Pin ① at 1000 (add boundary examples)
            ▸ Pin ① at a different value…
            ▸ Accept ② as `<`
            ▸ Suppress ① — document why
```

Accepting a code action **writes examples into your spec file**. It is an
ordinary text edit: visible in the buffer, undoable with the undo stack,
reviewable in the diff. Nothing lands in hidden state.

This is the linter-with-autofix model, which every developer already
understands, and it degrades cleanly everywhere:

- **In any LSP editor** (VS Code, Neovim, JetBrains, Zed) — diagnostics and code actions.
- **In a terminal** — `flux check` prints the same diagnostics with `file:line`.
- **In a script or CI** — `flux pin shipping_tier.threshold 1000` performs the
  identical edit non-interactively.

`flux derive --watch` exists, but it is a background daemon that resynthesizes on
save — the same category as `tsc --watch` or a test watcher. It is not a menu and
it owns no state.

**Reviewing a resynthesis uses snapshot semantics.** When behavior diverges, the
build fails with diagnostics and the new body is written beside the pinned one:

```
$ flux build
  ⚠ derive shipping_tier — behavior differs from pinned body
      weight_g = 1000 · was Heavy, now Standard  (open decision ①, uncovered)
    new body written to derived/shipping_tier.flux.new

  1 derive awaiting review · `flux accept shipping_tier`
```

`flux accept` is `jest -u` / `cargo insta accept`. Familiar, non-interactive,
scriptable, and it produces a git diff rather than a terminal transaction.

Every resolution is append-only into source. **The clarification process is an
asset that accumulates in your repository**, never state trapped in a tool.

### Examples at scale

Inline examples stop scaling around a dozen, and a serious spec built from a real
corpus will have hundreds. Examples may therefore come from a file:

```flux
derive shipping_tier(weight_g: int) -> Tier
  examples
    999  => Standard          # inline: the decisions you deliberately pinned
    1000 => Heavy
  examples from "fixtures/shipping.jsonl"   # bulk: the corpus
  laws
    forall w: int where w > 0 .
      shipping_tier(w) == Heavy or shipping_tier(w) == Standard
```

Inline examples are the ones a human chose to pin a decision, and they read as
documentation. File-sourced examples are the regression corpus. Both are part of
`spec_hash`; changing the fixture triggers resynthesis like any other spec edit.

### Spec durability: surviving change without starting over

The failure you flagged is the one that would kill the tier in practice: you
spend real effort converging on a good spec, something upstream changes, and the
clarification process starts from zero. If that happens, nobody will invest in
specs, and `derive` collapses into a novelty.

Four mechanisms prevent it.

**1. The spec and the body are versioned separately.**
Your examples, laws, and pinned decisions are the durable asset — they encode
understanding you paid for, and they only ever grow. The synthesized body is
disposable. When an upstream type changes, `body_sha256` is invalidated and
`spec_hash` is not: the compiler resynthesizes against your *full accumulated
spec*. Zero clarification work is lost.

**2. Type changes produce guided migration, not restart.**

```
derive normalize_address — spec migration required
  `Address.zip` changed: text → Zip

  12 of 14 examples still typecheck.
  2 need updating:
    line 7:  "62704"  → Zip("62704")?     [a]ccept  [e]dit  [d]rop
    line 9:  "89501"  → Zip("89501")?     [a]ccept  [e]dit  [d]rop
  3 of 3 laws still typecheck.
```

**3. Every synthesis is recorded in a journal.**
`derived/shipping_tier.journal.toml` is committed alongside the body and logs
each round: what was open, what you pinned, when, and why. It is the version
control you asked for, at the granularity of decisions rather than files — and
on resynthesis it is fed to the model as context, so the next body inherits the
reasoning rather than rediscovering it.

```toml
[[round]]
at       = "2026-09-05T18:22:11Z"
open     = ["threshold [501,5000]", "comparator"]
resolved = "threshold := 1000"
note     = "matches carrier's published cutoff, not our choice"
```

**4. Resynthesis produces a behavioral diff, never a silent replacement.**
Every previously synthesized body is retained as a behavioral oracle. A new body
is sampled against the old one across generated inputs, and any divergence is
shown before it is accepted:

```
derive shipping_tier — resynthesis (Tier changed upstream)
  spec:     14 examples, 3 laws — all preserved, all passing
  behavior: 998/1000 sampled inputs identical to previous body

  ⚠ 2 inputs diverge:
      weight_g = 1000  · was Heavy, now Standard
      weight_g = 1000  · not covered by any example (open decision #1)

  [a]ccept new behavior   [p]in old behavior as an example   [r]esynthesize
```

This is the strongest guarantee in the tier: **resynthesis cannot silently change
behavior.** A model swap, a compiler upgrade, or an upstream type change surfaces
as a reviewable behavioral delta — the same contract you get from a test suite,
except the compiler generates the comparison for you.

### What `derive` is and isn't for

Good candidates — the spec is much shorter than the implementation:

```flux
derive normalize_phone(raw: text) -> E164
derive parse_iso8601_partial(s: text) -> DateRange
derive merge_addresses(a: Address, b: Address) -> Address
derive classify_sql_dialect(query: text) -> Dialect
derive tokenize_csv_line(line: text, quote: char) -> list of text
```

Bad candidates:

- Anything needing 40 examples to pin down — just write the function.
- Anything whose correctness depends on data you cannot generate laws over.
- Anything with side effects. `derive` bodies are Tier 0: pure by construction.

**Rule of thumb: if the spec isn't meaningfully shorter than the code, you have
not found an abstraction, you have found a slower way to write a function.**

---

## Workflow decisions

Tier 1 puts a model in the build path. That is the design's whole value and also
the reason it can be rejected outright by the organizations most likely to pay
for it. These decisions determine adoption more than any syntax choice, and
several are irreversible once the toolchain ships.

Marked **⛔ make-or-break** where getting it wrong ends the use case entirely.

| Decision | Personal | Enterprise | Verdict |
|---|---|---|---|
| Commit generated bodies? | diff noise | audit requirement | **always commit** ⛔ |
| Can `flux build` synthesize? | convenient | unacceptable | **never implicitly** ⛔ |
| Where does the spec go? | don't care | may not leave the network | **pluggable, inspectable** ⛔ |
| Two devs, same spec | mild churn | constant conflicts | **lockfile wins** ⛔ |
| Model deprecated | resynthesize | 400 pinned derives | **body is the artifact** ⛔ |
| Hand-edit a body? | tempting | breaks the audit trail | **explicit detach** |
| What gets reviewed in a PR? | skim it | rubber-stamp risk | **spec diff foregrounded** |
| Who pays for synthesis? | your key | needs a budget | **build-time budget** |

### ⛔ Generated bodies are always committed

The temptation to `.gitignore` `derived/` is strong personally — every spec tweak
churns a file you didn't write. Give in to it and the entire pitch dies: there is
no artifact to review, no audit trail, and no way to answer *what code actually
ran in production*.

So: always committed, and the friction is paid down instead of avoided. The
generator emits stable formatting and deterministic ordering so diffs are minimal
and semantic. A shipped `.gitattributes` marks `derived/**` as `linguist-generated`,
which collapses it by default in GitHub review while keeping it fully present in
the repository. Committed but quiet.

### ⛔ Synthesis never happens implicitly

If a build server can silently call a model, no regulated organization will adopt
this — the build stops being reproducible, costs become unbounded, and source
leaves the network on a trigger nobody authorized.

Therefore `flux build` **never synthesizes**. It resolves from the lockfile or it
fails. Synthesis is a separate, deliberate command (`flux derive`), run locally
or in a dedicated pipeline that a human triggered. CI runs `--frozen` and fails
if any spec would require it.

This is `npm ci` versus `npm install`, and the split exists for exactly the same
reasons. Note that it also makes the *default* path free and offline: a clean
checkout of a Flux project builds with zero API calls.

### ⛔ The synthesis request is inspectable and the provider is pluggable

The spec — and whatever context accompanies it — is transmitted to a model. For
many buyers that single fact is the entire evaluation.

- `flux derive --dry-run` prints the exact payload that would be sent, byte for byte.
- Provider endpoints are configurable, including on-prem and self-hosted models.
- Nothing else is transmitted: no repository scanning, no ambient context
  gathering, no telemetry. What the spec contains is what is sent.

The spec being small and self-contained is what makes this reviewable, which is a
further argument for keeping derive bodies narrow.

### ⛔ The lockfile decides, so bodies don't thrash

Synthesis is nondeterministic. Two engineers on the same spec would get two
different valid bodies, and every branch would churn `derived/`.

So a body is only produced when **no valid body exists for that `spec_hash`**.
First synthesis wins; everyone else resolves from the lockfile and never calls a
model. A merge that brings in someone else's body for your spec hash is a no-op,
not a conflict.

Examples are canonically ordered before hashing, so reordering or reformatting
them does not invalidate a body — only a semantic change does. The journal is
append-only with timestamps, so it merges cleanly by construction.

### ⛔ The body is the artifact; the model is only provenance

This resolves what was previously listed as an open problem, and it is the
strongest answer available to the biggest enterprise objection — *what happens
when the model we depend on disappears?*

**Nothing happens.** A frozen derive never calls its model again. The pinned body
is ordinary Flux source, committed, running deterministically. Model deprecation
forces no resynthesis, no review cycle, and no behavioral risk. The `model` field
in the lockfile records what produced the body; it is not a dependency.

Resynthesis occurs when **you** change the spec. Never because the world moved.

That property is what makes it defensible to put a model in the build path at
all: the dependency is bounded in time to a single authoring session, not carried
into production indefinitely.

### Detachment is explicit and permanent

You will want to hand-edit a generated body. If you do so silently, the audit
trail becomes a lie — a file claiming to be derived from a spec that no longer
produces it.

The compiler detects the edit by body hash and fails. `flux detach shipping_tier`
moves the body into normal source, deletes the derive from your spec, and records
the detachment in the journal. From then on it is a `func` you own. No half-states,
no partially-authoritative specs.

### Reviewing intent, not mechanism

A 200-line generated body in a pull request gets an LGTM. Assuming otherwise is
the naive failure mode of this whole design.

So the review is inverted, and the tooling has to enforce it: the **spec diff is
foregrounded** (short, human-written, expresses intent) while the **body diff is
collapsed** (long, generated, expresses mechanism). What gates the merge is the
open-decisions delta and the behavioral diff — both machine-generated, both
short, both meaningful.

*You review the intent; the compiler verifies the mechanism matches it.* That is
the actual claim of Tier 1, and the review workflow either embodies it or
undermines it.

### Build-time budgets

Synthesis costs money and someone iterating on a hard spec can spend real amounts
without noticing. `flux derive` reports spend per session, and projects declare a
build-time budget separate from the runtime `budget` on pipelines. Symmetric with
the Tier-2 cost story, and the same reason it exists.

---

## Tier 2 — `infer` (bounded, not deterministic)

For input you have genuinely never seen. Every v1 problem is addressed here.

### Types carry semantic constraints

```flux
type Invoice
  number   text   matches /^INV-\d{6}$/
  vendor   text   len 1..200
  currency text   in ISO4217
  issued   date   where <= today
  total    cents  where > 0
  lines    list of LineItem  len 1..500

  invariant sum(lines |> map(l => l.amount)) == total
  invariant issued <= due
```

Constraints are **not** separate stdlib validators as in v1. Being part of the
type means they are (a) compiled into the JSON schema and the prompt, (b)
checked on every result, and (c) able to drive repair — the failing constraint
is the feedback the model receives.

### The failure taxonomy

```flux
infer extract(doc: Document) -> Invoice
  using   model.extract
  temperature 0

  on transport  retry 3 backoff exponential jitter   # 429 / 500 / timeout
  on schema     repair 2                             # unparseable or wrong shape
  on constraint repair 1                             # parsed, violates the type
  on refusal    fail                                 # model declined
  else quarantine
```

Four failure classes, four policies, because they demand different responses:

- **`retry`** — clean replay. Correct for transport. Useless for the rest.
- **`repair`** — *replay with the specific failure fed back in*. This is the fix
  for v1's blind retry: a model that omitted a field is far more likely to supply
  it when told which field failed and why than when handed the identical prompt
  again.
- **`quarantine`** — set the record aside with its full provenance and continue.
  At 500k records you want neither a crash nor a silently substituted default;
  you want a triage queue.
- **`fail`** — abort the pipeline.

`quarantine` is a first-class primitive, not an error value. Quarantined records
land in a typed sidecar the pipeline returns, so a run's output is
`(results, quarantined)` and you cannot accidentally treat a partial run as
complete.

### Provenance is in the type

```flux
let r = extract(doc)        # r : Inferred of Invoice

r.value              # Invoice — must be unwrapped explicitly
r.meta.model         # "claude-sonnet-5"
r.meta.attempts      # 2
r.meta.repairs       # 1
r.meta.fallback      # false
r.meta.cost_usd      # 0.0041
r.meta.cached        # false
r.meta.latency_ms    # 1840
```

`Inferred of T` is a distinct type from `T`. You must unwrap it to use the
value, which makes "this came from a model" syntactically visible at every use
site and makes provenance impossible to discard by accident. Writing an
`Inferred of T` to a sink emits the metadata alongside it by default.

### Model profiles, pinned

You were right that the complexity tier should be configurable rather than
hardcoded — but it belongs in a **versioned lockfile**, not the environment. Env
vars aren't reviewed or committed, so two machines silently produce different
programs, which is the exact failure this design exists to eliminate.

```toml
# flux.lock
[model.extract]
provider   = "anthropic"
id         = "claude-sonnet-5"
max_tokens = 4096

[model.extract.fallback]
id = "claude-opus-5"

[model.classify]
id = "claude-haiku-4-5-20251001"
```

Code says `using model.extract`. The lockfile says what that is today. You get
your abstraction *and* reproducibility, and a model swap becomes a reviewable
one-line diff rather than an invisible environment change.

`temperature` defaults to 0 everywhere and is a declared field. If predictability
is the pitch, sampling temperature cannot be an implicit default.

### Concurrency and circuits, defined

v1's circuit semantics were sequential ("doc 1 fails, doc 2 fails…") while the
compilation target was `Promise.all`. With N requests in flight there is no total
order, so "5 consecutive failures" was undefined.

```flux
pipeline process(docs: list of Document) -> Report
  concurrency 32
  circuit
    scope     model.extract       # per-profile, not per-call-site
    window    60s
    threshold 20% of 50           # rate over a rolling window, not a streak
    half_open after 30s probe 3
```

- Circuits are **rate-over-window**, not consecutive-failure counts. A rate is
  well-defined under concurrency; a streak is not.
- Scope is the **model profile**, so every call site sharing an endpoint shares
  the breaker — which is what you want when a provider degrades.
- Distributed runs coordinate the breaker through the checkpoint store.

### Batching, split into three real things

v1's `batch N` conflated unrelated mechanisms with different cost, latency, and
accuracy characteristics.

```flux
docs |> map infer extract              # 1 call per item, concurrency N
docs |> pack 20 infer classify         # 20 items per prompt
docs |> submit infer extract           # provider batch API: async, ~50% cost
```

**`pack` defines its misalignment semantics**, which v1 left open and which
happens constantly at scale. Each packed item carries a correlation id; results
are matched by id and **never positionally**. Unmatched or duplicated ids are
quarantined individually rather than failing the whole pack. A pack that returns
19 results for 20 inputs loses exactly one record, identifiably.

**`submit`** targets provider batch endpoints — asynchronous, roughly half price,
hours of turnaround. It is a different *execution mode*, not a tuning parameter,
and it composes with checkpointing: submit, checkpoint, exit, resume on
completion.

---

## Cost is a type, and budgets are compile errors

Every function carries an inferred cost effect. You never write it; `flux check`
displays it.

```flux
func   total_cents(..)    -> cents    !cost(0)
derive parse_duration(..) -> seconds  !cost(0)     # Tier 1 is free at runtime
infer  extract(..)        -> Invoice  !cost(calls 1..4, tok 3k..14k, $0.004..0.019)
```

The bounds come from the failure policies: `repair 2` plus `repair 1` plus a
fallback gives a worst case of 4 calls. Effects compose over the dataflow graph
symbolically in the input size.

```flux
pipeline process_invoices(docs: list of Document) -> Report
  budget 3 * len(docs) calls, $500
  concurrency 32
  checkpoint every 1000
```

```
$ flux cost pipeline.flux --n 100000

  extract    100k..400k calls   $  412 .. $1,905
  classify   100k     calls     $   31 .. $   31   (packed 20 → 5k calls)
  ─────────────────────────────────────────────────
  worst case 405,000 calls      $1,936
  expected*  118,000 calls      $  487      *from last run's observed repair rates

error: budget exceeded in `process_invoices`
  declared:   300,000 calls, $500
  worst case: 405,000 calls, $1,936
  note: `on schema repair 2` at extract.flux:14 contributes up to 200k calls
  note: budget is met if repair is reduced to 1 (worst case 300k, $1,441)
```

**This is the feature that requires a language.** No library inside a
Turing-complete host can bound its own call count before running. It is decidable
here only because the graph is static: no closures, no first-class functions, no
unbounded recursion, no dynamic dispatch. Those restrictions were in v1 already —
v2 makes explicit that *they exist to buy this*.

---

## Execution: caching, checkpointing, resume

At volume the run will be interrupted. This is the other thing a library
struggles to provide and that the design makes nearly free.

Every `infer` result is **content-addressed** on
`(input, prompt, schema, model id, temperature, compiler version)`.

- Re-running a pipeline over overlapping input is a cache hit — no LLM call.
- `checkpoint every 1000` persists cursor, cache, and circuit state.
- `flux run --resume` restarts exactly where it stopped.
- `r.meta.cached` marks which records came from cache.
- **A cached replay of a Tier-2 pipeline is fully deterministic** — which makes
  debugging one bad record possible without paying to re-infer everything.

Because Tier 0 and Tier 1 are pure, only Tier-2 boundaries need checkpointing.
The compiler places them automatically.

---

## Worked example: where the code goes

A pipeline over a vendor invoice feed. Note how much lives below Tier 2.

```flux
import model

type Invoice
  number   text  matches /^INV-\d{6}$/
  vendor   text  len 1..200
  currency text  in ISO4217
  total    cents where > 0
  lines    list of LineItem len 1..500
  invariant sum(lines |> map(l => l.amount)) == total

# ── Tier 1: synthesized once at build, free and deterministic forever ──
derive normalize_vendor(raw: text) -> text
  examples
    "ACME CORP."       => "Acme Corp"
    "acme corporation" => "Acme Corp"
    "ACME  CORP  LLC"  => "Acme Corp LLC"
  laws
    forall s: text . normalize_vendor(normalize_vendor(s)) == normalize_vendor(s)
    forall s: text . len(normalize_vendor(s)) <= len(s) + 4

derive parse_money(raw: text) -> cents
  examples
    "$1,234.56" => 123456
    "(45.00)"   => -4500
    "EUR 12,00" => 1200
    "n/a"       => error NotMoney
  laws
    forall c: cents . parse_money(format_money(c)) == c

# ── Tier 2: only the genuinely unstructured step ──
infer extract(doc: Document) -> Invoice
  using model.extract
  temperature 0
  on transport  retry 3 backoff exponential jitter
  on schema     repair 2
  on constraint repair 1
  on refusal    fail
  else quarantine

# ── The pipeline ──
pipeline process(docs: list of Document) -> Report
  budget 4 * len(docs) calls, $2000
  concurrency 32
  checkpoint every 1000

  let extracted = docs |> map infer extract

  let clean = extracted
    |> map(r => r.value with vendor: normalize_vendor(r.value.vendor))
    |> filter(inv => inv.total > 0)

  return Report {
    invoices:    clean,
    quarantined: quarantine_log,
    spend:       extracted |> map(r => r.meta.cost_usd) |> sum,
    cache_rate:  extracted |> rate(r => r.meta.cached)
  }
```

Vendor normalization and money parsing are exactly the fiddly, edge-case-ridden
code that eats an afternoon and a hundred lines. They are specified here in
twelve, and at runtime they are **free and deterministic** — no model in the hot
path, identical output on every run, forever. The single Tier-2 call is bounded,
typed, provenance-tracked, and budgeted.

That is the compression you were reaching for, without giving up determinism to
get it.

---

## What this is for

The goal is not cheaper AI pipelines. It is to make a Flux programmer
**consistently** capable of more than a prompt engineer can achieve at their
best — by making the model's contribution reviewable, pinned, and permanent
instead of re-rolled on every run.

The prevailing workflow is *prompt → plan → build*, and the failure is in the
middle. A plan is prose: nothing verifies it, so an error there propagates
silently into the build and compounds, even with a frontier model. `derive`
replaces the plan with a specification that **executes**. Examples run. Laws run.
Open decisions are enumerated. A bad spec is caught mechanically before any code
depends on it, and what comes out is pinned rather than regenerated differently
each time.

The same three steps. The middle one stops being a guess.

### Why it must be a language

The v1 doc's stated innovations were all things a library does well. These are
not, in order of how much they matter:

1. **A build phase that materializes, verifies, and pins generated code.** A
   library has no build phase, no lockfile, and no place to put reviewable
   generated source. This is the whole of Tier 1.
2. **Open-decision analysis over synthesized bodies.** Requires the compiler to
   own the spec and the generated code together.
3. **A type system where provenance is part of the type.** `Inferred of T` forces
   every use site to acknowledge that a model produced the value.
4. **Whole-program cost bounds as a compile error.** A genuine differentiator and
   an easy thing to sell, but a consequence of the static graph rather than a
   reason to build it — it falls out of the constraints that Tier 1 needs anyway.

If the answer to "why a language" is only ergonomics, build the TypeScript
library instead. It is the above four, or nothing.

---

## Open problems (the honest list)

1. **Synthesis is bounded by spec tightness.** Open-decision analysis finds what
   your spec leaves *unconstrained*; it cannot find what your spec gets *wrong*.
   A confidently incorrect example yields confidently incorrect code with zero
   open decisions. This is the central risk of the whole approach, and there is
   no mechanical answer to it — only review of the generated body.
2. **Laws need generators.** `forall d: seconds` requires generating values for
   every type, including user composites with constraints. QuickCheck solved this,
   but constrained generation for `matches /regex/` is real work.
3. **Cost analysis breaks on data-dependent iteration.** Any loop whose trip count
   depends on inferred output is unbounded. Either ban it inside `pipeline` or
   require a declared bound. Leaning toward: require the bound.
4. **Generated code is a supply-chain surface.** Committed code you did not write
   that passed its own tests is a new review burden. Open decisions and small
   derive bodies mitigate; they do not eliminate.
5. **Tier 1 may not carry its weight.** If `derive` only pays off for a narrow
   band of problems, v2 collapses back toward a very good library. This is the
   first thing to test empirically — see the viability experiment below.
6. **Specifying complex behavior may approach implementing it.** For a narrow
   band of functions the spec is dramatically shorter than the code. Outside that
   band the oracle problem bites: knowing what to assert is as hard as writing
   the thing. Where that line falls is unknown and is exactly what the viability
   experiment measures.

*(Model deprecation was previously listed here. It is resolved under Workflow
decisions: the body is the artifact, the model is provenance, and a frozen derive
never calls a model again.)*

---

## Still unspecified

This proposal is deliberately not a complete language definition. What is
designed above is the part that carries the thesis; the following are known gaps
rather than oversights, and each needs a decision before anything is built.

- **Grammar.** Block structure, expression precedence, and whether `then` is
  required in `if` are all undecided. Deliberately last — surface syntax is the
  cheapest thing to change and the easiest to bikeshed.
- **Error and effect types.** `error Malformed` appears in examples without a
  declared error taxonomy. Whether errors are a union in the return type, a
  separate effect, or both, is open.
- **The law language.** `forall d: seconds where d > 0 . ...` needs a real
  definition: what may appear in a law, whether laws can call Tier-2 functions
  (they must not), and how counterexamples are minimized for reporting.
- **Generators for user types.** Laws are only as good as the values fed to them.
  Constrained generation for `matches /regex/` and cross-field `invariant`s is
  the hard case.
- **Module system.** `import` exists in v1 and is unaddressed here. Whether a
  derive can be published as a library — shipping its spec, body, and journal
  together — is an interesting question with governance implications.
- **The stdlib.** v1's ~40 functions need re-specifying against the pipeline and
  lambda model. Which are Tier 0 and which are effectful matters for cost analysis.
- **Interpreter or transpiler.** Transpiling to TypeScript gives an ecosystem;
  a native runtime gives control over the checkpointing and cache semantics that
  Tier 2 depends on. Not obvious.

---

## If it were built: the order that de-risks it

Not a call to action — a note on which questions are load-bearing, so the
proposal can be evaluated against them.

**The viability experiment comes first and requires no code.** Take 20 real
utility functions from an existing codebase. For each, write only the spec,
without looking at the implementation. Synthesize. Check against the real
implementation and its existing tests. Score two things: did it pass, and was the
spec meaningfully shorter than the code?

- **≥12/20** → Tier 1 is real, and the compiler is worth building.
- **~5/20** → `derive` is a useful tool, not a language tier. Ship a library.
- **≤3/20** → the thesis is wrong, and it cost an afternoon to find out.

Everything else is downstream of that number. In rough order after it:

1. `derive` end to end — synthesis, example and law verification, the lockfile,
   generated source on disk.
2. Open-decision analysis. Constants and comparators first — the free parameters
   — before branch deletion.
3. Spec durability — separate spec/body hashes, the journal, behavioral diff on
   resynthesis. This is what makes anyone willing to invest in a spec.
4. Tier 2 runtime — one `infer`, the four failure classes, repair-with-feedback,
   provenance, content-addressed cache.
5. `flux cost`. Deliberately late: easiest to demo, least load-bearing.
6. Parser, LSP, formatter. Last — the expensive part, paid for only once the
   semantics are proven.
