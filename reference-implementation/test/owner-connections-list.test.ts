// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration suite for the bearer-authed owner-agent control-surface listing
 * `GET /v1/owner/connections` (mounted from `server/routes/owner-connections.ts`).
 *
 * Covers the Lane B slice of the owner-agent control surface:
 *
 *   - a trusted owner-agent bearer can list configured connection instances;
 *   - client grant tokens and missing/unauthenticated bearers cannot;
 *   - `/mcp` continues to reject owner bearers (the boundary this lane preserves);
 *   - each row exposes `connection_id`, the deprecated `connector_instance_id`
 *     alias, `connector_id`/`connector_key`, `display_name`, lifecycle fields,
 *     and a `label_status` (`owner_set` vs `fallback`);
 *   - two Amazon connections share the `amazon` connector identity but carry
 *     distinct `connection_id` values (multi-connection disambiguation);
 *   - a never-labeled connection (display_name defaulting to the connector id)
 *     reports `label_status: "fallback"` rather than masquerading as owner-set.
 *
 * Spec: openspec/changes/add-owner-agent-control-surface
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { COLLECTOR_PROTOCOL_VERSION } from "../server/collector-protocol.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { startServer } from "../server/index.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const OWNER_SUBJECT_ID = "owner_local";
const NOW = "2026-05-31T00:00:00.000Z";
const RESUME_PATTERN = /resume/;
const OWNER_AGENT_PATTERN = /owner-agent/i;

interface TestHttpServer {
  close: (callback: () => void) => void;
  closeAllConnections?: () => void;
}

interface TestServerHandle {
  asPort: number;
  asServer: TestHttpServer;
  rsPort: number;
  rsServer: TestHttpServer;
  schedulerManager?: {
    stop?: () => void;
  };
}

async function closeServer(server: TestServerHandle): Promise<void> {
  server.schedulerManager?.stop?.();
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  await Promise.allSettled([
    new Promise<void>((resolve) => server.asServer.close(resolve)),
    new Promise<void>((resolve) => server.rsServer.close(resolve)),
  ]);
}

interface FetchJsonResult {
  body: unknown;
  resp: Response;
  status: number;
}

async function fetchJson(url: string, opts: RequestInit = {}): Promise<FetchJsonResult> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body, resp, status: resp.status };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function withServer(fn: (ctx: { asUrl: string; rsUrl: string }) => Promise<void>): Promise<void> {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", ownerAuthPassword: "", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    await fn({ asUrl, rsUrl });
  } finally {
    await closeServer(server);
  }
}

