# Ratchet v0 — Issues, Defects, and Findings

Recorded 2026-09-05 from a review of the [ratchet/](ratchet/) v0 prototype
(868 lines of `src`, 177 of tests). Numbered `R1..R21` to stay distinct from the
design issues in [ISSUES.md](ISSUES.md). Status per entry is in the table below.

**Method.** Every module was read, the suite was run (11/11 pass), and each
suspected defect was reproduced by execution against a scratch project. Entries
marked *reproduced* carry the transcript that produced them. Nothing here is
inferred from reading alone.

**Summary.** The design is sound and the core loop works — the demo walkthrough
reproduces exactly as documented. But there is one arbitrary-code-execution hole
and two silent-false-pass paths, and the false passes break the specific promise
the whole system is built on: that a captured counterexample keeps enforcing
forever. This is a good v0; it is not yet safe to point at a shared repo.

**Update 2026-09-06 — v0.2 then v0.3.** All 21 entries are now closed. v0.2
fixed R1–R7, the correctness and security tier, each with a regression test and
each original repro re-run against the new build. v0.3 closed the remainder:
the `na` outcome, `fsck`, `list`/`show`, `--json`, parallel `verify`, the
packaging fix, and a generated demo. 33 tests. The repro transcripts below are
kept as written — they are the record of what each defect actually was.

| # | Severity | Status | Issue | Location |
|---|---|---|---|---|
| R1 | critical | **fixed** | Arbitrary command execution via `{test}` substitution | `src/verify.ts:22`, `src/runner.ts:16` |
| R2 | critical | **fixed** | An accepted row can never re-catch its own regression | `src/capture.ts:116` |
| R3 | high | **fixed** | Branch merges silently destroy rows (id collision) | `src/paths.ts:24` |
| R4 | high | **fixed** | Fold is file-order dependent; retirements can vanish | `src/corpus.ts:31` |
| R5 | high | **fixed** | Minimization slips to a different bug and loses the real one | `src/shrink.ts:50`, `src/capture.ts:152` |
| R6 | high | **fixed** | `bisect` strands the user's checkout on any error | `src/bisect.ts:38` |
| R7 | high | **fixed** | JUnit path bypasses discrimination and dedup entirely | `src/capture.ts:121` |
| R8 | medium | **fixed** | No error handling; one bad line bricks every command | `src/index.ts`, `src/corpus.ts:15` |
| R9 | medium | **fixed** | `verify` costs ~62 ms/row, serial, unbounded corpus growth | `src/verify.ts:41`, `src/runner.ts:19` |
| R10 | medium | **fixed** | `bin`/`main` point at a path the build never emits | `package.json` |
| R11 | medium | **fixed** | Flag values are parsed as positionals | `src/index.ts:105,118,155` |
| R12 | medium | **fixed** | `--home` honored by 2 of 8 commands | `src/index.ts:98,148` |
| R13 | medium | **fixed** | The accept ceremony cannot show what it is retiring | `src/verify.ts:56,70` |
| R14 | medium | **fixed** | Config-missing and check-crashed both score as `fail` | `src/verify.ts:16` |
| R15 | low | **fixed** | No machine-readable output; `json` option declared, never read | `src/verify.ts:11` |
| R16 | low | **fixed** | Dead code and a dishonest cast | `src/verify.ts:70`, `src/accept.ts:22,46` |
| R17 | low | **fixed** | `nextRowId` re-parses the corpus per row: O(n²) capture | `src/paths.ts:24` |
| R18 | low | **fixed** | `accept`/`reopen` behave asymmetrically on no-op | `src/accept.ts` |
| R19 | low | **fixed** | Demo and field-experiment artifacts are not committed | `ratchet/.gitignore:3` |
| R20 | low | **fixed** | `stableStringify` is unsound off the JSON value domain (latent) | `src/corpus.ts:5` |
| R21 | low | **fixed** | No `engines` field despite Node 18+ requirements | `package.json` |

---

## Resolved in v0.2

What changed, per issue. Every fix carries a regression test in
`ratchet/test/ratchet.test.ts` (22 tests, all passing), and every original
repro above was re-run against the new build.

**R1 — arbitrary command execution.** Checks are now tokenized and spawned
with `shell: false`, so no substituted value can become syntax. `{test}`
substitutes as exactly one argv element and the name is also exported as
`RATCHET_TEST`. `"shell": true` remains available per subject for pipes and
`.cmd` entry points — it runs only the project's own committed command
string, and `{test}` is refused in that mode. Re-run of the repro: the
payload arrives intact as `argv[2]`, `owned.txt` is not created.

