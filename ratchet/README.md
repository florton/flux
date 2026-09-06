# Ratchet — v0.3 prototype

Regression memory for AI-assisted development. The design sketch is
[../RATCHET.md](../RATCHET.md); this folder is the first working slice.

> **Status.** All 21 issues from the v0 review
> ([../ISSUES_RATCHET.md](../ISSUES_RATCHET.md)) are closed. v0.2 fixed the
> seven correctness and security defects; v0.3 adds the third check outcome
> (`na`), `fsck`, `list`, `show`, `--json`, parallel `verify` (3.1× faster),
> the packaging fix, and a generated demo that is reproducible from a clone.
> 33 tests, including a regression test per defect.

Zero runtime dependencies. Zero model calls. The corpus is plain JSONL; the
journal is plain JSONL; everything is a file git already knows how to commit.

## Running against a local repo

1. Build once: `cd ratchet && npm install && npm run build`
2. `alias ratchet="node /path/to/ratchet/dist/src/index.js"`
3. In the target repo: `ratchet init`, then edit `.ratchet/config.json` — for
   each subject, a `check` command that reads one input as JSON on stdin and
   exits 0 (pass) or nonzero (fail).
4. Wire a fast-check reporter into your property tests (`demo/setup.js`
   generates a working one), or point `ratchet capture` at CI's JUnit XML.

The CLI finds `.ratchet/` by walking up from the working directory, so run it
from anywhere inside the repo. `--home <dir>` overrides that for every
command.

**Checked out an old commit and want today's memory?** The corpus travels with
the commit, like tests do. Carry it over explicitly:

```
$ MEM=$(mktemp -d); cp -r .ratchet "$MEM/"
$ git checkout <old-commit>
$ ratchet verify --home "$MEM/.ratchet"   # today's corpus, old code
```

`ratchet bisect` does the carrying for you.

## Commands

```
ratchet init                      create .ratchet/ with a config template
ratchet capture <file...>         add counterexamples (fast-check capture JSON or junit.xml)
                                  [--reopen] put retired rows back when they recur
ratchet verify [--row id] [--subject name] [--quiet] [--jobs N]
ratchet list [--status active|archived] [--subject name]
ratchet show <id>                 a row's input, witness, history and journal
ratchet accept <id> --reason "..." [--actor name]
ratchet reopen <id> --reason "..." [--actor name]
ratchet note --text "..." [--actor name]
ratchet report                    corpus stats and churn summary
ratchet fsck                      corpus and journal integrity check
ratchet bisect <id> --good ref --bad ref [--setup "npm ci"]
```

Every command accepts `--home <dir>` and `--json`. Row ids are
content-addressed; any unambiguous prefix works where an id is expected.

## Config

`.ratchet/config.json` maps subjects to check commands:

```json
{
  "subjects": {
    "roundtrip": {
      "check": "node check.js roundtrip",
      "captureProperty": "roundtrip"
    },
    "suite": {
      "check": "npm test",
      "shell": true
    }
  }
}
```

- `check` — a command that reads one input as JSON on stdin and exits 0
  (pass) or nonzero (fail). **Stdout is the failure reason, and it is load-
  bearing** — see "The witness" below.
- `captureProperty` — binds a fast-check property name to this subject.
- `shell` — run `check` through a shell. Off by default.
- `timeoutMs` — per-subject timeout. Default 30000.

### How checks are executed

By default the command is tokenized (quotes group, backslashes stay literal)
and spawned directly with no shell, so nothing substituted into it can become
syntax. A check containing `{test}` gets the test name as **exactly one argv
element**; the name is also exported as `RATCHET_TEST`.

Set `"shell": true` for pipes, `&&`, or a `.cmd`/`.bat` entry point. The
command string is then your own committed config, at the same trust level as
a Makefile target — but the test name is still never interpolated into it, so
`{test}` is refused in shell mode and the check must read `RATCHET_TEST`.

## Capture sources

- **fast-check** — a custom reporter writes `ratchet-capture.json` on failure
  (`demo/setup.js` generates a working one); `ratchet capture` reads it.
- **JUnit XML** — `<failure>` test cases become rows keyed by test name.
- Anything else: hand-write the capture JSON shape and capture it.

Every capture, from every source, goes through the same gate:

