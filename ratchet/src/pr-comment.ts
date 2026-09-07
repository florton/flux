/**
 * The signal, delivered where merges are actually reviewed.
 *
 * `--json` has existed since v0.3 and nothing consumed it. That is the gap
 * that matters most in a landscape where agents open pull requests faster than
 * anyone reads them: a regression gate whose output lives in a CI log tab is a
 * gate nobody sees. What a reviewer needs, in the diff view, is two numbers —
 * did anything the corpus already knew come back, and did anything new appear.
 *
 * This renders that as markdown on stdout. It takes no network and knows
 * nothing about GitHub, so it composes with whatever posts comments:
 *
 *     ratchet pr-comment | gh pr comment --body-file -
 *
 * Rendering and posting stay separate on purpose. A tool that posts is a tool
 * that needs a token, a host, an API version and a retry policy; a tool that
 * prints markdown works on every forge and can be piped into a file, a chat
 * webhook, or a build summary with no ceremony.
 */
import { countOutcomes } from "./verify";
import type { VerifyResult } from "./types";
import type { ReportData } from "./report";
import type { YieldReport } from "./yield";

export interface CommentInput {
  results: VerifyResult[];
  report: ReportData;
  yields?: YieldReport;
  /** Rows whose input is worth showing, keyed by id. */
  inputs?: Map<string, string>;
  title?: string;
}

export function renderComment(input: CommentInput): string {
  const { results, report } = input;
  const counts = countOutcomes(results);
  const failing = results.filter((r) => r.outcome === "fail");
  const quarantined = results.filter((r) => r.outcome === "quarantine");

  const verdict =
    counts.fail > 0
      ? `**${counts.fail} regression${counts.fail === 1 ? "" : "s"}** — a counterexample the corpus already holds is failing again.`
      : quarantined.length > 0
        ? `No regressions. **${quarantined.length} row${quarantined.length === 1 ? "" : "s"} quarantined** — a heuristic moved, so these need a decision.`
        : `All ${counts.pass} corpus row${counts.pass === 1 ? "" : "s"} still hold.`;

  const lines: string[] = [];
  lines.push(`### ${input.title ?? "Ratchet"}`);
  lines.push("");
  lines.push(verdict);
  lines.push("");

  if (failing.length > 0) {
    lines.push("| row | subject | witness |");
    lines.push("|---|---|---|");
    for (const r of failing.slice(0, 20)) {
      const drift = r.signatureDrift ? " ⚠️ *different failure than captured*" : "";
      lines.push(`| \`${r.id.slice(0, 9)}\` | ${escapeCell(r.subject)} | ${escapeCell(r.reason ?? "failed")}${drift} |`);
    }
    if (failing.length > 20) lines.push(`| … | | ${failing.length - 20} more |`);
    lines.push("");
  }

  if (quarantined.length > 0) {
    lines.push("<details><summary>Quarantined rows (the heuristic changed since capture)</summary>");
    lines.push("");
    for (const r of quarantined) {
      lines.push(`- \`${r.id.slice(0, 9)}\` **${escapeCell(r.subject)}** — ${escapeCell(r.reason ?? "failed")}`);
      lines.push(`  - \`ratchet reaffirm ${r.id.slice(0, 9)}\` if the expectation still stands, \`ratchet accept\` if it does not`);
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  // The number that ends arguments: known regressions vs. novel bugs.
  const observations = report.caughtThisWeek + report.newThisWeek;
  lines.push("**Memory this week**");
  lines.push("");
  if (observations === 0) {
    lines.push("No failure signals reached capture this week.");
  } else {
    lines.push(`- caught by corpus: **${report.caughtThisWeek}** (${report.catchRateThisWeek}%) — known regressions`);
    lines.push(`- new counterexamples: **${report.newThisWeek}** — novel bugs`);
  }
  if (report.novelAllTime + report.caughtAllTime > 0) {
    lines.push(`- all time: ${report.caughtAllTime} caught, ${report.novelAllTime} new (${report.catchRateAllTime}%)`);
  }

  if (counts.na > 0 && results.length > 0 && counts.na / results.length > 0.5) {
    lines.push("");
    lines.push(
      `> ⚠️ ${counts.na} of ${results.length} rows reported *not applicable* here — most of this gate is green without checking anything.`
    );
  }

  const stale = input.yields?.stale ?? [];
  if (stale.length > 0) {
    lines.push("");
    lines.push(
      `> ${stale.length} heuristic(s) have produced no evidence in over ${input.yields!.staleAfterDays} days: ` +
        stale.map((s) => `\`${s.subject}\``).join(", ")
    );
  }

  lines.push("");
  lines.push("<sub>Posted by `ratchet pr-comment`. Rows are permanent counterexamples; a failing row means a past bug came back.</sub>");
  return lines.join("\n");
}

/** Pipes would break the table; newlines would break the row. */
function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").slice(0, 300);
}