**R2 — recurrence after accept.** Dedup is partitioned by row status. An
identical *active* row is a duplicate; an identical *archived* row is a
recurrence, reported with the date, actor and reason of the accept, and
`capture` exits 1. `--reopen` puts the row back and journals the decision.

**R3 — id collision across branches.** Ids are `c` + `sha256(subject+input)`
truncated to 12 hex, so id allocation and dedup became the same operation and
two branches converge on the same id instead of colliding. `nextRowId` is
gone (this also closes R17). `ratchet init` writes a `.gitattributes` with
`merge=union` so the text merge stops conflicting. Any unambiguous id prefix
is accepted wherever an id is expected.

**R4 — fold order.** `foldCorpus` replays events in timestamp order with a
stable tiebreak on file position, so an `accept` that lands above its
`capture` still retires the row. When any event has an unparseable `at`, file
order is used unchanged. Orphaned accept/reopen events are collected and
reported by `ratchet report` instead of being silently dropped.

**R5 — reduction slippage.** Each capture records a normalized failure
signature (`exit:1|expected <n>, got <n>`), and reduction only accepts a
smaller input that fails with the *same* signature; the winner is
re-confirmed before storage, so a flaky check cannot smuggle one through.
The repro now stores 1000 — the true minimal witness of the captured bug —
instead of slipping to 0. `verify` flags a row failing with a different
signature than it was captured with. Reduction also has a spawn budget.
Known limit, documented in `signature.ts`: a check that prints nothing on
failure degrades to `exit:<code>`.

**R6 — bisect strands the checkout.** The search runs in a detached
`git worktree` removed in a `finally`; the user's checkout is never touched,
so a dirty working tree is no longer a reason to refuse. `merge-base
--is-ancestor` rejects two refs that are not a range, and a range containing
merges is searched along first-parent, because binary search over a
non-linear list is not sound. `--setup` runs a command in the worktree before
each probe, which a fresh worktree needs for dependency installs.

**R7 — the JUnit path.** Both sources go through one gate: reproduce, then
dedup, then store. Test-name rows dedup on `(subject, test)`, so capturing
the same `junit.xml` three times yields one row. A binding whose subject has
no configured check is reported and dropped rather than stored, which removes
the permanently-red-build symptom without needing the `na` outcome.

**R11, R12 — argument handling.** `parseArgs` splits flags, switches and
positionals in one pass, so a flag's value is never taken as the id. `--home`
is resolved once in `main()` and now applies to every command.

**R16 — dead code and the cast.** `inputString` is used: `verify` prints the
failing row's input. The `as "fast-check"` cast is replaced with the honest
union type.

## Resolved in v0.3

**R8 — corpus robustness.** `readCorpus` parses per line and collects malformed
ones instead of throwing; a top-level handler turns errors into one actionable
line. `ratchet fsck` reports unreadable lines, orphaned accept/reopen events,
unconfigured subjects, and **rows whose id does not match their own content** —
a check only possible because ids are content-addressed, and the one that
catches hand-editing. `verify` still refuses to run against a corpus it cannot
fully read, because a row hidden behind a parse error is a false pass; it now
names the line instead of printing a stack.

**R9 — throughput.** `verify` runs rows through an async pool, default
concurrency = CPU count capped at 8, `--jobs N` to override. Measured on the
same 200-row corpus as the original finding: **12514 ms → 4019 ms, 3.1×**.
Per-subject `timeoutMs` replaces the hardcoded 30 s. Batching several inputs
into one process was considered and rejected: it would change the check
contract, which is the most valuable thing in the design.

**R10, R21 — packaging.** `bin` and `main` point at `dist/src/index.js`, which
is what `tsc` actually emits; `engines` declares node >= 18; `files` limits the
published surface.

**R13 — the ceremony can see what it retires.** `ratchet list` shows every row
with status and input; `ratchet show <id>` shows one row's input, witness, full
event history with actors and reasons, and its journal entries. Both accept id
prefixes.

**R14 — the third outcome.** A check may exit **125** to report "not applicable
at this commit". `na` is neither pass nor failure, does not fail the build, and
is counted separately in `verify` and `--json`. A check that cannot be
*spawned* deliberately stays a failure: that is indistinguishable from a broken
config, and greening it would be the false pass this tool exists to prevent.
The `na(env)` vs `na(code)` split from [NEXT_STEPS.md](NEXT_STEPS.md) needs
per-run environment recording and is not attempted here.

**R15 — machine-readable output.** `--json` on every command; `verify --json`
emits per-row results plus outcome counts.

