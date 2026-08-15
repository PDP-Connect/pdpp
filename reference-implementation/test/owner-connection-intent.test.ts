// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration suite for the bearer-authed owner-agent connection-intent route
 * `POST /v1/owner/connections/intents` (mounted from
 * `server/routes/owner-connection-intent.ts`) plus unit coverage for the pure
 * `classifyConnectorIntentModality` classifier.
 *
 * Covers the owner-agent connection-initiation slice (tasks 2.3, 5.1-5.4) of the
 * owner-agent control surface:
 *
 *   - a trusted owner-agent bearer initiating a connection for a proven
 *     local-collector connector (`codex`, `claude-code`) gets a real
 *     `enroll_local_collector` next step with a single-use enrollment code, and
 *     exchanging that code at the device-exporter enroll endpoint materializes a
 *     real `cin_*` connection — proving the minted code is genuine, not a stub;
 *   - proof-gated browser-bound connectors return typed `manual_runbook` setup
 *     steps, while static-secret connectors return a non-secret
 *     `capture_static_secret` owner-session step — NOT faked active
 *     connections;
 *   - provider-authorization connectors with missing platform config return
 *     `needs_deployment_config` with non-secret blockers;
 *   - an unknown connector returns `unsupported` / `connector_modality: unknown`;
 *   - every response carries `connection_active: false` and the intent itself
 *     writes no connection row;
 *   - the `GET /v1/owner/control` catalog advertises `initiate_connection` as
 *     `supported` (POST + URL), kept in sync with the metadata hint;
 *   - client grant tokens (403) and missing bearers (401) cannot initiate, and
 *     `/mcp` continues to reject owner bearers;
 *   - non-secret audit evidence (`owner_agent.connection.initiate`) records actor
 *     kind/client, connector key, modality, next-step kind, and outcome without
 *     logging the bearer token or the minted enrollment code.
 *
 * Spec: openspec/changes/add-owner-agent-control-surface
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { listSpineEventsPage, type SpineEventRecord } from "../lib/spine.ts";
import { COLLECTOR_PROTOCOL_VERSION } from "../server/collector-protocol.ts";
import { type ConnectorManifestLike, classifyConnectorIntentModality } from "../server/connection-setup-plan.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { startServer } from "../server/index.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const OWNER_SUBJECT_ID = "owner_local";
const PROTOCOL_HEADERS = { "X-PDPP-Collector-Protocol": COLLECTOR_PROTOCOL_VERSION };
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
            purpose_description: "owner-connection intent boundary test",
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

interface IntentNextStep {
  authorization_url?: string;
  capture_endpoint?: string;
  enroll_endpoint?: string;
  enrollment_code?: string;
  expires_at?: string;
  kind?: string;
  local_binding_name?: string;
  reason?: string;
  runbook_path?: string;
  upload_endpoint?: string;
  [key: string]: unknown;
}

interface IntentResponseBody {
  actions?: { family?: string; status?: string; method?: string | null; url?: string | null }[];
  connection_active?: boolean;
  connector_id?: string;
  connector_key?: string;
  connector_modality?: string;
  data?: { connector_key?: string; [key: string]: unknown }[];
  deployment_readiness?: {
    state?: string;
    blockers?: { key: string; [key: string]: unknown }[];
    [key: string]: unknown;
  };
  enrollment_code?: string;
  error?: { code?: string; type?: string; message?: string; param?: string };
  next_step?: IntentNextStep;
  object?: string;
  proof_gate?: string | null;
  runbook_path?: string | null;
  setup_modality?: string;
  support_state?: string;
  validation?: string;
  [key: string]: unknown;
}

interface AuditIntentData {
  actor_kind?: string;
  auth_token_kind?: string;
  connector_key?: string;
  connector_modality?: string;
  display_name_supplied?: boolean;
  error?: { code?: string; [key: string]: unknown };
  next_step_kind?: string;
  operation?: string;
  [key: string]: unknown;
}

function auditData(event: SpineEventRecord): AuditIntentData {
  return event.data as AuditIntentData;
}

// biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
async function createIntent(rsUrl: string, ownerToken: string, body?: Record<string, unknown>): Promise<JsonResult> {
  const opts: RequestInit = {
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  return fetchJson(`${rsUrl}/v1/owner/connections/intents`, opts);
}

function findIntentAuditEvent(resp: Response): SpineEventRecord {
  const traceId = resp.headers.get("PDPP-Reference-Trace-Id");
  assert.ok(traceId?.startsWith("trc_"), "intent response should carry an audit trace id");
  assert.ok(traceId, "trace id must be present");
  const page = listSpineEventsPage("trace", traceId, { limit: 20 });
  const event = page.events.find((entry) => entry.event_type === "owner_agent.connection.initiate");
  assert.ok(event, "expected owner-agent connection-initiate audit event");
  assert.equal(event.request_id, resp.headers.get("Request-Id"));
  assert.equal(event.token_id, null, "audit event must not store bearer tokens");
  return event;
}

interface PackageManifest extends ConnectorManifestLike {
  connector_id: string;
  streams?: { name: string; [key: string]: unknown }[];
  [key: string]: unknown;
}

function loadPackageManifest(name: string): PackageManifest {
  return JSON.parse(
    readFileSync(new URL(`../../packages/polyfill-connectors/manifests/${name}.json`, import.meta.url), "utf8")
  ) as PackageManifest;
}

function withExplicitTestSourceDeclaration(manifest: PackageManifest): PackageManifest {
  if (manifest.source_declaration && typeof manifest.source_declaration === "object") {
    return manifest;
  }
  const connectorKey = canonicalConnectorKey(manifest.connector_id) ?? manifest.connector_id;
  const streams = Array.isArray(manifest.streams)
    ? manifest.streams.map((stream) => ({
        ...stream,
        ...(stream.semantics === "append" ? { semantics: "append_only" } : {}),
      }))
    : [];
  return {
    ...manifest,
    source_declaration: {
      declaration_version: `owner-connection-intent-test:${connectorKey}:v1`,
      display: { name: typeof manifest.display_name === "string" ? manifest.display_name : connectorKey },
      protocol_version: manifest.protocol_version,
      publisher: { id: "https://pdpp.dev/reference-implementation/tests" },
      source: { id: `https://sources.example/connectors/${encodeURIComponent(connectorKey)}`, kind: "connector" },
      streams,
    },
  };
}

async function registerConnector(asUrl: string, manifest: PackageManifest): Promise<PackageManifest> {
  const registeredManifest = withExplicitTestSourceDeclaration(manifest);
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(registeredManifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const text = await resp.text();
  assert.equal(resp.status, 201, `register ${registeredManifest.connector_id} failed: ${resp.status} ${text}`);
  return manifest;
}

interface SeedInstanceOptions {
  connectorId: string;
  connectorInstanceId: string;
  displayName: string;
  sourceBindingKey: string;
}

// Seed one configured connection instance directly, the same way the schedule
// suite does, so the "owner already has a first Amazon account" precondition is
// real without driving an enroll/ingest flow.
async function seedInstance({
  connectorInstanceId,
  connectorId,
  displayName,
  sourceBindingKey,
}: SeedInstanceOptions): Promise<void> {
  const store = createSqliteConnectorInstanceStore();
  await store.upsert({
    connectorId,
    connectorInstanceId,
    createdAt: NOW,
    displayName,
    ownerSubjectId: OWNER_SUBJECT_ID,
    sourceBinding: { account_hint: sourceBindingKey },
    sourceBindingKey,
    sourceKind: "account",
    status: "active",
    updatedAt: NOW,
  });
}

// ---- classifier unit tests -------------------------------------------------

test("classifyConnectorIntentModality: filesystem binding -> local_collector", () => {
  assert.equal(
    classifyConnectorIntentModality({ runtime_requirements: { bindings: { filesystem: { required: true } } } }),
    "local_collector"
  );
});

test("classifyConnectorIntentModality: browser binding -> browser_bound", () => {
  assert.equal(
    classifyConnectorIntentModality({
      runtime_requirements: { bindings: { browser: { required: true }, network: { required: true } } },
    }),
    "browser_bound"
  );
});

test("classifyConnectorIntentModality: network-only binding -> api_network", () => {
  assert.equal(
    classifyConnectorIntentModality({ runtime_requirements: { bindings: { network: { required: true } } } }),
    "api_network"
  );
});

test("classifyConnectorIntentModality: null manifest -> unknown", () => {
  assert.equal(classifyConnectorIntentModality(null), "unknown");
});

test("classifyConnectorIntentModality: no bindings -> unknown", () => {
  assert.equal(classifyConnectorIntentModality({ runtime_requirements: {} }), "unknown");
});

test("classifyConnectorIntentModality: filesystem wins over a stray browser binding", () => {
  assert.equal(
    classifyConnectorIntentModality({
      runtime_requirements: { bindings: { browser: { required: true }, filesystem: { required: true } } },
    }),
    "local_collector"
  );
});

// ---- route integration tests ----------------------------------------------

test("owner-agent initiates a local-collector connection and receives a real enrollment next step", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const {
      status,
      body: rawBody,
      resp,
    } = await createIntent(rsUrl, ownerToken, {
      connector_id: " https://registry.pdpp.dev/connectors/codex ",
      display_name: "My laptop Codex",
    });
    const body = rawBody as IntentResponseBody;
    assert.equal(status, 201);
    assert.equal(body.object, "owner_connection_intent");
    assert.equal(body.connector_id, "codex");
    assert.equal(body.connector_key, "codex");
    assert.equal(body.connector_modality, "local_collector");
    assert.equal(body.setup_modality, "local_collector");
    assert.equal(body.support_state, "supported");
    assert.equal(body.proof_gate, null);
    assert.equal(body.runbook_path, null);
    assert.ok(body.deployment_readiness, "response carries deployment_readiness");
    assert.equal(body.deployment_readiness.state, "not_applicable");
    assert.equal(body.connection_active, false);
    assert.ok(body.next_step, "response carries a next_step");
    assert.equal(body.next_step.kind, "enroll_local_collector");
    assert.ok(body.next_step.enrollment_code, "should mint a single-use enrollment code");
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(body.next_step.enroll_endpoint ?? "", /\/_ref\/device-exporters\/enroll$/);
    assert.equal(body.next_step.local_binding_name, "codex");
    assert.ok(body.next_step.expires_at, "should carry an expiry");

    // Audit: succeeded, owner_agent, codex, local_collector, enroll_local_collector.
    const audit = findIntentAuditEvent(resp);
    assert.equal(audit.actor_type, "owner_agent");
    assert.equal(audit.actor_id, "cli_longview");
    assert.equal(audit.client_id, "cli_longview");
    assert.equal(audit.subject_id, OWNER_SUBJECT_ID);
    assert.equal(audit.object_type, "connection_intent");
    assert.equal(audit.object_id, "codex");
    assert.equal(audit.status, "succeeded");
    assert.equal(auditData(audit).actor_kind, "owner_agent");
    assert.equal(auditData(audit).auth_token_kind, "owner");
    assert.equal(auditData(audit).operation, "initiate_connection");
    assert.equal(auditData(audit).connector_key, "codex");
    assert.equal(auditData(audit).connector_modality, "local_collector");
    assert.equal(auditData(audit).next_step_kind, "enroll_local_collector");
    assert.equal(auditData(audit).display_name_supplied, true);
    // Audit must NOT carry the minted enrollment code anywhere.
    assert.equal(JSON.stringify(audit).includes(body.next_step.enrollment_code ?? ""), false);
  });
});

