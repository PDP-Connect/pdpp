// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration suite for the owner-agent connection-reactivate control routes
 * (bearer: `server/routes/owner-connection-reactivate.ts`) and the owner-session
 * cookie sibling (`/_ref` route in `server/routes/ref-connectors.ts`):
 *
 *   POST /v1/owner/connections/:connectionId/reactivate  (bearer, on RS)
 *   POST /v1/owner/connectors/:connectorId/reactivate   (bearer, on RS)
 *   POST /_ref/connections/:connectorInstanceId/reactivate (owner-session, on AS)
 *
 * Covers:
 *   - a revoked connection is flipped back to `active`, `revoked_at` is cleared,
 *     already-collected records are preserved, and a reactivate audit event is emitted;
 *   - reactivate on a non-revoked (active) connection returns connector_instance_not_revoked (409);
 *   - reactivate on a foreign/unknown connection_id returns connector_instance_not_found (404);
 *   - a cross-owner reactivate is rejected (foreign id -> 404);
 *   - the connector-only bearer route auto-selects a single revoked connection;
 *   - client grant tokens (403) and missing bearers (401) cannot reactivate;
 *   - the `/_ref` (owner-session cookie) route mirrors the bearer behaviour;
 *   - a repeat reactivate on an already-active connection returns 409.
 *
 * The `/_ref` tests run in open mode (no ownerAuthPassword) so the owner-session
 * gate does not interfere -- auth boundary tests are out of scope here.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { listSpineEventsPage, type SpineEventRecord } from "../lib/spine.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { ingestRecord } from "../server/records.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const BEARER_PATTERN = /Bearer\s/i;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const OWNER_SUBJECT_ID = "owner_local";
const OTHER_SUBJECT_ID = "owner_other";
const OWNER_CLIENT_ID = "cli_longview";
const NOW = "2026-05-31T00:00:00.000Z";

interface CloseableServer {
  close: (callback?: (err?: Error) => void) => unknown;
  closeAllConnections: () => void;
}

type StartedServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: CloseableServer;
  rsServer: CloseableServer;
  schedulerManager?: { stop?: () => void };
};

async function closeServer(server: StartedServer): Promise<void> {
  server.schedulerManager?.stop?.();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

interface JsonResult {
  body: unknown;
  resp: Response;
  status: number;
}

async function fetchJson(url: string | URL, opts: RequestInit = {}): Promise<JsonResult> {
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

// Open mode (ownerAuthPassword: '') lets /_ref routes work without CSRF/session
// ceremony, and device/approve issues a bearer without a gate.
async function withServer(
  fn: (ctx: { asUrl: string; rsUrl: string; server: StartedServer }) => Promise<void>
): Promise<void> {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
  })) as StartedServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    await fn({ asUrl, rsUrl, server });
  } finally {
    await closeServer(server);
  }
}

// Device-code exchange yields an owner-kind bearer (pdpp_token_kind: "owner").
async function issueOwnerToken(asUrl: string, subjectId = OWNER_SUBJECT_ID): Promise<string> {
  const device = (
    await fetchJson(`${asUrl}/oauth/device_authorization`, {
      body: new URLSearchParams({ client_id: OWNER_CLIENT_ID }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    })
  ).body as { user_code: string; device_code: string };
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const tok = (
    await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: OWNER_CLIENT_ID,
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    })
  ).body as { access_token?: string };
  assert.ok(tok.access_token, "device exchange should issue an owner token");
  return tok.access_token;
}

