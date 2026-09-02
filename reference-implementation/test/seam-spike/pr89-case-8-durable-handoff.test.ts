// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const REFERENCE_ROOT = resolve(import.meta.dirname, "../..");

const POSTGRES_TEST_OPTIONS = {
  skip: process.env.PDPP_TEST_POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runNodeTests(
  file: string,
  testNames: readonly string[],
  opts: { forceSqlite?: boolean } = {}
): Promise<string> {
  const childEnv = { ...process.env };
  childEnv.NODE_TEST_CONTEXT = undefined;
  if (opts.forceSqlite) {
    childEnv.DATABASE_URL = undefined;
    childEnv.PDPP_DATABASE_URL = undefined;
    childEnv.PDPP_STORAGE_BACKEND = undefined;
    childEnv.PDPP_TEST_POSTGRES_URL = undefined;
  }
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

async function assertFocusedNestedTestsPass(
  file: string,
  parentTestName: string,
  testNames: readonly string[],
  opts: { forceSqlite?: boolean } = {}
): Promise<void> {
  const output = await runNodeTests(file, [parentTestName, ...testNames], opts);
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

test("terminal decisions: SQLite approval and denial arbitrate without contradictory evidence", async () => {
  await assertFocusedTestsPass("test/as-device-decision-outcome-pure.test.ts", [
    "executeAsDeviceDecision: approval_conflict maps to HTTP 409 and preserves trace ids",
  ]);
  await assertFocusedTestsPass("test/owner-device-approval-atomicity.test.ts", [
    "owner-device approval wins a denial race without contradictory rejection",
    "owner-device denial wins before approval and denial event rolls back on failure",
    "owner-device mixed approval and denial contention has one durable terminal outcome",
  ]);
  await assertFocusedNestedTestsPass(
    "test/security-consent-token-handoff.test.ts",
    "security: harden consent token handoff",
    [
      "ordinary approval wins a paused denial without contradictory denial evidence",
      "ordinary denial is terminal and rolls back its event on transaction failure",
      "ordinary mixed approval and denial contention has one terminal outcome",
    ],
    { forceSqlite: true }
  );
});

test(
  "terminal decisions: live PostgreSQL approval and denial arbitrate atomically",
  POSTGRES_TEST_OPTIONS,
  async () => {
    await assertFocusedTestsPass("test/auth-consent-device-postgres-path.test.ts", [
      "owner device authorization: approve and deny arbitrate one terminal decision on postgres",
      "pending consent: approve and deny arbitrate atomically with rollback on postgres",
    ]);
  }
);

test("agent-cli: crash recovery from committed pending approval", async () => {
  await assertFocusedTestsPass("test/agent-cli.test.ts", [
    "agent-connect: approval committed before completion recovers at poll time",
  ]);
});

test("agent-connect: registration response is cache-safe", async () => {
  await assertFocusedTestsPass("test/agent-cli.test.ts", [
    "agent-connect: registration 201 carries credential no-store headers",
  ]);
});

test("agent-connect: denial response is bounded", async () => {
  await assertFocusedTestsPass("test/agent-cli.test.ts", ["agent-connect: owner denial returns bounded access_denied"]);
});

test("agent-connect: denial is durable across approval_id and completion failure", async () => {
  await assertFocusedTestsPass("test/agent-cli.test.ts", [
    "agent-connect: approval_id denial projects to polling",
    "agent-connect: denial completion failure is reconciled during polling",
    "agent-connect: expired consent projects to bounded expired_token polling",
  ]);
});

test(
  "agent-connect: live PostgreSQL denial is durable across approval_id and restart",
  POSTGRES_TEST_OPTIONS,
  async () => {
    await assertFocusedTestsPass("test/agent-cli.test.ts", [
      "agent-connect: live Postgres denial projects and recovers after completion failure",
    ]);
  }
);

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

test(
  "agent-cli: live PostgreSQL approved expiry and revocation fail closed before delivery",
  POSTGRES_TEST_OPTIONS,
  async () => {
    await assertFocusedTestsPass("test/agent-cli.test.ts", [
      "agent-connect: live Postgres approved expiry and revocation fail closed before delivery",
    ]);
  }
);

test("agent-cli: live PostgreSQL crash expiry/prune and response-loss replay", POSTGRES_TEST_OPTIONS, async () => {
  await assertFocusedTestsPass("test/agent-cli.test.ts", [
    "agent-connect: live Postgres response-loss retry survives unrelated registration",
    "agent-connect: live Postgres crash-completed expiry and prune revoke committed tokens",
    "agent-connect: live Postgres cleanup miss racing approval commit revokes committed token",
    "agent-connect: live Postgres expiry CAS interleavings revoke committed tokens",
  ]);
});

test("consent-exchange: SQLite restart, single-use, and response-loss recovery", async () => {
  await assertFocusedNestedTestsPass(
    "test/security-consent-token-handoff.test.ts",
    "security: harden consent token handoff",
    [
      "concurrent SQLite redemptions converge on one stored transition",
      "an already-committed approval can create a fresh HTML handoff",
      "an exchange code survives a SQLite-backed server restart",
    ]
  );
});

test("batch consent: package handoff and revocation are durable", async () => {
  await assertFocusedTestsPass("test/batch-consent-per-source-gate.test.ts", [
    "batch consent terminal decision is exclusive across approval and denial",
    "batch consent gate: HTML approval hands off the package token durably",
    "batch consent gate: a revoked package is not delivered by a stored exchange code",
  ]);
});

test(
  "auth consent device PostgreSQL: concurrent redemption and package revocation",
  POSTGRES_TEST_OPTIONS,
  async () => {
    await assertFocusedTestsPass("test/auth-consent-device-postgres-path.test.ts", [
      "consent handoff: concurrent Postgres redemption converges on one persisted token",
      "consent handoff: Postgres package delivery works and revocation fails closed",
    ]);
  }
);
