// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration suite for the bearer-authed owner-agent connection-scoped
 * diagnostics reads (mounted from `server/routes/owner-connection-diagnostics.ts`):
 *
 *   GET /v1/owner/connections/:connectionId/diagnostics
 *   GET /v1/owner/connectors/:connectorId/diagnostics
 *
 * Covers the connection-scoped diagnostics primitive (design "Deferred:
 * connection-scoped diagnostics", tasks 6.1d / 3.1d flip) plus the
 * authorization/audit hardening shared by the owner-agent control family:
 *
 *   - a trusted owner-agent bearer reads ONE connection's diagnostics by
 *     `connection_id` and receives the typed health classification, last run,
 *     last successful run, last ingest time, schedule state, freshness, and the
 *     rendered verdict / required-action projection shared with the console;
 *   - the response is connection-scoped: it carries no device-exporter subsystem
 *     state and no sibling-connection rows, even when the owner has two active
 *     connections for the same connector (the over-broad sharing the design
 *     rejected for device-rooted diagnostics);
 *   - the connector-only route auto-selects the single active connection, and
 *     rejects a connector with two active connections using a typed
 *     `ambiguous_connection` (409) carrying the available `connection_id` values
 *     and `retry_with: connection_id`;
 *   - every read emits non-secret `owner_agent.connection.inspect` audit
 *     evidence with no bearer token;
 *   - client grant tokens (403), missing bearers (401), unknown/foreign
 *     connections (404), and `/mcp` owner bearers (403) cannot read diagnostics;
 *   - the control surface advertises inspect_diagnostics as supported.
 *
 * Spec: openspec/changes/add-owner-agent-control-surface
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { listSpineEventsPage, type SpineEventRecord } from "../lib/spine.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { startServer } from "../server/index.ts";
import { getDefaultConnectorDetailGapStore } from "../server/stores/connector-detail-gap-store.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

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

async function withServer(fn: (ctx: { asUrl: string; rsUrl: string }) => Promise<void>): Promise<void> {
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
    await fn({ asUrl, rsUrl });
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
            purpose_description: "owner-connection diagnostics boundary test",
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
  ).body as { request_uri?: string };
  const approved = (
    await fetchJson(`${asUrl}/consent/approve`, {
      body: JSON.stringify({ request_uri: par.request_uri, subject_id: OWNER_SUBJECT_ID }),
      headers: { "Content-Type": "application/json" },
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
  return JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "manifests", `${name}.json`), "utf8")) as ReferenceManifest;
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
  sourceBindingKey: string;
}

async function seedInstance({
  connectorInstanceId,
  connectorId,
  displayName,
  sourceBindingKey,
  ownerSubjectId = OWNER_SUBJECT_ID,
}: SeedInstanceOptions): Promise<void> {
  const store = createSqliteConnectorInstanceStore();
  await store.upsert({
    connectorId,
    connectorInstanceId,
    createdAt: NOW,
    displayName,
    ownerSubjectId,
    sourceBinding: { account_hint: sourceBindingKey },
    sourceBindingKey,
    sourceKind: "account",
    status: "active",
    updatedAt: NOW,
  });
}

// biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
async function getDiagnostics(rsUrl: string, ownerToken: string, path: string): Promise<JsonResult> {
  return fetchJson(`${rsUrl}${path}`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
}

function findInspectAuditEvent(resp: Response): SpineEventRecord {
  const traceId = resp.headers.get("PDPP-Reference-Trace-Id");
  assert.ok(traceId?.startsWith("trc_"), "diagnostics response should carry an audit trace id");
  assert.ok(traceId, "expected a trace id");
  const page = listSpineEventsPage("trace", traceId, { limit: 20 });
  const event = page.events.find((entry) => entry.event_type === "owner_agent.connection.inspect");
  assert.ok(event, "expected owner-agent inspect audit event");
  assert.equal(event.request_id, resp.headers.get("Request-Id"));
  assert.equal(event.token_id, null, "audit event must not store bearer tokens");
  return event;
}

interface DiagnosticsResponseBody {
  actions?: { family?: string; status?: string; method?: string | null; url?: string | null }[];
  connection_id?: string;
  connector_id?: string;
  connector_key?: string;
  display_name?: string;
  error?: {
    code?: string;
    type?: string;
    message?: string;
    retry_with?: string;
    available_connections?: { connection_id: string; display_name?: string }[];
  };
  freshness?: unknown;
  health?: { state?: string; reason_code?: unknown; axes?: unknown; badges?: unknown };
  last_ingest_at?: unknown;
  last_run?: unknown;
  last_successful_run?: unknown;
  object?: string;
  recovery?: {
    admission: {
      candidates: number;
      admitted: number;
      deferred: number;
      deferred_by_reason: Record<string, number>;
      next_eligible_at?: string;
      why_not_now?: string;
    };
    stall: { stalled: boolean; eligibleCandidates: number; lastAttemptAt?: string };
    unreadable: boolean;
  };
  rendered_verdict?: { pill?: unknown; required_actions?: unknown[] };
  schedule?: unknown;
  [key: string]: unknown;
}

// Local structural type for getDefaultConnectorDetailGapStore()'s real (but
// deliberately unexported/opaque, typed `unknown` at the boundary) return
// shape -- covers only the two methods these tests actually call.
interface DetailGapUpsertInput {
  connectorId: string;
  connectorInstanceId: string;
  nextAttemptAfter?: string;
  now?: string;
  reason: string;
  recordKey: string;
  stream: string;
}

interface DetailGapMarkStatusOptions {
  now?: string;
  runId?: string | null;
}

interface DetailGapRecord {
  gap_id: string;
  [key: string]: unknown;
}

interface ConnectorDetailGapStoreLike {
  markGapStatus: (
    gapId: string,
    status: string,
    options?: DetailGapMarkStatusOptions
  ) => Promise<DetailGapRecord | null>;
  upsertPendingGap: (input: DetailGapUpsertInput) => Promise<DetailGapRecord | null>;
}

function detailGapStore(): ConnectorDetailGapStoreLike {
  return getDefaultConnectorDetailGapStore() as ConnectorDetailGapStoreLike;
}

interface AuditInspectData {
  actor_kind?: string;
  auth_token_kind?: string;
  connection_id?: string;
  connector_key?: string;
  error?: { code?: string; http_status?: number };
  health_state?: string;
  operation?: string;
  selector?: string;
}

function auditData(event: SpineEventRecord): AuditInspectData {
  return (event.data ?? {}) as AuditInspectData;
}

const HEALTH_STATES = new Set(["blocked", "cooling_off", "degraded", "healthy", "idle", "needs_attention", "unknown"]);

test("owner-agent bearer reads connection-scoped diagnostics by connection_id and audits it", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_personal",
      displayName: "the owner personal",
      sourceBindingKey: "the owner@example.com",
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const {
      status,
      body: rawBody,
      resp,
    } = await getDiagnostics(rsUrl, ownerToken, "/v1/owner/connections/cin_spotify_personal/diagnostics");
    const body = rawBody as DiagnosticsResponseBody;
    assert.equal(status, 200);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
    assert.equal(body?.object, "owner_connection_diagnostics");
    // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
    assert.equal(body?.connection_id, "cin_spotify_personal");
    // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
    assert.equal(body?.connector_id, connectorKey);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
    assert.equal(body?.connector_key, connectorKey);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
    assert.equal(body?.display_name, "the owner personal");
    // Typed health classification using the canonical taxonomy. A seeded
    // never-run connection projects to `idle` (no terminal run evidence).
    // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
    const healthState = body?.health?.state;
    assert.ok(healthState, "response carries a health state");
    assert.ok(HEALTH_STATES.has(healthState), `unexpected health state: ${healthState}`);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
    assert.ok("reason_code" in (body?.health ?? {}), "health carries reason_code");
    // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
    assert.ok("axes" in (body?.health ?? {}), "health carries axes");
    // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
    assert.ok("badges" in (body?.health ?? {}), "health carries badges");
    // Connection-scoped run + schedule + freshness fields are present (null when
    // no evidence), and the response declares last_ingest_at.
    assert.ok("last_run" in body, "response carries last_run");
    assert.ok("last_successful_run" in body, "response carries last_successful_run");
    assert.ok("last_ingest_at" in body, "response carries last_ingest_at");
    assert.ok("schedule" in body, "response carries schedule");
    assert.ok("freshness" in body, "response carries freshness");
    // Owner-only recovery-admission diagnostics (tasks 2.6/2.7) are always
    // present. A never-run connection with no seeded gaps has no candidates, so
    // nothing is admitted or deferred, there is no blocker to explain, and the
    // observe-only stall watchdog reports no stall.
    // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
    const recovery = body?.recovery;
    assert.ok(recovery, "response carries recovery diagnostics");
    assert.deepEqual(recovery.admission, { admitted: 0, candidates: 0, deferred: 0 });
    assert.equal(recovery.admission.why_not_now, undefined);
    assert.equal(recovery.stall.stalled, false);
    assert.equal(recovery.stall.eligibleCandidates, 0);
    assert.equal(recovery.unreadable, false);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
    const renderedVerdict = body?.rendered_verdict;
    assert.ok(renderedVerdict, "response carries rendered_verdict");
    assert.ok(renderedVerdict.pill, "rendered_verdict carries pill");
    assert.ok(
      Array.isArray(renderedVerdict.required_actions),
      "diagnostics carries the shared required-action projection"
    );

    const audit = findInspectAuditEvent(resp);
    assert.equal(audit.actor_type, "owner_agent");
    assert.equal(audit.actor_id, OWNER_CLIENT_ID);
    assert.equal(audit.client_id, OWNER_CLIENT_ID);
    assert.equal(audit.subject_id, OWNER_SUBJECT_ID);
    assert.equal(audit.object_type, "connection");
    assert.equal(audit.object_id, "cin_spotify_personal");
    assert.equal(audit.status, "succeeded");
    assert.equal(auditData(audit).actor_kind, "owner_agent");
    assert.equal(auditData(audit).auth_token_kind, "owner");
    assert.equal(auditData(audit).operation, "inspect_diagnostics");
    assert.equal(auditData(audit).selector, "connection_id");
    assert.equal(auditData(audit).connection_id, "cin_spotify_personal");
    assert.equal(auditData(audit).connector_key, connectorKey);
    assert.equal(auditData(audit).health_state, healthState, "audit records the observed health state");
  });
});

