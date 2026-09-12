import { test } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { tmpDir, runRoot, scratchParent, sweepStale } from "./tmp";

/**
 * The standing invariant that would have caught this on day one.
 *
 * 24,711 `ratchet-*` directories accumulated at the top level of `%TEMP%`
 * because every fixture was its own `mkdtempSync` and nothing ever removed it.
 * Nothing in the suite could notice: each test passed, and the leak was a
 * property of the run, not of any test. So the property is asserted here, as a
 * property of a run: *a fixture-using suite adds no top-level entry to the
 * scratch parent and removes its run root*.
 *
 * This is the second half of the fix in `test/tmp.ts`. That one removes the
 * leak; this one fails if a future fixture creates its own top-level directory,
 * which is exactly how the leak arrived the first time.
 *
 * The two halves of that claim are asserted in the two places that can honestly
 * assert them. "Adds no top-level entry" is checked inside the spawned child,
 * against its own root, because it is the process that owns it. "Removes its
 * run root" is checked here, on the child's own path, after it exits. Neither
 * is phrased over the shared scratch parent: the runner parallelises test
 * files, so every sibling's root sits in that parent at the same time, and a
 * claim about the parent's *contents* is a claim about other processes.
 */

const CHILD = path.join(__dirname, "tmp-child.test.js");

test("a fixture is a child of this run's root, not a sibling in the scratch parent", () => {
  const dir = tmpDir("f-nesting-");
  assert.strictEqual(
    path.dirname(dir),
    runRoot(),
    "a fixture must live under the run root — the leak was one top-level %TEMP% entry per fixture"
  );
  assert.ok(path.basename(dir).startsWith("f-nesting-"), "the prefix is how a leaked dir is read in %TEMP%");
});

test("a suite run's process removes its own run root when it exits", () => {
  // The handshake file lives inside this run's root, so the child's own
  // teardown removes it — that is one of the things being asserted.
  const rootBeforeChild = runRoot();
  const report = path.join(rootBeforeChild, "child-report.txt");
  const child = spawnSync(process.execPath, [CHILD], {
    // Inherited, not piped: the child reports through the handshake file, so a
    // pipe would be a handle this test does not need.
    stdio: "inherit",
    // No baseline is handed over. The child owns its own run root and asserts
    // that creating a fixture adds no top-level entry; a "before" list would
    // only invite a cross-process claim again.
    env: { ...process.env, RATCHET_GUARD_REPORT: report },
  });
  assert.strictEqual(child.status, 0, "the child suite must pass before its temp behaviour means anything");

  const said = fs.readFileSync(report, "utf8").trim().split("\n");
  const childRoot = said.find((l) => l.startsWith("root="))?.slice("root=".length);
  assert.ok(childRoot, `the child did not name its run root:\n${said.join("\n")}`);
  assert.strictEqual(
    path.dirname(childRoot!),
    path.resolve(scratchParent()),
    "the child's run root was a direct child of the scratch parent"
  );
  assert.ok(!fs.existsSync(childRoot!), "the child's run root must be gone when it exits");
});

test("the age sweep collects a killed run's leftover root, and nothing young", () => {
  // The half of the fix that heals a machine already carrying debris: a run
  // killed with SIGKILL cannot clean up after itself, so its root is collected
  // by the next run instead. The age floor is what keeps a live concurrent run
  // out of reach.
  const parent = tmpDir("f-gc-");
  const stale = path.join(parent, "ratchet-stale");
  fs.mkdirSync(stale);
  const old = new Date(Date.now() - 48 * 3600_000);
  fs.utimesSync(stale, old, old);

  const fresh = path.join(parent, "ratchet-fresh");
  fs.mkdirSync(fresh);

  const removed = sweepStale({ dirs: [parent], olderThanMs: 24 * 3600_000 });
  assert.deepStrictEqual(removed, [stale], "only the root older than the floor is collected");
  assert.ok(!fs.existsSync(stale), "a leftover root is gone");
  assert.ok(fs.existsSync(fresh), "a young root — a live run's — is left alone");
});

test("RATCHET_TMPDIR keeps scratch off the user profile", () => {
  // Windows User Profile Service walks `%TEMP%` at logon, so nesting alone
  // still leaves scratch inside the profile being loaded. The override is how a
  // dev or CI moves the whole run root somewhere else, and the sweep must
  // follow it — otherwise a root moved out of `%TEMP%` would never be
  // collected.
  const parent = tmpDir("f-override-");
  const report = path.join(parent, "override.txt");
  // The child reports the fixture it created, which is nested under the run
  // root the override asked for. Only the *containment* is asserted: naming a
  // grandchild as a grandchild encodes how many levels `tempDir` happens to add,
  // which is not what this test is about.
  const script =
    "const fs=require('fs');const s=require(process.argv[1]);" +
    "fs.writeFileSync(process.argv[2],s.tempDir('f-x-'),'utf8')";
  const child = spawnSync(process.execPath, ["-e", script, path.join(__dirname, "..", "src", "scratch.js"), report], {
    stdio: "inherit",
    env: { ...process.env, RATCHET_TMPDIR: parent },
  });
  assert.strictEqual(child.status, 0, "the scratch module must honor RATCHET_TMPDIR");

  const created = fs.readFileSync(report, "utf8").trim();
  assert.ok(
    created.startsWith(parent + path.sep),
    `RATCHET_TMPDIR was ignored: the child created ${created}, which is not under ${parent}`
  );
  // The other half of the contract, and the half that was missing from the
  // shipped tool: a process removes the root it made instead of leaving it for
  // a sweep a day later. The child's own fixture is a `f-x-` directory under
  // that root, so anything left here that is not one of ours is leaked scratch.
  // A test that checked the directory *survived* was testing for the leak.
  const leftBehind = fs.readdirSync(parent).filter((e) => !e.startsWith("f-") && e !== "override.txt");
  assert.deepStrictEqual(leftBehind, [], "the child left a run root behind in the override parent");
});
