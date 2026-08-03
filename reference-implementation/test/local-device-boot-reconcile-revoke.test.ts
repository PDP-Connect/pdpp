// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// waspflow/local-device-revoke-reconcile-0803: an owner-revoked local_device
// connection resurrected as `active`/`revoked_at = NULL` after a reference
// restart, even though the enrollment-code re-enroll path itself
// (`performFirstEnrollment`, fixed by 556e89110) correctly preserves
// `connector_instances.revoked_at` on re-enroll.
//
// Root cause is a SEPARATE write path: the boot-time deterministic backfill
// `migrateLocalDeviceConnectorInstances` (SQLite, server/db.ts) and its
// Postgres sibling `migratePostgresLocalDeviceConnectorInstances`
// (server/postgres-storage.ts) run unconditionally on every startup (not
// gated to fresh DBs) and derive `connector_instances.status`/`revoked_at`
// PURELY from `device_source_instances.status` — via
// `row.status === "revoked" ? "revoked" : "active"` — then
// unconditionally overwrite the EXISTING `connector_instances` row via
// `ON CONFLICT(connector_instance_id) DO UPDATE SET status = excluded.status,
// ... revoked_at = excluded.revoked_at`.
//
// Owner-revoke (`server/routes/owner-connection-revoke.ts`) is deliberately
// "zero-cascade": it flips only `connector_instances`, and NEVER touches
// `device_source_instances` (documented contract — must not change). So
// after an owner revokes a local_device connection, `device_source_instances`
// legitimately stays `active`. The next boot's backfill then reads that
// still-`active` device_source_instances row as ground truth and silently
// writes `connector_instances` back to `active`/`revoked_at = NULL`,
// resurrecting the connection into fleet-health/audit scope — with NO device
// re-enrollment, HTTP request, or code change involved at all.
//
// The fix: the backfill must never downgrade an existing `connector_instances`
// row's already-more-authoritative revoked lifecycle. It may still
// materialize/activate a connector_instance that doesn't exist yet (the
// genuine bootstrap case this backfill exists for), but once a
// connector_instances row already carries an explicit `revoked` (or `paused`)
// status, that status is preserved across every subsequent boot.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { COLLECTOR_PROTOCOL_VERSION } from "../server/collector-protocol.ts";
import { closeDb, getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";

const PROTOCOL_HEADERS = { "X-PDPP-Collector-Protocol": COLLECTOR_PROTOCOL_VERSION };
const OWNER_SUBJECT_ID = "owner_local";
const OWNER_CLIENT_ID = "cli_longview";

interface CloseableTestServer {
  readonly asPort: number;
  readonly asServer: { closeAllConnections?: () => void; close: (callback: () => void) => void };
  readonly rsPort: number;
  readonly rsServer: { closeAllConnections?: () => void; close: (callback: () => void) => void };
}

async function closeServer(server: CloseableTestServer): Promise<void> {
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  const closeOne = (srv: CloseableTestServer["asServer"]) =>
    new Promise<void>((resolve) => {
      let settled = false;
      const t = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      }, 2000);
      srv.close(() => {
        if (!settled) {
          settled = true;
          clearTimeout(t);
          resolve();
        }
      });
    });
  await Promise.allSettled([closeOne(server.asServer), closeOne(server.rsServer)]);
}

interface JsonResponse {
  readonly body: Record<string, unknown> | null;
  readonly status: number;
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<JsonResponse> {
  const resp = await fetch(url, {
    body: JSON.stringify(body),
    headers: { Accept: "application/json", "Content-Type": "application/json", ...headers },
    method: "POST",
  });
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = (await resp.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON error responses intentionally retain a null parsed body.
  }
  return { body: parsed, status: resp.status };
}

function bodyOf(response: JsonResponse): Record<string, unknown> {
  assert.ok(response.body, "response has a JSON body");
  return response.body;
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  assert.equal(typeof value, "string", `${field} must be a string`);
  return value as string;
}

interface EnrolledDevice {
  readonly connector_id: string;
  readonly connector_instance_id: string;
  readonly device_id: string;
  readonly device_token: string;
  readonly source_instance_id: string;
}

async function enrollDevice(asUrl: string, localBindingName: string, connectorId = "codex"): Promise<EnrolledDevice> {
  const codeResp = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
    connector_id: connectorId,
    local_binding_name: localBindingName,
  });
  assert.equal(codeResp.status, 201, JSON.stringify(codeResp.body));
  const enrollResp = await postJson(
    `${asUrl}/_ref/device-exporters/enroll`,
    { enrollment_code: stringField(bodyOf(codeResp), "enrollment_code") },
    PROTOCOL_HEADERS
  );
  assert.equal(enrollResp.status, 201, JSON.stringify(enrollResp.body));
  const body = bodyOf(enrollResp);
  const enrolled = {
    connector_id: stringField(body, "connector_id"),
    connector_instance_id: stringField(body, "connector_instance_id"),
    device_id: stringField(body, "device_id"),
    device_token: stringField(body, "device_token"),
    source_instance_id: stringField(body, "source_instance_id"),
  };
  // A fresh local_device connector instance starts `draft` until its own
  // first heartbeat/ingest activates it (initialEnrollmentStatus). Send one
  // so the revoke/restart scenario below exercises a genuinely activated
  // connection, not an unchecked-in draft.
  await postJson(
    `${asUrl}/_ref/device-exporters/${encodeURIComponent(enrolled.device_id)}/heartbeat`,
    {
      connector_id: connectorId,
      records_pending: 0,
      source_instances: [{ records_pending: 0, source_instance_id: enrolled.source_instance_id, status: "healthy" }],
    },
    authHeaders(enrolled.device_token)
  );
  return enrolled;
}

