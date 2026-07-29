// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startServer } from "../server/index.ts";
import {
  configuredGoogleDataPortabilityProviderAuthConnectorKeys,
  createGoogleDataPortabilityProviderAuthExchanger,
  GOOGLE_MAPS_DATA_PORTABILITY_CONNECTOR_KEY,
  GoogleDataPortabilityProviderAuthError,
  hasGoogleDataPortabilityProviderAuthConfig,
} from "../server/provider-auth/google-data-portability.ts";
import { createSqliteConnectorInstanceCredentialStore } from "../server/stores/connector-instance-credential-store.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { resolveProviderAuthRunEnv } from "../server/stores/provider-auth-run-credentials.ts";

const READY_ENV = Object.freeze({
  GOOGLE_DATAPORTABILITY_CLIENT_ID: "client-id",
  GOOGLE_DATAPORTABILITY_CLIENT_SECRET: "client-secret",
  GOOGLE_DATAPORTABILITY_REDIRECT_URI: "https://pdpp.example/_ref/provider-auth/callback",
  GOOGLE_DATAPORTABILITY_RESOURCE_GROUPS: "maps.starred_places,myactivity.maps",
});
const TEST_KEY = "google-data-portability-test-key";

interface Manifest {
  connector_id?: string;
  [key: string]: unknown;
}

function readManifest(): Manifest {
  return JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../../packages/polyfill-connectors/manifests/google_maps_data_portability.json", import.meta.url)
      ),
      "utf8"
    )
  );
}

// Matches the established pattern in connector-summary-dirty-hooks.test.ts /
// connector-failure-diagnostics-control-plane.test.ts: startServer's real
// return type already carries asServer/rsServer/schedulerManager; the
// intersection only adds the closeAllConnections shape these tests rely on.
type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  rsServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
};

async function closeServer(server: TestServer): Promise<void> {
  server.schedulerManager?.stop?.();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise<void>((resolve) => server.asServer.close(() => resolve())),
    new Promise<void>((resolve) => server.rsServer.close(() => resolve())),
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
  return {
    body: text ? JSON.parse(text) : null,
    resp,
    status: resp.status,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
    ...init,
  });
}

interface FetchCall {
  body: string;
  headers: Headers;
  method: string;
  url: string;
}

function makeFetch(responses: readonly Response[]) {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  return {
    calls,
    // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
    async fetch(url: string, init: RequestInit): Promise<Response> {
      calls.push({
        body: init.body ? String(init.body) : "",
        headers: new Headers(init.headers),
        method: init.method ?? "GET",
        url,
      });
      const response = queue.shift();
      assert.ok(response, `unexpected fetch call to ${url}`);
      return response;
    },
  };
}

test("Google Data Portability provider auth readiness is driven by deployment config", () => {
  assert.equal(hasGoogleDataPortabilityProviderAuthConfig({}), false);
  assert.deepEqual(configuredGoogleDataPortabilityProviderAuthConnectorKeys({}), []);
  assert.equal(hasGoogleDataPortabilityProviderAuthConfig(READY_ENV), true);
  assert.deepEqual(configuredGoogleDataPortabilityProviderAuthConnectorKeys(READY_ENV), [
    GOOGLE_MAPS_DATA_PORTABILITY_CONNECTOR_KEY,
  ]);
});

test("initiateAuthorization builds a Google OAuth URL with Data Portability scopes only", async () => {
  const exchanger = createGoogleDataPortabilityProviderAuthExchanger({
    // biome-ignore lint/suspicious/noEmptyBlockStatements: localized test assertion preserves its explicit contract.
    credentialStoreFactory: () => ({ capture: () => {} }),
    env: READY_ENV,
    fetch: async () => jsonResponse({}),
  });

  const result = await exchanger.initiateAuthorization({
    connectorId: GOOGLE_MAPS_DATA_PORTABILITY_CONNECTOR_KEY,
    redirectUri: READY_ENV.GOOGLE_DATAPORTABILITY_REDIRECT_URI,
    state: "pas_state",
  });

  const url = new URL(result.authorizationUrl);
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("client_id"), "client-id");
  assert.equal(url.searchParams.get("redirect_uri"), READY_ENV.GOOGLE_DATAPORTABILITY_REDIRECT_URI);
  assert.equal(url.searchParams.get("state"), "pas_state");
  assert.equal(url.searchParams.get("access_type"), "offline");
  const scope = url.searchParams.get("scope") ?? "";
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.match(scope, /https:\/\/www\.googleapis\.com\/auth\/dataportability\.maps\.starred_places/);
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.match(scope, /https:\/\/www\.googleapis\.com\/auth\/dataportability\.myactivity\.maps/);
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.doesNotMatch(scope, /gmail|userinfo|timeline/i);
});

