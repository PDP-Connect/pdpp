// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration suite for the bearer-authed owner-agent connection rename route
 * `PATCH /v1/owner/connections/:connectionId` (mounted from
 * `server/routes/owner-connections.ts`).
 *
 * Covers the owner-agent rename slice (task 4.4) of the owner-agent control
 * surface:
 *
 *   - a trusted owner-agent bearer can rename a seeded connection, and a
 *     follow-up `GET /v1/owner/connections` reflects the new `display_name`
 *     with `label_status: "owner_set"`;
 *   - the rename response itself carries the owner-agent contract
 *     (`connection_id`, `connector_key`, `label_status: "owner_set"`);
 *   - client grant tokens and missing/unauthenticated bearers cannot rename;
 *   - `/mcp` continues to reject owner bearers (the boundary this lane preserves);
 *   - missing / empty / non-string `display_name` return a typed 400
 *     `invalid_request` with `param: "display_name"`;
 *   - an unknown / cross-owner `connection_id` returns a typed 404
 *     `connector_instance_not_found`;
 *   - the public read connection alias agrees on `connection_id` and the
 *     renamed `display_name` after rename.
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
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const REGEXP_1 = /owner-agent/i;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const OWNER_SUBJECT_ID = "owner_local";
const OTHER_SUBJECT_ID = "owner_other";
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
  const clientId = "cli_longview";
  const device = (
    await fetchJson(`${asUrl}/oauth/device_authorization`, {
      body: new URLSearchParams({ client_id: clientId }).toString(),
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
        client_id: clientId,
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
            purpose_code: "https://pdpp.org/purpose/analytics",
            purpose_description: "owner-connection rename boundary test",
            source: { id: connectorId, kind: "connector" },
            streams: [{ fields: ["id"], name: streamName }],
            type: "https://pdpp.org/data-access",
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

interface PackageManifest {
  connector_id: string;
  streams?: { name: string; [key: string]: unknown }[];
  [key: string]: unknown;
}

function loadManifest(name: string): PackageManifest {
  return JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "..", "packages", "polyfill-connectors", "manifests", `${name}.json`), "utf8")
  ) as PackageManifest;
}

