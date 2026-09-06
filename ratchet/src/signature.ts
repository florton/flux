/**
 * Failure signatures — the mechanism that keeps delta-debugging honest.
 *
 * Reduction asks "does the smaller input still fail?". That question is too
 * weak: a reduced input can fail for a completely different reason, and the
 * stored row then reproduces a bug nobody captured while the real one is
 * minimized away. Every reduction step must therefore fail the *same way*,
 * not merely fail.
 *
 * A signature normalizes the check's own failure reason so that a message
 * quoting the input ("expected 3600, got 60") still matches after the input
 * shrinks, while a genuinely different failure ("divide by zero") does not.
 *
 * Known limit: a check that fails silently produces only `exit:<code>`, so
 * cause preservation degrades to "fails with the same exit status". Checks
 * that print a reason get the strong guarantee; that is the incentive.
 */

const MAX_SIGNATURE = 200;

export function failureSignature(reason: string, code: number | null): string {
  const firstLine = (reason ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "") ?? "";

  const normalized = firstLine
    .toLowerCase()
    // absolute paths and drive letters, before number scrubbing eats them
    .replace(/[a-z]:[\\/][^\s:]*/g, "<path>")
    .replace(/(?:^|\s)[\\/][^\s:]*/g, " <path>")
    // quoted literals
    .replace(/"[^"]*"/g, "<s>")
    .replace(/'[^']*'/g, "<s>")
    // hex, then any remaining numeric literal
    .replace(/\b0x[0-9a-f]+\b/g, "<n>")
    .replace(/-?\b\d+(?:\.\d+)?(?:e[-+]?\d+)?\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();

  return `exit:${code ?? "killed"}|${normalized.slice(0, MAX_SIGNATURE)}`;
}

export function signaturesMatch(a: string, b: string): boolean {
  return a === b;
}
