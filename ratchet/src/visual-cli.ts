#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { createRequire } from "module";
import { decodePng, encodePng, compareImages, renderDiffImage, type DiffStats } from "./visual";
import { appendEvent, foldRows, readEvents, rowId } from "./corpus";
import { appendJournal } from "./journal";
import { ruleHash } from "./rule";
import type { RatchetConfig, SubjectConfig } from "./types";

/**
 * The visual check — a probe for the ratchet's own check contract.
 *
 * `ratchet verify` runs each corpus row's check with the row's input on
 * stdin. A visual row's input names a screen and its "actual" pixels come
 * either from this probe's own browser (anything `playwright` or
 * `puppeteer`), or from a file the project's own screenshot tool wrote:
 *
 *   node dist/src/visual-cli.js <subject>
 *
 * reads the input, loads the baseline pinned at .ratchet/visual/<row-id>.png,
 * and compares. Exit 0 = pixels still match; anything else prints the witness
 * on stdout (the diff percentage, the bounding box, the max channel delta,
 * and the artifact files it wrote) — that string is what the ratchet feeds
 * its failure signatures, so cause-preserving reduction and drift detection
 * work for pixels the same way they work for JSON.
 *
 * Setting RATCHET_VISUAL_RECORD=1 disables comparison after the screenshot
 * is taken: the probe becomes a shooter, and `ratchet visual record` uses it
 * to produce baselines.
 */

export interface VisualInput {
  /** Browser mode: the URL (or localhost route) to load and shoot. */
  route?: string;
  /** File mode: the actual screenshot written by your own tool. Paths are relative to the repo root. */
  file?: string;
  width?: number;
  height?: number;
  /** Browser modal: wait this long after load before shooting, for animations. */
  waitMs?: number;
  /** Per-pixel channel tolerance, 0..255. Default 0 (exact). */
  tolerance?: number;
  /** Fraction (percent) of pixels that may differ without failing. Default 0. */
  maxPercent?: number;
}

export function ratchetHome(cwd: string): string {
  return process.env.RATCHET_HOME ?? path.join(cwd, ".ratchet");
}

export function visualDir(cwd: string): string {
  return path.join(ratchetHome(cwd), "visual");
}

/** Baseline path for a row: content-addressed, like the row id itself. */
export function baselinePathFor(cwd: string, subject: string, input: unknown): string {
  return path.join(visualDir(cwd), rowId(subject, input) + ".png");
}

function currentCommit(cwd: string): string {
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd, encoding: "utf8" });
  return r.status === 0 ? (r.stdout ?? "").trim() : "";
}

function loadBrowser(cwd: string): { module: "playwright" | "puppeteer"; mod: unknown } | null {
  const req = createRequire(path.join(cwd, "__ratchet_visual_probe__.js"));
  try {
    return { module: "playwright", mod: req("playwright") };
  } catch {
    /* not installed */
  }
  try {
    return { module: "puppeteer", mod: req("puppeteer") };
  } catch {
    /* not installed */
  }
  return null;
}

/** Shoot a live page with playwright or puppeteer, whichever the target project installed. */
export async function captureBrowser(cwd: string, input: VisualInput): Promise<Buffer> {
  const width = input.width ?? 1280;
  const height = input.height ?? 800;
  const route = input.route ?? "/";
  const found = loadBrowser(cwd);
  if (!found) {
    throw new Error(
      "no browser library installed in this project — `npm i -D playwright` or `npm i -D puppeteer`, and this or your own tool can shoot screenshots"
    );
  }
  const { module, mod } = found;
  if (module === "playwright") {
    const pw = mod as { chromium: { launch(): Promise<BrowserLike> } };
    const browser = await pw.chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width, height } });
      await page.goto(route, { waitUntil: "networkidle" });
      if (input.waitMs) await new Promise((r) => setTimeout(r, input.waitMs));
      const png = await page.screenshot({ type: "png" });
      return Buffer.from(png);
    } finally {
      await browser.close();
    }
  }
  const pp = mod as { launch(): Promise<BrowserLike> };
  const browser = await pp.launch();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    await page.goto(route, { waitUntil: "networkidle" });
    if (input.waitMs) await new Promise((r) => setTimeout(r, input.waitMs));
    const png = await page.screenshot({ type: "png", encoding: "binary" });
    return Buffer.from(png);
  } finally {
    await browser.close();
  }
}

interface BrowserLike {
  close(): Promise<void>;
  newPage(opts?: unknown): Promise<PageLike>;
}

interface PageLike {
  goto(route: string, opts?: unknown): Promise<unknown>;
  setViewport(opts: { width?: number; height?: number }): Promise<unknown>;
  screenshot(opts?: unknown): Promise<Buffer | Uint8Array>;
}

/** Produce the actual PNG for a visual input. */
export async function captureScreen(cwd: string, input: VisualInput): Promise<{ png: Buffer; source: string }> {
  if (input.file) {
    const p = path.resolve(cwd, input.file);
    const png = fs.readFileSync(p);
    decodePng(png);
    return { png, source: input.file };
  }
  if (!input.route) {
    throw new Error("visual input needs a `route` (browser mode) or a `file` (your own screenshot)");
  }
  return { png: await captureBrowser(cwd, input), source: input.route };
}

export function describeDiff(stats: DiffStats, extra: string[]): string {
  const b = stats.bbox
    ? `bbox ${stats.bbox.w}x${stats.bbox.h} at (${stats.bbox.x},${stats.bbox.y})`
    : "none";
  const parts = [
    `visual diff: ${stats.percentChanged}% of ${stats.totalPixels} pixels (${stats.changedPixels}, ${b}, max channel delta ${stats.maxChannelDelta})`,
    ...extra,
  ];
  return parts.join(" — ");
}

