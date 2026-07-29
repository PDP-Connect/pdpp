const TOP_LEVEL_REGEX_1 = /partition\[1\]/;
const TOP_LEVEL_REGEX_2 = /partition\[0\]/;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { CompositeCursorPayload, UpcomingCursorPayload } from "../operations/rs-explore-timeline/index.ts";
import {
  decodeCompositeCursor,
  decodeUpcomingCursor,
  encodeCompositeCursor,
  encodeUpcomingCursor,
  InvalidCompositeCursorError,
} from "../operations/rs-explore-timeline/index.ts";

// Mutation-killing unit tests for the PURE composite/upcoming cursor codec in
// `rs.explore.timeline`. These functions are the opaque-cursor contract for the
// k-way-merge timeline read model: they round-trip the pinned snapshot anchor
// (snapshotSeq / snapshotAt), the past/future boundary (nowCeiling), the scan
// direction, and each partition's keyset position — and REJECT stale or
// malformed cursors so a mis-versioned cursor re-anchors a fresh snapshot
// instead of mis-seeking. The integration tests exercise the merge over a real
// DB; NONE call the codec directly, so every validation branch here is otherwise
// unguarded. No DB, no I/O.

// A base64url encoder for hand-built (deliberately malformed) payloads.
function b64url(obj: unknown) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

// --------------------------------------------------------------------------
// Composite cursor — happy-path round trip
// --------------------------------------------------------------------------

test("composite cursor: round-trips every field (desc default omits direction on encode)", () => {
  const payload: CompositeCursorPayload = {
    nowCeiling: "2026-06-02T12:00:00.000Z",
    partitions: [
      {
        connectorId: "cin_a",
        lastRecordKey: "rk-1",
        lastSemanticTime: "2026-05-30T00:00:00.000Z",
        stream: "transactions",
      },
    ],
    snapshotAt: "2026-06-01T00:00:00.000Z",
    snapshotSeq: 12_345,
    version: 4,
  };
  const decoded = decodeCompositeCursor(encodeCompositeCursor(payload));
  assert.equal(decoded.version, 4);
  assert.equal(decoded.snapshotSeq, 12_345);
  assert.equal(decoded.snapshotAt, "2026-06-01T00:00:00.000Z");
  assert.equal(decoded.nowCeiling, "2026-06-02T12:00:00.000Z");
  // No direction on the encoded payload => decodes as "desc".
  assert.equal(decoded.direction, "desc");
  assert.deepEqual(decoded.partitions, [
    {
      connectorId: "cin_a",
      lastRecordKey: "rk-1",
      lastSemanticTime: "2026-05-30T00:00:00.000Z",
      stream: "transactions",
    },
  ]);
});

test('composite cursor: direction "asc" survives the round trip', () => {
  const decoded = decodeCompositeCursor(
    encodeCompositeCursor({
      direction: "asc",
      nowCeiling: "2026-06-01T00:00:00.000Z",
      partitions: [],
      snapshotAt: "2026-06-01T00:00:00.000Z",
      snapshotSeq: 1,
      version: 4,
    })
  );
  assert.equal(decoded.direction, "asc");
});

test('composite cursor: an unknown direction value decays to "desc"', () => {
  const decoded = decodeCompositeCursor(
    b64url({
      direction: "sideways",
      nowCeiling: "t",
      partitions: [],
      snapshotAt: "t",
      snapshotSeq: 1,
      version: 4,
    })
  );
  assert.equal(decoded.direction, "desc");
});

test("composite cursor: non-string keyset fields coerce to null (not left as-is)", () => {
  const decoded = decodeCompositeCursor(
    b64url({
      nowCeiling: "t",
      partitions: [
        // lastSemanticTime / lastRecordKey are numbers / missing => must become null.
        { connectorId: "c", lastRecordKey: null, lastSemanticTime: 123, stream: "s" },
        { connectorId: "c2", stream: "s2" },
      ],
      snapshotAt: "t",
      snapshotSeq: 1,
      version: 4,
    })
  );
  // biome-ignore lint/style/useDestructuring: index access documents the asserted ordered position
  const partition0 = decoded.partitions[0];
  // biome-ignore lint/style/useDestructuring: index access documents the asserted ordered position
  const partition1 = decoded.partitions[1];
  assert.ok(partition0, "expected decoded.partitions[0] to be defined");
  assert.ok(partition1, "expected decoded.partitions[1] to be defined");
  assert.equal(partition0.lastSemanticTime, null);
  assert.equal(partition0.lastRecordKey, null);
  assert.equal(partition1.lastSemanticTime, null);
  assert.equal(partition1.lastRecordKey, null);
  // The valid string identity fields are preserved verbatim.
  assert.equal(partition0.connectorId, "c");
  assert.equal(partition1.stream, "s2");
});

// --------------------------------------------------------------------------
// Composite cursor — rejection branches (each one otherwise unguarded)
// --------------------------------------------------------------------------

test("composite cursor: a wrong version is rejected as InvalidCompositeCursorError", () => {
  const stale = b64url({
    nowCeiling: "t",
    partitions: [],
    snapshotAt: "t",
    snapshotSeq: 1,
    version: 3, // v3 keyset key no longer matches the sort => must be rejected.
  });
  assert.throws(() => decodeCompositeCursor(stale), InvalidCompositeCursorError);
});

