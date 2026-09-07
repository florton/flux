export interface SubjectConfig {
  check: string;
  /**
   * Set when this subject was compiled from a prose heuristic in
   * `.ratchet/heuristics.rules` rather than declared in config.json. It is
   * never serialized to config.json; it travels in memory so that the rule
   * hash, the failure output, and `ratchet heuristics` can speak in the
   * author's own clauses instead of in an opaque command string.
   */
  heuristic?: import("./heuristics").Heuristic;
  captureProperty?: string;
  /**
   * Run `check` through a shell. Off by default: the command is tokenized
   * and spawned directly, so no metacharacter in any substituted value can
   * become syntax. Turn it on for pipes, `&&`, or a `.cmd`/`.bat` entry
   * point — the command string is then the project's own committed config,
   * and the test name still reaches the check only via RATCHET_TEST.
   */
  shell?: boolean;
  /** Per-subject timeout in milliseconds. Default 30_000. */
  timeoutMs?: number;
  /**
   * Files whose contents define this subject's rule: the scripts that do the
   * measuring. They are hashed with the check command into the owning-rule
   * hash, so that a row captured under one version of the instrument can be
   * told apart from a row captured under another. Paths are relative to the
   * repository root; directories are walked.
   */
  owns?: string[];
}

export interface RatchetConfig {
  subjects: Record<string, SubjectConfig>;
}

export interface CorpusEvent {
  /**
   * `reaffirm` re-pins a row to the current rule without changing its status:
   * the instrument was edited, the expectation still stands, and someone said
   * so on the record. It is what lifts a quarantine.
   */
  op: "capture" | "accept" | "reopen" | "reaffirm";
  id: string;
  at: string;
  subject: string;
  input: unknown;
  expected?: unknown;
  actual?: unknown;
  reason?: string;
  /** Normalized failure signature at capture — the witness for this row. */
  signature?: string;
  /** Hash of the rule (check + owned files) that justified this row. */
  ruleHash?: string;
  actor?: string;
  test?: string;
  seed?: string;
  commit?: string;
  source: "fast-check" | "junit" | "manual" | "visual" | "tap";
}

export type RowStatus = "active" | "archived";

export interface RowState {
  id: string;
  subject: string;
  input: unknown;
  status: RowStatus;
  test?: string;
  signature?: string;
  ruleHash?: string;
  source: string;
  capturedAt: string;
  lastOp: string;
  lastAt: string;
  lastReason?: string;
  lastActor?: string;
}

export interface CorpusFold {
  rows: Map<string, RowState>;
  /** accept/reopen events with no preceding capture — an integrity signal. */
  orphans: CorpusEvent[];
}

export interface LineProblem {
  line: number;
  text: string;
  error: string;
}

export interface JournalEvent {
  at: string;
  kind: "decision" | "accept" | "note" | "validation" | "recurrence";
  actor: string;
  text: string;
  corpusId?: string;
  commit?: string;
}

/**
 * Outcomes beyond pass/fail:
 *
 * `na` — the check ran and reported that it does not apply at this commit
 * (exit code 125, borrowed from `git bisect skip`). Neither a pass nor a
 * failure, and it does not fail the build. A check that cannot be spawned at
 * all stays a failure: that is indistinguishable from a broken config, and
 * silently greening it would be the exact false pass this tool exists to
 * prevent.
 *
 * `na-env` — the check could not run *here*, for a reason that is about the
 * environment rather than about the code (exit code 126). `na` and `na-env`
 * are both "no verdict", and they are the two jobs `na` used to do at once:
 * "this feature did not exist yet" and "today's toolchain cannot build that
 * commit" mean opposite things about the commit under test, and collapsing
 * them manufactures regressions out of dependency rot. `replay --setup`
 * already made the distinction for setup failures; nothing let a *check* make
 * it, so every scripted instrument grew its own three-way split by hand.
 *
 * `quarantine` — the check failed, but under a rule that has been edited
 * since the row was captured. The heuristic moved, so the failure is routed
 * to review rather than treated as a regression. It does not fail the build;
 * `ratchet reaffirm` or `ratchet accept` resolves it.
 */
export type CheckOutcome = "pass" | "fail" | "na" | "na-env" | "quarantine";

export const NA_EXIT_CODE = 125;

/**
 * "This environment cannot run the check here."
 *
 * 126 is the shell's own code for "found but not executable", which is the
 * same claim, so the collision points the same way rather than a misleading
 * one. In shell mode a shell that cannot execute the command will therefore
 * report `na-env` rather than a failure — loudly, because a subject that
 * reports no verdict at every commit trips the "most of this gate is not
 * checking anything" warning on its first run.
 */
export const NA_ENV_EXIT_CODE = 126;

export interface VerifyResult {
  id: string;
  subject: string;
  /**
   * What produced this result.
   *
   * `row` — a counterexample out of the corpus: this exact input once broke.
   * `standing` — a heuristic proven by a declared rejection, enforcing as
   * itself with no row behind it. The corpus is memory of things that
   * happened; a standing invariant is a claim about the tree, and forcing it
   * to impersonate a counterexample would put a line in the corpus that never
   * occurred. Defaults to `row` so existing readers are unchanged.
   */
  kind?: "row" | "standing";
  outcome: CheckOutcome;
  /** True only for outcome "pass". Kept so callers read as before. */
  pass: boolean;
  reason?: string;
  /**
   * Set when the row failed, but with a different failure signature than the
   * one it was captured with — the row is red for a reason it was not
   * created to watch.
   */
  signatureDrift?: boolean;
  /** The rule that justified this row has been edited since capture. */
  ruleChanged?: boolean;
}
