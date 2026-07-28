// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operation-level behavior tests for `rs.connector-state.put`.
 *
 * Pins the validation order:
 *   1. manifest resolution
 *   2. grant-scope resolution
 *   3. onGrantResolved notification
 *   4. per-stream manifest membership and grant-scope membership checks
 *   5. storage write
 *
 * Stream-validation failures throw a typed
 * `RsConnectorStatePutValidationError` with the same `code` shape the
 * route adapter previously used (`not_found` for unknown streams,
 * `invalid_request` for streams outside the grant scope).
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { RsConnectorStatePutDependencies } from "../operations/rs-connector-state-put/index.ts";
import {
  executeRsConnectorStatePut,
  RsConnectorStatePutValidationError,
} from "../operations/rs-connector-state-put/index.ts";

function deps(overrides: Partial<RsConnectorStatePutDependencies> = {}): RsConnectorStatePutDependencies {
  return {
    // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
    onGrantResolved: () => {},
    putSyncState: async (_id, map) => ({
      state: map,
      updated_at: "t1",
    }),
    // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
    resolveGrantScope: async () => {
      throw new Error("grant scope resolver should not be called without grantId");
    },
    resolveRegisteredConnectorManifest: async () => ({
      streams: [{ name: "messages" }, { name: "events" }],
    }),
    ...overrides,
  };
}

test("writes sync state with null grant context when no grantId is supplied", async () => {
  let captured:
    | { id: string; map: Record<string, unknown>; grantId: string | null; allowedStreams: ReadonlySet<string> | null }
    | undefined;
  const stateMap = { messages: { cursor: "abc" } };
  const result = await executeRsConnectorStatePut(
    { connectorId: "gh", grantId: null, stateMap },
    deps({
      // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
      putSyncState: async (id, map, args) => {
        captured = { id, map, ...args };
        return { state: map, updated_at: "t1" };
      },
    })
  );
  assert.ok(captured);
  assert.equal(captured.id, "gh");
  assert.equal(captured.map, stateMap);
  assert.equal(captured.grantId, null);
  assert.equal(captured.allowedStreams, null);
  assert.equal(result.grantScope, null);
});

test("passes grant-scope allowedStreams to putSyncState", async () => {
  const grantScope = {
    grantedStreams: new Set(["messages"]),
    grantId: "g1",
  };
  let captured: { grantId: string | null; allowedStreams: ReadonlySet<string> | null } | undefined;
  await executeRsConnectorStatePut(
    {
      connectorId: "gh",
      grantId: "g1",
      stateMap: { messages: { cursor: "abc" } },
    },
    deps({
      // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
      putSyncState: async (_id, _map, args) => {
        captured = args;
        return { state: {}, updated_at: null };
      },
      resolveGrantScope: async () => grantScope,
    })
  );
  assert.ok(captured);
  assert.equal(captured.grantId, "g1");
  assert.equal(captured.allowedStreams, grantScope.grantedStreams);
});

test("rejects unknown manifest streams with not_found typed error", async () => {
  await assert.rejects(
    executeRsConnectorStatePut(
      {
        connectorId: "gh",
        grantId: null,
        stateMap: { ghosts: { cursor: "abc" } },
      },
      deps()
    ),
    (err) => err instanceof RsConnectorStatePutValidationError && err.code === "not_found"
  );
});

test("rejects streams outside the grant scope with invalid_request typed error", async () => {
  await assert.rejects(
    executeRsConnectorStatePut(
      {
        connectorId: "gh",
        grantId: "g1",
        stateMap: { events: { cursor: "abc" } },
      },
      deps({
        resolveGrantScope: async () => ({
          grantedStreams: new Set(["messages"]),
          grantId: "g1",
        }),
      })
    ),
    (err) => err instanceof RsConnectorStatePutValidationError && err.code === "invalid_request"
  );
});

test("invokes onGrantResolved between grant scope resolution and stream validation", async () => {
  const order: string[] = [];
  await executeRsConnectorStatePut(
    {
      connectorId: "gh",
      grantId: "g1",
      stateMap: { messages: { cursor: "abc" } },
    },
    deps({
      onGrantResolved: () => {
        order.push("notify");
      },
      // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
      putSyncState: async () => {
        order.push("write");
        return { state: {}, updated_at: null };
      },
      // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
      resolveGrantScope: async () => {
        order.push("grant");
        return {
          grantedStreams: new Set(["messages"]),
          grantId: "g1",
        };
      },
      // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
      resolveRegisteredConnectorManifest: async () => {
        order.push("manifest");
        return { streams: [{ name: "messages" }] };
      },
    })
  );
  assert.deepEqual(order, ["manifest", "grant", "notify", "write"]);
});

test("does not write sync state when stream validation fails", async () => {
  let writeCalled = false;
  await assert.rejects(
    executeRsConnectorStatePut(
      {
        connectorId: "gh",
        grantId: null,
        stateMap: { unknown: { cursor: "abc" } },
      },
      deps({
        // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
        putSyncState: async () => {
          writeCalled = true;
          return { state: {}, updated_at: null };
        },
      })
    ),
    RsConnectorStatePutValidationError
  );
  assert.equal(writeCalled, false);
});

test("still notifies onGrantResolved before validation failure", async () => {
  let notified = false;
  await assert.rejects(
    executeRsConnectorStatePut(
      {
        connectorId: "gh",
        grantId: null,
        stateMap: { unknown: { cursor: "abc" } },
      },
      deps({
        onGrantResolved: () => {
          notified = true;
        },
      })
    ),
    RsConnectorStatePutValidationError
  );
  assert.equal(notified, true);
});

test("accepts an empty stateMap without storage error", async () => {
  let writeArgs:
    | { id: string; map: Record<string, unknown>; grantId: string | null; allowedStreams: ReadonlySet<string> | null }
    | undefined;
  await executeRsConnectorStatePut(
    { connectorId: "gh", grantId: null, stateMap: {} },
    deps({
      // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
      putSyncState: async (id, map, args) => {
        writeArgs = { id, map, ...args };
        return { state: {}, updated_at: null };
      },
    })
  );
  assert.ok(writeArgs);
  assert.deepEqual(writeArgs.map, {});
});
