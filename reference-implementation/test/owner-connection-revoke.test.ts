const TOP_LEVEL_REGEX_1 = /Bearer\s/i;
const TOP_LEVEL_REGEX_2 = /owner-agent/i;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration suite for the bearer-authed owner-agent connection-revoke control
 * routes (mounted from `server/routes/owner-connection-revoke.ts`):
 *
 *   POST /v1/owner/connections/:connectionId/revoke
 *   POST /v1/owner/connectors/:connectorId/revoke
 *
 * Covers the owner-agent revoke packet (design "Deferred: connection-revoke
 * durability" → Unit 2, tasks 3.1d/6.1d) plus the durability guard it depends on
 * (Unit 1, proven at the store level in connector-instance-store.test.js and
 * end-to-end here through the default-account class):
 *
 *   - a trusted owner-agent bearer revokes an instance-scoped connection by
 *     connection_id (200), the connection stops collecting future data, and
 *     already-collected records remain readable (revoke != delete);
 *   - a DEFAULT-ACCOUNT connection revoked through the route stays revoked across
 *     subsequent owner reads and a re-materialization attempt (the durability
 *     regression that failed before the Unit 1 guard);
 *   - no sibling overreach: revoking one connection on a connector leaves a
 *     sibling connection active and collectable;
 *   - the connector-only route auto-selects a single active connection and
 *     rejects two active connections with a typed ambiguous_connection (409);
 *   - a repeat revoke returns a typed connector_instance_inactive;
 *   - foreign/unknown connection ids are 404 (never a cross-owner revoke);
 *   - client grant tokens (403), missing bearers (401), revoked owner-agent
 *     credentials (401), and `/mcp` owner bearers (403) cannot revoke;
 *   - every attempt emits non-secret owner_agent.connection.revoke audit
 *     evidence with no bearer/secret;
 *   - the control surface advertises revoke_connection as supported.
 *
 * Spec: openspec/changes/add-owner-agent-control-surface
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { exec, referenceQueries } from "../lib/db.ts";
import { listSpineEventsPage, type SpineEventRecord } from "../lib/spine.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { getDb } from "../server/db.ts";
import { startServer as startServerUntyped } from "../server/index.ts";
import { ingestRecord as ingestRecordUntyped } from "../server/records.ts";
import {
  createSqliteConnectorInstanceStore,
  makeDefaultAccountConnectorInstanceId,
} from "../server/stores/connector-instance-store.ts";

/**
 * server/index.js (startServer) and server/records.js (ingestRecord) are
 * untyped JS (allowJs, checkJs:false). `startServer`'s inferred return
 * type structurally names `asServer`/`rsServer` as `Http2SecureServer`
 * (an artifact of TS's inference through the untyped `.listen()` chain —
 * at runtime they are plain `http.Server` objects, and `Http2SecureServer`
 * itself is missing `closeAllConnections` too, so the inferred type is
 * simply incomplete, not a real alternate shape to design around). Read
 * each field this suite actually uses off an indexed `Record<string,
 * unknown>` view of the awaited result — a per-property narrowing cast,
 * not a same-shape object cast — then hand back the concrete interface.
 */
interface CloseableHandle {
  close: (cb: (err?: Error) => void) => unknown;
  closeAllConnections: () => void;
}

interface ClosableServer {
  asPort: number;
  asServer: CloseableHandle;
  rsPort: number;
  rsServer: CloseableHandle;
  schedulerManager?: { stop?: () => void };
}

interface StartServerOptions {
  asPort?: number;
  dbPath?: string;
  ownerAuthPassword?: string;
  quiet?: boolean;
  rsPort?: number;
}

async function startServer(opts: StartServerOptions): Promise<ClosableServer> {
  const raw: Record<string, unknown> = await startServerUntyped(opts);
  const result: ClosableServer = {
    asPort: raw.asPort as number,
    asServer: raw.asServer as CloseableHandle,
    rsPort: raw.rsPort as number,
    rsServer: raw.rsServer as CloseableHandle,
  };
  if (raw.schedulerManager !== undefined) {
    result.schedulerManager = raw.schedulerManager as { stop?: () => void };
  }
  return result;
}

const ingestRecord = ingestRecordUntyped as (
  storageTarget: { connector_id: string; connector_instance_id: string },
  record: { stream: string; key: string; data: Record<string, unknown> }
) => Promise<unknown>;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const OWNER_SUBJECT_ID = "owner_local";
const OTHER_SUBJECT_ID = "owner_other";
const OWNER_CLIENT_ID = "cli_longview";
const NOW = "2026-05-31T00:00:00.000Z";

async function closeServer(server: ClosableServer): Promise<void> {
  server.schedulerManager?.stop?.();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(() => resolve(undefined))),
    new Promise((resolve) => server.rsServer.close(() => resolve(undefined))),
  ]);
}

