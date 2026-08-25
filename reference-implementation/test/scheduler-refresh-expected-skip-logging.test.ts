// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The scheduler's `buildConnectors` skips a schedule row whose connection no
 * longer exists. That skip is expected and fully handled — the row is dropped
 * and the scheduler keeps running — but it used to be reported at warn WITH a
 * full stack, so every boot emitted one stack trace per such row (10 observed
 * on the live deployment). A log level that says "fault" for a non-event trains
 * the reader to ignore the message.
 *
 * `isExpectedMissingConnectorInstance` is the predicate that splits those two
 * cases. These tests pin its contract, because it is the whole basis for
 * choosing debug-without-stack over warn-with-stack:
 *   - the expected missing-connection case is classified as expected;
 *   - every OTHER typed resolution failure (owner mismatch, connector
 *     mismatch, inactive instance, missing selector) stays a real fault;
 *   - a non-resolution error is never swallowed into the quiet path.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  ConnectorInstanceResolutionError,
  isExpectedMissingConnectorInstance,
} from "../server/stores/connector-instance-store.ts";

test("a missing connector instance is the expected, handled skip", () => {
  const err = new ConnectorInstanceResolutionError(
    "connector_instance_not_found",
    "Connector instance 'apple_contacts' does not exist.",
    { connectorId: "apple_contacts", connectorInstanceId: "apple_contacts", ownerSubjectId: "owner_local" }
  );
  assert.equal(isExpectedMissingConnectorInstance(err), true);
});

test("every other typed resolution failure stays a real fault", () => {
  // These are genuine defects: a row pointing at another owner's connection, at
  // a different connector, at a revoked/inactive instance, or carrying no
  // selector at all. None may be demoted to the quiet debug path.
  for (const code of [
    "connector_instance_owner_mismatch",
    "connector_instance_connector_mismatch",
    "connector_instance_inactive",
    "connector_instance_selector_required",
    "ambiguous_connector_instance",
    "owner_subject_required",
    "connector_instance_store_required",
  ]) {
    const err = new ConnectorInstanceResolutionError(code, `simulated ${code}`);
    assert.equal(isExpectedMissingConnectorInstance(err), false, `${code} must stay a warn-level fault`);
  }
});

test("a non-resolution error is never classified as the expected skip", () => {
  // A store/driver failure must not be quietly demoted just because it
  // surfaced on the same code path.
  assert.equal(isExpectedMissingConnectorInstance(new Error("connector_instance_not_found")), false);
  assert.equal(isExpectedMissingConnectorInstance(new TypeError("boom")), false);
  assert.equal(isExpectedMissingConnectorInstance(null), false);
  assert.equal(isExpectedMissingConnectorInstance(undefined), false);
  assert.equal(isExpectedMissingConnectorInstance({ code: "connector_instance_not_found" }), false);
});
