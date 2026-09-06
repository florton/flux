#!/usr/bin/env node
/**
 * Prepare a checked-out commit so the self-hosted subjects can run against it.
 *
 * Replay hands each probe a fresh worktree, which has no `node_modules` and no
 * `dist/`. This script supplies both. A failure here is an *environment*
 * problem, not a bug in the commit — replay reports it as `na-env` rather than
 * manufacturing a regression out of dependency rot.
 *
 * Set RATCHET_BUILD_MODULES to an existing node_modules directory to skip the
 * install; otherwise `npm install` runs, which needs the network.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = process.cwd();
const pkg = path.join(root, "ratchet");

if (!fs.existsSync(path.join(pkg, "package.json"))) {
  console.log("no ratchet/package.json at this commit — nothing to build");
  process.exit(1);
}

const modules = path.join(pkg, "node_modules");
if (!fs.existsSync(modules)) {
  const donor = process.env.RATCHET_BUILD_MODULES;
  if (donor && fs.existsSync(donor)) {
    fs.cpSync(donor, modules, { recursive: true });
  } else {
    const r = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
      cwd: pkg,
      encoding: "utf8",
      shell: true,
    });
    if (r.status !== 0) {
      console.log(`npm install failed: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" ")}`);
      process.exit(1);
    }
  }
}

const tsc = path.join(modules, "typescript", "bin", "tsc");
if (!fs.existsSync(tsc)) {
  console.log("typescript is not available in this tree");
  process.exit(1);
}

const build = spawnSync(process.execPath, [tsc], { cwd: pkg, encoding: "utf8" });
if (build.status !== 0) {
  console.log(`tsc failed: ${(build.stdout || build.stderr || "").trim().split("\n").slice(0, 3).join(" ")}`);
  process.exit(1);
}
console.log("built");
