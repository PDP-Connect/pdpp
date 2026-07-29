// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mutation-killing coverage for the `owner_subject_required` typed-error code
 * (server/routes/ref-error-status.ts: `owner_subject_required: 400`) and the
 * adjacent `connector_instance_store_required` precondition on the exported
 * `resolveOwnerConnectorInstanceNamespace`.
 *
 * `resolveOwnerConnectorInstanceNamespace` validates its arguments BEFORE any
 * storage access: a missing/falsy `ownerSubjectId` yields a
 * `ConnectorInstanceResolutionError` with code `owner_subject_required`, and —
 * only once an owner is present — a missing `connectorInstanceStore` yields code
 * `connector_instance_store_required`. This ordering matters: the owner check
 * fires first so a caller that supplies neither is told about the owner, not
 * the store.
 *
 * Prior to this test no `test/` file exercised `owner_subject_required` by name,
 * so a mutation dropping or reordering the owner guard (or corrupting the code
 * string) went undetected. These are pure argument-precondition assertions and
 * require no database or server boot.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ConnectorInstanceResolutionError,
  resolveOwnerConnectorInstanceNamespace,
} from "../server/stores/connector-instance-store.ts";

const STORE_SENTINEL = { __brand: "connector-instance-store-sentinel" };

function hasOwnerSubjectId(err: unknown): err is { ownerSubjectId: unknown } {
  return typeof err === "object" && err !== null && "ownerSubjectId" in err;
}

test("resolveOwnerConnectorInstanceNamespace rejects a missing ownerSubjectId with owner_subject_required", async () => {
  for await (const ownerSubjectId of [undefined, null, "", 0, false]) {
    await assert.rejects(
      () =>
        resolveOwnerConnectorInstanceNamespace({
          connectorId: "gmail",
          // A store is supplied so the ONLY thing that can be wrong is the owner;
          // this proves the owner guard, not the store guard, fired.
          // @ts-expect-error deliberately-mismatched store shape — the guard fires before the store is used.
          connectorInstanceStore: STORE_SENTINEL,
          // @ts-expect-error deliberately-invalid ownerSubjectId — the test proves the runtime guard rejects it.
          ownerSubjectId,
        }),
      (err) => err instanceof ConnectorInstanceResolutionError && err.code === "owner_subject_required",
      `falsy ownerSubjectId ${JSON.stringify(ownerSubjectId)} SHALL raise owner_subject_required`
    );
  }
});

test("the owner_subject_required check precedes the connector_instance_store check", async () => {
  // Neither owner nor store supplied: the owner guard runs first, so the caller
  // is told about the owner (not the store). This pins the guard ORDER.
  await assert.rejects(
    () =>
      resolveOwnerConnectorInstanceNamespace({
        connectorId: "gmail",
        // @ts-expect-error deliberately-missing store — the owner guard is proven to fire first.
        connectorInstanceStore: null,
        // @ts-expect-error deliberately-invalid ownerSubjectId — the test proves the runtime guard rejects it.
        ownerSubjectId: null,
      }),
    (err) => err instanceof ConnectorInstanceResolutionError && err.code === "owner_subject_required",
    "with both missing, owner_subject_required SHALL win over connector_instance_store_required"
  );
});

test("a present owner but missing store yields connector_instance_store_required", async () => {
  await assert.rejects(
    () =>
      resolveOwnerConnectorInstanceNamespace({
        connectorId: "gmail",
        // @ts-expect-error deliberately-missing store — the test proves the runtime guard rejects it.
        connectorInstanceStore: null,
        ownerSubjectId: "owner_1",
      }),
    (err) =>
      err instanceof ConnectorInstanceResolutionError &&
      err.code === "connector_instance_store_required" &&
      hasOwnerSubjectId(err) &&
      err.ownerSubjectId === "owner_1",
    "a valid owner with no store SHALL raise connector_instance_store_required"
  );
});
