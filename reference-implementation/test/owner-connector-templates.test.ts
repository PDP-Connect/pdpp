// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration suite for the bearer-authed owner-agent connector-template
 * listing `GET /v1/owner/connector-templates`.
 *
 * This is the template half of the owner-agent control shape: agents can see
 * connector types separately from configured connection instances and can tell
 * whether adding a new connection is supported, owner-mediated, or currently
 * unsupported before probing an action.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalConnectorKey } from "../server/connector-key.ts";
import { startServer } from "../server/index.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const OWNER_SUBJECT_ID = "owner_local";
const NOW = "2026-06-01T00:00:00.000Z";

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

async function approveClientGrant(
  asUrl: string,
  sourceId: string,
  streamName: string,
  instanceId: string
): Promise<string> {
  const par = asRecord(
    (
      await fetchJson(`${asUrl}/oauth/par`, {
        body: JSON.stringify({
          authorization_details: [
            {
              access_mode: "continuous",
              purpose_code: "https://pdpp.dev/purpose/analytics",
              purpose_description: "owner-connector-template boundary test",
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
    ).body
  );
  assert.ok(par.request_uri);
  const review = asRecord(
    (
      await fetchJson(`${asUrl}/consent/review`, {
        body: JSON.stringify({ request_uri: par.request_uri, subject_id: OWNER_SUBJECT_ID }),
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        method: "POST",
      })
    ).body
  );
  assert.ok(review.approval_review);
  assert.ok(review.approval_review_revision);
  assert.equal(review.request_uri, par.request_uri);
  const approved = asRecord(
    (
      await fetchJson(`${asUrl}/consent/approve`, {
        body: JSON.stringify({
          approval_review_revision: review.approval_review_revision,
          request_uri: review.request_uri,
        }),
        headers: { Accept: "application/json", "Content-Type": "application/json" },
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
  sourceBindingKey: string;
}

async function seedInstance({
  connectorInstanceId,
  connectorId,
  displayName,
  sourceBindingKey,
}: SeedInstanceInput): Promise<void> {
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

function byConnector(body: unknown, connectorKey: string): Record<string, unknown> {
  const { data } = asRecord(body);
  const row = Array.isArray(data) ? data.find((item) => asRecord(item).connector_key === connectorKey) : undefined;
  assert.ok(row, `expected connector template ${connectorKey}`);
  return asRecord(row);
}

function actionByFamily(row: Record<string, unknown>, family: string): Record<string, unknown> {
  const actions = row.supported_actions;
  const action = Array.isArray(actions) ? actions.find((item) => asRecord(item).family === family) : undefined;
  assert.ok(action, `expected supported_actions.${family}`);
  return asRecord(action);
}

test("owner-agent bearer lists connector templates with related connection summaries", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const amazonManifest = await registerConnector(asUrl, loadManifest("amazon"));
    const amazonKey = canonicalConnectorKey(amazonManifest.connector_id);
    assert.ok(amazonKey, "amazon manifest must resolve a canonical connector key");
    await seedInstance({
      connectorId: amazonKey,
      connectorInstanceId: "cin_amazon_personal",
      displayName: "the owner personal",
      sourceBindingKey: "the owner@example.com",
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connector-templates`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    assert.equal(status, 200);
    assert.equal(asRecord(body).object, "list");

    const amazon = byConnector(body, "amazon");
    assert.equal(amazon.object, "owner_connector_template");
    assert.equal(amazon.connector_id, "amazon");
    assert.equal(amazon.display_name, "Amazon");
    assert.equal(amazon.connector_modality, "browser_bound");
    const amazonSetupPlan = asRecord(amazon.setup_plan);
    assert.equal(amazonSetupPlan.setup_modality, "static_secret");
    assert.equal(amazonSetupPlan.support_state, "proof_gated");
    assert.equal(amazonSetupPlan.next_step_kind, "capture_static_secret");
    assert.equal(amazonSetupPlan.proof_gate, "static_secret_live_proof_missing");
    assert.equal(amazonSetupPlan.runbook_path, null);
    assert.equal(amazon.connection_count, 1);
    const amazonConnections = amazon.connections;
    assert.ok(Array.isArray(amazonConnections));
    const amazonConnection = asRecord(amazonConnections[0]);
    assert.equal(amazonConnection.object, "owner_connection_summary");
    assert.equal(amazonConnection.connection_id, "cin_amazon_personal");
    assert.equal(amazonConnection.connector_key, "amazon");
    assert.equal(amazonConnection.display_name, "the owner personal");
    assert.equal(amazonConnection.label_status, "owner_set");

    const amazonInitiate = actionByFamily(amazon, "initiate_connection");
    assert.equal(amazonInitiate.status, "unsupported");
    assert.equal(amazonInitiate.method, null);
    assert.equal(amazonInitiate.url, null);
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(String(amazonInitiate.reason), /static provider secret|static-secret/i);

    // Local-collector templates are discoverable even before a connection is
    // registered, because they live in the reference local-collector catalog.
    const codex = byConnector(body, "codex");
    assert.equal(codex.connector_modality, "local_collector");
    const codexSetupPlan = asRecord(codex.setup_plan);
    assert.equal(codexSetupPlan.support_state, "supported");
    assert.equal(codexSetupPlan.next_step_kind, "enroll_local_collector");
    assert.equal(codex.connection_count, 0);
    const codexInitiate = actionByFamily(codex, "initiate_connection");
    assert.equal(codexInitiate.status, "supported");
    assert.equal(codexInitiate.method, "POST");
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(String(codexInitiate.url), /\/v1\/owner\/connections\/intents$/);
  });
});

test("GET /v1/owner/control advertises list_connector_templates with the template route", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/control`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    const { actions } = asRecord(body);
    const listTemplates = Array.isArray(actions)
      ? actions.find((action) => asRecord(action).family === "list_connector_templates")
      : undefined;
    assert.ok(listTemplates, "control surface should list list_connector_templates");
    const listTemplatesRecord = asRecord(listTemplates);
    assert.equal(listTemplatesRecord.status, "supported");
    assert.equal(listTemplatesRecord.method, "GET");
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(String(listTemplatesRecord.url), /\/v1\/owner\/connector-templates$/);
  });
});

test("client grant bearer cannot list owner connector templates", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest("spotify"));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorKey, "spotify manifest must resolve a canonical connector key");
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_spotify_template_auth",
      displayName: "Spotify auth fixture",
      sourceBindingKey: "the owner@example.com",
    });
    const clientToken = await approveClientGrant(
      asUrl,
      String(manifest.connector_id),
      "saved_tracks",
      "cin_spotify_template_auth"
    );
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connector-templates`, {
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    assert.equal(status, 403);
    assert.equal(asRecord(asRecord(body).error).code, "permission_error");
  });
});