async function registerConnector(asUrl: string, manifest: PackageManifest): Promise<PackageManifest> {
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

// biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
async function renameConnection(
  rsUrl: string,
  ownerToken: string,
  connectionId: string,
  body?: Record<string, unknown>
): Promise<JsonResult> {
  const opts: RequestInit = {
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      "Content-Type": "application/json",
    },
    method: "PATCH",
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  return fetchJson(`${rsUrl}/v1/owner/connections/${encodeURIComponent(connectionId)}`, opts);
}

interface RenameResponseBody {
  connection_id?: string;
  connector_id?: string;
  connector_instance_id?: string;
  connector_key?: string;
  data?: { connection_id?: string; display_name?: string; label_status?: string; [key: string]: unknown }[];
  display_name?: string;
  error?: { code?: string; type?: string; message?: string; param?: string; http_status?: number };
  label_status?: string;
  object?: string;
  supported_actions?: { family?: string; status?: string; method?: string | null; url?: string | null }[];
  [key: string]: unknown;
}

interface AuditRenameData {
  actor_kind?: string;
  auth_token_kind?: string;
  connector_key?: string;
  display_name?: string;
  display_name_supplied?: boolean;
  error?: { code?: string; http_status?: number; [key: string]: unknown };
  label_status?: string;
  operation?: string;
  [key: string]: unknown;
}

function auditData(event: SpineEventRecord): AuditRenameData {
  return event.data as AuditRenameData;
}

function findRenameAuditEvent(resp: Response): SpineEventRecord {
  const traceId = resp.headers.get("PDPP-Reference-Trace-Id");
  assert.ok(traceId?.startsWith("trc_"), "rename response should carry an audit trace id");
  assert.ok(traceId, "trace id must be present");
  const page = listSpineEventsPage("trace", traceId, { limit: 20 });
  const event = page.events.find((entry) => entry.event_type === "owner_agent.connection.rename");
  assert.ok(event, "expected owner-agent rename audit event");
  assert.equal(event.request_id, resp.headers.get("Request-Id"));
  assert.equal(event.token_id, null, "audit event must not store bearer tokens");
  assert.equal(auditData(event).display_name, undefined, "audit event must not store raw display_name values");
  assert.equal(typeof auditData(event).display_name_supplied, "boolean");
  return event;
}

test("owner-agent bearer renames a connection and the listing reflects the new label", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest("amazon"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    // Seed unlabeled (display_name == connector key) so it starts as fallback.
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_amazon_personal",
      displayName: connectorKey,
      sourceBindingKey: "the owner@example.com",
    });

    const ownerToken = await issueOwnerToken(asUrl);

    // Precondition: the listing reports the connection as label-needed.
    const before = await fetchJson(`${rsUrl}/v1/owner/connections`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const beforeBody = before.body as RenameResponseBody;
    assert.ok(beforeBody.data, "listing response carries data");
    const beforeRow = beforeBody.data.find((r) => r.connection_id === "cin_amazon_personal");
    assert.ok(beforeRow, "expected the seeded connection row");
    assert.equal(beforeRow.label_status, "fallback");

    // Rename.
    const {
      status,
      body: rawBody,
      resp,
    } = await renameConnection(rsUrl, ownerToken, "cin_amazon_personal", {
      display_name: "the owner personal",
    });
    const body = rawBody as RenameResponseBody;
    assert.equal(status, 200);
    assert.equal(body.object, "owner_connection");
    assert.equal(body.connection_id, "cin_amazon_personal");
    assert.equal(body.connector_instance_id, "cin_amazon_personal");
    assert.equal(body.connector_key, connectorKey);
    assert.equal(body.connector_id, connectorKey);
    assert.equal(body.display_name, "the owner personal");
    assert.equal(body.label_status, "owner_set");
    // The renamed row carries instance-scoped supported_actions, with the
    // rename action resolved to this connection's concrete URL.
    const renameAction = body.supported_actions?.find((a) => a.family === "rename_connection");
    assert.ok(renameAction, "renamed row must advertise rename_connection");
    assert.equal(renameAction.status, "supported");
    assert.ok(renameAction.url?.endsWith("/v1/owner/connections/cin_amazon_personal"));

    const audit = findRenameAuditEvent(resp);
    assert.equal(audit.actor_type, "owner_agent");
    assert.equal(audit.actor_id, "cli_longview");
    assert.equal(audit.client_id, "cli_longview");
    assert.equal(audit.subject_id, OWNER_SUBJECT_ID);
    assert.equal(audit.object_type, "connection");
    assert.equal(audit.object_id, "cin_amazon_personal");
    assert.equal(audit.status, "succeeded");
    assert.equal(auditData(audit).actor_kind, "owner_agent");
    assert.equal(auditData(audit).auth_token_kind, "owner");
    assert.equal(auditData(audit).operation, "rename_connection");
    assert.equal(auditData(audit).connector_key, connectorKey);
    assert.equal(auditData(audit).display_name_supplied, true);
    assert.equal(auditData(audit).label_status, "owner_set");

    // Follow-up listing reflects the new label with owner_set status.
    const after = await fetchJson(`${rsUrl}/v1/owner/connections`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const afterBody = after.body as RenameResponseBody;
    assert.ok(afterBody.data, "listing response carries data");
    const afterRow = afterBody.data.find((r) => r.connection_id === "cin_amazon_personal");
    assert.ok(afterRow, "expected the seeded connection row");
    assert.equal(afterRow.display_name, "the owner personal");
    assert.equal(afterRow.label_status, "owner_set");
  });
});

