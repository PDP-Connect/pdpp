// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration suite for the owner-agent connection-pause control routes
 * (bearer: `server/routes/owner-connection-pause.ts`):
 *
 *   POST /v1/owner/connections/:connectionId/pause  (bearer, on RS)
 *   POST /v1/owner/connectors/:connectorId/pause    (bearer, on RS)
 *
 * Pause is the inverse of resume (`owner-connection-resume.ts`). It exists
 * because `paused` was previously a state the system could land a row in
 * (e.g. a recovered historical-archive transplant) but that no owner could
 * ever deliberately produce — making the resume half of the pair reachable
 * only by accident. Pause is the reversible "stop collecting for now, keep
 * everything" act, deliberately distinct from revoke (the durable end of an
 * account relationship, whose inverse is an explicit re-initiate).
 *
 * Covers:
 *   - an active connection is flipped to `paused`, already-collected records
 *     AND the revoked_at null-ness are preserved, and an audit event fires;
 *   - pause on a non-active (already-paused) connection returns
 *     connector_instance_not_active (409) — a repeat pause is a typed no-op;
 *   - pause on a revoked connection returns 409 and never resurrects it;
 *   - pause on a foreign/unknown connection_id returns 404;
 *   - a cross-owner pause is rejected and does not mutate the foreign row;
 *   - the connector-only bearer route auto-selects a single active connection
 *     and rejects ambiguity across two;
 *   - client grant tokens (403) and missing bearers (401) cannot pause;
 *   - a paused connection round-trips back to active through resume, proving
 *     the two routes compose into a real owner-usable cycle.
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

// Open mode (ownerAuthPassword: '') lets device/approve issue a bearer without a gate.
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
            purpose_description: "owner-connection pause boundary test",
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

// Defaults to `active` (the pause-able state) — the mirror of the resume
// suite's `paused` default.
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

// Count physically-stored records for a connection. Proves pause does NOT
// touch already-collected records -- a direct table read avoids depending on
// manifest-projection plumbing for this invariant.
function countStoredRecords(connectorInstanceId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM records WHERE connector_instance_id = ?")
    .get(connectorInstanceId) as { n: number };
  return row.n;
}

// bearer owner-agent POSTs to the RS (rsUrl).
function postPause(rsUrl: string, ownerToken: string, path: string): Promise<JsonResult> {
  return fetchJson(`${rsUrl}${path}`, {
    headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
    method: "POST",
  });
}

interface PauseResponseBody {
  connection_id?: string;
  error?: { code?: string; type?: string; message?: string };
  object?: string;
  paused_at?: string;
  status?: string;
  [key: string]: unknown;
}

function pauseBody(result: JsonResult): PauseResponseBody {
  return result.body as PauseResponseBody;
}

interface AuditPauseData {
  connection_id?: string;
  connector_key?: string;
  operation?: string;
  [key: string]: unknown;
}

function auditData(event: SpineEventRecord): AuditPauseData {
  return event.data as AuditPauseData;
}

function findPauseAuditEvent(resp: Response): SpineEventRecord {
  const traceId = resp.headers.get("PDPP-Reference-Trace-Id");
  assert.ok(traceId?.startsWith("trc_"), "pause response should carry an audit trace id");
  assert.ok(traceId, "trace id must be present");
  const page = listSpineEventsPage("trace", traceId, { limit: 20 });
  const event = page.events.find((entry) => entry.event_type === "owner_agent.connection.pause");
  assert.ok(event, "expected owner_agent.connection.pause audit event");
  assert.equal(event.request_id, resp.headers.get("Request-Id"));
  assert.equal(event.token_id, null, "audit event must not store bearer tokens");
  const serialized = JSON.stringify(event);
  assert.ok(!BEARER_PATTERN.test(serialized), "audit must not carry a bearer token");
  assert.ok(!serialized.includes("access_token"), "audit must not carry an access token");
  return event;
}

