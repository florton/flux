export interface SubjectConfig {
  check: string;
  captureProperty?: string;
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
  source: string;
  capturedAt: string;
  lastOp: string;
  lastAt: string;
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
}
