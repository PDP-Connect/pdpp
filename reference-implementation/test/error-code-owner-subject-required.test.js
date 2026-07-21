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

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConnectorInstanceResolutionError,
  resolveOwnerConnectorInstanceNamespace,
} from '../server/stores/connector-instance-store.js';

const STORE_SENTINEL = { __brand: 'connector-instance-store-sentinel' };

test('resolveOwnerConnectorInstanceNamespace rejects a missing ownerSubjectId with owner_subject_required', async () => {
  for (const ownerSubjectId of [undefined, null, '', 0, false]) {
    await assert.rejects(
      () =>
        resolveOwnerConnectorInstanceNamespace({
          ownerSubjectId,
          connectorId: 'gmail',
          // A store is supplied so the ONLY thing that can be wrong is the owner;
          // this proves the owner guard, not the store guard, fired.
          connectorInstanceStore: STORE_SENTINEL,
        }),
      (err) =>
        err instanceof ConnectorInstanceResolutionError &&
        err.code === 'owner_subject_required',
      `falsy ownerSubjectId ${JSON.stringify(ownerSubjectId)} SHALL raise owner_subject_required`,
    );
  }
});

test('the owner_subject_required check precedes the connector_instance_store check', async () => {
  // Neither owner nor store supplied: the owner guard runs first, so the caller
  // is told about the owner (not the store). This pins the guard ORDER.
  await assert.rejects(
    () =>
      resolveOwnerConnectorInstanceNamespace({
        ownerSubjectId: null,
        connectorId: 'gmail',
        connectorInstanceStore: null,
      }),
    (err) =>
      err instanceof ConnectorInstanceResolutionError &&
      err.code === 'owner_subject_required',
    'with both missing, owner_subject_required SHALL win over connector_instance_store_required',
  );
});

test('a present owner but missing store yields connector_instance_store_required', async () => {
  await assert.rejects(
    () =>
      resolveOwnerConnectorInstanceNamespace({
        ownerSubjectId: 'owner_1',
        connectorId: 'gmail',
        connectorInstanceStore: null,
      }),
    (err) =>
      err instanceof ConnectorInstanceResolutionError &&
      err.code === 'connector_instance_store_required' &&
      err.ownerSubjectId === 'owner_1',
    'a valid owner with no store SHALL raise connector_instance_store_required',
  );
});
