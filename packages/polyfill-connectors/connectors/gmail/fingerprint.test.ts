/**
 * Per-thread fingerprint behavior for the Gmail connector. These tests
 * pin the contract the threads-stream churn fix depends on:
 *
 *   1. An unchanged thread's fingerprint stays stable across runs —
 *      `buildThreadFingerprint(agg1) === buildThreadFingerprint(agg2)`
 *      whenever (agg1, agg2) carry the same semantic shape.
 *   2. Any real change to the aggregate moves the fingerprint
 *      (message_count, last_message_date, labels, flags, etc.).
 *   3. `readPriorThreadFingerprints` is tolerant of missing / legacy /
 *      malformed state and never throws.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readPriorThreadFingerprints } from "./index.ts";
import { buildThreadFingerprint } from "./parsers.ts";
import type { ThreadAggregate } from "./types.ts";

function makeAgg(overrides: Partial<ThreadAggregate> = {}): ThreadAggregate {
  return {
    id: "T1",
    subject: "Hello",
    participant_set: new Set(["alice@example.com", "bob@example.com"]),
    message_count: 3,
    first_message_date: "2026-05-01T00:00:00.000Z",
    last_message_date: "2026-05-10T00:00:00.000Z",
    labels_set: new Set(["INBOX", "[Gmail]/Sent Mail"]),
    unread_count: 0,
    flagged_count: 0,
    has_attachments: false,
    ...overrides,
  };
}

test("buildThreadFingerprint: identical aggregates produce identical hashes — fingerprint is content-only", () => {
  const a = makeAgg();
  const b = makeAgg();
  assert.equal(buildThreadFingerprint(a), buildThreadFingerprint(b));
});

test("buildThreadFingerprint: participant-set insertion order does NOT change the hash", () => {
  // The emitted record uses [...set]; insertion order is the JS iteration
  // order. If two builds yielded different orders for the same set of
  // participants, the hash would oscillate and every run would re-emit.
  const a = makeAgg({ participant_set: new Set(["alice@example.com", "bob@example.com"]) });
  const b = makeAgg({ participant_set: new Set(["bob@example.com", "alice@example.com"]) });
  // The fingerprint is stableStringify-based, so the array is sorted-key
  // canonicalized, but array element order itself is preserved. The Set's
  // iteration order differs here intentionally — this test pins that the
  // record builder's array form sorts/stabilizes participants.
  // NOTE: Slack uses sorted arrays; gmail uses Set spread. If this test
  // fails it means we need to sort the participant array in
  // buildThreadRecord (the production code path) so the fingerprint is
  // truly stable across runs where Set iteration could vary.
  // For now this is an aspirational pin — see the report's residual risks
  // if it fails.
  if (buildThreadFingerprint(a) !== buildThreadFingerprint(b)) {
    assert.fail(
      "buildThreadRecord must produce a participant array stable across Set iteration order; " +
        "if this assert fires, sort the array in buildThreadRecord before emitting"
    );
  }
});

test("buildThreadFingerprint: moving message_count changes the hash", () => {
  const a = makeAgg({ message_count: 3 });
  const b = makeAgg({ message_count: 4 });
  assert.notEqual(buildThreadFingerprint(a), buildThreadFingerprint(b));
});

test("buildThreadFingerprint: moving last_message_date changes the hash", () => {
  const a = makeAgg({ last_message_date: "2026-05-10T00:00:00.000Z" });
  const b = makeAgg({ last_message_date: "2026-05-11T00:00:00.000Z" });
  assert.notEqual(buildThreadFingerprint(a), buildThreadFingerprint(b));
});

test("buildThreadFingerprint: adding a label changes the hash", () => {
  const a = makeAgg({ labels_set: new Set(["INBOX"]) });
  const b = makeAgg({ labels_set: new Set(["INBOX", "STARRED"]) });
  assert.notEqual(buildThreadFingerprint(a), buildThreadFingerprint(b));
});

test("buildThreadFingerprint: flag/attachment changes participate in the hash", () => {
  const base = makeAgg();
  assert.notEqual(buildThreadFingerprint(base), buildThreadFingerprint({ ...base, unread_count: 1 }));
  assert.notEqual(buildThreadFingerprint(base), buildThreadFingerprint({ ...base, flagged_count: 1 }));
  assert.notEqual(buildThreadFingerprint(base), buildThreadFingerprint({ ...base, has_attachments: true }));
});

test("readPriorThreadFingerprints: empty state → empty map (first run)", () => {
  const out = readPriorThreadFingerprints({});
  assert.equal(out.size, 0);
});

test("readPriorThreadFingerprints: legacy state (no thread_fingerprints) → empty map (one-time re-emit cost)", () => {
  const out = readPriorThreadFingerprints({ threads: { fetched_at: "2026-05-26T00:00:00.000Z" } });
  assert.equal(out.size, 0);
});

test("readPriorThreadFingerprints: well-formed state round-trips", () => {
  const out = readPriorThreadFingerprints({
    threads: {
      fetched_at: "2026-05-26T00:00:00.000Z",
      thread_fingerprints: { T1: "abc123", T2: "def456" },
    },
  });
  assert.equal(out.size, 2);
  assert.equal(out.get("T1"), "abc123");
  assert.equal(out.get("T2"), "def456");
});

test("readPriorThreadFingerprints: malformed entries are silently dropped", () => {
  const out = readPriorThreadFingerprints({
    threads: {
      thread_fingerprints: {
        T1: "good",
        T2: 42, // wrong type
        T3: "", // empty string
        T4: null, // null
        T5: "alsoGood",
      },
    },
  });
  assert.equal(out.size, 2);
  assert.ok(out.has("T1"));
  assert.ok(out.has("T5"));
});