test("Google exchanger exchanges code, inventories access type, and stores sealed token bundle", async () => {
  const transport = makeFetch([
    jsonResponse({
      access_token: "ya29.access",
      expires_in: 3600,
      refresh_token: "refresh-token",
      token_type: "Bearer",
    }),
    jsonResponse({
      oneTimeResources: ["maps.starred_places"],
      timeBasedResources: [],
    }),
  ]);
  interface Capture {
    connectorInstanceId: string;
    credentialKind: "secret_bundle";
    now: string;
    ownerSubjectId: string;
    secret: string;
  }
  const captures: Capture[] = [];
  const exchanger = createGoogleDataPortabilityProviderAuthExchanger({
    credentialStoreFactory: () => ({
      capture(args: Capture) {
        captures.push(args);
      },
    }),
    env: READY_ENV,
    fetch: transport.fetch,
  });

  const tokens = await exchanger.exchangeCode({
    code: "oauth-code",
    connectorId: GOOGLE_MAPS_DATA_PORTABILITY_CONNECTOR_KEY,
    redirectUri: READY_ENV.GOOGLE_DATAPORTABILITY_REDIRECT_URI,
    state: "pas_state",
  });
  assert.equal(tokens?.accessToken, "ya29.access");
  assert.equal(tokens?.refreshToken, "refresh-token");
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const tokenCall = transport.calls[0];
  assert.ok(tokenCall, "the exchanger made a token request");
  assert.equal(tokenCall.url, "https://oauth2.googleapis.com/token");
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.match(tokenCall.body, /grant_type=authorization_code/);

  assert.ok(tokens, "premise: exchangeCode returned tokens");
  const accounts = await exchanger.runInventoryOrTest({
    connectorId: GOOGLE_MAPS_DATA_PORTABILITY_CONNECTOR_KEY,
    tokens,
  });
  assert.equal(accounts.length, 1);
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const account = accounts[0];
  assert.ok(account, "runInventoryOrTest returned an account");
  assert.ok(account.sourceBinding, "account carries a sourceBinding");
  assert.equal(account.sourceBinding.provider, "google_data_portability");
  assert.equal(account.sourceBinding.account_id_verified, false);
  assert.deepEqual(account.sourceBinding.authorized_resource_groups, ["maps.starred_places"]);
  assert.deepEqual(account.sourceBinding.denied_resource_groups, ["myactivity.maps"]);
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.doesNotMatch(JSON.stringify(accounts), /ya29|refresh-token/);

  await exchanger.storeTokens({
    connectorInstanceId: "cin_google",
    now: "2026-06-11T00:00:00.000Z",
    ownerSubjectId: "owner_local",
    tokens,
  });
  assert.equal(captures.length, 1);
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const capture = captures[0];
  assert.ok(capture, "storeTokens captured a credential");
  assert.equal(capture.connectorInstanceId, "cin_google");
  assert.equal(capture.credentialKind, "secret_bundle");
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.match(capture.secret, /ya29\.access/);
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.match(capture.secret, /refresh-token/);
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.match(capture.secret, /maps\.starred_places/);
});

test("Google exchanger returns a typed setup error when no requested resources are authorized", async () => {
  const exchanger = createGoogleDataPortabilityProviderAuthExchanger({
    // biome-ignore lint/suspicious/noEmptyBlockStatements: localized test assertion preserves its explicit contract.
    credentialStoreFactory: () => ({ capture: () => {} }),
    env: READY_ENV,
    fetch: makeFetch([jsonResponse({ oneTimeResources: [], timeBasedResources: [] })]).fetch,
  });

  await assert.rejects(
    async () =>
      exchanger.runInventoryOrTest({
        connectorId: GOOGLE_MAPS_DATA_PORTABILITY_CONNECTOR_KEY,
        tokens: { accessToken: "token", tokenKind: "Bearer" },
      }),
    (err: unknown) =>
      err instanceof GoogleDataPortabilityProviderAuthError &&
      err.code === "google_dataportability_no_authorized_resources" &&
      err.status === 422
  );
});

