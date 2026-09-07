/**
 * What proves a subject can fail — and which of the two proofs it has.
 *
 * v0.7 made "prove it failed on a past bug" the gate, because it was the
 * strongest proof available and because a convention that nothing enforces
 * erodes. Both were true; neither was an argument that it should be the
 * *only* proof accepted. Run against eight real subjects in two outside
 * repositories, that gate refused five of them — and the five were the
 * standing invariants: Monty Hall is 2/3, particle count equals capacity, the
 * mode constants index their own table, the tree builds. Every refusal was
 * the gate working exactly as designed, and every refusal was wrong about the
 * subject it refused, because *the reason those checks had never failed is
 * that they are worth having*.
 *
 * The proxy conflated two situations that could not be more different:
 *
 *   vacuous            the check cannot fail against any input. Refuse it.
 *   standing invariant the check discriminates perfectly well; the property
 *                      has simply never been violated here.
 *
 * History cannot tell them apart, and it is not the only available evidence.
 * So history-based proof stops being the gate and becomes the *strongest
 * tier*, alongside a second tier any honest check can reach: a declared
 * rejection (`rejects` in heuristics.rules), evaluated against the rules with
 * no process, no git and no clock.
 *
 * The two are ordered, not equivalent, and both stay visible. A declared
 * rejection proves the rule discriminates; a successful run proves the
 * extraction works; together they refute vacuity without a bug ever having
 * happened. What they do *not* prove, and what history does, is that the
 * check catches a mistake a human actually made. So nothing in this tool ever
 * prints a bare "validated" again.
 */
import * as path from "path";
import { readJournal } from "./journal";
import { ruleHash } from "./rule";
import type { RatchetConfig, SubjectConfig } from "./types";

export type ProofTier = "history" | "declared" | "none";

export interface SubjectProof {
  subject: string;
  tier: ProofTier;
  /** The rule hash the proof is tied to — editing the check retires it. */
  ruleHash: string;
  /** One phrase, for a listing. Never a bare "validated". */
  label: string;
  /** The proof in a sentence, for a report. */
  detail: string;
  /**
   * True when this subject enforces with no corpus row behind it. Only a
   * declared rejection earns that: a history proof says the check once caught
   * something, which is a fact about the past, not a standing claim about the
   * tree.
   */
  standing: boolean;
}

export const PROOF_LABEL: Record<ProofTier, string> = {
  history: "validated against history",
  declared: "validated against a declared counterexample",
  none: "UNVALIDATED",
};

/**
 * The proof each subject has for the rule it is running under *now*.
 *
 * Editing a check changes its hash, so its history proof no longer applies —
 * the proof is tied to the instrument it was proven against. A declared
 * rejection travels with the prose instead, and is re-checked at parse time
 * on every load, which is the stricter of the two: editing a band is exactly
 * when its rejection should be re-checked.
 */
export function subjectProofs(
  cwd: string,
  ratchetDir: string,
  config: RatchetConfig
): Map<string, SubjectProof> {
  const journal = readJournal(path.join(ratchetDir, "journal.jsonl"));
  const out = new Map<string, SubjectProof>();

  for (const [name, subj] of Object.entries(config.subjects)) {
    const rule = ruleHash(name, subj, cwd);
    const needle = `validated "${name}" (rule ${rule})`;
    const historical = journal.find((j) => j.kind === "validation" && j.text.startsWith(needle));
    const declared = declaredRejections(subj);

    // History outranks a declared rejection, and is reported when both hold:
    // a reviewer asking "which subjects have only the weaker proof" must be
    // able to see it at a glance.
    const tier: ProofTier = historical ? "history" : declared.length > 0 ? "declared" : "none";
    out.set(name, {
      subject: name,
      tier,
      ruleHash: rule,
      label: PROOF_LABEL[tier],
      standing: declared.length > 0,
      detail:
        tier === "history"
          ? historical!.text
          : tier === "declared"
            ? `"${name}" declares ${declared.length} reading(s) its rules refuse: ${declared.join("; ")}` +
              ` — proof that the rule discriminates, not that it has ever caught a mistake someone made`
            : `"${name}" has no proof it can fail: no known bug it was shown to catch, and no declared counterexample`,
    });
  }
  return out;
}

/** The `rejects` clauses of a prose subject, as canonical text. */
export function declaredRejections(subj: SubjectConfig): string[] {
  return (subj.heuristic?.rejects ?? []).map((r) =>
    r.kind === "reading" ? r.text : `output ${JSON.stringify(r.output)}`
  );
}

/**
 * Subjects that enforce with no corpus row behind them.
 *
 * The corpus is memory of *counterexamples*: a row says "this exact input
 * once broke, and never again". A standing invariant is not a counterexample
 * and is not made into one — minting a synthetic row from a declared
 * rejection would put a line in the corpus that never happened, and the
 * corpus's whole value is that every line in it did.
 *
 * A subject with an active row carrying no input already runs exactly this
 * check, so it is left to the row: two identical probes per gate is time
 * spent for no information.
 */
export function standingSubjects(
  config: RatchetConfig,
  proofs: Map<string, SubjectProof>,
  rowedSubjects: Set<string>
): string[] {
  return Object.keys(config.subjects)
    .filter((name) => proofs.get(name)?.standing === true)
    .filter((name) => !rowedSubjects.has(name))
    .sort();
}