**R18 — symmetry.** `reopen` on an active row is refused, as `accept` on an
archived one already was, so no-ops stop appending to the decision log.

**R19 — reproducible demo.** `demo/setup.js` generates the five-commit history
from scratch into `demo/repo/`; the generator and the walkthrough are
committed, the generated repository is not. A nested `.git` cannot live inside
this repository, which is why the demo was ignored in the first place. The
generated history was verified to carry the same bug and yield the same bisect
answer, and its `check.js` now prints a failure reason — so the demo
demonstrates the strong form of the witness rather than the degraded one. The
field-experiment check scripts remain uncommitted: they live in the target
repos and are out of scope here.

**R20 — stableStringify.** Values outside the JSON domain get distinct
sentinels (`<undefined>`, `<NaN>`, `<date:...>`, `<map:...>`) instead of
aliasing onto `null` or `{}`, and the function no longer returns `undefined`
against a `string` return type.

### Beyond the original scope

Two v0.2 changes were not strictly required by the safety tier and are noted
rather than left silent: the top-level error handler and printing the row input
in `verify` output. Both exist because the new error paths — ambiguous id
prefixes, non-ancestor refs, recurrences — are unreadable as stack traces.

---

## Critical

### R1. Arbitrary command execution via `{test}` substitution

**Severity: critical. Status: FIXED in v0.2. Reproduced.**
`src/verify.ts:22`, `src/runner.ts:16`, `src/capture.ts:67`

`resolveCheck` interpolates a corpus row's test name into a command string that
`runCheck` executes with `shell: true` and no escaping. The JUnit reader is a
regex, not an XML parser, so it accepts malformed XML and passes raw shell
metacharacters straight through.

```
<testsuite><testcase name="a & echo PWNED > owned.txt & echo x">
  <failure message="f"/></testcase></testsuite>
```
```
$ ratchet capture junit2.xml
+ c0001
$ ratchet verify
✓ c0001 suite                          <- forged PASS
1/1 rows pass
$ cat owned.txt
PWNED
```

Two properties make this worse than an ordinary injection:

- **The payload persists into a committed file.** It is written to
  `corpus.jsonl`, which the design requires be committed, so it re-executes on
  every teammate's machine and in CI, indefinitely.
- **It forges a green result.** The injected command exits 0, so the row reports
  pass — the failure mode the design names as the worst one a check can have.

The vector is realistic: parameterized tests named from fixture data, a
`junit.xml` from an untrusted CI artifact, or a PR that adds a fixture whose
name reaches the report. This is [ISSUES.md](ISSUES.md) item 5 (supply chain)
arriving through a channel that item does not list.

**Fix.** Run checks with `shell: false` and an argv array; pass the test name
via env var or stdin rather than string interpolation. If `shell: true` must
stay for config ergonomics, the substituted value has to be quoted per-platform,
and `{test}` should be rejected outright for `source: "junit"` rows.

### R2. An accepted row can never re-catch its own regression

**Severity: critical. Status: FIXED in v0.2. Reproduced.** `src/capture.ts:116`

The capture dedup set is built from *all* corpus events, including rows that the
accept ceremony has archived. Once a row is retired, the identical counterexample
can never be stored again — and nothing reports that an archived row matched.

```
$ ratchet capture cap.json          # first time
+ c0001 s 42
$ ratchet accept c0001 --reason "intended for now" --actor alice
accepted c0001 — expectation retired, audit trail retained

# ... the same bug comes back ...
$ ratchet capture cap.json
skip: s 42 (already in corpus)      <- reassuring, and wrong
$ ratchet verify
0/0 rows pass                        exit=0
```

Green build, live regression, and the skip message actively tells the operator it
is handled. Accepting a row is meant to say "this behavior is intended *now*" —
it currently also says "never tell me about this input again," which is a
different and much stronger claim than the ceremony asks for.

**Fix.** Partition dedup by row status. A capture matching an archived row is a
distinct outcome: report it loudly (`matches archived row c0001, accepted
2026-03-01 by alice — reopen?`) and either auto-`reopen` or exit nonzero. Do not
let it fall through the same code path as a genuine duplicate.

---

## High

### R3. Branch merges silently destroy rows

**Severity: high. Status: FIXED in v0.2. Reproduced.** `src/paths.ts:24`, `src/corpus.ts:31`

`nextRowId` allocates sequential ids from local file state, so two developers on
two branches both receive `c0001`. `foldRows` keys by id with last-write-wins, so
after the merge one row is gone with no error:

```
capture events in file: 2
rows after fold: 1  -> 1 survives, 1 SILENTLY LOST
```

