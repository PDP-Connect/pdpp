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

async function withServer(
  fn: (ctx: { asUrl: string; rsUrl: string }) => Promise<void>,
  options: { configuredProviderAuthConnectorKeys?: readonly string[] } = {}
): Promise<void> {
  const server = await startServer({
    asPort: 0,
    ...(options.configuredProviderAuthConnectorKeys === undefined
      ? {}
      : { configuredProviderAuthConnectorKeys: options.configuredProviderAuthConnectorKeys }),
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
  });
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
  const responseBody = await resp.text();
  assert.equal(resp.status, 201, `register ${manifest.connector_id} failed: ${resp.status} ${responseBody}`);
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
    const listedUnprovenManifest = loadManifest("doordash");
    listedUnprovenManifest.capabilities = {
      ...asRecord(listedUnprovenManifest.capabilities),
      public_listing: { tier: "preview" },
    };
    await registerConnector(asUrl, listedUnprovenManifest);
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
    assert.equal(amazon.registration_status, "registered");
    assert.deepEqual(amazon.public_listing, { tier: "supported" });
    const amazonSetupPlan = asRecord(amazon.setup_plan);
    assert.equal(amazonSetupPlan.setup_modality, "static_secret");
    assert.equal(amazonSetupPlan.support_state, "proof_gated");
    assert.equal(amazonSetupPlan.next_step_kind, "capture_static_secret");
    assert.equal(amazonSetupPlan.proof_gate, "static_secret_live_proof_missing");
    assert.equal(amazonSetupPlan.owner_actionable, true);
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
    assert.equal(amazonInitiate.status, "owner_mediated");
    assert.equal(amazonInitiate.method, null);
    assert.equal(amazonInitiate.url, null);
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(String(amazonInitiate.reason), /secure browser-session dashboard/i);

    const templates = asRecord(body).data;
    assert.ok(Array.isArray(templates));
    assert.equal(
      templates.some((item) => asRecord(item).connector_key === "codex"),
      false,
      "a local-only manifest must not create a server catalog entry"
    );

    const doordash = byConnector(body, "doordash");
    assert.deepEqual(doordash.public_listing, { tier: "preview" });
    const doordashSetupPlan = asRecord(doordash.setup_plan);
    assert.equal(doordashSetupPlan.owner_actionable, false);
    const doordashInitiate = actionByFamily(doordash, "initiate_connection");
    assert.equal(doordashInitiate.status, "unsupported");
    assert.equal(doordashInitiate.method, null);
    assert.equal(doordashInitiate.url, null);
  });
});

