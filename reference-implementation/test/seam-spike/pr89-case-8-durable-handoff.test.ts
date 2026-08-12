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

async function assertFocusedNestedTestsPass(file: string, testNames: readonly string[]): Promise<void> {
  await runNodeTests(file, testNames);
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

test("agent-cli: crash-completed expiry and prune revoke committed approvals", async () => {
  await assertFocusedTestsPass("test/agent-cli.test.ts", [
    "agent-connect: crash-completed approval that expires before poll revokes committed token",
    "agent-connect: prune reconciles crash-completed expired approval before deleting attempt",
  ]);
});

test("agent-cli: cleanup/approval race revokes committed token", async () => {
  await assertFocusedTestsPass("test/agent-cli.test.ts", [
    "agent-connect: cleanup miss racing approval commit revokes the committed token",
    "agent-connect: approval after cleanup second miss before tombstone is revoked",
    "agent-connect: approval completion after tombstone revokes its token",
  ]);
});

test("agent-cli: response-loss replay survives unrelated registration", async () => {
  await assertFocusedTestsPass("test/agent-cli.test.ts", [
    "agent-connect: owner approval completes polling without exposing owner token",
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

test("agent-cli: live PostgreSQL crash expiry/prune and response-loss replay", async () => {
  assert.ok(process.env.PDPP_TEST_POSTGRES_URL, "live PostgreSQL is required");
  await assertFocusedTestsPass("test/agent-cli.test.ts", [
    "agent-connect: live Postgres response-loss retry survives unrelated registration",
    "agent-connect: live Postgres crash-completed expiry and prune revoke committed tokens",
    "agent-connect: live Postgres cleanup miss racing approval commit revokes committed token",
    "agent-connect: live Postgres expiry CAS interleavings revoke committed tokens",
  ]);
});

test("consent-exchange: SQLite restart, single-use, and response-loss recovery", async () => {
  await assertFocusedNestedTestsPass("test/security-consent-token-handoff.test.ts", [
    "concurrent SQLite redemptions converge on one stored transition",
    "an already-committed approval can create a fresh HTML handoff",
    "an exchange code survives a SQLite-backed server restart",
  ]);
});

test("batch consent: package handoff and revocation are durable", async () => {
  await assertFocusedTestsPass("test/batch-consent-per-source-gate.test.ts", [
    "batch consent gate: HTML approval hands off the package token durably",
    "batch consent gate: a revoked package is not delivered by a stored exchange code",
  ]);
});

test("auth consent device PostgreSQL: concurrent redemption and package revocation", async () => {
  assert.ok(process.env.PDPP_TEST_POSTGRES_URL, "live PostgreSQL is required");
  await assertFocusedTestsPass("test/auth-consent-device-postgres-path.test.ts", [
    "consent handoff: concurrent Postgres redemption converges on one persisted token",
    "consent handoff: Postgres package delivery works and revocation fails closed",
  ]);
});