test("diagnostics is connection-scoped: two active connections do not leak into one read", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
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
    const { status, body: rawBody } = await getDiagnostics(
      rsUrl,
      ownerToken,
      "/v1/owner/connections/cin_spotify_personal/diagnostics"
    );
    const body = rawBody as DiagnosticsResponseBody;
    assert.equal(status, 200);
    // The read describes exactly the addressed connection — never the sibling.
    // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
    assert.equal(body?.connection_id, "cin_spotify_personal");
    // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
    assert.equal(body?.display_name, "the owner personal");
    // The sibling connection id must appear nowhere in the serialized response
    // (no device-wide / sibling-connection bleed-through).
    const serialized = JSON.stringify(body);
    assert.ok(
      !serialized.includes("cin_spotify_shared"),
      "sibling connection_id must not leak into a connection-scoped diagnostics read"
    );
    assert.ok(
      !serialized.includes("Shared Spotify"),
      "sibling display_name must not leak into a connection-scoped diagnostics read"
    );
    // The response carries no device-exporter subsystem envelope.
    assert.ok(!serialized.includes("device_exporter"), "must not carry device-exporter subsystem state");
    assert.ok(!serialized.includes("source_instances"), "must not carry device source-instance list");
  });
});

test("owner-agent connector-only diagnostics auto-selects the single active connection", async () => {
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
    const {
      status,
      body: rawBody,
      resp,
    } = await getDiagnostics(rsUrl, ownerToken, `/v1/owner/connectors/${encodeURIComponent(connectorKey)}/diagnostics`);
    const body = rawBody as DiagnosticsResponseBody;
    assert.equal(status, 200);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
    assert.equal(body?.connection_id, "cin_spotify_only");

    const audit = findInspectAuditEvent(resp);
    assert.equal(auditData(audit).selector, "connector_id");
    assert.equal(auditData(audit).connection_id, "cin_spotify_only");
    assert.equal(auditData(audit).operation, "inspect_diagnostics");
  });
});