test("the minted enrollment code is genuine: exchanging it materializes a real connection", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const intent = (await createIntent(rsUrl, ownerToken, { connector_id: "codex" })).body as IntentResponseBody;
    assert.ok(intent.next_step, "intent response carries a next_step");
    assert.equal(intent.next_step.kind, "enroll_local_collector");
    assert.ok(intent.next_step.enroll_endpoint, "next_step carries an enroll_endpoint");

    // Before enroll: the intent wrote no connection row.
    const beforeStore = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(beforeStore.length, 0, "the intent itself must not create a connection");

    // Exchange the minted code at the enroll endpoint named by the intent.
    const enrollResult = await fetchJson(intent.next_step.enroll_endpoint, {
      body: JSON.stringify({ enrollment_code: intent.next_step.enrollment_code }),
      headers: { Accept: "application/json", "Content-Type": "application/json", ...PROTOCOL_HEADERS },
      method: "POST",
    });
    const enrollBody = enrollResult.body as { object?: string; connector_instance_id?: string };
    assert.equal(enrollResult.status, 201);
    assert.equal(enrollBody.object, "device_exporter_enrollment");
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(enrollBody.connector_instance_id ?? "", /^cin_/);

    // After enroll: a real codex connection now exists for the owner.
    const after = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(after.length, 1);
    // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
    const afterRow = after[0];
    assert.ok(afterRow, "expected the newly enrolled connection row");
    assert.equal(afterRow.connectorId, "codex");
  });
});

interface CollectionScopeBody {
  connection_id?: string;
  declared_at?: string;
  fingerprint?: string;
  object?: string;
  scope?: { since?: string; source_roots?: string[] } | null;
  [key: string]: unknown;
}

function getCollectionScope(rsUrl: string, ownerToken: string, connectionId: string): Promise<JsonResult> {
  return fetchJson(`${rsUrl}/v1/owner/connections/${encodeURIComponent(connectionId)}/collection-scope`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
}

test("a boundary declared at intent creation is materialized on enroll and reads back exactly", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const declaredScope = { since: "2026-07-10T00:00:00.000Z" };
    const intent = (await createIntent(rsUrl, ownerToken, { collection_scope: declaredScope, connector_id: "codex" }))
      .body as IntentResponseBody;
    assert.ok(intent.next_step, "intent response carries a next_step");
    // The intent echoes the boundary it staged, before any device exists, so a
    // caller can confirm what will apply without a second round trip.
    assert.deepEqual(intent.next_step.collection_scope, declaredScope);

    const enrollResult = await fetchJson(intent.next_step.enroll_endpoint ?? "", {
      body: JSON.stringify({ enrollment_code: intent.next_step.enrollment_code }),
      headers: { Accept: "application/json", "Content-Type": "application/json", ...PROTOCOL_HEADERS },
      method: "POST",
    });
    const enrollBody = enrollResult.body as { connector_instance_id?: string };
    assert.equal(enrollResult.status, 201);
    assert.ok(enrollBody.connector_instance_id, "enroll response carries the materialized connector_instance_id");

    // The declared boundary is now durable against the real connection — read
    // back through the SAME owner-scope route a UI/CLI would use later.
    const scopeResp = await getCollectionScope(rsUrl, ownerToken, enrollBody.connector_instance_id ?? "");
    const scopeBody = scopeResp.body as CollectionScopeBody;
    assert.equal(scopeResp.status, 200);
    assert.equal(scopeBody.object, "collection_scope");
    assert.deepEqual(scopeBody.scope, declaredScope);
    assert.equal(scopeBody.fingerprint, `since=${declaredScope.since}`);
  });
});