// Response body shape across every route this suite exercises (revoke
// success, typed error envelopes, the owner-connections list, and the
// owner-control document). A single loosely-optional shape rather than a
// union, matching how the test bodies read it: every field is read with
// `?.` and only asserted present at the specific line that needs it.
interface RevokeResponseBody {
  actions?: { family: string; status: string; method: string; url: string }[];
  connection_id?: string;
  data?: { object: string; connection_id: string; status: string }[];
  error?: {
    code?: string;
    type?: string;
    message?: string;
    retry_with?: string;
    available_connections?: { connection_id: string }[];
  };
  object?: string;
  revoked_at?: string;
  status?: string;
}

interface FetchJsonResult {
  body: RevokeResponseBody | null;
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
  return { body: body as RevokeResponseBody | null, resp, status: resp.status };
}

interface ServerHandles {
  asUrl: string;
  rsUrl: string;
  server: ClosableServer;
}

async function withServer(fn: (handles: ServerHandles) => Promise<void>): Promise<void> {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    await fn({ asUrl, rsUrl, server });
  } finally {
    await closeServer(server);
  }
}

// Device-code exchange yields an owner-kind bearer (pdpp_token_kind: "owner").
// Returns both the access token and the issuing client id so a test can revoke
// the credential by cascading the client's tokens (RFC 7592-style deletion).
async function issueOwnerToken(asUrl: string, subjectId = OWNER_SUBJECT_ID): Promise<string> {
  const device = (
    await fetchJson(`${asUrl}/oauth/device_authorization`, {
      body: new URLSearchParams({ client_id: OWNER_CLIENT_ID }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    })
  ).body as { device_code: string; user_code: string };
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
  return tok.access_token as string;
}

// PAR + consent yields a grant-scoped client-kind bearer (pdpp_token_kind:
// "client"). These must NOT reach the owner-agent control surface.
async function approveClientGrant(asUrl: string, connectorId: string, streamName: string): Promise<string> {
  const par = (
    await fetchJson(`${asUrl}/oauth/par`, {
      body: JSON.stringify({
        authorization_details: [
          {
            access_mode: "continuous",
            purpose_code: "https://pdpp.dev/purpose/analytics",
            purpose_description: "owner-connection revoke boundary test",
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
  ).body as { request_uri: string };
  const approved = (
    await fetchJson(`${asUrl}/consent/approve`, {
      body: JSON.stringify({ request_uri: par.request_uri, subject_id: OWNER_SUBJECT_ID }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    })
  ).body as { token?: string };
  assert.ok(approved.token, "consent approval should issue a client grant token");
  return approved.token as string;
}

interface ReferenceManifest {
  connector_id: string;
  display_name?: string;
  streams: { name: string }[];
  [key: string]: unknown;
}

function loadReferenceManifest(name: string): ReferenceManifest {
  return JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "manifests", `${name}.json`), "utf8"));
}

// canonicalConnectorKey returns string | null for arbitrary `unknown`
// input; every reference manifest in this suite has a well-formed
// connector_id, so a null result is a fixture bug, not a real outcome to
// carry through every call site as `| null`.
function mustCanonicalConnectorKey(connectorId: unknown): string {
  const key = canonicalConnectorKey(connectorId);
  assert.ok(key, `expected a canonical connector key for ${JSON.stringify(connectorId)}`);
  return key;
}

function mustGetInstance(connectorInstanceId: string) {
  const row = getInstance(connectorInstanceId);
  assert.ok(row, `expected a stored connector_instances row for ${connectorInstanceId}`);
  return row;
}

function mustFirstStreamName(manifest: ReferenceManifest): string {
  // biome-ignore lint/style/useDestructuring: index access documents the asserted ordered position
  const stream = manifest.streams[0];
  assert.ok(stream, `expected at least one stream on ${manifest.connector_id}`);
  return stream.name;
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
  sourceBinding?: unknown;
  sourceBindingKey: string;
  sourceKind?: string;
}

async function seedInstance({
  connectorInstanceId,
  connectorId,
  displayName,
  sourceBindingKey,
  sourceKind = "account",
  sourceBinding,
  ownerSubjectId = OWNER_SUBJECT_ID,
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
    status: "active",
    updatedAt: NOW,
  });
}

function getInstance(connectorInstanceId: string) {
  return createSqliteConnectorInstanceStore().get(connectorInstanceId);
}

// Count physically-stored records for a connection. Used to prove revoke does
// NOT delete already-collected records (revoke != forget) — a direct table read
// avoids depending on manifest-projection plumbing for this invariant.
function countStoredRecords(connectorInstanceId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM records WHERE connector_instance_id = ?")
    .get(connectorInstanceId) as { n: number };
  return row.n;
}

// biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
async function postRevoke(rsUrl: string, ownerToken: string, path: string): Promise<FetchJsonResult> {
  return fetchJson(`${rsUrl}${path}`, {
    headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
    method: "POST",
  });
}

// data is `unknown` on the real SpineEventRecord; this suite reads a fixed
// set of revoke-audit-specific keys off it, modeled locally.
interface RevokeAuditData {
  actor_kind?: string;
  connection_id?: string;
  connector_key?: string;
  error?: { code?: string; http_status?: number };
  operation?: string;
  selector?: string;
}

function findRevokeAuditEvent(resp: Response): SpineEventRecord & { data: RevokeAuditData | null } {
  const traceId = resp.headers.get("PDPP-Reference-Trace-Id");
  assert.ok(traceId?.startsWith("trc_"), "revoke response should carry an audit trace id");
  const page = listSpineEventsPage("trace", traceId as string, { limit: 20 });
  const event = page.events.find((entry) => entry.event_type === "owner_agent.connection.revoke");
  assert.ok(event, "expected owner-agent revoke audit event");
  assert.equal(event.request_id, resp.headers.get("Request-Id"));
  assert.equal(event.token_id, null, "audit event must not store bearer tokens");
  // No secret material in the serialized event payload.
  const serialized = JSON.stringify(event);
  assert.ok(!TOP_LEVEL_REGEX_1.test(serialized), "audit must not carry a bearer token");
  assert.ok(!serialized.includes("access_token"), "audit must not carry an access token");
  return event as SpineEventRecord & { data: RevokeAuditData | null };
}

test("owner-agent bearer revokes an instance-scoped connection (200), stops future collection, preserves records", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = mustCanonicalConnectorKey(manifest.connector_id);
    const stream = mustFirstStreamName(manifest);
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_personal",
      displayName: "My Spotify",
      sourceBindingKey: "the owner@example.com",
    });

    // Pre-existing record collected before revoke.
    const storageTarget = { connector_id: connectorKey, connector_instance_id: "cin_spotify_personal" };
    await ingestRecord(storageTarget, { data: { id: "rec_1", name: "pre-revoke" }, key: "rec_1", stream });
    assert.equal(countStoredRecords("cin_spotify_personal"), 1, "record should exist before revoke");

    const ownerToken = await issueOwnerToken(asUrl);
    const revoke = await postRevoke(rsUrl, ownerToken, "/v1/owner/connections/cin_spotify_personal/revoke");
    assert.equal(revoke.status, 200);
    assert.equal(revoke.body?.object, "owner_connection_revoke");
    assert.equal(revoke.body?.connection_id, "cin_spotify_personal");
    assert.equal(revoke.body?.status, "revoked");
    assert.ok(typeof revoke.body?.revoked_at === "string" && revoke.body.revoked_at.length > 0);

    // The stored row is soft-flipped to revoked with a revoked_at stamp.
    const row = mustGetInstance("cin_spotify_personal");
    assert.equal(row.status, "revoked");
    assert.ok(row.revokedAt, "revoked_at must be stamped");

    // Already-collected records remain stored (revoke != delete records).
    assert.equal(countStoredRecords("cin_spotify_personal"), 1, "pre-revoke record must survive revoke");

    const audit = findRevokeAuditEvent(revoke.resp);
    assert.equal(audit.actor_type, "owner_agent");
    assert.equal(audit.client_id, OWNER_CLIENT_ID);
    assert.equal(audit.subject_id, OWNER_SUBJECT_ID);
    assert.equal(audit.object_type, "connection");
    assert.equal(audit.object_id, "cin_spotify_personal");
    assert.equal(audit.status, "succeeded");
    assert.equal(audit.data?.operation, "revoke");
    assert.equal(audit.data?.selector, "connection_id");
    assert.equal(audit.data?.connection_id, "cin_spotify_personal");
    assert.equal(audit.data?.connector_key, connectorKey);
  });
});