A colliding `accept` is worse than a lost capture: accepting `c0005` on one
branch retires a *different* row after the merge, so the ceremony's audit trail
records a decision against a counterexample nobody made it about.

[RATCHET.md](RATCHET.md) claims "Merge behavior is trivial because it is
append-only: no conflicts, ever." Both halves are false. Git conflicts on the
trailing line of a JSONL append routinely, and the fold is not merge-safe even
when the text merges cleanly.

**Fix.** Content-addressed or random ids (`c-<hash of subject+input>` or a
ULID), which also makes dedup and id allocation the same operation. Ship a
`.gitattributes` with `*.jsonl merge=union` so the text merge stops conflicting.

### R4. Fold is file-order dependent, so retirements can vanish

**Severity: high. Status: FIXED in v0.2. Reproduced.** `src/corpus.ts:31,48,52`

`foldRows` walks the file in physical order and guards `accept`/`reopen` with
`if (prev)`. An event that lands above its own `capture` line — which a merge can
easily produce — is silently discarded:

```
accept(Feb) written before capture(Jan), e.g. after a merge reorder:
  status = active   <- the retirement was dropped; the row is enforcing again
```

The `at` timestamp is recorded on every event and never used for ordering.

**Fix.** Sort events by `at` (with a stable tiebreak on file position) before
folding, and count orphaned `accept`/`reopen` events instead of dropping them —
an orphan is a corpus-integrity signal, not a no-op.

### R5. Minimization slips to a different bug and loses the real one

**Severity: high. Status: FIXED in v0.2. Reproduced.** `src/shrink.ts:50`, `src/capture.ts:152`

The reduction predicate is `!pass` — *any* failure — not "fails the same way."
`shrinkNumber` finishes with an unconditional `test(0)` candidate that overrides
everything found so far, and 0 is the single most commonly broken input in real
code. Given a genuine regression at `n >= 1000` and an unrelated legacy bug at 0:

```
$ ratchet capture cap.json           # counterexample was 8347
+ c0001 s 0                          <- stored 0
stored reason: "THE REGRESSION"      <- the row now lies about itself
```

The consequences compound:

- The row's `input` reproduces bug B while its `reason` describes bug A.
- Fixing the actual regression leaves the row red forever, pointing at a bug that
  was never the one captured. Neither `accept` nor `fix` is the correct response,
  and there is no command for "this row was mis-minimized."
- The real regression is **no longer in the corpus at all**. It was captured and
  then minimized away. Permanent memory of that bug: gone.

This is exactly the pressure that makes teams bulk-delete a corpus — the outcome
the accept ceremony exists to prevent.

Array and string reduction did *not* exhibit this in testing: `ddmin`'s
`while (current.length >= 2)` guard and chunk-removal structure mean it never
reaches `[]` or `""`. The demonstrated slippage is numeric. The general risk (a
reduced input that fails for a different reason) remains for all three types.

**Fix.** Cause-preserving reduction. The check contract already returns a reason
on stdout, so the machinery exists: capture the original failure signature
(normalized stdout + exit code) and require every accepted reduction to match it.
Store the witness on the row so a later mismatch is detectable. Additionally,
bound the reduction: it currently issues up to ~100 subprocess spawns with a 30 s
timeout each and no overall budget.

### R6. `bisect` strands the user's checkout on any error

**Severity: high. Status: FIXED in v0.2. Reproduced.** `src/bisect.ts:38`

`bisect` runs `git checkout` directly in the user's working tree and has no
`try/finally`. The two early-exit paths restore manually; nothing else does. A
typo'd row id is enough:

```
$ ratchet bisect c9999 --good <sha> --bad HEAD
[uncaught stack trace]
branch AFTER: ''      HEAD: (detached)
```

The same applies to Ctrl-C, a crashing check, or a failed checkout. The temp
corpus directory leaks too.

[NEXT_STEPS.md](NEXT_STEPS.md) already states the requirement — "History commands
run in worktrees. Never the user's checkout. The margin detached-HEAD scare was
the proof" — so this is a written requirement that is not yet implemented.

A second, separate correctness limit: binary search over
`git rev-list --reverse good..bad` assumes a linear, monotone commit list. Across
merge commits it is neither, which is why `git bisect` uses a graph walk. The
result can name a commit that is not the introducing one.

**Fix.** `git worktree add` into a temp dir and never touch the user's checkout;
`try/finally` for teardown regardless. Refuse or warn when `good..bad` is
non-linear.

### R7. The JUnit path bypasses discrimination and dedup entirely