test("omitting collection_scope at intent creation defaults the connection to recent history, not an implicit full pass", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const intent = (await createIntent(rsUrl, ownerToken, { connector_id: "codex" })).body as IntentResponseBody;
    assert.equal(intent.next_step?.collection_scope, null);

    const enrollResult = await fetchJson(intent.next_step?.enroll_endpoint ?? "", {
      body: JSON.stringify({ enrollment_code: intent.next_step?.enrollment_code }),
      headers: { Accept: "application/json", "Content-Type": "application/json", ...PROTOCOL_HEADERS },
      method: "POST",
    });
    const enrollBody = enrollResult.body as { connector_instance_id?: string };
    assert.equal(enrollResult.status, 201);

    const scopeResp = await getCollectionScope(rsUrl, ownerToken, enrollBody.connector_instance_id ?? "");
    const scopeBody = scopeResp.body as CollectionScopeBody;
    assert.equal(scopeResp.status, 200);
    // Neither the intent NOR the device declared a boundary, so the honest
    // system default applies: recent history, never an implicit full pass.
    // See enrollment-scope-narrowing.ts's resolveEffectiveEnrollmentScope.
    assert.ok(scopeBody.scope?.since, "an undeclared enrollment defaults to a recent-history since, not null");
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(scopeBody.fingerprint ?? "", /^since=/);
  });
});

test("owner-agent intent rejects an unparseable collection_scope.since with a typed 400", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body: rawBody } = await createIntent(rsUrl, ownerToken, {
      collection_scope: { since: "last tuesday" },
      connector_id: "codex",
    });
    const body = rawBody as IntentResponseBody;
    assert.equal(status, 400);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the runtime fixture deliberately exercises an absent or nullable boundary value.
    assert.equal(body?.error?.code, "invalid_request");
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the runtime fixture deliberately exercises an absent or nullable boundary value.
    assert.equal(body?.error?.param, "collection_scope");

    // A rejected intent must mint no enrollment code and materialize nothing.
    const rows = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(rows.length, 0);
  });
});

test("owner-agent intent rejects a malformed collection_scope.source_roots entry with a typed 400", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body: rawBody } = await createIntent(rsUrl, ownerToken, {
      collection_scope: { source_roots: ["pdpp", ""] },
      connector_id: "codex",
    });
    const body = rawBody as IntentResponseBody;
    assert.equal(status, 400);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the runtime fixture deliberately exercises an absent or nullable boundary value.
    assert.equal(body?.error?.code, "invalid_request");
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the runtime fixture deliberately exercises an absent or nullable boundary value.
    assert.equal(body?.error?.param, "collection_scope");
  });
});

test("owner-agent initiating Amazon gets browser runtime class plus static-secret proof gate", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    // Amazon must be a registered connector for its manifest (and thus its
    // browser binding) to resolve. An operator with the Amazon connector
    // available is the motivating second-account case.
    const manifest = JSON.parse(
      (await import("node:fs")).readFileSync(
        new URL("../../packages/polyfill-connectors/manifests/amazon.json", import.meta.url),
        "utf8"
      )
    );
    await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const {
      status,
      body: rawBody,
      resp,
    } = await createIntent(rsUrl, ownerToken, {
      connector_id: "https://registry.pdpp.dev/connectors/amazon",
    });
    const body = rawBody as IntentResponseBody;
    assert.equal(status, 201);
    assert.equal(body.connector_key, "amazon");
    assert.equal(body.connector_modality, "browser_bound");
    assert.equal(body.setup_modality, "static_secret");
    assert.equal(body.support_state, "proof_gated");
    assert.equal(body.proof_gate, "static_secret_live_proof_missing");
    assert.equal(body.runbook_path, null);
    assert.equal(body.connection_active, false);
    assert.ok(body.next_step, "response carries a next_step");
    assert.equal(body.next_step.kind, "capture_static_secret");
    assert.equal(body.next_step.capture_endpoint, "/connect/static-secret/amazon");
    assert.equal(body.next_step.runbook_path, undefined);
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(body.next_step.reason ?? "", /static provider secret|static-secret/i);
    // The route must NOT mint browser enrollment material. Amazon's current
    // setup contract captures the owner-provided credential first; the browser
    // runtime remains a collection dependency, not the setup primitive.
    assert.notEqual(body.next_step.kind, "enroll_browser_collector");
    assert.equal(Object.hasOwn(body.next_step, "enrollment_code"), false);

    const audit = findIntentAuditEvent(resp);
    assert.equal(audit.status, "succeeded");
    assert.equal(auditData(audit).connector_key, "amazon");
    assert.equal(auditData(audit).connector_modality, "browser_bound");
    assert.equal(auditData(audit).next_step_kind, "capture_static_secret");
  });
});

