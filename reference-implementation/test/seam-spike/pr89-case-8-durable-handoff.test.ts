// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const REFERENCE_ROOT = resolve(import.meta.dirname, "../..");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runNodeTests(file: string, testNames: readonly string[]): Promise<string> {
  const childEnv = { ...process.env };
  childEnv.NODE_TEST_CONTEXT = undefined;
  const pattern = `^(${testNames.map(escapeRegExp).join("|")})$`;
  return new Promise((resolveOutput, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--test", "--test-name-pattern", pattern, file], {
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
        reject(new Error(`durable handoff focused tests failed (${code ?? "signal"}:${signal ?? "none"})\n${output}`));
        return;
      }
      resolveOutput(output);
    });
  });
}

async function assertFocusedTestsPass(file: string, testNames: readonly string[]): Promise<void> {
  const output = await runNodeTests(file, testNames);
  for (const required of testNames) {
    assert.match(output, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
}

test("owner-device-approval-atomicity: rollback, owner concurrency, and cross-subject recovery", async () => {
  await assertFocusedTestsPass("test/owner-device-approval-atomicity.test.ts", [
    "owner-device approval rolls back when token insertion has not started",
    "owner-device approval rolls back token insert and events on mid-transaction failure",
    "owner-device approval retry after rollback mints exactly one introspectable owner token",
    "owner-device dynamic client binding rolls back with failed approval",
    "owner-device approval is idempotent across concurrent approval and response-loss retry",
    "owner-device approval recovery rejects a different authenticated subject",
    "owner-device approval allows only the claimed subject under mixed concurrent calls",
  ]);
});

test("agent-cli: crash recovery from committed pending approval", async () => {
  await assertFocusedTestsPass("test/agent-cli.test.ts", [
    "agent-connect: approval committed before completion recovers at poll time",
  ]);
});

test("agent-cli: approved-after-expiry revokes bearer and expired bearer is refused", async () => {
  await assertFocusedTestsPass("test/agent-cli.test.ts", [
    "agent-connect: expired polling handle returns bounded expired_token",
    "agent-connect: approved attempt that expires before delivery revokes the stranded bearer",
  ]);
});

test("agent-cli: revoked bearer is refused before delivery", async () => {
  await assertFocusedTestsPass("test/agent-cli.test.ts", [
    "agent-connect: approved attempt fails closed when the grant is revoked before delivery",
  ]);
});

test("agent-cli: cache headers reject invalid bearer without token disclosure", async () => {
  await assertFocusedTestsPass("test/agent-cli.test.ts", [
    "agent-connect: schema verification fails cleanly for invalid bearer",
  ]);
});

test("agent-cli: live PostgreSQL approved expiry and revocation fail closed before delivery", async () => {
  assert.ok(process.env.PDPP_TEST_POSTGRES_URL, "live PostgreSQL is required");
  await assertFocusedTestsPass("test/agent-cli.test.ts", [
    "agent-connect: live Postgres approved expiry and revocation fail closed before delivery",
  ]);
});