1. **Discrimination.** The counterexample must reproduce against the current
   code. One that already passes is skipped, never stored.
2. **Configured subject required.** A binding whose subject has no `check`
   is reported and dropped, not stored — an unverifiable row would otherwise
   fail forever with "no subject config", reddening the build over a config
   gap rather than a regression.
3. **Cause-preserving reduction.** Array, string, and number inputs are
   minimized (ddmin), but a smaller input is only accepted if it fails the
   *same way*; the reduced input is re-confirmed before storage.
4. **Dedup by content, split by status.** An identical active row is a
   duplicate. An identical *archived* row is a recurrence, and is reported
   loudly with a nonzero exit — see the ceremony below.

## The witness

Each row stores a normalized signature of the failure it was captured for
(`exit:1|expected <n>, got <n>`). It is what keeps reduction honest, and
`verify` uses it to flag a row that is failing for a reason other than the
one it was created to watch:

```
✗ c398849eeeec4 s 1000 — divide by zero  [!] different failure than the one captured
```

A check that prints nothing on failure degrades to `exit:<code>`, which is a
much weaker guarantee. Printing why you failed is what buys the strong one.

## The three outcomes

A check exits 0 to pass and nonzero to fail. It may also exit **125** to say
*not applicable at this commit* — the third outcome, borrowed from
`git bisect skip`:

```
✓ c87cb67944d6f s
✗ cfd1f483d53bf s 13 — unlucky
− c74cef33855a7 s 7 — n/a: feature absent at this commit

2/4 rows pass, 1 failing, 1 n/a
```

`na` is neither a pass nor a failure and does not fail the build, which is
what replay across history needs: a check that cannot apply to a 2019 commit
should not be scored as a bug there. A check that cannot be *spawned* stays a
failure — that is indistinguishable from a broken config, and silently
greening it would be the false pass this tool exists to prevent.

## Integrity

`ratchet fsck` reports unreadable lines, orphaned accept/reopen events,
subjects with no configured check, and rows whose id does not match their own
content. That last one is only possible because ids are content-addressed: a
hand-edited or corrupted row is mechanically detectable.

`verify` refuses to run at all against a corpus with unreadable lines — a row
hidden behind a parse error is a false pass — and names the line.

## The accept ceremony

A failing active row is a hard block — `ratchet verify` exits 1. When the
behavior changed on purpose, `ratchet accept <id> --reason "..."` retires the
row: it stops enforcing, the audit trail keeps every event, and the reason is
journaled.

Accepting says "this behavior is intended *now*", not "never mention this
input again". If the same counterexample fails again later, `capture` reports
it as a recurrence — citing who retired it and why — and exits nonzero.
`--reopen` puts it back into enforcement and journals that decision.

## Bisect (retroactive replay)

`ratchet bisect <id> --good ref --bad ref` binary-searches the commit range
and reports the first commit where the row fails. It runs entirely inside a
detached `git worktree`: your checkout never moves, a dirty working tree is
fine, and the worktree is torn down even when a probe throws. When the range
contains merges the search follows first-parent, because a binary search over
a non-linear list is not sound. `--setup "npm ci"` runs a command in the
worktree before each probe.

## Layout

```
.ratchet/
  config.json      # subjects → check commands (authored)
  corpus.jsonl     # append-only capture/accept/reopen events (committed)
  journal.jsonl    # append-only decisions (committed)
  .gitattributes   # merge=union for the two JSONL files
```

Row ids are `c` + the first 12 hex of `sha256(subject + input)`. Sequential
ids were allocated from local file state, so two branches both minted `c0001`
and the merge silently dropped one row; content addressing makes id
allocation and dedup the same operation. Events are replayed in timestamp
order, not file order, so a merge that lands an `accept` above its `capture`
still retires the row.

## Build & test

```
npm install
npm run build
npm test
```

33 tests, including one regression test per defect closed from the v0 review.
The demo is generated by `node demo/setup.js`; see [demo/README.md](demo/README.md).

## What this prototype still leaves out

From the design in [../RATCHET.md](../RATCHET.md), still absent: owning-rule
hashes and quarantine, behavior snapshots and sampled behavioral diffs, the
churn report's catch-rate vs. new-bug split, `ratchet history`, metric
budgets, the PR bot, and agent attach.