// ---- Amazon second-account acceptance (task 5.3) ---------------------------
//
// Task 5.3 asks for proof that a trusted owner agent can "initiate the
// second-account flow up to the owner-mediated next step." The other Amazon test
// above initiates from a clean slate; this one exercises the actual acceptance
// fixture from design.md Decision 2: the owner ALREADY has one configured Amazon
// connection ("the owner personal") and the agent adds a SECOND account ("Shared
// Amazon"). It walks both planes the design names — the owner control listing
// plane (discover the existing account by its distinct `connection_id`) and the
// intent plane (initiate the second account) — and asserts the flow reaches the
// typed owner-mediated browser-assistance stop without faking success or
// silently materializing the second connection.
//
// This is the acceptance-permitted form of 5.3: the browser-collector enrollment
// primitive's live proof is still pending, so the honest second-account outcome
// is a typed `manual_runbook`/`browser_bound` next step describing the owner-run
// static-secret capture step. The response does NOT claim the agent can complete
// provider login/2FA by bearer authority.
test("a trusted owner agent initiates an Amazon SECOND account up to the owner-mediated next step", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadPackageManifest("amazon"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.equal(connectorKey, "amazon");
    assert.ok(connectorKey, "expected a canonical connector key");

    // Precondition: the owner already has ONE configured Amazon account.
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_amazon_personal",
      displayName: "the owner personal",
      sourceBindingKey: "the owner@example.com",
    });

    const ownerToken = await issueOwnerToken(asUrl);

    // --- Discovery plane: the agent lists connections and sees the existing
    // Amazon account by its distinct connection_id + owner-meaningful label, so
    // it knows which account the second one is being added alongside. (Spec:
    // "Owner agent lists Amazon state".)
    const listing = await fetchJson(`${rsUrl}/v1/owner/connections`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(listing.status, 200);
    const listingBody = listing.body as IntentResponseBody;
    assert.ok(listingBody.data, "listing response carries data");
    const amazonRows = listingBody.data.filter((r) => r.connector_key === "amazon");
    assert.equal(amazonRows.length, 1, "exactly one Amazon account exists before the second-account intent");
    // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
    const firstAccount = amazonRows[0];
    assert.ok(firstAccount, "expected the seeded Amazon account row");
    assert.equal(firstAccount.connection_id, "cin_amazon_personal");
    assert.equal(firstAccount.connector_id, "amazon");
    assert.equal(firstAccount.display_name, "the owner personal");
    assert.equal(firstAccount.label_status, "owner_set");

    // --- Intent plane: the agent initiates the SECOND Amazon account, carrying
    // the owner-meaningful label it intends to apply once the account is live.
    const {
      status,
      body: rawBody,
      resp,
    } = await createIntent(rsUrl, ownerToken, {
      connector_id: "https://registry.pdpp.dev/connectors/amazon",
      display_name: "Shared Amazon",
    });
    const body = rawBody as IntentResponseBody;

    // The flow reaches the typed owner-mediated next step: an auditable intent,
    // classified browser_bound, not yet active, with a proof-gated runbook step.
    assert.equal(status, 201);
    assert.equal(body.object, "owner_connection_intent");
    assert.equal(body.connector_key, "amazon");
    assert.equal(body.connector_modality, "browser_bound");
    assert.equal(body.setup_modality, "static_secret");
    assert.equal(body.support_state, "proof_gated");
    assert.equal(body.proof_gate, "static_secret_live_proof_missing");
    assert.equal(body.connection_active, false);
    assert.ok(body.next_step, "response carries a next_step");
    assert.equal(body.next_step.kind, "capture_static_secret");
    assert.equal(body.next_step.capture_endpoint, "/connect/static-secret/amazon");
    assert.equal(body.next_step.runbook_path, undefined);
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(body.next_step.reason ?? "", /static provider secret|static-secret/i);
    // It must NOT claim the agent can complete login/2FA by bearer authority.
    assert.notEqual(body.next_step.kind, "enroll_browser_collector");
    assert.equal(Object.hasOwn(body.next_step, "enrollment_code"), false);
    assert.doesNotMatch(
      body.next_step.reason ?? "",
      // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
      /\b(headless|2fa|two-factor|log in for you|on your behalf without)\b/i,
      "the next step must not claim the agent completes provider login/2FA itself"
    );

    // --- No silent success: the second intent wrote NO connection row. The owner
    // still has exactly the one original Amazon account; the second materializes
    // only when the owner completes the browser-assistance step locally.
    const afterRows = (await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID)).filter(
      (row) => row.connectorId === "amazon"
    );
    assert.equal(afterRows.length, 1, "the second-account intent must not materialize a connection");
    // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
    const afterRow = afterRows[0];
    assert.ok(afterRow, "expected the original Amazon account row to remain");
    assert.equal(afterRow.connectorInstanceId, "cin_amazon_personal");

    // The owner-agent listing still shows exactly one Amazon account, unchanged.
    const afterListing = await fetchJson(`${rsUrl}/v1/owner/connections`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const afterListingBody = afterListing.body as IntentResponseBody;
    assert.ok(afterListingBody.data, "listing response carries data");
    const afterAmazonRows = afterListingBody.data.filter((r) => r.connector_key === "amazon");
    assert.equal(afterAmazonRows.length, 1);
    // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
    const afterAmazonRow = afterAmazonRows[0];
    assert.ok(afterAmazonRow, "expected the unchanged Amazon account row");
    assert.equal(afterAmazonRow.connection_id, "cin_amazon_personal");

    // --- Audit: the second-account initiation is recorded as a non-secret,
    // owner-agent, browser_bound/static-secret event with no bearer/secret leak.
    const audit = findIntentAuditEvent(resp);
    assert.equal(audit.actor_type, "owner_agent");
    assert.equal(audit.subject_id, OWNER_SUBJECT_ID);
    assert.equal(audit.status, "succeeded");
    assert.equal(auditData(audit).actor_kind, "owner_agent");
    assert.equal(auditData(audit).connector_key, "amazon");
    assert.equal(auditData(audit).connector_modality, "browser_bound");
    assert.equal(auditData(audit).next_step_kind, "capture_static_secret");
    assert.equal(auditData(audit).operation, "initiate_connection");
    assert.equal(auditData(audit).display_name_supplied, true);
    // The owner-supplied label is never persisted in audit evidence.
    assert.equal(JSON.stringify(audit).includes("Shared Amazon"), false);
  });
});

