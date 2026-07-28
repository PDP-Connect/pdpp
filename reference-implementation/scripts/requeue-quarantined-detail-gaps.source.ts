// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, "../..");
const relativeCliPath = "reference-implementation/scripts/repair/requeue-quarantined-detail-gaps.ts";

test("direct import does not execute the repair CLI", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "await import('./reference-implementation/scripts/repair/requeue-quarantined-detail-gaps.ts')",
    ],
    { cwd: repoRoot, encoding: "utf8" }
  );

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("documented relative invocation executes main before database access", () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== "PDPP_DATABASE_URL" && key !== "PDPP_TEST_POSTGRES_URL")
  );
  const result = spawnSync(process.execPath, [relativeCliPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });

  assert.equal(result.status, 2);
  // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
  assert.match(result.stderr, /--connector-id is required/);
  assert.equal(result.stdout, "");
});
