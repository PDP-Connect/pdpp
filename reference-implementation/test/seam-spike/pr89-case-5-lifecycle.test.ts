// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const REFERENCE_ROOT = resolve(import.meta.dirname, "../..");

function runTestFile(file: string): Promise<string> {
  const childEnv = { ...process.env };
  childEnv.NODE_TEST_CONTEXT = undefined;
  return new Promise((resolveOutput, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--test", file], {
      cwd: REFERENCE_ROOT,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code !== 0 || signal) {
        reject(new Error(`lifecycle proof failed (${code ?? "signal"}:${signal ?? "none"})\n${output}`));
        return;
      }
      resolveOutput(output);
    });
  });
}

test("authorization and refresh lifecycle portfolio passes on PostgreSQL", async () => {
  assert.ok(process.env.PDPP_TEST_POSTGRES_URL, "live PostgreSQL is required");
  const output = [
    await runTestFile("test/token-refresh-postgres-path.test.ts"),
    await runTestFile("test/grant-package-postgres-path.test.ts"),
  ].join("\n");
  for (const required of [
    "authorization-code redemption has one PostgreSQL race winner",
    "authorization-code failure rolls back PostgreSQL consumption with initial refresh issuance",
    "authorization-code delivery converges and recovers on PostgreSQL",
    "single-use grant issuance has one PostgreSQL race winner",
    "PostgreSQL migration revokes unlinked legacy refresh families and bound bearers",
    "PostgreSQL supersede failure rolls back the newly inserted family bearer",
    "PostgreSQL token lifetime and refresh eligibility follow the persisted grant contract",
    "authorization-code exchange + refresh rotation through real auth.js postgres adapters",
    "package refresh replay deactivates every family-linked bearer through real postgres adapters",
  ]) {
    assert.match(output, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