test("owner-agent initiating a static-secret API connector gets a non-secret capture step", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    // gmail must be a registered connector for the manifest to resolve.
    const manifest = JSON.parse(
      (await import("node:fs")).readFileSync(
        new URL("../../packages/polyfill-connectors/manifests/gmail.json", import.meta.url),
        "utf8"
      )
    );
    await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const { status, body: rawBody } = await createIntent(rsUrl, ownerToken, { connector_id: "gmail" });
    const body = rawBody as IntentResponseBody;
    assert.equal(status, 201);
    assert.equal(body.connector_key, "gmail");
    assert.equal(body.connector_modality, "api_network");
    assert.equal(body.setup_modality, "static_secret");
    assert.equal(body.support_state, "supported");
    assert.equal(body.proof_gate, null);
    assert.equal(body.runbook_path, null);
    assert.ok(body.deployment_readiness, "response carries deployment_readiness");
    assert.equal(body.deployment_readiness.state, "not_applicable");
    // Gmail has a synchronous credential probe, so the owner-agent/CLI setup
    // projection advertises synchronous validation — without exposing a secret.
    assert.equal(body.validation, "synchronous");
    assert.ok(body.next_step, "response carries a next_step");
    assert.equal(body.next_step.kind, "capture_static_secret");
    assert.equal(body.next_step.capture_endpoint, "/connect/static-secret/gmail");
    assert.equal(body.next_step.runbook_path, undefined);
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(body.next_step.reason ?? "", /static-secret credential capture/i);
    // Honesty: static-secret connectors authenticate with a connector-declared
    // provider secret the owner supplies through an owner-session surface, NOT
    // an OAuth authorization-code flow. The route may point at the
    // owner-session capture page and runbook, but it must not emit the provider
    // secret, an owner cookie, or an OAuth authorization URL.
    assert.doesNotMatch(
      body.next_step.reason ?? "",
      // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
      /add this connection from the dashboard/i,
      "must not point the owner at a dashboard that lists API/network as unsupported"
    );
    assert.equal(body.next_step.authorization_url, undefined);
    assert.equal(body.next_step.enrollment_code, undefined);
    assert.equal(body.enrollment_code, undefined);
    const responseText = JSON.stringify(body);
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.doesNotMatch(responseText, /pdpp_owner_session/i);
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.doesNotMatch(responseText, /"secret"\s*:/i);
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.doesNotMatch(responseText, /super-secret|provider-secret-value|app-password-value/i);
  });
});

test("owner-agent initiating a manual/upload connector gets a non-secret upload step", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    await registerConnector(asUrl, loadPackageManifest("google_maps"));
    const { status, body: rawBody, resp } = await createIntent(rsUrl, ownerToken, { connector_id: "google-maps" });
    const body = rawBody as IntentResponseBody;
    assert.equal(status, 201);
    assert.equal(body.connector_key, "google-maps");
    assert.equal(body.connector_modality, "local_collector");
    assert.equal(body.setup_modality, "manual_or_upload");
    assert.equal(body.support_state, "supported");
    assert.equal(body.proof_gate, null);
    assert.ok(body.next_step, "response carries a next_step");
    assert.equal(body.next_step.kind, "provide_import_file");
    assert.equal(body.next_step.upload_endpoint, "/connect/manual-upload/google-maps");
    assert.equal(body.next_step.enrollment_code, undefined);
    assert.equal(body.next_step.capture_endpoint, undefined);
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.doesNotMatch(JSON.stringify(body), /GOOGLE_MAPS_TIMELINE_DIR|import_dir|pdpp_owner_session/i);

    const audit = findIntentAuditEvent(resp);
    assert.equal(audit.actor_type, "owner_agent");
    assert.equal(auditData(audit).connector_key, "google-maps");
    assert.equal(auditData(audit).connector_modality, "local_collector");
    assert.equal(auditData(audit).next_step_kind, "provide_import_file");
  });
});