test("owner-agent bearer pauses an active connection (200), flips to paused, preserves records", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    const [firstStream] = manifest.streams;
    assert.ok(firstStream, "manifest carries at least one stream");
    const stream = firstStream.name;
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_active",
      displayName: "My Spotify",
      sourceBindingKey: "the owner@example.com",
    });

    // Ingest a record before pause to verify it survives the round-trip.
    const storageTarget = { connector_id: connectorKey, connector_instance_id: "cin_spotify_active" };
    await ingestRecord(storageTarget, { data: { id: "rec_1", name: "pre-pause" }, key: "rec_1", stream });
    assert.equal(countStoredRecords("cin_spotify_active"), 1, "record should exist before pause");
    assert.equal(getInstance("cin_spotify_active")?.status, "active");

    const ownerToken = await issueOwnerToken(asUrl);
    const pause = await postPause(rsUrl, ownerToken, "/v1/owner/connections/cin_spotify_active/pause");

    assert.equal(pause.status, 200);
    assert.equal(pauseBody(pause).object, "owner_connection_pause");
    assert.equal(pauseBody(pause).connection_id, "cin_spotify_active");
    assert.equal(pauseBody(pause).status, "paused");
    const pausedAt = pauseBody(pause).paused_at;
    assert.ok(typeof pausedAt === "string" && pausedAt.length > 0);

    // Store row is paused -- and NOT revoked. A paused row must never read as
    // revoked on any surface, so revoked_at stays null.
    const row = getInstance("cin_spotify_active");
    assert.ok(row, "expected the paused connection row");
    assert.equal(row.status, "paused", "connection must be paused after pause");
    assert.equal(row.revokedAt, null, "pause must never set revoked_at");

    // Records survive the round-trip -- pause is zero-cascade.
    assert.equal(countStoredRecords("cin_spotify_active"), 1, "pre-pause record must survive pause");

    // Audit event emitted with correct fields.
    const audit = findPauseAuditEvent(pause.resp);
    assert.equal(audit.actor_type, "owner_agent");
    assert.equal(audit.client_id, OWNER_CLIENT_ID);
    assert.equal(audit.subject_id, OWNER_SUBJECT_ID);
    assert.equal(audit.object_type, "connection");
    assert.equal(audit.object_id, "cin_spotify_active");
    assert.equal(audit.status, "succeeded");
    assert.equal(auditData(audit).operation, "pause");
    assert.equal(auditData(audit).connection_id, "cin_spotify_active");
    assert.equal(auditData(audit).connector_key, connectorKey);
  });
});

test("repeat pause on an already-paused connection returns connector_instance_not_active (409)", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_paused",
      displayName: "My Spotify (already paused)",
      sourceBindingKey: "the owner@example.com",
      status: "paused",
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const result = await postPause(rsUrl, ownerToken, "/v1/owner/connections/cin_spotify_paused/pause");
    assert.equal(result.status, 409, "pausing an already-paused connection must return 409");
    assert.equal(pauseBody(result).error?.code, "connector_instance_not_active");

    assert.equal(getInstance("cin_spotify_paused")?.status, "paused");
  });
});

test("pause on a revoked connection returns connector_instance_not_active (409), never resurrecting it", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_revoked",
      displayName: "My Spotify",
      sourceBindingKey: "the owner@example.com",
      status: "revoked",
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const result = await postPause(rsUrl, ownerToken, "/v1/owner/connections/cin_spotify_revoked/pause");
    assert.equal(result.status, 409, "pause must refuse a revoked connection");
    assert.equal(pauseBody(result).error?.code, "connector_instance_not_active");

    // A revoked row must stay revoked -- pause must never launder it into a
    // merely-paused (and therefore resumable) state.
    assert.equal(getInstance("cin_spotify_revoked")?.status, "revoked");
  });
});

test("pause on a foreign/unknown connection_id returns 404", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const ownerToken = await issueOwnerToken(asUrl);
    const result = await postPause(rsUrl, ownerToken, "/v1/owner/connections/cin_does_not_exist/pause");
    assert.equal(result.status, 404);
  });
});

test("owner-agent cannot pause another owner's connection", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_other_owner",
      displayName: "Other owner's Spotify",
      ownerSubjectId: OTHER_SUBJECT_ID,
      sourceBindingKey: "other@example.com",
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const result = await postPause(rsUrl, ownerToken, "/v1/owner/connections/cin_spotify_other_owner/pause");
    assert.notEqual(result.status, 200, "a cross-owner pause must not succeed");

    // The foreign row must be untouched.
    assert.equal(getInstance("cin_spotify_other_owner")?.status, "active");
  });
});

