// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import type { DeploymentConfigResolver, ProviderAuthManifestLike } from "../../src/provider-auth-adapter.ts";
import { resolveProviderAuthAdapter } from "../../src/provider-auth-adapters.ts";
import { GoogleDataPortabilityProviderAuthError } from "./provider-auth.ts";

const REDIRECT_URI = "https://pdpp.example/_ref/provider-auth/callback";

const MANIFEST: ProviderAuthManifestLike = Object.freeze({
  capabilities: {
    auth: {
      authorization_url: "https://accounts.google.com/o/oauth2/v2/auth",
      deployment_config: [
        { env_alias: "GOOGLE_DATAPORTABILITY_CLIENT_ID", logical_key: "client_id", secret: false },
        { env_alias: "GOOGLE_DATAPORTABILITY_CLIENT_SECRET", logical_key: "client_secret", secret: true },
      ],
      exchanger_kind: "oauth2_access_type_resource_groups",
      resource_groups: ["maps.starred_places", "myactivity.maps"],
      token_url: "https://oauth2.googleapis.com/token",
    },
  },
  connector_key: "google-maps-data-portability",
});

const READY_VALUES: Record<string, string> = {
  client_id: "client-id",
  client_secret: "client-secret",
};

const readyResolver: DeploymentConfigResolver = async ({ logicalKey }) => READY_VALUES[logicalKey] ?? null;

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

test("registers under the oauth2_access_type_resource_groups kind", async () => {
  const adapter = await resolveProviderAuthAdapter("oauth2_access_type_resource_groups");
  assert.ok(adapter, "oauth2_access_type_resource_groups adapter is registered");
});

test("initiateAuthorization builds a Google OAuth URL scoped to the manifest-declared resource groups only", async () => {
  const adapter = await resolveProviderAuthAdapter("oauth2_access_type_resource_groups");
  assert.ok(adapter);

  const result = await adapter.initiateAuthorization({
    deploymentConfigResolver: readyResolver,
    manifest: MANIFEST,
    redirectUri: REDIRECT_URI,
    state: "pas_state",
  });

  const url = new URL(result.authorizationUrl);
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("client_id"), "client-id");
  assert.equal(url.searchParams.get("redirect_uri"), REDIRECT_URI);
  const scope = url.searchParams.get("scope") ?? "";
  assert.match(scope, /dataportability\.maps\.starred_places/);
  assert.match(scope, /dataportability\.myactivity\.maps/);
  assert.doesNotMatch(scope, /gmail|userinfo|timeline/i);
});

test("initiateAuthorization rejects a manifest declaring an unsupported resource group", async () => {
  const adapter = await resolveProviderAuthAdapter("oauth2_access_type_resource_groups");
  assert.ok(adapter);

  const badManifest: ProviderAuthManifestLike = {
    ...MANIFEST,
    capabilities: {
      auth: {
        ...MANIFEST.capabilities?.auth,
        resource_groups: ["not_a_real_resource_group"],
      },
    },
  };

  await assert.rejects(
    async () =>
      adapter.initiateAuthorization({
        deploymentConfigResolver: readyResolver,
        manifest: badManifest,
        redirectUri: REDIRECT_URI,
        state: "s",
      }),
    GoogleDataPortabilityProviderAuthError
  );
});

test("exchangeCode resolves client_id/client_secret via the injected resolver, never a literal env var", async () => {
  const adapter = await resolveProviderAuthAdapter("oauth2_access_type_resource_groups");
  assert.ok(adapter);
  const fetchStub = makeFetch([
    jsonResponse({
      access_token: "ya29.access",
      expires_in: 3600,
      refresh_token: "refresh-token",
      token_type: "Bearer",
    }),
  ]);

  try {
    const tokens = await adapter.exchangeCode({
      code: "oauth-code",
      deploymentConfigResolver: readyResolver,
      manifest: MANIFEST,
      redirectUri: REDIRECT_URI,
      state: "pas_state",
    });

    assert.ok(tokens);
    assert.equal(tokens?.accessToken, "ya29.access");
    assert.equal(tokens?.refreshToken, "refresh-token");
    const [tokenCall] = fetchStub.calls;
    assert.ok(tokenCall);
    assert.equal(tokenCall.url, "https://oauth2.googleapis.com/token");
    assert.match(tokenCall.body, /client_id=client-id/);
    assert.match(tokenCall.body, /client_secret=client-secret/);
  } finally {
    fetchStub.restore();
  }
});

