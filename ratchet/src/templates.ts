/**
 * What `ratchet init` writes.
 *
 * The rules file ships with a worked, commented example rather than empty. The
 * closed vocabulary is the part a new user has to discover, and a file that
 * shows the shape is worth more than a manual page they will not open — the
 * whole premise of prose heuristics is that the person who knows the domain
 * can contribute without reading a reference first.
 */
export const RULES_TEMPLATE = `# Heuristics, in prose. Each block below is a subject that \`ratchet verify\`
# enforces on every commit.
#
#   run      the command that produces the observation
#   measure  how to read a number or a string out of what it printed
#   rule     what must be true of that value            (checked)
#   rejects  a reading the rules must refuse            (checked, and it is
#            how a check that has never failed here proves it can fail at all)
#   note     anything the vocabulary cannot say         (never checked)
#   because  why this matters, quoted back on failure
#
# Write clauses however they come out -- "should be greater than 5" is fine;
# \`ratchet fmt\` snaps them to the canonical vocabulary. What it cannot resolve
# it reports with a line number and a suggestion, never a guess.
#
# Ways to measure:
#   the number after "LABEL"              the first number following that text
#   the 2nd number after "LABEL"          ...following its 2nd appearance
#   the json field a.b.c                  parse stdout as JSON, read a path
#   the count of lines matching "TEXT"    how many output lines contain it
#   the exit code                         the command's own status
#   the output                            all of stdout, trimmed
#
# Ways to check one:  is / is not / is one of / is above / is below /
#   is at least / is at most / is between N and M / is within P percent of N /
#   contains / does not contain / starts with / ends with / is empty /
#   is a number / is the same as ANOTHER-MEASURE
#
# The four comparisons take either a number or another measure of the same
# run, so "change is above keep" says what it looks like it says.
#
# Bounds written the ordinary way land on those four: "under" and "over",
# "no more than", "must not exceed", "should never be above". A negation folds
# into the comparison it negates, so "never above 100" is "is at most 100".
# What the table cannot resolve it refuses with a line and a column -- it
# never guesses. "is faster than 5" is refused on purpose: whether that is a
# ceiling or a floor depends on what you are measuring, and only you know.
#
# Ways to prove a check can fail, strongest first:
#   ratchet adopt <name> --good <old-ref>   it failed where a real bug lived
#   rejects <measure> <value>               the rules refuse that reading
#   rejects output "..."                    the rules refuse that whole output
#
# A \`rejects\` line is checked, not asserted: if every rule accepts the reading
# you declared, that is an error with a line and a column. It is what lets an
# invariant that has never been violated here -- arithmetic, a conservation
# law, "the build works" -- enforce without inventing a bug it never had.
#
# When a check does not apply, say which kind:
#   applies when <path> exists   this feature did not exist at that commit
#   needs <path> exists          this environment cannot run the check here
#
# Delete the example below once you have your own.

# heuristic every-card-has-an-image
#   run      node tools/audit-cards.js
#   measure  missing  the number after "cards without images:"
#   rule     missing is 0
#   rejects  missing 1
#   because  a card with no image renders as an empty box in the grid
`;

/**
 * Empty on purpose.
 *
 * The old template shipped an `example` subject pointing at a check.js that
 * does not exist, so a fresh `ratchet guard` opened with a warning about a
 * subject the user never wrote. A tool whose first run complains about its
 * own scaffolding teaches people to ignore its warnings. Scripted subjects
 * are documented in the README and in the rules-file header; prose is the
 * place to start.
 */
export const CONFIG_TEMPLATE = { subjects: {} };

/**
 * The operating guide that lands *inside* `.ratchet/`, where it is found.
 *
 * An agent opening a repository does not read a dependency's README; it reads
 * the files in front of it. Everything it needs to not do damage here — that
 * the ledgers are append-only, that going green by deleting a row is the one
 * unforgivable move, that a shadowed block is inert — was documented in the
 * tool's own README and therefore, in practice, nowhere.
 *
 * Written as lines joined at the end rather than one template literal: this is
 * markdown about a command-line tool, so it is most of the way to being all
 * backticks, and an escaped backtick is a typo waiting to happen.
 */
