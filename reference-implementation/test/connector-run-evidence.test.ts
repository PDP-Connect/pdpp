// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure connector-run-evidence projections.
 *
 * connector-run-evidence.js has no co-named test. The async
 * getLatestConnectorRunSummary needs the spine store and is out of scope
 * here; these tests pin the three pure, synchronous projections directly:
 *   - getConnectorRunEvidenceConnectorId: storage connector id gating,
 *   - getManifestRefreshPolicy: capabilities shape gating,
 *   - getMaximumStalenessSeconds: positive-finite-number gating.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { emitSpineEvent } from "../lib/spine.ts";
import {
  getConnectorRunEvidenceConnectorId,
  getLatestConnectorRunSummary,
  getManifestRefreshPolicy,
  getMaximumStalenessSeconds,
} from "../server/connector-run-evidence.ts";
import { closeDb, initDb } from "../server/db.ts";

const getLatestConnectorRunSummaryForTest = getLatestConnectorRunSummary as unknown as (
  connectorId: string,
  status: string,
  connectorInstanceId: string
) => Promise<{ last_at: unknown; status: unknown } | null>;

async function withSpine(fn: () => Promise<void>): Promise<void> {
  initDb();
  try {
    await fn();
  } finally {
    closeDb();
  }
}

test("getConnectorRunEvidenceConnectorId returns the id only from a storage binding", () => {
  assert.equal(getConnectorRunEvidenceConnectorId({ connector_id: "gmail" }), "gmail");
  assert.equal(getConnectorRunEvidenceConnectorId({ connector_id: "" }), null);
  assert.equal(getConnectorRunEvidenceConnectorId({}), null);
  assert.equal(getConnectorRunEvidenceConnectorId(null), null);
});

test("getManifestRefreshPolicy reads capabilities.refresh_policy or null", () => {
  const policy = { mode: "automatic" };
  assert.deepEqual(getManifestRefreshPolicy({ capabilities: { refresh_policy: policy } }), policy);
  // No refresh_policy -> null.
  assert.equal(getManifestRefreshPolicy({ capabilities: {} }), null);
  // Non-object / array / missing capabilities -> null.
  assert.equal(getManifestRefreshPolicy({ capabilities: [] }), null);
  assert.equal(getManifestRefreshPolicy({ capabilities: "x" }), null);
  assert.equal(getManifestRefreshPolicy({}), null);
  assert.equal(getManifestRefreshPolicy(null), null);
});

test("getMaximumStalenessSeconds accepts a positive finite number only", () => {
  assert.equal(getMaximumStalenessSeconds({ maximum_staleness_seconds: 3600 }), 3600);
  assert.equal(getMaximumStalenessSeconds({ maximum_staleness_seconds: 0 }), null);
  assert.equal(getMaximumStalenessSeconds({ maximum_staleness_seconds: -1 }), null);
  assert.equal(getMaximumStalenessSeconds({ maximum_staleness_seconds: Number.POSITIVE_INFINITY }), null);
  assert.equal(getMaximumStalenessSeconds({ maximum_staleness_seconds: "3600" }), null);
  // Non-object / array / null policy -> null.
  assert.equal(getMaximumStalenessSeconds([]), null);
  assert.equal(getMaximumStalenessSeconds(null), null);
});

test("getLatestConnectorRunSummary scopes success evidence to the connector instance", async () => {
  await withSpine(async () => {
    await emitSpineEvent({
      data: { connector_instance_id: "cin_amazon_a" },
      event_type: "run.completed",
      object_id: "run_amazon_a",
      object_type: "run",
      occurred_at: "2026-08-01T00:00:00.000Z",
      run_id: "run_amazon_a",
      source_id: "amazon",
      source_kind: "connector",
      status: "succeeded",
    });
    await emitSpineEvent({
      data: { connector_instance_id: "cin_amazon_b" },
      event_type: "run.completed",
      object_id: "run_amazon_b",
      object_type: "run",
      occurred_at: "2026-08-02T00:00:00.000Z",
      run_id: "run_amazon_b",
      source_id: "amazon",
      source_kind: "connector",
      status: "succeeded",
    });

    const summary = await getLatestConnectorRunSummaryForTest("amazon", "succeeded", "cin_amazon_a");
    assert.equal(summary?.last_at, "2026-08-01T00:00:00.000Z");
  });
});
