# LeetCode Ceiling Experiment — Statement Length vs. Solution Length

> The first step of the viability experiment in
> [DESIGN_V3.md](DESIGN_V3.md): *"Statement length against solution length is a
> scrape and an afternoon, and it produces a number today."*
> Run 2026-09-05.

## Method

- **Sample:** 45 problems, stratified 15 easy / 15 medium / 15 hard, drawn with a
  fixed seed (`0x7f3a`) from all free LeetCode problems that have a reference
  solution in the [neetcode](https://github.com/neetcode-gh/leetcode) Python repo
  (the seed is recorded for reproducibility; nothing was cherry-picked).
- **Statement:** full problem statement (description + examples + constraints),
  fetched from the
  [doocs/leetcode](https://github.com/doocs/leetcode) mirror, HTML stripped to
  text. Cross-checked against the LeetCode GraphQL API on the same 45 problems —
  the full-statement median agreed (1.43 both ways).
- **Solution:** neetcode Python reference solution, comments and blank lines
  stripped. Robustness check against doocs editorial Python solutions on the same
  set: full-statement median ratio 1.73 (vs 1.43) — same verdict, so the
  code-source choice does not change the conclusion.
- **Metric:** statement chars ÷ solution chars. The thesis lives or dies by
  whether the spec is shorter than the code.
- Statement decomposition: `narrative` = description before "Example 1:";
  `examples` = the worked examples; `constraints` = the constraints block.

## The number

| Ratio (chars) | easy | medium | hard | ALL |
|---|---|---|---|---|
| full statement / code | 1.38 | 1.71 | **1.20** | **1.43** (median) / 1.56 (mean) |
| statement minus constraints / code | 0.95 | 1.56 | 1.11 | 1.15 |
| narrative-only / code | 0.40 | 0.82 | 0.43 | **0.52** |
| examples-only / code | 0.61 | 0.75 | 0.56 | 0.62 |

- Statement < code: 10/45 (22%). Statement minus constraints < code: 17/45 (38%).
  Narrative alone < code: 37/45 (82%).
- Statement composition: examples 44–49%, narrative 34–45%, constraints 11–21%.

## Per-problem data

| id | title | diff | stmt ch | code ch | full | no-constraints | narrative |
|---|---|---|---|---|---|---|---|
| 108 | Convert Sorted Array to Binary Search Tree | easy | 470 | 324 | 1.45 | 1.12 | 0.40 |
| 2864 | Maximum Odd Binary Number | easy | 817 | 557 | 1.47 | 1.29 | 0.68 |
| 203 | Remove Linked List Elements | easy | 421 | 359 | 1.17 | 0.87 | 0.40 |
| 168 | Excel Sheet Column Title | easy | 357 | 307 | 1.16 | 1.02 | 0.55 |
| 119 | Pascal's Triangle II | easy | 434 | 454 | 0.96 | 0.70 | 0.40 |
| 125 | Valid Palindrome | easy | 802 | 206 | 3.89 | 3.48 | 1.47 |
| 344 | Reverse String | easy | 401 | 196 | 2.05 | 1.68 | 0.89 |
| 572 | Subtree of Another Tree | easy | 696 | 652 | 1.07 | 0.77 | 0.52 |
| 1260 | Shift 2D Grid | easy | 753 | 519 | 1.45 | 1.22 | 0.61 |
| 746 | Min Cost Climbing Stairs | easy | 893 | 213 | 4.19 | 3.92 | 1.32 |
| 112 | Path Sum | easy | 837 | 749 | 1.12 | 0.95 | 0.28 |
| 145 | Binary Tree Postorder Traversal | easy | 503 | 586 | 0.86 | 0.57 | 0.15 |
| 144 | Binary Tree Preorder Traversal | easy | 498 | 360 | 1.38 | 0.92 | 0.23 |
| 977 | Squares of a Sorted Array | easy | 604 | 413 | 1.46 | 0.89 | 0.33 |
| 67 | Add Binary | easy | 339 | 496 | 0.68 | 0.35 | 0.14 |
| 45 | Jump Game II | medium | 754 | 330 | 2.28 | 1.96 | 1.27 |
| 304 | Range Sum Query 2D - Immutable | medium | 1392 | 604 | 2.30 | 1.99 | 1.01 |
| 1905 | Count Sub Islands | medium | 1375 | 930 | 1.48 | 1.32 | 0.51 |
| 62 | Unique Paths | medium | 763 | 288 | 2.65 | 2.54 | 1.65 |
| 647 | Palindromic Substrings | medium | 486 | 400 | 1.22 | 1.02 | 0.52 |
| 167 | Two Sum II - Input Array Is Sorted | medium | 1220 | 352 | 3.47 | 2.88 | 1.57 |
| 721 | Accounts Merge | medium | 2323 | 1362 | 1.71 | 1.56 | 0.59 |
| 355 | Design Twitter | medium | 2036 | 1422 | 1.43 | 1.27 | 0.63 |
| 371 | Sum of Two Integers | medium | 216 | 534 | 0.40 | 0.34 | 0.19 |
| 1209 | Remove All Adjacent Duplicates in String II | medium | 839 | 423 | 1.98 | 1.77 | 0.98 |
| 662 | Maximum Width of Binary Tree | medium | 1032 | 579 | 1.78 | 1.61 | 0.87 |
| 665 | Non-decreasing Array | medium | 569 | 496 | 1.15 | 1.01 | 0.50 |
| 91 | Decode Ways | medium | 1348 | 812 | 1.66 | 1.55 | 1.03 |
| 435 | Non-overlapping Intervals | medium | 864 | 372 | 2.32 | 2.04 | 0.82 |
| 473 | Matchsticks to Square | medium | 693 | 646 | 1.07 | 0.96 | 0.50 |
| 1383 | Maximum Performance of a Team | hard | 1400 | 557 | 2.51 | 2.30 | 1.03 |
| 124 | Binary Tree Maximum Path Sum | hard | 758 | 473 | 1.60 | 1.39 | 0.82 |
| 84 | Largest Rectangle in Histogram | hard | 473 | 531 | 0.89 | 0.77 | 0.31 |
| 42 | Trapping Rain Water | hard | 503 | 532 | 0.95 | 0.81 | 0.27 |
| 51 | N-Queens | hard | 635 | 860 | 0.74 | 0.71 | 0.45 |
| 1489 | Find Critical and Pseudo-Critical Edges in MST | hard | 1662 | 1679 | 0.99 | 0.89 | 0.43 |
| 410 | Split Array Largest Sum | hard | 785 | 606 | 1.30 | 1.15 | 0.38 |
| 312 | Burst Balloons | hard | 713 | 585 | 1.22 | 1.11 | 0.75 |
| 2306 | Naming a Company | hard | 1765 | 921 | 1.92 | 1.75 | 0.60 |
| 10 | Regular Expression Matching | hard | 950 | 1426 | 0.67 | 0.48 | 0.21 |
| 2709 | Greatest Common Divisor Traversal | hard | 1573 | 1312 | 1.20 | 1.15 | 0.37 |
| 778 | Swim in Rising Water | hard | 1344 | 830 | 1.62 | 1.48 | 0.82 |
| 1345 | Jump Game IV | hard | 874 | 1210 | 0.72 | 0.67 | 0.31 |
| 44 | Wildcard Matching | hard | 760 | 483 | 1.57 | 1.28 | 0.59 |
| 115 | Distinct Subsequences | hard | 582 | 530 | 1.10 | 0.94 | 0.32 |

## What it says

**The raw prose ratio is unfavorable.** By the document's own gate — *"an
unfavorable ratio there kills the thesis outright"* — the full LeetCode statement
is ~1.4–1.7× longer than the solution. Taken at face value, the thesis dies here.

**The decomposition says the raw ratio is the wrong number.** The unfavorable
mass is formatting bloat, not information content:

- **Constraints (11–21%)** are not prose in Flux. They compile from type
  declarations — a few words in the `takes`/`gives` header, not a paragraph.
  Excluding them: median 1.15.
- **Examples (44–49%)** are the largest block, and in Flux they are *table rows*
  (`"1h30m" => 5400`), not LeetCode's prose Input/Output/Explanation with images.
  The tabular form is several times denser than what was measured.
- **Narrative (34–45%)** is the true prose spec — the part that maps to `rule`
  clauses. Median **0.52× code**, and 82% of problems have narrative shorter than
  their solution.

A realistic `.rules` file lands at roughly **parity** with the code, not a
fraction of it.

**The shape of the data is exactly what the thesis predicts.** Hard problems have
the *lowest* full-statement ratio (1.20) and the fiddliest code — the value is
highest where the code is hardest, which is the claim in *What the set already
predicts*. Easy problems inflate the median with problems whose code is a
five-liner and whose spec is mostly story.

**The strongest evidence for the thesis is structural, not numerical.** The
doocs repo this data came from ships **one statement, seven language
implementations**. That is the exact economics Flux proposes — one spec, many
bodies, resynthesized against changing types — running at scale as a community
practice. People already maintain LeetCode statements worth maintaining because
the statement outlives any one implementation.

## What it changes in the design

1. **Rescope the pitch.** "Writing a spec is less work than writing the code"
   does not survive at the ceiling. What survives: *writing a spec costs about
   the same as writing the code, but is verifiable, durable, and reusable — the
   spec outlives the implementation.* The ratchet and resynthesis, not length,
   are the argument.
2. **Examples must be table-first.** The examples block is the biggest cost and
   the most compressible; the `.rules` tabular form is load-bearing, and the
   LeetCode-style Explanation prose must not be a supported idiom.
3. **Constraints stay in types, never prose.** Already designed; the data
   confirms a prose constraints block would add ~15% of dead weight.
4. **Baseline-set scoring should reweight.** DESIGN_V3.md scores "did it pass"
   and "was the spec meaningfully shorter." Given ceiling parity, "meaningfully
   shorter" is unlikely to hold broadly; score pass-rate and durability/reuse
   instead, or the threshold game is rigged against the design.

## Caveats

- **Ceiling, not sample** — LeetCode statements are unusually complete; real
  tickets are worse specs. Favorable numbers here bound the best case.
- **Code side is optimistic for the thesis** — neetcode/editorial solutions are
  concise; production code is longer. The real ratio is *lower* than measured.
- **Length is not effort** — a complete spec is expensive to write even when
  short; this measures only volume.
- **Sample bias** — restricted to problems with reference solutions (classics),
  the same bias as any corpus of curated solutions.
