// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { startServer } from "../server/index.ts";
import {
  configuredGoogleOwnerAccountProviderAuthConnectorKeys,
  createGoogleOwnerAccountProviderAuthExchanger,
  GOOGLE_OWNER_ACCOUNT_CONNECTOR_KEYS,
  GoogleOwnerAccountProviderAuthError,
  hasGoogleOwnerAccountProviderAuthConfig,
} from "../server/provider-auth/google-oauth-account.ts";
import { createSqliteConnectorInstanceCredentialStore } from "../server/stores/connector-instance-credential-store.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { resolveProviderAuthRunEnv } from "../server/stores/provider-auth-run-credentials.ts";

const REDIRECT_URI = "https://pdpp.example/_ref/provider-auth/callback";
const READY_ENV = Object.freeze({
  GOOGLE_OAUTH_CLIENT_ID: "client-id",
  GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
});
const TEST_KEY = "google-owner-account-test-key";

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
    // biome-ignore lint/suspicious/useAwait: mirrors google-data-portability-provider-auth.test.ts's makeFetch
    async fetch(url: string, init: RequestInit = {}): Promise<Response> {
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

test("Google owner-account provider auth readiness is driven by deployment config", () => {
  assert.equal(hasGoogleOwnerAccountProviderAuthConfig({}), false);
  assert.deepEqual(configuredGoogleOwnerAccountProviderAuthConnectorKeys({}), []);
  assert.equal(hasGoogleOwnerAccountProviderAuthConfig(READY_ENV), true);
  assert.deepEqual([...configuredGoogleOwnerAccountProviderAuthConnectorKeys(READY_ENV)].sort(), [
    "google-calendar",
    "google-contacts",
  ]);
});

test("GOOGLE_OWNER_ACCOUNT_CONNECTOR_KEYS is disjoint from google-maps-data-portability", () => {
  assert.deepEqual([...GOOGLE_OWNER_ACCOUNT_CONNECTOR_KEYS].sort(), ["google-calendar", "google-contacts"]);
  assert.ok(!GOOGLE_OWNER_ACCOUNT_CONNECTOR_KEYS.includes("google-maps-data-portability"));
});

for (const connectorId of ["google-calendar", "google-contacts"] as const) {
  test(`initiateAuthorization builds a Google OAuth URL with ${connectorId}'s least-privilege scope only`, async () => {
    const exchanger = createGoogleOwnerAccountProviderAuthExchanger({
      // biome-ignore lint/suspicious/noEmptyBlockStatements: mirrors google-data-portability-provider-auth.test.ts
      credentialStoreFactory: () => ({ capture: () => {} }),
      env: READY_ENV,
      fetch: async () => jsonResponse({}),
    });

    const result = await exchanger.initiateAuthorization({
      connectorId,
      redirectUri: REDIRECT_URI,
      state: "pas_state",
    });

    const url = new URL(result.authorizationUrl);
    assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(url.searchParams.get("client_id"), "client-id");
    assert.equal(url.searchParams.get("redirect_uri"), REDIRECT_URI);
    assert.equal(url.searchParams.get("state"), "pas_state");
    assert.equal(url.searchParams.get("access_type"), "offline");
    const scope = url.searchParams.get("scope") ?? "";
    if (connectorId === "google-calendar") {
      assert.equal(scope, "https://www.googleapis.com/auth/calendar.readonly");
    } else {
      assert.equal(scope, "https://www.googleapis.com/auth/contacts.readonly");
    }
    // No PKCE, no Data Portability namespace leakage.
    assert.equal(url.searchParams.has("code_challenge"), false);
    // biome-ignore lint/performance/useTopLevelRegex: mirrors google-data-portability-provider-auth.test.ts
    assert.doesNotMatch(scope, /dataportability/i);
  });
}

test("initiateAuthorization rejects a connector outside the owner-account allowlist", async () => {
  const exchanger = createGoogleOwnerAccountProviderAuthExchanger({
    // biome-ignore lint/suspicious/noEmptyBlockStatements: mirrors google-data-portability-provider-auth.test.ts
    credentialStoreFactory: () => ({ capture: () => {} }),
    env: READY_ENV,
    fetch: async () => jsonResponse({}),
  });
  await assert.rejects(
    async () =>
      exchanger.initiateAuthorization({
        connectorId: "google-maps-data-portability",
        redirectUri: REDIRECT_URI,
        state: "pas_state",
      }),
    (err: unknown) =>
      err instanceof GoogleOwnerAccountProviderAuthError && err.code === "provider_auth_connector_unsupported"
  );
});

test("exchanger exchanges code, resolves account identity via userinfo, and stores a refresh-token bundle", async () => {
  const transport = makeFetch([
    jsonResponse({
      access_token: "ya29.access",
      expires_in: 3600,
      refresh_token: "refresh-token",
      token_type: "Bearer",
    }),
    jsonResponse({ email: "owner@example.com", id: "112233445566" }),
  ]);
  interface Capture {
    connectorInstanceId: string;
    credentialKind: "secret_bundle";
    now: string;
    ownerSubjectId: string;
    secret: string;
  }
  const captures: Capture[] = [];
  const exchanger = createGoogleOwnerAccountProviderAuthExchanger({
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
    connectorId: "google-calendar",
    redirectUri: REDIRECT_URI,
    state: "pas_state",
  });
  assert.equal(tokens?.accessToken, "ya29.access");
  assert.equal(tokens?.refreshToken, "refresh-token");
  // biome-ignore lint/style/useDestructuring: mirrors google-data-portability-provider-auth.test.ts
  const tokenCall = transport.calls[0];
  assert.ok(tokenCall, "the exchanger made a token request");
  assert.equal(tokenCall.url, "https://oauth2.googleapis.com/token");
  // biome-ignore lint/performance/useTopLevelRegex: mirrors google-data-portability-provider-auth.test.ts
  assert.match(tokenCall.body, /grant_type=authorization_code/);

  assert.ok(tokens, "premise: exchangeCode returned tokens");
  const accounts = await exchanger.runInventoryOrTest({ connectorId: "google-calendar", tokens });
  assert.equal(accounts.length, 1);
  // biome-ignore lint/style/useDestructuring: mirrors google-data-portability-provider-auth.test.ts
  const account = accounts[0];
  assert.ok(account, "runInventoryOrTest returned an account");
  assert.equal(account.accountId, "google_owner_account_112233445566");
  assert.equal(account.displayLabel, "owner@example.com");
  assert.ok(account.sourceBinding, "account carries a sourceBinding");
  assert.equal(account.sourceBinding.provider, "google_owner_account");
  assert.equal(account.sourceBinding.account_email, "owner@example.com");
  // biome-ignore lint/performance/useTopLevelRegex: mirrors google-data-portability-provider-auth.test.ts
  assert.doesNotMatch(JSON.stringify(accounts), /ya29|refresh-token/);

  await exchanger.storeTokens({
    connectorId: "google-calendar",
    connectorInstanceId: "cin_calendar",
    now: "2026-08-07T00:00:00.000Z",
    ownerSubjectId: "owner_local",
    tokens,
  });
  assert.equal(captures.length, 1);
  // biome-ignore lint/style/useDestructuring: mirrors google-data-portability-provider-auth.test.ts
  const capture = captures[0];
  assert.ok(capture, "storeTokens captured a credential");
  assert.equal(capture.connectorInstanceId, "cin_calendar");
  assert.equal(capture.credentialKind, "secret_bundle");
  // biome-ignore lint/performance/useTopLevelRegex: mirrors google-data-portability-provider-auth.test.ts
  assert.match(capture.secret, /refresh-token/);
  // Disjoint bundle key prefix from google_dataportability_*.
  // biome-ignore lint/performance/useTopLevelRegex: mirrors google-data-portability-provider-auth.test.ts
  assert.match(capture.secret, /google_owner_account_refresh_token/);
  // biome-ignore lint/performance/useTopLevelRegex: mirrors google-data-portability-provider-auth.test.ts
  assert.doesNotMatch(capture.secret, /google_dataportability/);
});

test("runInventoryOrTest fails closed when Google returns no refresh_token (re-consent required)", async () => {
  const exchanger = createGoogleOwnerAccountProviderAuthExchanger({
    // biome-ignore lint/suspicious/noEmptyBlockStatements: mirrors google-data-portability-provider-auth.test.ts
    credentialStoreFactory: () => ({ capture: () => {} }),
    env: READY_ENV,
    fetch: async () => jsonResponse({}),
  });
  await assert.rejects(
    async () =>
      exchanger.runInventoryOrTest({
        connectorId: "google-calendar",
        tokens: { accessToken: "ya29.access", tokenKind: "Bearer" },
      }),
    (err: unknown) =>
      err instanceof GoogleOwnerAccountProviderAuthError && err.code === "google_owner_account_refresh_token_missing"
  );
});

test("runInventoryOrTest fails closed when Google userinfo returns no account identity", async () => {
  const exchanger = createGoogleOwnerAccountProviderAuthExchanger({
    // biome-ignore lint/suspicious/noEmptyBlockStatements: mirrors google-data-portability-provider-auth.test.ts
    credentialStoreFactory: () => ({ capture: () => {} }),
    env: READY_ENV,
    fetch: async () => jsonResponse({}),
  });
  await assert.rejects(
    async () =>
      exchanger.runInventoryOrTest({
        connectorId: "google-contacts",
        tokens: { accessToken: "ya29.access", refreshToken: "refresh-token", tokenKind: "Bearer" },
      }),
    (err: unknown) =>
      err instanceof GoogleOwnerAccountProviderAuthError && err.code === "google_owner_account_identity_unavailable"
  );
});

for (const [connectorId, envVar] of [
  ["google-calendar", "GOOGLE_CALENDAR_REFRESH_TOKEN"],
  ["google-contacts", "GOOGLE_CONTACTS_REFRESH_TOKEN"],
] as const) {
  test(`provider-auth run env maps ${connectorId}'s stored refresh token to ${envVar}, matching resolveGoogleOAuthCredentials`, async () => {
    const env = await resolveProviderAuthRunEnv({
      connectorId,
      connectorInstanceId: `cin_${connectorId}`,
      credentialStore: {
        // biome-ignore lint/suspicious/useAwait: mirrors google-data-portability-provider-auth.test.ts
        async recoverSecret() {
          return {
            credentialKind: "secret_bundle",
            secret: JSON.stringify({
              google_owner_account_access_token: "ya29.access",
              google_owner_account_refresh_token: "the-refresh-token",
            }),
          };
        },
      },
      ownerSubjectId: "owner_local",
      sourceBinding: {
        kind: "provider_auth_account",
        provider: "google_owner_account",
      },
    });

    assert.deepEqual(env, { [envVar]: "the-refresh-token" });
  });
}

test("provider-auth run env: google-maps-data-portability connectorId with a google_owner_account binding does not cross-dispatch", async () => {
  const env = await resolveProviderAuthRunEnv({
    connectorId: "google-maps-data-portability",
    connectorInstanceId: "cin_x",
    credentialStore: {
      // biome-ignore lint/suspicious/useAwait: mirrors google-data-portability-provider-auth.test.ts
      async recoverSecret() {
        throw new Error("must not be called: connectorId/binding combination should short-circuit to null");
      },
    },
    ownerSubjectId: "owner_local",
    sourceBinding: { kind: "provider_auth_account", provider: "google_owner_account" },
  });
  assert.equal(env, null);
});

test("Google owner-account provider-auth route materializes an active connection for Calendar", async () => {
  const asPublicUrl = "https://pdpp.example";
  const env = { ...READY_ENV };
  // The setup planner measures deployment readiness from the manifest's
  // declared settings against the process environment, so this route test
  // supplies them for its duration the way a configured deployment would.
  const priorDeploymentEnv = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const transport = makeFetch([
    jsonResponse({
      access_token: "ya29.route-access",
      expires_in: 3600,
      refresh_token: "route-refresh-token",
      token_type: "Bearer",
    }),
    jsonResponse({ email: "owner@example.com", id: "998877" }),
  ]);
  const exchanger = createGoogleOwnerAccountProviderAuthExchanger({
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
    configuredProviderAuthConnectorKeys: ["google-calendar"],
    dbPath: ":memory:",
    ownerAuthPassword: "",
    ownerAuthSubjectId: "owner_local",
    providerAuthExchanger: exchanger,
    quiet: true,
    rsPort: 0,
  })) as TestServer;
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    const calendarManifest = JSON.parse(
      await (await import("node:fs/promises")).readFile(
        new URL("../../packages/polyfill-connectors/manifests/google_calendar.json", import.meta.url),
        "utf8"
      )
    );
    await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(calendarManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const initiated = await fetchJson(`${asUrl}/_ref/connectors/google-calendar/provider-auth-initiate`, {
      method: "POST",
    });
    assert.equal(initiated.status, 201, JSON.stringify(initiated.body));
    const initiatedBody = initiated.body as { next_step: { authorization_url: string } };
    const authorizationUrl = new URL(initiatedBody.next_step.authorization_url);
    const state = authorizationUrl.searchParams.get("state");
    assert.ok(state);
    assert.equal(authorizationUrl.searchParams.get("scope"), "https://www.googleapis.com/auth/calendar.readonly");

    const callback = await fetchJson(
      `${asUrl}/_ref/provider-auth/callback?state=${encodeURIComponent(state)}&code=oauth-code`
    );
    assert.equal(callback.status, 201, JSON.stringify(callback.body));
    const callbackBody = callback.body as { connector_id: string; connections: { connection_id: string }[] };
    assert.equal(callbackBody.connector_id, "google-calendar");
    // biome-ignore lint/style/useDestructuring: mirrors google-data-portability-provider-auth.test.ts
    const callbackConnection = callbackBody.connections[0];
    assert.ok(callbackConnection, "the callback response lists the materialized connection");
    const connectionId = callbackConnection.connection_id;
    // biome-ignore lint/performance/useTopLevelRegex: mirrors google-data-portability-provider-auth.test.ts
    assert.match(connectionId, /^cin_/);
    // biome-ignore lint/performance/useTopLevelRegex: mirrors google-data-portability-provider-auth.test.ts
    assert.doesNotMatch(JSON.stringify(callback.body), /route-access|route-refresh-token|access_token|refresh_token/i);

    const instance = await createSqliteConnectorInstanceStore().get(connectionId);
    assert.ok(instance, "the connector instance was created");
    assert.equal(instance.connectorId, "google-calendar");
    const sourceBinding = instance.sourceBinding as { account_email: string; provider: string };
    assert.equal(sourceBinding.provider, "google_owner_account");
    assert.equal(sourceBinding.account_email, "owner@example.com");
    const credential = await createSqliteConnectorInstanceCredentialStore({
      env: { PDPP_CREDENTIAL_ENCRYPTION_KEY: TEST_KEY },
    }).getMetadata(connectionId);
    assert.ok(credential, "a credential was captured for the connection");
    assert.equal(credential.credentialKind, "secret_bundle");
    assert.equal(credential.status, "active");
  } finally {
    await closeServer(server);
    for (const [key, value] of priorDeploymentEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
