// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end wiring proof for the 2026-08-30 fail-closed profile guard: an
 * ungated `run-tests.ts` invocation (no --accounting-authority) with an
 * absent PDPP_TEST_PROFILE must hard-fail before test discovery ever runs,
 * not fall through to memory-default. `test-profile-env.test.ts` proves the
 * guard function's own logic; this proves `run-tests.ts` actually calls it
 * on the real ungated path, at real process boundaries, before spawning
 * anything.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runTestsPath = fileURLToPath(new URL("./run-tests.ts", import.meta.url));
const PROFILE_MUST_BE_SET_PATTERN = /PDPP_TEST_PROFILE must be set/;

function runUngated(env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", runTestsPath], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stderr }));
  });
}

test("an absent PDPP_TEST_PROFILE hard-fails before discovery even with a PostgreSQL URL set", async () => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PDPP_TEST_POSTGRES_URL: "postgresql://postgres:pw@127.0.0.1:55447/pdpp_test",
    PDPP_TEST_PROFILE: undefined,
  };
  const { code, stderr } = await runUngated(env);
  assert.notEqual(code, 0);
  assert.match(stderr, PROFILE_MUST_BE_SET_PATTERN);
});
