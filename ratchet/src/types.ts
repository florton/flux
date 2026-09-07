export interface SubjectConfig {
  check: string;
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
 * `quarantine` — the check failed, but under a rule that has been edited
 * since the row was captured. The heuristic moved, so the failure is routed
 * to review rather than treated as a regression. It does not fail the build;
 * `ratchet reaffirm` or `ratchet accept` resolves it.
 */
export type CheckOutcome = "pass" | "fail" | "na" | "quarantine";

export const NA_EXIT_CODE = 125;

export interface VerifyResult {
  id: string;
  subject: string;
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