// PAR + consent yields a grant-scoped client-kind bearer (pdpp_token_kind: "client").
// These must NOT reach the owner-agent control surface.
async function approveClientGrant(
  asUrl: string,
  sourceId: string,
  streamName: string,
  instanceId: string
): Promise<string> {
  const par = (
    await fetchJson(`${asUrl}/oauth/par`, {
      body: JSON.stringify({
        authorization_details: [
          {
            access_mode: "continuous",
            purpose_code: "https://pdpp.dev/purpose/analytics",
            purpose_description: "owner-connection reactivate boundary test",
            source: { id: sourceId, kind: "connector" },
            streams: [{ fields: ["id"], instance_ids: [instanceId], name: streamName }],
            type: "https://pdpp.dev/data-access",
          },
        ],
        client_id: "longview",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    })
  ).body as { request_uri?: string };
  assert.ok(par.request_uri);
  const review = (
    await fetchJson(`${asUrl}/consent/review`, {
      body: JSON.stringify({ request_uri: par.request_uri, subject_id: OWNER_SUBJECT_ID }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    })
  ).body as { approval_review?: object; approval_review_revision?: string; request_uri?: string };
  assert.ok(review.approval_review);
  assert.ok(review.approval_review_revision);
  assert.equal(review.request_uri, par.request_uri);
  const approved = (
    await fetchJson(`${asUrl}/consent/approve`, {
      body: JSON.stringify({
        approval_review_revision: review.approval_review_revision,
        request_uri: review.request_uri,
      }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    })
  ).body as { token?: string };
  assert.ok(approved.token, "consent approval should issue a client grant token");
  return approved.token;
}

interface ReferenceManifest {
  connector_id: string;
  display_name?: string;
  streams: { name: string; [key: string]: unknown }[];
  [key: string]: unknown;
}

function loadReferenceManifest(name: string): ReferenceManifest {
  return JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "fixtures", "seed-manifests", `${name}.json`), "utf8")
  ) as ReferenceManifest;
}

async function registerConnector(asUrl: string, manifest: ReferenceManifest): Promise<ReferenceManifest> {
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(resp.status, 201, `register ${manifest.connector_id} failed: ${resp.status}`);
  return manifest;
}

interface SeedInstanceOptions {
  connectorId: string;
  connectorInstanceId: string;
  displayName: string;
  ownerSubjectId?: string;
  sourceBinding?: Record<string, unknown>;
  sourceBindingKey: string;
  sourceKind?: string;
  status?: string;
}

// seedInstance allows seeding with a custom status (default: 'active') so cross-
// owner revoked instances can be set up without going through the route.
async function seedInstance({
  connectorInstanceId,
  connectorId,
  displayName,
  sourceBindingKey,
  sourceKind = "account",
  sourceBinding,
  ownerSubjectId = OWNER_SUBJECT_ID,
  status = "active",
}: SeedInstanceOptions): Promise<void> {
  const store = createSqliteConnectorInstanceStore();
  await store.upsert({
    connectorId,
    connectorInstanceId,
    createdAt: NOW,
    displayName,
    ownerSubjectId,
    sourceBinding: sourceBinding ?? { account_hint: sourceBindingKey },
    sourceBindingKey,
    sourceKind,
    status,
    updatedAt: NOW,
  });
}

// Local structural type for the store's real (but unexported) ConnectorInstance
// return shape -- covers only the fields these tests read.
interface ConnectorInstanceLike {
  connectorInstanceId: string;
  revokedAt: string | null;
  status: string;
  [key: string]: unknown;
}

// SQLite store get() is synchronous in :memory: mode.
function getInstance(connectorInstanceId: string): ConnectorInstanceLike | null {
  return createSqliteConnectorInstanceStore().get(connectorInstanceId) as ConnectorInstanceLike | null;
}

// Count physically-stored records for a connection. Proves reactivate does NOT
// delete already-collected records -- a direct table read avoids depending on
// manifest-projection plumbing for this invariant.
function countStoredRecords(connectorInstanceId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM records WHERE connector_instance_id = ?")
    .get(connectorInstanceId) as { n: number };
  return row.n;
}

// bearer owner-agent POSTs to the RS (rsUrl).
function postReactivate(rsUrl: string, ownerToken: string, path: string): Promise<JsonResult> {
  return fetchJson(`${rsUrl}${path}`, {
    headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
    method: "POST",
  });
}

function postRevoke(rsUrl: string, ownerToken: string, path: string): Promise<JsonResult> {
  return fetchJson(`${rsUrl}${path}`, {
    headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
    method: "POST",
  });
}

interface ReactivateResponseBody {
  connection_id?: string;
  error?: { code?: string; type?: string; message?: string };
  object?: string;
  reactivated_at?: string;
  status?: string;
  [key: string]: unknown;
}

function reactivateBody(result: JsonResult): ReactivateResponseBody {
  return result.body as ReactivateResponseBody;
}

interface AuditReactivateData {
  connection_id?: string;
  connector_key?: string;
  operation?: string;
  [key: string]: unknown;
}

function auditData(event: SpineEventRecord): AuditReactivateData {
  return event.data as AuditReactivateData;
}

function findReactivateAuditEvent(resp: Response): SpineEventRecord {
  const traceId = resp.headers.get("PDPP-Reference-Trace-Id");
  assert.ok(traceId?.startsWith("trc_"), "reactivate response should carry an audit trace id");
  assert.ok(traceId, "trace id must be present");
  const page = listSpineEventsPage("trace", traceId, { limit: 20 });
  const event = page.events.find((entry) => entry.event_type === "owner_agent.connection.reactivate");
  assert.ok(event, "expected owner_agent.connection.reactivate audit event");
  assert.equal(event.request_id, resp.headers.get("Request-Id"));
  assert.equal(event.token_id, null, "audit event must not store bearer tokens");
  // No secret material in the serialized event payload.
  const serialized = JSON.stringify(event);
  assert.ok(!BEARER_PATTERN.test(serialized), "audit must not carry a bearer token");
  assert.ok(!serialized.includes("access_token"), "audit must not carry an access token");
  return event;
}

test("owner-agent bearer reactivates a revoked connection (200), flips to active, clears revoked_at, preserves records", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    const [firstStream] = manifest.streams;
    assert.ok(firstStream, "manifest carries at least one stream");
    const stream = firstStream.name;
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_personal",
      displayName: "My Spotify",
      sourceBindingKey: "the owner@example.com",
    });

    // Ingest a record before revoke to verify it survives the round-trip.
    const storageTarget = { connector_id: connectorKey, connector_instance_id: "cin_spotify_personal" };
    await ingestRecord(storageTarget, { data: { id: "rec_1", name: "pre-revoke" }, key: "rec_1", stream });
    assert.equal(countStoredRecords("cin_spotify_personal"), 1, "record should exist before revoke");

    const ownerToken = await issueOwnerToken(asUrl);

    // Revoke first so we have a revoked state to reactivate from.
    const revoke = await postRevoke(rsUrl, ownerToken, "/v1/owner/connections/cin_spotify_personal/revoke");
    assert.equal(revoke.status, 200);
    assert.equal(getInstance("cin_spotify_personal")?.status, "revoked");
    assert.ok(getInstance("cin_spotify_personal")?.revokedAt, "revoked_at must be stamped after revoke");

    // Now reactivate.
    const reactivate = await postReactivate(rsUrl, ownerToken, "/v1/owner/connections/cin_spotify_personal/reactivate");
    assert.equal(reactivate.status, 200);
    assert.equal(reactivateBody(reactivate).object, "owner_connection_reactivate");
    assert.equal(reactivateBody(reactivate).connection_id, "cin_spotify_personal");
    assert.equal(reactivateBody(reactivate).status, "active");
    const reactivatedAt = reactivateBody(reactivate).reactivated_at;
    assert.ok(typeof reactivatedAt === "string" && reactivatedAt.length > 0);

    // Store row is back to active with revoked_at cleared.
    const row = getInstance("cin_spotify_personal");
    assert.ok(row, "expected the reactivated connection row");
    assert.equal(row.status, "active", "connection must be active after reactivate");
    assert.ok(!row.revokedAt, "revoked_at must be cleared after reactivate");

    // Records survive the round-trip -- reactivate is zero-cascade.
    assert.equal(countStoredRecords("cin_spotify_personal"), 1, "pre-revoke record must survive reactivate");

    // Audit event emitted with correct fields.
    const audit = findReactivateAuditEvent(reactivate.resp);
    assert.equal(audit.actor_type, "owner_agent");
    assert.equal(audit.client_id, OWNER_CLIENT_ID);
    assert.equal(audit.subject_id, OWNER_SUBJECT_ID);
    assert.equal(audit.object_type, "connection");
    assert.equal(audit.object_id, "cin_spotify_personal");
    assert.equal(audit.status, "succeeded");
    assert.equal(auditData(audit).operation, "reactivate");
    assert.equal(auditData(audit).connection_id, "cin_spotify_personal");
    assert.equal(auditData(audit).connector_key, connectorKey);
  });
});

