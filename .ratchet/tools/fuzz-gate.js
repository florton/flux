// Frozen instrument for the `fuzz-clean` heuristic.
//
// The ratchet's own gate runs the secondary verifier against the build in the
// tree — the strongest form of self-hosting: the fuzzer attacks the machinery
// that enforces the gate that is running the fuzzer. The wrapper exists so
// the frozen-instrument detector sees a program outside the tree it measures;
// what it spawns is the build under test, which is the point.
const { spawnSync } = require("child_process");
const path = require("path");

const repo = path.join(__dirname, "..", "..");
const bin = path.join(repo, "ratchet", "dist", "src", "index.js");
const iters = process.env.FUZZ_ITERS || "20";

const res = spawnSync(
  process.execPath,
  [bin, "fuzz", "--seed", "20260907", "--iterations", iters],
  { encoding: "utf8", timeout: 600000, maxBuffer: 32 * 1024 * 1024 }
);

if (res.stdout) console.log(res.stdout.trim());
if (res.stderr) console.error(res.stderr.trim());
process.exit(res.status === null ? 1 : res.status);