/** Standalone compare for `ratchet visual diff` — no corpus involved. */
export function diffImageFiles(
  aPath: string,
  bPath: string,
  opts: { perPixel?: number; maxPercent?: number }
): { stats: DiffStats; diffPng: Buffer } {
  const a = decodePng(fs.readFileSync(aPath));
  const b = decodePng(fs.readFileSync(bPath));
  const stats = compareImages(a, b, { perPixel: opts.perPixel, maxPercent: opts.maxPercent });
  const rendered = renderDiffImage(a, b);
  return { stats, diffPng: encodePng(rendered.width, rendered.height, rendered.data) };
}

/**
 * Run the visual check itself: shoot (or take the file), compare, exit.
 * This is the process entry point; it is not in the null path when imported.
 */
async function main(): Promise<void> {
  const subject = process.argv[2];
  const recordMode = !!process.env.RATCHET_VISUAL_RECORD;
  const cwd = process.cwd();
  const home = ratchetHome(cwd);

  if (!subject) {
    console.error("usage: node visual-cli.js <subject>  (input JSON on stdin)");
    process.exit(1);
  }

  let input: VisualInput;
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8")) as VisualInput;
  } catch (err) {
    console.log(`visual check for ${subject}: stdin was not JSON (${err instanceof Error ? err.message : err})`);
    process.exit(1);
  }

  try {
    const { png } = await captureScreen(cwd, input);

    if (recordMode) {
      // Shooter mode: `ratchet visual record` handles the corpus plumbing.
      process.stdout.write(png);
      process.exit(0);
    }

    const baselinePath = baselinePathFor(cwd, subject, input);
    if (!fs.existsSync(baselinePath)) {
      console.log(`no visual baseline for ${subject} — record one with \`ratchet visual record ${subject}\` (or --file <png>)`);
      process.exit(1);
    }

    const actual = decodePng(png);
    const baseline = decodePng(fs.readFileSync(baselinePath));
    const stats = compareImages(actual, baseline, {
      perPixel: input.tolerance,
      maxPercent: input.maxPercent,
    });

    if (stats.equal) process.exit(0);

    const dir = visualDir(cwd);
    fs.mkdirSync(dir, { recursive: true });
    const id = rowId(subject, input);
    const diffPath = path.join(dir, id + "-diff.png");
    const actualPath = path.join(dir, id + "-actual.png");
    fs.writeFileSync(diffPath, encodePng(stats.width, stats.height, renderDiffImage(actual, baseline).data));
    fs.writeFileSync(actualPath, encodePng(actual.width, actual.height, actual.data));
    console.log(
      describeDiff(stats, [
        `actual: visual/${path.basename(actualPath)}`,
        `diff: visual/${path.basename(diffPath)}`,
      ])
    );
    process.exit(1);
  } catch (err) {
    console.log(`visual check failed to run: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// The entry point must stay dead code when imported by `ratchet visual record`.
if (require.main === module) {
  void main();
}

export interface RecordResult {
  id: string;
  pngName: string;
  sha256: string;
  previousStatus: "active" | "archived" | "none";
}

/**
 * Record a baseline: pin the current pixels of a screen as the oracle for
 * the subject. The event is a capture with `source: "visual"` and no failure
 * signature — a pin starts with no witness; it earns one the day it goes red.
 * Re-recording an existing row re-activates it (a capture always does), and
 * every old baseline hash stays in the audit trail.
 */
export async function recordVisual(
  cwd: string,
  subject: string,
  input: VisualInput,
  actor?: string
): Promise<RecordResult> {
  const home = ratchetHome(cwd);
  const configPath = path.join(home, "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as RatchetConfig;
  const subj: SubjectConfig | undefined = config.subjects[subject];
  if (!subj || !subj.check) {
    throw new Error(`subject "${subject}" is not configured with a check — a baseline is unenforceable without one`);
  }

  const png = await captureScreen(cwd, input);
  // The row identity is (subject, canonical input). CLI flags that were not
  // provided arrive as `undefined` properties, and JSON drops those on the
  // way into the corpus — so the id must be computed from the same shape the
  // judge will later parse back, or every verify resolves a different row.
  const canonical = JSON.parse(JSON.stringify(input)) as VisualInput;
  const id = rowId(subject, canonical);
  const pngName = id + ".png";
  const dir = visualDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, pngName), png.png);

  const sha256 = createHash("sha256").update(png.png).digest("hex");
  const rows = foldRows(readEvents(path.join(home, "corpus.jsonl")));
  const existing = rows.get(id);
  const at = new Date().toISOString();
  const commit = currentCommit(cwd);

  appendEvent(path.join(home, "corpus.jsonl"), {
    op: "capture",
    id,
    at,
    subject,
    input: canonical,
    expected: { sha256, png: pngName },
    reason: "baseline recorded",
    ruleHash: ruleHash(subject, subj, cwd),
    actor: actor ?? "human",
    commit,
    source: "visual",
  });
  appendJournal(path.join(home, "journal.jsonl"), {
    at,
    kind: "decision",
    actor: actor ?? "human",
    text: `visual baseline pinned for "${subject}": ${pngName} (sha256 ${sha256.slice(0, 12)}…)${
      existing ? ` — replaced the previous baseline of the same row` : ""
    }`,
    corpusId: id,
    commit,
  });

  return { id, pngName, sha256, previousStatus: existing?.status ?? "none" };
}
