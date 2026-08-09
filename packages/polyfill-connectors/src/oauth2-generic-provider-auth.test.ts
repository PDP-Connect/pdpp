// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { Oauth2GenericProviderAuthError } from "./oauth2-generic-provider-auth.ts";
import type { DeploymentConfigResolver, ProviderAuthManifestLike } from "./provider-auth-adapter.ts";
import { resolveProviderAuthAdapter } from "./provider-auth-adapters.ts";

// This fixture is deliberately named after a fictional provider ("Aurora"),
// not a real one — the adapter must behave identically regardless of which
// provider's shape the manifest describes. Swap this fixture for a
// Google-shaped one and every assertion below should still pass unchanged.
const AURORA_MANIFEST: ProviderAuthManifestLike = Object.freeze({
  capabilities: {
    auth: {
      authorization_params: { access_type: "offline", prompt: "consent" },
      authorization_url: "https://auth.aurora.example/o/oauth2/v2/auth",
      deployment_config: [
        { env_alias: "AURORA_OAUTH_CLIENT_ID", label: "OAuth client ID", logical_key: "client_id", secret: false },
        {
          env_alias: "AURORA_OAUTH_CLIENT_SECRET",
          label: "OAuth client secret",
          logical_key: "client_secret",
          secret: true,
        },
      ],
      exchanger_kind: "oauth2_generic",
      scopes: ["https://api.aurora.example/scopes/notes.readonly"],
      token_url: "https://token.aurora.example/token",
      userinfo_url: "https://api.aurora.example/userinfo",
    },
  },
  connector_key: "aurora-notes",
});

const REDIRECT_URI = "https://pdpp.example/_ref/provider-auth/callback";

const READY_VALUES: Record<string, string> = {
  client_id: "client-id",
  client_secret: "client-secret",
};

const readyResolver: DeploymentConfigResolver = async ({ logicalKey }) => READY_VALUES[logicalKey] ?? null;

const emptyResolver: DeploymentConfigResolver = async () => null;

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
  const originalFetch = globalThis.fetch;
  // biome-ignore lint/suspicious/useAwait: must be async to satisfy the fetch signature it stands in for; the stub resolves from a pre-seeded queue.
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      body: init.body ? String(init.body) : "",
      headers: new Headers(init.headers),
      method: init.method ?? "GET",
      url: String(url),
    });
    const response = queue.shift();
    assert.ok(response, `unexpected fetch call to ${url}`);
    return response;
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

test("registers under the oauth2_generic kind", async () => {
  const adapter = await resolveProviderAuthAdapter("oauth2_generic");
  assert.ok(adapter, "oauth2_generic adapter is registered");
});

