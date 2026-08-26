// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration suite for the owner-agent connection-resume control routes
 * (bearer: `server/routes/owner-connection-resume.ts`):
 *
 *   POST /v1/owner/connections/:connectionId/resume  (bearer, on RS)
 *   POST /v1/owner/connectors/:connectorId/resume    (bearer, on RS)
 *
 * Resume is the `paused`-status sibling of reactivate (`owner-connection-reactivate.ts`,
 * which flips `revoked` -> `active`). It exists because before this route, no
 * path in the reference implementation ever transitioned a connector_instance
 * from `paused` back to `active` — a connection paused by an out-of-band
 * operation (e.g. a recovered historical-archive row, restored with
 * `status: 'paused'` specifically because activating it with no surviving
 * credential would be unsafe) had no way back to `active` even after the
 * owner re-sealed a working credential via the static-secret credential-
 * capture route (which now admits a `paused` target — see
 * static-secret-credential-probe-route.test.ts).
 *
 * Covers:
 *   - a paused connection is flipped to `active`, already-collected records
 *     are preserved, and a resume audit event is emitted;
 *   - resume on a non-paused (active) connection returns connector_instance_not_paused (409);
 *   - resume on a foreign/unknown connection_id returns connector_instance_not_found (404);
 *   - a cross-owner resume is rejected (foreign id -> 404);
 *   - the connector-only bearer route auto-selects a single paused connection;
 *   - client grant tokens (403) and missing bearers (401) cannot resume;
 *   - a repeat resume on an already-active connection returns 409.
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
            purpose_description: "owner-connection resume boundary test",
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

async function seedInstance({
  connectorInstanceId,
  connectorId,
  displayName,
  sourceBindingKey,
  sourceKind = "account",
  sourceBinding,
  ownerSubjectId = OWNER_SUBJECT_ID,
  status = "paused",
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

// Count physically-stored records for a connection. Proves resume does NOT
// touch already-collected records -- a direct table read avoids depending on
// manifest-projection plumbing for this invariant.
function countStoredRecords(connectorInstanceId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM records WHERE connector_instance_id = ?")
    .get(connectorInstanceId) as { n: number };
  return row.n;
}

// bearer owner-agent POSTs to the RS (rsUrl).
function postResume(rsUrl: string, ownerToken: string, path: string): Promise<JsonResult> {
  return fetchJson(`${rsUrl}${path}`, {
    headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
    method: "POST",
  });
}

interface ResumeResponseBody {
  connection_id?: string;
  error?: { code?: string; type?: string; message?: string };
  object?: string;
  resumed_at?: string;
  status?: string;
  [key: string]: unknown;
}

function resumeBody(result: JsonResult): ResumeResponseBody {
  return result.body as ResumeResponseBody;
}

interface AuditResumeData {
  connection_id?: string;
  connector_key?: string;
  operation?: string;
  [key: string]: unknown;
}

function auditData(event: SpineEventRecord): AuditResumeData {
  return event.data as AuditResumeData;
}

function findResumeAuditEvent(resp: Response): SpineEventRecord {
  const traceId = resp.headers.get("PDPP-Reference-Trace-Id");
  assert.ok(traceId?.startsWith("trc_"), "resume response should carry an audit trace id");
  assert.ok(traceId, "trace id must be present");
  const page = listSpineEventsPage("trace", traceId, { limit: 20 });
  const event = page.events.find((entry) => entry.event_type === "owner_agent.connection.resume");
  assert.ok(event, "expected owner_agent.connection.resume audit event");
  assert.equal(event.request_id, resp.headers.get("Request-Id"));
  assert.equal(event.token_id, null, "audit event must not store bearer tokens");
  const serialized = JSON.stringify(event);
  assert.ok(!BEARER_PATTERN.test(serialized), "audit must not carry a bearer token");
  assert.ok(!serialized.includes("access_token"), "audit must not carry an access token");
  return event;
}

test("owner-agent bearer resumes a paused connection (200), flips to active, preserves records", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    const [firstStream] = manifest.streams;
    assert.ok(firstStream, "manifest carries at least one stream");
    const stream = firstStream.name;
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_paused",
      displayName: "My Spotify (recovered)",
      sourceBinding: {
        kind: "historical_archive",
        original_connector_instance_id: "cin_spotify_paused",
      },
      sourceBindingKey: "historical_archive_cin_spotify_paused",
    });

    // Ingest a record before resume to verify it survives the round-trip.
    const storageTarget = { connector_id: connectorKey, connector_instance_id: "cin_spotify_paused" };
    await ingestRecord(storageTarget, { data: { id: "rec_1", name: "pre-resume" }, key: "rec_1", stream });
    assert.equal(countStoredRecords("cin_spotify_paused"), 1, "record should exist before resume");
    assert.equal(getInstance("cin_spotify_paused")?.status, "paused");

    const ownerToken = await issueOwnerToken(asUrl);
    const resume = await postResume(rsUrl, ownerToken, "/v1/owner/connections/cin_spotify_paused/resume");

    assert.equal(resume.status, 200);
    assert.equal(resumeBody(resume).object, "owner_connection_resume");
    assert.equal(resumeBody(resume).connection_id, "cin_spotify_paused");
    assert.equal(resumeBody(resume).status, "active");
    const resumedAt = resumeBody(resume).resumed_at;
    assert.ok(typeof resumedAt === "string" && resumedAt.length > 0);

    // Store row is back to active.
    const row = getInstance("cin_spotify_paused");
    assert.ok(row, "expected the resumed connection row");
    assert.equal(row.status, "active", "connection must be active after resume");

    // Records survive the round-trip -- resume is zero-cascade.
    assert.equal(countStoredRecords("cin_spotify_paused"), 1, "pre-resume record must survive resume");

    // Audit event emitted with correct fields.
    const audit = findResumeAuditEvent(resume.resp);
    assert.equal(audit.actor_type, "owner_agent");
    assert.equal(audit.client_id, OWNER_CLIENT_ID);
    assert.equal(audit.subject_id, OWNER_SUBJECT_ID);
    assert.equal(audit.object_type, "connection");
    assert.equal(audit.object_id, "cin_spotify_paused");
    assert.equal(audit.status, "succeeded");
    assert.equal(auditData(audit).operation, "resume");
    assert.equal(auditData(audit).connection_id, "cin_spotify_paused");
    assert.equal(auditData(audit).connector_key, connectorKey);
  });
});

