// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  formatAttentionAxis,
  formatCoverageAxis,
  formatFreshnessAxis,
  formatOutboxAxis,
} from "./axis-vocabulary.ts";

test("coverage axis maps all known states to owner-facing words with correct tone", () => {
  assert.equal(formatCoverageAxis("complete").value, "complete");
  assert.equal(formatCoverageAxis("complete").tone, "success");

  assert.equal(formatCoverageAxis("deferred").value, "optional, not collected");
  assert.equal(formatCoverageAxis("deferred").tone, "neutral");

  assert.equal(formatCoverageAxis("gaps").value, "gaps");
  assert.equal(formatCoverageAxis("gaps").tone, "warning");

  assert.equal(formatCoverageAxis("inventory_only").value, "complete (list only, by design)");
  assert.equal(formatCoverageAxis("inventory_only").tone, "neutral");

  assert.equal(formatCoverageAxis("partial").value, "partial");
  assert.equal(formatCoverageAxis("partial").tone, "warning");

  assert.equal(formatCoverageAxis("retryable_gap").value, "retryable gap");
  assert.equal(formatCoverageAxis("retryable_gap").tone, "warning");

  assert.equal(formatCoverageAxis("terminal_gap").value, "won't backfill");
  assert.equal(formatCoverageAxis("terminal_gap").tone, "danger");

  assert.equal(formatCoverageAxis("unavailable").value, "unavailable");
  assert.equal(formatCoverageAxis("unavailable").tone, "neutral");

  assert.equal(formatCoverageAxis("unknown").value, "not measured");
  assert.equal(formatCoverageAxis("unknown").tone, "neutral");

  assert.equal(formatCoverageAxis("unsupported").value, "unsupported");
  assert.equal(formatCoverageAxis("unsupported").tone, "neutral");
});

test("freshness axis maps known states to owner-facing words with correct tone", () => {
  assert.equal(formatFreshnessAxis("fresh").value, "fresh");
  assert.equal(formatFreshnessAxis("fresh").tone, "success");

  assert.equal(formatFreshnessAxis("stale").value, "stale");
  assert.equal(formatFreshnessAxis("stale").tone, "warning");

  assert.equal(formatFreshnessAxis("unknown").value, "not measured");
  assert.equal(formatFreshnessAxis("unknown").tone, "neutral");
});

test("outbox axis maps known states to owner-facing words with correct tone", () => {
  assert.equal(formatOutboxAxis("active").value, "active");
  assert.equal(formatOutboxAxis("active").tone, "success");

  assert.equal(formatOutboxAxis("idle").value, "idle");
  assert.equal(formatOutboxAxis("idle").tone, "success");

  assert.equal(formatOutboxAxis("stalled").value, "stalled");
  assert.equal(formatOutboxAxis("stalled").tone, "danger");

  assert.equal(formatOutboxAxis("unknown").value, "not measured");
  assert.equal(formatOutboxAxis("unknown").tone, "neutral");
});

test("attention axis maps known states to owner-facing words with correct tone", () => {
  assert.equal(formatAttentionAxis("acknowledged")?.value, "acknowledged");
  assert.equal(formatAttentionAxis("acknowledged")?.tone, "warning");

  assert.equal(formatAttentionAxis("in_progress")?.value, "in progress");
  assert.equal(formatAttentionAxis("in_progress")?.tone, "warning");

  assert.equal(formatAttentionAxis("none"), null);

  assert.equal(formatAttentionAxis("open")?.value, "open");
  assert.equal(formatAttentionAxis("open")?.tone, "warning");

  assert.equal(formatAttentionAxis("unknown_state")?.value, "not measured");
  assert.equal(formatAttentionAxis("unknown_state")?.tone, "neutral");
});