test("runInventoryOrTest computes an access-type snapshot and rejects when nothing requested was authorized", async () => {
  const adapter = await resolveProviderAuthAdapter("oauth2_access_type_resource_groups");
  assert.ok(adapter);
  const fetchStub = makeFetch([jsonResponse({ oneTimeResources: [], timeBasedResources: [] })]);

  try {
    await assert.rejects(
      () =>
        adapter.runInventoryOrTest({
          manifest: MANIFEST,
          tokens: { accessToken: "token-no-access", tokenKind: "Bearer" },
        }),
      (err: unknown) =>
        err instanceof GoogleDataPortabilityProviderAuthError &&
        err.code === "google_dataportability_no_authorized_resources"
    );
  } finally {
    fetchStub.restore();
  }
});

test("runInventoryOrTest returns a fingerprinted account with denied/authorized resource-group sourceBinding and no raw tokens", async () => {
  const adapter = await resolveProviderAuthAdapter("oauth2_access_type_resource_groups");
  assert.ok(adapter);
  const fetchStub = makeFetch([jsonResponse({ oneTimeResources: ["maps.starred_places"], timeBasedResources: [] })]);

  try {
    const tokens = { accessToken: "ya29.inventory-access", refreshToken: "refresh-inventory", tokenKind: "Bearer" };
    const result = await adapter.runInventoryOrTest({ manifest: MANIFEST, tokens });

    assert.equal(result.accounts.length, 1);
    const [account] = result.accounts;
    assert.ok(account);
    assert.match(account.accountId, /^google_dataportability_/);
    assert.deepEqual(account.sourceBinding?.authorized_resource_groups, ["maps.starred_places"]);
    assert.deepEqual(account.sourceBinding?.denied_resource_groups, ["myactivity.maps"]);
    assert.doesNotMatch(JSON.stringify(result.accounts), /ya29\.inventory-access|refresh-inventory/);
  } finally {
    fetchStub.restore();
  }
});

test("runInventoryOrTest's persistenceContext carries only the non-secret access-type snapshot, never a raw token", async () => {
  const adapter = await resolveProviderAuthAdapter("oauth2_access_type_resource_groups");
  assert.ok(adapter);
  const fetchStub = makeFetch([
    jsonResponse({ oneTimeResources: ["maps.starred_places"], timeBasedResources: ["myactivity.maps"] }),
  ]);

  try {
    const tokens = { accessToken: "ya29.context-access", refreshToken: "context-refresh", tokenKind: "Bearer" };
    const result = await adapter.runInventoryOrTest({ manifest: MANIFEST, tokens });

    assert.ok(result.persistenceContext, "a persistenceContext is returned");
    assert.deepEqual(Object.keys(result.persistenceContext).sort(), [
      "deniedResourceGroups",
      "oneTimeResourceGroups",
      "timeBasedResourceGroups",
    ]);
    assert.doesNotMatch(
      JSON.stringify(result.persistenceContext),
      /ya29\.context-access|context-refresh/,
      "the persistenceContext never carries the raw access or refresh token"
    );
  } finally {
    fetchStub.restore();
  }
});

test("storeTokens returns generic (non-prefixed) bundle field names given the persistenceContext from runInventoryOrTest", async () => {
  const adapter = await resolveProviderAuthAdapter("oauth2_access_type_resource_groups");
  assert.ok(adapter);
  const fetchStub = makeFetch([
    jsonResponse({ oneTimeResources: ["maps.starred_places"], timeBasedResources: ["myactivity.maps"] }),
  ]);

  try {
    const tokens = {
      accessToken: "ya29.store-access",
      expiresAt: "2026-08-08T00:00:00.000Z",
      refreshToken: "store-refresh-token",
      tokenKind: "Bearer",
    };
    const { persistenceContext } = await adapter.runInventoryOrTest({ manifest: MANIFEST, tokens });
    assert.ok(persistenceContext);
    const bundle = await adapter.storeTokens({ manifest: MANIFEST, persistenceContext, tokens });

    assert.deepEqual(Object.keys(bundle).sort(), [
      "access_token",
      "authorized_resource_groups",
      "denied_resource_groups",
      "expires_at",
      "one_time_resource_groups",
      "time_based_resource_groups",
      "token_kind",
    ]);
    assert.equal(bundle.access_token, "ya29.store-access");
    assert.equal(bundle.authorized_resource_groups, "maps.starred_places,myactivity.maps");
    assert.ok(
      !Object.keys(bundle).some((key) => key.startsWith("google_dataportability_")),
      "no provider-prefixed field names in the returned bundle"
    );
  } finally {
    fetchStub.restore();
  }
});