test("owner-agent connector-only diagnostics rejects two active connections with typed ambiguous_connection", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
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
    const {
      status,
      body: rawBody,
      resp,
    } = await getDiagnostics(rsUrl, ownerToken, `/v1/owner/connectors/${encodeURIComponent(connectorKey)}/diagnostics`);
    const body = rawBody as DiagnosticsResponseBody;
    assert.equal(status, 409);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
    assert.equal(body?.error?.code, "ambiguous_connection");
    // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
    assert.equal(body?.error?.retry_with, "connection_id");
    // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
    const ids = (body?.error?.available_connections ?? []).map((c) => c.connection_id).sort();
    assert.deepEqual(ids, ["cin_spotify_personal", "cin_spotify_shared"]);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
    const labels = (body?.error?.available_connections ?? [])
      .map((c) => c.display_name)
      .filter(Boolean)
      .sort();
    assert.deepEqual(labels, ["Shared Spotify", "the owner personal"]);

    const audit = findInspectAuditEvent(resp);
    assert.equal(audit.status, "failed");
    assert.equal(auditData(audit).selector, "connector_id");
    assert.equal(auditData(audit).connector_key, connectorKey);
    assert.equal(auditData(audit).operation, "inspect_diagnostics");
    assert.equal(auditData(audit).error?.code, "ambiguous_connection");
    assert.equal(auditData(audit).error?.http_status, 409);
  });
});

test("owner-agent diagnostics on an unknown connection_id returns a typed 404", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const ownerToken = await issueOwnerToken(asUrl);
    const {
      status,
      body: rawBody,
      resp,
    } = await getDiagnostics(rsUrl, ownerToken, "/v1/owner/connections/cin_missing/diagnostics");
    const body = rawBody as DiagnosticsResponseBody;
    assert.equal(status, 404);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
    assert.equal(body?.error?.code, "connector_instance_not_found");
    const audit = findInspectAuditEvent(resp);
    assert.equal(audit.status, "failed");
    assert.equal(audit.object_id, "cin_missing");
    assert.equal(auditData(audit).connection_id, "cin_missing");
    assert.equal(auditData(audit).error?.code, "connector_instance_not_found");
  });
});

test("owner-agent diagnostics cannot cross owners (other-owner instance is not found)", async () => {
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
    const ownerToken = await issueOwnerToken(asUrl);
    const { status } = await getDiagnostics(rsUrl, ownerToken, "/v1/owner/connections/cin_spotify_other/diagnostics");
    // Resolver rejects the foreign instance.
    assert.ok(status === 404 || status === 403, `expected 404/403, got ${status}`);
  });
});

test("owner-agent diagnostics rejects a client grant token with 403 and audits it", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_personal",
      displayName: "My Spotify",
      sourceBindingKey: "the owner@example.com",
    });
    // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
    const firstStream = manifest.streams[0];
    assert.ok(firstStream, "manifest carries at least one stream");
    const clientToken = await approveClientGrant(asUrl, connectorKey, firstStream.name);

    const {
      status,
      body: rawBody,
      resp,
    } = await getDiagnostics(rsUrl, clientToken, "/v1/owner/connections/cin_spotify_personal/diagnostics");
    const body = rawBody as DiagnosticsResponseBody;
    assert.equal(status, 403);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
    assert.equal(body?.error?.code, "permission_error");

    const audit = findInspectAuditEvent(resp);
    assert.equal(audit.status, "failed");
    assert.equal(audit.actor_type, "client");
    assert.equal(auditData(audit).actor_kind, "client");
    assert.equal(auditData(audit).operation, "inspect_diagnostics");
    assert.equal(auditData(audit).error?.code, "permission_error");
  });
});

