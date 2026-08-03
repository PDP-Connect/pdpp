// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Disposable-Postgres oracle for the live-proven resurrection bug on
// waspflow/local-device-revoke-pg-0803: commit 8264cb5d6 ("preserve an
// existing connector_instance's lifecycle" in the boot-time local_device
// backfill) does NOT hold on Postgres once more than one
// `device_source_instances` row shares the same local_device binding (i.e.
// the same `connector_instance_id`) -- the exact live shape observed on
// pdpp-reference for connector_instance cin_7763bf59803d54ad6d433cf7
// (4 device_source_instances rows, one binding "codex-vivid-fish").
//
// Root cause: `migratePostgresLocalDeviceConnectorInstances` iterates
// `device_source_instances` rows `sequentially` inside ONE transaction and
// re-derives `connectorInstanceId` per row as
//   row.connector_instance_id || existingBindingInstanceId || legacyInstanceId || makeConnectorInstanceId(...)
// When multiple sibling rows share a binding, later iterations' UPSERT can
// still overwrite the earlier iteration's correctly-preserved lifecycle if
// any sibling's own `row.status` disagrees -- device_source_instances is
// NEVER updated by owner-revoke (zero-cascade contract), so only ONE of the
// N sibling device rows needs to still read as "active" (which they all
// legitimately do, forever) to blow away the preserved `revoked` lifecycle
// on a later iteration within the same boot.
//
// This test seeds the exact live shape against a disposable Postgres
// (PDPP_TEST_POSTGRES_URL), revokes via the real HTTP route, restarts via a
// genuine startServer() re-bootstrap, and asserts the connector_instances
// row stays revoked.

import assert from "node:assert/strict";
import test from "node:test";

