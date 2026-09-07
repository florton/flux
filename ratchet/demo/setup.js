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
const JUDGE = __JUDGE__;

if (subject === "roundtrip") {
  const got = parseDuration(formatDuration(input));
  if (got === input) process.exit(0);
  // The reason on stdout is what gives this row a real failure signature,
  // so reduction and drift detection can tell causes apart. A silent check
  // degrades both to "still exits nonzero".
  console.log(\`round-trip failed: \${input} formatted to "\${formatDuration(input)}" and parsed back as \${JSON.stringify(got)}\`);
  process.exit(1);
}
if (subject === "home-page") {
  // The subject's row input reaches this check on stdin. The screen is
  // rendered fresh from the committed spec, then the ratchet's own visual
  // probe compares it against the pinned baseline and produces the witness.
  // The judge path is absolute so a ratchet bisect worktree — which lives
  // outside the repo — still measures with the same frozen instrument.
  const { spawnSync } = require("child_process");
  const path = require("path");
  const render = spawnSync(process.execPath, [path.join(__dirname, "render-page.js")], { stdio: "inherit" });
  if (render.status !== 0) process.exit(1);
  const result = spawnSync(process.execPath, [JUDGE, "home-page"], {
    input: JSON.stringify(input),
    stdio: ["pipe", "inherit", "inherit"],
  });
  process.exit(result.status ?? 1);
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
  {
    subjects: {
      roundtrip: { check: "node check.js roundtrip", captureProperty: "roundtrip" },
      "home-page": {
        check: "node check.js home-page",
        owns: ["check.js", "render-page.js"],
        timeoutMs: 60_000,
      },
    },
  },
  null,
  2
) + "\n";

// ------------------------------------------------------------------ build

fs.mkdirSync(target, { recursive: true });
git("init", "-q", "-b", "main");

write(".gitignore", "node_modules/\nratchet-capture.json\n.ratchet-visual/\n");
write("package.json", JSON.stringify({
  name: "ratchet-demo",
  version: "1.0.0",
  private: true,
  description: "Demo project for the ratchet prototype: a duration parser with a seeded git history.",
  scripts: { test: "node property.js" },
  dependencies: { "fast-check": "3.23.2" },
}, null, 2) + "\n");
write("check.js", CHECK.replace("__JUDGE__", JSON.stringify(path.join(__dirname, "..", "dist", "src", "visual-cli.js"))));
write(".ratchet/config.json", CONFIG);
write(".ratchet/corpus.jsonl", "");
write(".ratchet/journal.jsonl", "");
write(".ratchet/.gitattributes", "corpus.jsonl merge=union\njournal.jsonl merge=union\n");
write(".ratchet/.gitignore", "visual/*-actual.png\nvisual/*-diff.png\n");

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

// ------------------------------------------------ the visual regression story
//
// The ratchet cannot see a browser, but a visual pin is just a check: render
// the page, compare against the pinned pixels, report the diff as the witness.
// This demo's "browser" is a deterministic pure-JS renderer that draws the
// home page from design tokens — a real project would run Playwright here,
// and the ratchet side is identical.

const RENDER = `#!/usr/bin/env node
/**
 * The fake browser in this demo: a deterministic pure-JS page renderer.
 *
 * The visual probe needs a "screenshot"; this project has no browser, so the
 * page is drawn here, pixel by pixel, from the design tokens committed in
 * page-spec.json. Same idea, zero process drag — the check contract, the
 * corpus row, and the witness are exactly what a Playwright-based subject
 * would have. Swap this renderer for \`page.goto(url) + screenshot()\` and
 * nothing else in the walkthrough changes.
 */
const fs = require("fs");
const path = require("path");
const { encodePng } = require(__VISUAL__);

const W = 320;
const H = 200;
const spec = JSON.parse(fs.readFileSync(path.join(__dirname, "page-spec.json"), "utf8"));

const page = Buffer.alloc(W * H * 4);
const put = (x, y, rgb) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  page[i] = rgb[0];
  page[i + 1] = rgb[1];
  page[i + 2] = rgb[2];
  page[i + 3] = 255;
};
const fillRect = (x0, y0, w, h, rgb) => {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) put(x, y, rgb);
};

fillRect(0, 0, W, H, spec.background);              // page
fillRect(0, 0, W, 32, spec.header);                  // header bar
fillRect(0, 32, spec.sidebarWidth, H - 32, spec.sidebar); // sidebar
fillRect(12, 44, 96, 12, spec.accent);               // title
fillRect(12, 64, 200, 8, spec.text);                 // body lines
fillRect(12, 78, 200, 8, spec.text);
fillRect(12, 92, 128, 8, spec.text);
fillRect(spec.sidebarWidth + 16, H - 44, 92, 28, spec.accent); // CTA button

fs.mkdirSync(path.join(__dirname, ".ratchet-visual"), { recursive: true });
fs.writeFileSync(path.join(__dirname, ".ratchet-visual", "home.png"), encodePng(W, H, page));
console.log("rendered home page (spec:", spec.name + ")");
`;

const ocean = JSON.stringify({ name: "ocean", background: [20, 24, 60], header: [40, 52, 120], sidebar: [28, 36, 84], sidebarWidth: 64, text: [196, 208, 240], accent: [62, 132, 212] });
const lava = JSON.stringify({ name: "lava", background: [64, 20, 16], header: [176, 44, 32], sidebar: [112, 30, 22], sidebarWidth: 64, text: [236, 216, 200], accent: [214, 146, 48] });

write("render-page.js", RENDER.replace("__VISUAL__", JSON.stringify(path.join(__dirname, "..", "dist", "src", "visual.js"))));
write("page-spec.json", ocean);
commit("home page with an ocean theme");

// Render once, then pin the pixels — the human's eye says "good".
const renderOnce = spawnSync(process.execPath, [path.join(target, "render-page.js")], { cwd: target, encoding: "utf8" });
if (renderOnce.status !== 0) throw new Error(`render failed: ${renderOnce.stderr || renderOnce.stdout}`);
const RATCHET = path.join(__dirname, "..", "dist", "src", "index.js");
const record = spawnSync(process.execPath, [RATCHET, "visual", "record", "home-page", "--file", ".ratchet-visual/home.png"], {
  cwd: target,
  encoding: "utf8",
});
if (record.status !== 0) throw new Error(`visual record failed: ${record.stderr || record.stdout}`);
commit("pin the home page pixels (ratchet visual row)");

write("page-spec.json", lava);
commit("theme refresh: warm accent on the home page", "visual-bug");

write("page-spec.json", ocean);
commit("revert theme back to ocean");

console.log(`built ${target}`);
console.log(git("log", "--oneline", "--decorate", "--reverse"));
console.log("\nnext: cd demo/repo && npm install");
console.log("then follow demo/README.md");