// Device-code exchange yields an owner-kind bearer (pdpp_token_kind: "owner").
// Default subject_id matches the seeded OWNER_SUBJECT_ID so seeded instances
// resolve to the token's owner.
async function issueOwnerToken(asUrl: string, subjectId: string = OWNER_SUBJECT_ID): Promise<string> {
  const clientId = "cli_longview";
  const device = asRecord(
    (
      await fetchJson(`${asUrl}/oauth/device_authorization`, {
        body: new URLSearchParams({ client_id: clientId }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      })
    ).body
  );
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: String(device.user_code) }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const tok = asRecord(
    (
      await fetchJson(`${asUrl}/oauth/token`, {
        body: new URLSearchParams({
          client_id: clientId,
          device_code: String(device.device_code),
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      })
    ).body
  );
  assert.ok(tok.access_token, "device exchange should issue an owner token");
  return String(tok.access_token);
}

// PAR + consent yields a grant-scoped client-kind bearer (pdpp_token_kind:
// "client"). These must NOT reach the owner-agent control surface.
async function approveClientGrant(asUrl: string, connectorId: string, streamName: string): Promise<string> {
  const par = asRecord(
    (
      await fetchJson(`${asUrl}/oauth/par`, {
        body: JSON.stringify({
          authorization_details: [
            {
              access_mode: "continuous",
              purpose_code: "https://pdpp.dev/purpose/analytics",
              purpose_description: "owner-connections boundary test",
              source: { id: connectorId, kind: "connector" },
              streams: [{ fields: ["id"], name: streamName }],
              type: "https://pdpp.dev/data-access",
            },
          ],
          client_id: "longview",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    ).body
  );
  const approved = asRecord(
    (
      await fetchJson(`${asUrl}/consent/approve`, {
        body: JSON.stringify({ request_uri: par.request_uri, subject_id: OWNER_SUBJECT_ID }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    ).body
  );
  assert.ok(approved.token, "consent approval should issue a client grant token");
  return String(approved.token);
}

function loadManifest(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "..", "packages", "polyfill-connectors", "manifests", `${name}.json`), "utf8")
  ) as Record<string, unknown>;
}

async function registerConnector(asUrl: string, manifest: Record<string, unknown>): Promise<Record<string, unknown>> {
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(resp.status, 201, `register ${manifest.connector_id} failed: ${resp.status}`);
  return manifest;
}

interface SeedInstanceInput {
  connectorId: string;
  connectorInstanceId: string;
  displayName: string;
  sourceBinding?: unknown;
  sourceBindingKey: string;
}

async function seedInstance({
  connectorInstanceId,
  connectorId,
  displayName,
  sourceBindingKey,
  sourceBinding,
}: SeedInstanceInput): Promise<void> {
  const store = createSqliteConnectorInstanceStore();
  await store.upsert({
    connectorId,
    connectorInstanceId,
    createdAt: NOW,
    displayName,
    ownerSubjectId: OWNER_SUBJECT_ID,
    sourceBinding: sourceBinding ?? { account_hint: sourceBindingKey },
    sourceBindingKey,
    sourceKind: "account",
    status: "active",
    updatedAt: NOW,
  });
}

function byFamilyUrl(row: Record<string, unknown>, family: string): string {
  const action = asArray(row.supported_actions).find((a) => asRecord(a).family === family);
  return String(asRecord(action).url);
}

test("owner-agent bearer lists a configured connection with full identity + owner_set label", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest("amazon"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey);
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_amazon_personal",
      displayName: "the owner personal",
      sourceBindingKey: "the owner@example.com",
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connections`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    assert.equal(status, 200);
    const bodyRecord = asRecord(body);
    assert.equal(bodyRecord.object, "list");
    const data = asArray(bodyRecord.data);
    assert.equal(data.length, 1);
    const row = asRecord(data[0]);
    assert.equal(row.object, "owner_connection");
    assert.equal(row.connection_id, "cin_amazon_personal");
    // Deprecated alias preserved for compatibility.
    assert.equal(row.connector_instance_id, "cin_amazon_personal");
    assert.equal(row.connector_id, connectorKey);
    assert.equal(row.connector_key, connectorKey);
    assert.equal(row.display_name, "the owner personal");
    assert.equal(row.label_status, "owner_set");
    assert.equal(row.status, "active");
    assert.equal(row.source_kind, "account");
    assert.equal(row.schedule, null);

    // Capability-advertised, instance-scoped control actions (task 2.2 /
    // design.md #5). Projected from the same catalog GET /v1/owner/control
    // reads, so the row can never claim a supported action the control
    // document calls unsupported.
    const supportedActions = row.supported_actions;
    assert.ok(Array.isArray(supportedActions), "row must carry supported_actions");
    const byFamily = new Map(supportedActions.map((a) => [asRecord(a).family, asRecord(a)]));
    // Surface-level families (discover/list/initiate) are NOT instance-scoped
    // and must be absent from a per-connection action list.
    assert.equal(byFamily.has("discover_control_capabilities"), false);
    assert.equal(byFamily.has("list_connections"), false);
    assert.equal(byFamily.has("initiate_connection"), false);
    // rename is supported over the owner-agent bearer and carries THIS
    // connection's concrete URL (placeholder resolved, no `{connection_id}`).
    const rename = byFamily.get("rename_connection");
    assert.ok(rename, "rename_connection action must be advertised");
    assert.equal(rename?.status, "supported");
    assert.equal(rename?.method, "PATCH");
    const renameUrl = String(rename?.url);
    assert.ok(renameUrl.endsWith("/v1/owner/connections/cin_amazon_personal"), renameUrl);
    assert.ok(!renameUrl.includes("{connection_id}"), "placeholder must be resolved");
    // manage_schedule is supported over the owner-agent bearer and carries THIS
    // connection's concrete pause URL (placeholder resolved); the resume sibling
    // is named in the reason (tasks 6.1-6.3).
    const manageSchedule = byFamily.get("manage_schedule");
    assert.ok(manageSchedule, "manage_schedule action must be advertised");
    assert.equal(manageSchedule?.status, "supported");
    assert.equal(manageSchedule?.method, "POST");
    const manageScheduleUrl = String(manageSchedule?.url);
    assert.ok(
      manageScheduleUrl.endsWith("/v1/owner/connections/cin_amazon_personal/schedule/pause"),
      manageScheduleUrl
    );
    assert.ok(!manageScheduleUrl.includes("{connection_id}"), "placeholder must be resolved");
    assert.match(String(manageSchedule?.reason), RESUME_PATTERN);
    // run_connection is supported over the owner-agent bearer and carries THIS
    // connection's concrete run URL (placeholder resolved); connector-only
    // addressing is named in the reason (tasks 6.1-6.3).
    const runConnection = byFamily.get("run_connection");
    assert.ok(runConnection, "run_connection action must be advertised");
    assert.equal(runConnection?.status, "supported");
    assert.equal(runConnection?.method, "POST");
    const runConnectionUrl = String(runConnection?.url);
    assert.ok(runConnectionUrl.endsWith("/v1/owner/connections/cin_amazon_personal/run"), runConnectionUrl);
    assert.ok(!runConnectionUrl.includes("{connection_id}"), "placeholder must be resolved");
    // inspect_diagnostics is supported and instance-scoped: the per-connection
    // URL resolves to this connection's diagnostics route.
    const inspectDiagnostics = byFamily.get("inspect_diagnostics");
    assert.ok(inspectDiagnostics, "inspect_diagnostics action must be advertised");
    assert.equal(inspectDiagnostics?.status, "supported");
    assert.equal(inspectDiagnostics?.method, "GET");
    const inspectDiagnosticsUrl = String(inspectDiagnostics?.url);
    assert.ok(
      inspectDiagnosticsUrl.endsWith("/v1/owner/connections/cin_amazon_personal/diagnostics"),
      inspectDiagnosticsUrl
    );
    assert.ok(!inspectDiagnosticsUrl.includes("{connection_id}"), "placeholder must be resolved");
    // revoke_connection is supported and instance-scoped: the per-connection
    // URL resolves to this connection's revoke route.
    const revokeConnection = byFamily.get("revoke_connection");
    assert.ok(revokeConnection, "revoke_connection action must be advertised");
    assert.equal(revokeConnection?.status, "supported");
    assert.equal(revokeConnection?.method, "POST");
    const revokeConnectionUrl = String(revokeConnection?.url);
    assert.ok(revokeConnectionUrl.endsWith("/v1/owner/connections/cin_amazon_personal/revoke"), revokeConnectionUrl);
    assert.ok(!revokeConnectionUrl.includes("{connection_id}"), "placeholder must be resolved");
    // delete_connection is now supported and instance-scoped: the per-connection
    // URL resolves to this connection's DELETE route (the bare connection
    // resource, no `/delete` suffix). See add-owner-connection-delete-contract.
    const deleteConnection = byFamily.get("delete_connection");
    assert.ok(deleteConnection, "delete_connection action must be advertised");
    assert.equal(deleteConnection?.status, "supported");
    assert.equal(deleteConnection?.method, "DELETE");
    const deleteConnectionUrl = String(deleteConnection?.url);
    assert.ok(deleteConnectionUrl.endsWith("/v1/owner/connections/cin_amazon_personal"), deleteConnectionUrl);
    assert.ok(!deleteConnectionUrl.includes("{connection_id}"), "placeholder must be resolved");
  });
});

test("per-connection supported_actions agree with GET /v1/owner/control", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest("amazon"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey);
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_amazon_personal",
      displayName: "the owner personal",
      sourceBindingKey: "the owner@example.com",
    });
    const ownerToken = await issueOwnerToken(asUrl);

    const control = asRecord(
      (
        await fetchJson(`${rsUrl}/v1/owner/control`, {
          headers: { Authorization: `Bearer ${ownerToken}` },
        })
      ).body
    );
    const connections = asRecord(
      (
        await fetchJson(`${rsUrl}/v1/owner/connections`, {
          headers: { Authorization: `Bearer ${ownerToken}` },
        })
      ).body
    );

    const controlByFamily = new Map(asArray(control.actions).map((a) => [asRecord(a).family, asRecord(a)]));
    const row = asRecord(asArray(connections.data).find((r) => asRecord(r).connection_id === "cin_amazon_personal"));
    // Every instance-scoped action on the row must carry the same status the
    // control document reports for that family — single source of truth.
    for (const action of asArray(row.supported_actions)) {
      const actionRecord = asRecord(action);
      const fromControl = controlByFamily.get(actionRecord.family);
      assert.ok(fromControl, `control document must also list ${String(actionRecord.family)}`);
      assert.equal(actionRecord.status, fromControl?.status, `status mismatch for ${String(actionRecord.family)}`);
      assert.equal(actionRecord.method, fromControl?.method, `method mismatch for ${String(actionRecord.family)}`);
      assert.equal(actionRecord.reason, fromControl?.reason, `reason mismatch for ${String(actionRecord.family)}`);
    }
    // The control document's rename URL is templated; the row's is concrete.
    const controlRename = controlByFamily.get("rename_connection");
    assert.ok(String(controlRename?.url).includes("{connection_id}"));
    assert.ok(byFamilyUrl(row, "rename_connection").endsWith("/v1/owner/connections/cin_amazon_personal"));
  });
});

test("owner-agent bearer sees fallback label_status for a never-labeled connection", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey);
    // display_name left equal to the connector id — the storage default for an
    // unlabeled connection. The surface must report this as label-needed.
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_unlabeled",
      displayName: connectorKey,
      sourceBindingKey: "acct_unlabeled",
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connections`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    assert.equal(status, 200);
    const row = asRecord(
      asArray(asRecord(body).data).find((r) => asRecord(r).connection_id === "cin_spotify_unlabeled")
    );
    assert.ok(row.connection_id, "unlabeled connection must appear in the listing");
    assert.equal(row.label_status, "fallback");
  });
});

test("owner-agent bearer sees fallback label_status for a registry URL display_name", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest("amazon"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey);
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_amazon_registry_fallback",
      displayName: String(manifest.connector_id),
      sourceBindingKey: "acct_registry_fallback",
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connections`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    assert.equal(status, 200);
    const row = asRecord(
      asArray(asRecord(body).data).find((r) => asRecord(r).connection_id === "cin_amazon_registry_fallback")
    );
    assert.ok(row.connection_id, "registry fallback connection must appear in the listing");
    assert.equal(row.display_name, manifest.connector_id);
    assert.equal(row.label_status, "fallback");
  });
});

test("owner-agent bearer distinguishes two Amazon connections by connection_id", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest("amazon"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey);
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_amazon_personal",
      displayName: "the owner personal",
      sourceBindingKey: "the owner@example.com",
    });
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_amazon_shared",
      // Distinct binding key so the upsert does not collapse onto the first row.
      displayName: connectorKey, // unlabeled -> fallback
      sourceBindingKey: "shared@example.com",
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/owner/connections?connector_id=${encodeURIComponent(connectorKey)}`,
      {
        headers: { Authorization: `Bearer ${ownerToken}` },
      }
    );

    assert.equal(status, 200);
    const amazonRows = asArray(asRecord(body).data)
      .map((r) => asRecord(r))
      .filter((r) => r.connector_key === connectorKey);
    assert.equal(amazonRows.length, 2, "both Amazon connections must be listed");
    const ids = amazonRows.map((r) => r.connection_id).sort((a, b) => String(a).localeCompare(String(b)));
    assert.deepEqual(ids, ["cin_amazon_personal", "cin_amazon_shared"]);
    // Same connector identity, distinct connection identity.
    assert.ok(amazonRows.every((r) => r.connector_key === connectorKey));
    assert.equal(new Set(ids).size, 2);
    // One labeled, one label-needed — the agent can tell them apart and knows
    // which still needs a label.
    const personal = amazonRows.find((r) => r.connection_id === "cin_amazon_personal");
    const shared = amazonRows.find((r) => r.connection_id === "cin_amazon_shared");
    assert.equal(personal?.label_status, "owner_set");
    assert.equal(personal?.display_name, "the owner personal");
    assert.equal(shared?.label_status, "fallback");
  });
});

