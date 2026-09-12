import { test } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as path from "path";
import { tmpDir, runRoot, scratchParent } from "./tmp";

/**
 * The run of a fixture-using suite in a *fresh process*, asserted from inside
 * that process because it is the process that owns the run root and the
 * teardown. `tmp-guard.test.ts` starts it and reads the handshake file.
 *
 * Deliberately run with stdio inherited rather than piped: a pipe is a handle
 * this test does not need, and the assertions belong in the child, where the
 * facts are.
 */

const REPORT = process.env.RATCHET_GUARD_REPORT;

/**
 * The handshake is the whole contract: this file is a *fixture* that
 * `tmp-guard.test.ts` spawns, not a test of its own.
 *
 * It cannot rely on its name to stay out of the runner's way. `node --test
 * <dir>` collects `**\/*.test.js`, so a direct `node --test dist/test/` run
 * already picks it up as a standalone test file, where the handshake is absent
 * and the assertions below would report a failure that means nothing. Skipping
 * in that case keeps the file honest under every invocation instead of only the
 * one it was written for.
 */
const SPAWNED = REPORT !== undefined;

function say(line: string): void {
  if (REPORT) fs.appendFileSync(REPORT, line + "\n", "utf8");
}

/** Top-level entries in the scratch parent, or none if it cannot be read. */
function parentEntries(): string[] {
  try {
    return fs.readdirSync(scratchParent());
  } catch {
    return [];
  }
}

test("the child's fixtures are nested under one run root", { skip: !SPAWNED }, () => {
  assert.ok(REPORT, "RATCHET_GUARD_REPORT must point at the handshake file");

  const root = runRoot();
  assert.strictEqual(
    path.dirname(root),
    path.resolve(scratchParent()),
    "the run root is a direct child of the scratch parent"
  );

  say(`root=${root}`);
  say(`parent=${scratchParent()}`);

  const before = parentEntries();
  const fixture = tmpDir("f-child-");
  assert.strictEqual(path.dirname(fixture), root, "a fixture is a child of the run root");
  say(`fixture=${fixture}`);

  // Every assertion here is about scratch *this process* owns. Sibling suite
  // runs share the same parent, so anything phrased as "the parent contains
  // only my root" is a statement about other processes and would flake as soon
  // as they start in parallel.
  assert.deepStrictEqual(
    parentEntries(),
    before,
    "creating a fixture must not add a top-level entry to the scratch parent"
  );
  assert.ok(
    !parentEntries().includes(path.basename(fixture)),
    "the fixture is nested, so its own name is never a top-level entry"
  );
});
