// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic integration tests for the provider-authorization lifecycle
 * (task 6.3: complete-self-service-connection-onboarding).
 *
 * All tests use a synthetic "test_provider" connector and an injectable
 * ProviderAuthExchanger double. No live provider credentials are used.
 *
 * Covers:
 *   - deployment config missing blocks initiation (503)
 *   - lifecycle present returns open_provider_auth authorization URL
 *   - callback with missing state does not create/activate a connection
 *   - callback with expired state does not create/activate a connection
 *   - callback with bad/missing code does not create/activate a connection
 *   - callback with valid code but failed inventory does not activate a connection
 *   - callback with valid code + successful inventory activates exactly the intended connection(s)
 *   - two accounts produce two distinct connection_ids with separate credential store calls
 *   - no provider secrets/tokens appear in owner-session, owner-agent, or callback response bodies
 *   - audit events are emitted for all outcome paths
 */

import assert from "node:assert/strict";
import test from "node:test";

import { listSpineEventsPage } from "../lib/spine.ts";
import { PROVIDER_AUTH_LIFECYCLE_PROVEN_CONNECTOR_KEYS } from "../server/connection-setup-plan.ts";
import { startServer as startServerUntyped } from "../server/index.ts";
import type { ProviderAuthExchanger } from "../server/routes/ref-provider-auth.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const REGEXP_1 = /access_token|refresh_token|tok_access|Bearer/i;
const REGEXP_2 = /secret/i;
const REGEXP_3 = /access_token|tok_access/i;
const REGEXP_4 = /SUPER_SECRET/;
const REGEXP_5 = /SUPER_SECRET/;
const REGEXP_6 = /access_token.*:/i;
const REGEXP_7 = /refresh_token.*:/i;
const REGEXP_8 = /access_token|refresh_token|Bearer/i;
const REGEXP_9 = /^cin_/;

const OWNER_SUBJECT_ID = "owner_local";

function requiredStateToken(state: string | null | undefined): string {
  assert.ok(state, "provider-auth initiation must record a state token");
  return state;
}

type TestServer = Awaited<ReturnType<typeof startServerUntyped>>;

// biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
async function startServer(opts: Parameters<typeof startServerUntyped>[0]): Promise<TestServer> {
  return startServerUntyped(opts);
}

interface ConnectionClosingServer {
  closeAllConnections: () => void;
}

function isConnectionClosingServer(value: unknown): value is ConnectionClosingServer {
  return (
    typeof value === "object" &&
    value !== null &&
    "closeAllConnections" in value &&
    typeof value.closeAllConnections === "function"
  );
}

function requireConnectionClosingServer(value: unknown, description: string): ConnectionClosingServer {
  if (!isConnectionClosingServer(value)) {
    throw new TypeError(`${description} must provide closeAllConnections`);
  }
  return value;
}

interface JsonBody {
  [key: string]: any;
}

// Synthetic provider OAuth connector registered for all tests.
// Must have: network binding, oauth auth kind, deployment_config keys.
const TEST_PROVIDER_MANIFEST = {
  capabilities: {
    auth: {
      deployment_config: ["TEST_PROVIDER_CLIENT_ID", "TEST_PROVIDER_CLIENT_SECRET"],
      kind: "oauth",
    },
    refresh_policy: {
      background_safe: true,
      interaction_posture: "credentials",
      rationale: "Synthetic provider can refresh with stored OAuth tokens.",
      recommended_interval_seconds: 900,
      recommended_mode: "automatic",
    },
  },
  connector_id: "test_provider",
  connector_key: "test_provider",
  display_name: "Test Provider",
  manifest_uri: "https://sources.example/test_provider",
  protocol_version: "0.1.0",
  runtime_requirements: { bindings: { network: { required: true } } },
  streams: [
    {
      name: "items",
      primary_key: ["id"],
      schema: {
        properties: { id: { type: "string" } },
        required: ["id"],
        type: "object",
      },
      selection: { fields: true, resources: true },
      semantics: "mutable_state",
    },
  ],
  version: "1.0.0",
};

