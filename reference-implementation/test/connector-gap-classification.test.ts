// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyTooLargeProof,
  hasTerminalKnownGap,
  isOwnerRecoverableKnownGap,
  isProvenUnfillableGap,
  isRetryableKnownGap,
  isStreamFullyUnfillableAccounted,
  readClaimedSizeProof,
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

// ─── `too_large` proof adjudication (fabricated vs genuine) ──────────────────
//
// A `too_large` terminal gap normally carries durable per-item impossibility
// proof, and the requeue allowlist refuses the reason categorically because of
// it. That refusal assumes the proof is TRUE.
//
// It is forgeable by an ordinary bug. Gmail sized attachments from imapflow's
// `meta.expectedSize`, which is the FETCH `RFC822.SIZE` — the whole MESSAGE's
// size, identical for every part of a multipart message. Against a per-part cap
// that condemned every attachment of a message once their SUM crossed it. Live
// on the owner's mailbox: 32 terminal rows sharing 7 distinct "observed" sizes,
// each ≈ the sum of that message's parts, the smallest condemned item being
// 3,080 bytes against a 26,214,400-byte cap.

const GMAIL_CAP_BYTES = 26_214_400;

/** A row in the exact durable shape `AttachmentTooLargeError` writes. */
function tooLargeRow(claimedBytes: number) {
  return {
    last_error: {
      class: "too_large",
      message: `attachment exceeds max size: ${claimedBytes} > ${GMAIL_CAP_BYTES} bytes`,
    },
    status: "terminal",
  };
}

test("classifyTooLargeProof: a claimed size contradicted by the item's real size is fabricated", () => {
  // The real 2026-08 row: a 3,080-byte attachment condemned as 29,830,196.
  assert.equal(classifyTooLargeProof(tooLargeRow(29_830_196), 3080), "fabricated_proof");
});

test("classifyTooLargeProof: a genuinely oversized item keeps its proof (the safety property)", () => {
  // This is the case the allowlist refusal exists for. Requeuing it could never
  // converge, so it must STAY terminal even though the claimed number is also
  // over the cap.
  assert.equal(classifyTooLargeProof(tooLargeRow(29_830_196), 29_830_196), "proof_holds");
  // Exactly at the cap is NOT over it — the hydrator rejects only `> maxBytes`.
  assert.equal(classifyTooLargeProof(tooLargeRow(29_830_196), GMAIL_CAP_BYTES), "fabricated_proof");
  assert.equal(classifyTooLargeProof(tooLargeRow(29_830_196), GMAIL_CAP_BYTES + 1), "proof_holds");
});

test("classifyTooLargeProof: no corroborating record is absence of contradiction, not proof of fabrication", () => {
  for (const missing of [null, undefined, Number.NaN]) {
    assert.equal(
      classifyTooLargeProof(tooLargeRow(29_830_196), missing),
      "no_corroborating_record",
      "a row with nothing to compare against must stay terminal, never requeue on missing evidence"
    );
  }
});

test("classifyTooLargeProof: a row carrying no parseable size claim is not adjudicated", () => {
  // A bare class tag is a hint of where to look, never evidence.
  assert.equal(
    classifyTooLargeProof({ last_error: { class: "too_large" }, status: "terminal" }, 3080),
    "not_a_size_proof"
  );
  assert.equal(classifyTooLargeProof({ last_error: null, status: "terminal" }, 3080), "not_a_size_proof");
  assert.equal(classifyTooLargeProof(null, 3080), "not_a_size_proof");
});

test("readClaimedSizeProof: extracts both numbers, and isProvenUnfillableGap still reads the same rows", () => {
  assert.deepEqual(readClaimedSizeProof(tooLargeRow(29_830_196)), {
    claimedBytes: 29_830_196,
    limitBytes: GMAIL_CAP_BYTES,
  });
  assert.equal(readClaimedSizeProof({ last_error: { message: "no numbers here" } }), null);
  // Behavior preservation: the shared parser did not change what the health
  // projection treats as durable proof.
  assert.equal(isProvenUnfillableGap(tooLargeRow(29_830_196)), true);
  assert.equal(isProvenUnfillableGap({ last_error: { message: "attachment exceeds max size: 10 > 20 bytes" } }), false);
});
