// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CORE_JOURNEY_NAME = /Core-only connector validates, renders retained consent, issues a grant/;
const FORBIDDEN_IMPORT_ERROR = /Core-only runtime loaded a Collection module/;

test("Core-only SourceDeclaration consent and read do not load the legacy Collection projection", () => {
  const loaderPath = fileURLToPath(new URL("./fixtures/forbid-legacy-collection-loader.mjs", import.meta.url));
  const journeyPath = fileURLToPath(new URL("./core-only-source-runtime-journey.test.ts", import.meta.url));
  const childEnv = { ...process.env, NODE_TEST_CONTEXT: undefined, PDPP_TEST_POSTGRES_URL: "" };
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--experimental-loader",
      loaderPath,
      "--test",
      "--test-name-pattern=Core-only connector validates, renders retained consent, issues a grant",
      journeyPath,
    ],
    {
      encoding: "utf8",
      env: childEnv,
      timeout: 60_000,
    }
  );

  assert.equal(result.status, 0, `Core-only journey failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, CORE_JOURNEY_NAME);
  assert.doesNotMatch(result.stderr, FORBIDDEN_IMPORT_ERROR);
});
