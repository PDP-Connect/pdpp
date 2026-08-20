// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mutation-killing unit tests for the GATING, generic field-resolution, and
 * typed error paths of `resolveProviderAuthRunEnv` in
 * `server/stores/provider-auth-run-credentials.ts`.
 *
 * This module carries zero connector/provider-specific knowledge: gating and
 * field resolution are driven entirely by the caller-supplied
 * `connectionConfig`/`legacyBundleFieldAliases` (sourced from the manifest),
 * never a hardcoded provider literal. This is credential-adjacent (RED-tier)
 * code, but the assertions only OBSERVE behavior — they do not change it.
 * The gating short-circuits are reachable without any real credential store
 * or DB:
 *
 *   - no declared connection_config -> null (nothing to resolve for this
 *     connector's run, regardless of connectorId or binding)
 *   - a source binding that isn't a `provider_auth_account` -> null
 *   - the matching binding + declared connection_config but a MISSING
 *     credential store -> a typed `credential_store_required`
 *     ProviderAuthRunCredentialError
 *   - a recovered credential whose kind is not `secret_bundle` ->
 *     `provider_auth_credential_kind_mismatch`
 *
 * The fail-CLOSED order matters: a mutant that lets a connector with no
 * declared connection_config fall through (touching the store), or that
 * drops the kind-mismatch check, turns red here.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ProviderAuthRunCredentialError,
  resolveProviderAuthRunEnv,
} from "../server/stores/provider-auth-run-credentials.ts";

// A generic provider-auth binding — this module gates on `kind ===
// "provider_auth_account"` only, never on a `provider` value, so the
// `provider` field here is arbitrary test data, not something the module
// branches on.
const GDP_BINDING = { kind: "provider_auth_account", provider: "google_data_portability" };
const FIXTURE_CONNECTION_CONFIG = [{ bundleField: "refresh_token", envVar: "FIXTURE_REFRESH_TOKEN" }];
type ResolveArgs = Parameters<typeof resolveProviderAuthRunEnv>[0];
type CredentialStore = NonNullable<ResolveArgs["credentialStore"]>;
type RecoverSecretArgs = Parameters<CredentialStore["recoverSecret"]>[0];

// A store that must NOT be called for the short-circuit cases; if it is, the
// test fails loudly rather than silently passing.
function poisonStore(): CredentialStore {
  return {
    recoverSecret() {
      throw new Error("recoverSecret must not be called when the connector/binding does not match");
    },
  } as never;
}

test("resolveProviderAuthRunEnv: no declared connection_config short-circuits to null before touching the store", async () => {
  const result = await resolveProviderAuthRunEnv({
    connectionConfig: [],
    connectorId: "github",
    connectorInstanceId: "cin_1",
    credentialStore: poisonStore(),
    ownerSubjectId: "owner",
    sourceBinding: GDP_BINDING,
  });
  assert.equal(result, null);
});

test("resolveProviderAuthRunEnv: a non-provider-auth source binding short-circuits to null even with a declared connection_config", async () => {
  for await (const binding of [
    null,
    {},
    { id: "x", kind: "connector" },
    { kind: "provider_native", provider: "google_data_portability" },
  ]) {
    const result = await resolveProviderAuthRunEnv({
      connectionConfig: FIXTURE_CONNECTION_CONFIG,
      connectorId: "google-maps-data-portability",
      connectorInstanceId: "cin_1",
      credentialStore: poisonStore(),
      ownerSubjectId: "owner",
      sourceBinding: binding,
    });
    assert.equal(result, null, `binding ${JSON.stringify(binding)} must gate to null`);
  }
});

test("resolveProviderAuthRunEnv: matching binding + declared connection_config but NO store -> credential_store_required", async () => {
  await assert.rejects(
    () =>
      resolveProviderAuthRunEnv({
        connectionConfig: FIXTURE_CONNECTION_CONFIG,
        connectorId: "google-maps-data-portability",
        connectorInstanceId: "cin_1",
        credentialStore: null,
        ownerSubjectId: "owner",
        sourceBinding: GDP_BINDING,
      }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderAuthRunCredentialError);
      if (!(err instanceof ProviderAuthRunCredentialError)) {
        return false;
      }
      assert.ok(
        err instanceof ProviderAuthRunCredentialError,
        `expected ProviderAuthRunCredentialError, got ${err.name}`
      );
      assert.equal(err.code, "credential_store_required");
      return true;
    }
  );
});

