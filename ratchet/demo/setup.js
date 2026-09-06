#!/usr/bin/env node
/**
 * Build the demo repository from scratch.
 *
 * The walkthrough in README.md needs a git history with a known bug in it.
 * That history used to exist only as a nested .git directory, which cannot
 * be committed inside another repository — so the evidence for the whole
 * design was not reproducible from a clone. This script regenerates it:
 *
 *   node demo/setup.js            # creates demo/repo/
 *   node demo/setup.js --force    # discards and recreates it
 *
 * The result is a five-commit history of a duration parser:
 *
 *   v1                 round-trip property holds
 *   broken             hours parsed as minutes          property FAILS
 *   (fix)              hours parsed correctly again     property holds
 *   intentional-zero   formatDuration(0) becomes ""     property FAILS
 *   v2                 spec updated: zero is "" by design
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const target = path.join(__dirname, "repo");
const force = process.argv.includes("--force");

if (fs.existsSync(target)) {
  if (!force) {
    console.error(`${target} already exists — pass --force to recreate it`);
    process.exit(1);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function git(...args) {
  const r = spawnSync("git", args, { cwd: target, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return (r.stdout || "").trim();
}

function write(rel, contents) {
  const p = path.join(target, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents, "utf8");
}

function commit(message, tag) {
  git("add", "-A");
  git("-c", "user.name=ratchet demo", "-c", "user.email=demo@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "-qm", message);
  if (tag) git("tag", "-f", tag);
}

// ---------------------------------------------------------------- sources

const parseDuration = ({ hoursMultiplier, zeroFormat }) => `function parseDuration(text) {
  if (text === "") return "Malformed";
  let total = 0;
  const re = /(\\d+)(h|m|s)/g;
  let m;
  let matched = false;
  while ((m = re.exec(text))) {
    matched = true;
    const v = parseInt(m[1], 10);
    if (m[2] === "h") total += v * ${hoursMultiplier};
    else if (m[2] === "m") total += v * 60;
    else total += v;
  }
  return matched && text.replace(re, "") === "" ? total : "Malformed";
}

function formatDuration(seconds) {
  if (seconds === 0) return ${JSON.stringify(zeroFormat)};
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  let out = "";
  if (h) out += \`\${h}h\`;
  if (m) out += \`\${m}m\`;
  if (s) out += \`\${s}s\`;
  return out;
}

module.exports = { parseDuration, formatDuration };
`;

const CHECK = `const fs = require("fs");
const { parseDuration, formatDuration } = require("./parseDuration");

const subject = process.argv[2];
const input = JSON.parse(fs.readFileSync(0, "utf8"));

if (subject === "roundtrip") {
  const got = parseDuration(formatDuration(input));
  if (got === input) process.exit(0);
  // The reason on stdout is what gives this row a real failure signature,
  // so reduction and drift detection can tell causes apart. A silent check
  // degrades both to "still exits nonzero".
  console.log(\`round-trip failed: \${input} formatted to "\${formatDuration(input)}" and parsed back as \${JSON.stringify(got)}\`);
  process.exit(1);
}
console.log(\`unknown subject: \${subject}\`);
process.exit(1);
`;

const property = ({ min, zeroContract }) => `const fc = require("fast-check");
const fs = require("fs");
const { parseDuration, formatDuration } = require("./parseDuration");

let failed = false;

const reporter = (runDetails) => {
  if (runDetails.failed) {
    failed = true;
    fs.writeFileSync(
      "ratchet-capture.json",
      JSON.stringify(
        [
          {
            property: "roundtrip",
            seed: runDetails.seed,
            counterexample: runDetails.counterexample,
            error: runDetails.error || "property failed",
          },
        ],
        null,
        2
      )
    );
    console.error(\`property failed after \${runDetails.numRuns} tests: \${runDetails.error}\`);
  }
};

fc.assert(
  fc.property(fc.integer({ min: ${min}, max: 100000 }), (n) => {
    return parseDuration(formatDuration(n)) === n;
  }),
  { reporter, numRuns: 2000 }
);
${zeroContract ? `
fc.assert(
  fc.property(fc.constant(0), () => formatDuration(0) === ""),
  { reporter, numRuns: 1 }
);
` : ""}
if (failed) process.exit(1);
console.log("property passes");
`;

const CONFIG = JSON.stringify(
  { subjects: { roundtrip: { check: "node check.js roundtrip", captureProperty: "roundtrip" } } },
  null,
  2
) + "\n";

// ------------------------------------------------------------------ build

fs.mkdirSync(target, { recursive: true });
git("init", "-q", "-b", "main");

write(".gitignore", "node_modules/\nratchet-capture.json\n");
write("package.json", JSON.stringify({
  name: "ratchet-demo",
  version: "1.0.0",
  private: true,
  description: "Demo project for the ratchet prototype: a duration parser with a seeded git history.",
  scripts: { test: "node property.js" },
  dependencies: { "fast-check": "3.23.2" },
}, null, 2) + "\n");
write("check.js", CHECK);
write(".ratchet/config.json", CONFIG);
write(".ratchet/corpus.jsonl", "");
write(".ratchet/journal.jsonl", "");
write(".ratchet/.gitattributes", "corpus.jsonl merge=union\njournal.jsonl merge=union\n");

write("parseDuration.js", parseDuration({ hoursMultiplier: 3600, zeroFormat: "0s" }));
write("property.js", property({ min: 0, zeroContract: false }));
commit("duration functions with round-trip property and ratchet skeleton", "v1");

write("parseDuration.js", parseDuration({ hoursMultiplier: 60, zeroFormat: "0s" }));
commit("optimize hour parsing", "broken");

write("parseDuration.js", parseDuration({ hoursMultiplier: 3600, zeroFormat: "0s" }));
commit("fix hour parsing");

write("parseDuration.js", parseDuration({ hoursMultiplier: 3600, zeroFormat: "" }));
commit("format zero as empty string", "intentional-zero");

write("property.js", property({ min: 1, zeroContract: true }));
commit("spec update: zero formats as empty string", "v2");

console.log(`built ${target}`);
console.log(git("log", "--oneline", "--decorate", "--reverse"));
console.log("\nnext: cd demo/repo && npm install");
console.log("then follow demo/README.md");