test("owner-agent diagnostics rejects a request with no bearer (401)", async () => {
  await withServer(async ({ rsUrl }) => {
    const { status, body: rawBody } = await fetchJson(`${rsUrl}/v1/owner/connections/cin_spotify_personal/diagnostics`);
    const body = rawBody as DiagnosticsResponseBody;
    assert.equal(status, 401);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
    assert.equal(body?.error?.type, "authentication_error");
  });
});

test("/mcp continues to reject owner-agent bearers after diagnostics control lands", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body: rawBody } = await fetchJson(`${rsUrl}/mcp`, {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list", params: {} }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    const body = rawBody as DiagnosticsResponseBody;
    assert.equal(status, 403);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
    assert.equal(body?.error?.code, "permission_error");
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
    assert.match(body?.error?.message ?? "", /owner-agent/i);
  });
});

test("owner-agent control document advertises inspect_diagnostics as supported with a diagnostics URL", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { body: rawBody } = await fetchJson(`${rsUrl}/v1/owner/control`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const body = rawBody as DiagnosticsResponseBody;
    assert.ok(body.actions, "control document carries actions");
    const diagnostics = body.actions.find((a) => a.family === "inspect_diagnostics");
    assert.ok(diagnostics, "inspect_diagnostics must be advertised");
    assert.equal(diagnostics.status, "supported");
    assert.equal(diagnostics.method, "GET");
    assert.equal(diagnostics.url, `${rsUrl}/v1/owner/connections/{connection_id}/diagnostics`);
  });
});

// ─── Recovery-admission diagnostics (tasks 2.6 / 2.7) ────────────────────────
//
// These prove the durable owner-only read answers "why didn't the most recent
// recovery attempt run" (2.6) and surfaces a stalled eligible backlog as an
// observable system condition (2.7), derived from the connection's real
// `connector_detail_gaps` rows — no fabricated evidence, no new store.

const RECOVERY_STALL_CADENCE_MS = 6 * 60 * 60 * 1000;

test("2.6 diagnostics answers why_not_now=cooldown for a fully-cooling-down backlog", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_cooldown",
      displayName: "cooldown connection",
      sourceBindingKey: "cooldown@example.com",
    });

    // Two pending recovery gaps whose own next-attempt floor is in the future:
    // every candidate is deferred by its per-item cooldown, so nothing is
    // admissible now.
    const gapStore = detailGapStore();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1h
    for (const recordKey of ["track_a", "track_b"]) {
      // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
      await gapStore.upsertPendingGap({
        connectorId: connectorKey,
        connectorInstanceId: "cin_spotify_cooldown",
        nextAttemptAfter: future,
        reason: "retry_exhausted",
        recordKey,
        stream: "tracks",
      });
    }

    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body: rawBody } = await getDiagnostics(
      rsUrl,
      ownerToken,
      "/v1/owner/connections/cin_spotify_cooldown/diagnostics"
    );
    const body = rawBody as DiagnosticsResponseBody;
    assert.equal(status, 200);
    assert.ok(body.recovery, "response carries recovery diagnostics");
    const { admission, stall } = body.recovery;
    assert.equal(admission.candidates, 2, "both pending gaps are candidates");
    assert.equal(admission.admitted, 0, "nothing is admissible while cooling down");
    assert.equal(admission.deferred, 2);
    assert.equal(admission.deferred_by_reason.cooldown, 2);
    assert.equal(admission.next_eligible_at, future, "read surfaces the next eligible time");
    assert.equal(admission.why_not_now, "cooldown", "diagnostics answers why it did not run");
    // Cooling-down work is correctly deferred — NOT a stall.
    assert.equal(stall.eligibleCandidates, 0);
    assert.equal(stall.stalled, false);
  });
});