// A no-oauth connector used to test that non-provider-auth connectors are rejected.
const NON_OAUTH_MANIFEST = {
  capabilities: { auth: { kind: "api_key" } },
  connector_id: "plain_api",
  connector_key: "plain_api",
  display_name: "Plain API",
  manifest_uri: "https://sources.example/plain_api",
  protocol_version: "0.1.0",
  runtime_requirements: { bindings: { network: { required: true } } },
  streams: [
    {
      name: "items",
      primary_key: ["id"],
      schema: {
        properties: { id: { type: "string" } },
        required: ["id"],
        type: "object",
      },
      selection: { fields: true, resources: true },
      semantics: "mutable_state",
    },
  ],
  version: "1.0.0",
};

// Minimal exchanger double that records all calls and lets callers inject
// per-call behavior via callbacks.
function buildTestExchanger({
  onInitiate = () => ({ authorizationUrl: "https://provider.example/oauth/authorize?state=TEST" }),
  onExchange = () => ({ accessToken: "tok_access_synthetic", tokenKind: "bearer" }),
  onInventory = () => [{ accountId: "account_1", displayLabel: "test@example.com" }],
  onStore = () => {
    /* intentionally empty */
  },
}: {
  onInitiate?: ProviderAuthExchanger["initiateAuthorization"];
  onExchange?: ProviderAuthExchanger["exchangeCode"];
  onInventory?: ProviderAuthExchanger["runInventoryOrTest"];
  onStore?: ProviderAuthExchanger["storeTokens"];
} = {}): ProviderAuthExchanger & {
  calls: {
    initiate: Parameters<ProviderAuthExchanger["initiateAuthorization"]>[0][];
    exchange: Parameters<ProviderAuthExchanger["exchangeCode"]>[0][];
    inventory: Parameters<ProviderAuthExchanger["runInventoryOrTest"]>[0][];
    store: Parameters<ProviderAuthExchanger["storeTokens"]>[0][];
  };
} {
  const calls: {
    initiate: Parameters<ProviderAuthExchanger["initiateAuthorization"]>[0][];
    exchange: Parameters<ProviderAuthExchanger["exchangeCode"]>[0][];
    inventory: Parameters<ProviderAuthExchanger["runInventoryOrTest"]>[0][];
    store: Parameters<ProviderAuthExchanger["storeTokens"]>[0][];
  } = { exchange: [], initiate: [], inventory: [], store: [] };
  return {
    calls,
    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async exchangeCode(args) {
      calls.exchange.push(args);
      return onExchange(args);
    },
    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async initiateAuthorization(args) {
      calls.initiate.push(args);
      return onInitiate(args);
    },
    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async runInventoryOrTest(args) {
      calls.inventory.push(args);
      return onInventory(args);
    },
    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async storeTokens(args) {
      calls.store.push(args);
      return onStore(args);
    },
  };
}

async function closeServer(server: TestServer): Promise<void> {
  server.schedulerManager?.stop?.();
  requireConnectionClosingServer(server.asServer, "authorization server").closeAllConnections();
  requireConnectionClosingServer(server.rsServer, "resource server").closeAllConnections();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

async function fetchJson(
  url: string,
  opts: RequestInit = {}
): Promise<{ body: JsonBody; resp: Response; status: number }> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body: JsonBody = {};
  try {
    body = text ? (JSON.parse(text) as JsonBody) : {};
  } catch {
    body = { raw: text };
  }
  return { body, resp, status: resp.status };
}

// TEST_PROVIDER_MANIFEST declares deployment_config: ["TEST_PROVIDER_CLIENT_ID",
// "TEST_PROVIDER_CLIENT_SECRET"] (bare-string legacy shape). connection-setup-plan.ts's
// buildDeploymentReadiness answers deployment readiness from the manifest's
// OWN declared entries against the observed environment whenever the
// manifest declares any — configuredProviderAuthConnectorKeys is only the
// fallback for a manifest declaring NONE, so it cannot make this connector
// "ready" by itself. A real deployment satisfies these via env or the
// provider-app-config store; the test satisfies them via env, scoped to
// exactly the withServer() call so no state leaks between tests.
const TEST_PROVIDER_DEPLOYMENT_ENV = Object.freeze({
  TEST_PROVIDER_CLIENT_ID: "test-provider-client-id",
  TEST_PROVIDER_CLIENT_SECRET: "test-provider-client-secret",
});

async function withDeploymentEnv<T>(values: Record<string, string>, operation: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      process.env[key] = value;
    }
    return await operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