// Reproduces the live owner-agent observation from task 8.5: a PATCH whose
// `display_name` is still a storage-layer fallback (the registry URL the
// connector defaults to) returns 200 and persists the value, but `label_status`
// stays `fallback` because the label is derived from the VALUE, not the act of
// PATCHing. This is correct: a same-fallback PATCH has not established an
// owner-meaningful label, so `owner_set` must NOT be claimed. The follow-up
// PATCH to a visibly owner-meaningful label is what proves `owner_set`. This
// locks the route contract that the live "200 but still fallback" surfaced.
test("owner-agent rename to a still-fallback value stays label_status fallback; only a visible label flips to owner_set", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest("amazon"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    // Seed with the registry-URL fallback display name, matching the live
    // Amazon connection's pre-label state.
    const registryUrlFallback = `https://registry.pdpp.org/connectors/${connectorKey}`;
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_amazon_personal",
      displayName: registryUrlFallback,
      sourceBindingKey: "the owner@example.com",
    });

    const ownerToken = await issueOwnerToken(asUrl);

    // Precondition: a registry-URL display name is reported as label-needed.
    const before = await fetchJson(`${rsUrl}/v1/owner/connections`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const beforeBody = before.body as RenameResponseBody;
    assert.ok(beforeBody.data, "listing response carries data");
    const beforeRow = beforeBody.data.find((r) => r.connection_id === "cin_amazon_personal");
    assert.ok(beforeRow, "expected the seeded connection row");
    assert.equal(beforeRow.display_name, registryUrlFallback);
    assert.equal(beforeRow.label_status, "fallback");

    // PATCH with the SAME still-fallback value (the live same-display-name PATCH).
    // The route accepts it (200) and persists it, but cannot claim owner_set
    // because the value remains a storage-layer fallback.
    const sameValue = await renameConnection(rsUrl, ownerToken, "cin_amazon_personal", {
      display_name: registryUrlFallback,
    });
    const sameValueBody = sameValue.body as RenameResponseBody;
    assert.equal(sameValue.status, 200, "a same-fallback PATCH is a valid 200 write");
    assert.equal(sameValueBody.display_name, registryUrlFallback);
    assert.equal(
      sameValueBody.label_status,
      "fallback",
      "a still-fallback value must NOT be promoted to owner_set by the act of PATCHing"
    );
    // The audit reflects the honest, still-fallback outcome.
    const sameAudit = findRenameAuditEvent(sameValue.resp);
    assert.equal(sameAudit.status, "succeeded");
    assert.equal(auditData(sameAudit).label_status, "fallback");

    // A follow-up listing still reports fallback — no hidden state changed it.
    const stillFallback = await fetchJson(`${rsUrl}/v1/owner/connections`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const stillFallbackBody = stillFallback.body as RenameResponseBody;
    assert.ok(stillFallbackBody.data, "listing response carries data");
    const stillRow = stillFallbackBody.data.find((r) => r.connection_id === "cin_amazon_personal");
    assert.ok(stillRow, "expected the seeded connection row");
    assert.equal(stillRow.label_status, "fallback");

    // Now PATCH a visibly owner-meaningful label: THIS is what proves owner_set.
    const labeled = await renameConnection(rsUrl, ownerToken, "cin_amazon_personal", {
      display_name: "the owner personal",
    });
    const labeledBody = labeled.body as RenameResponseBody;
    assert.equal(labeled.status, 200);
    assert.equal(labeledBody.display_name, "the owner personal");
    assert.equal(labeledBody.label_status, "owner_set");
    const labeledAudit = findRenameAuditEvent(labeled.resp);
    assert.equal(auditData(labeledAudit).label_status, "owner_set");
  });
});

