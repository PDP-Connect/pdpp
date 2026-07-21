// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-label fingerprint behavior for the Gmail `labels` stream.
 *
 * Before this gate, `labels` re-emitted every IMAP mailbox unconditionally
 * on every run, accumulating ~269 byte-identical versions per label. The
 * gate computes a stable per-label fingerprint and emits only when the
 * label's stored shape actually moves.
 *
 * These tests pin:
 *
 *   1. An unchanged label is suppressed on the second run (no version
 *      churn) while a changed/new label still emits.
 *   2. The keying `id` (label name) is EXCLUDED from the fingerprint, so
 *      the connector's fingerprint over `{id, ...body}` equals the
 *      compaction script's fingerprint over the stored body `{...}` (no
 *      `id`). This is the byte-parity contract the historical compaction
 *      policy depends on.
 *   3. `readPriorLabelFingerprints` tolerates missing / legacy / malformed
 *      state and never throws.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { openFingerprintCursor, recordFingerprint } from "../../src/fingerprint-cursor.ts";
import { readPriorLabelFingerprints } from "./index.ts";

/** The stored `labels` record body — exactly what lands in record_json.
 *  No `id`, no run-clock field. */
function labelBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "INBOX",
    canonical_name: "inbox",
    is_system: true,
    parent_name: null,
    message_count: null,
    ...overrides,
  };
}

/** Drive the same gate the connector uses: key on `id = name`, exclude
 *  `id` from the fingerprint. Returns the names that would emit. */
function runLabelsPass(
  priorState: Record<string, unknown>,
  bodies: Record<string, unknown>[]
): { emitted: string[]; nextState: Record<string, unknown> } {
  const cursor = openFingerprintCursor(priorState, {
    excludeFromFingerprint: ["id"],
    priorFingerprints: readPriorLabelFingerprints(priorState),
  });
  const emitted: string[] = [];
  for (const body of bodies) {
    if (cursor.shouldEmit({ id: String(body.name), ...body })) {
      emitted.push(String(body.name));
    }
  }
  cursor.pruneStale();
  const nextCursor: Record<string, unknown> = { fetched_at: "2026-06-01T00:00:00.000Z" };
  if (cursor.size() > 0) {
    nextCursor.fingerprints = cursor.toState();
  }
  return { emitted, nextState: { labels: nextCursor } };
}

test("labels: an unchanged mailbox set does not re-emit on the second run", () => {
  const bodies = [
    labelBody({ name: "INBOX", canonical_name: "inbox" }),
    labelBody({ name: "[Gmail]/Sent Mail", canonical_name: "sent mail", is_system: true }),
  ];
  const run1 = runLabelsPass({}, bodies);
  assert.deepEqual(run1.emitted.sort(), ["INBOX", "[Gmail]/Sent Mail"], "first run emits every label once");

  // Same mailboxes, same shapes — second run must emit nothing.
  const run2 = runLabelsPass(run1.nextState, bodies);
  assert.deepEqual(run2.emitted, [], "unchanged labels are fully suppressed on the second run");
});

test("labels: a newly-created label emits; the unchanged ones stay silent", () => {
  const run1 = runLabelsPass({}, [labelBody({ name: "INBOX" })]);
  const run2 = runLabelsPass(run1.nextState, [
    labelBody({ name: "INBOX" }),
    labelBody({ name: "Work/Receipts", canonical_name: "work/receipts", is_system: false, parent_name: "Work" }),
  ]);
  assert.deepEqual(run2.emitted, ["Work/Receipts"], "only the new label re-emits");
});

test("labels: a changed flag on an existing label re-emits", () => {
  const run1 = runLabelsPass({}, [labelBody({ name: "Promotions", is_system: true })]);
  // Same name, but is_system flipped (e.g. canonicalization changed).
  const run2 = runLabelsPass(run1.nextState, [labelBody({ name: "Promotions", is_system: false })]);
  assert.deepEqual(run2.emitted, ["Promotions"], "a real field change moves the fingerprint and re-emits");
});

test("labels: a deleted mailbox is pruned so it re-emits if re-created", () => {
  const run1 = runLabelsPass({}, [labelBody({ name: "INBOX" }), labelBody({ name: "Temp" })]);
  // 'Temp' deleted — only INBOX observed this run.
  const run2 = runLabelsPass(run1.nextState, [labelBody({ name: "INBOX" })]);
  assert.deepEqual(run2.emitted, [], "INBOX unchanged stays silent");
  // 'Temp' re-created later — must emit because it was pruned.
  const run3 = runLabelsPass(run2.nextState, [labelBody({ name: "INBOX" }), labelBody({ name: "Temp" })]);
  assert.deepEqual(run3.emitted, ["Temp"], "re-created mailbox re-emits after prune");
});

test("labels: connector fingerprint (excludes id) == compaction fingerprint over stored body", () => {
  // This is the byte-parity contract the historical compaction policy
  // relies on. The connector keys on id=name but excludes id from the
  // hash; the compaction script hashes the stored record_json which has
  // no id and an empty exclude set. The two hashes MUST be identical.
  const body = labelBody({ name: "[Gmail]/All Mail", canonical_name: "all mail" });

  const connectorFp = recordFingerprint({ id: body.name, ...body }, ["id"]);
  const compactionFp = recordFingerprint(body, []); // mirrors script policy excludeKeys: []
  assert.equal(connectorFp, compactionFp, "connector and compaction fingerprints must match byte-for-byte");
});

test("readPriorLabelFingerprints: tolerates missing / legacy / malformed state", () => {
  assert.equal(readPriorLabelFingerprints({}).size, 0, "empty state → empty map");
  assert.equal(
    readPriorLabelFingerprints({ labels: { fetched_at: "x" } }).size,
    0,
    "legacy cursor (no fingerprints key) → empty map"
  );
  assert.equal(
    readPriorLabelFingerprints({ labels: { fingerprints: "not-an-object" } }).size,
    0,
    "malformed fingerprints value → empty map"
  );
  assert.equal(
    readPriorLabelFingerprints({ labels: { fingerprints: ["a"] } }).size,
    0,
    "array fingerprints value → empty map"
  );
  const ok = readPriorLabelFingerprints({ labels: { fingerprints: { INBOX: "fp-1", bad: 5 } } });
  assert.equal(ok.size, 1, "non-string entries dropped, valid entries kept");
  assert.equal(ok.get("INBOX"), "fp-1");
});