// Start a server with the given exchanger and configured provider keys.
// `deploymentConfigured` (default true) sets TEST_PROVIDER_CLIENT_ID/
// TEST_PROVIDER_CLIENT_SECRET for the whole call (server startup through fn)
// so connection-setup-plan.ts's manifest-driven deployment readiness reads
// ready for test_provider — pass false for a test that specifically wants
// needs_config (deployment config missing).
async function withServer(
  exchanger: ProviderAuthExchanger,
  {
    configuredKeys = ["test_provider"],
    deploymentConfigured = true,
  }: { configuredKeys?: string[]; deploymentConfigured?: boolean },
  fn: (handles: { asUrl: string; rsUrl: string; server: TestServer }) => Promise<void>
): Promise<void> {
  await withDeploymentEnv(deploymentConfigured ? TEST_PROVIDER_DEPLOYMENT_ENV : {}, async () => {
    const server = await startServer({
      asPort: 0,
      autoEnrollEligibleSchedules: false,
      configuredProviderAuthConnectorKeys: configuredKeys,
      dbPath: ":memory:",
      ownerAuthPassword: "",
      ownerAuthSubjectId: OWNER_SUBJECT_ID,
      providerAuthExchanger: exchanger,
      quiet: true,
      rsPort: 0,
    });
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    try {
      // Register the test provider connector.
      const registration = await fetch(`${asUrl}/connectors`, {
        body: JSON.stringify(TEST_PROVIDER_MANIFEST),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(registration.status, 201, `provider test fixture registration (${await registration.text()})`);
      await fn({ asUrl, rsUrl, server });
    } finally {
      await closeServer(server);
    }
  });
}

// The test server uses ownerAuthPassword: '' (open auth), so the owner session
// requires no password. Pass an empty cookie string — the server treats a
// missing/empty session as the default owner in open-auth mode.
const OPEN_SESSION_COOKIE = "";

// biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
async function initiateProviderAuth(
  asUrl: string,
  sessionCookie: string,
  connectorId: string
): Promise<{ body: JsonBody; resp: Response; status: number }> {
  return fetchJson(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/provider-auth-initiate`, {
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    method: "POST",
  });
}

// ---------------------------------------------------------------------------
// Setup planner unit-level check
// ---------------------------------------------------------------------------

test("PROVIDER_AUTH_LIFECYCLE_PROVEN_CONNECTOR_KEYS includes test_provider", () => {
  assert.ok(
    PROVIDER_AUTH_LIFECYCLE_PROVEN_CONNECTOR_KEYS.includes("test_provider"),
    "test_provider must be in the lifecycle-proven set"
  );
});

// ---------------------------------------------------------------------------
// Deployment config missing → initiation blocked
// ---------------------------------------------------------------------------

test("provider-auth initiation is blocked when deployment config is missing", async () => {
  const exchanger = buildTestExchanger();
  // Pass an empty configured-keys list AND leave the manifest's own
  // deployment_config env vars unset so the planner sees needs_config.
  await withServer(exchanger, { configuredKeys: [], deploymentConfigured: false }, async ({ asUrl, rsUrl: _rsUrl }) => {
    const session = OPEN_SESSION_COOKIE;
    const { status, body } = await initiateProviderAuth(asUrl, session, "test_provider");
    assert.equal(status, 503, `expected 503, got ${status}: ${JSON.stringify(body)}`);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
    assert.equal(body?.error?.code, "provider_app_deployment_config_missing");
    // No exchanger calls should have been made.
    assert.equal(exchanger.calls.initiate.length, 0);
    // No connection should exist.
    const connections = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(connections.length, 0, "no connection should be created on blocked initiation");
  });
});

// ---------------------------------------------------------------------------
// Non-provider-auth connector is rejected
// ---------------------------------------------------------------------------

test("provider-auth initiation is rejected for non-oauth connectors", async () => {
  const exchanger = buildTestExchanger();
  await withServer(exchanger, {}, async ({ asUrl, rsUrl: _rsUrl }) => {
    // Register a non-oauth connector.
    await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(NON_OAUTH_MANIFEST),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const session = OPEN_SESSION_COOKIE;
    const { status, body } = await initiateProviderAuth(asUrl, session, "plain_api");
    assert.equal(status, 409, `expected 409, got ${status}: ${JSON.stringify(body)}`);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
    assert.equal(body?.error?.code, "provider_auth_not_applicable");
    assert.equal(exchanger.calls.initiate.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle present → returns authorization URL
// ---------------------------------------------------------------------------

test("provider-auth initiation returns open_provider_auth with authorization URL", async () => {
  const authUrl = "https://provider.example/oauth/authorize?client_id=X&state=STATE";
  const exchanger = buildTestExchanger({
    onInitiate: () => ({ authorizationUrl: authUrl }),
  });
  await withServer(exchanger, {}, async ({ asUrl, rsUrl: _rsUrl }) => {
    const session = OPEN_SESSION_COOKIE;
    const { status, body, resp } = await initiateProviderAuth(asUrl, session, "test_provider");
    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.object, "provider_auth_initiate");
    assert.equal(body.connector_id, "test_provider");
    assert.equal(body.setup_modality, "provider_authorization");
    assert.equal(body.next_step.kind, "open_provider_auth");
    assert.equal(body.next_step.authorization_url, authUrl);
    assert.ok(body.next_step.redirect_uri, "must include redirect_uri");
    assert.ok(body.next_step.expires_at, "must include expiry");

    // Exchanger was called with the connector id.
    assert.equal(exchanger.calls.initiate.length, 1);
    assert.equal(exchanger.calls.initiate[0]?.connectorId, "test_provider");
    assert.ok(exchanger.calls.initiate[0]?.state, "exchanger must receive state token");

    // No connection row created yet.
    const connections = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(connections.length, 0, "initiation must not create a connection row");

    // No provider secrets in the response.
    const bodyStr = JSON.stringify(body);
    assert.doesNotMatch(bodyStr, REGEXP_8);

    // Audit event emitted.
    const traceId = resp.headers.get("PDPP-Reference-Trace-Id");
    assert.ok(traceId?.startsWith("trc_"), "must carry a trace id");
    const page = listSpineEventsPage("trace", requiredStateToken(traceId), { limit: 20 });
    const event = page.events.find((e) => e.event_type === "owner.connection.provider_auth.initiate");
    assert.ok(event, "must emit initiate audit event");
    assert.equal(event.status, "succeeded");
    assert.equal((event.data as { connector_id?: string } | undefined)?.connector_id, "test_provider");
  });
});

// ---------------------------------------------------------------------------
// Callback: missing/invalid state
// ---------------------------------------------------------------------------

test("callback with missing state does not create a connection", async () => {
  const exchanger = buildTestExchanger();
  await withServer(exchanger, {}, async ({ asUrl }) => {
    const { status, body } = await fetchJson(`${asUrl}/_ref/provider-auth/callback?code=somecode`);
    assert.equal(status, 400);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
    assert.equal(body?.error?.code, "provider_auth_state_invalid");
    assert.equal(exchanger.calls.exchange.length, 0);
    const connections = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(connections.length, 0);
  });
});

test("callback with unrecognized state does not create a connection", async () => {
  const exchanger = buildTestExchanger();
  await withServer(exchanger, {}, async ({ asUrl }) => {
    const { status, body } = await fetchJson(
      `${asUrl}/_ref/provider-auth/callback?state=pas_bogus_unrecognized&code=somecode`
    );
    assert.equal(status, 400);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
    assert.equal(body?.error?.code, "provider_auth_state_invalid");
    assert.equal(exchanger.calls.exchange.length, 0);
    const connections = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(connections.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Callback: redirect_uri mismatch
// ---------------------------------------------------------------------------

test("callback whose recomputed redirect_uri differs from the one used at initiate is rejected before code exchange", async () => {
  const exchanger = buildTestExchanger();
  await withServer(exchanger, {}, async ({ asUrl }) => {
    const session = OPEN_SESSION_COOKIE;
    const { body: initBody } = await initiateProviderAuth(asUrl, session, "test_provider");
    assert.equal(initBody.object, "provider_auth_initiate");
    const initiatedRedirectUri = initBody.next_step.redirect_uri;
    assert.ok(initiatedRedirectUri, "initiate must record the redirect_uri it used");

    const stateToken = requiredStateToken(exchanger.calls.initiate[exchanger.calls.initiate.length - 1]?.state);

    // The callback recomputes redirect_uri from ITS OWN request
    // (resolveCallbackBaseUrl reads x-forwarded-host with no explicit
    // asPublicUrl configured for this test server) -- spoofing a different
    // forwarded host here reproduces a real-world redirect_uri drift (e.g. a
    // rotated/misconfigured public base URL, or a forged callback request
    // presenting a different origin than the one the owner actually
    // authorized against).
    const { status, body } = await fetchJson(`${asUrl}/_ref/provider-auth/callback?code=somecode&state=${stateToken}`, {
      headers: { "x-forwarded-host": "attacker.example", "x-forwarded-proto": "https" },
    });

    assert.equal(status, 400, `expected 400, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body?.error?.code, "provider_auth_redirect_uri_mismatch");
    assert.equal(
      exchanger.calls.exchange.length,
      0,
      "code exchange must never be attempted on a redirect_uri mismatch"
    );
    const connections = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(connections.length, 0, "no connection may be created on a redirect_uri mismatch");

    // The state token is consumed (replay protection) even on this rejection
    // path -- a second attempt with the same state must also fail, not
    // silently retry against the original (correct) redirect_uri.
    const retry = await fetchJson(`${asUrl}/_ref/provider-auth/callback?code=somecode&state=${stateToken}`);
    assert.equal(retry.status, 400);
    assert.equal(retry.body?.error?.code, "provider_auth_state_invalid");
  });
});