test("owner-agent connector-only pause route pauses the single active connection", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_only_active",
      displayName: "My Spotify",
      sourceBindingKey: "the owner@example.com",
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const result = await postPause(rsUrl, ownerToken, `/v1/owner/connectors/${encodeURIComponent(connectorKey)}/pause`);

    assert.equal(result.status, 200);
    assert.equal(pauseBody(result).status, "paused");
    assert.equal(pauseBody(result).connection_id, "cin_spotify_only_active");
    assert.equal(getInstance("cin_spotify_only_active")?.status, "paused");
  });
});

test("owner-agent connector-only pause route rejects ambiguity across two active connections", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_active_a",
      displayName: "Spotify A",
      sourceBindingKey: "a@example.com",
    });
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_active_b",
      displayName: "Spotify B",
      sourceBindingKey: "b@example.com",
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const result = await postPause(rsUrl, ownerToken, `/v1/owner/connectors/${encodeURIComponent(connectorKey)}/pause`);

    assert.equal(result.status, 409, "two active connections must be ambiguous, not an arbitrary pick");
    assert.equal(pauseBody(result).error?.code, "ambiguous_connection");

    // Neither row may be mutated by a refused ambiguous request.
    assert.equal(getInstance("cin_spotify_active_a")?.status, "active");
    assert.equal(getInstance("cin_spotify_active_b")?.status, "active");
  });
});

test("client grant token cannot pause (403)", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    const [firstStream] = manifest.streams;
    assert.ok(firstStream, "manifest carries at least one stream");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_client_scope",
      displayName: "My Spotify",
      sourceBindingKey: "the owner@example.com",
    });
    const storageTarget = { connector_id: connectorKey, connector_instance_id: "cin_spotify_client_scope" };
    await ingestRecord(storageTarget, { data: { id: "rec_1" }, key: "rec_1", stream: firstStream.name });

    const clientToken = await approveClientGrant(
      asUrl,
      manifest.connector_id,
      firstStream.name,
      "cin_spotify_client_scope"
    );
    const result = await postPause(rsUrl, clientToken, "/v1/owner/connections/cin_spotify_client_scope/pause");

    assert.equal(result.status, 403, "a client grant token must not reach the owner-agent control surface");
    assert.equal(getInstance("cin_spotify_client_scope")?.status, "active");
  });
});

test("missing bearer cannot pause (401)", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_no_bearer",
      displayName: "My Spotify",
      sourceBindingKey: "the owner@example.com",
    });

    const result = await fetchJson(`${rsUrl}/v1/owner/connections/cin_spotify_no_bearer/pause`, {
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    assert.equal(result.status, 401);
    assert.equal(getInstance("cin_spotify_no_bearer")?.status, "active");
  });
});

// The point of shipping pause: the owner can stop collection and start it
// again. Neither half is useful alone, so prove the whole cycle, not just the
// two flips in isolation.
test("pause then resume round-trips a connection back to active, preserving records", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    const [firstStream] = manifest.streams;
    assert.ok(firstStream, "manifest carries at least one stream");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_round_trip",
      displayName: "My Spotify",
      sourceBindingKey: "the owner@example.com",
    });
    const storageTarget = { connector_id: connectorKey, connector_instance_id: "cin_spotify_round_trip" };
    await ingestRecord(storageTarget, {
      data: { id: "rec_1", name: "pre-pause" },
      key: "rec_1",
      stream: firstStream.name,
    });

    const ownerToken = await issueOwnerToken(asUrl);

    const pause = await postPause(rsUrl, ownerToken, "/v1/owner/connections/cin_spotify_round_trip/pause");
    assert.equal(pause.status, 200);
    assert.equal(getInstance("cin_spotify_round_trip")?.status, "paused");

    const resume = await postPause(rsUrl, ownerToken, "/v1/owner/connections/cin_spotify_round_trip/resume");
    assert.equal(resume.status, 200, "a connection paused by the owner must be resumable by the owner");
    assert.equal(pauseBody(resume).object, "owner_connection_resume");
    assert.equal(pauseBody(resume).status, "active");

    const row = getInstance("cin_spotify_round_trip");
    assert.equal(row?.status, "active", "the round trip must land back on active");
    assert.equal(row?.revokedAt, null, "a pause/resume cycle must never touch revoked_at");
    assert.equal(countStoredRecords("cin_spotify_round_trip"), 1, "records must survive the full cycle");
  });
});
