// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  createOauth2GenericProviderAuthExchanger,
  type Oauth2GenericManifestLike,
  Oauth2GenericProviderAuthError,
} from "../server/provider-auth/oauth2-generic.ts";

// This fixture is deliberately named after a fictional provider ("Aurora"),
// not a real one. The module under test must behave identically regardless
// of which provider's shape the manifest describes — that is the whole
// point of "generic." Swap this fixture for a Google-shaped one and every
// assertion below should still pass unchanged.
const AURORA_MANIFEST: Oauth2GenericManifestLike = Object.freeze({
  capabilities: {
    auth: {
      authorization_url: "https://auth.aurora.example/o/oauth2/v2/auth",
      deployment_config: [
        { key: "AURORA_OAUTH_CLIENT_ID", label: "OAuth client ID", secret: false },
        { key: "AURORA_OAUTH_CLIENT_SECRET", label: "OAuth client secret", secret: true },
      ],
      exchanger_kind: "oauth2_generic",
      scopes: ["https://api.aurora.example/scopes/notes.readonly"],
      token_url: "https://token.aurora.example/token",
      userinfo_url: "https://api.aurora.example/userinfo",
    },
  },
  connector_key: "aurora-notes",
});

const READY_ENV = Object.freeze({
  AURORA_OAUTH_CLIENT_ID: "client-id",
  AURORA_OAUTH_CLIENT_SECRET: "client-secret",
});

const REDIRECT_URI = "https://pdpp.example/_ref/provider-auth/callback";

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
    // biome-ignore lint/suspicious/useAwait: mirrors google-owner-account-provider-auth.test.ts's makeFetch
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

function noopCredentialStoreFactory() {
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op capture stub
  return { capture: () => {} };
}

