// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `createGenericProviderAuthDispatch` (generic-dispatch.ts),
 * the manifest-driven `ProviderAuthExchanger` that dispatches to a
 * connector-owned `ProviderAuthAdapter` by `exchanger_kind`.
 *
 * Focus: the dispatcher must hold NO per-flow state of its own (no
 * module-scope map keyed by access token or anything else). `persistenceContext`
 * crosses the runInventoryOrTest -> storeTokens gap only through
 * `ProviderAccount.sourceBinding`, which `ref-provider-auth.ts` already
 * threads back on `storeTokens`'s call args within the same request — so two
 * interleaved or abandoned flows can never contaminate each other, because
 * there is nothing shared for them to contaminate.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  type ProviderAuthAdapter,
  registerProviderAuthAdapter,
} from "../../packages/polyfill-connectors/src/provider-auth-adapter.ts";
import { createGenericProviderAuthDispatch } from "../server/provider-auth/generic-dispatch.ts";

const TEST_KIND = "generic_dispatch_test_kind__unit_only";

const capturedSecrets: { connectorInstanceId: string; secret: string }[] = [];

function fixtureManifest(connectorId: string) {
  return {
    capabilities: { auth: { exchanger_kind: TEST_KIND } },
    connector_id: connectorId,
  };
}

// A stub adapter whose runInventoryOrTest hands back a distinct
// persistenceContext PER ACCOUNT (keyed by accountId), so a test can prove
// storeTokens receives exactly the context for the account it was called
// for — never another concurrently in-flight account's context.
const stubAdapter: ProviderAuthAdapter = {
  exchangeCode: async () => ({ accessToken: "tok", tokenKind: "Bearer" }),
  initiateAuthorization: async () => ({ authorizationUrl: "https://example.test/authorize" }),
  async runInventoryOrTest({ tokens }) {
    return {
      accounts: [
        {
          accountId: `account_for_${tokens.accessToken}`,
          sourceBinding: { seed: tokens.accessToken },
        },
      ],
      persistenceContext: { flow_marker: `context_for_${tokens.accessToken}` },
    };
  },
  async storeTokens({ persistenceContext }) {
    return { flow_marker_seen: String(persistenceContext?.flow_marker ?? "MISSING") };
  },
};

registerProviderAuthAdapter(TEST_KIND, stubAdapter);

function buildDispatch() {
  return createGenericProviderAuthDispatch({
    credentialStoreFactory: () => ({
      capture: (args) => {
        capturedSecrets.push({ connectorInstanceId: args.connectorInstanceId, secret: args.secret });
      },
    }),
    deploymentConfigResolver: async () => "configured-value",
    resolveManifest: (connectorId) => Promise.resolve(fixtureManifest(connectorId)),
  });
}

test("storeTokens receives exactly the persistenceContext for its own account, threaded via sourceBinding — not a shared/global value", async () => {
  capturedSecrets.length = 0;
  const dispatch = buildDispatch();

  const accountsA = await dispatch.runInventoryOrTest({
    connectorId: "c1",
    tokens: { accessToken: "token-A", tokenKind: "Bearer" },
  });
  const accountsB = await dispatch.runInventoryOrTest({
    connectorId: "c1",
    tokens: { accessToken: "token-B", tokenKind: "Bearer" },
  });

  // Two interleaved flows: call storeTokens for B before A, proving order
  // doesn't matter because nothing is retained between the two calls.
  await dispatch.storeTokens({
    connectorId: "c1",
    connectorInstanceId: "inst-B",
    now: "2026-08-09T00:00:00.000Z",
    ownerSubjectId: "owner-1",
    sourceBinding: accountsB[0]?.sourceBinding ?? null,
    tokens: { accessToken: "token-B", tokenKind: "Bearer" },
  });
  await dispatch.storeTokens({
    connectorId: "c1",
    connectorInstanceId: "inst-A",
    now: "2026-08-09T00:00:00.000Z",
    ownerSubjectId: "owner-1",
    sourceBinding: accountsA[0]?.sourceBinding ?? null,
    tokens: { accessToken: "token-A", tokenKind: "Bearer" },
  });

  const secretForA = capturedSecrets.find((s) => s.connectorInstanceId === "inst-A");
  const secretForB = capturedSecrets.find((s) => s.connectorInstanceId === "inst-B");
  assert.ok(secretForA && JSON.parse(secretForA.secret).flow_marker_seen === "context_for_token-A");
  assert.ok(secretForB && JSON.parse(secretForB.secret).flow_marker_seen === "context_for_token-B");
});

