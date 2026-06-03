/**
 * Per-message fingerprint behavior for the USAA `inbox_messages` stream.
 *
 * Before this gate, `runInboxStream` appended a fresh version of every
 * still-listed inbox message on every run because the record body carried a
 * run-clock `fetched_at` and the inbox page is re-scraped in full each run. A
 * message's identity (id = hashId(date_short|preview[:120])) and its body are
 * otherwise immutable until its read/unread status flips, so the only field
 * that moved between byte-identical runs was `fetched_at`.
 *
 * These tests drive the exact gate `runInboxStream` wires — a full-scan
 * cursor (`shouldEmit` per message, then `pruneStale`) — over real records
 * built by the exported `buildInboxMessageRecord`. They pin:
 *
 *   1. Re-scraping the same inbox (only fetched_at differs) is fully
 *      suppressed on the second run.
 *   2. A read → unread (or unread → read) status flip re-emits — a real
 *      transition the gate must never hide.
 *   3. A message dropped from the inbox listing is pruned so a re-appearance
 *      re-emits (full-scan invariant; contrast with transactions which never
 *      prune).
 *   4. The STATE round-trips the `fingerprints` map and excludes
 *      `fetched_at`.
 *   5. `readPriorInboxMessageFingerprints` tolerates missing / legacy /
 *      malformed state.
 *   6. Connector fingerprint (excludes fetched_at) == compaction fingerprint
 *      over the stored body with excludeKeys ['fetched_at'].
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type FingerprintCursor, openFingerprintCursor, recordFingerprint } from "../../src/fingerprint-cursor.ts";
import { readPriorInboxMessageFingerprints } from "./index.ts";
import { buildInboxMessageRecord } from "./parsers.ts";
import type { InboxMessageRecord, InboxRow } from "./types.ts";

const RUN1_AT = "2026-06-01T10:00:00.000Z";
const RUN2_AT = "2026-06-02T10:00:00.000Z";
const YEAR = 2026;

function makeRow(overrides: Partial<InboxRow> = {}): InboxRow {
  return {
    status: "Unread",
    date_short: "May 14",
    preview: "Your statement is ready to view",
    ...overrides,
  };
}

function records(fetchedAt: string, rows: readonly InboxRow[]): InboxMessageRecord[] {
  const out: InboxMessageRecord[] = [];
  for (const r of rows) {
    const rec = buildInboxMessageRecord(r, YEAR, fetchedAt);
    if (rec) {
      out.push(rec);
    }
  }
  return out;
}

/** Replicate runInboxStream's full-scan emit loop: gate each message, then
 *  pruneStale (the inbox page is re-scraped in full each run). Returns the
 *  emitted records. */
function emitFullScan(cursor: FingerprintCursor, recs: readonly InboxMessageRecord[]): InboxMessageRecord[] {
  const emitted: InboxMessageRecord[] = [];
  for (const rec of recs) {
    if (cursor.shouldEmit(rec)) {
      emitted.push(rec);
    }
  }
  cursor.pruneStale();
  return emitted;
}

/** Build the `{ inbox_messages: cursor }` STATE shape the next run reads. */
function stateFrom(cursor: FingerprintCursor): Record<string, unknown> {
  const inner: Record<string, unknown> = { fetched_at: RUN1_AT };
  if (cursor.size() > 0) {
    inner.fingerprints = cursor.toState();
  }
  return { inbox_messages: inner };
}

function openInboxCursor(priorState: Record<string, unknown>): FingerprintCursor {
  return openFingerprintCursor(priorState.inbox_messages, {
    excludeFromFingerprint: ["fetched_at"],
    priorFingerprints: readPriorInboxMessageFingerprints(priorState),
  });
}

const TWO_MESSAGES: readonly InboxRow[] = [
  makeRow({ date_short: "May 14", preview: "Your statement is ready to view" }),
  makeRow({ date_short: "May 10", preview: "Security alert: new device sign-in", status: "Read" }),
];

test("inbox_messages: re-scraping the same inbox (only fetched_at differs) is fully suppressed", () => {
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  const run1 = emitFullScan(cursor1, records(RUN1_AT, TWO_MESSAGES));
  assert.equal(run1.length, 2, "first run emits both messages once");

  const priorState = stateFrom(cursor1);
  const cursor2 = openInboxCursor(priorState);
  const run2 = emitFullScan(cursor2, records(RUN2_AT, TWO_MESSAGES));
  assert.equal(run2.length, 0, "re-scraped unchanged messages fully suppressed despite new fetched_at");
});