**Severity: high. Status: FIXED in v0.2. Reproduced.** `src/capture.ts:121`

`if (b.input === null)` short-circuits and appends before the reproduce check and
before the dedup lookup. Capturing the same `junit.xml` three times:

```
c0001 login works / c0002 login works / c0003 login works
✗ c0001 login works — Error: no subject config for "login works"
0/3 rows pass, 3 failing
```

Two distinct problems:

- **Unbounded duplicate rows.** Every red CI run that captures the same artifact
  adds another permanent, enforcing row. A flaky test mints a fresh row on every
  failure — precisely the untrustworthy-corpus outcome the design says
  discrimination prevents.
- **A config gap becomes a permanently red build.** Captured subjects are raw
  test names, which will essentially never match a hand-authored config key, and
  an unconfigured subject scores as a *failure* (see R14) rather than as
  not-applicable.

`ratchet/README.md:75` states "Every capture runs **dual-run discrimination**."
That is false for this path.

**Fix.** Route JUnit rows through the same reproduce + dedup gate; key dedup on
`(subject, test)` when `input` is null. Reject or quarantine captures for
subjects with no config rather than storing them.

---

## Medium

### R8. No error handling; one malformed line bricks every command

**Severity: medium. Status: FIXED in v0.2. Reproduced.** `src/index.ts:49`, `src/corpus.ts:15`

`main()` has no try/catch, and there is no `JSON.parse` guard in `readEvents`,
`readJournal`, `nextRowId`, or `loadConfig`. A single truncated line — a crashed
write, a concurrent append, a merge-conflict marker — makes *every* command die
with a raw `SyntaxError` and no repair path:

```
$ ratchet verify
undefined:1
{"op":"capture","id":"c0002","at":"2026-01-01T00:00:00Z","subj
SyntaxError: Unterminated string in JSON at position 62
exit code = 1
```

The exit code is 1, so CI stays red rather than falsely green — but a durable,
append-only store that is the system's memory has no `ratchet fsck`, no
skip-and-report on bad lines, and no way to recover except hand-editing.

Related: `nextRowId` + `appendEvent` is an unlocked read-modify-write. Two
concurrent `ratchet capture` runs (parallel CI jobs) produce duplicate ids by the
same mechanism as R3.

**Fix.** Per-line parse with a collected error report; a top-level handler that
prints one actionable line instead of a stack; a `ratchet fsck` that reports
unparseable lines, orphaned events, and duplicate ids.

### R9. `verify` throughput is the wall under the core economic claim

**Severity: medium. Status: FIXED in v0.2. Measured.** `src/verify.ts:41`, `src/runner.ts:19`

200 rows against a **trivial no-op check**, serial, one subprocess per row:

```
200 rows: 12514 ms  (~62 ms/row)
extrapolated: 2000 rows ~125 s ; 10000 rows ~625 s
```

That is pure spawn overhead before any check does work. The corpus is designed to
grow monotonically and never shrink, so "a past finding costs nothing ever again"
is false in the direction that decides whether anyone keeps this installed.
[NEXT_STEPS.md](NEXT_STEPS.md) costs *replay* (sampling, artifact caching,
parallelism) but not `verify`, which is the cost paid on every commit forever.

The 30 s timeout at `runner.ts:19` is hardcoded and no caller ever passes one, so
a hanging check costs 30 s per row with no way to tune it. On Windows with
`shell: true`, killing the shell may orphan the child process.

**Fix.** Batch a subject's inputs into one process invocation (amortize the
spawn); run rows in parallel with a worker pool; make the timeout configurable
per subject in `config.json`.

### R10. `bin`/`main` point at a path the build never emits

**Severity: medium. Status: FIXED in v0.2. Verified.** `package.json`

`bin.ratchet` and `main` are both `dist/index.js`. `tsconfig.json` sets
`rootDir: "."`, so `tsc` emits `dist/src/index.js`. `npm link` installs a
`ratchet` command that cannot start. `ratchet/README.md` documents the workaround
(`node dist/src/index.js`) without fixing the cause.

**Fix.** Point both at `dist/src/index.js`, or set `rootDir: "src"` and adjust the
test include.

### R11. Flag values are parsed as positionals

**Severity: medium. Status: FIXED in v0.2. Reproduced.** `src/index.ts:105,118,155`

`accept`, `reopen`, and `bisect` locate their positional id with
`rest.find(a => !a.startsWith("--"))`, which finds the *first* non-flag token —
including a flag's value when flags come first:

```
$ ratchet accept --reason "some reason" c0001
Error: no row some reason in corpus
```

