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

test("--reason=too_large is refused before any database connection is attempted", () => {
  // No PDPP_DATABASE_URL/PDPP_TEST_POSTGRES_URL in the child env at all: if
  // the CLI's `--reason` allowlist check ran AFTER the database-url guard (or
  // skipped straight to a DB call), this would fail with a DIFFERENT error
  // ("PDPP_DATABASE_URL is required") instead of the reason refusal — proving
  // the refusal is unconditional and connection-free, not merely reachable.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== "PDPP_DATABASE_URL" && key !== "PDPP_TEST_POSTGRES_URL")
  );
  const result = spawnSync(
    process.execPath,
    [relativeCliPath, "--connector-id=gmail", "--connector-instance-id=cin_test", "--reason=too_large"],
    { cwd: repoRoot, encoding: "utf8", env }
  );

  assert.equal(result.status, 2);
  // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
  assert.match(result.stderr, /--reason='too_large' is not requeueable/);
  // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
  assert.doesNotMatch(result.stderr, /PDPP_DATABASE_URL/);
  assert.equal(result.stdout, "");
});

test("an unrecognized --reason is refused the same way as too_large", () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== "PDPP_DATABASE_URL" && key !== "PDPP_TEST_POSTGRES_URL")
  );
  const result = spawnSync(
    process.execPath,
    [relativeCliPath, "--connector-id=gmail", "--connector-instance-id=cin_test", "--reason=not_found"],
    { cwd: repoRoot, encoding: "utf8", env }
  );

  assert.equal(result.status, 2);
  // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
  assert.match(result.stderr, /--reason='not_found' is not requeueable/);
  assert.equal(result.stdout, "");
});
