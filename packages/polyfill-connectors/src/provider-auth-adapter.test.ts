// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { type ProviderAuthAdapter, registerProviderAuthAdapter } from "./provider-auth-adapter.ts";
import { _resetProviderAuthAdapterRegistryForTests, resolveProviderAuthAdapter } from "./provider-auth-adapters.ts";

const STUB_ADAPTER: ProviderAuthAdapter = {
  exchangeCode: async () => null,
  initiateAuthorization: async () => ({ authorizationUrl: "https://example.test/authorize" }),
  runInventoryOrTest: async () => ({ accounts: [] }),
  storeTokens: async () => ({}),
};

test("resolveProviderAuthAdapter eagerly loads the fixed adapter module list and resolves the real registered kinds", async () => {
  const oauth2Generic = await resolveProviderAuthAdapter("oauth2_generic");
  assert.ok(oauth2Generic, "oauth2_generic is registered from provider-auth-adapters.ts's adapter list");

  const googleDataPortability = await resolveProviderAuthAdapter("oauth2_access_type_resource_groups");
  assert.ok(
    googleDataPortability,
    "oauth2_access_type_resource_groups is registered by the google_maps_data_portability connector's module-load side effect"
  );
});

test("resolveProviderAuthAdapter returns null for an unregistered kind", async () => {
  const resolved = await resolveProviderAuthAdapter("no_such_kind_anywhere");
  assert.equal(resolved, null);
});

test("resolveProviderAuthAdapter is independent of call order — resolving an unknown kind first does not prevent a later real kind from resolving", async () => {
  const first = await resolveProviderAuthAdapter("still_not_a_real_kind");
  assert.equal(first, null);
  const second = await resolveProviderAuthAdapter("oauth2_generic");
  assert.ok(second);
});

test("registerProviderAuthAdapter throws on a duplicate kind instead of silently overwriting", () => {
  _resetProviderAuthAdapterRegistryForTests();
  try {
    registerProviderAuthAdapter("duplicate_kind_test", STUB_ADAPTER);
    assert.throws(
      () => registerProviderAuthAdapter("duplicate_kind_test", STUB_ADAPTER),
      /provider_auth_adapter_kind_duplicate: duplicate_kind_test/
    );
  } finally {
    _resetProviderAuthAdapterRegistryForTests();
  }
});
