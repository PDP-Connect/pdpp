// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for the pure exports of server/connector-run-evidence.ts.
// No test imports this module by name. These extract the connector-run evidence
// storage connector id and the manifest refresh-policy / staleness bound used by schema +
// freshness projection and scheduler admission. (getLatestConnectorRunSummary is
// async spine-backed and out of scope here.)
//
// Mutation surface:
//   getConnectorRunEvidenceConnectorId -- trusted storage connector id -> id,
//     else null (empty / missing / non-string -> null).
//   getManifestRefreshPolicy -- capabilities must be a plain object, else null;
//     returns capabilities.refresh_policy ?? null.
//   getMaximumStalenessSeconds -- a positive finite number -> value, else null
//     (zero, negative, non-number, non-finite -> null).

import assert from "node:assert/strict";
import test from "node:test";

import {
  getConnectorRunEvidenceConnectorId,
  getManifestRefreshPolicy,
  getMaximumStalenessSeconds,
} from "../server/connector-run-evidence.ts";

// ---------------------------------------------------------------------------
// getConnectorRunEvidenceConnectorId
// ---------------------------------------------------------------------------

test("getConnectorRunEvidenceConnectorId: a storage binding with a non-empty connector_id yields the id", () => {
  assert.equal(getConnectorRunEvidenceConnectorId({ connector_id: "amazon" }), "amazon");
});

test("getConnectorRunEvidenceConnectorId: empty, missing, or non-string connector_id -> null", () => {
  assert.equal(getConnectorRunEvidenceConnectorId({ connector_id: "" }), null, "empty id -> null");
  assert.equal(getConnectorRunEvidenceConnectorId({}), null, "missing id -> null");
  assert.equal(getConnectorRunEvidenceConnectorId(null), null);
  assert.equal(getConnectorRunEvidenceConnectorId({ connector_id: 42 }), null, "non-string id -> null");
});

// ---------------------------------------------------------------------------
// getManifestRefreshPolicy
// ---------------------------------------------------------------------------

test("getManifestRefreshPolicy: returns capabilities.refresh_policy when capabilities is a plain object", () => {
  const policy = { recommended_mode: "automatic" };
  assert.equal(getManifestRefreshPolicy({ capabilities: { refresh_policy: policy } }), policy);
});

test("getManifestRefreshPolicy: missing capabilities / refresh_policy -> null", () => {
  assert.equal(getManifestRefreshPolicy({ capabilities: {} }), null, "no refresh_policy -> null");
  assert.equal(getManifestRefreshPolicy({}), null, "no capabilities -> null");
  assert.equal(getManifestRefreshPolicy(null), null);
});

test("getManifestRefreshPolicy: an array-shaped capabilities is rejected (not a plain object)", () => {
  assert.equal(getManifestRefreshPolicy({ capabilities: [] }), null);
});

// ---------------------------------------------------------------------------
// getMaximumStalenessSeconds
// ---------------------------------------------------------------------------

test("getMaximumStalenessSeconds: a positive finite number passes through", () => {
  assert.equal(getMaximumStalenessSeconds({ maximum_staleness_seconds: 3600 }), 3600);
  assert.equal(getMaximumStalenessSeconds({ maximum_staleness_seconds: 1 }), 1);
});

test("getMaximumStalenessSeconds: zero, negative, non-number, or non-finite -> null", () => {
  assert.equal(getMaximumStalenessSeconds({ maximum_staleness_seconds: 0 }), null, "zero is not positive");
  assert.equal(getMaximumStalenessSeconds({ maximum_staleness_seconds: -5 }), null);
  assert.equal(getMaximumStalenessSeconds({ maximum_staleness_seconds: "3600" }), null, "string -> null");
  assert.equal(getMaximumStalenessSeconds({ maximum_staleness_seconds: Number.POSITIVE_INFINITY }), null);
  assert.equal(getMaximumStalenessSeconds({ maximum_staleness_seconds: Number.NaN }), null);
  assert.equal(getMaximumStalenessSeconds({}), null, "absent -> null");
  assert.equal(getMaximumStalenessSeconds(null), null);
});