It fails loudly rather than accepting the wrong row, which is the good version of
this bug, but the error is misleading and the ordering constraint is undocumented.
`capture` has the same shape: `rest.filter(a => !a.startsWith("--"))` would treat
a `--home` value as a capture file.

**Fix.** Parse flags into a map first, then take positionals from what remains.

### R12. `--home` is honored by 2 of 8 commands

**Severity: medium. Status: FIXED in v0.2. Verified.** `src/index.ts:98,148`

`verify` and `report` accept `--home`. `capture`, `accept`, `reopen`, and `note`
read `RATCHET_HOME` from the environment only, and `init` ignores both. The
carry-the-corpus workflow that `ratchet/README.md` documents therefore works for
half the commands.

**Fix.** Resolve the ratchet home once in `main()` from `--home` → `RATCHET_HOME`
→ `findRoot()`, and pass it explicitly to every command.

### R13. The accept ceremony cannot show what it is retiring

**Severity: medium. Status: FIXED in v0.2. Verified.** `src/verify.ts:56,70`

`verify` prints id, subject, and reason — never the input. There is no
`ratchet list` and no `ratchet show <id>`. The human performing the ceremony that
[RATCHET.md](RATCHET.md) calls "the load-bearing piece" cannot see the
counterexample they are permanently retiring, and after R5 the recorded `reason`
may not describe the stored input.

`inputString` at `src/verify.ts:70` does exactly this job and is never called from
anywhere in the codebase.

**Fix.** Print the input in `verify` output; add `ratchet show <id>` rendering the
full event history for a row (capture → accept → reopen with actors and reasons).

### R14. Config-missing and check-crashed both score as `fail`

**Severity: medium. Status: FIXED in v0.2. Reproduced.** `src/verify.ts:16,47`

`resolveCheck` throws for an unconfigured subject; the `catch` converts it to
`pass: false`. A missing config entry, a crashed check, and a genuine regression
are indistinguishable in output and all block the build:

```
✗ c0001 login works — Error: no subject config for "login works"
```

This is the third-outcome gap that [NEXT_STEPS.md](NEXT_STEPS.md) proposes as
`na(code)` / `na(env)`. It is not only a future need for replay — it is the
specific mechanism by which R7 produces a permanently red build today, which
argues for raising its priority.

**Fix.** Add `na` as a first-class result with a reason class, exclude it from the
pass/fail exit code, and surface the count separately in `verify` and `report`.

---

## Low

### R15. No machine-readable output

**Status: FIXED in v0.2. Verified.** `src/verify.ts:11`

`VerifyOptions.json` is declared and never read; no command emits structured
output. The PR bot and agent-attach that [RATCHET.md](RATCHET.md) describes both
need it, as does any CI annotation.

### R16. Dead code and a dishonest cast

**Status: FIXED in v0.2. Verified.** `src/verify.ts:70`, `src/accept.ts:22,46`

`inputString` is exported and unused (see R13). `accept`/`reopen` write
`source: row.source as "fast-check"` — the cast launders a `string` into a
narrower literal type; a junit-sourced row stores `"junit"` under a type that
says otherwise. No runtime effect, but it defeats the type checker at exactly the
seam where row provenance matters.

### R17. `nextRowId` is O(n²) across a capture run

**Status: FIXED in v0.2.** `src/paths.ts:24`

`nextRowId` reads and parses the entire corpus, and it is called once per captured
row inside the loop. Subsumed by the id-scheme change in R3.

### R18. `accept`/`reopen` are asymmetric on no-ops

**Status: FIXED in v0.2.** `src/accept.ts:13,33`

`accept` on an already-archived row throws. `reopen` on an already-active row
silently succeeds and writes a journal entry, so the journal accumulates
decisions that changed nothing.

### R19. The demo and the field-experiment artifacts are not committed

**Status: FIXED in v0.3. Verified.** `ratchet/.gitignore:3`

`ratchet/demo/` is gitignored, so the walkthrough that is the primary evidence for
the design is not in the repo (28 files committed in total). The four field
experiments in [EXPERIMENTS_RATCHET.md](EXPERIMENTS_RATCHET.md) rely on
`tools/ratchet-check.js` scripts living in the *target* repos; none are committed
here either. The experiments are the load-bearing evidence for the whole design
and none of them are reproducible from a clone.

### R20. `stableStringify` is unsound off the JSON value domain

**Status: FIXED in v0.3, latent. Verified.** `src/corpus.ts:5`

