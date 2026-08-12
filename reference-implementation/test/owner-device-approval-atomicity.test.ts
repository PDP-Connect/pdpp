// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  approveOwnerDeviceAuthorization,
  exchangeOwnerDeviceCode,
  initiateOwnerDeviceAuthorization,
  introspect,
  type OwnerDeviceApprovalFaultHook,
  seedPreRegisteredClients,
} from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";

const CLIENT_ID = "owner_device_atomicity_client";
const FORCED_AFTER_TOKEN_INSERT_RE = /forced after_token_insert/;
const FORCED_BEFORE_TOKEN_INSERT_RE = /forced before_token_insert/;

interface StartedOwnerDeviceAuth {
  device_code: string;
  user_code: string;
}

function setupSqliteAuth() {
  initDb();
  return seedPreRegisteredClients([
    {
      client_id: CLIENT_ID,
      metadata: {
        client_name: "Owner Device Atomicity Client",
        token_endpoint_auth_method: "none",
      },
    },
  ]);
}

async function startOwnerDeviceAuth(): Promise<StartedOwnerDeviceAuth> {
  const started = await initiateOwnerDeviceAuthorization(CLIENT_ID, {
    expiresIn: 300,
    interval: 1,
  });
  assert.equal(typeof started.device_code, "string");
  assert.equal(typeof started.user_code, "string");
  return {
    device_code: String(started.device_code),
    user_code: String(started.user_code),
  };
}

function countRows(table: string, where = "1 = 1"): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get() as { count: number };
  return row.count;
}

function ownerDeviceRow(deviceCode: string): { status: string; token_id: string | null } {
  const row = getDb().prepare("SELECT status, token_id FROM owner_device_auth WHERE device_code = ?").get(deviceCode) as
    | { status: string; token_id: string | null }
    | undefined;
  assert.ok(row, "owner_device_auth row must exist");
  return row;
}

function countOwnerTokensForClient(): number {
  return countRows("tokens", `client_id = '${CLIENT_ID}' AND token_kind = 'owner'`);
}

function countOwnerDeviceEvents(deviceCode: string, eventType: string): number {
  return countRows(
    "spine_events",
    `object_id = '${deviceCode}' AND object_type = 'owner_device_auth' AND event_type = '${eventType}'`
  );
}

function throwingHook(stageToThrow: Parameters<OwnerDeviceApprovalFaultHook>[0]): OwnerDeviceApprovalFaultHook {
  return (stage) => {
    if (stage === stageToThrow) {
      throw Object.assign(new Error(`forced ${stage}`), { code: `forced_${stage}` });
    }
  };
}

test.afterEach(() => {
  closeDb();
});

test("owner-device approval rolls back when token insertion has not started", async () => {
  await setupSqliteAuth();
  const started = await startOwnerDeviceAuth();

  await assert.rejects(
    approveOwnerDeviceAuthorization(started.user_code, "owner_local", {
      faultHook: throwingHook("before_token_insert"),
    }),
    FORCED_BEFORE_TOKEN_INSERT_RE
  );

  assert.deepEqual(ownerDeviceRow(started.device_code), { status: "pending", token_id: null });
  assert.equal(countOwnerTokensForClient(), 0, "no owner token is persisted");
  assert.equal(countOwnerDeviceEvents(started.device_code, "consent.approved"), 0, "approval event rolls back");
});

test("owner-device approval rolls back token insert and events on mid-transaction failure", async () => {
  await setupSqliteAuth();
  const started = await startOwnerDeviceAuth();

  await assert.rejects(
    approveOwnerDeviceAuthorization(started.user_code, "owner_local", {
      faultHook: throwingHook("after_token_insert"),
    }),
    FORCED_AFTER_TOKEN_INSERT_RE
  );

  assert.deepEqual(ownerDeviceRow(started.device_code), { status: "pending", token_id: null });
  assert.equal(countOwnerTokensForClient(), 0, "inserted owner token is rolled back");
  assert.equal(countOwnerDeviceEvents(started.device_code, "consent.approved"), 0, "approval event rolls back");
  assert.equal(countRows("spine_events", "event_type = 'token.issued'"), 0, "token event rolls back");
});

test("owner-device approval retry after rollback mints exactly one introspectable owner token", async () => {
  await setupSqliteAuth();
  const started = await startOwnerDeviceAuth();

  await assert.rejects(
    approveOwnerDeviceAuthorization(started.user_code, "owner_local", {
      faultHook: throwingHook("after_token_insert"),
    }),
    FORCED_AFTER_TOKEN_INSERT_RE
  );
  const approved = await approveOwnerDeviceAuthorization(started.user_code, "owner_local");
  assert.equal(typeof approved.access_token, "string");

  assert.deepEqual(ownerDeviceRow(started.device_code), { status: "approved", token_id: approved.access_token });
  assert.equal(countOwnerTokensForClient(), 1);
  assert.equal(countOwnerDeviceEvents(started.device_code, "consent.approved"), 1);
  assert.equal(countRows("spine_events", "event_type = 'token.issued'"), 1);

  const tokenState = await introspect(approved.access_token);
  assert.equal(tokenState.active, true, "bound owner token introspects active");
  assert.equal(tokenState.pdpp_token_kind, "owner");
});

test("owner-device approval is idempotent across concurrent approval and response-loss retry", async () => {
  await setupSqliteAuth();
  const started = await startOwnerDeviceAuth();

  const approvals = await Promise.all(
    Array.from({ length: 16 }, () => approveOwnerDeviceAuthorization(started.user_code, "owner_local"))
  );
  const tokens = new Set(approvals.map((approval) => approval.access_token));
  assert.equal(tokens.size, 1, "all concurrent approvals return the same bound token");
  const token = approvals[0]?.access_token;
  assert.equal(typeof token, "string");

  const retry = await approveOwnerDeviceAuthorization(started.user_code, "owner_local");
  assert.equal(retry.access_token, token, "retry after lost response returns the original token");
  assert.equal(countOwnerTokensForClient(), 1, "no remint on concurrent calls or retry");
  assert.equal(countOwnerDeviceEvents(started.device_code, "consent.approved"), 1, "approval event is emitted once");
  assert.equal(countRows("spine_events", "event_type = 'token.issued'"), 1, "token.issued event is emitted once");

  const exchanged = await exchangeOwnerDeviceCode({
    clientId: CLIENT_ID,
    deviceCode: started.device_code,
  });
  assert.equal(exchanged.access_token, token, "device-code exchange returns the same approved token");
});
