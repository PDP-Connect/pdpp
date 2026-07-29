// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operation-level behavior tests for `rs.connector-state.get`.
 *
 * Pins the validation order, the storage call shape, and the
 * `onGrantResolved` notification ordering.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type {
  RsConnectorStateGetDependencies,
  RsConnectorStateGetGrantScope,
} from "../operations/rs-connector-state-get/index.ts";
import { executeRsConnectorStateGet } from "../operations/rs-connector-state-get/index.ts";

function deps(overrides: Partial<RsConnectorStateGetDependencies> = {}): RsConnectorStateGetDependencies {
  return {
    getSyncState: async () => ({ state: {}, updated_at: null }),
    // biome-ignore lint/suspicious/noEmptyBlockStatements: localized test assertion preserves its explicit contract.
    onGrantResolved: () => {},
    // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
    resolveGrantScope: async () => {
      throw new Error("grant scope resolver should not be called without grantId");
    },
    resolveRegisteredConnectorManifest: async () => ({}),
    ...overrides,
  };
}

test("reads sync state with null grant context when no grantId is supplied", async () => {
  let capturedArgs: { id: string; grantId: string | null; allowedStreams: ReadonlySet<string> | null } | undefined;
  const result = await executeRsConnectorStateGet(
    { connectorId: "gh", grantId: null },
    deps({
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      getSyncState: async (id, args) => {
        capturedArgs = { id, ...args };
        return { state: { messages: { cursor: "abc" } }, updated_at: "t1" };
      },
    })
  );
  assert.deepEqual(capturedArgs, {
    allowedStreams: null,
    grantId: null,
    id: "gh",
  });
  assert.equal(result.grantScope, null);
  assert.equal(result.state.updated_at, "t1");
});

test("passes grant-scope allowedStreams to getSyncState", async () => {
  const grantScope = {
    grantedStreams: new Set(["messages", "events"]),
    grantId: "g1",
  };
  let capturedArgs: { grantId: string | null; allowedStreams: ReadonlySet<string> | null } | undefined;
  const result = await executeRsConnectorStateGet(
    { connectorId: "gh", grantId: "g1" },
    deps({
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      getSyncState: async (_id, args) => {
        capturedArgs = args;
        return { state: {}, updated_at: null };
      },
      resolveGrantScope: async () => grantScope,
    })
  );
  assert.ok(capturedArgs);
  assert.equal(capturedArgs.grantId, "g1");
  assert.equal(capturedArgs.allowedStreams, grantScope.grantedStreams);
  assert.equal(result.grantScope, grantScope);
});

test("invokes onGrantResolved between grant scope resolution and storage read", async () => {
  const order: Array<string | [string, boolean]> = [];
  const grantScope = {
    grantedStreams: new Set(["messages"]),
    grantId: "g1",
  };
  await executeRsConnectorStateGet(
    { connectorId: "gh", grantId: "g1" },
    deps({
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      getSyncState: async () => {
        order.push("state");
        return { state: {}, updated_at: null };
      },
      onGrantResolved: (scope) => {
        order.push(["notify", scope === grantScope]);
      },
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      resolveGrantScope: async () => {
        order.push("grant");
        return grantScope;
      },
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      resolveRegisteredConnectorManifest: async () => {
        order.push("manifest");
        return {};
      },
    })
  );
  assert.deepEqual(order, ["manifest", "grant", ["notify", true], "state"]);
});

test("invokes onGrantResolved with null when no grantId is supplied", async () => {
  let capturedScope: RsConnectorStateGetGrantScope | null | "unset" = "unset";
  await executeRsConnectorStateGet(
    { connectorId: "gh", grantId: null },
    deps({
      onGrantResolved: (scope) => {
        capturedScope = scope;
      },
    })
  );
  assert.equal(capturedScope, null);
});

test("manifest resolver error short-circuits before grant resolution", async () => {
  let grantCalled = false;
  await assert.rejects(
    executeRsConnectorStateGet(
      { connectorId: "gh", grantId: "g1" },
      deps({
        // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
        resolveGrantScope: async () => {
          grantCalled = true;
          return {
            grantedStreams: new Set(),
            grantId: "g1",
          };
        },
        // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
        resolveRegisteredConnectorManifest: async () => {
          const err = new Error("unknown") as Error & { code: string };
          err.code = "not_found";
          throw err;
        },
      })
    ),
    { code: "not_found" }
  );
  assert.equal(grantCalled, false);
});