```
undefined -> undefined      (returns undefined, not a string; return type says string)
NaN       -> "null"         collides with null and Infinity as a dedup key
[1,undef] -> "[1,]"         not valid JSON; printed verbatim by `report`
new Date  -> "{}"           every Date, Map and Set shares one dedup key
```

Currently **unreachable**: all inputs arrive via `JSON.parse`, which cannot
produce these values. Recorded because the function is exported, is used for both
dedup keys and display, and its contract silently assumes a domain it does not
enforce.

### R21. No `engines` field

**Status: FIXED in v0.3.** `package.json`

`fs.cpSync` requires Node 16.7+ and `node --test` requires 18+, neither declared.

---

## What v0 gets right

Recorded because the defect list is long and the ideas underneath are not the
problem.

- **The check contract** — one JSON value on stdin, exit code as verdict, reason
  on stdout — is the right primitive. It is why the same instrument faces forward
  (staged commit) and backward (replay, bisect) with no special-casing, and why
  adopting a project's existing suite costs one config line.
- **Append-only with retirement-as-event** is the correct shape for an audit
  trail. The defects in R3/R4 are in the id scheme and the fold, not the model.
- **Capture-time discrimination** — skip a counterexample that already passes —
  is the right instinct. It needs to apply to all paths (R7) and to preserve the
  failure cause (R5), but the idea is sound and cheap.
- **Zero dependencies, zero model calls, plain files.** The adoption-wedge
  argument in [RATCHET.md](RATCHET.md) holds up, and the result is small enough
  that a reviewer can actually read all of it.
- **The demo reproduces exactly as documented.** `1/1 rows pass`, and `report`
  matches the README transcript line for line.

## Claim vs. implementation

Three statements in the docs are not true of the code as written. Each is a
one-line documentation fix once the corresponding defect is resolved.

1. **"Every capture runs dual-run discrimination"** — *resolved*. v0.2 made
   both sources run the reproduce check (R7); v0.4 added the second
   confirmation run, so [RATCHET.md](RATCHET.md)'s "a failure must reproduce
   twice to enter the corpus" is now true of the code. A check that disagrees
   between runs is reported as flaky and nothing is stored.
2. **"Merge behavior is trivial because it is append-only: no conflicts, ever"**
   — *the code half is resolved in v0.2* (content ids, timestamp fold,
   `merge=union`), but the sentence in [RATCHET.md](RATCHET.md) is still wrong
   as written: git does conflict on the trailing line without the merge driver,
   which is why `init` now ships one. Restate as "conflict-free **given** the
   union merge driver and content-addressed ids".
3. **"Frozen instrument — the check script is pinned across every commit... so
   readings are comparable by construction"**
   ([EXPERIMENTS_RATCHET.md](EXPERIMENTS_RATCHET.md)) — *resolved in v0.4*, and
   it took two mechanisms rather than one. Rows now record their owning-rule
   hash, so a reading taken under a different instrument is detectable
   (quarantine). And `{home}` lets the instrument live in the ratchet home,
   which history commands carry out of the working tree, so the same script
   measures every commit instead of each commit measuring itself. Without the
   second half the claim stayed false no matter how the rows were hashed.

## Measurements

| what | value |
|---|---|
| source size | 868 `src` / 177 tests (v0) → 1922 `src` / 732 tests (v0.3) |
| test suite | 11/11 pass, 5.4 s (v0) → 47/47 pass, 10.3 s (v0.4) |
| `verify` throughput | 62 ms/row serial (v0) → 20 ms/row at default concurrency (v0.3) |
| check timeout | 30 s hardcoded (v0) → per-subject `timeoutMs` (v0.3) |
| minimization budget | up to ~100 spawns/row, no overall cap |
| committed files in repo | 28 (demo and experiment artifacts excluded) |
| runtime dependencies | 0 |

The v0 suite covered the happy path of each module and none of the interaction
seams where every defect above lives — that is why 11/11 passed alongside two
critical findings. The v0.2 suite adds one regression test per closed defect,
which is where the runtime increase comes from: the R5 and R6 tests spawn real
subprocesses and drive a real git repository.

## Findings on NEXT_STEPS.md

Recorded here because they concern v0's evidence base, not the plan's ambition.

**What holds up.** Every design requirement is tied to a specific observed failure
or measurement, which is rare and worth keeping. Negative results are recorded as
results (particles' dense replay was clean; newportfolio's real finding was that
main is behind its own floor; visual rejection is uncatchable by design). The
`na(env)` / `na(code)` distinction is the strongest item in the document.

**Gaps.**

1. **Two plans, contradicting.** "Next experiments, in priority order" lists four
   items; "Conclusion for now" then names three different *implementation* steps
   and reorders everything. The document should state plainly whether the next
   move is more evidence or more code.