test("a revoked DEFAULT-ACCOUNT connection stays revoked across owner reads (durability guard)", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    // github is an API/network default-account connector: its connection
    // materializes implicitly. Register it, then materialize the default account
    // by listing connections (which triggers dashboard materialization) — but to
    // be explicit and deterministic we materialize directly through the store.
    const manifest = await registerConnector(asUrl, loadReferenceManifest("github"));
    const connectorKey = mustCanonicalConnectorKey(manifest.connector_id);
    const store = createSqliteConnectorInstanceStore();
    const defaultId = makeDefaultAccountConnectorInstanceId(OWNER_SUBJECT_ID, connectorKey);
    await store.ensureDefaultAccountConnection({
      connectorId: connectorKey,
      displayName: manifest.display_name || connectorKey,
      now: NOW,
      ownerSubjectId: OWNER_SUBJECT_ID,
    });
    assert.equal(mustGetInstance(defaultId).status, "active", "default account should materialize active");

    const ownerToken = await issueOwnerToken(asUrl);

    // Revoke the default-account connection via the owner-agent route.
    const revoke = await postRevoke(rsUrl, ownerToken, `/v1/owner/connections/${defaultId}/revoke`);
    assert.equal(revoke.status, 200);
    assert.equal(revoke.body?.status, "revoked");
    assert.equal(mustGetInstance(defaultId).status, "revoked");

    // Two subsequent owner listings must NOT resurrect it to active. Before the
    // Unit 1 durability guard, the dashboard/owner read path re-materialized the
    // deterministically-keyed revoked row back to active.
    for (const attempt of [1, 2]) {
      // biome-ignore lint/performance/noAwaitInLoops: ordered test setup is intentionally sequential
      const list = await fetchJson(`${rsUrl}/v1/owner/connections`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(list.status, 200, `owner list read ${attempt} should succeed`);
      const row = (list.body?.data ?? []).find((c) => c.connection_id === defaultId);
      // The connection may be listed (revoked rows are still owner-visible) but
      // it MUST NOT be active.
      if (row) {
        assert.equal(row.status, "revoked", `default account must stay revoked after read ${attempt}`);
      }
      assert.equal(mustGetInstance(defaultId).status, "revoked", `stored row must stay revoked after read ${attempt}`);
    }

    // A direct re-materialization attempt (the dashboard path) also respects the
    // revoke.
    const reEnsured = await store.ensureDefaultAccountConnection({
      connectorId: connectorKey,
      displayName: manifest.display_name || connectorKey,
      now: "2026-06-01T00:00:00.000Z",
      ownerSubjectId: OWNER_SUBJECT_ID,
    });
    assert.equal(reEnsured.status, "revoked", "default-account materialization must not resurrect a revoke");
    assert.equal(mustGetInstance(defaultId).status, "revoked");
  });
});