test("inbox_messages: a read/unread status flip re-emits (real transition, not run-clock)", () => {
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  emitFullScan(cursor1, records(RUN1_AT, [makeRow({ status: "Unread" })]));

  const priorState = stateFrom(cursor1);
  const cursor2 = openInboxCursor(priorState);
  // Same message (same date_short + preview → same id), now Read.
  const run2 = emitFullScan(cursor2, records(RUN2_AT, [makeRow({ status: "Read" })]));
  assert.equal(run2.length, 1, "an unread → read transition is a fingerprint boundary and re-emits");
  assert.equal(run2[0]?.status, "read", "the re-emitted record carries the new status");
});

test("inbox_messages: a disappeared message is pruned so its re-appearance re-emits", () => {
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  emitFullScan(cursor1, records(RUN1_AT, TWO_MESSAGES));

  // Run 2: only the first message is still listed (the second scrolled off).
  const state1 = stateFrom(cursor1);
  const cursor2 = openInboxCursor(state1);
  const run2 = emitFullScan(cursor2, records(RUN2_AT, [TWO_MESSAGES[0] as InboxRow]));
  assert.equal(run2.length, 0, "the first message unchanged stays silent");
  // The second message must have been pruned so a re-appearance re-emits.
  const state2 = stateFrom(cursor2);
  const fps2 = readPriorInboxMessageFingerprints(state2);
  const droppedId = (records(RUN1_AT, [TWO_MESSAGES[1] as InboxRow])[0] as InboxMessageRecord).id;
  assert.equal(fps2.has(droppedId), false, "disappeared message pruned from fingerprint map");

  // Run 3: the second message re-appears unchanged. Because it was pruned, it
  // re-emits exactly once.
  const cursor3 = openInboxCursor(state2);
  const run3 = emitFullScan(cursor3, records(RUN1_AT, TWO_MESSAGES));
  assert.equal(run3.length, 1, "re-appeared message re-emits exactly once; the first stays suppressed");
});

test("inbox_messages: STATE carries a fingerprints map that excludes fetched_at", () => {
  const cursor = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  emitFullScan(cursor, records(RUN1_AT, TWO_MESSAGES));
  const fps = readPriorInboxMessageFingerprints(stateFrom(cursor));
  assert.equal(fps.size, 2, "both message fingerprints persisted");
});

test("readPriorInboxMessageFingerprints: tolerates missing / legacy / malformed state", () => {
  assert.equal(readPriorInboxMessageFingerprints({}).size, 0, "empty state → empty map");
  assert.equal(
    readPriorInboxMessageFingerprints({ inbox_messages: { fetched_at: RUN1_AT } }).size,
    0,
    "legacy cursor (fetched_at only, no fingerprints) → empty map"
  );
  assert.equal(
    readPriorInboxMessageFingerprints({ inbox_messages: { fingerprints: 5 } }).size,
    0,
    "malformed fingerprints value → empty map"
  );
  const ok = readPriorInboxMessageFingerprints({ inbox_messages: { fingerprints: { id1: "fp-1", bad: null } } });
  assert.equal(ok.size, 1, "valid entries kept, invalid dropped");
});

test("inbox_messages: connector fingerprint (excludes fetched_at) == compaction fingerprint over stored body", () => {
  const body = {
    id: "inbox-hash-1",
    date_received: "2026-05-14",
    status: "unread",
    subject: "Your statement is ready to view",
    preview: "Your statement is ready to view",
    fetched_at: RUN1_AT,
  };
  const later = { ...body, fetched_at: RUN2_AT };
  const flipped = { ...later, status: "read" };
  assert.equal(
    recordFingerprint(body, ["fetched_at"]),
    recordFingerprint(later, ["fetched_at"]),
    "fetched_at must not participate; a no-op re-scrape hashes identically"
  );
  assert.notEqual(
    recordFingerprint(body, ["fetched_at"]),
    recordFingerprint(flipped, ["fetched_at"]),
    "a read/unread status flip MUST produce a different fingerprint"
  );
});