test("owner-agent bearer can label two Amazon connections distinctly", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest("amazon"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_amazon_personal",
      displayName: connectorKey,
      sourceBindingKey: "the owner@example.com",
    });
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_amazon_shared",
      displayName: connectorKey,
      sourceBindingKey: "shared@example.com",
    });

    const ownerToken = await issueOwnerToken(asUrl);
    await renameConnection(rsUrl, ownerToken, "cin_amazon_personal", { display_name: "the owner personal" });
    await renameConnection(rsUrl, ownerToken, "cin_amazon_shared", { display_name: "Shared Amazon" });

    const { body: rawBody } = await fetchJson(
      `${rsUrl}/v1/owner/connections?connector_id=${encodeURIComponent(connectorKey)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    const body = rawBody as RenameResponseBody;
    assert.ok(body.data, "listing response carries data");
    const personal = body.data.find((r) => r.connection_id === "cin_amazon_personal");
    const shared = body.data.find((r) => r.connection_id === "cin_amazon_shared");
    assert.ok(personal, "expected the personal Amazon connection row");
    assert.ok(shared, "expected the shared Amazon connection row");
    assert.equal(personal.display_name, "the owner personal");
    assert.equal(personal.label_status, "owner_set");
    assert.equal(shared.display_name, "Shared Amazon");
    assert.equal(shared.label_status, "owner_set");
  });
});

test("owner-agent rename trims whitespace around the display name", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest("amazon"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_amazon_personal",
      displayName: connectorKey,
      sourceBindingKey: "the owner@example.com",
    });
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body: rawBody } = await renameConnection(rsUrl, ownerToken, "cin_amazon_personal", {
      display_name: "  the owner personal  ",
    });
    const body = rawBody as RenameResponseBody;
    assert.equal(status, 200);
    assert.equal(body.display_name, "the owner personal");
  });
});

test("owner-agent rename rejects a missing display_name with a typed 400", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest("amazon"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_amazon_personal",
      displayName: connectorKey,
      sourceBindingKey: "the owner@example.com",
    });
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body: rawBody, resp } = await renameConnection(rsUrl, ownerToken, "cin_amazon_personal", {});
    const body = rawBody as RenameResponseBody;
    assert.equal(status, 400);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
    assert.equal(body?.error?.code, "invalid_request");
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
    assert.equal(body?.error?.param, "display_name");
    const audit = findRenameAuditEvent(resp);
    assert.equal(audit.status, "failed");
    assert.equal(auditData(audit).actor_kind, "owner_agent");
    assert.equal(auditData(audit).display_name_supplied, false);
    assert.equal(auditData(audit).error?.code, "invalid_request");
    assert.equal(auditData(audit).error?.http_status, 400);
  });
});

test("owner-agent rename rejects an empty/whitespace display_name with a typed 400", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest("amazon"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_amazon_personal",
      displayName: connectorKey,
      sourceBindingKey: "the owner@example.com",
    });
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body: rawBody } = await renameConnection(rsUrl, ownerToken, "cin_amazon_personal", {
      display_name: "   ",
    });
    const body = rawBody as RenameResponseBody;
    assert.equal(status, 400);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
    assert.equal(body?.error?.code, "invalid_request");
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
    assert.equal(body?.error?.param, "display_name");
  });
});

test("owner-agent rename rejects a non-string display_name with a typed 400", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest("amazon"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_amazon_personal",
      displayName: connectorKey,
      sourceBindingKey: "the owner@example.com",
    });
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body: rawBody } = await renameConnection(rsUrl, ownerToken, "cin_amazon_personal", {
      display_name: 42,
    });
    const body = rawBody as RenameResponseBody;
    assert.equal(status, 400);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
    assert.equal(body?.error?.code, "invalid_request");
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
    assert.equal(body?.error?.param, "display_name");
  });
});

test("owner-agent rename of an unknown connection_id returns a typed 404", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    await registerConnector(asUrl, loadManifest("amazon"));
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body: rawBody } = await renameConnection(rsUrl, ownerToken, "cin_does_not_exist", {
      display_name: "Whatever",
    });
    const body = rawBody as RenameResponseBody;
    assert.equal(status, 404);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
    assert.equal(body?.error?.code, "connector_instance_not_found");
  });
});

test("owner-agent rename cannot cross owners (other owner instance is not found)", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest("amazon"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    // Instance belongs to a DIFFERENT owner subject.
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_amazon_other",
      displayName: connectorKey,
      ownerSubjectId: OTHER_SUBJECT_ID,
      sourceBindingKey: "other@example.com",
    });
    // Token authenticates as the default OWNER_SUBJECT_ID.
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body: rawBody } = await renameConnection(rsUrl, ownerToken, "cin_amazon_other", {
      display_name: "Hijack attempt",
    });
    const body = rawBody as RenameResponseBody;
    assert.equal(status, 404);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
    assert.equal(body?.error?.code, "connector_instance_not_found");
  });
});

test("owner-agent rename rejects a client grant token with 403", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest("amazon"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_amazon_personal",
      displayName: connectorKey,
      sourceBindingKey: "the owner@example.com",
    });
    const firstStream = manifest.streams?.[0];
    assert.ok(firstStream, "manifest carries at least one stream");
    const clientToken = await approveClientGrant(asUrl, connectorKey, firstStream.name);

    const {
      status,
      body: rawBody,
      resp,
    } = await renameConnection(rsUrl, clientToken, "cin_amazon_personal", {
      display_name: "the owner personal",
    });
    const body = rawBody as RenameResponseBody;
    assert.equal(status, 403);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
    assert.equal(body?.error?.code, "permission_error");
    const audit = findRenameAuditEvent(resp);
    assert.equal(audit.status, "failed");
    assert.equal(audit.actor_type, "client");
    assert.equal(audit.client_id, "longview");
    assert.equal(auditData(audit).actor_kind, "client");
    assert.equal(auditData(audit).auth_token_kind, "client");
    assert.equal(auditData(audit).display_name_supplied, true);
    assert.equal(auditData(audit).error?.code, "permission_error");
  });
});

test("owner-agent rename rejects a request with no bearer (401)", async () => {
  await withServer(async ({ rsUrl }) => {
    const { status, body: rawBody } = await fetchJson(`${rsUrl}/v1/owner/connections/cin_amazon_personal`, {
      body: JSON.stringify({ display_name: "the owner personal" }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
    const body = rawBody as RenameResponseBody;
    assert.equal(status, 401);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
    assert.equal(body?.error?.type, "authentication_error");
  });
});

test("/mcp continues to reject owner-agent bearers after rename support lands", async () => {
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
    const body = rawBody as RenameResponseBody;
    assert.equal(status, 403);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
    assert.equal(body?.error?.code, "permission_error");
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
    assert.match(body?.error?.message ?? "", REGEXP_1);
  });
});

test("owner-agent rename is the single source of truth: a fresh store read agrees on connection_id and display_name", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest("amazon"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "expected a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_amazon_personal",
      displayName: connectorKey,
      sourceBindingKey: "the owner@example.com",
    });
    const ownerToken = await issueOwnerToken(asUrl);
    await renameConnection(rsUrl, ownerToken, "cin_amazon_personal", { display_name: "the owner personal" });

    // The owner-agent surface and a direct store read (what the cookie-authed
    // `/_ref` listing and public-read connection decoration both project from)
    // must agree on connection identity + the renamed label, proving the rename
    // persisted to the shared store row rather than a surface-local view.
    const ownerList = await fetchJson(`${rsUrl}/v1/owner/connections`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const ownerListBody = ownerList.body as RenameResponseBody;
    assert.ok(ownerListBody.data, "listing response carries data");
    const ownerRow = ownerListBody.data.find((r) => r.connection_id === "cin_amazon_personal");
    assert.ok(ownerRow, "expected the seeded connection row");
    assert.equal(ownerRow.display_name, "the owner personal");

    // Local structural type for the store's real (but unexported) ConnectorInstance
    // return shape -- covers only the fields this assertion reads.
    const stored = (await createSqliteConnectorInstanceStore().get("cin_amazon_personal")) as {
      connectorInstanceId: string;
      displayName: string;
    } | null;
    assert.ok(stored, "expected the renamed connection row in the store");
    assert.equal(stored.connectorInstanceId, ownerRow.connection_id);
    assert.equal(stored.displayName, ownerRow.display_name);
  });
});