test("reactivate on an already-active connection returns connector_instance_not_revoked (409)", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_active",
      displayName: "My Spotify",
      sourceBindingKey: "the owner@example.com",
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const result = await postReactivate(rsUrl, ownerToken, "/v1/owner/connections/cin_spotify_active/reactivate");
    assert.equal(result.status, 409, "reactivating an active connection must return 409");
    assert.equal(reactivateBody(result).error?.code, "connector_instance_not_revoked");

    // Connection must remain active.
    assert.equal(getInstance("cin_spotify_active")?.status, "active");
  });
});

test("reactivate on a foreign/unknown connection_id returns 404", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    await registerConnector(asUrl, loadReferenceManifest("spotify"));

    const ownerToken = await issueOwnerToken(asUrl);
    const result = await postReactivate(rsUrl, ownerToken, "/v1/owner/connections/cin_does_not_exist/reactivate");
    assert.equal(result.status, 404);
    assert.equal(reactivateBody(result).error?.code, "connector_instance_not_found");
  });
});

test("owner-agent cannot reactivate another owner's connection (cross-owner returns 404)", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    // Seed a revoked instance belonging to OTHER_SUBJECT_ID.
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_other",
      displayName: "Other Spotify",
      ownerSubjectId: OTHER_SUBJECT_ID,
      sourceBindingKey: "other@example.com",
    });
    // Flip it to revoked directly via the store (synchronous in SQLite mode).
    createSqliteConnectorInstanceStore().updateStatus("cin_spotify_other", {
      revokedAt: new Date().toISOString(),
      status: "revoked",
      updatedAt: new Date().toISOString(),
    });
    assert.equal(getInstance("cin_spotify_other")?.status, "revoked");

    // A token for OWNER_SUBJECT_ID must not reach the other owner's connection.
    const ownerToken = await issueOwnerToken(asUrl, OWNER_SUBJECT_ID);
    const result = await postReactivate(rsUrl, ownerToken, "/v1/owner/connections/cin_spotify_other/reactivate");
    // The resolver surfaces a cross-owner hit as 404 (ownership mismatch maps to
    // not_found); the requireOwner gate may fire first with 403 depending on how
    // the token was issued. Either way the request must not succeed.
    assert.ok(
      result.status === 404 || result.status === 403,
      `cross-owner reactivate must return 403 or 404, got ${result.status}`
    );
    // The other owner's connection must remain revoked.
    assert.equal(getInstance("cin_spotify_other")?.status, "revoked");
  });
});