test("owner-agent revoke does not over-reach: a sibling connection stays active and collectable", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = mustCanonicalConnectorKey(manifest.connector_id);
    const stream = mustFirstStreamName(manifest);
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_personal",
      displayName: "the owner personal",
      sourceBindingKey: "the owner@example.com",
    });
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_shared",
      displayName: "Shared Spotify",
      sourceBindingKey: "shared@example.com",
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const revoke = await postRevoke(rsUrl, ownerToken, "/v1/owner/connections/cin_spotify_personal/revoke");
    assert.equal(revoke.status, 200);

    // The sibling is untouched and can still collect.
    assert.equal(mustGetInstance("cin_spotify_personal").status, "revoked");
    const sibling = mustGetInstance("cin_spotify_shared");
    assert.equal(sibling.status, "active", "sibling connection must remain active");

    const siblingTarget = { connector_id: connectorKey, connector_instance_id: "cin_spotify_shared" };
    await ingestRecord(siblingTarget, { data: { id: "rec_sibling" }, key: "rec_sibling", stream });
    assert.equal(
      countStoredRecords("cin_spotify_shared"),
      1,
      "sibling connection must remain collectable after sibling revoke"
    );
  });
});

test("owner-agent connector-only revoke auto-selects the single active connection", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = mustCanonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_only",
      displayName: "My Spotify",
      sourceBindingKey: "the owner@example.com",
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const revoke = await postRevoke(
      rsUrl,
      ownerToken,
      `/v1/owner/connectors/${encodeURIComponent(connectorKey)}/revoke`
    );
    assert.equal(revoke.status, 200);
    assert.equal(revoke.body?.connection_id, "cin_spotify_only");
    assert.equal(mustGetInstance("cin_spotify_only").status, "revoked");

    const audit = findRevokeAuditEvent(revoke.resp);
    assert.equal(audit.data?.selector, "connector_id");
    assert.equal(audit.data?.connection_id, "cin_spotify_only");
    assert.equal(audit.data?.operation, "revoke");
  });
});

