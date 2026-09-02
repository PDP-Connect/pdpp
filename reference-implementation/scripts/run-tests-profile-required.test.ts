// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end wiring proof for the 2026-08-30 fail-closed profile guard: an
 * unbound or authority-bound `run-tests.ts` invocation with an absent,
 * malformed, or mismatched PDPP_TEST_PROFILE must hard-fail before test
 * discovery ever runs, not fall through to memory-default.
 * `test-profile-env.test.ts` proves the guard function's own logic; this
 * proves `run-tests.ts` invokes it at real process boundaries before spawning
 * anything.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RUN_AUTHORITY_SCHEMA } from "../../scripts/test-accounting/inventory.ts";

const runTestsPath = fileURLToPath(new URL("./run-tests.ts", import.meta.url));
const PROFILE_MUST_BE_SET_PATTERN = /PDPP_TEST_PROFILE must be set/;
const AUTHORITY_BINDING_PATTERN = /accounting authority does not bind the selected RI profile/;
const PROFILE_HELPER_TEST_PATH = "reference-implementation/scripts/test-profile-env.test.ts";
const SELECTED_CHILD_OUTPUT_PATTERN = /[=]=> .*test-profile-env\.test\.ts/;

function runTestRunner(
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", runTestsPath, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stderr, stdout }));
  });
}

function runUngated(env: NodeJS.ProcessEnv) {
  return runTestRunner([], env);
}

async function runWithAuthority(authority: object, env: NodeJS.ProcessEnv) {
  const directory = await mkdtemp(join(tmpdir(), "pdpp-run-tests-authority-"));
  const authorityPath = join(directory, "authority.json");
  await writeFile(authorityPath, JSON.stringify(authority));
  try {
    return await runTestRunner(["--accounting-authority", authorityPath], env);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function validAuthority(overrides: object = {}) {
  return {
    expires_at: "2099-01-01T00:00:00.000Z",
    files: [],
    nonce: "test-nonce",
    profile: "memory-default",
    run_id: "test-run-id",
    schema: RUN_AUTHORITY_SCHEMA,
    suite: "ri-default",
    ...overrides,
  };
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

test("an authority with an absent profile hard-fails before child execution", async () => {
  const { code, stderr, stdout } = await runWithAuthority(
    validAuthority({ files: [PROFILE_HELPER_TEST_PATH], profile: undefined }),
    {
      ...process.env,
      PDPP_TEST_PROFILE: undefined,
    }
  );
  assert.notEqual(code, 0);
  assert.match(stderr, PROFILE_MUST_BE_SET_PATTERN);
  assert.equal(stdout, "");
});

test("an authority with a malformed profile hard-fails before child execution", async () => {
  const { code, stderr, stdout } = await runWithAuthority(
    validAuthority({ files: [PROFILE_HELPER_TEST_PATH], profile: "sqlite" }),
    {
      ...process.env,
      PDPP_TEST_PROFILE: "sqlite",
    }
  );
  assert.notEqual(code, 0);
  assert.match(stderr, PROFILE_MUST_BE_SET_PATTERN);
  assert.equal(stdout, "");
});

test("an authority profile mismatch hard-fails before child execution", async () => {
  const { code, stderr, stdout } = await runWithAuthority(
    validAuthority({ files: [PROFILE_HELPER_TEST_PATH], profile: "postgres" }),
    {
      ...process.env,
      PDPP_TEST_PROFILE: "memory-default",
    }
  );
  assert.notEqual(code, 0);
  assert.match(stderr, AUTHORITY_BINDING_PATTERN);
  assert.equal(stdout, "");
});

test("a valid authority profile reaches its selected child test", async () => {
  const { code, stderr, stdout } = await runWithAuthority(validAuthority({ files: [PROFILE_HELPER_TEST_PATH] }), {
    ...process.env,
    PDPP_TEST_POSTGRES_URL: "postgresql://postgres:pw@127.0.0.1:55447/pdpp_test",
    PDPP_TEST_PROFILE: "memory-default",
  });
  // The intentionally partial authority cannot satisfy the complete-suite
  // named-skip mapping, but it proves profile validation accepted the bound
  // memory selection and the runner spawned the authorized child.
  assert.notEqual(code, 0);
  assert.doesNotMatch(stderr, PROFILE_MUST_BE_SET_PATTERN);
  assert.match(stdout, SELECTED_CHILD_OUTPUT_PATTERN);
});
