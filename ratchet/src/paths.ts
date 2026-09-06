import * as fs from "fs";
import * as path from "path";
import type { RatchetConfig } from "./types";

export function findRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".ratchet"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function ratchetDir(root: string, home?: string): string {
  return home ?? path.join(root, ".ratchet");
}

export function loadConfig(dir: string): RatchetConfig {
  const raw = fs.readFileSync(path.join(dir, "config.json"), "utf8");
  return JSON.parse(raw) as RatchetConfig;
}

export function nextRowId(corpusPath: string): string {
  if (!fs.existsSync(corpusPath)) return "c0001";
  const text = fs.readFileSync(corpusPath, "utf8");
  let max = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const ev = JSON.parse(line);
    const m = /^c(\d+)$/.exec(ev.id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `c${String(max + 1).padStart(4, "0")}`;
}
