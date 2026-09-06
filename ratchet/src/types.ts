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

export interface JournalEvent {
  at: string;
  kind: "decision" | "accept" | "note";
  actor: string;
  text: string;
  corpusId?: string;
  commit?: string;
}

export interface VerifyResult {
  id: string;
  subject: string;
  pass: boolean;
  reason?: string;
  /**
   * Set when the row failed, but with a different failure signature than the
   * one it was captured with — the row is red for a reason it was not
   * created to watch.
   */
  signatureDrift?: boolean;
}