import { COLLECTOR_PROTOCOL_VERSION } from "../server/collector-protocol.ts";
import { closeDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { closePostgresStorage, postgresQuery } from "../server/postgres-storage.ts";

const PROTOCOL_HEADERS = { "X-PDPP-Collector-Protocol": COLLECTOR_PROTOCOL_VERSION };
const OWNER_SUBJECT_ID = "owner_local";
const OWNER_CLIENT_ID = "cli_longview";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

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

function authHeaders(deviceToken: string): Record<string, string> {
  return { Authorization: `Bearer ${deviceToken}`, ...PROTOCOL_HEADERS };
}

// Enrolls a FRESH device onto the SAME `localBindingName` -- reproducing the
// live shape where multiple physical devices/re-enrollments share one
// local_device binding and therefore one connector_instance_id.
async function enrollDeviceOntoBinding(
  asUrl: string,
  localBindingName: string,
  connectorId = "codex"
): Promise<EnrolledDevice> {
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

async function connectorInstanceRow(
  connectorInstanceId: string
): Promise<{ revoked_at: string | null; status: string }> {
  const result = await postgresQuery<{ revoked_at: string | null; status: string }>(
    "SELECT status, revoked_at FROM connector_instances WHERE connector_instance_id = $1",
    [connectorInstanceId]
  );
  assert.ok(result.rows[0], "connector_instances row must exist");
  return result.rows[0];
}

async function deviceSourceInstanceCount(connectorInstanceId: string): Promise<number> {
  const result = await postgresQuery<{ count: string }>(
    "SELECT count(*)::text AS count FROM device_source_instances WHERE connector_instance_id = $1",
    [connectorInstanceId]
  );
  return Number(result.rows[0]?.count ?? "0");
}

async function issueOwnerToken(asUrl: string): Promise<string> {
  const authResp = await fetch(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: OWNER_CLIENT_ID }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const device = (await authResp.json()) as { device_code: string; user_code: string };
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({
      subject_id: OWNER_SUBJECT_ID,
      user_code: device.user_code,
    }).toString(),
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

async function wipeLocalDeviceState(): Promise<void> {
  await postgresQuery(
    "DELETE FROM device_source_instances WHERE connector_id = 'codex' AND local_binding_id LIKE 'pg-multi-%'"
  );
  await postgresQuery("DELETE FROM device_exporters WHERE device_id LIKE 'dexp_%' AND created_at > '2000-01-01'");
  await postgresQuery(
    "DELETE FROM connector_instances WHERE connector_id = 'codex' AND source_kind = 'local_device' AND source_binding_key IN (SELECT source_binding_key FROM connector_instances WHERE source_binding_json->>'local_binding_name' LIKE 'pg-multi-%')"
  );
}

test("owner-revoked local_device connection with MULTIPLE sibling device_source_instances stays revoked across a Postgres restart", {
  skip: !POSTGRES_URL && "set PDPP_TEST_POSTGRES_URL to run",
}, async () => {
  if (!POSTGRES_URL) {
    throw new Error(
      "this test body must not run when PDPP_TEST_POSTGRES_URL is unset (test.skip should have prevented it)"
    );
  }
  closeDb();
  const bindingName = "pg-multi-codex-vivid-fish";
  let server = await startServer({
    asPort: 0,
    databaseUrl: POSTGRES_URL,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
    storageBackend: "postgres",
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  let connectorInstanceId = "";
  const devices: EnrolledDevice[] = [];
  try {
    // Reproduce the live shape: 4 separate device enrollments landing on
    // the SAME local_device binding, hence the same connector_instance_id.
    // Sequential by necessity: concurrent enrollment-code minting against
    // the SAME binding can race/dedupe, which is not what this test is
    // exercising.
    for (let i = 0; i < 4; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential enrollment onto one binding is required to avoid a code-minting race.
      devices.push(await enrollDeviceOntoBinding(asUrl, bindingName));
    }
    const [firstDevice] = devices;
    assert.ok(firstDevice, "at least one device must have enrolled");
    connectorInstanceId = firstDevice.connector_instance_id;
    for (const device of devices) {
      assert.equal(
        device.connector_instance_id,
        connectorInstanceId,
        "all sibling enrollments onto one binding must resolve to one connector_instance_id"
      );
    }
    assert.equal(await deviceSourceInstanceCount(connectorInstanceId), 4);
    assert.equal((await connectorInstanceRow(connectorInstanceId)).status, "active");

    const ownerToken = await issueOwnerToken(asUrl);
    const revokeResp = await postJson(
      `${rsUrl}/v1/owner/connections/${encodeURIComponent(connectorInstanceId)}/revoke`,
      {},
      { Authorization: `Bearer ${ownerToken}` }
    );
    assert.equal(revokeResp.status, 200, JSON.stringify(revokeResp.body));

    const revokedRow = await connectorInstanceRow(connectorInstanceId);
    assert.equal(revokedRow.status, "revoked");
    assert.ok(revokedRow.revoked_at, "revoke must stamp revoked_at");

    // A live device on this binding does not know it was revoked and keeps
    // heartbeating / re-enrolling (app restart, network blip) -- exercise
    // performFirstEnrollment's re-enroll path AFTER the revoke, before the
    // reference restart, matching what a real fleet device would do.
    const postRevokeDevice = await enrollDeviceOntoBinding(asUrl, bindingName);
    assert.equal(postRevokeDevice.connector_instance_id, connectorInstanceId);
    const rowAfterPostRevokeEnroll = await connectorInstanceRow(connectorInstanceId);
    assert.equal(
      rowAfterPostRevokeEnroll.status,
      "revoked",
      "re-enroll of a sibling device after revoke must not resurrect the connection"
    );
  } finally {
    await closeServer(server);
    await closePostgresStorage();
  }

  // Simulate the real reference restart: reopen the SAME Postgres database
  // and re-run bootstrap (including migratePostgresLocalDeviceConnectorInstances)
  // exactly as pdpp-reference does on every container boot.
  server = await startServer({
    asPort: 0,
    databaseUrl: POSTGRES_URL,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
    storageBackend: "postgres",
  });
  const asUrl2 = `http://localhost:${server.asPort}`;
  try {
    const rowAfterRestart = await connectorInstanceRow(connectorInstanceId);
    assert.equal(
      rowAfterRestart.status,
      "revoked",
      "boot-time local_device backfill must not resurrect an owner-revoked connector_instance " +
        "when multiple sibling device_source_instances share its binding"
    );
    assert.ok(
      rowAfterRestart.revoked_at,
      "boot-time local_device backfill must not clear revoked_at when multiple siblings share a binding"
    );

    // A live device on this binding keeps heartbeating after the restart too
    // (it has no idea it was revoked -- heartbeat never checks connector_instances
    // status). Confirm a SECOND restart, after live post-restart heartbeat
    // traffic, still preserves the revoke.
    await Promise.all(
      devices.map((device) =>
        postJson(
          `${asUrl2}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/heartbeat`,
          {
            connector_id: "codex",
            records_pending: 0,
            source_instances: [
              { records_pending: 0, source_instance_id: device.source_instance_id, status: "healthy" },
            ],
          },
          authHeaders(device.device_token)
        )
      )
    );
  } finally {
    await closeServer(server);
    await closePostgresStorage();
  }

  server = await startServer({
    asPort: 0,
    databaseUrl: POSTGRES_URL,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
    storageBackend: "postgres",
  });
  try {
    const rowAfterSecondRestart = await connectorInstanceRow(connectorInstanceId);
    assert.equal(
      rowAfterSecondRestart.status,
      "revoked",
      "a SECOND restart after post-restart heartbeat traffic must still preserve the revoke"
    );
    assert.ok(rowAfterSecondRestart.revoked_at, "revoked_at must still be set after the second restart");
    await wipeLocalDeviceState();
  } finally {
    await closeServer(server);
    await closePostgresStorage();
  }
});
