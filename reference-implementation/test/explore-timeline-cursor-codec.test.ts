// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for the UNTESTED pagination-cursor codecs exported by
 * `operations/rs-explore-timeline/index.ts`:
 * `encodeCompositeCursor` / `decodeCompositeCursor` (main feed, version 4) and
 * `encodeUpcomingCursor` / `decodeUpcomingCursor` (upcoming feed, version 1).
 *
 * These are the read-model paging handles the Explore timeline hands back to
 * clients. The contract pinned here:
 *
 *   - encode is `base64url(JSON.stringify(payload))`; decode is the inverse and
 *     round-trips a full payload byte-for-byte;
 *   - decode REJECTS (throws InvalidCompositeCursorError) on: non-base64url that
 *     fails to parse as JSON, non-JSON, wrong/absent version, missing required
 *     scalar fields, non-array partitions, and per-partition shape violations;
 *   - the main cursor's `direction` is OPTIONAL and defaults to "desc" when the
 *     encoded payload omits it (backward-compat for pre-direction cursors);
 *   - per-partition `lastSemanticTime` / `lastRecordKey` normalize to null when
 *     not a string;
 *   - the two codecs are version-isolated: an upcoming payload (version 1) is
 *     rejected by the composite decoder (expects version 4) and vice-versa;
 *   - the upcoming partition additionally requires `connectorType`.
 *
 * Pure — the module has no DB/server imports. No fixtures needed.
 */

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

const COMPOSITE_VERSION = 4;

// Well-formed composite payload builder — matches CompositeCursorPayload's
// real shape so it can pass through the typed encoder. `direction` is
// declared optional here (mirroring the interface) so it can be `delete`d.
interface WellFormedCompositePayload {
  direction?: "asc" | "desc";
  nowCeiling: string;
  partitions: Array<{
    connectorId: string;
    stream: string;
    lastSemanticTime: string | null;
    lastRecordKey: string | null;
  }>;
  snapshotAt: string;
  snapshotSeq: number;
  version: 4;
}

function compositePayload(overrides: Partial<WellFormedCompositePayload> = {}): WellFormedCompositePayload {
  return {
    direction: "asc",
    nowCeiling: "2026-07-02T00:00:00.000Z",
    partitions: [
      {
        connectorId: "cin_1",
        lastRecordKey: "k1",
        lastSemanticTime: "2026-06-01T00:00:00.000Z",
        stream: "orders",
      },
    ],
    snapshotAt: "2026-07-01T00:00:00.000Z",
    snapshotSeq: 100,
    version: COMPOSITE_VERSION,
    ...overrides,
  };
}

interface WellFormedUpcomingPayload {
  nowCeiling: string;
  partitions: Array<{
    connectorId: string;
    connectorType: string;
    stream: string;
    lastSemanticTime: string | null;
    lastRecordKey: string | null;
  }>;
  snapshotAt: string;
  snapshotSeq: number;
  version: 1;
}

function upcomingPayload(overrides: Partial<WellFormedUpcomingPayload> = {}): WellFormedUpcomingPayload {
  return {
    nowCeiling: "2026-07-02T00:00:00.000Z",
    partitions: [
      {
        connectorId: "cin_1",
        connectorType: "amazon",
        lastRecordKey: "k9",
        lastSemanticTime: "2026-08-01T00:00:00.000Z",
        stream: "orders",
      },
    ],
    snapshotAt: "2026-07-01T00:00:00.000Z",
    snapshotSeq: 200,
    version: UPCOMING_CURSOR_VERSION,
    ...overrides,
  };
}

// Loosely-typed builders for the malformed-payload tests below: same default
// shape as compositePayload()/upcomingPayload(), but `overrides` accepts any
// shape (including off-contract values) since these feed b64urlOf directly,
// bypassing the typed encoder, to exercise the decoder's own validation.
function rawCompositePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...compositePayload(), ...overrides };
}

function rawUpcomingPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...upcomingPayload(), ...overrides };
}