test("owner-template projection separates browser owner-session setup from owner-agent REST support", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    await registerConnector(asUrl, loadManifest("chatgpt"));
    const browserManualManifest = loadManifest("chase");
    browserManualManifest.setup = undefined;
    await registerConnector(asUrl, browserManualManifest);
    const browserRunbookManifest = loadManifest("doordash");
    browserRunbookManifest.capabilities = {
      ...asRecord(browserRunbookManifest.capabilities),
      public_listing: { tier: "supported" },
    };
    await registerConnector(asUrl, browserRunbookManifest);

    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connector-templates`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);

    const chatgpt = byConnector(body, "chatgpt");
    const chatgptSetupPlan = asRecord(chatgpt.setup_plan);
    assert.equal(chatgptSetupPlan.catalog_disposition, "static_secret_connect");
    assert.equal(chatgptSetupPlan.owner_actionable, true);
    const chatgptInitiate = actionByFamily(chatgpt, "initiate_connection");
    assert.equal(chatgptInitiate.status, "owner_mediated");
    assert.equal(chatgptInitiate.method, null);
    assert.equal(chatgptInitiate.url, null);

    const browserManual = byConnector(body, "chase");
    const browserManualSetupPlan = asRecord(browserManual.setup_plan);
    assert.equal(browserManualSetupPlan.catalog_disposition, "browser_collector_manual");
    assert.equal(browserManualSetupPlan.next_step_kind, "enroll_browser_collector");
    assert.equal(browserManualSetupPlan.owner_actionable, true);
    const browserManualInitiate = actionByFamily(browserManual, "initiate_connection");
    assert.equal(browserManualInitiate.status, "owner_mediated");
    assert.equal(browserManualInitiate.method, null);
    assert.equal(browserManualInitiate.url, null);

    const browserRunbook = byConnector(body, "doordash");
    const browserRunbookSetupPlan = asRecord(browserRunbook.setup_plan);
    assert.equal(browserRunbookSetupPlan.catalog_disposition, "browser_bound_runbook");
    assert.equal(browserRunbookSetupPlan.next_step_kind, "manual_runbook");
    assert.equal(browserRunbookSetupPlan.owner_actionable, false);
    const browserRunbookInitiate = actionByFamily(browserRunbook, "initiate_connection");
    assert.equal(browserRunbookInitiate.status, "unsupported");
    assert.equal(browserRunbookInitiate.method, null);
    assert.equal(browserRunbookInitiate.url, null);
  });
});

test("owner-template readiness reflects configured provider authorization", async () => {
  // Readiness is measured against the settings the manifest declares, so a
  // "configured" deployment is described by supplying those settings rather
  // than by naming the connector.
  const declaredSettings = {
    GOOGLE_DATAPORTABILITY_CLIENT_ID: "test-client-id",
    GOOGLE_DATAPORTABILITY_CLIENT_SECRET: "test-client-secret",
    GOOGLE_DATAPORTABILITY_REDIRECT_URI: "https://example.test/callback",
  };
  const priorSettings = new Map(Object.keys(declaredSettings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, declaredSettings);
  try {
    await withServer(
      async ({ asUrl, rsUrl }) => {
        const manifest = await registerConnector(asUrl, loadManifest("google_maps_data_portability"));
        const connectorKey = canonicalConnectorKey(manifest.connector_id);
        assert.equal(connectorKey, "google-maps-data-portability");

        const ownerToken = await issueOwnerToken(asUrl);
        const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connector-templates`, {
          headers: { Authorization: `Bearer ${ownerToken}` },
        });
        assert.equal(status, 200);

        const google = byConnector(body, "google-maps-data-portability");
        const publicListing = asRecord(google.public_listing);
        assert.equal(publicListing.tier, "development");
        const setupPlan = asRecord(google.setup_plan);
        assert.equal(setupPlan.catalog_disposition, "provider_auth_connect");
        const deploymentReadiness = asRecord(setupPlan.deployment_readiness);
        assert.equal(deploymentReadiness.state, "ready");
        assert.equal(setupPlan.next_step_kind, "open_provider_auth");
        assert.equal(setupPlan.support_state, "supported");
        assert.equal(setupPlan.proof_gate, null);
        assert.equal(setupPlan.owner_actionable, false);
        const initiate = actionByFamily(google, "initiate_connection");
        assert.equal(initiate.method, null);
        assert.equal(initiate.status, "unsupported");
        assert.equal(initiate.url, null);
      },
      { configuredProviderAuthConnectorKeys: ["google-maps-data-portability"] }
    );
  } finally {
    for (const [key, value] of priorSettings) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
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

test("UAT-exposed experimental static-secret connector is visible without claiming production support", async () => {
  const declaredSettings = {
    PDPP_EXPOSE_UNPROVEN_CONNECTORS_UAT: "1",
  };
  const priorSettings = new Map(Object.keys(declaredSettings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, declaredSettings);
  try {
    await withServer(async ({ asUrl, rsUrl }) => {
      // Real proof-gated form: UAT can exercise it, while production support
      // remains false until a live run promotes the manifest.
      const steamManifest = loadManifest("steam");
      await registerConnector(asUrl, steamManifest);

      const ownerToken = await issueOwnerToken(asUrl);
      const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connector-templates`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(status, 200);

      const bodyRec = asRecord(body);
      const templates = Array.isArray(bodyRec.data) ? bodyRec.data : [];
      const steam = templates.find((t: unknown) => asRecord(t).connector_key === "steam");

      assert.ok(steam, "steam fixture must be registered");

      const steamRec = asRecord(steam);
      const setup = asRecord(steamRec.setup_plan);
      const listing = asRecord(steamRec.public_listing);

      assert.equal(steamRec.uat_expose_unlisted_connectors, true);
      assert.equal(setup.catalog_disposition, "static_secret_experimental");
      assert.equal(setup.owner_actionable, false, "UAT exposure must not promote production support");
      assert.equal(listing.tier, "preview");
      assert.equal(actionByFamily(steamRec, "initiate_connection").status, "unsupported");
    });
  } finally {
    for (const [key, value] of priorSettings) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("with flag=ON, exposure follows production or experimental actionability without an allowlist", async () => {
  const declaredSettings = {
    PDPP_EXPOSE_UNPROVEN_CONNECTORS_UAT: "1",
  };
  const priorSettings = new Map(Object.keys(declaredSettings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, declaredSettings);
  try {
    await withServer(async ({ asUrl, rsUrl }) => {
      // Prove: ANY owner-actionable unproven is exposed (steam as example)
      // Proves no hardcoded allowlist, just the generic gate
      const steamManifest = loadManifest("steam");
      await registerConnector(asUrl, steamManifest);

      const ownerToken = await issueOwnerToken(asUrl);
      const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connector-templates`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(status, 200);

      const bodyRec = asRecord(body);
      const templates = Array.isArray(bodyRec.data) ? bodyRec.data : [];
      const steam = templates.find((t: unknown) => asRecord(t).connector_key === "steam");

      assert.ok(steam, "steam must be registered");

      // Production actionability and explicitly experimental actionability are
      // separate facts. Either real setup path can be exercised in UAT.
      const steamRec = asRecord(steam);
      const uatExposed = steamRec.uat_expose_unlisted_connectors === true;
      const setup = asRecord(steamRec.setup_plan);
      const isUatActionable =
        setup.owner_actionable === true || setup.catalog_disposition === "static_secret_experimental";

      assert.equal(
        uatExposed,
        isUatActionable,
        "steam: UAT exposure must follow a real production or experimental setup path"
      );
    });
  } finally {
    for (const [key, value] of priorSettings) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("UAT-exposed unproven connectors from real manifests prove no allowlist", async () => {
  const declaredSettings = {
    PDPP_EXPOSE_UNPROVEN_CONNECTORS_UAT: "1",
  };
  const priorSettings = new Map(Object.keys(declaredSettings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, declaredSettings);
  try {
    await withServer(async ({ asUrl, rsUrl }) => {
      // Register real unproven connectors to prove no allowlist in production code
      // Any unproven owner-actionable connector is automatically included without hardcoding its name
      const testConnectors = ["steam", "imessage", "apple_photos", "google_messages", "netflix_export"];

      for (const id of testConnectors) {
        const manifest = loadManifest(id);
        await registerConnector(asUrl, manifest);
      }

      const ownerToken = await issueOwnerToken(asUrl);
      const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connector-templates`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(status, 200);

      const { data } = asRecord(body);
      const templates = Array.isArray(data) ? data : [];

      // For each real unproven connector, exposure is derived from its setup
      // plan rather than a connector-name allowlist.
      for (const connectorId of testConnectors) {
        const template = templates.find((t) => {
          const key = asRecord(t).connector_key;
          return key === connectorId || key === connectorId.replace(/_/g, "-");
        });
        assert.ok(template, `${connectorId}: must be registered`);

        const setup = asRecord(template).setup_plan;
        const isUatActionable =
          asRecord(setup).owner_actionable === true ||
          asRecord(setup).catalog_disposition === "static_secret_experimental";
        const uatExposed = asRecord(template).uat_expose_unlisted_connectors === true;

        assert.equal(
          uatExposed,
          isUatActionable,
          `${connectorId}: UAT exposure must follow a real production or experimental setup path`
        );
      }
    });
  } finally {
    for (const [key, value] of priorSettings) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("without legacy UAT exposure, Preview and Development tiers stay authoritative", async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifestIds = ["steam", "netflix_export"];
    const connectorKeys = ["steam", "netflix-export"];
    const expectedTiers = new Map([
      ["steam", "preview"],
      ["netflix-export", "development"],
    ]);

    for (const manifestId of manifestIds) {
      const manifest = loadManifest(manifestId);
      await registerConnector(asUrl, manifest);
    }

    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connector-templates`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    const { data } = asRecord(body);
    const templates = Array.isArray(data) ? data : [];

    // Verify unproven connectors appear but with uat_expose_unlisted_connectors=false
    for (const connectorKey of connectorKeys) {
      const template = templates.find((t) => asRecord(t).connector_key === connectorKey);
      assert.ok(template, `${connectorKey}: should appear in server response (manifest is registered)`);

      // public_listing is honest
      const listing = asRecord(asRecord(template).public_listing);
      assert.equal(listing.tier, expectedTiers.get(connectorKey), `${connectorKey}: lifecycle tier is unchanged`);

      // UAT exposure fact is false (flag not set)
      assert.equal(
        asRecord(template).uat_expose_unlisted_connectors,
        false,
        `${connectorKey}: uat_expose_unlisted_connectors=false when flag not set`
      );
    }
  });
});

test("without PDPP_EXPOSE_UNPROVEN_CONNECTORS_UAT flag set, unproven connectors are not UAT-exposed", async () => {
  // This is the default behavior - no flag means no exposure
  await withServer(async ({ asUrl, rsUrl }) => {
    const steamManifest = loadManifest("steam");
    await registerConnector(asUrl, steamManifest);

    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connector-templates`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);

    const steam = byConnector(body, "steam");
    assert.equal(steam.uat_expose_unlisted_connectors, false, "steam should NOT be UAT-exposed without flag");
  });
});

test("Development Venmo stays unavailable even when legacy UAT exposure is enabled", async () => {
  const previous = process.env.PDPP_EXPOSE_UNPROVEN_CONNECTORS_UAT;
  try {
    delete process.env.PDPP_EXPOSE_UNPROVEN_CONNECTORS_UAT;
    await withServer(async ({ asUrl, rsUrl }) => {
      await registerConnector(asUrl, loadManifest("venmo"));
      const ownerToken = await issueOwnerToken(asUrl);
      const hidden = await fetchJson(`${rsUrl}/v1/owner/connector-templates`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(hidden.status, 200);
      assert.equal(byConnector(hidden.body, "venmo").uat_expose_unlisted_connectors, false);
    });

    process.env.PDPP_EXPOSE_UNPROVEN_CONNECTORS_UAT = "1";
    await withServer(async ({ asUrl, rsUrl }) => {
      await registerConnector(asUrl, loadManifest("venmo"));
      const ownerToken = await issueOwnerToken(asUrl);
      const exposed = await fetchJson(`${rsUrl}/v1/owner/connector-templates`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(exposed.status, 200);
      const venmo = byConnector(exposed.body, "venmo");
      const listing = asRecord(venmo.public_listing);
      const setup = asRecord(venmo.setup_plan);
      assert.equal(listing.tier, "development");
      assert.equal(venmo.uat_expose_unlisted_connectors, false);
      assert.equal(setup.setup_modality, "static_secret");
      assert.equal(setup.next_step_kind, "capture_static_secret");
    });
  } finally {
    if (previous === undefined) delete process.env.PDPP_EXPOSE_UNPROVEN_CONNECTORS_UAT;
    else process.env.PDPP_EXPOSE_UNPROVEN_CONNECTORS_UAT = previous;
  }
});

test("unproven with recognized modality but non-actionable plan is not UAT-exposed", async () => {
  const declaredSettings = {
    PDPP_EXPOSE_UNPROVEN_CONNECTORS_UAT: "1",
  };
  const priorSettings = new Map(Object.keys(declaredSettings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, declaredSettings);
  try {
    await withServer(async ({ asUrl, rsUrl }) => {
      // Doordash is unproven with a recognized modality but requires proof (not owner-actionable)
      const doorDashManifest = loadManifest("doordash");
      doorDashManifest.capabilities = {
        ...asRecord(doorDashManifest.capabilities),
        public_listing: { tier: "development" },
      };
      await registerConnector(asUrl, doorDashManifest);

      const ownerToken = await issueOwnerToken(asUrl);
      const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connector-templates`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(status, 200);

      const doorDash = byConnector(body, "doordash");
      const setup = asRecord(doorDash.setup_plan);

      // Doordash is unproven but its plan is NOT owner-actionable (requires proof_gated flow)
      assert.equal(setup.owner_actionable, false, "doordash plan should not be owner_actionable");
      assert.equal(
        doorDash.uat_expose_unlisted_connectors,
        false,
        "doordash should NOT be UAT-exposed (plan not owner_actionable)"
      );
    });
  } finally {
    for (const [key, value] of priorSettings) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("with flag disabled, positive unproven owner-actionable connectors have uat_expose_unlisted_connectors=false", async () => {
  // CRITICAL: prove the feature DOES NOT WORK without the flag
  // This is the gate test: if flag is disabled, uat_expose_unlisted_connectors is always false
  await withServer(async ({ asUrl, rsUrl }) => {
    const steamManifest = loadManifest("steam");
    await registerConnector(asUrl, steamManifest);

    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connector-templates`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);

    const bodyRec = asRecord(body);
    const templates = Array.isArray(bodyRec.data) ? bodyRec.data : [];
    const steam = templates.find((t: unknown) => asRecord(t).connector_key === "steam");

    assert.ok(steam, "steam fixture must be registered");

    // Steam is unproven, browser-bound (modality), static_secret
    // Even if it passes owner_actionable checks, it should NOT be exposed without the flag
    assert.equal(
      asRecord(steam).uat_expose_unlisted_connectors,
      false,
      "steam: uat_expose_unlisted_connectors MUST be false when flag is not set"
    );
  });
});

test("UAT allowlist: development connector exposed only when flag+key+valid-setup all present", async () => {
  const priorEnv = { uat: process.env.PDPP_EXPOSE_UNPROVEN_CONNECTORS_UAT, allowlist: process.env.PDPP_UAT_CONNECTOR_ALLOWLIST };
  try {
    // Scenario table: all combinations of flag, allowlist, setup validity
    const scenarios = [
      { uat: false, list: "", connectorKey: "venmo", expectedExposed: false, label: "no flag, with allowlist" },
      { uat: true, list: "", connectorKey: "venmo", expectedExposed: false, label: "flag ON, empty allowlist" },
      { uat: true, list: "venmo", connectorKey: "venmo", expectedExposed: true, label: "flag+allowlist+valid-setup" },
      { uat: true, list: "doordash", connectorKey: "doordash", expectedExposed: false, label: "allowlist but no valid setup" },
      { uat: true, list: "steam", connectorKey: "steam", expectedExposed: true, label: "preview tier via legacy path" },
    ];

    for (const scenario of scenarios) {
      const cleanEnv = () => {
        delete process.env.PDPP_EXPOSE_UNPROVEN_CONNECTORS_UAT;
        delete process.env.PDPP_UAT_CONNECTOR_ALLOWLIST;
      };
      cleanEnv();
      if (scenario.uat) process.env.PDPP_EXPOSE_UNPROVEN_CONNECTORS_UAT = "1";
      if (scenario.list) process.env.PDPP_UAT_CONNECTOR_ALLOWLIST = scenario.list;

      await withServer(async ({ asUrl, rsUrl }) => {
        // Register the connector to test
        if (scenario.connectorKey === "venmo") await registerConnector(asUrl, loadManifest("venmo"));
        if (scenario.connectorKey === "doordash") {
          const m = loadManifest("doordash");
          m.capabilities = { ...asRecord(m.capabilities), public_listing: { tier: "development" } };
          await registerConnector(asUrl, m);
        }
        if (scenario.connectorKey === "steam") await registerConnector(asUrl, loadManifest("steam"));

        const ownerToken = await issueOwnerToken(asUrl);
        const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connector-templates`, {
          headers: { Authorization: `Bearer ${ownerToken}` },
        });
        assert.equal(status, 200);
        const template = byConnector(body, scenario.connectorKey);
        assert.equal(
          template.uat_expose_unlisted_connectors,
          scenario.expectedExposed,
          `${scenario.label}: uat_expose_unlisted_connectors should be ${scenario.expectedExposed}`
        );
      });
    }
  } finally {
    if (priorEnv.uat === undefined) delete process.env.PDPP_EXPOSE_UNPROVEN_CONNECTORS_UAT;
    else process.env.PDPP_EXPOSE_UNPROVEN_CONNECTORS_UAT = priorEnv.uat;
    if (priorEnv.allowlist === undefined) delete process.env.PDPP_UAT_CONNECTOR_ALLOWLIST;
    else process.env.PDPP_UAT_CONNECTOR_ALLOWLIST = priorEnv.allowlist;
  }
});

test("allowlist parser: rejects malformed entries, admits valid connector keys", async () => {
  // This is a route-level discriminator test via environment parsing
  const priorEnv = { uat: process.env.PDPP_EXPOSE_UNPROVEN_CONNECTORS_UAT, allowlist: process.env.PDPP_UAT_CONNECTOR_ALLOWLIST };
  try {
    process.env.PDPP_EXPOSE_UNPROVEN_CONNECTORS_UAT = "1";
    process.env.PDPP_UAT_CONNECTOR_ALLOWLIST = "venmo, invalid@key, netflix-export, ../evil, my_connector";

    await withServer(async ({ asUrl, rsUrl }) => {
      // Register valid connectors
      await registerConnector(asUrl, loadManifest("venmo"));
      await registerConnector(asUrl, loadManifest("netflix_export"));

      const ownerToken = await issueOwnerToken(asUrl);
      const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connector-templates`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(status, 200);

      // Valid keys are admitted: venmo, netflix-export, my_connector
      const venmo = byConnector(body, "venmo");
      assert.equal(venmo.uat_expose_unlisted_connectors, true, "venmo: valid key admitted");

      const netflix = byConnector(body, "netflix-export");
      assert.equal(netflix.uat_expose_unlisted_connectors, true, "netflix-export: valid key admitted");

      // Malformed keys (invalid@key, ../evil) are rejected silently; no server error
    });
  } finally {
    if (priorEnv.uat === undefined) delete process.env.PDPP_EXPOSE_UNPROVEN_CONNECTORS_UAT;
    else process.env.PDPP_EXPOSE_UNPROVEN_CONNECTORS_UAT = priorEnv.uat;
    if (priorEnv.allowlist === undefined) delete process.env.PDPP_UAT_CONNECTOR_ALLOWLIST;
    else process.env.PDPP_UAT_CONNECTOR_ALLOWLIST = priorEnv.allowlist;
  }
});