test("resume on an already-active connection returns connector_instance_not_paused (409)", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_active",
      displayName: "My Spotify",
      sourceBindingKey: "the owner@example.com",
      status: "active",
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const result = await postResume(rsUrl, ownerToken, "/v1/owner/connections/cin_spotify_active/resume");
    assert.equal(result.status, 409, "resuming an active connection must return 409");
    assert.equal(resumeBody(result).error?.code, "connector_instance_not_paused");

    // Connection must remain active.
    assert.equal(getInstance("cin_spotify_active")?.status, "active");
  });
});

test("resume on a revoked connection returns connector_instance_not_paused (409), not a silent un-revoke", async () => {
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
    const result = await postResume(rsUrl, ownerToken, "/v1/owner/connections/cin_spotify_revoked/resume");
    assert.equal(result.status, 409, "resume must refuse a revoked connection, not reactivate it");
    assert.equal(resumeBody(result).error?.code, "connector_instance_not_paused");
    assert.equal(getInstance("cin_spotify_revoked")?.status, "revoked");
  });
});

test("resume on a foreign/unknown connection_id returns 404", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    await registerConnector(asUrl, loadReferenceManifest("spotify"));

    const ownerToken = await issueOwnerToken(asUrl);
    const result = await postResume(rsUrl, ownerToken, "/v1/owner/connections/cin_does_not_exist/resume");
    assert.equal(result.status, 404);
    assert.equal(resumeBody(result).error?.code, "connector_instance_not_found");
  });
});

test("owner-agent cannot resume another owner's connection (cross-owner returns 404)", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_other",
      displayName: "Other Spotify",
      ownerSubjectId: OTHER_SUBJECT_ID,
      sourceBindingKey: "other@example.com",
    });
    assert.equal(getInstance("cin_spotify_other")?.status, "paused");

    // A token for OWNER_SUBJECT_ID must not reach the other owner's connection.
    const ownerToken = await issueOwnerToken(asUrl, OWNER_SUBJECT_ID);
    const result = await postResume(rsUrl, ownerToken, "/v1/owner/connections/cin_spotify_other/resume");
    assert.ok(
      result.status === 404 || result.status === 403,
      `cross-owner resume must return 403 or 404, got ${result.status}`
    );
    // The other owner's connection must remain paused.
    assert.equal(getInstance("cin_spotify_other")?.status, "paused");
  });
});