// Enroll a connector through the REAL binding-aware device-exporter path
// (mint code -> enroll), so the resulting instance's `source_kind` is the one
// the enrollment resolver derived from the manifest, not a seeded value. The
// enrollment-codes route is owner-session authed and defaults the owner subject
// to `owner_local` (no session password in the test server), matching the
// bearer subject issued by `issueOwnerToken`, so the listing resolves to it.
async function enrollThroughBindingAwarePath(
  asUrl: string,
  { connectorId, localBindingName }: { connectorId: string; localBindingName: string }
): Promise<Record<string, unknown>> {
  const codeResp = await fetchJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
    body: JSON.stringify({ connector_id: connectorId, local_binding_name: localBindingName }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(codeResp.status, 201, JSON.stringify(codeResp.body));
  const codeBody = asRecord(codeResp.body);
  const enrollResp = await fetchJson(`${asUrl}/_ref/device-exporters/enroll`, {
    body: JSON.stringify({ enrollment_code: codeBody.enrollment_code }),
    headers: {
      "Content-Type": "application/json",
      "X-PDPP-Collector-Protocol": COLLECTOR_PROTOCOL_VERSION,
    },
    method: "POST",
  });
  assert.equal(enrollResp.status, 201, JSON.stringify(enrollResp.body));
  return asRecord(enrollResp.body);
}

// Honesty proof for the owner-run browser-collector live-proof procedure (the
// prior operator runbook doc was removed in LFDT curation). The procedure's
// Step 2 / Step 4 tell the owner to verify the enrolled Amazon connection is
// recorded as `browser_collector` after the live run. `source_kind` is NOT
// exposed on the device-exporter `source-instances` JSON, so the owner is
// directed at the owner-agent listing instead. This pins that the
// binding-aware enrollment path surfaces `source_kind: "browser_collector"`
// end-to-end on `GET /v1/owner/connections`, so that verification step is real
// and no owner SQL is required. It does NOT flip Amazon's intent off `unsupported`.
test("owner-agent bearer sees source_kind=browser_collector for an Amazon connection enrolled through the binding-aware path", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest("amazon"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey);
    const enrolled = await enrollThroughBindingAwarePath(asUrl, {
      connectorId: "amazon",
      localBindingName: "the owner-personal-amazon",
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connections`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    assert.equal(status, 200);
    const row = asRecord(
      asArray(asRecord(body).data).find((r) => asRecord(r).connection_id === enrolled.connector_instance_id)
    );
    assert.ok(row.connection_id, "the enrolled Amazon connection must be listed for its owner");
    assert.equal(row.connector_key, connectorKey);
    // The runbook's source-kind verification: the owner-agent API honestly
    // reports browser_collector (not local_device, not account) for a
    // browser-bound connector enrolled through the real path.
    assert.equal(row.source_kind, "browser_collector");
    assert.notEqual(row.source_kind, "local_device");
    assert.equal(asRecord(row.source_binding).kind, "browser_collector");
  });
});

test("owner-agent connection listing rejects a client grant token with 403", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest("amazon"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey);
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_amazon_personal",
      displayName: "the owner personal",
      sourceBindingKey: "the owner@example.com",
    });
    // A client grant needs a stream to scope to; amazon's first stream suffices.
    const { streams } = manifest;
    const streamName = String(asRecord(asArray(streams)[0]).name);
    const clientToken = await approveClientGrant(asUrl, connectorKey, streamName);

    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connections`, {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    assert.equal(status, 403);
    assert.equal(asRecord(asRecord(body).error).code, "permission_error");
  });
});

test("owner-agent connection listing rejects a request with no bearer (401)", async () => {
  await withServer(async ({ rsUrl }) => {
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connections`);
    assert.equal(status, 401);
    assert.equal(asRecord(asRecord(body).error).type, "authentication_error");
  });
});

test("/mcp continues to reject owner-agent bearers (boundary preserved)", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(`${rsUrl}/mcp`, {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list", params: {} }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    assert.equal(status, 403);
    const errorRecord = asRecord(asRecord(body).error);
    assert.equal(errorRecord.code, "permission_error");
    assert.match(String(errorRecord.message ?? ""), OWNER_AGENT_PATTERN);
  });
});
