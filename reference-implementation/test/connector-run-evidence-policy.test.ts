// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mutation-killing unit tests for the pure refresh-policy / run-evidence
 * projection helpers in `server/connector-run-evidence.ts`. No test imports
 * this module by name.
 *
 *   - getConnectorRunEvidenceConnectorId (returns the id only from a trusted
 *                                         storage binding with a non-empty connector id)
 *   - getManifestRefreshPolicy      (reads capabilities.refresh_policy, with a
 *                                    strict object guard on capabilities)
 *   - getMaximumStalenessSeconds    (accepts a positive finite number only;
 *                                    rejects 0, negatives, NaN, Infinity, and
 *                                    non-numbers)
 *
 * The `value > 0` and finiteness boundary is the key: a mutant that relaxes
 * `> 0` to `>= 0` (accepting a zero staleness budget) or drops the finiteness
 * check turns red here.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  getConnectorRunEvidenceConnectorId,
  getManifestRefreshPolicy,
  getMaximumStalenessSeconds,
} from "../server/connector-run-evidence.ts";

test("getConnectorRunEvidenceConnectorId: storage connector id + non-empty string id -> id, else null", () => {
  assert.equal(getConnectorRunEvidenceConnectorId({ connector_id: "github" }), "github");

  // Missing / empty / non-string id -> null.
  assert.equal(getConnectorRunEvidenceConnectorId({ connector_id: "" }), null);
  assert.equal(getConnectorRunEvidenceConnectorId({}), null);
  assert.equal(getConnectorRunEvidenceConnectorId({ connector_id: 42 }), null);
  // Null-ish storage binding -> null (optional-chaining guard).
  assert.equal(getConnectorRunEvidenceConnectorId(null), null);
  assert.equal(getConnectorRunEvidenceConnectorId(undefined), null);
});

test("getManifestRefreshPolicy: reads capabilities.refresh_policy behind a strict object guard", () => {
  const policy = { maximum_staleness_seconds: 3600 };
  assert.deepEqual(getManifestRefreshPolicy({ capabilities: { refresh_policy: policy } }), policy);

  // No refresh_policy member -> null (?? fallback).
  assert.equal(getManifestRefreshPolicy({ capabilities: {} }), null);
  // Missing / non-object / array capabilities -> null.
  assert.equal(getManifestRefreshPolicy({}), null);
  assert.equal(getManifestRefreshPolicy(null), null);
  assert.equal(getManifestRefreshPolicy({ capabilities: "x" }), null);
  assert.equal(getManifestRefreshPolicy({ capabilities: [] }), null);
  // An ARRAY that even carries a `refresh_policy` named property must still be
  // rejected by the Array.isArray guard (kills a mutant that drops it).
  const arrayCaps: unknown[] & { refresh_policy?: unknown } = [];
  arrayCaps.refresh_policy = { maximum_staleness_seconds: 60 };
  assert.equal(getManifestRefreshPolicy({ capabilities: arrayCaps }), null);
});

test("getMaximumStalenessSeconds: positive finite number only; rejects 0/neg/NaN/Infinity/non-number", () => {
  assert.equal(getMaximumStalenessSeconds({ maximum_staleness_seconds: 3600 }), 3600);
  assert.equal(getMaximumStalenessSeconds({ maximum_staleness_seconds: 1 }), 1);

  // Boundary: 0 is NOT a valid staleness budget (> 0, not >= 0).
  assert.equal(getMaximumStalenessSeconds({ maximum_staleness_seconds: 0 }), null);
  // Negative rejected.
  assert.equal(getMaximumStalenessSeconds({ maximum_staleness_seconds: -5 }), null);
  // Non-finite rejected.
  assert.equal(getMaximumStalenessSeconds({ maximum_staleness_seconds: Number.NaN }), null);
  assert.equal(getMaximumStalenessSeconds({ maximum_staleness_seconds: Number.POSITIVE_INFINITY }), null);
  // Non-number rejected.
  assert.equal(getMaximumStalenessSeconds({ maximum_staleness_seconds: "3600" }), null);
  // Non-object / array / null refresh policy -> null.
  assert.equal(getMaximumStalenessSeconds(null), null);
  assert.equal(getMaximumStalenessSeconds([]), null);
  assert.equal(getMaximumStalenessSeconds("x"), null);
  // An ARRAY carrying a numeric maximum_staleness_seconds prop must still be
  // rejected by the Array.isArray guard.
  const arrayPolicy: unknown[] & { maximum_staleness_seconds?: unknown } = [];
  arrayPolicy.maximum_staleness_seconds = 3600;
  assert.equal(getMaximumStalenessSeconds(arrayPolicy), null);
});