test("owner-agent connector-only resume route resumes the single paused connection", async () => {
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
    const result = await postResume(
      rsUrl,
      ownerToken,
      `/v1/owner/connectors/${encodeURIComponent(connectorKey)}/resume`
    );
    assert.equal(result.status, 200);
    assert.equal(resumeBody(result).object, "owner_connection_resume");
    assert.equal(resumeBody(result).status, "active");
    const row = getInstance("cin_spotify_only");
    assert.ok(row, "expected the resumed connection row");
    assert.equal(row.status, "active");

    const audit = findResumeAuditEvent(result.resp);
    assert.equal(auditData(audit).connection_id, "cin_spotify_only");
    assert.equal(auditData(audit).operation, "resume");
  });
});

test("owner-agent connector-only resume route rejects ambiguity across two paused connections", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_paused_a",
      displayName: "My Spotify A",
      sourceBindingKey: "a@example.com",
    });
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_paused_b",
      displayName: "My Spotify B",
      sourceBindingKey: "b@example.com",
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const result = await postResume(
      rsUrl,
      ownerToken,
      `/v1/owner/connectors/${encodeURIComponent(connectorKey)}/resume`
    );
    assert.equal(result.status, 409, "two paused connections must be ambiguous");
    assert.equal(resumeBody(result).error?.code, "ambiguous_connection");
    assert.equal(getInstance("cin_spotify_paused_a")?.status, "paused");
    assert.equal(getInstance("cin_spotify_paused_b")?.status, "paused");
  });
});

test("client grant token cannot resume (403)", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    // Approval only authorizes active instances, so seed active first, mint
    // the client grant, then pause the row directly via the store -- the
    // negative-auth assertion targets the owner-control boundary, not
    // consent eligibility (mirrors owner-connection-reactivate.test.ts).
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_client_test",
      displayName: "My Spotify",
      sourceBindingKey: "the owner@example.com",
      status: "active",
    });

    const [clientStream] = manifest.streams;
    assert.ok(clientStream, "manifest carries at least one stream");
    const clientToken = await approveClientGrant(
      asUrl,
      manifest.connector_id,
      clientStream.name,
      "cin_spotify_client_test"
    );

    createSqliteConnectorInstanceStore().updateStatus("cin_spotify_client_test", {
      status: "paused",
      updatedAt: NOW,
    });
    assert.equal(getInstance("cin_spotify_client_test")?.status, "paused");

    const result = await fetchJson(`${rsUrl}/v1/owner/connections/cin_spotify_client_test/resume`, {
      headers: { Authorization: `Bearer ${clientToken}`, "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(result.status, 403, "client grant must not reach resume");
    // Connection must remain paused.
    assert.equal(getInstance("cin_spotify_client_test")?.status, "paused");
  });
});

test("missing bearer cannot resume (401)", async () => {
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
    const result = await fetchJson(`${rsUrl}/v1/owner/connections/cin_spotify_noauth/resume`, {
      method: "POST",
    });
    assert.equal(result.status, 401);
  });
});

test("repeat resume on already-active connection returns connector_instance_not_paused (409)", async () => {
  // Proves the not_paused guard fires even for a connection that was previously
  // paused and then resumed -- the guard is on the current status, not history.
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

    const first = await postResume(rsUrl, ownerToken, "/v1/owner/connections/cin_spotify_repeat/resume");
    assert.equal(first.status, 200);
    assert.equal(getInstance("cin_spotify_repeat")?.status, "active");

    // A second resume must fail: the connection is now active, not paused.
    const second = await postResume(rsUrl, ownerToken, "/v1/owner/connections/cin_spotify_repeat/resume");
    assert.equal(second.status, 409);
    assert.equal(resumeBody(second).error?.code, "connector_instance_not_paused");
    assert.equal(getInstance("cin_spotify_repeat")?.status, "active");
  });
});
