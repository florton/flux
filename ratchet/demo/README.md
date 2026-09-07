# Ratchet demo

A duration parser with a seeded git history, used to walk the ratchet loop end
to end.

```
$ node demo/setup.js          # builds demo/repo/ with the five-commit history
$ cd demo/repo && npm install
$ R="node ../../dist/src/index.js"
```

The repository is generated rather than committed: it needs its own `.git` to
demonstrate replay, and a nested `.git` cannot live inside this one. `setup.js`
is the source of truth, so the walkthrough below is reproducible from a clean
clone. Commit hashes differ per generation; the ids below are illustrative.

Row ids are content-addressed (a hash of subject + input), so the same
counterexample gets the same id on every machine and two branches that find it
independently converge instead of colliding. Any unambiguous prefix works
wherever an id is accepted — `$R accept c909b7` is enough.

## The history

```
433856a (v1)             duration functions + property + ratchet skeleton      property passes
7851c83 (broken)         optimize hour parsing                                  property FAILS (1h parses as 60)
bc0f9b2                  fix hour parsing                                       property passes
9b7c5c4 (intentional-zero) format zero as empty string                          property FAILS (0 no longer round-trips)
6296fe1 (v2)             spec update: zero is '' by design                      property passes
```

The property: `parseDuration(formatDuration(n)) === n` for `n >= 0` (n >= 1
plus an explicit zero contract after v2). `property.js` writes
`ratchet-capture.json` on failure via a fast-check reporter.

## Walkthrough

### 1. Capture a counterexample at the broken commit

The corpus is carried in a temp home so the checkout cannot erase it — the
same mechanism `bisect` uses internally.

```
$ MEM=$(mktemp -d); cp .ratchet/config.json "$MEM/"; : > "$MEM/corpus.jsonl"; : > "$MEM/journal.jsonl"
$ git checkout broken
$ node property.js                          # fails, writes ratchet-capture.json
property failed after 1 tests: Error: Property failed by returning false

$ $R capture --home "$MEM" ratchet-capture.json
+ c909b7deb1e1f roundtrip 3600
1 added, 0 skipped
```

The counterexample (3600) reproduced against the current code, was minimized
while preserving its failure cause, and was pinned.

### 2. Fix present: the row passes again

```
$ git checkout main
$ $R verify --home "$MEM"
✓ c909b7deb1e1f roundtrip

1/1 rows pass
```

### 3. The corpus rides the PR

```
$ cp "$MEM"/*.jsonl .ratchet/
$ git add .ratchet && git commit -m "capture regression row c909b7d"
```

### 4. Retroactive replay: which commit introduced it?

```
$ $R bisect c909b7d --good v1 --bad broken
bisecting row c909b7d (good=v1, bad=broken)...
first bad commit: 7851c831d35cf8fb6cb428761341d7f6cd530a41  (2 probes)   # "optimize hour parsing"
```

The search runs in a detached `git worktree`. Your checkout never moves, a
dirty working tree is fine, and an error part-way through cannot strand the
repository on a detached HEAD. For a project that needs installed
dependencies at each probe, pass `--setup "npm ci"`.

### 5. The accept ceremony

The team changes `formatDuration(0)` from `"0s"` to `""` on purpose (v2
updates the spec). The old round-trip expectation for 0 is captured, fails,
and is retired with a reason:

```
$ cat > capture-zero.json <<'EOF'
[{"property":"roundtrip","counterexample":[0],"error":"round-trip broken for zero after the format change"}]
EOF
$ $R capture capture-zero.json
+ c2b52c6881340 roundtrip 0
1 added, 0 skipped

$ $R verify
✓ c909b7deb1e1f roundtrip
✗ c2b52c6881340 roundtrip 0 — exit 1

1/2 rows pass, 1 failing

$ $R accept c2b52c6 --reason "formatDuration(0) === '' is the intended behavior — spec updated in commit 6296fe1" --actor alice
accepted c2b52c6881340 — expectation retired, audit trail retained

$ $R verify
✓ c909b7deb1e1f roundtrip

1/1 rows pass
```

### 6. When a retired expectation comes back

Accepting a row says "this behavior is intended *now*" — not "never tell me
about this input again." If the same counterexample starts failing again, the
capture is not silently deduplicated against the archived row:

```
$ $R capture capture-zero.json

[!] REGRESSION RECURRED — c2b52c6881340 roundtrip
    retired 2026-09-06T05:59:45Z by alice: formatDuration(0) === '' is the intended behavior
    that accepted behavior is failing again
    reopen it with: ratchet reopen c2b52c6 --reason "..."

0 added, 0 skipped, 1 recurred
$ echo $?
1
```

`--reopen` does it in one step and journals the decision.

### 7. Report

```
$ $R report
corpus: 2 rows (1 active, 1 archived) — +2 this week
sources: fast-check 2
journal: 1 entries
retirements: 1 accepted via ceremony
```

### 8. Regression memory survives checkout

At the broken commit, with the corpus carried in from main, the ratchet still
knows:

```
$ MEM=$(mktemp -d); cp -r .ratchet "$MEM/"
$ git checkout broken
$ $R verify --home "$MEM/.ratchet"
✗ c909b7deb1e1f roundtrip 3600 — exit 1

0/1 rows pass, 1 failing
```

## Visual regression: pinning the pixels

The same machinery that watches the round-trip also watches pixels — the
row's check just becomes "render the page, compare against the pinned
baseline, report the diff as the witness". This demo's "browser" is a
deterministic JS renderer (`render-page.js`) drawing the home page from the
design tokens in `page-spec.json`; a real project would run Playwright here
and the ratchet side would not change.

```
<home page with an ocean theme>     renderer + spec land, nothing pinned yet
<pin>                               pin the home page pixels (ratchet visual row)
(visual-bug) theme refresh: warm accent on the home page     the pixels move
(revert theme back to ocean)                                  pixels return
```

`visual-bug`'s parent, the pin commit, recorded the visual row:
`.ratchet/visual/<id>.png` holds the baseline and `corpus.jsonl` holds the
capture event with `"source": "visual"`.

### 1. Pinned pixels pass — and a change does not

```
$ $R verify
✓ c32e0364b168e home-page

1/1 rows pass

$ git checkout visual-bug
$ $R verify
✗ c32e0364b168e home-page {"file":".ratchet-visual/home.png"} — rendered home page (spec: lava)
  visual diff: 100% of 64000 pixels (64000, bbox 320x200 at (0,0), max channel delta 164) —
  actual: visual/c32e0364b168e-actual.png — diff: visual/c32e0364b168e-diff.png

0/1 rows pass, 1 failing
```

That one line on stdout is the witness — normalized, it feeds failure
signatures and drift detection exactly like the round-trip's message does.
The `-actual.png` and `-diff.png` files are review artifacts for the
developer and are gitignored; `.ratchet/visual/<id>.png` (the baseline) is
committed.

### 2. Which commit moved the pixels?

```
$ $R bisect c32e036 --good de9c8ca --bad visual-bug
bisecting row c32e036 (good=de9c8ca, bad=visual-bug)...
first bad commit: ccb4d1e379273  (2 probes)   # theme refresh: warm accent on the home page
```

### 3. The ceremony, for pixels too

The change was on purpose — the theme is visibly being refreshed. What the
ratchet must never allow is re-deriving the expectation silently, so the
retirement is on the record and the new baseline goes through the same
capture:

```
$ $R accept c32e036 --reason "warm accent theme is the intended design going forward" --actor alice
accepted c32e0364b168e — expectation retired, audit trail retained

$ $R visual record home-page --file .ratchet-visual/home.png --actor alice
recorded c32e0364b168e home-page — baseline .ratchet/visual/c32e0364b168e.png (sha256 e2b5a095a161…, size 1357 bytes)
note: this row was retired — the new capture re-activates it

$ $R verify
✓ c32e0364b168e home-page

1/1 rows pass
```

`$R show c32e036` tells the whole story — capture, accept, re-record — and
`$R fsck` audits the baseline against the recorded hash, so a hand-edited
PNG is mechanical corruption, not a mystery.

## The witness

`check.js` prints why it failed, which is the strong form of the check
contract:

```
$ $R show c1ae26
  input:     3600
  witness:   exit:1|round-trip failed: <n> formatted to <s> and parsed back as <n>
```

That normalized signature is what lets reduction stay on the captured bug
instead of walking onto an unrelated one, and what lets `verify` say "this
row is failing, but not for the reason it was created to watch". A check
that exits nonzero and prints nothing still works — its signature just
degrades to `exit:1`, and both guarantees weaken to "still exits nonzero".

## Other commands worth trying here

```
$ $R list                    # every row, active (●) and archived (○)
$ $R show <id>               # one row: input, witness, full event history, journal
$ $R fsck                    # corpus integrity: bad lines, orphans, tampered ids
$ $R verify --json           # machine-readable, for CI annotation
$ $R verify --jobs 8         # rows checked in parallel
```

This history is small enough to replay densely, and it has exactly one real bug
in it, so both history commands have something to find:

```
$ $R replay --good v1 --bad main
replay: 4 of 4 commits (dense)
environment: node v20.9.0 on win32/x64

  ✗ 922e7daa  0 pass, 1 fail  optimize hour parsing
  ✓ 8f9e3694  1 pass, 0 fail  format zero as empty string
  ...
```

`validate` proves the subject is strong enough to be worth trusting — it must
fail at a commit known to contain the bug, and pass at one known not to:

```
$ $R validate roundtrip --known-bad broken --known-good v1 --input 3600
  ✓ known-bad  922e7daa "optimize hour parsing" — fails as required:
      round-trip failed: 3600 formatted to "1h" and parsed back as 60
  ✓ known-good c572188e "duration functions..." — passes as required

validated — proof recorded in the journal against this rule hash
```

A subject that passes through the known bug is refused, and no proof is
recorded. Try it by pointing `validate` at a subject that asserts nothing.