test("an abandoned flow (runInventoryOrTest called, storeTokens never called) leaves nothing for a later unrelated flow to pick up", async () => {
  capturedSecrets.length = 0;
  const dispatch = buildDispatch();

  // Abandoned: inventory runs, but the caller never proceeds to storeTokens
  // (e.g. the owner closed the tab, or a later step in the callback threw).
  await dispatch.runInventoryOrTest({
    connectorId: "c1",
    tokens: { accessToken: "abandoned-token", tokenKind: "Bearer" },
  });

  // A later, unrelated flow reusing a token value must get its OWN context,
  // never a leftover from the abandoned flow above.
  const laterAccounts = await dispatch.runInventoryOrTest({
    connectorId: "c1",
    tokens: { accessToken: "later-token", tokenKind: "Bearer" },
  });
  await dispatch.storeTokens({
    connectorId: "c1",
    connectorInstanceId: "inst-later",
    now: "2026-08-09T00:00:00.000Z",
    ownerSubjectId: "owner-1",
    sourceBinding: laterAccounts[0]?.sourceBinding ?? null,
    tokens: { accessToken: "later-token", tokenKind: "Bearer" },
  });

  const secret = capturedSecrets.find((s) => s.connectorInstanceId === "inst-later");
  assert.ok(secret && JSON.parse(secret.secret).flow_marker_seen === "context_for_later-token");
});

test("N concurrent runInventoryOrTest+storeTokens flows, run via Promise.all with no ordering guarantee, never cross-contaminate each other's persistenceContext", async () => {
  capturedSecrets.length = 0;
  const dispatch = buildDispatch();
  const flowCount = 25;
  const tokenFor = (i: number) => `concurrent-token-${i}`;
  const instanceFor = (i: number) => `inst-concurrent-${i}`;

  // Every flow's own runInventoryOrTest -> storeTokens pair runs inside ONE
  // async function passed to Promise.all, so the JS event loop is free to
  // interleave these flows' internal awaits in any order — this is the
  // shape a real burst of concurrent OAuth callbacks takes (N owners
  // completing consent around the same time), unlike the sequential
  // call-then-call tests above.
  await Promise.all(
    Array.from({ length: flowCount }, (_, i) => async () => {
      const token = tokenFor(i);
      const accounts = await dispatch.runInventoryOrTest({
        connectorId: "c1",
        tokens: { accessToken: token, tokenKind: "Bearer" },
      });
      await dispatch.storeTokens({
        connectorId: "c1",
        connectorInstanceId: instanceFor(i),
        now: "2026-08-09T00:00:00.000Z",
        ownerSubjectId: `owner-${i}`,
        sourceBinding: accounts[0]?.sourceBinding ?? null,
        tokens: { accessToken: token, tokenKind: "Bearer" },
      });
    }).map((thunk) => thunk())
  );

  assert.equal(capturedSecrets.length, flowCount, "every concurrent flow's storeTokens call landed exactly once");
  for (let i = 0; i < flowCount; i++) {
    const secret = capturedSecrets.find((s) => s.connectorInstanceId === instanceFor(i));
    assert.ok(secret, `flow ${i} captured a secret`);
    assert.equal(
      JSON.parse(secret.secret).flow_marker_seen,
      `context_for_${tokenFor(i)}`,
      `flow ${i} must see its OWN persistenceContext, never another concurrently-running flow's`
    );
  }
});

test("storeTokens with no sourceBinding (e.g. a hand-rolled test exchanger call) does not throw — persistenceContext is simply absent", async () => {
  capturedSecrets.length = 0;
  const dispatch = buildDispatch();
  await dispatch.storeTokens({
    connectorId: "c1",
    connectorInstanceId: "inst-no-binding",
    now: "2026-08-09T00:00:00.000Z",
    ownerSubjectId: "owner-1",
    tokens: { accessToken: "token-no-binding", tokenKind: "Bearer" },
  });
  const secret = capturedSecrets.find((s) => s.connectorInstanceId === "inst-no-binding");
  assert.ok(secret && JSON.parse(secret.secret).flow_marker_seen === "MISSING");
});