test("owner-agent initiating provider authorization returns deployment blockers, not secrets or fake support", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { setup: _setup, ...oauthFixtureManifest } = loadPackageManifest("notion");
    await registerConnector(asUrl, {
      ...oauthFixtureManifest,
      capabilities: {
        auth: {
          deployment_config: ["FITNESS_OAUTH_CLIENT_ID", "FITNESS_OAUTH_CLIENT_SECRET"],
          kind: "oauth",
        },
      },
      connector_id: "fitness_oauth",
      connector_key: "fitness_oauth",
      display_name: "Fitness OAuth",
      manifest_uri: "https://registry.pdpp.dev/connectors/fitness-oauth",
    });
    const { status, body: rawBody } = await createIntent(rsUrl, ownerToken, { connector_id: "fitness_oauth" });
    const body = rawBody as IntentResponseBody;
    assert.equal(status, 201);
    assert.equal(body.connector_key, "fitness_oauth");
    assert.equal(body.connector_modality, "api_network");
    assert.equal(body.setup_modality, "provider_authorization");
    assert.equal(body.support_state, "needs_deployment_config");
    assert.equal(body.proof_gate, "provider_app_deployment_config_missing");
    assert.ok(body.next_step, "response carries a next_step");
    assert.equal(body.next_step.kind, "needs_deployment_config");
    assert.ok(body.deployment_readiness, "response carries deployment_readiness");
    assert.equal(body.deployment_readiness.state, "needs_config");
    assert.ok(body.deployment_readiness.blockers, "deployment_readiness carries blockers");
    assert.deepEqual(
      body.deployment_readiness.blockers.map((item) => item.key),
      ["FITNESS_OAUTH_CLIENT_ID", "FITNESS_OAUTH_CLIENT_SECRET"]
    );
    const serialized = JSON.stringify(body);
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.doesNotMatch(serialized, /Bearer|access_token|refresh_token|owner_session|mcp_package/i);
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.doesNotMatch(serialized, /client-secret-value|cookie-value/i);
  });
});

test("owner-agent initiating Google Maps Data Portability blocks on provider app config", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    await registerConnector(asUrl, loadPackageManifest("google_maps_data_portability"));
    const { status, body: rawBody } = await createIntent(rsUrl, ownerToken, {
      connector_id: "google-maps-data-portability",
    });
    const body = rawBody as IntentResponseBody;
    assert.equal(status, 201);
    assert.equal(body.connector_key, "google-maps-data-portability");
    assert.equal(body.connector_modality, "api_network");
    assert.equal(body.setup_modality, "provider_authorization");
    assert.equal(body.support_state, "needs_deployment_config");
    assert.equal(body.proof_gate, "provider_app_deployment_config_missing");
    assert.ok(body.next_step, "response carries a next_step");
    assert.equal(body.next_step.kind, "needs_deployment_config");
    assert.ok(body.deployment_readiness, "response carries deployment_readiness");
    assert.ok(body.deployment_readiness.blockers, "deployment_readiness carries blockers");
    assert.deepEqual(
      body.deployment_readiness.blockers.map((item) => item.key),
      [
        "GOOGLE_DATAPORTABILITY_CLIENT_ID",
        "GOOGLE_DATAPORTABILITY_CLIENT_SECRET",
        "GOOGLE_DATAPORTABILITY_REDIRECT_URI",
      ]
    );
    const serialized = JSON.stringify(body);
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.doesNotMatch(serialized, /GMAIL_APP_PASSWORD|GOOGLE_APP_PASSWORD|Timeline\\.json|owner_session/i);
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.doesNotMatch(serialized, /access_token|refresh_token|client-secret-value/i);
  });
});

test("owner-agent initiating an unknown connector gets unsupported / unknown modality", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body: rawBody } = await createIntent(rsUrl, ownerToken, {
      connector_id: "definitely-not-a-connector",
    });
    const body = rawBody as IntentResponseBody;
    assert.equal(status, 201);
    assert.equal(body.connector_modality, "unknown");
    assert.equal(body.setup_modality, "unknown");
    assert.equal(body.support_state, "unsupported");
    assert.ok(body.next_step, "response carries a next_step");
    assert.equal(body.next_step.kind, "unsupported");
  });
});

test("owner-agent intent rejects a missing connector_id with a typed 400", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body: rawBody, resp } = await createIntent(rsUrl, ownerToken, {});
    const body = rawBody as IntentResponseBody;
    assert.equal(status, 400);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the runtime fixture deliberately exercises an absent or nullable boundary value.
    assert.equal(body?.error?.code, "invalid_request");
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the runtime fixture deliberately exercises an absent or nullable boundary value.
    assert.equal(body?.error?.param, "connector_id");
    const audit = findIntentAuditEvent(resp);
    assert.equal(audit.status, "failed");
    assert.equal(auditData(audit).actor_kind, "owner_agent");
    assert.equal(auditData(audit).error?.code, "invalid_request");
  });
});