test("owner-agent connector-only revoke rejects two active connections with typed ambiguous_connection", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = mustCanonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_personal",
      displayName: "the owner personal",
      sourceBindingKey: "the owner@example.com",
    });
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_shared",
      displayName: "Shared Spotify",
      sourceBindingKey: "shared@example.com",
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body, resp } = await postRevoke(
      rsUrl,
      ownerToken,
      `/v1/owner/connectors/${encodeURIComponent(connectorKey)}/revoke`
    );
    assert.equal(status, 409);
    assert.equal(body?.error?.code, "ambiguous_connection");
    assert.equal(body?.error?.retry_with, "connection_id");
    const ids = (body?.error?.available_connections ?? []).map((c) => c.connection_id).sort();
    assert.deepEqual(ids, ["cin_spotify_personal", "cin_spotify_shared"]);

    // Neither connection was revoked by the ambiguous request.
    assert.equal(mustGetInstance("cin_spotify_personal").status, "active");
    assert.equal(mustGetInstance("cin_spotify_shared").status, "active");

    const audit = findRevokeAuditEvent(resp);
    assert.equal(audit.status, "failed");
    assert.equal(audit.data?.selector, "connector_id");
    assert.equal(audit.data?.error?.code, "ambiguous_connection");
    assert.equal(audit.data?.error?.http_status, 409);
  });
});

test("owner-agent repeat revoke returns typed connector_instance_inactive", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = mustCanonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_personal",
      displayName: "My Spotify",
      sourceBindingKey: "the owner@example.com",
    });
    const ownerToken = await issueOwnerToken(asUrl);

    const first = await postRevoke(rsUrl, ownerToken, "/v1/owner/connections/cin_spotify_personal/revoke");
    assert.equal(first.status, 200);

    const second = await postRevoke(rsUrl, ownerToken, "/v1/owner/connections/cin_spotify_personal/revoke");
    assert.equal(second.status, 400);
    assert.equal(second.body?.error?.code, "connector_instance_inactive");
    // Still revoked, not crashed or flipped.
    assert.equal(mustGetInstance("cin_spotify_personal").status, "revoked");
  });
});

