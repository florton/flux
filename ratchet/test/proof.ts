import * as fs from "fs";
import * as path from "path";
import { appendJournal } from "../src/journal";
import { loadSubjects } from "../src/paths";
import { ruleHash } from "../src/rule";

/**
 * Seed the validation proofs a scratch project's subjects would have earned in
 * real use.
 *
 * `capture` refuses a subject with no proof that it can fail on a known bug —
 * the gate that turns "who checks the checkers" from a convention into a
 * mechanism. Tests of capture *mechanics* (discrimination, dedup, reduction,
 * the recurrence gate) are not tests of that gate, and they should run against
 * the same shape of project a real user has: subjects that have been proven.
 *
 * The proof text is the one `ratchet validate` writes, matched against the
 * current rule hash, so a subject whose check is later edited in a test loses
 * its proof exactly as it would in a repository.
 */
export function proveSubjects(home: string, root: string): void {
  const config = loadSubjects(home);
  const journalPath = path.join(home, "journal.jsonl");
  if (!fs.existsSync(journalPath)) fs.writeFileSync(journalPath, "", "utf8");
  for (const [name, subj] of Object.entries(config.subjects)) {
    appendJournal(journalPath, {
      at: new Date().toISOString(),
      kind: "validation",
      actor: "test",
      text: `validated "${name}" (rule ${ruleHash(name, subj, root)}): seeded by the test harness`,
    });
  }
}