test("owner-agent intent rejects a non-string display_name with a typed 400", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body: rawBody } = await createIntent(rsUrl, ownerToken, {
      connector_id: "codex",
      display_name: 42,
    });
    const body = rawBody as IntentResponseBody;
    assert.equal(status, 400);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the runtime fixture deliberately exercises an absent or nullable boundary value.
    assert.equal(body?.error?.code, "invalid_request");
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the runtime fixture deliberately exercises an absent or nullable boundary value.
    assert.equal(body?.error?.param, "display_name");
  });
});

test("owner-agent intent rejects display_name values over the contract length cap", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body: rawBody } = await createIntent(rsUrl, ownerToken, {
      connector_id: "codex",
      display_name: "x".repeat(201),
    });
    const body = rawBody as IntentResponseBody;
    assert.equal(status, 400);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the runtime fixture deliberately exercises an absent or nullable boundary value.
    assert.equal(body?.error?.code, "invalid_request");
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the runtime fixture deliberately exercises an absent or nullable boundary value.
    assert.equal(body?.error?.param, "display_name");
  });
});

test("owner-agent intent rejects a client grant token with 403 and audits the failure", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    // Register codex so a client grant is well-formed against a real connector.
    const manifest = JSON.parse(
      (await import("node:fs")).readFileSync(
        new URL("../../packages/polyfill-connectors/manifests/codex.json", import.meta.url),
        "utf8"
      )
    );
    await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    await seedInstance({
      connectorId: "codex",
      connectorInstanceId: "cin_codex_client_auth",
      displayName: "Codex auth fixture",
      sourceBindingKey: "the owner@example.com",
    });
    const streamName = manifest.streams?.[0]?.name || "sessions";
    const clientToken = await approveClientGrant(asUrl, manifest.connector_id, streamName, "cin_codex_client_auth");

    const { status, body: rawBody, resp } = await createIntent(rsUrl, clientToken, { connector_id: "codex" });
    const body = rawBody as IntentResponseBody;
    assert.equal(status, 403);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the runtime fixture deliberately exercises an absent or nullable boundary value.
    assert.equal(body?.error?.code, "permission_error");
    const audit = findIntentAuditEvent(resp);
    assert.equal(audit.status, "failed");
    assert.equal(audit.actor_type, "client");
    assert.equal(audit.client_id, "longview");
    assert.equal(auditData(audit).actor_kind, "client");
    assert.equal(auditData(audit).auth_token_kind, "client");
    assert.equal(auditData(audit).error?.code, "permission_error");
  });
});

test("owner-agent intent rejects a request with no bearer (401)", async () => {
  await withServer(async ({ rsUrl }) => {
    const { status, body: rawBody } = await fetchJson(`${rsUrl}/v1/owner/connections/intents`, {
      body: JSON.stringify({ connector_id: "codex" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const body = rawBody as IntentResponseBody;
    assert.equal(status, 401);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the runtime fixture deliberately exercises an absent or nullable boundary value.
    assert.equal(body?.error?.type, "authentication_error");
  });
});

test("/mcp continues to reject owner-agent bearers after connection-intent support lands", async () => {
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
    const body = rawBody as IntentResponseBody;
    assert.equal(status, 403);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the runtime fixture deliberately exercises an absent or nullable boundary value.
    assert.equal(body?.error?.code, "permission_error");
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the runtime fixture deliberately exercises an absent or nullable boundary value.
    assert.match(body?.error?.message ?? "", /owner-agent/i);
  });
});

test("GET /v1/owner/control advertises initiate_connection as supported with the intent route", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body: rawBody } = await fetchJson(`${rsUrl}/v1/owner/control`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const body = rawBody as IntentResponseBody;
    assert.equal(status, 200);
    assert.ok(body.actions, "control document carries actions");
    const initiate = body.actions.find((a) => a.family === "initiate_connection");
    assert.ok(initiate, "control surface should list initiate_connection");
    assert.equal(initiate.status, "supported");
    assert.equal(initiate.method, "POST");
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(initiate.url ?? "", /\/v1\/owner\/connections\/intents$/);
  });
});

test("owner-agent intent contract exposes the setup-plan next-step vocabulary", () => {
  const openapi = JSON.parse(readFileSync(new URL("../openapi/reference-full.openapi.json", import.meta.url), "utf8"));
  const intentResponseSchema =
    openapi.paths?.["/v1/owner/connections/intents"]?.post?.responses?.["201"]?.content?.["application/json"]?.schema;
  assert.ok(intentResponseSchema, "intent route must document a 201 JSON response schema");
  const nextStepEnum = intentResponseSchema.properties?.next_step?.properties?.kind?.enum;
  assert.ok(Array.isArray(nextStepEnum), "next_step.kind must be a closed enum in the contract");
  assert.deepEqual(nextStepEnum, [
    "enroll_local_collector",
    "enroll_browser_collector",
    "capture_static_secret",
    "open_provider_auth",
    "needs_deployment_config",
    "provide_import_file",
    "manual_runbook",
    "unsupported",
  ]);
});