test("storeTokens throws when called without a persistenceContext (abandoned flow: runInventoryOrTest never reached, no retained secret state to fall back to)", async () => {
  const adapter = await resolveProviderAuthAdapter("oauth2_access_type_resource_groups");
  assert.ok(adapter);

  await assert.rejects(
    () =>
      adapter.storeTokens({
        manifest: MANIFEST,
        tokens: { accessToken: "never-inventoried", tokenKind: "Bearer" },
      }),
    (err: unknown) =>
      err instanceof GoogleDataPortabilityProviderAuthError && err.code === "google_dataportability_access_type_missing"
  );
});

test("storeTokens fails closed on a malformed persistenceContext instead of trusting its shape", async () => {
  const adapter = await resolveProviderAuthAdapter("oauth2_access_type_resource_groups");
  assert.ok(adapter);

  const malformedContexts = [
    { deniedResourceGroups: "not-an-array", oneTimeResourceGroups: [], timeBasedResourceGroups: [] },
    { oneTimeResourceGroups: [], timeBasedResourceGroups: [] },
    { deniedResourceGroups: [1, 2], oneTimeResourceGroups: [], timeBasedResourceGroups: [] },
    {},
  ];

  for (const persistenceContext of malformedContexts) {
    await assert.rejects(
      () =>
        adapter.storeTokens({
          manifest: MANIFEST,
          persistenceContext,
          tokens: { accessToken: "some-access-token", tokenKind: "Bearer" },
        }),
      (err: unknown) =>
        err instanceof GoogleDataPortabilityProviderAuthError &&
        err.code === "google_dataportability_access_type_missing",
      `expected rejection for context ${JSON.stringify(persistenceContext)}`
    );
  }
});

test("two interleaved flows for different tokens do not cross-talk: each storeTokens only ever sees its own runInventoryOrTest's context", async () => {
  const adapter = await resolveProviderAuthAdapter("oauth2_access_type_resource_groups");
  assert.ok(adapter);
  const fetchStub = makeFetch([
    jsonResponse({ oneTimeResources: ["maps.starred_places"], timeBasedResources: [] }),
    jsonResponse({ oneTimeResources: [], timeBasedResources: ["myactivity.maps"] }),
  ]);

  try {
    const tokensA = { accessToken: "ya29.flow-a", refreshToken: "refresh-a", tokenKind: "Bearer" };
    const tokensB = { accessToken: "ya29.flow-b", refreshToken: "refresh-b", tokenKind: "Bearer" };

    const [resultA, resultB] = await Promise.all([
      adapter.runInventoryOrTest({ manifest: MANIFEST, tokens: tokensA }),
      adapter.runInventoryOrTest({ manifest: MANIFEST, tokens: tokensB }),
    ]);
    const { persistenceContext: contextA } = resultA;
    const { persistenceContext: contextB } = resultB;
    assert.ok(contextA);
    assert.ok(contextB);

    const bundleA = await adapter.storeTokens({
      manifest: MANIFEST,
      persistenceContext: contextA,
      tokens: tokensA,
    });
    const bundleB = await adapter.storeTokens({
      manifest: MANIFEST,
      persistenceContext: contextB,
      tokens: tokensB,
    });

    assert.equal(bundleA.access_token, "ya29.flow-a");
    assert.equal(bundleB.access_token, "ya29.flow-b");
    assert.notEqual(bundleA.authorized_resource_groups, bundleB.authorized_resource_groups);

    // Swapping contexts between flows must not silently succeed with the
    // wrong data — each flow's context is only valid for its own tokens'
    // resource-group facts, proving there is no shared global memo to
    // accidentally read the other flow's state from.
    const swappedBundle = await adapter.storeTokens({
      manifest: MANIFEST,
      persistenceContext: contextB,
      tokens: tokensA,
    });
    assert.equal(swappedBundle.access_token, "ya29.flow-a");
    assert.notEqual(
      swappedBundle.authorized_resource_groups,
      bundleA.authorized_resource_groups,
      "swapping in the other flow's context changes the resulting bundle, proving each flow's context is distinct and independently threaded, not read from shared module state"
    );
  } finally {
    fetchStub.restore();
  }
});