test("provider-auth run env recovers Google token bundle without using static-secret registry", async () => {
  const env = await resolveProviderAuthRunEnv({
    connectorId: GOOGLE_MAPS_DATA_PORTABILITY_CONNECTOR_KEY,
    connectorInstanceId: "cin_google",
    credentialStore: {
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      async recoverSecret() {
        return {
          credentialKind: "secret_bundle",
          secret: JSON.stringify({
            google_dataportability_access_token: "ya29.access",
            google_dataportability_authorized_resource_groups: "maps.starred_places",
            google_dataportability_refresh_token: "refresh-token",
          }),
        };
      },
    },
    ownerSubjectId: "owner_local",
    sourceBinding: {
      kind: "provider_auth_account",
      provider: "google_data_portability",
    },
  });

  assert.deepEqual(env, {
    GOOGLE_DATAPORTABILITY_ACCESS_TOKEN: "ya29.access",
    GOOGLE_DATAPORTABILITY_AUTHORIZED_RESOURCE_GROUPS: "maps.starred_places",
    GOOGLE_DATAPORTABILITY_REFRESH_TOKEN: "refresh-token",
  });
});

test("Google Data Portability provider-auth route materializes an active connection with sealed tokens", async () => {
  const asPublicUrl = "https://pdpp.example";
  const env = {
    ...READY_ENV,
    GOOGLE_DATAPORTABILITY_REDIRECT_URI: `${asPublicUrl}/_ref/provider-auth/callback`,
  };
  const transport = makeFetch([
    jsonResponse({
      access_token: "ya29.route-access",
      expires_in: 3600,
      refresh_token: "route-refresh-token",
      token_type: "Bearer",
    }),
    jsonResponse({
      oneTimeResources: ["maps.starred_places"],
      timeBasedResources: ["myactivity.maps"],
    }),
  ]);
  const exchanger = createGoogleDataPortabilityProviderAuthExchanger({
    credentialStoreFactory: () =>
      createSqliteConnectorInstanceCredentialStore({
        env: { PDPP_CREDENTIAL_ENCRYPTION_KEY: TEST_KEY },
      }),
    env,
    fetch: transport.fetch,
  });
  const server = (await startServer({
    asPort: 0,
    asPublicUrl,
    autoEnrollEligibleSchedules: false,
    configuredProviderAuthConnectorKeys: [GOOGLE_MAPS_DATA_PORTABILITY_CONNECTOR_KEY],
    dbPath: ":memory:",
    ownerAuthPassword: "",
    ownerAuthSubjectId: "owner_local",
    providerAuthExchanger: exchanger,
    quiet: true,
    rsPort: 0,
  })) as TestServer;
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(readManifest()),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const initiated = await fetchJson(
      `${asUrl}/_ref/connectors/${GOOGLE_MAPS_DATA_PORTABILITY_CONNECTOR_KEY}/provider-auth-initiate`,
      { method: "POST" }
    );
    assert.equal(initiated.status, 201, JSON.stringify(initiated.body));
    const initiatedBody = initiated.body as { next_step: { authorization_url: string } };
    const authorizationUrl = new URL(initiatedBody.next_step.authorization_url);
    const state = authorizationUrl.searchParams.get("state");
    assert.ok(state);
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(authorizationUrl.searchParams.get("scope") ?? "", /dataportability\.maps\.starred_places/);

    const callback = await fetchJson(
      `${asUrl}/_ref/provider-auth/callback?state=${encodeURIComponent(state)}&code=oauth-code`
    );
    assert.equal(callback.status, 201, JSON.stringify(callback.body));
    const callbackBody = callback.body as { connector_id: string; connections: { connection_id: string }[] };
    assert.equal(callbackBody.connector_id, GOOGLE_MAPS_DATA_PORTABILITY_CONNECTOR_KEY);
    // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
    const callbackConnection = callbackBody.connections[0];
    assert.ok(callbackConnection, "the callback response lists the materialized connection");
    const connectionId = callbackConnection.connection_id;
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(connectionId, /^cin_/);
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.doesNotMatch(JSON.stringify(callback.body), /route-access|route-refresh-token|access_token|refresh_token/i);

    const instance = await createSqliteConnectorInstanceStore().get(connectionId);
    assert.ok(instance, "the connector instance was created");
    assert.equal(instance.connectorId, GOOGLE_MAPS_DATA_PORTABILITY_CONNECTOR_KEY);
    const sourceBinding = instance.sourceBinding as {
      authorized_resource_groups: string[];
      provider: string;
    };
    assert.equal(sourceBinding.provider, "google_data_portability");
    assert.deepEqual(sourceBinding.authorized_resource_groups, ["maps.starred_places", "myactivity.maps"]);
    const credential = await createSqliteConnectorInstanceCredentialStore({
      env: { PDPP_CREDENTIAL_ENCRYPTION_KEY: TEST_KEY },
    }).getMetadata(connectionId);
    assert.ok(credential, "a credential was captured for the connection");
    assert.equal(credential.credentialKind, "secret_bundle");
    assert.equal(credential.status, "active");
  } finally {
    await closeServer(server);
  }
});
