// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  hasTerminalKnownGap,
  isOwnerRecoverableKnownGap,
  isProvenUnfillableGap,
  isRetryableKnownGap,
  isStreamFullyUnfillableAccounted,
} from "../server/connector-gap-classification.ts";
import type { ConnectorRunSummary } from "../server/ref-control.ts";

test("assistance timeout gaps are owner/session-recoverable, not maintainer-code terminal gaps", () => {
  const gap = {
    kind: "run_failed",
    reason: "assistance_timed_out",
    recovery_hint: { action: "unknown", retryable: false },
    severity: "actionable",
  };

  const run: ConnectorRunSummary = {
    collection_facts: null,
    event_count: 0,
    failure_reason: null,
    finished_at: null,
    first_at: "2026-01-01T00:00:00.000Z",
    known_gaps: [gap],
    last_at: "2026-01-01T00:00:00.000Z",
    recovery_only: false,
    run_id: "run-1",
    started_at: "2026-01-01T00:00:00.000Z",
    status: "failed",
    terminal_reason: null,
  };

  assert.equal(isOwnerRecoverableKnownGap(gap), true);
  assert.equal(isRetryableKnownGap(gap), true);
  assert.equal(hasTerminalKnownGap(run), false);
});

// ─── isProvenUnfillableGap / isStreamFullyUnfillableAccounted ─────────────────
//
// Fixtures below mirror the exact durable row shapes verified against
// production `connector_detail_gaps` for cin_12407c1afb78d56848fe0b20 (Gmail):
// 32 terminal `too_large` rows all carry `last_error.message` in the
// `AttachmentTooLargeError` wire format; the 5 terminal `temporary_unavailable`
// rows carry NO `last_error` at all (37+/117 attempts, no recorded evidence).

test("a terminal gap with a recorded observed-size-over-cap message is proven unfillable", () => {
  const gap = {
    last_error: { class: "too_large", message: "attachment exceeds max size: 29209135 > 26214400 bytes" },
    status: "terminal",
  };
  assert.equal(isProvenUnfillableGap(gap), true);
});

test("a terminal gap with no last_error at all is NOT proven unfillable, however many attempts it made", () => {
  // Production shape: 37-117 attempts, `last_error_json IS NULL`.
  const gap = { last_error: null, status: "terminal" };
  assert.equal(isProvenUnfillableGap(gap), false);
});

test("a bare too_large class tag with no parseable numbers is NOT proof by itself", () => {
  const gap = { last_error: { class: "too_large" }, status: "terminal" };
  assert.equal(isProvenUnfillableGap(gap), false);
});

test("an observed size that does NOT exceed the recorded cap is not proof of impossibility", () => {
  const gap = {
    last_error: { class: "too_large", message: "attachment exceeds max size: 100 > 26214400 bytes" },
    status: "terminal",
  };
  assert.equal(isProvenUnfillableGap(gap), false);
});

test("an unrelated terminal error (e.g. quarantined) is NOT proven unfillable", () => {
  // Production shape: the one non-Gmail terminal row in the fleet.
  const gap = {
    last_error: {
      attempt_count: 8,
      class: "quarantined",
      failure_class: "export_no_download",
      reason: "temporary_unavailable",
      stream: "transactions",
      threshold: 8,
    },
    status: "terminal",
  };
  assert.equal(isProvenUnfillableGap(gap), false);
});

test("a stream with 32 proven-unfillable gaps and zero unproven ones is fully accounted", () => {
  const proven = { last_error: { message: "attachment exceeds max size: 29209135 > 26214400 bytes" } };
  const gaps = Array.from({ length: 32 }, () => proven);
  assert.equal(isStreamFullyUnfillableAccounted(gaps), true);
});

test("a stream with 32 proven and 5 unproven terminal gaps is NOT fully accounted — the exact Gmail attachments shape", () => {
  const proven = { last_error: { message: "attachment exceeds max size: 29209135 > 26214400 bytes" } };
  const unproven = { last_error: null };
  const gaps = [...Array.from({ length: 32 }, () => proven), ...Array.from({ length: 5 }, () => unproven)];
  assert.equal(isStreamFullyUnfillableAccounted(gaps), false);
});

test("an empty terminal-gap list is not accounted for (there is nothing to account for)", () => {
  assert.equal(isStreamFullyUnfillableAccounted([]), false);
});
