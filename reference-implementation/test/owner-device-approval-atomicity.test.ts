// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type AuthorizationDecisionFaultHook,
  approveOwnerDeviceAuthorization,
  denyOwnerDeviceAuthorization,
  exchangeOwnerDeviceCode,
  initiateOwnerDeviceAuthorization,
  introspect,
  type OwnerDeviceApprovalFaultHook,
  registerDynamicClient,
  seedPreRegisteredClients,
} from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";

const CLIENT_ID = "owner_device_atomicity_client";
const FORCED_AFTER_TOKEN_INSERT_RE = /forced after_token_insert/;
const FORCED_BEFORE_TOKEN_INSERT_RE = /forced before_token_insert/;
const FORCED_DENIAL_EVENT_RE = /forced denial event rollback/;

interface StartedOwnerDeviceAuth {
  device_code: string;
  user_code: string;
}

function setupSqliteAuth(path = ":memory:") {
  initDb(path);
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

function ownerDeviceRow(deviceCode: string): { status: string; subject_id: string | null; token_id: string | null } {
  const row = getDb()
    .prepare("SELECT status, subject_id, token_id FROM owner_device_auth WHERE device_code = ?")
    .get(deviceCode) as { status: string; subject_id: string | null; token_id: string | null } | undefined;
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

function clientIssuerSubject(clientId: string): string | null {
  const row = getDb().prepare("SELECT metadata_json FROM oauth_clients WHERE client_id = ?").get(clientId) as
    | { metadata_json: string }
    | undefined;
  assert.ok(row, "oauth client row must exist");
  const metadata = JSON.parse(row.metadata_json) as { issuer_subject_id?: string };
  return metadata.issuer_subject_id || null;
}

function throwingHook(stageToThrow: Parameters<OwnerDeviceApprovalFaultHook>[0]): OwnerDeviceApprovalFaultHook {
  return (stage) => {
    if (stage === stageToThrow) {
      throw Object.assign(new Error(`forced ${stage}`), { code: `forced_${stage}` });
    }
  };
}

function createPause(): { paused: Promise<void>; release: () => void; hook: () => Promise<void> } {
  let release: () => void = () => undefined;
  let markPaused: () => void = () => undefined;
  const paused = new Promise<void>((resolve) => {
    markPaused = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    hook: async () => {
      markPaused();
      await resumed;
    },
    paused,
    release,
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

  assert.deepEqual(ownerDeviceRow(started.device_code), { status: "pending", subject_id: null, token_id: null });
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

  assert.deepEqual(ownerDeviceRow(started.device_code), { status: "pending", subject_id: null, token_id: null });
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

  assert.deepEqual(ownerDeviceRow(started.device_code), {
    status: "approved",
    subject_id: "owner_local",
    token_id: approved.access_token,
  });
  assert.equal(countOwnerTokensForClient(), 1);
  assert.equal(countOwnerDeviceEvents(started.device_code, "consent.approved"), 1);
  assert.equal(countRows("spine_events", "event_type = 'token.issued'"), 1);

  const tokenState = await introspect(approved.access_token);
  assert.equal(tokenState.active, true, "bound owner token introspects active");
  assert.equal(tokenState.pdpp_token_kind, "owner");
});

test("owner-device dynamic client binding rolls back with failed approval", async () => {
  initDb();
  const registered = await registerDynamicClient({
    client_name: "Owner Device Dynamic Client",
    token_endpoint_auth_method: "none",
  });
  const clientId = String(registered.client_id);
  const started = await initiateOwnerDeviceAuthorization(clientId, {
    expiresIn: 300,
    interval: 1,
  });
  assert.equal(clientIssuerSubject(clientId), null);

  await assert.rejects(
    approveOwnerDeviceAuthorization(started.user_code, "owner_A", {
      faultHook: throwingHook("after_token_insert"),
    }),
    FORCED_AFTER_TOKEN_INSERT_RE
  );

  assert.equal(clientIssuerSubject(clientId), null, "dynamic subject stamp rolls back with approval failure");
  const recovered = await approveOwnerDeviceAuthorization(started.user_code, "owner_A");
  assert.equal(clientIssuerSubject(clientId), "owner_A", "retry binds dynamic client in the successful transaction");
  assert.equal(recovered.subject_id, "owner_A");
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

test("owner-device approval recovery rejects a different authenticated subject", async () => {
  await setupSqliteAuth();
  const started = await startOwnerDeviceAuth();

  const ownerA = await approveOwnerDeviceAuthorization(started.user_code, "owner_A");
  assert.equal(ownerA.subject_id, "owner_A");

  await assert.rejects(
    approveOwnerDeviceAuthorization(started.user_code, "owner_B"),
    (err: unknown) => err instanceof Error && "code" in err && err.code === "not_found"
  );

  assert.deepEqual(ownerDeviceRow(started.device_code), {
    status: "approved",
    subject_id: "owner_A",
    token_id: ownerA.access_token,
  });
  assert.equal(countOwnerTokensForClient(), 1, "cross-subject recovery does not remint");
  const tokenState = await introspect(ownerA.access_token);
  assert.equal(tokenState.active, true, "original owner token remains active");
  assert.equal(tokenState.subject_id, "owner_A");
});

test("owner-device approval allows only the claimed subject under mixed concurrent calls", async () => {
  await setupSqliteAuth();
  const started = await startOwnerDeviceAuth();

  const attempts = await Promise.allSettled(
    Array.from({ length: 16 }, (_, index) =>
      approveOwnerDeviceAuthorization(started.user_code, index % 2 === 0 ? "owner_A" : "owner_B")
    )
  );
  const approvals = attempts
    .filter((attempt): attempt is PromiseFulfilledResult<Record<string, unknown>> => attempt.status === "fulfilled")
    .map((attempt) => attempt.value);
  assert.ok(approvals.length >= 1, "one subject claims the pending authorization");
  assert.ok(approvals.length <= 8, "only calls for the claimed subject can recover");
  const approvedSubjects = new Set(approvals.map((approval) => approval.subject_id));
  const approvedTokens = new Set(approvals.map((approval) => approval.access_token));
  assert.equal(approvedSubjects.size, 1, "all successful callers have the same subject");
  assert.equal(approvedTokens.size, 1, "all successful callers have the same token");
  assert.equal(countOwnerTokensForClient(), 1, "mixed concurrent calls mint one owner token");

  const row = ownerDeviceRow(started.device_code);
  assert.equal(row.status, "approved");
  assert.equal(row.subject_id, [...approvedSubjects][0]);
  assert.equal(row.token_id, [...approvedTokens][0]);
});

test("owner-device approval rejects expired rows before owner token issuance", async () => {
  await setupSqliteAuth();
  const started = await startOwnerDeviceAuth();
  getDb()
    .prepare("UPDATE owner_device_auth SET expires_at = ? WHERE device_code = ?")
    .run(new Date(Date.now() - 1000).toISOString(), started.device_code);

  await assert.rejects(
    approveOwnerDeviceAuthorization(started.user_code, "owner_local"),
    (err: unknown) => err instanceof Error && "code" in err && err.code === "not_found"
  );

  assert.deepEqual(ownerDeviceRow(started.device_code), { status: "expired", subject_id: null, token_id: null });
  assert.equal(countOwnerTokensForClient(), 0, "expired approval does not mint");
});

test("owner-device denial persists one rejection event and is terminal", async () => {
  await setupSqliteAuth();
  const started = await startOwnerDeviceAuth();

  await denyOwnerDeviceAuthorization(started.user_code);

  assert.deepEqual(ownerDeviceRow(started.device_code), { status: "denied", subject_id: null, token_id: null });
  assert.equal(countOwnerTokensForClient(), 0, "denial does not mint an owner token");
  assert.equal(countOwnerDeviceEvents(started.device_code, "request.rejected"), 1);
  assert.equal(countOwnerDeviceEvents(started.device_code, "consent.approved"), 0);
});

test("owner-device approval wins a denial race without contradictory rejection", async () => {
  await setupSqliteAuth();
  const started = await startOwnerDeviceAuth();
  const pause = createPause();
  const denial = denyOwnerDeviceAuthorization(started.user_code, "owner_local", {
    beforeCasHook: pause.hook,
  });
  await pause.paused;
  const approved = await approveOwnerDeviceAuthorization(started.user_code, "owner_local");
  pause.release();

  await assert.rejects(
    denial,
    (err: unknown) => err instanceof Error && "code" in err && err.code === "approval_conflict"
  );
  assert.equal((await introspect(approved.access_token)).active, true);
  assert.equal(countOwnerTokensForClient(), 1);
  assert.equal(countOwnerDeviceEvents(started.device_code, "consent.approved"), 1);
  assert.equal(countOwnerDeviceEvents(started.device_code, "request.rejected"), 0);
});

test("owner-device denial wins before approval and denial event rolls back on failure", async () => {
  await setupSqliteAuth();
  const rollback = await startOwnerDeviceAuth();
  const faultHook: AuthorizationDecisionFaultHook = (stage) => {
    if (stage === "after_event_before_commit") {
      throw new Error("forced denial event rollback");
    }
  };
  await assert.rejects(
    denyOwnerDeviceAuthorization(rollback.user_code, "owner_local", { faultHook }),
    FORCED_DENIAL_EVENT_RE
  );
  assert.equal(ownerDeviceRow(rollback.device_code).status, "pending");
  assert.equal(countOwnerDeviceEvents(rollback.device_code, "request.rejected"), 0);

  const denied = await startOwnerDeviceAuth();
  await denyOwnerDeviceAuthorization(denied.user_code, "owner_local");
  await assert.rejects(
    approveOwnerDeviceAuthorization(denied.user_code, "owner_local"),
    (err: unknown) => err instanceof Error && "code" in err && err.code === "approval_conflict"
  );
  assert.equal(countOwnerTokensForClient(), 0);
  assert.equal(countOwnerDeviceEvents(denied.device_code, "request.rejected"), 1);
  assert.equal(countOwnerDeviceEvents(denied.device_code, "consent.approved"), 0);
});

test("owner-device mixed approval and denial contention has one durable terminal outcome", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pdpp-owner-contention-"));
  const dbPath = join(directory, "pdpp.sqlite");
  try {
    setupSqliteAuth(dbPath);
    const started = await startOwnerDeviceAuth();
    await Promise.allSettled(
      Array.from({ length: 16 }, (_, index) =>
        index % 2 === 0
          ? approveOwnerDeviceAuthorization(started.user_code, "owner_local")
          : denyOwnerDeviceAuthorization(started.user_code, "owner_local")
      )
    );
    const row = ownerDeviceRow(started.device_code);
    assert.ok(row.status === "approved" || row.status === "denied");
    assert.equal(countOwnerDeviceEvents(started.device_code, "consent.approved"), row.status === "approved" ? 1 : 0);
    assert.equal(countOwnerDeviceEvents(started.device_code, "request.rejected"), row.status === "denied" ? 1 : 0);
    assert.equal(countOwnerTokensForClient(), row.status === "approved" ? 1 : 0);

    closeDb();
    initDb(dbPath);
    assert.deepEqual(ownerDeviceRow(started.device_code), row, "terminal decision survives close/reopen");
    assert.equal(countOwnerDeviceEvents(started.device_code, "consent.approved"), row.status === "approved" ? 1 : 0);
    assert.equal(countOwnerDeviceEvents(started.device_code, "request.rejected"), row.status === "denied" ? 1 : 0);
  } finally {
    closeDb();
    rmSync(directory, { force: true, recursive: true });
  }
});