2. **The experiment design has a blind spot, and it is where the real defects
   live.** Four repos, four roles — all single-operator, single-branch,
   retrospective. Nothing in the requirements list touches corpus integrity: id
   allocation under branching, merge semantics, minimization fidelity, archived-row
   recurrence. R2–R5 are all in that class, and no field experiment as designed
   could have surfaced them. **The missing fifth role is "two people and a merge."**
3. **The subject-validation protocol is a convention with no mechanism.** "Every
   subject must be proven to fail on at least one known past bug before it can be
   captured from" is the best idea in either document and the only real answer to
   "who checks the checkers." It needs to be a command
   (`ratchet validate <subject> --known-bad <ref>`) that writes the proof into the
   corpus, or it erodes the first time someone is in a hurry. It appears in the
   requirements and then in neither the priority list nor the conclusion.
4. **Replay is costed; `verify` is not.** See R9.
5. **The frozen-instrument claim needs `rule_hash` before the replay tables mean
   what they say.** See "Claim vs. implementation" item 3.
6. Item 1 is headed **DONE** but ends "Remaining: capture it as a corpus row and
   run it through the accept ceremony." It is not done.

## Closed in v0.4 — the design gaps behind the findings

The 21 findings were defects in the prototype. Behind them sat five gaps
between [RATCHET.md](RATCHET.md) / [NEXT_STEPS.md](NEXT_STEPS.md) and what was
built. All five are now closed.

**Owning-rule hashes and quarantine.** Each row records the hash of its check
command plus the files the subject declares it `owns`. Rule unchanged and the
row fails → hard block. Rule edited since capture → quarantine: routed to
review, not counted as a regression, resolved by `ratchet reaffirm` (the
expectation stands under the new instrument) or `ratchet accept` (it does
not). This is the piece [RATCHET.md](RATCHET.md) calls load-bearing, and its
absence was the largest gap between the documents and the code.

**The frozen instrument.** A check written as `node check.js` runs whatever
the checked-out tree contains, so replay measured each commit with that
commit's own instrument. `{home}` now resolves to the ratchet home, which
history commands carry out of the tree, and `RATCHET_HOME` is exported to
every check. The same script measures every commit — which is what
"comparable by construction" actually requires.

**The second confirmation run.** A failure must now reproduce twice, with the
same signature, before it enters the corpus; disagreement is reported as a
flaky check and nothing is stored. `--confirm N` tunes it. The design promised
this and one run was happening.

**`ratchet replay` with sampling and halving.** `--every N` or
`--every day|week` samples, and any pass → fail transition is closed by
halving — coarse to fine. `--subjects` replays standing invariants rather
than corpus rows, which is what the field experiments actually did. Setup
failures at old commits are reported as `na-env` rather than as regressions,
and the environment each run happened under is recorded, which is the
`na(env)` half of the third-outcome requirement.

**`ratchet validate` and self-hosting.** The subject-validation protocol is a
command: prove the subject fails at a known-bad ref and passes at a known-good
one, with the proof written to the journal against the rule hash it was proven
under, so editing the check invalidates its own validation. The ratchet is now
configured over its own repository with five subjects, all validated against
`4abc1d5` — the last v0 commit, where those bugs lived. Replayed over its own
history it reports 0/5 passing at v0, 4/5 at v0.2, 5/5 at v0.3, reconstructing
the fix history unaided.

Two of those five subjects **failed their own validation** on the first
attempt: they exercised `minimize` and `foldRows` in isolation while the
defects lived in the capture path that calls them, so they passed straight
through the bug they were written for. The protocol caught them. That is the
single best piece of evidence in this document that it is worth having.

## What comes next

Not defects — unbuilt design from [RATCHET.md](RATCHET.md):

1. **Mode 2, mine.** `ratchet history` walking test-file history to resurrect
   deleted and weakened assertions.
2. **Mode 3, semantic history.** Behavioral diff between two commits.
3. **Behavior snapshots and metric budgets.** The baseline-relative form, which
   is the only one that survives shared CI runners.
4. **Static checks and the PR bot.** `--json` is in place; nothing consumes it.
5. **Per-branch corpora**, still an open product question from
   [NEXT_STEPS.md](NEXT_STEPS.md).

Self-hosting ([NEXT_STEPS.md](NEXT_STEPS.md) experiment 4) should move up. A
ratchet subject asserting "the corpus folds to the same row count after a
simulated merge" would have caught R3; "every stored row still reproduces its
recorded reason" would have caught R5.
