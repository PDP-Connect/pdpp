// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for the shared records-timeline loader bound to the
 * sandbox `DashboardDataSource`.
 *
 * The same `loadTimeline` function powers the time-range lens on
 * `/explore` (live AS/RS) and `/sandbox/records/timeline`
 * (deterministic mock dataset). These tests assert the sandbox binding
 * produces a usable,
 * deterministic timeline and that the seeded sandbox manifests advertise
 * the per-stream `consent_time_field` the loader requires.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { findTimeAnchoredStreams, loadTimeline } from "@pdpp/operator-ui/lib/timeline";
import { sandboxDashboardDataSource } from "./data-source.ts";

const SANDBOX_CONNECTOR_SUFFIX = /_demo$/;

test("sandbox manifests advertise consent_time_field on every demo stream", async () => {
  const manifests = await sandboxDashboardDataSource.listConnectorManifests();
  assert.ok(manifests.length >= 3);
  for (const m of manifests) {
    for (const s of m.streams ?? []) {
      assert.equal(typeof (s as { consent_time_field?: unknown }).consent_time_field, "string");
    }
  }
});

test("findTimeAnchoredStreams against sandbox returns one entry per seeded stream", async () => {
  const anchored = await findTimeAnchoredStreams(sandboxDashboardDataSource);
  assert.ok(anchored.length >= 4, "expected at least 4 time-anchored sandbox streams");
  for (const a of anchored) {
    assert.equal(typeof a.connectorId, "string");
    assert.equal(typeof a.streamName, "string");
    assert.equal(typeof a.consentTimeField, "string");
  }
});

test("sandbox loadTimeline produces deterministic, sorted entries within a wide window", async () => {
  const result = await loadTimeline({ since: "2025-01-01", until: "2027-01-01" }, sandboxDashboardDataSource);
  assert.ok(result.entries.length >= 3, "sandbox timeline should surface multiple seeded records");
  assert.ok(result.sources >= 3, "expected at least 3 sandbox streams scanned");
  assert.ok(result.scanned >= result.entries.length);

  // Entries are sorted descending by timestamp.
  for (let i = 1; i < result.entries.length; i += 1) {
    const prev = result.entries[i - 1]?.timestamp ?? "";
    const cur = result.entries[i]?.timestamp ?? "";
    assert.ok(prev >= cur, `entries must be sorted desc: ${prev} >= ${cur}`);
  }

  // Every entry references a sandbox connector (no live RS bleed-through).
  for (const e of result.entries) {
    assert.match(e.connectorId, SANDBOX_CONNECTOR_SUFFIX);
    assert.equal(typeof e.summary, "string");
  }
});

test("sandbox loadTimeline filters by since/until window using the per-stream consent_time_field", async () => {
  const narrow = await loadTimeline({ since: "2026-04-01", until: "2026-05-01" }, sandboxDashboardDataSource);
  for (const e of narrow.entries) {
    assert.ok(e.timestamp >= "2026-04-01", `entry should respect since: ${e.timestamp}`);
    assert.ok(e.timestamp < "2026-05-01", `entry should respect until: ${e.timestamp}`);
  }
  // April-only window should still capture Fabrikam transactions.
  assert.ok(
    narrow.entries.some((e) => e.connectorId === "fabrikam_bank_demo"),
    "expected at least one bank transaction in April 2026"
  );
});

test("sandbox loadTimeline is deterministic across calls (no randomness)", async () => {
  const a = await loadTimeline({ since: "2025-01-01", until: "2027-01-01" }, sandboxDashboardDataSource);
  const b = await loadTimeline({ since: "2025-01-01", until: "2027-01-01" }, sandboxDashboardDataSource);
  assert.deepEqual(
    a.entries.map((e) => `${e.connectorId}::${e.stream}::${e.recordId}::${e.timestamp}`),
    b.entries.map((e) => `${e.connectorId}::${e.stream}::${e.recordId}::${e.timestamp}`)
  );
});
