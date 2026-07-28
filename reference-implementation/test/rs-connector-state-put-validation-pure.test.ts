// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for the connector-state PUT validation in
// operations/rs-connector-state-put/index.ts. No test imports it by name. It
// validates each stream in the submitted state map against the connector manifest
// AND the grant scope before persisting — the write-gate that keeps a client from
// writing sync state for streams it can't see or wasn't granted.
//
// The store/manifest/grant dependencies are stubbed so we exercise the validation
// gates and their typed error codes without a DB.
//
// Mutation surface:
//   - a stream not in the manifest -> RsConnectorStatePutValidationError('not_found').
//   - a stream not in the grant scope (when grant-scoped) ->
//     RsConnectorStatePutValidationError('invalid_request').
//   - a valid state map is persisted via putSyncState with the allowed-streams set.

import assert from "node:assert/strict";
import test from "node:test";

import type {
  RsConnectorStatePutDependencies,
  RsConnectorStatePutErrorCode,
  RsConnectorStatePutGrantScope,
} from "../operations/rs-connector-state-put/index.ts";
import {
  executeRsConnectorStatePut,
  RsConnectorStatePutValidationError,
} from "../operations/rs-connector-state-put/index.ts";

interface PutCall {
  connectorId: string;
  opts: { grantId: string | null; allowedStreams: ReadonlySet<string> | null };
  stateMap: Record<string, unknown>;
}

function makeDeps({
  grantScope = null,
  onPut,
}: {
  grantScope?: RsConnectorStatePutGrantScope | null;
  onPut?: (p: PutCall) => void;
} = {}): RsConnectorStatePutDependencies {
  return {
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
    onGrantResolved: async () => {},
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    putSyncState: async (connectorId, stateMap, opts) => {
      if (onPut) {
        onPut({ connectorId, opts, stateMap });
      }
      return { persisted: stateMap };
    },
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    resolveGrantScope: async () => {
      // executeRsConnectorStatePut only calls this when input.grantId is
      // truthy, and every test that supplies a grantId also supplies a
      // non-null grantScope override, so this branch is unreachable in
      // practice — same pattern as the sibling get/put operation tests.
      if (!grantScope) {
        throw new Error("grant scope resolver should not be called without grantId");
      }
      return grantScope;
    },
    resolveRegisteredConnectorManifest: async () => ({ streams: [{ name: "orders" }, { name: "items" }] }),
  };
}

function expectValidation(promise: Promise<unknown>, code: RsConnectorStatePutErrorCode) {
  return assert.rejects(promise, (err) => {
    assert.ok(err instanceof RsConnectorStatePutValidationError, "typed validation error");
    assert.equal(err.code, code, `expected ${code}, got ${err.code}`);
    return true;
  });
}

test("executeRsConnectorStatePut: a valid state map (no grant) persists", async () => {
  let put: PutCall | undefined;
  const out = await executeRsConnectorStatePut(
    { connectorId: "c", grantId: null, stateMap: { orders: { cursor: "x" } } },
    makeDeps({
      onPut: (p) => {
        put = p;
      },
    })
  );
  assert.deepEqual(out.state, { persisted: { orders: { cursor: "x" } } });
  assert.ok(put);
  assert.equal(put.connectorId, "c");
  assert.equal(put.opts.allowedStreams, null, "no grant -> null allowed-streams");
});

test("executeRsConnectorStatePut: a stream absent from the manifest is not_found", async () => {
  await expectValidation(
    executeRsConnectorStatePut({ connectorId: "c", grantId: null, stateMap: { ghost_stream: {} } }, makeDeps()),
    "not_found"
  );
});

test("executeRsConnectorStatePut: a stream outside the grant scope is invalid_request", async () => {
  await expectValidation(
    executeRsConnectorStatePut(
      { connectorId: "c", grantId: "g", stateMap: { orders: {} } },
      makeDeps({ grantScope: { grantedStreams: new Set(["items"]), grantId: "g" } })
    ),
    "invalid_request"
  );
});

test("executeRsConnectorStatePut: a grant-scoped stream that IS granted persists with the allowed set", async () => {
  let put: PutCall | undefined;
  const out = await executeRsConnectorStatePut(
    { connectorId: "c", grantId: "g", stateMap: { items: { cursor: "y" } } },
    makeDeps({
      grantScope: { grantedStreams: new Set(["items"]), grantId: "g" },
      onPut: (p) => {
        put = p;
      },
    })
  );
  assert.deepEqual(out.state, { persisted: { items: { cursor: "y" } } });
  assert.ok(put);
  assert.ok(put.opts.allowedStreams instanceof Set, "allowed-streams set threaded to the store");
  assert.ok(put.opts.allowedStreams.has("items"));
});

test("executeRsConnectorStatePut: the manifest check runs BEFORE the grant check (unknown stream is not_found even if grant-scoped)", async () => {
  // 'ghost' is not in the manifest AND not in the grant; the manifest gate must fire first.
  await expectValidation(
    executeRsConnectorStatePut(
      { connectorId: "c", grantId: "g", stateMap: { ghost: {} } },
      makeDeps({ grantScope: { grantedStreams: new Set(["items"]), grantId: "g" } })
    ),
    "not_found"
  );
});
