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

export const INIT_MESSAGE = [
  "created .ratchet/",
  "  heuristics.rules  prose subjects, in a closed vocabulary (start here)",
  "  config.json       scripted subjects, for checks prose cannot express",
  "  corpus.jsonl      counterexamples, committed with your code",
  "  journal.jsonl     decisions, committed with your code",
  "",
  "next:",
  "  1. write a heuristic in .ratchet/heuristics.rules",
  "  2. prove it can fail, either way:",
  "       ratchet adopt <name> --good <an-old-ref>   against your own history",
  "       or add a `rejects <measure> <value>` line  against a stated reading",
  "  3. ratchet hooks install                      make it enforce on every commit",
].join("\n");
