# Ratchet — v0 prototype

Regression memory for AI-assisted development. The design sketch is
[../RATCHET.md](../RATCHET.md); this folder is the first working slice.

Zero runtime dependencies. Zero model calls. The corpus is plain JSONL; the
journal is plain JSONL; everything is a file git already knows how to commit.

## Running against a local repo

1. Build once: `cd ratchet && npm install && npm run build`
2. `alias ratchet="node /path/to/ratchet/dist/src/index.js"` (or `npm link`)
3. In the target repo: `ratchet init`, then edit `.ratchet/config.json` — for
   each subject, a `check` command that reads one input as JSON on stdin and
   exits 0 (pass) or nonzero (fail).
4. Wire the fast-check reporter from `demo/property.js` into your property
   tests, or point `ratchet capture` at CI's JUnit XML.

The CLI finds `.ratchet/` by walking up from the working directory, so run it
from anywhere inside the repo.

**Checked out an old commit and want today's memory?** The corpus travels with
the commit, like tests do. Carry it over explicitly:

```
$ MEM=$(mktemp -d); cp -r .ratchet "$MEM/"
$ git checkout <old-commit>
$ ratchet verify --home "$MEM/.ratchet"   # today's corpus, old code
```

The same mechanism backs `ratchet bisect`, which does the carrying for you.

## Commands

```
ratchet init                      create .ratchet/ with a config template
ratchet capture <file...>         add counterexamples (fast-check capture JSON or junit.xml)
ratchet verify [--row id] [--subject name] [--quiet]
ratchet accept <id> --reason "..." [--actor name]
ratchet reopen <id> --reason "..." [--actor name]
ratchet note --text "..." [--actor name]
ratchet report                    corpus stats and churn summary
ratchet bisect <id> --good ref --bad ref
```

Run via `node dist/src/index.js <command>` from anywhere inside the project.

## Config

`.ratchet/config.json` maps subjects to check commands:

```json
{
  "subjects": {
    "roundtrip": {
      "check": "node check.js roundtrip",
      "captureProperty": "roundtrip"
    }
  }
}
```

- `check` — a command that reads one input as JSON on stdin and exits 0
  (pass) or nonzero (fail). Stdout is the failure reason.
- `captureProperty` — binds a fast-check property name to this subject.
- A check containing `{test}` substitutes the test name (for JUnit rows).

## Capture sources

- **fast-check** — a custom reporter writes `ratchet-capture.json` on failure
  (see `demo/property.js`); `ratchet capture` reads it.
- **JUnit XML** — `<failure>` test cases become rows keyed by test name.
- Anything else: hand-write the capture JSON shape and capture it.

Every capture runs **dual-run discrimination**: a counterexample that already
passes is skipped, never stored. Array/string/number inputs are minimized
(ddmin) before storage.

## The accept ceremony

A failing active row is a hard block — `ratchet verify` exits 1. When the
behavior changed on purpose, `ratchet accept <id> --reason "..."` retires the
row: it stops enforcing, the audit trail keeps every event, and the reason is
journaled. `ratchet reopen` restores a row.

## Bisect (retroactive replay)

`ratchet bisect <id> --good ref --bad ref` binary-searches the commit list and
reports the first commit where the row fails. The corpus is carried out of the
working tree during the search, so checking out old commits cannot erase it.
The working tree must be clean.

## Layout

```
.ratchet/
  config.json      # subjects → check commands (authored)
  corpus.jsonl     # append-only capture/accept/reopen events (committed)
  journal.jsonl    # append-only decisions (committed)
```

## Build & test

```
npm install
npm run build
npm test
```

## What v0 deliberately leaves out

See [../RATCHET.md](../RATCHET.md) for the full design. Not yet here:

- owning-rule hashes and quarantine (the heuristic-change analysis)
- behavior snapshots and sampled behavioral diffs
- the churn report's catch-rate vs. new-bug split (report prints counts today)
- `ratchet history` (mining deleted/weakened tests from commit history)
- metric budgets, static checks, PR bot, agent attach