test("2.6 diagnostics answers why_not_now=owner_required over a cooldown row", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_owner",
      displayName: "owner-required connection",
      sourceBindingKey: "owner-required@example.com",
    });

    const gapStore = detailGapStore();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await gapStore.upsertPendingGap({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_owner",
      nextAttemptAfter: future,
      reason: "retry_exhausted",
      recordKey: "cooldown_track",
      stream: "tracks",
    });
    await gapStore.upsertPendingGap({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_owner",
      reason: "auth_failure",
      recordKey: "auth_track",
      stream: "tracks",
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const { body: rawBody } = await getDiagnostics(
      rsUrl,
      ownerToken,
      "/v1/owner/connections/cin_spotify_owner/diagnostics"
    );
    const body = rawBody as DiagnosticsResponseBody;
    assert.ok(body.recovery, "response carries recovery diagnostics");
    const { admission } = body.recovery;
    assert.equal(admission.admitted, 0);
    assert.equal(admission.deferred_by_reason.owner_required, 1);
    assert.equal(admission.deferred_by_reason.cooldown, 1);
    // Owner-sole-resolution outranks a system-resumable cooldown.
    assert.equal(admission.why_not_now, "owner_required");
  });
});

test("2.6 diagnostics scopes pending-gap reads before applying the read limit", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_noisy_sibling",
      displayName: "noisy sibling connection",
      sourceBindingKey: "noisy@example.com",
    });
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_targeted",
      displayName: "targeted connection",
      sourceBindingKey: "targeted@example.com",
    });

    const gapStore = detailGapStore();
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    for (let i = 0; i < 120; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
      await gapStore.upsertPendingGap({
        connectorId: connectorKey,
        connectorInstanceId: "cin_spotify_noisy_sibling",
        now: old,
        reason: "retry_exhausted",
        recordKey: `sibling_track_${i}`,
        stream: "tracks",
      });
    }
    await gapStore.upsertPendingGap({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_targeted",
      reason: "retry_exhausted",
      recordKey: "target_track",
      stream: "tracks",
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body: rawBody } = await getDiagnostics(
      rsUrl,
      ownerToken,
      "/v1/owner/connections/cin_spotify_targeted/diagnostics"
    );
    const body = rawBody as DiagnosticsResponseBody;
    assert.equal(status, 200);
    assert.ok(body.recovery, "response carries recovery diagnostics");
    assert.equal(body.recovery.admission.candidates, 1);
    assert.equal(body.recovery.admission.admitted, 1);
    assert.equal(body.recovery.admission.deferred, 0);
  });
});

test("2.7 stall watchdog surfaces eligible work with no attempt beyond the cadence window", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_stalled",
      displayName: "stalled connection",
      sourceBindingKey: "stalled@example.com",
    });

    // An eligible (no future floor) recovery gap whose last attempt is well
    // beyond the cadence window — eligible work that has stopped receiving
    // attempts. The seeded `now` sets updated_at/last-touch older than 6h.
    const gapStore = detailGapStore();
    const stale = new Date(Date.now() - RECOVERY_STALL_CADENCE_MS - 60 * 60 * 1000).toISOString();
    const gap = await gapStore.upsertPendingGap({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_stalled",
      now: stale,
      reason: "retry_exhausted",
      recordKey: "stalled_track",
      stream: "tracks",
    });
    assert.ok(gap, "expected the pending gap to be created");
    // Record an attempt at the stale instant, then revert to pending so it is
    // eligible again but its last_attempt_at is old (the crash-reclaim shape).
    await gapStore.markGapStatus(gap.gap_id, "in_progress", { now: stale, runId: "run_old" });
    await gapStore.markGapStatus(gap.gap_id, "pending", { now: stale, runId: "run_old" });

    const ownerToken = await issueOwnerToken(asUrl);
    const { body: rawBody } = await getDiagnostics(
      rsUrl,
      ownerToken,
      "/v1/owner/connections/cin_spotify_stalled/diagnostics"
    );
    const body = rawBody as DiagnosticsResponseBody;
    assert.ok(body.recovery, "response carries recovery diagnostics");
    const { admission, stall } = body.recovery;
    // The gap is eligible now (no future floor) — it should be admitted...
    assert.equal(admission.admitted, 1, "the stale-but-eligible gap is admissible");
    assert.equal(admission.why_not_now, undefined, "eligible work has no blocker to explain");
    // ...yet it has received no attempt within the cadence window: a stall.
    assert.equal(stall.eligibleCandidates, 1);
    assert.equal(stall.stalled, true, "eligible work with no fresh attempt is an observable stall");
    assert.equal(stall.lastAttemptAt, stale, "stall carries the last-attempt recency evidence");
  });
});
