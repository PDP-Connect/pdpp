// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for the explore-timeline composite + upcoming CURSOR
// CODECS in operations/rs-explore-timeline/index.ts. None are imported by name.
// These encode/decode the pagination cursors for the explore feed; a codec
// regression corrupts pagination (skipped/duplicated rows) or fails to reject a
// forged/incompatible cursor. Base64url+JSON round-trip, version gating, and
// per-partition shape validation are the mutation surface.
//
// Mutation surface:
//   encode/decodeCompositeCursor -- base64url<->JSON round-trip; version gate
//     (only the current version decodes); required fields (snapshotAt string,
//     snapshotSeq number, nowCeiling string, partitions array); per-partition
//     connectorId/stream strings; direction OPTIONAL (defaults to 'desc').
//   encode/decodeUpcomingCursor -- same envelope with the independent upcoming
//     version and connectorType-carrying partitions.
//   All decode failures throw InvalidCompositeCursorError.

import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeCompositeCursor,
  decodeUpcomingCursor,
  encodeCompositeCursor,
  encodeUpcomingCursor,
  InvalidCompositeCursorError,
  UPCOMING_CURSOR_VERSION,
} from "../operations/rs-explore-timeline/index.ts";

// The composite CURSOR_VERSION is not exported; a valid cursor round-trips, so we
// derive the accepted version by decoding a freshly-encoded valid payload.
const validComposite = {
  direction: "asc" as const,
  nowCeiling: "2024-06-01T00:00:00.000Z",
  partitions: [
    {
      connectorId: "ci-1",
      lastRecordKey: "k1" as string | null,
      lastSemanticTime: "2024-03-01T00:00:00Z" as string | null,
      stream: "orders",
    },
  ],
  snapshotAt: "2024-01-01T00:00:00.000Z",
  snapshotSeq: 100,
  version: 4 as const,
};

// Same encode logic as encodeCompositeCursor/encodeUpcomingCursor, but with an
// `unknown` param — used only to exercise decodeCompositeCursor/
// decodeUpcomingCursor's own runtime validation against deliberately
// off-contract payloads (missing fields, wrong version, malformed partitions)
// that could never satisfy the typed encoder's parameter type.
function encodeRawCursor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

// ---------------------------------------------------------------------------
// composite cursor
// ---------------------------------------------------------------------------

test("decodeCompositeCursor: round-trips a valid encoded payload", () => {
  const decoded = decodeCompositeCursor(encodeCompositeCursor(validComposite));
  assert.deepEqual(decoded, validComposite, "encode -> decode is the identity for a valid payload");
});

test("decodeCompositeCursor: direction is optional and defaults to desc", () => {
  const noDirection: Record<string, unknown> = { ...validComposite };
  noDirection.direction = undefined;
  const decoded = decodeCompositeCursor(encodeRawCursor(noDirection));
  assert.equal(decoded.direction, "desc", "a cursor minted without direction decodes as desc");
});

test("decodeCompositeCursor: an unrecognized direction value falls back to desc", () => {
  const decoded = decodeCompositeCursor(encodeRawCursor({ ...validComposite, direction: "sideways" }));
  assert.equal(decoded.direction, "desc", 'only "asc" is honored; anything else -> desc');
});

test("decodeCompositeCursor: an incompatible version is rejected", () => {
  assert.throws(
    () => decodeCompositeCursor(encodeRawCursor({ ...validComposite, version: 3 })),
    InvalidCompositeCursorError
  );
});

test("decodeCompositeCursor: garbage / non-JSON / missing fields are rejected", () => {
  assert.throws(() => decodeCompositeCursor("%%% not base64url %%%"), InvalidCompositeCursorError);
  const notJson = Buffer.from("not json at all", "utf8").toString("base64url");
  assert.throws(() => decodeCompositeCursor(notJson), InvalidCompositeCursorError);
  const missingFields = Buffer.from(JSON.stringify({ version: 4 }), "utf8").toString("base64url");
  assert.throws(() => decodeCompositeCursor(missingFields), InvalidCompositeCursorError);
});

test("decodeCompositeCursor: a partition missing connectorId/stream is rejected", () => {
  assert.throws(
    () => decodeCompositeCursor(encodeRawCursor({ ...validComposite, partitions: [{ connectorId: "ci-1" }] })),
    InvalidCompositeCursorError
  );
});

test("decodeCompositeCursor: non-string partition seek fields normalize to null", () => {
  const decoded = decodeCompositeCursor(
    encodeRawCursor({
      ...validComposite,
      partitions: [{ connectorId: "ci-1", lastRecordKey: {}, lastSemanticTime: 123, stream: "orders" }],
    })
  );
  assert.equal(decoded.partitions[0]?.lastSemanticTime, null, "non-string semantic time -> null");
  assert.equal(decoded.partitions[0]?.lastRecordKey, null, "non-string record key -> null");
});

// ---------------------------------------------------------------------------
// upcoming cursor
// ---------------------------------------------------------------------------

const validUpcoming = {
  nowCeiling: "2024-06-01T00:00:00.000Z",
  partitions: [
    { connectorId: "ci-1", connectorType: "amazon", lastRecordKey: null, lastSemanticTime: null, stream: "orders" },
  ],
  snapshotAt: "2024-01-01T00:00:00.000Z",
  snapshotSeq: 5,
  version: UPCOMING_CURSOR_VERSION,
};

test("UPCOMING_CURSOR_VERSION is 1", () => {
  assert.equal(UPCOMING_CURSOR_VERSION, 1);
});

test("decodeUpcomingCursor: round-trips a valid payload (carrying connectorType)", () => {
  const decoded = decodeUpcomingCursor(encodeUpcomingCursor(validUpcoming));
  assert.deepEqual(decoded, validUpcoming);
  assert.equal(decoded.partitions[0]?.connectorType, "amazon", "connectorType preserved for partition rebuild");
});

test("decodeUpcomingCursor: an incompatible version is rejected", () => {
  assert.throws(
    () => decodeUpcomingCursor(encodeRawCursor({ ...validUpcoming, version: 2 })),
    InvalidCompositeCursorError
  );
});

test("decodeUpcomingCursor: garbage and missing-field payloads are rejected", () => {
  assert.throws(() => decodeUpcomingCursor("@@@ invalid @@@"), InvalidCompositeCursorError);
  const missing = Buffer.from(JSON.stringify({ snapshotSeq: 5, version: UPCOMING_CURSOR_VERSION }), "utf8").toString(
    "base64url"
  );
  assert.throws(() => decodeUpcomingCursor(missing), InvalidCompositeCursorError);
});