test("initiateAuthorization builds an authorization URL from the manifest, not from a hardcoded provider", async () => {
  const exchanger = createOauth2GenericProviderAuthExchanger({
    credentialStoreFactory: noopCredentialStoreFactory,
    env: READY_ENV,
    fetch: async () => jsonResponse({}),
    manifest: AURORA_MANIFEST,
  });

  const result = await exchanger.initiateAuthorization({
    connectorId: "aurora-notes",
    redirectUri: REDIRECT_URI,
    state: "pas_state",
  });

  const url = new URL(result.authorizationUrl);
  assert.equal(url.origin + url.pathname, "https://auth.aurora.example/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("client_id"), "client-id");
  assert.equal(url.searchParams.get("redirect_uri"), REDIRECT_URI);
  assert.equal(url.searchParams.get("state"), "pas_state");
  assert.equal(url.searchParams.get("scope"), "https://api.aurora.example/scopes/notes.readonly");
  assert.equal(url.searchParams.get("access_type"), "offline");
});

test("initiateAuthorization throws when the manifest omits authorization_url", async () => {
  const manifest: Oauth2GenericManifestLike = {
    capabilities: {
      auth: {
        deployment_config: [
          { key: "AURORA_OAUTH_CLIENT_ID", label: "OAuth client ID", secret: false },
          { key: "AURORA_OAUTH_CLIENT_SECRET", label: "OAuth client secret", secret: true },
        ],
        token_url: "https://token.aurora.example/token",
      },
    },
    connector_key: "aurora-notes",
  };
  const exchanger = createOauth2GenericProviderAuthExchanger({
    credentialStoreFactory: noopCredentialStoreFactory,
    env: READY_ENV,
    fetch: async () => jsonResponse({}),
    manifest,
  });

  await assert.rejects(
    async () => exchanger.initiateAuthorization({ connectorId: "aurora-notes", redirectUri: REDIRECT_URI, state: "s" }),
    Oauth2GenericProviderAuthError
  );
});

test("exchangeCode reads deployment-config values by manifest-declared key name, not a literal env var", async () => {
  const fetchStub = makeFetch([
    jsonResponse({ access_token: "at", expires_in: 3600, refresh_token: "rt", token_type: "Bearer" }),
  ]);
  const exchanger = createOauth2GenericProviderAuthExchanger({
    credentialStoreFactory: noopCredentialStoreFactory,
    env: READY_ENV,
    fetch: fetchStub.fetch,
    manifest: AURORA_MANIFEST,
  });

  const tokens = await exchanger.exchangeCode({
    code: "auth-code",
    connectorId: "aurora-notes",
    redirectUri: REDIRECT_URI,
    state: "s",
  });

  assert.ok(tokens);
  assert.equal(tokens?.accessToken, "at");
  assert.equal(tokens?.refreshToken, "rt");
  assert.equal(fetchStub.calls.length, 1);
  // biome-ignore lint/style/useDestructuring: mirrors google-owner-account-provider-auth.test.ts
  const tokenCall = fetchStub.calls[0];
  assert.ok(tokenCall, "the exchanger made a token request");
  assert.equal(tokenCall.url, "https://token.aurora.example/token");
  // biome-ignore lint/performance/useTopLevelRegex: mirrors google-owner-account-provider-auth.test.ts
  assert.match(tokenCall.body, /client_id=client-id/);
  // biome-ignore lint/performance/useTopLevelRegex: mirrors google-owner-account-provider-auth.test.ts
  assert.match(tokenCall.body, /client_secret=client-secret/);
});

test("exchangeCode throws when a manifest-declared deployment-config key is unset in env", async () => {
  const exchanger = createOauth2GenericProviderAuthExchanger({
    credentialStoreFactory: noopCredentialStoreFactory,
    env: {},
    fetch: async () => jsonResponse({}),
    manifest: AURORA_MANIFEST,
  });

  await assert.rejects(
    async () =>
      exchanger.exchangeCode({ code: "auth-code", connectorId: "aurora-notes", redirectUri: REDIRECT_URI, state: "s" }),
    Oauth2GenericProviderAuthError
  );
});

test("runInventoryOrTest resolves identity via the manifest-declared userinfo_url", async () => {
  const exchanger = createOauth2GenericProviderAuthExchanger({
    credentialStoreFactory: noopCredentialStoreFactory,
    env: READY_ENV,
    // biome-ignore lint/suspicious/useAwait: matches the injectable FetchLike signature
    fetch: async (url) => {
      assert.equal(url, "https://api.aurora.example/userinfo");
      return jsonResponse({ email: "owner@example.com", id: "aurora-user-1" });
    },
    manifest: AURORA_MANIFEST,
  });

  const accounts = await exchanger.runInventoryOrTest({
    connectorId: "aurora-notes",
    tokens: { accessToken: "at", refreshToken: "rt", tokenKind: "Bearer" },
  });

  assert.equal(accounts.length, 1);
  const [account] = accounts;
  assert.ok(account, "runInventoryOrTest returned an account");
  assert.equal(account.accountId, "aurora-user-1");
  assert.equal(account.displayLabel, "owner@example.com");
});

test("runInventoryOrTest rejects a token bundle with no refresh_token", async () => {
  const exchanger = createOauth2GenericProviderAuthExchanger({
    credentialStoreFactory: noopCredentialStoreFactory,
    env: READY_ENV,
    fetch: async () => jsonResponse({}),
    manifest: AURORA_MANIFEST,
  });

  await assert.rejects(
    () =>
      Promise.resolve(
        exchanger.runInventoryOrTest({
          connectorId: "aurora-notes",
          tokens: { accessToken: "at", tokenKind: "Bearer" },
        })
      ),
    Oauth2GenericProviderAuthError
  );
});

test("storeTokens captures a provider-neutral secret bundle shape (no provider-prefixed field names)", async () => {
  const captured: { secret: string }[] = [];
  const exchanger = createOauth2GenericProviderAuthExchanger({
    credentialStoreFactory: () => ({
      capture: (args) => {
        captured.push({ secret: args.secret });
      },
    }),
    env: READY_ENV,
    fetch: async () => jsonResponse({}),
    manifest: AURORA_MANIFEST,
  });

  await exchanger.storeTokens({
    connectorId: "aurora-notes",
    connectorInstanceId: "inst-1",
    now: "2026-08-07T00:00:00.000Z",
    ownerSubjectId: "owner-1",
    tokens: { accessToken: "at", expiresAt: "2026-08-08T00:00:00.000Z", refreshToken: "rt", tokenKind: "Bearer" },
  });

  assert.equal(captured.length, 1);
  const [capturedEntry] = captured;
  assert.ok(capturedEntry, "storeTokens captured a secret bundle");
  const bundle = JSON.parse(capturedEntry.secret);
  assert.deepEqual(Object.keys(bundle).sort(), ["access_token", "expires_at", "refresh_token", "token_kind"]);
  assert.equal(bundle.access_token, "at");
  assert.equal(bundle.refresh_token, "rt");
});

test("a connectorId that does not match the manifest's declared connector_key is rejected", async () => {
  const exchanger = createOauth2GenericProviderAuthExchanger({
    credentialStoreFactory: noopCredentialStoreFactory,
    env: READY_ENV,
    fetch: async () => jsonResponse({}),
    manifest: AURORA_MANIFEST,
  });

  await assert.rejects(
    async () =>
      exchanger.initiateAuthorization({
        connectorId: "someone-elses-connector",
        redirectUri: REDIRECT_URI,
        state: "s",
      }),
    Oauth2GenericProviderAuthError
  );
});
