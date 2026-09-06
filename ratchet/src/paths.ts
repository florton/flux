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