test("owner-agent connector-only reactivate route reactivates the single revoked connection", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_only",
      displayName: "My Spotify",
      sourceBindingKey: "the owner@example.com",
    });

    const ownerToken = await issueOwnerToken(asUrl);

    // Revoke via connection-scoped route first.
    await postRevoke(rsUrl, ownerToken, "/v1/owner/connections/cin_spotify_only/revoke");
    assert.equal(getInstance("cin_spotify_only")?.status, "revoked");

    // Reactivate via connector-only route.
    const result = await postReactivate(
      rsUrl,
      ownerToken,
      `/v1/owner/connectors/${encodeURIComponent(connectorKey)}/reactivate`
    );
    assert.equal(result.status, 200);
    assert.equal(reactivateBody(result).object, "owner_connection_reactivate");
    assert.equal(reactivateBody(result).status, "active");
    const row = getInstance("cin_spotify_only");
    assert.ok(row, "expected the reactivated connection row");
    assert.equal(row.status, "active");
    assert.ok(!row.revokedAt, "revoked_at must be cleared via connector-only route");

    const audit = findReactivateAuditEvent(result.resp);
    assert.equal(auditData(audit).connection_id, "cin_spotify_only");
    assert.equal(auditData(audit).operation, "reactivate");
  });
});

test("client grant token cannot reactivate (403)", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_client_test",
      displayName: "My Spotify",
      sourceBindingKey: "the owner@example.com",
    });

    // Client grant must not reach reactivate.
    const [clientStream] = manifest.streams;
    assert.ok(clientStream, "manifest carries at least one stream");
    const clientToken = await approveClientGrant(
      asUrl,
      manifest.connector_id,
      clientStream.name,
      "cin_spotify_client_test"
    );

    // Revoke it via owner token after minting the client grant. Approval only
    // authorizes active instances, but the negative-auth assertion targets the
    // owner-control boundary, not consent eligibility.
    const ownerToken = await issueOwnerToken(asUrl);
    await postRevoke(rsUrl, ownerToken, "/v1/owner/connections/cin_spotify_client_test/revoke");

    const result = await fetchJson(`${rsUrl}/v1/owner/connections/cin_spotify_client_test/reactivate`, {
      headers: { Authorization: `Bearer ${clientToken}`, "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(result.status, 403, "client grant must not reach reactivate");
    // Connection must remain revoked.
    assert.equal(getInstance("cin_spotify_client_test")?.status, "revoked");
  });
});