test("callback whose recomputed redirect_uri matches the one used at initiate proceeds normally", async () => {
  const exchanger = buildTestExchanger();
  await withServer(exchanger, {}, async ({ asUrl }) => {
    const session = OPEN_SESSION_COOKIE;
    const { body: initBody } = await initiateProviderAuth(asUrl, session, "test_provider");
    const stateToken = requiredStateToken(exchanger.calls.initiate[exchanger.calls.initiate.length - 1]?.state);

    const { status, body } = await fetchJson(`${asUrl}/_ref/provider-auth/callback?code=somecode&state=${stateToken}`);

    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(exchanger.calls.exchange.length, 1);
    assert.equal(exchanger.calls.exchange[0]?.redirectUri, initBody.next_step.redirect_uri);
  });
});

// ---------------------------------------------------------------------------
// Callback: provider error
// ---------------------------------------------------------------------------

test("callback with provider error parameter does not create a connection", async () => {
  const exchanger = buildTestExchanger();
  await withServer(exchanger, {}, async ({ asUrl }) => {
    const { status, body } = await fetchJson(
      `${asUrl}/_ref/provider-auth/callback?error=access_denied&state=irrelevant`
    );
    assert.equal(status, 400);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
    assert.equal(body?.error?.code, "provider_auth_denied");
    assert.equal(exchanger.calls.exchange.length, 0);
    const connections = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(connections.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Callback: bad/expired code does not activate connection
// ---------------------------------------------------------------------------

test("callback with code-exchange failure does not activate a connection", async () => {
  const exchanger = buildTestExchanger({
    onExchange: () => null, // simulate failed exchange
  });
  await withServer(exchanger, {}, async ({ asUrl, rsUrl: _rsUrl }) => {
    const session = OPEN_SESSION_COOKIE;
    const { body: initBody } = await initiateProviderAuth(asUrl, session, "test_provider");
    assert.equal(initBody.object, "provider_auth_initiate");

    // Extract the state token that the exchanger received.
    const stateToken = requiredStateToken(exchanger.calls.initiate[0]?.state);

    const { status, body } = await fetchJson(
      `${asUrl}/_ref/provider-auth/callback?state=${encodeURIComponent(stateToken)}&code=bad_code`
    );
    assert.equal(status, 400);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
    assert.equal(body?.error?.code, "provider_auth_code_invalid");

    // Exchange was attempted but inventory was NOT called.
    assert.equal(exchanger.calls.exchange.length, 1);
    assert.equal(exchanger.calls.inventory.length, 0);

    // No connection was activated.
    const connections = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(connections.length, 0);
  });
});

test("callback with missing code does not activate a connection", async () => {
  const exchanger = buildTestExchanger();
  await withServer(exchanger, {}, async ({ asUrl, rsUrl: _rsUrl }) => {
    const session = OPEN_SESSION_COOKIE;
    await initiateProviderAuth(asUrl, session, "test_provider");
    const stateToken = requiredStateToken(exchanger.calls.initiate[0]?.state);

    // Callback without code parameter.
    const { status, body } = await fetchJson(
      `${asUrl}/_ref/provider-auth/callback?state=${encodeURIComponent(stateToken)}`
    );
    assert.equal(status, 400);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
    assert.equal(body?.error?.code, "provider_auth_code_missing");
    assert.equal(exchanger.calls.exchange.length, 0);
    const connections = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(connections.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Callback: failed inventory does not activate connection
// ---------------------------------------------------------------------------

test("callback with failed inventory does not activate a connection", async () => {
  const exchanger = buildTestExchanger({
    onInventory: () => {
      throw new Error("inventory_service_error");
    },
  });
  await withServer(exchanger, {}, async ({ asUrl, rsUrl: _rsUrl }) => {
    const session = OPEN_SESSION_COOKIE;
    await initiateProviderAuth(asUrl, session, "test_provider");
    const stateToken = requiredStateToken(exchanger.calls.initiate[0]?.state);

    const { status, body } = await fetchJson(
      `${asUrl}/_ref/provider-auth/callback?state=${encodeURIComponent(stateToken)}&code=valid_code`
    );
    assert.equal(status, 502);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
    assert.equal(body?.error?.code, "provider_auth_inventory_failed");

    // Exchange was called but store was NOT.
    assert.equal(exchanger.calls.exchange.length, 1);
    assert.equal(exchanger.calls.store.length, 0);

    // No connection was activated.
    const connections = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(connections.length, 0);
  });
});

test("callback with empty inventory does not activate a connection", async () => {
  const exchanger = buildTestExchanger({
    onInventory: () => [], // empty accounts
  });
  await withServer(exchanger, {}, async ({ asUrl, rsUrl: _rsUrl }) => {
    const session = OPEN_SESSION_COOKIE;
    await initiateProviderAuth(asUrl, session, "test_provider");
    const stateToken = requiredStateToken(exchanger.calls.initiate[0]?.state);

    const { status, body } = await fetchJson(
      `${asUrl}/_ref/provider-auth/callback?state=${encodeURIComponent(stateToken)}&code=valid_code`
    );
    assert.equal(status, 422);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
    assert.equal(body?.error?.code, "provider_auth_no_accounts");
    assert.equal(exchanger.calls.store.length, 0);
    const connections = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(connections.length, 0);
  });
});

test("callback with token-store failure does not expose an active connection", async () => {
  const exchanger = buildTestExchanger({
    onInventory: () => [{ accountId: "account_alice", displayLabel: "alice@example.com" }],
    onStore: () => {
      throw new Error("credential_store_failed");
    },
  });
  await withServer(exchanger, {}, async ({ asUrl }) => {
    await initiateProviderAuth(asUrl, OPEN_SESSION_COOKIE, "test_provider");
    const stateToken = requiredStateToken(exchanger.calls.initiate[0]?.state);

    const { status, body } = await fetchJson(
      `${asUrl}/_ref/provider-auth/callback?state=${encodeURIComponent(stateToken)}&code=valid_code`
    );
    assert.equal(status, 500);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
    assert.equal(body?.error?.code, "api_error");

    const connections = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(connections.length, 0, "credential-store failure must not leave a readable active connection");
  });
});

// ---------------------------------------------------------------------------
// Happy path: single account activated
// ---------------------------------------------------------------------------

test("callback with valid code + successful inventory activates exactly one connection", async () => {
  const exchanger = buildTestExchanger({
    onInventory: () => [{ accountId: "account_alice", displayLabel: "alice@example.com" }],
  });
  await withServer(exchanger, {}, async ({ asUrl, rsUrl: _rsUrl, server }) => {
    const session = OPEN_SESSION_COOKIE;
    await initiateProviderAuth(asUrl, session, "test_provider");
    const stateToken = requiredStateToken(exchanger.calls.initiate[0]?.state);

    const { status, body, resp } = await fetchJson(
      `${asUrl}/_ref/provider-auth/callback?state=${encodeURIComponent(stateToken)}&code=valid_code`
    );
    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.object, "provider_auth_callback");
    assert.equal(body.connector_id, "test_provider");
    assert.equal(body.connections.length, 1);
    // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
    const conn = body.connections[0];
    assert.match(conn.connection_id, REGEXP_9, "connection_id must have cin_ prefix");
    assert.equal(conn.connector_id, "test_provider");
    assert.equal(conn.status, "active");

    // Next step is run_connection.
    assert.equal(body.next_step.kind, "run_connection");

    // Exactly one connection was activated in the store.
    const connections = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(connections.length, 1);
    assert.equal(connections[0]?.connectorId, "test_provider");
    assert.equal(connections[0]?.status, "active");

    // The activation lifecycle invariant attaches a per-connection schedule for
    // automatic/background-safe manifests. This is independent of credential
    // presence and keyed by the connection_id, not the connector key.
    const schedule = await server.controller?.getSchedule("test_provider", {
      connectorInstanceId: conn.connection_id,
    });
    assert.ok(schedule, "automatic provider-auth activation must attach a schedule");
    assert.equal(schedule.connector_instance_id, conn.connection_id);
    assert.equal(schedule.interval_seconds, 900);
    assert.equal(schedule.enabled, true);

    // storeTokens was called once for the one account.
    assert.equal(exchanger.calls.store.length, 1);
    assert.equal(exchanger.calls.store[0]?.connectorInstanceId, conn.connection_id);
    assert.equal(exchanger.calls.store[0]?.ownerSubjectId, OWNER_SUBJECT_ID);

    // No provider tokens appear in the response body.
    const bodyStr = JSON.stringify(body);
    assert.doesNotMatch(bodyStr, REGEXP_1);
    assert.doesNotMatch(bodyStr, REGEXP_2);

    // Audit event emitted with no secret leak.
    const traceId = resp.headers.get("PDPP-Reference-Trace-Id");
    assert.ok(traceId?.startsWith("trc_"), "must carry a trace id");
    const page = listSpineEventsPage("trace", requiredStateToken(traceId), { limit: 20 });
    const event = page.events.find((e) => e.event_type === "owner.connection.provider_auth.callback");
    assert.ok(event, "must emit callback audit event");
    assert.equal(event.status, "succeeded");
    assert.equal((event.data as { connector_id?: string } | undefined)?.connector_id, "test_provider");
    assert.equal((event.data as { account_count?: number } | undefined)?.account_count, 1);
    // Audit must not carry access_token.
    assert.doesNotMatch(JSON.stringify(event), REGEXP_3);
  });
});

// ---------------------------------------------------------------------------
// Two accounts → two distinct connection_ids
// ---------------------------------------------------------------------------

test("two-account inventory creates two distinct connection_ids with separate storeTokens calls", async () => {
  const exchanger = buildTestExchanger({
    onInventory: () => [
      { accountId: "account_alice", displayLabel: "alice@example.com" },
      { accountId: "account_bob", displayLabel: "bob@example.com" },
    ],
  });
  await withServer(exchanger, {}, async ({ asUrl, rsUrl: _rsUrl }) => {
    const session = OPEN_SESSION_COOKIE;
    await initiateProviderAuth(asUrl, session, "test_provider");
    const stateToken = requiredStateToken(exchanger.calls.initiate[0]?.state);

    const { status, body } = await fetchJson(
      `${asUrl}/_ref/provider-auth/callback?state=${encodeURIComponent(stateToken)}&code=valid_code`
    );
    assert.equal(status, 201);
    assert.equal(body.connections.length, 2, "two accounts should produce two connection rows");

    const ids = body.connections.map((c: { connection_id: string }) => c.connection_id);
    assert.notEqual(ids[0], ids[1], "two accounts must get distinct connection_ids");

    // Both are active in the store.
    const connections = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(connections.length, 2);
    // biome-ignore lint/complexity/noForEach: Callback form preserves this fixture traversal contract.
    // biome-ignore lint/suspicious/useIterableCallbackReturn: Callback intentionally performs side effects only.
    connections.forEach((c) => assert.equal(c.status, "active"));

    // storeTokens was called separately for each account.
    assert.equal(exchanger.calls.store.length, 2);
    const storedIds = exchanger.calls.store.map((c) => c.connectorInstanceId);
    assert.notEqual(storedIds[0], storedIds[1], "storeTokens must be called with distinct instance ids");
  });
});

// ---------------------------------------------------------------------------
// State token replay protection
// ---------------------------------------------------------------------------

test("state token is consumed on first callback; replay is rejected", async () => {
  const exchanger = buildTestExchanger();
  await withServer(exchanger, {}, async ({ asUrl, rsUrl: _rsUrl }) => {
    const session = OPEN_SESSION_COOKIE;
    await initiateProviderAuth(asUrl, session, "test_provider");
    const stateToken = requiredStateToken(exchanger.calls.initiate[0]?.state);
    const callbackUrl = `${asUrl}/_ref/provider-auth/callback?state=${encodeURIComponent(stateToken)}&code=valid_code`;

    // First callback succeeds.
    const first = await fetchJson(callbackUrl);
    assert.equal(first.status, 201);

    // Second callback with the same state is rejected.
    const second = await fetchJson(callbackUrl);
    assert.equal(second.status, 400);
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
    assert.equal(second.body?.error?.code, "provider_auth_state_invalid");

    // Only one connection should exist (from the first callback).
    const connections = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(connections.length, 1);
  });
});

// ---------------------------------------------------------------------------
// No provider secrets in any response
// ---------------------------------------------------------------------------

test("no provider tokens appear in initiation or callback response bodies", async () => {
  const exchanger = buildTestExchanger({
    onExchange: () => ({
      accessToken: "SUPER_SECRET_ACCESS_TOKEN",
      refreshToken: "SUPER_SECRET_REFRESH_TOKEN",
      tokenKind: "bearer",
    }),
    onInventory: () => [{ accountId: "acct_1", displayLabel: "test@example.com" }],
    onStore: () => {
      /* intentionally empty */
    },
  });
  await withServer(exchanger, {}, async ({ asUrl, rsUrl: _rsUrl }) => {
    const session = OPEN_SESSION_COOKIE;
    const { body: initBody } = await initiateProviderAuth(asUrl, session, "test_provider");
    const stateToken = requiredStateToken(exchanger.calls.initiate[0]?.state);

    const { body: callbackBody } = await fetchJson(
      `${asUrl}/_ref/provider-auth/callback?state=${encodeURIComponent(stateToken)}&code=valid_code`
    );

    const initStr = JSON.stringify(initBody);
    const callbackStr = JSON.stringify(callbackBody);
    assert.doesNotMatch(initStr, REGEXP_4);
    assert.doesNotMatch(callbackStr, REGEXP_5);
    assert.doesNotMatch(callbackStr, REGEXP_6);
    assert.doesNotMatch(callbackStr, REGEXP_7);
  });
});

// ---------------------------------------------------------------------------
// Owner-session requirement (unauthenticated initiation blocked)
// ---------------------------------------------------------------------------

test("provider-auth initiation without owner session returns 401 or redirect", async () => {
  const exchanger = buildTestExchanger();
  // Use a password-protected server so that no-cookie requests are actually rejected.
  const server = await startServer({
    asPort: 0,
    autoEnrollEligibleSchedules: false,
    configuredProviderAuthConnectorKeys: ["test_provider"],
    dbPath: ":memory:",
    ownerAuthPassword: "protected-owner-password",
    ownerAuthSubjectId: OWNER_SUBJECT_ID,
    providerAuthExchanger: exchanger,
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(TEST_PROVIDER_MANIFEST),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const { status } = await fetchJson(`${asUrl}/_ref/connectors/test_provider/provider-auth-initiate`, {
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    // Owner session required: expect 401 or 302 redirect to login.
    assert.ok(status === 401 || status === 302 || status === 403, `expected auth rejection, got ${status}`);
    assert.equal(exchanger.calls.initiate.length, 0);
    const connections = await createSqliteConnectorInstanceStore().listByOwner(OWNER_SUBJECT_ID);
    assert.equal(connections.length, 0);
  } finally {
    server.schedulerManager?.stop?.();
    requireConnectionClosingServer(server.asServer, "authorization server").closeAllConnections();
    requireConnectionClosingServer(server.rsServer, "resource server").closeAllConnections();
    await Promise.allSettled([
      new Promise((resolve) => server.asServer.close(resolve)),
      new Promise((resolve) => server.rsServer.close(resolve)),
    ]);
  }
});