function authHeaders(deviceToken: string): Record<string, string> {
  return { Authorization: `Bearer ${deviceToken}`, ...PROTOCOL_HEADERS };
}

function connectorInstanceRow(connectorInstanceId: string): { revoked_at: string | null; status: string } {
  const row = getDb()
    .prepare("SELECT status, revoked_at FROM connector_instances WHERE connector_instance_id = ?")
    .get<{ revoked_at: string | null; status: string }>(connectorInstanceId);
  assert.ok(row, "connector_instances row must exist");
  return row;
}

async function issueOwnerToken(asUrl: string): Promise<string> {
  const authResp = await fetch(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: OWNER_CLIENT_ID }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const device = (await authResp.json()) as { device_code: string; user_code: string };
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: OWNER_SUBJECT_ID, user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const tokenResp = await fetch(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: OWNER_CLIENT_ID,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const tok = (await tokenResp.json()) as { access_token?: string };
  assert.ok(tok.access_token, "device exchange should issue an owner token");
  return tok.access_token as string;
}

function deviceSourceInstanceStatus(sourceInstanceId: string): string {
  const row = getDb()
    .prepare("SELECT status FROM device_source_instances WHERE source_instance_id = ?")
    .get<{ status: string }>(sourceInstanceId);
  assert.ok(row, "device_source_instances row must exist");
  return row.status;
}

async function withTempDbPath(fn: (dbPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-local-device-boot-reconcile-"));
  const dbPath = join(dir, "pdpp.sqlite");
  try {
    await fn(dbPath);
  } finally {
    closeDb();
    await rm(dir, { force: true, recursive: true });
  }
}

test("owner-revoked local_device connection stays revoked across a reference restart", async () => {
  await withTempDbPath(async (dbPath) => {
    const first = await startServer({ asPort: 0, dbPath, ownerAuthPassword: "", quiet: true, rsPort: 0 });
    const firstAsUrl = `http://localhost:${first.asPort}`;
    const firstRsUrl = `http://localhost:${first.rsPort}`;
    let device: EnrolledDevice;
    try {
      device = await enrollDevice(firstAsUrl, "revoke-then-reboot");
      assert.equal(connectorInstanceRow(device.connector_instance_id).status, "active");

      // Owner-revoke is deliberately zero-cascade (owner-connection-revoke.ts):
      // it flips ONLY connector_instances. device_source_instances is left
      // untouched — this is the documented, correct contract and must not change.
      const ownerToken = await issueOwnerToken(firstAsUrl);
      const revokeResp = await postJson(
        `${firstRsUrl}/v1/owner/connections/${encodeURIComponent(device.connector_instance_id)}/revoke`,
        {},
        { Authorization: `Bearer ${ownerToken}` }
      );
      assert.equal(revokeResp.status, 200, JSON.stringify(revokeResp.body));

      const revokedRow = connectorInstanceRow(device.connector_instance_id);
      assert.equal(revokedRow.status, "revoked");
      assert.ok(revokedRow.revoked_at, "revoke must stamp revoked_at");
      // Confirms the zero-cascade contract: the sibling table is untouched.
      assert.equal(deviceSourceInstanceStatus(device.source_instance_id), "active");
    } finally {
      await closeServer(first);
    }

    // Simulate a reference restart: reopen the SAME durable sqlite file.
    // startServer() runs initDb() internally, which unconditionally re-runs
    // migrateLocalDeviceConnectorInstances on every boot.
    const second = await startServer({ asPort: 0, dbPath, quiet: true, rsPort: 0 });
    try {
      const rowAfterRestart = connectorInstanceRow(device.connector_instance_id);
      assert.equal(
        rowAfterRestart.status,
        "revoked",
        "boot-time local_device backfill must not resurrect an owner-revoked connector_instance"
      );
      assert.ok(
        rowAfterRestart.revoked_at,
        "boot-time local_device backfill must not clear revoked_at on an owner-revoked connector_instance"
      );
    } finally {
      await closeServer(second);
    }
  });
});

test("an active local_device connection stays active across a reference restart", async () => {
  await withTempDbPath(async (dbPath) => {
    const first = await startServer({ asPort: 0, dbPath, quiet: true, rsPort: 0 });
    let device: EnrolledDevice;
    try {
      device = await enrollDevice(`http://localhost:${first.asPort}`, "active-through-reboot");
      assert.equal(connectorInstanceRow(device.connector_instance_id).status, "active");
    } finally {
      await closeServer(first);
    }

    const second = await startServer({ asPort: 0, dbPath, quiet: true, rsPort: 0 });
    try {
      const row = connectorInstanceRow(device.connector_instance_id);
      assert.equal(row.status, "active", "a genuinely active local_device connection must remain active on restart");
      assert.equal(row.revoked_at, null);
    } finally {
      await closeServer(second);
    }

    // A second restart (repeated boot) must be equally stable, not just the
    // first re-run.
    const third = await startServer({ asPort: 0, dbPath, quiet: true, rsPort: 0 });
    try {
      const row = connectorInstanceRow(device.connector_instance_id);
      assert.equal(row.status, "active");
      assert.equal(row.revoked_at, null);
    } finally {
      await closeServer(third);
    }
  });
});

// waspflow/local-device-revoke-pg-0803: 8264cb5d6's fix looked up the
// existing-lifecycle-to-preserve by a FRESHLY-DERIVED binding key, but the
// backfill's own UPSERT conflicts on connector_instance_id (row.connector_instance_id,
// from device_source_instances, when set). These two identities can diverge:
// a connector_instances row's OWN stored source_binding_key can predate a
// binding-key derivation change (see the D8 fix-enroll-connector-instance-pk-collision
// comment in connector-instance-store.ts for the documented legacy-key class).
// When that happens, the binding-key lookup misses even though the row the
// UPSERT will conflict against already exists and already carries an
// authoritative revoked lifecycle -- proven live on pdpp-reference for
// cin_7763bf59803d54ad6d433cf7 / cin_3b19c21af86b474fe34f5e48, both of which
// have tombstoned deterministic-id siblings (source_binding_key hashes that
// DO match today's derivation) alongside their own, differently-derived live
// row -- exactly this class of drift.
test("a revoked connector_instance whose OWN source_binding_key predates the current derivation stays revoked across a SQLite restart", async () => {
  await withTempDbPath(async (dbPath) => {
    const connectorInstanceId = "cin_bkdrift_legacy_row_0000000";
    const first = await startServer({ asPort: 0, dbPath, ownerAuthPassword: "", quiet: true, rsPort: 0 });
    try {
      const db = getDb();
      db.prepare(
        "INSERT INTO connectors(connector_id, manifest, created_at) VALUES ('bkdrift', '{}', '2026-01-01T00:00:00.000Z') ON CONFLICT(connector_id) DO NOTHING"
      ).run();
      db.prepare(
        `INSERT INTO connector_instances(connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at)
         VALUES (?, 'owner_bkdrift', 'bkdrift', 'bkdrift device', 'revoked', 'local_device', 'legacy-binding-key-that-does-not-match-current-derivation', '{"kind":"local_device","legacy_shape":true}', '2026-01-01T00:00:00.000Z', '2026-08-03T16:15:16.000Z', '2026-08-03T16:15:16.000Z')`
      ).run(connectorInstanceId);
      db.prepare(
        "INSERT INTO device_exporters(device_id, owner_subject_id, display_name, created_at, updated_at) VALUES ('dexp_bkdrift', 'owner_bkdrift', 'bkdrift device', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')"
      ).run();
      // device_source_instances.connector_instance_id is set (a completed
      // enrollment) -- so the backfill uses THIS id directly as the UPSERT
      // conflict target, bypassing the binding-key lookup for the WRITE
      // path. Only the lifecycle-to-preserve lookup goes through the
      // (drifted, missing) binding key.
      db.prepare(
        `INSERT INTO device_source_instances(source_instance_id, device_id, connector_id, local_binding_id, display_name, status, created_at, updated_at, revoked_at, connector_instance_id)
         VALUES ('dsrc_bkdrift', 'dexp_bkdrift', 'bkdrift', 'bkdrift-binding', 'bkdrift device', 'active', '2026-01-01T00:00:00.000Z', '2026-08-03T16:15:16.000Z', NULL, ?)`
      ).run(connectorInstanceId);

      const before = connectorInstanceRow(connectorInstanceId);
      assert.equal(before.status, "revoked");
      assert.ok(before.revoked_at);
    } finally {
      await closeServer(first);
    }

    const second = await startServer({ asPort: 0, dbPath, quiet: true, rsPort: 0 });
    try {
      const row = connectorInstanceRow(connectorInstanceId);
      assert.equal(
        row.status,
        "revoked",
        "a binding-key derivation drift must not cause the boot-time backfill to resurrect an owner-revoked connector_instance"
      );
      assert.ok(
        row.revoked_at,
        "a binding-key derivation drift must not cause the boot-time backfill to clear revoked_at"
      );
    } finally {
      await closeServer(second);
    }
  });
});