export const AGENTS_TEMPLATE = [
  "# Working in `.ratchet/`",
  "",
  "Regression memory for this repository. Everything in this folder is committed,",
  "and it is read by people and by agents alike. Read this before changing anything",
  "in here.",
  "",
  "## The files",
  "",
  "| file | what it is |",
  "|---|---|",
  "| `heuristics.rules` | prose subjects, in a closed vocabulary. Start here. |",
  "| `config.json` | scripted subjects, for checks prose cannot express |",
  "| `corpus.jsonl` | counterexamples — inputs that once broke. Append-only. |",
  "| `journal.jsonl` | decisions and proofs. Append-only. |",
  "| `tools/` | the instruments subjects run. Reach them as `{home}/tools/x.mjs`. |",
  "",
  "The two ledgers are append-only and their ids are content-addressed:",
  "`id = sha256(subject + input)`. A hand-edited row no longer matches its id and",
  "`ratchet fsck` says so. Never edit them with a text editor — every change has a",
  "command.",
  "",
  "## The one command",
  "",
  "```",
  "ratchet guard",
  "```",
  "",
  "Parse, integrity, rows, standing invariants, coverage, validation — in one exit",
  "code. `✗` fails the build; `!` is a warning and does not. Run it before you",
  "start (so you know what was already broken) and after you finish.",
  "",
  "| step | what a failure means |",
  "|---|---|",
  "| `heuristics parse` | a clause stopped parsing, so that check stopped running |",
  "| `shadowed heuristics` | a prose block is inert: `config.json` claims its name |",
  "| `integrity` | the corpus or journal is corrupt, or an instrument is unguarded |",
  "| `rows` | a counterexample came back — this is a regression |",
  "| `standing` | an invariant that must always hold here stopped holding |",
  "| `coverage` | the gate is green over almost nothing |",
  "| `unrun subjects` | a subject is declared, counted, and executed by nothing |",
  "| `frozen instrument` | a check reads the measured tree's own copy of its script |",
  "| `validation` | a subject has no proof it can fail at all |",
  "",
  "## The four things you will actually need to do",
  "",
  "**A row is failing.** That is a counterexample recurring. Fix the code. If the",
  "expectation itself is wrong, say so on the record: `ratchet accept <id> --reason",
  '"..."`. Never delete the row.',
  "",
  "**Add a check.** `ratchet heuristics new <name>` writes a commented skeleton and",
  "refuses names that would collide. Fill it in, uncomment it, `ratchet fmt`, then",
  "prove it can fail (below). Put the instrument in `.ratchet/tools/`, run it as",
  "`{home}/tools/...`, and declare `owns` for it — without `owns` its contents are",
  "outside the rule hash, so rewriting the script silently re-points every row it",
  "armed.",
  "",
  "**A subject has no proof it can fail.** Two tiers, ordered:",
  "",
  "- *against history* — it failed where a real bug lived:",
  "  `ratchet adopt <name> --good <an-old-ref>`, or",
  "  `ratchet validate <name> --known-bad <sha> --known-good HEAD`.",
  "  To find a `<sha>` where it fails, do not write a sweep script — run",
  "  `ratchet replay --subjects --subject <name> --good <an-old-ref>`.",
  "- *against a declared counterexample* — add `rejects <measure> <value>` to the",
  "  block. It is checked on every load: if your rules would accept that reading,",
  "  that is a parse error with a line and a column. This is the tier for a",
  "  standing invariant that has never been violated here.",
  "",
  "**A row is quarantined.** Its rule was edited since capture, so it is routed to",
  "review rather than failed. Read `ratchet show <id>`, then `ratchet reaffirm <id>",
  '--reason "..."` (the expectation stands) or `ratchet accept` (it does not).',
  "",
  "## Rules",
  "",
  "1. **Never go green by weakening the memory.** Not by deleting a row, not by",
  "   loosening a bound, not by editing an instrument so it stops seeing. If a",
  "   check is genuinely wrong, change it deliberately and say so in the reason —",
  "   the journal is the record of that judgment.",
  "2. **Never hand-write into `corpus.jsonl` or `journal.jsonl`.** A synthetic row",
  "   is a lie about the past, and the corpus's whole value is that every line in",
  "   it happened.",
  "3. **Never validate against a commit where the instrument merely crashed.** An",
  "   instrument that cannot run fails at every commit it cannot run at, which",
  "   looks exactly like a check that discriminates perfectly. `ratchet validate`",
  "   refuses this now; if it asks, the honest fix is usually to exit 125 (not",
  "   applicable at this commit) or 126 (this environment cannot run it here).",
  "4. **Report what you measured, not what you expect.** If you did not run it,",
  "   do not write it down.",
  "5. **Commit `.ratchet/` with the change that caused it.** The memory and the",
  "   code move together or the history stops meaning anything.",
  "",
  "## Two things worth knowing before you trust a green tick",
  "",
  "A **declared rejection proves the rule discriminates** — that the judgment",
  "would refuse a bad reading. It does not prove the instrument would ever",
  "*produce* that reading, or that it exercised anything at all. A check whose",
  "script prints three hardcoded constants passes every gate here. If you write a",
  "standing invariant, break the thing it watches on a throwaway copy and confirm",
  "it goes red — and record that you did, with `ratchet note`.",
  "",
  "A **warning is not nothing.** `guard` exits 0 on warnings so a build is not",
  "held hostage to advice, but every warning in the list above is a way the gate",
  "can be green over nothing. Leave them deliberately, not by drift.",
  "",
  "## Handing back",
  "",
  "Say which subjects are enforcing, which proof tier each has, and what you left",
  "red and why. `ratchet guard` and `ratchet yield` print both.",
].join("\n") + "\n";

export const INIT_MESSAGE = [
  "created .ratchet/",
  "  AGENTS.md         how to work in this folder — read by people and agents",
  "  heuristics.rules  prose subjects, in a closed vocabulary (start here)",
  "  config.json       scripted subjects, for checks prose cannot express",
  "  corpus.jsonl      counterexamples, committed with your code",
  "  journal.jsonl     decisions, committed with your code",
  "",
  "next:",
  "  1. ratchet heuristics new <name>              start a subject",
  "  2. prove it can fail, either way:",
  "       ratchet adopt <name> --good <an-old-ref>   against your own history",
  "       or add a `rejects <measure> <value>` line  against a stated reading",
  "  3. ratchet hooks install                      make it enforce on every commit",
].join("\n");