test("initiateAuthorization builds an authorization URL from the manifest and applies only manifest-declared authorization_params, no implicit defaults", async () => {
  const adapter = await resolveProviderAuthAdapter("oauth2_generic");
  assert.ok(adapter);

  const result = await adapter.initiateAuthorization({
    deploymentConfigResolver: readyResolver,
    manifest: AURORA_MANIFEST,
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
  assert.equal(url.searchParams.get("prompt"), "consent");
});

test("initiateAuthorization applies no authorization_params at all when the manifest declares none", async () => {
  const adapter = await resolveProviderAuthAdapter("oauth2_generic");
  assert.ok(adapter);

  const manifestWithoutParams: ProviderAuthManifestLike = {
    capabilities: {
      auth: {
        authorization_url: "https://auth.aurora.example/o/oauth2/v2/auth",
        deployment_config: [{ logical_key: "client_id" }, { logical_key: "client_secret" }],
        scopes: [],
        token_url: "https://token.aurora.example/token",
      },
    },
    connector_key: "aurora-notes",
  };

  const result = await adapter.initiateAuthorization({
    deploymentConfigResolver: readyResolver,
    manifest: manifestWithoutParams,
    redirectUri: REDIRECT_URI,
    state: "s",
  });

  const url = new URL(result.authorizationUrl);
  assert.equal(url.searchParams.get("access_type"), null, "no implicit access_type default");
  assert.equal(url.searchParams.get("prompt"), null, "no implicit prompt default");
  assert.equal(url.searchParams.get("include_granted_scopes"), null, "no implicit include_granted_scopes default");
});

test("initiateAuthorization passes include_granted_scopes through verbatim as a plain authorization_params entry — a REPLACE of the requested scope list, never a union computed by this adapter", async () => {
  const adapter = await resolveProviderAuthAdapter("oauth2_generic");
  assert.ok(adapter);

  const sharedIdentityManifest: ProviderAuthManifestLike = {
    ...AURORA_MANIFEST,
    capabilities: {
      auth: {
        ...AURORA_MANIFEST.capabilities?.auth,
        authorization_params: { include_granted_scopes: "true" },
        // Two connectors sharing one provider_identity_group each run their
        // own separate consent flow; include_granted_scopes: "true" is how
        // the SECOND flow avoids the provider silently narrowing the FIRST
        // flow's already-granted scope on the same account.
        provider_identity_group: "aurora-shared-app",
        scopes: ["https://api.aurora.example/scopes/second-connector.readonly"],
      },
    },
  };

  const result = await adapter.initiateAuthorization({
    deploymentConfigResolver: readyResolver,
    manifest: sharedIdentityManifest,
    redirectUri: REDIRECT_URI,
    state: "s",
  });

  const url = new URL(result.authorizationUrl);
  assert.equal(url.searchParams.get("include_granted_scopes"), "true");
  assert.equal(
    url.searchParams.get("scope"),
    "https://api.aurora.example/scopes/second-connector.readonly",
    "scope is always this connector's own declared list, never merged with any other connector's scopes locally"
  );
});

test("initiateAuthorization throws when the manifest omits authorization_url", async () => {
  const adapter = await resolveProviderAuthAdapter("oauth2_generic");
  assert.ok(adapter);

  const manifest: ProviderAuthManifestLike = {
    capabilities: {
      auth: {
        deployment_config: [{ logical_key: "client_id" }, { logical_key: "client_secret" }],
        token_url: "https://token.aurora.example/token",
      },
    },
    connector_key: "aurora-notes",
  };

  await assert.rejects(
    async () =>
      adapter.initiateAuthorization({
        deploymentConfigResolver: readyResolver,
        manifest,
        redirectUri: REDIRECT_URI,
        state: "s",
      }),
    Oauth2GenericProviderAuthError
  );
});

test("exchangeCode resolves deployment values via the injected resolver by logical_key, never a literal env var", async () => {
  const adapter = await resolveProviderAuthAdapter("oauth2_generic");
  assert.ok(adapter);
  const fetchStub = makeFetch([
    jsonResponse({ access_token: "at", expires_in: 3600, refresh_token: "rt", token_type: "Bearer" }),
  ]);
  const seenArgs: { envAlias?: string | null; identityGroup: string; logicalKey: string }[] = [];
  // biome-ignore lint/suspicious/useAwait: implements the Promise-returning DeploymentConfigResolver contract; this stub resolves synchronously.
  const trackingResolver: DeploymentConfigResolver = async (args) => {
    seenArgs.push(args);
    return READY_VALUES[args.logicalKey] ?? null;
  };

  try {
    const tokens = await adapter.exchangeCode({
      code: "auth-code",
      deploymentConfigResolver: trackingResolver,
      manifest: AURORA_MANIFEST,
      redirectUri: REDIRECT_URI,
      state: "s",
    });

    assert.ok(tokens);
    assert.equal(tokens?.accessToken, "at");
    assert.equal(tokens?.refreshToken, "rt");
    assert.equal(fetchStub.calls.length, 1);
    const [tokenCall] = fetchStub.calls;
    assert.ok(tokenCall);
    assert.equal(tokenCall.url, "https://token.aurora.example/token");
    assert.match(tokenCall.body, /client_id=client-id/);
    assert.match(tokenCall.body, /client_secret=client-secret/);
    assert.deepEqual(
      seenArgs.map((a) => a.logicalKey).sort((left, right) => left.localeCompare(right)),
      ["client_id", "client_secret"]
    );
    assert.ok(
      seenArgs.every((a) => a.envAlias === "AURORA_OAUTH_CLIENT_ID" || a.envAlias === "AURORA_OAUTH_CLIENT_SECRET")
    );
  } finally {
    fetchStub.restore();
  }
});

test("exchangeCode throws when the resolver has no value for a manifest-declared deployment-config key", async () => {
  const adapter = await resolveProviderAuthAdapter("oauth2_generic");
  assert.ok(adapter);

  await assert.rejects(
    async () =>
      adapter.exchangeCode({
        code: "auth-code",
        deploymentConfigResolver: emptyResolver,
        manifest: AURORA_MANIFEST,
        redirectUri: REDIRECT_URI,
        state: "s",
      }),
    Oauth2GenericProviderAuthError
  );
});

test("runInventoryOrTest resolves identity via the manifest-declared userinfo_url", async () => {
  const adapter = await resolveProviderAuthAdapter("oauth2_generic");
  assert.ok(adapter);
  const fetchStub = makeFetch([jsonResponse({ email: "owner@example.com", id: "aurora-user-1" })]);

  try {
    const result = await adapter.runInventoryOrTest({
      manifest: AURORA_MANIFEST,
      tokens: { accessToken: "at", refreshToken: "rt", tokenKind: "Bearer" },
    });

    assert.equal(result.accounts.length, 1);
    const [account] = result.accounts;
    assert.ok(account);
    assert.equal(account.accountId, "aurora-user-1");
    assert.equal(account.displayLabel, "owner@example.com");
    assert.equal(fetchStub.calls[0]?.url, "https://api.aurora.example/userinfo");
    assert.equal(result.persistenceContext, undefined, "the generic adapter carries no persistence context");
  } finally {
    fetchStub.restore();
  }
});

test("storeTokens ignores any persistenceContext (the generic adapter's shape is unaffected by the per-flow context change)", async () => {
  const adapter = await resolveProviderAuthAdapter("oauth2_generic");
  assert.ok(adapter);

  const bundle = await adapter.storeTokens({
    manifest: AURORA_MANIFEST,
    persistenceContext: { unexpected: "value" },
    tokens: { accessToken: "at", expiresAt: "2026-08-08T00:00:00.000Z", refreshToken: "rt", tokenKind: "Bearer" },
  });

  assert.deepEqual(Object.keys(bundle).sort(), ["access_token", "expires_at", "refresh_token", "token_kind"]);
});

test("runInventoryOrTest rejects a token bundle with no refresh_token", async () => {
  const adapter = await resolveProviderAuthAdapter("oauth2_generic");
  assert.ok(adapter);

  await assert.rejects(
    () =>
      adapter.runInventoryOrTest({
        manifest: AURORA_MANIFEST,
        tokens: { accessToken: "at", tokenKind: "Bearer" },
      }),
    Oauth2GenericProviderAuthError
  );
});

test("storeTokens returns a provider-neutral bundle shape (no provider-prefixed field names), and leaves persistence to the caller", async () => {
  const adapter = await resolveProviderAuthAdapter("oauth2_generic");
  assert.ok(adapter);

  const bundle = await adapter.storeTokens({
    manifest: AURORA_MANIFEST,
    tokens: { accessToken: "at", expiresAt: "2026-08-08T00:00:00.000Z", refreshToken: "rt", tokenKind: "Bearer" },
  });

  assert.deepEqual(Object.keys(bundle).sort(), ["access_token", "expires_at", "refresh_token", "token_kind"]);
  assert.equal(bundle.access_token, "at");
  assert.equal(bundle.refresh_token, "rt");
});