// helper: base64url-encode an arbitrary object (bypassing the typed encoder)
// so we can test the decoder against hand-built (including deliberately
// malformed) payloads.
function b64urlOf(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

// --- composite cursor -------------------------------------------------------

test("encode/decodeCompositeCursor: full payload round-trips exactly", () => {
  const payload = compositePayload();
  const decoded = decodeCompositeCursor(encodeCompositeCursor(payload));
  assert.deepEqual(decoded, payload, `decoded: ${JSON.stringify(decoded)}`);
});

test("encodeCompositeCursor: output is base64url of the JSON payload", () => {
  const payload = compositePayload();
  const encoded = encodeCompositeCursor(payload);
  const roundTripJson = Buffer.from(encoded, "base64url").toString("utf8");
  assert.deepEqual(JSON.parse(roundTripJson), payload);
  // base64url alphabet: no '+', '/', or '=' padding.
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.equal(/[+/=]/.test(encoded), false, `encoded must be base64url-clean: ${encoded}`);
});

test('decodeCompositeCursor: direction defaults to "desc" when omitted (pre-direction cursor)', () => {
  const { direction: _direction, ...payload } = compositePayload();
  const decoded = decodeCompositeCursor(b64urlOf(payload));
  assert.equal(decoded.direction, "desc", `direction: ${decoded.direction}`);
});

test('decodeCompositeCursor: an unknown direction value normalizes to "desc"', () => {
  const decoded = decodeCompositeCursor(b64urlOf(rawCompositePayload({ direction: "sideways" })));
  assert.equal(decoded.direction, "desc", `direction: ${decoded.direction}`);
});

test("decodeCompositeCursor: non-string partition seek fields normalize to null", () => {
  const decoded = decodeCompositeCursor(
    b64urlOf(
      rawCompositePayload({
        partitions: [{ connectorId: "cin_1", lastRecordKey: null, lastSemanticTime: 42, stream: "orders" }],
      })
    )
  );
  assert.equal(decoded.partitions[0]?.lastSemanticTime, null, "numeric semantic-time -> null");
  assert.equal(decoded.partitions[0]?.lastRecordKey, null, "null record-key stays null");
});

test("decodeCompositeCursor: rejects a wrong version", () => {
  assert.throws(
    () => decodeCompositeCursor(b64urlOf(rawCompositePayload({ version: 3 }))),
    InvalidCompositeCursorError
  );
});

test("decodeCompositeCursor: rejects a missing required scalar (nowCeiling)", () => {
  const payload = rawCompositePayload();
  payload.nowCeiling = undefined;
  assert.throws(() => decodeCompositeCursor(b64urlOf(payload)), InvalidCompositeCursorError);
});

test("decodeCompositeCursor: rejects non-array partitions", () => {
  assert.throws(
    () => decodeCompositeCursor(b64urlOf(rawCompositePayload({ partitions: { nope: true } }))),
    InvalidCompositeCursorError
  );
});

test("decodeCompositeCursor: rejects a partition missing connectorId/stream", () => {
  assert.throws(
    () => decodeCompositeCursor(b64urlOf(rawCompositePayload({ partitions: [{ connectorId: "cin_1" }] }))),
    InvalidCompositeCursorError
  );
});

test("decodeCompositeCursor: rejects payload that is valid JSON but not an object", () => {
  assert.throws(() => decodeCompositeCursor(b64urlOf(["not", "an", "object"])), InvalidCompositeCursorError);
  assert.throws(() => decodeCompositeCursor(b64urlOf(42)), InvalidCompositeCursorError);
});

test("decodeCompositeCursor: rejects a payload that is not valid JSON", () => {
  const notJson = Buffer.from("this is not json", "utf8").toString("base64url");
  assert.throws(() => decodeCompositeCursor(notJson), InvalidCompositeCursorError);
});

// --- upcoming cursor --------------------------------------------------------

test("encode/decodeUpcomingCursor: full payload round-trips exactly", () => {
  const payload = upcomingPayload();
  const decoded = decodeUpcomingCursor(encodeUpcomingCursor(payload));
  assert.deepEqual(decoded, payload, `decoded: ${JSON.stringify(decoded)}`);
});

test("decodeUpcomingCursor: has NO direction field (upcoming is always ASC)", () => {
  const decoded = decodeUpcomingCursor(encodeUpcomingCursor(upcomingPayload()));
  assert.equal("direction" in decoded, false, "upcoming payload must not carry direction");
});

test("decodeUpcomingCursor: requires connectorType on each partition", () => {
  assert.throws(
    () =>
      decodeUpcomingCursor(
        b64urlOf(
          rawUpcomingPayload({
            // connectorType omitted -> invalid upcoming partition shape.
            partitions: [{ connectorId: "cin_1", stream: "orders" }],
          })
        )
      ),
    InvalidCompositeCursorError
  );
});

test("decodeUpcomingCursor: non-string partition seek fields normalize to null", () => {
  const decoded = decodeUpcomingCursor(
    b64urlOf(
      rawUpcomingPayload({
        partitions: [
          { connectorId: "cin_1", connectorType: "amazon", lastRecordKey: 9, lastSemanticTime: 7, stream: "orders" },
        ],
      })
    )
  );
  assert.equal(decoded.partitions[0]?.lastSemanticTime, null);
  assert.equal(decoded.partitions[0]?.lastRecordKey, null);
});

// --- version isolation between the two codecs -------------------------------

test("cross-codec version isolation: upcoming payload (v1) is rejected by the composite decoder", () => {
  // An upcoming payload carries version 1; the composite decoder expects 4.
  assert.throws(() => decodeCompositeCursor(encodeUpcomingCursor(upcomingPayload())), InvalidCompositeCursorError);
});

test("cross-codec version isolation: composite payload (v4) is rejected by the upcoming decoder", () => {
  // A composite payload carries version 4; the upcoming decoder expects 1.
  assert.throws(() => decodeUpcomingCursor(encodeCompositeCursor(compositePayload())), InvalidCompositeCursorError);
});
