import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { startServer } from "../server/index.js";
import {
  GOOGLE_MAPS_DATA_PORTABILITY_CONNECTOR_KEY,
  GoogleDataPortabilityProviderAuthError,
  configuredGoogleDataPortabilityProviderAuthConnectorKeys,
  createGoogleDataPortabilityProviderAuthExchanger,
  hasGoogleDataPortabilityProviderAuthConfig,
} from "../server/provider-auth/google-data-portability.ts";
import { createSqliteConnectorInstanceCredentialStore } from "../server/stores/connector-instance-credential-store.js";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.js";
import { resolveProviderAuthRunEnv } from "../server/stores/provider-auth-run-credentials.js";

const READY_ENV = Object.freeze({
  GOOGLE_DATAPORTABILITY_CLIENT_ID: "client-id",
  GOOGLE_DATAPORTABILITY_CLIENT_SECRET: "client-secret",
  GOOGLE_DATAPORTABILITY_REDIRECT_URI: "https://pdpp.example/_ref/provider-auth/callback",
  GOOGLE_DATAPORTABILITY_RESOURCE_GROUPS: "maps.starred_places,myactivity.maps",
});
const TEST_KEY = "google-data-portability-test-key";

function readManifest() {
  return JSON.parse(
    readFileSync(
      join(process.cwd(), "packages/polyfill-connectors/manifests/google_maps_data_portability.json"),
      "utf8"
    )
  );
}

async function closeServer(server) {
  server.schedulerManager?.stop?.();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

async function fetchJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  return {
    body: text ? JSON.parse(text) : null,
    resp,
    status: resp.status,
  };
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
    ...init,
  });
}

function makeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  return {
    calls,
    async fetch(url, init) {
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
  assert.match(scope, /https:\/\/www\.googleapis\.com\/auth\/dataportability\.maps\.starred_places/);
  assert.match(scope, /https:\/\/www\.googleapis\.com\/auth\/dataportability\.myactivity\.maps/);
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
  const captures = [];
  const exchanger = createGoogleDataPortabilityProviderAuthExchanger({
    credentialStoreFactory: () => ({
      capture(args) {
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
  assert.equal(transport.calls[0].url, "https://oauth2.googleapis.com/token");
  assert.match(transport.calls[0].body, /grant_type=authorization_code/);

  const accounts = await exchanger.runInventoryOrTest({
    connectorId: GOOGLE_MAPS_DATA_PORTABILITY_CONNECTOR_KEY,
    tokens,
  });
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].sourceBinding.provider, "google_data_portability");
  assert.equal(accounts[0].sourceBinding.account_id_verified, false);
  assert.deepEqual(accounts[0].sourceBinding.authorized_resource_groups, ["maps.starred_places"]);
  assert.deepEqual(accounts[0].sourceBinding.denied_resource_groups, ["myactivity.maps"]);
  assert.doesNotMatch(JSON.stringify(accounts), /ya29|refresh-token/);

  await exchanger.storeTokens({
    connectorInstanceId: "cin_google",
    ownerSubjectId: "owner_local",
    tokens,
    now: "2026-06-11T00:00:00.000Z",
  });
  assert.equal(captures.length, 1);
  assert.equal(captures[0].connectorInstanceId, "cin_google");
  assert.equal(captures[0].credentialKind, "secret_bundle");
  assert.match(captures[0].secret, /ya29\.access/);
  assert.match(captures[0].secret, /refresh-token/);
  assert.match(captures[0].secret, /maps\.starred_places/);
});

test("Google exchanger returns a typed setup error when no requested resources are authorized", async () => {
  const exchanger = createGoogleDataPortabilityProviderAuthExchanger({
    credentialStoreFactory: () => ({ capture: () => {} }),
    env: READY_ENV,
    fetch: makeFetch([jsonResponse({ oneTimeResources: [], timeBasedResources: [] })]).fetch,
  });

  await assert.rejects(
    () =>
      exchanger.runInventoryOrTest({
        connectorId: GOOGLE_MAPS_DATA_PORTABILITY_CONNECTOR_KEY,
        tokens: { accessToken: "token", tokenKind: "Bearer" },
      }),
    (err) =>
      err instanceof GoogleDataPortabilityProviderAuthError &&
      err.code === "google_dataportability_no_authorized_resources" &&
      err.status === 422
  );
});

test("provider-auth run env recovers Google token bundle without using static-secret registry", async () => {
  const env = await resolveProviderAuthRunEnv({
    connectorId: GOOGLE_MAPS_DATA_PORTABILITY_CONNECTOR_KEY,
    connectorInstanceId: "cin_google",
    ownerSubjectId: "owner_local",
    sourceBinding: {
      kind: "provider_auth_account",
      provider: "google_data_portability",
    },
    credentialStore: {
      async recoverSecret() {
        return {
          credentialKind: "secret_bundle",
          secret: JSON.stringify({
            google_dataportability_access_token: "ya29.access",
            google_dataportability_refresh_token: "refresh-token",
            google_dataportability_authorized_resource_groups: "maps.starred_places",
          }),
        };
      },
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
  const server = await startServer({
    asPort: 0,
    asPublicUrl,
    autoEnrollEligibleSchedules: false,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    ownerAuthSubjectId: "owner_local",
    providerAuthExchanger: exchanger,
    configuredProviderAuthConnectorKeys: [GOOGLE_MAPS_DATA_PORTABILITY_CONNECTOR_KEY],
    quiet: true,
    rsPort: 0,
  });
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
    const authorizationUrl = new URL(initiated.body.next_step.authorization_url);
    const state = authorizationUrl.searchParams.get("state");
    assert.ok(state);
    assert.match(authorizationUrl.searchParams.get("scope") ?? "", /dataportability\.maps\.starred_places/);

    const callback = await fetchJson(
      `${asUrl}/_ref/provider-auth/callback?state=${encodeURIComponent(state)}&code=oauth-code`
    );
    assert.equal(callback.status, 201, JSON.stringify(callback.body));
    assert.equal(callback.body.connector_id, GOOGLE_MAPS_DATA_PORTABILITY_CONNECTOR_KEY);
    const connectionId = callback.body.connections[0].connection_id;
    assert.match(connectionId, /^cin_/);
    assert.doesNotMatch(JSON.stringify(callback.body), /route-access|route-refresh-token|access_token|refresh_token/i);

    const instance = await createSqliteConnectorInstanceStore().get(connectionId);
    assert.equal(instance.connectorId, GOOGLE_MAPS_DATA_PORTABILITY_CONNECTOR_KEY);
    assert.equal(instance.sourceBinding.provider, "google_data_portability");
    assert.deepEqual(instance.sourceBinding.authorized_resource_groups, [
      "maps.starred_places",
      "myactivity.maps",
    ]);
    const credential = await createSqliteConnectorInstanceCredentialStore({
      env: { PDPP_CREDENTIAL_ENCRYPTION_KEY: TEST_KEY },
    }).getMetadata(connectionId);
    assert.equal(credential.credentialKind, "secret_bundle");
    assert.equal(credential.status, "active");
  } finally {
    await closeServer(server);
  }
});
