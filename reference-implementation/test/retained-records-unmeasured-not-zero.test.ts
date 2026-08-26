// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for the worst false statement this product can make:
 * telling an owner "Holding 0 records." about data it is still holding.
 *
 * Observed live (2026-08-19, prod Postgres): two paused manual file-import
 * connections rendered `headline: "Holding 0 records."` while the canonical
 * `records` table held 299,248 (google-maps, cin_50f5bf4b7ecbc7acd6f4c254) and
 * 120,042 (whatsapp, cin_a6aa0550ed70c8ce6bd73170) rows. Their
 * `connector_summary_evidence` rows carried the CORRECT `total_records`
 * (299,248 / 120,042) with `record_snapshot_state='current'`.
 *
 * Root cause: the rendered verdict was fed `live.totalRecords` — a sum over the
 * SPARSE `retained_size_stream` table. Neither connection had ever been
 * measured by the retained-size projection, so it had zero rows for them, and
 * summing zero rows produced `0`. That fabricated zero then rendered as a
 * confident count.
 *
 * The rule these tests pin: an UNKNOWN count stays `null` all the way to the
 * renderer, which already says "unavailable". A null is honest; a zero lies.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ConnectionHealthSnapshot } from "../runtime/connection-health.ts";
import { synthesizeConnectorVerdict } from "../runtime/connector-verdict-input.ts";
import { liveRetainedRecordsOrNull } from "../server/ref-control.ts";

/** The exact false statement this file exists to prevent. */
const HOLDING_ZERO_RECORDS = /Holding\s+0\s+records/;
const ANY_ZERO = /\b0\b/;

// ─── liveRetainedRecordsOrNull: the sparse-sum guard ─────────────────────────

/** Shape-compatible stand-in for the `RecordProjection` the guard reads. */
function projection(totalRecords: number, retainedSizeReliable: boolean) {
  return {
    byStream: new Map(),
    freshness: { captured_at: null, state: "unknown" },
    retainedBytes: null,
    retainedSizeReliable,
    totalRecords,
  } as unknown as Parameters<typeof liveRetainedRecordsOrNull>[0];
}

test("liveRetainedRecordsOrNull: an UNMEASURED connection (sparse sum of zero rows) is null, never 0", () => {
  // Exactly the two live connections' shape: no retained_size_stream rows at
  // all, so the reduce sums to 0, and no clean/computed retained_size_connection
  // row to vouch for it.
  assert.strictEqual(
    liveRetainedRecordsOrNull(projection(0, false)),
    null,
    "an unmeasured connection must make NO count claim"
  );
});

test("liveRetainedRecordsOrNull: a PROVEN-clean zero stays an exact 0 (a real measurement)", () => {
  assert.strictEqual(
    liveRetainedRecordsOrNull(projection(0, true)),
    0,
    "a measured zero is a real fact and must not be withdrawn to null"
  );
});

test("liveRetainedRecordsOrNull: a positive total always stands on its own", () => {
  assert.strictEqual(liveRetainedRecordsOrNull(projection(299_248, false)), 299_248);
  assert.strictEqual(liveRetainedRecordsOrNull(projection(120_042, true)), 120_042);
});

// ─── Renderer: null renders "unavailable", a real count renders the number ───

/**
 * Paused manual import: no schedule, no prior success — the live shape.
 *
 * Complete and uncast, so the compiler enforces that this stays a shape
 * `computeConnectionHealth` can emit. The headline path this file asserts reads
 * `axes.outbox` (`rendered-verdict.ts`), so an omitted axis here would silently
 * change the very sentence these tests exist to pin. Do not reintroduce
 * `as unknown as`.
 */
function pausedManualSnapshot(): ConnectionHealthSnapshot {
  return {
    axes: {
      attention: "none",
      coverage: "complete",
      freshness: "fresh",
      outbox: "idle",
      remote_surface: "none",
    },
    badges: { stale: false, syncing: false },
    collection_rate: null,
    conditions: [],
    detail_gap_backlog: null,
    dominant_condition_id: null,
    ephemeral_browser_runtime: null,
    forward_disposition: "complete",
    last_success_at: null,
    local_device_outbox_counts: null,
    next_action: null,
    next_attempt_at: null,
    reason_code: null,
    remote_surface: null,
    state: "healthy",
    supporting_condition_ids: [],
    unknown_reasons: [],
  };
}

function renderManual(retainedRecords: number | null) {
  return synthesizeConnectorVerdict({
    manifestStreams: [],
    progress: {
      gaps_drained_last_run: null,
      last_refreshed_at: null,
      mode: "manual",
      observed_at: "2026-08-19T00:00:00.000Z",
      records_committed_last_run: null,
      retained_records: retainedRecords,
    },
    refresh: null,
    report: [],
    runtimeOk: true,
    snapshot: pausedManualSnapshot(),
  });
}

test("renderer: a null retained count renders as unavailable, and NEVER as a 0 count", () => {
  const v = renderManual(null);
  assert.strictEqual(
    v.progress.retained_records,
    null,
    "a null count must survive to the rendered payload, not become 0"
  );
  const { headline } = v.progress;
  assert.ok(
    !HOLDING_ZERO_RECORDS.test(headline),
    `an unknown count must never claim "Holding 0 records"; got ${JSON.stringify(headline)}`
  );
  assert.ok(!ANY_ZERO.test(headline), `an unknown count must state no number at all; got ${JSON.stringify(headline)}`);
  assert.strictEqual(headline, "Refresh to update.", `got ${JSON.stringify(headline)}`);
});

test("renderer: a real count renders the real number (google-maps live shape: 299,248)", () => {
  const v = renderManual(299_248);
  assert.strictEqual(v.progress.retained_records, 299_248);
  assert.strictEqual(v.progress.headline, "Holding 299,248 records.");
});

test("renderer: a real count renders the real number (whatsapp live shape: 120,042)", () => {
  const v = renderManual(120_042);
  assert.strictEqual(v.progress.retained_records, 120_042);
  assert.strictEqual(v.progress.headline, "Holding 120,042 records.");
});

test("renderer: a PROVEN zero still renders an honest 0 (0 and null stay distinguishable)", () => {
  const v = renderManual(0);
  assert.strictEqual(v.progress.retained_records, 0, "a measured zero must not be coerced to null");
  assert.strictEqual(v.progress.headline, "Holding 0 records.");
});

// ─── End-to-end: the live defect, as a single composed assertion ─────────────

test("live defect: an unmeasured paused manual import never renders a fabricated zero count", () => {
  // The exact composition that produced the defect: an unmeasured retained-size
  // projection feeding the manual-progress headline. With the guard in place
  // the sparse zero becomes null, and the owner is told the truth.
  const retained = liveRetainedRecordsOrNull(projection(0, false));
  const { headline } = renderManual(retained).progress;
  assert.ok(
    !HOLDING_ZERO_RECORDS.test(headline),
    `google-maps/whatsapp must never be told they hold 0 records; got ${JSON.stringify(headline)}`
  );
});