test("owner-agent revoke on an unknown connection_id returns a typed 404", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body, resp } = await postRevoke(rsUrl, ownerToken, "/v1/owner/connections/cin_missing/revoke");
    assert.equal(status, 404);
    assert.equal(body?.error?.code, "connector_instance_not_found");
    const audit = findRevokeAuditEvent(resp);
    assert.equal(audit.status, "failed");
    assert.equal(audit.object_id, "cin_missing");
    assert.equal(audit.data?.error?.code, "connector_instance_not_found");
  });
});

test("owner-agent revoke cannot cross owners (other-owner connection is not found)", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = mustCanonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_other",
      displayName: "Other Spotify",
      ownerSubjectId: OTHER_SUBJECT_ID,
      sourceBindingKey: "other@example.com",
    });
    const ownerToken = await issueOwnerToken(asUrl);
    const { status } = await postRevoke(rsUrl, ownerToken, "/v1/owner/connections/cin_spotify_other/revoke");
    assert.ok(status === 404 || status === 403, `expected 404/403, got ${status}`);
    // The foreign connection was not revoked.
    assert.equal(mustGetInstance("cin_spotify_other").status, "active");
  });
});

test("owner-agent revoke rejects a client grant token with 403 and audits it", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = mustCanonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_personal",
      displayName: "My Spotify",
      sourceBindingKey: "the owner@example.com",
    });
    const clientToken = await approveClientGrant(asUrl, connectorKey, mustFirstStreamName(manifest));

    const { status, body, resp } = await postRevoke(
      rsUrl,
      clientToken,
      "/v1/owner/connections/cin_spotify_personal/revoke"
    );
    assert.equal(status, 403);
    assert.equal(body?.error?.code, "permission_error");
    // The connection was NOT revoked by the rejected client.
    assert.equal(mustGetInstance("cin_spotify_personal").status, "active");

    const audit = findRevokeAuditEvent(resp);
    assert.equal(audit.status, "failed");
    assert.equal(audit.actor_type, "client");
    assert.equal(audit.data?.actor_kind, "client");
    assert.equal(audit.data?.operation, "revoke");
    assert.equal(audit.data?.error?.code, "permission_error");
  });
});

test("owner-agent revoke rejects a request with no bearer (401)", async () => {
  await withServer(async ({ rsUrl }) => {
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connections/cin_spotify_personal/revoke`, {
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(status, 401);
    assert.equal(body?.error?.type, "authentication_error");
  });
});

test("a revoked owner-agent credential cannot revoke a connection (401)", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = mustCanonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_personal",
      displayName: "My Spotify",
      sourceBindingKey: "the owner@example.com",
    });
    const ownerToken = await issueOwnerToken(asUrl);

    // Revoke the owner-agent credential the way RFC 7592 client deletion does:
    // cascade-revoke the issuing client's tokens (same path the schedule suite
    // uses for task 3.4).
    exec(referenceQueries.authTokensRevokeByClientId, [OWNER_CLIENT_ID]);

    const { status, body } = await postRevoke(rsUrl, ownerToken, "/v1/owner/connections/cin_spotify_personal/revoke");
    assert.equal(status, 401);
    assert.equal(body?.error?.type, "authentication_error");
    // The connection was NOT revoked by the dead credential.
    assert.equal(mustGetInstance("cin_spotify_personal").status, "active");
  });
});

test("/mcp continues to reject owner-agent bearers after revoke control lands", async () => {
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
    assert.equal(body?.error?.code, "permission_error");
    assert.match(body?.error?.message ?? "", TOP_LEVEL_REGEX_2);
  });
});

test("owner-agent control document advertises revoke_connection as supported with a revoke URL", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { body } = await fetchJson(`${rsUrl}/v1/owner/control`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const revoke = body?.actions?.find((a) => a.family === "revoke_connection");
    assert.ok(revoke, "revoke_connection must be advertised");
    assert.equal(revoke.status, "supported");
    assert.equal(revoke.method, "POST");
    assert.equal(revoke.url, `${rsUrl}/v1/owner/connections/{connection_id}/revoke`);
  });
});
