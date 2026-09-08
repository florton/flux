/**
 * `ratchet fuzz` — the command entry for the secondary verifier.
 *
 * One command, one exit code: 0 when no oracle was violated, 1 when at least
 * one was. The run is never stopped early for a finding — every target runs
 * its full budget and the report shows the whole set, because a crash is
 * rarely one crash. `--max-findings` only caps how many are kept per run, so
 * a single broken code path cannot flood the report past usefulness.
 *
 * The seed is printed on every run, whether you chose it or the tool did: a
 * finding reproduces from seed + iteration, which is the same property that
 * makes a corpus row reproducible. In CI, pass a fixed seed.
 */
import { runFuzz, formatFuzz, type Target, type FuzzReport } from "./fuzz";

export interface FuzzArgs {
  flags: Map<string, string>;
  bools: Set<string>;
}

const ALL_TARGETS: Target[] = ["state", "cli", "rules"];

function parseTargets(raw: string | undefined): Target[] {
  if (!raw) return [...ALL_TARGETS];
  const parts = raw.split(",").map((t) => t.trim()).filter((t) => t !== "");
  const bad = parts.filter((t) => !ALL_TARGETS.includes(t as Target));
  if (bad.length > 0) {
    console.error(`unknown fuzz target(s): ${bad.join(", ")} — pick from ${ALL_TARGETS.join(", ")}`);
    process.exit(1);
  }
  if (parts.length === 0) return [...ALL_TARGETS];
  return parts as Target[];
}

export async function fuzzMain(args: FuzzArgs): Promise<void> {
  const { flags, bools } = args;
  const json = bools.has("--json");

  const seed =
    flags.get("--seed") !== undefined
      ? parseInt(flags.get("--seed")!, 10)
      : Math.floor(Math.random() * 2 ** 31);
  if (!Number.isInteger(seed)) {
    console.error(`--seed must be an integer, got "${flags.get("--seed")}"`);
    process.exit(1);
  }
  const iterations =
    flags.get("--iterations") !== undefined ? parseInt(flags.get("--iterations")!, 10) : 300;
  if (!Number.isInteger(iterations) || iterations < 1) {
    console.error(`--iterations must be a positive integer, got "${flags.get("--iterations")}"`);
    process.exit(1);
  }
  const maxFindings =
    flags.get("--max-findings") !== undefined ? parseInt(flags.get("--max-findings")!, 10) : 20;
  if (!Number.isInteger(maxFindings) || maxFindings < 1) {
    console.error(`--max-findings must be a positive integer, got "${flags.get("--max-findings")}"`);
    process.exit(1);
  }

  const targets = parseTargets(flags.get("--targets"));
  const report: FuzzReport = await runFuzz({ seed, iterations, targets, maxFindings });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatFuzz(report));
  }
  process.exit(report.ok ? 0 : 1);
}