test("missing bearer cannot reactivate (401)", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_noauth",
      displayName: "My Spotify",
      sourceBindingKey: "the owner@example.com",
    });
    const result = await fetchJson(`${rsUrl}/v1/owner/connections/cin_spotify_noauth/reactivate`, {
      method: "POST",
    });
    assert.equal(result.status, 401);
  });
});

test("owner-session /_ref reactivate mirrors bearer: flips revoked->active, emits audit, preserves records", async () => {
  // /_ref routes are on the AS (asUrl). Open mode means no CSRF/session ceremony.
  await withServer(async ({ asUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    const [refStream] = manifest.streams;
    assert.ok(refStream, "manifest carries at least one stream");
    const stream = refStream.name;
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_ref",
      displayName: "My Spotify",
      sourceBindingKey: "the owner@example.com",
    });

    // Ingest a record before the round-trip.
    const storageTarget = { connector_id: connectorKey, connector_instance_id: "cin_spotify_ref" };
    await ingestRecord(storageTarget, { data: { id: "rec_ref", name: "ref-test" }, key: "rec_ref", stream });

    // Revoke via /_ref (open mode, no cookie needed).
    const revokeResp = await fetchJson(`${asUrl}/_ref/connections/cin_spotify_ref/revoke`, {
      method: "POST",
    });
    assert.equal(revokeResp.status, 200);
    assert.equal(getInstance("cin_spotify_ref")?.status, "revoked");

    // Reactivate via /_ref.
    const reactivateResp = await fetchJson(`${asUrl}/_ref/connections/cin_spotify_ref/reactivate`, {
      method: "POST",
    });
    assert.equal(
      reactivateResp.status,
      200,
      `/_ref reactivate must return 200, got ${reactivateResp.status}: ${JSON.stringify(reactivateResp.body)}`
    );
    assert.equal(reactivateBody(reactivateResp).object, "ref_connection_reactivate");
    assert.equal(reactivateBody(reactivateResp).status, "active");

    // Connection is active, revoked_at cleared, record intact.
    const row = getInstance("cin_spotify_ref");
    assert.ok(row, "expected the reactivated connection row");
    assert.equal(row.status, "active");
    assert.ok(!row.revokedAt, "revoked_at must be cleared");
    assert.equal(countStoredRecords("cin_spotify_ref"), 1, "record must survive reactivate");

    // Audit event emitted under the correct event type and actor_type.
    const traceId = reactivateResp.resp.headers.get("PDPP-Reference-Trace-Id");
    assert.ok(traceId?.startsWith("trc_"), "/_ref reactivate must carry audit trace id");
    assert.ok(traceId, "trace id must be present");
    const page = listSpineEventsPage("trace", traceId, { limit: 20 });
    const event = page.events.find((e) => e.event_type === "owner_agent.connection.reactivate");
    assert.ok(event, "expected owner_agent.connection.reactivate audit event from /_ref path");
    assert.equal(event.actor_type, "owner_session");
    assert.equal(event.status, "succeeded");
    assert.equal(auditData(event).operation, "reactivate");
  });
});

test("repeat reactivate on already-active connection returns connector_instance_not_revoked (409)", async () => {
  // Proves the not_revoked guard fires even for a connection that was previously
  // revoked and then reactivated -- the guard is on the current status, not history.
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_repeat",
      displayName: "My Spotify",
      sourceBindingKey: "the owner@example.com",
    });

    const ownerToken = await issueOwnerToken(asUrl);

    // Revoke then reactivate (first reactivate succeeds).
    await postRevoke(rsUrl, ownerToken, "/v1/owner/connections/cin_spotify_repeat/revoke");
    const first = await postReactivate(rsUrl, ownerToken, "/v1/owner/connections/cin_spotify_repeat/reactivate");
    assert.equal(first.status, 200);
    assert.equal(getInstance("cin_spotify_repeat")?.status, "active");

    // A second reactivate must fail: the connection is now active, not revoked.
    const second = await postReactivate(rsUrl, ownerToken, "/v1/owner/connections/cin_spotify_repeat/reactivate");
    assert.equal(second.status, 409);
    assert.equal(reactivateBody(second).error?.code, "connector_instance_not_revoked");
    // Still active.
    assert.equal(getInstance("cin_spotify_repeat")?.status, "active");
  });
});
