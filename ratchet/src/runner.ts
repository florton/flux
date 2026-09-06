import { spawnSync } from "child_process";

export interface RunOptions {
  cwd: string;
  timeoutMs?: number;
}

export interface RunResult {
  pass: boolean;
  reason?: string;
}

export function runCheck(command: string, input: unknown, opts: RunOptions): RunResult {
  const result = spawnSync(command, {
    cwd: opts.cwd,
    shell: true,
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 30_000,
  });
  if (result.error) {
    return { pass: false, reason: result.error.message };
  }
  if (result.status === null) {
    return { pass: false, reason: `killed: ${result.signal}` };
  }
  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();
  const pass = result.status === 0;
  const reason = pass ? stdout : (stdout || stderr || `exit ${result.status}`);
  return { pass, reason };
}