test("composite cursor: each missing/mistyped top-level field is rejected", () => {
  const base = { nowCeiling: "t", partitions: [], snapshotAt: "t", snapshotSeq: 1, version: 4 };
  // snapshotSeq must be a number.
  assert.throws(() => decodeCompositeCursor(b64url({ ...base, snapshotSeq: "1" })), InvalidCompositeCursorError);
  // snapshotAt must be a string.
  assert.throws(() => decodeCompositeCursor(b64url({ ...base, snapshotAt: 123 })), InvalidCompositeCursorError);
  // nowCeiling must be a string (v4-required).
  assert.throws(() => decodeCompositeCursor(b64url({ ...base, nowCeiling: 123 })), InvalidCompositeCursorError);
  // partitions must be an array.
  assert.throws(() => decodeCompositeCursor(b64url({ ...base, partitions: {} })), InvalidCompositeCursorError);
});

test("composite cursor: a partition with a bad shape is rejected (with its index)", () => {
  const bad = b64url({
    nowCeiling: "t",
    partitions: [
      { connectorId: "ok", stream: "s" },
      { connectorId: "missing-stream" }, // stream absent => invalid shape
    ],
    snapshotAt: "t",
    snapshotSeq: 1,
    version: 4,
  });
  assert.throws(
    () => decodeCompositeCursor(bad),
    (err) => {
      assert.ok(err instanceof InvalidCompositeCursorError);
      assert.match(err.message, TOP_LEVEL_REGEX_1);
      return true;
    }
  );
});

test("composite cursor: non-JSON / non-base64url payloads are rejected, not thrown raw", () => {
  // Valid base64url but not JSON.
  const notJson = Buffer.from("this is not json", "utf8").toString("base64url");
  assert.throws(() => decodeCompositeCursor(notJson), InvalidCompositeCursorError);
  // A JSON primitive (not an object) fails the object/version guard.
  assert.throws(() => decodeCompositeCursor(b64url(42)), InvalidCompositeCursorError);
  // Explicit null payload.
  assert.throws(() => decodeCompositeCursor(b64url(null)), InvalidCompositeCursorError);
});

// --------------------------------------------------------------------------
// Upcoming cursor — round trip + validation (independent version = 1)
// --------------------------------------------------------------------------

test("upcoming cursor: round-trips every field including connectorType", () => {
  const payload: UpcomingCursorPayload = {
    nowCeiling: "2026-06-02T00:00:00.000Z",
    partitions: [
      {
        connectorId: "cin_x",
        connectorType: "amazon",
        lastRecordKey: "rk-9",
        lastSemanticTime: "2026-07-01T00:00:00.000Z",
        stream: "orders",
      },
    ],
    snapshotAt: "2026-06-01T00:00:00.000Z",
    snapshotSeq: 99,
    version: 1,
  };
  const decoded = decodeUpcomingCursor(encodeUpcomingCursor(payload));
  assert.deepEqual(decoded, payload);
});

test("upcoming cursor: version mismatch is rejected (independent of composite version)", () => {
  // The main composite version (4) must NOT be accepted as an upcoming cursor.
  assert.throws(
    () =>
      decodeUpcomingCursor(
        b64url({
          nowCeiling: "t",
          partitions: [],
          snapshotAt: "t",
          snapshotSeq: 1,
          version: 4,
        })
      ),
    InvalidCompositeCursorError
  );
});

test("upcoming cursor: a partition missing connectorType is an invalid shape", () => {
  // Unlike the main cursor, the upcoming partition REQUIRES connectorType so the
  // future-page fetch can rebuild the partition identity without re-enumeration.
  const bad = b64url({
    nowCeiling: "t",
    partitions: [{ connectorId: "c", stream: "s" }], // connectorType absent
    snapshotAt: "t",
    snapshotSeq: 1,
    version: 1,
  });
  assert.throws(
    () => decodeUpcomingCursor(bad),
    (err) => {
      assert.ok(err instanceof InvalidCompositeCursorError);
      assert.match(err.message, TOP_LEVEL_REGEX_2);
      return true;
    }
  );
});

test("upcoming cursor: non-string keyset fields coerce to null", () => {
  const decoded = decodeUpcomingCursor(
    b64url({
      nowCeiling: "t",
      partitions: [{ connectorId: "c", connectorType: "ct", lastSemanticTime: 5, stream: "s" }],
      snapshotAt: "t",
      snapshotSeq: 1,
      version: 1,
    })
  );
  // biome-ignore lint/style/useDestructuring: index access documents the asserted ordered position
  const partition0 = decoded.partitions[0];
  assert.ok(partition0, "expected decoded.partitions[0] to be defined");
  assert.equal(partition0.lastSemanticTime, null);
  assert.equal(partition0.lastRecordKey, null);
});

test("upcoming cursor: each missing/mistyped top-level field is rejected", () => {
  const base = { nowCeiling: "t", partitions: [], snapshotAt: "t", snapshotSeq: 1, version: 1 };
  assert.throws(() => decodeUpcomingCursor(b64url({ ...base, snapshotSeq: "1" })), InvalidCompositeCursorError);
  assert.throws(() => decodeUpcomingCursor(b64url({ ...base, snapshotAt: 1 })), InvalidCompositeCursorError);
  assert.throws(() => decodeUpcomingCursor(b64url({ ...base, nowCeiling: 1 })), InvalidCompositeCursorError);
  assert.throws(() => decodeUpcomingCursor(b64url({ ...base, partitions: "nope" })), InvalidCompositeCursorError);
});