test("resolveProviderAuthRunEnv: a non-secret_bundle credential kind -> provider_auth_credential_kind_mismatch", async () => {
  let called = false;
  const store = {
    recoverSecret({ connectorInstanceId, ownerSubjectId }: RecoverSecretArgs) {
      called = true;
      // The gating passed the connector-instance + owner through to the store.
      assert.equal(connectorInstanceId, "cin_1");
      assert.equal(ownerSubjectId, "owner");
      return Promise.resolve({ credentialKind: "static_secret", secret: "{}" });
    },
  };

  await assert.rejects(
    () =>
      resolveProviderAuthRunEnv({
        connectionConfig: FIXTURE_CONNECTION_CONFIG,
        connectorId: "google-maps-data-portability",
        connectorInstanceId: "cin_1",
        credentialStore: store,
        ownerSubjectId: "owner",
        sourceBinding: GDP_BINDING,
      }),
    (err: unknown) => {
      assert.ok(err instanceof ProviderAuthRunCredentialError);
      if (!(err instanceof ProviderAuthRunCredentialError)) {
        return false;
      }
      assert.equal(err.code, "provider_auth_credential_kind_mismatch");
      return true;
    }
  );
  assert.ok(called, "the store must have been consulted once the gates passed");
});

test("resolveProviderAuthRunEnv: generic refresh_token field resolves via connection_config", async () => {
  const store = {
    recoverSecret() {
      return Promise.resolve({
        credentialKind: "secret_bundle",
        secret: JSON.stringify({ refresh_token: "rt-generic" }),
      });
    },
  };
  const result = await resolveProviderAuthRunEnv({
    connectionConfig: [{ bundleField: "refresh_token", envVar: "GOOGLE_CALENDAR_REFRESH_TOKEN" }],
    connectorId: "google-calendar",
    connectorInstanceId: "cin_1",
    credentialStore: store,
    ownerSubjectId: "owner",
    sourceBinding: { kind: "provider_auth_account" },
  });
  assert.deepEqual(result, { GOOGLE_CALENDAR_REFRESH_TOKEN: "rt-generic" });
});

test("resolveProviderAuthRunEnv: legacy field name resolves via manifest-declared legacy_bundle_field_aliases when the generic field is absent", async () => {
  const store = {
    recoverSecret() {
      return Promise.resolve({
        credentialKind: "secret_bundle",
        secret: JSON.stringify({ google_owner_account_refresh_token: "rt-legacy" }),
      });
    },
  };
  const result = await resolveProviderAuthRunEnv({
    connectionConfig: [{ bundleField: "refresh_token", envVar: "GOOGLE_CALENDAR_REFRESH_TOKEN" }],
    connectorId: "google-calendar",
    connectorInstanceId: "cin_1",
    credentialStore: store,
    legacyBundleFieldAliases: { refresh_token: "google_owner_account_refresh_token" },
    ownerSubjectId: "owner",
    sourceBinding: { kind: "provider_auth_account" },
  });
  assert.deepEqual(result, { GOOGLE_CALENDAR_REFRESH_TOKEN: "rt-legacy" });
});

test("resolveProviderAuthRunEnv: an optional (required: false) connection_config entry is omitted, not thrown, when its field is absent", async () => {
  const store = {
    recoverSecret() {
      return Promise.resolve({
        credentialKind: "secret_bundle",
        secret: JSON.stringify({ access_token: "at-1" }),
      });
    },
  };
  const result = await resolveProviderAuthRunEnv({
    connectionConfig: [
      { bundleField: "access_token", envVar: "GOOGLE_DATAPORTABILITY_ACCESS_TOKEN" },
      {
        bundleField: "denied_resource_groups",
        envVar: "GOOGLE_DATAPORTABILITY_DENIED_RESOURCE_GROUPS",
        required: false,
      },
    ],
    connectorId: "google-maps-data-portability",
    connectorInstanceId: "cin_1",
    credentialStore: store,
    ownerSubjectId: "owner",
    sourceBinding: { kind: "provider_auth_account" },
  });
  assert.deepEqual(result, { GOOGLE_DATAPORTABILITY_ACCESS_TOKEN: "at-1" });
});
