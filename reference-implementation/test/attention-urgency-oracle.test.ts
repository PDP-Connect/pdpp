// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import type { AttentionRecord } from "../runtime/attention.ts";
import { compareAttentionUrgency, pickMostUrgentAttention } from "../server/attention-urgency.ts";

console.log("BASELINE: attention urgency oracle active");

// compareAttentionUrgency / pickMostUrgentAttention only read the
// response_contract / progress_posture / expires_at / created_at fields, but
// the AttentionRecord type requires the full record shape. This helper builds
// a complete record with fixed, urgency-irrelevant defaults for every other
// field so tests can override only the axes under test — note this
// deliberately bypasses createAttention()'s validateAxes guard (the default
// response_contract='none' + progress_posture='running' + owner_action='none'
// combination here is invalid per validateAxes), which is fine because this
// oracle exercises the pure comparator, not record construction.
function attention(overrides: Partial<AttentionRecord> = {}): AttentionRecord {
  return {
    action_target: null,
    attachments: [],
    auto_detect: false,
    connection_id: "conn_1",
    created_at: "2026-07-06T12:00:00.000Z",
    dedupe_key: "dedupe_1",
    expires_at: null,
    id: "att_1",
    lifecycle: "open",
    metadata: {},
    notification_reason: null,
    notification_state: "pending",
    notification_updated_at: null,
    owner_action: "none",
    owner_copy: null,
    progress_posture: "running",
    reason_code: "test_reason",
    response_contract: "none",
    run_id: null,
    sensitivity: "none",
    updated_at: "2026-07-06T12:00:00.000Z",
    ...overrides,
  };
}

test("compareAttentionUrgency orders response-required records before optional records", () => {
  const required = attention({ response_contract: "response_required" });
  const optional = attention({ response_contract: "none" });

  assert.equal(compareAttentionUrgency(required, optional) < 0, true);
  assert.equal(compareAttentionUrgency(optional, required) > 0, true);
});

test("compareAttentionUrgency orders blocked posture before progressing when response contract ties", () => {
  const blocked = attention({
    progress_posture: "blocked",
    response_contract: "response_required",
  });
  const progressing = attention({
    progress_posture: "running",
    response_contract: "response_required",
  });

  assert.equal(compareAttentionUrgency(blocked, progressing) < 0, true);
  assert.equal(compareAttentionUrgency(progressing, blocked) > 0, true);
});

test("compareAttentionUrgency orders earlier expiry before later or absent expiry", () => {
  const earlier = attention({ expires_at: "2026-07-06T12:05:00.000Z" });
  const later = attention({ expires_at: "2026-07-06T12:10:00.000Z" });
  const absent = attention({ expires_at: null });

  assert.equal(compareAttentionUrgency(earlier, later) < 0, true);
  assert.equal(compareAttentionUrgency(later, earlier) > 0, true);
  assert.equal(compareAttentionUrgency(earlier, absent) < 0, true);
  assert.equal(compareAttentionUrgency(absent, earlier) > 0, true);
});

test("compareAttentionUrgency uses earlier creation as the final tie-break", () => {
  const earlier = attention({ created_at: "2026-07-06T11:59:00.000Z" });
  const later = attention({ created_at: "2026-07-06T12:01:00.000Z" });

  assert.equal(compareAttentionUrgency(earlier, later) < 0, true);
  assert.equal(compareAttentionUrgency(later, earlier) > 0, true);
});

test("pickMostUrgentAttention returns the comparator winner from an unsorted tuple", () => {
  const optionalSoon = attention({
    created_at: "2026-07-06T11:58:00.000Z",
    expires_at: "2026-07-06T12:01:00.000Z",
  });
  const requiredBlocked = attention({
    created_at: "2026-07-06T12:02:00.000Z",
    expires_at: "2026-07-06T12:30:00.000Z",
    progress_posture: "blocked",
    response_contract: "response_required",
  });
  const requiredProgressing = attention({
    created_at: "2026-07-06T11:57:00.000Z",
    expires_at: "2026-07-06T12:00:30.000Z",
    progress_posture: "running",
    response_contract: "response_required",
  });

  assert.equal(pickMostUrgentAttention([optionalSoon, requiredProgressing, requiredBlocked]), requiredBlocked);
});
