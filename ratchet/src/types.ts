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
}

export interface RatchetConfig {
  subjects: Record<string, SubjectConfig>;
}

export interface CorpusEvent {
  op: "capture" | "accept" | "reopen";
  id: string;
  at: string;
  subject: string;
  input: unknown;
  expected?: unknown;
  actual?: unknown;
  reason?: string;
  /** Normalized failure signature at capture — the witness for this row. */
  signature?: string;
  actor?: string;
  test?: string;
  seed?: string;
  commit?: string;
  source: "fast-check" | "junit" | "manual";
}

export type RowStatus = "active" | "archived";

export interface RowState {
  id: string;
  subject: string;
  input: unknown;
  status: RowStatus;
  test?: string;
  signature?: string;
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
  kind: "decision" | "accept" | "note";
  actor: string;
  text: string;
  corpusId?: string;
  commit?: string;
}

/**
 * `na` is the third outcome: the check ran and reported that it does not
 * apply at this commit (exit code 125, borrowed from `git bisect skip`).
 * It is neither a pass nor a failure, and it does not fail the build. A
 * check that cannot be spawned at all stays a failure — that is
 * indistinguishable from a broken config, and silently greening it would
 * be the exact false pass this tool exists to prevent.
 */
export type CheckOutcome = "pass" | "fail" | "na";

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
}
