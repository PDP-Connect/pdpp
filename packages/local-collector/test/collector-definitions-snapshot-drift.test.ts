// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proves the definitions-bridge invariant: `@pdpp/local-collector` never
 * reaches into `@pdpp/polyfill-connectors`'s source tree at runtime, but its
 * checked-in snapshot of `LOCAL_COLLECTOR_DEFINITIONS`
 * (`src/generated/collector-definitions.generated.ts`) must never drift from
 * what polyfill-connectors actually declares.
 *
 * 1. Drift oracle: the tracked snapshot is exactly what regenerating from
 *    `packages/polyfill-connectors/src/collector-registry.ts` right now
 *    would produce — the same pattern
 *    `static-secret-registry-manifest-derivation.test.ts` uses for its
 *    generated registry.
 * 2. Update-path proof: this test's own failure message is the update path
 *    (regenerate, then commit) — the snapshot's header states the same
 *    command so a contributor who reads either finds the same instruction.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const generatorScript = join(packageDir, "scripts/generate-collector-definitions-snapshot.ts");
const trackedSnapshotPath = join(packageDir, "src/generated/collector-definitions.generated.ts");

test("collector-definitions.generated.ts has not drifted from polyfill-connectors' LOCAL_COLLECTOR_DEFINITIONS", () => {
  const scratchDir = mkdtempSync(join(tmpdir(), "collector-definitions-snapshot-drift-"));
  try {
    const scratchPath = join(scratchDir, "collector-definitions.generated.ts");
    execFileSync("node", ["--experimental-strip-types", generatorScript, scratchPath], {
      cwd: packageDir,
      stdio: "pipe",
    });
    const generated = readFileSync(scratchPath, "utf8");
    const tracked = readFileSync(trackedSnapshotPath, "utf8");
    assert.equal(
      generated,
      tracked,
      "src/generated/collector-definitions.generated.ts is stale — rerun " +
        "`node --experimental-strip-types scripts/generate-collector-definitions-snapshot.ts` " +
        "from packages/local-collector and commit the result"
    );
  } finally {
    rmSync(scratchDir, { force: true, recursive: true });
  }
});
