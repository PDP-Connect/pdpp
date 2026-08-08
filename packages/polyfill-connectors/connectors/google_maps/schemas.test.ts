// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGoogleMapsExport } from "./parsers.ts";
import { timelinePointSchema, timelineSegmentSchema, validateRecord } from "./schemas.ts";

test("timeline_points schema accepts a parser-built legacy point", () => {
  const result = parseGoogleMapsExport({
    locations: [
      {
        timestampMs: "1717595122000",
        latitudeE7: 377_749_000,
        longitudeE7: -1_224_194_000,
        accuracy: 12.5,
      },
    ],
  });
  const [point] = result.points;
  assert.ok(point);
  const parsed = timelinePointSchema.safeParse(point);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
});

test("timeline_segments schema accepts a parser-built visit", () => {
  const result = parseGoogleMapsExport({
    semanticSegments: [
      {
        startTime: "2024-06-05T13:00:00Z",
        visit: {
          topCandidate: {
            placeID: "ChIJ-test",
            semanticType: "TYPE_HOME",
            probability: 0.4,
            placeLocation: { latLng: "geo:37.4219999,-122.0840575" },
          },
        },
      },
    ],
  });
  const [segment] = result.segments;
  assert.ok(segment);
  const parsed = timelineSegmentSchema.safeParse(segment);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
});

test("timeline_points schema rejects out-of-range latitude", () => {
  const parsed = timelinePointSchema.safeParse({
    id: "a".repeat(24),
    timestamp: "2024-06-05T13:45:22.000Z",
    latitude: 900,
    longitude: -122.4194,
    accuracy_meters: null,
    altitude_m: null,
    velocity_mps: null,
    activity_type: null,
    segment_id: null,
    source_format: "legacy_records",
    source_kind: "raw_location",
  });
  assert.equal(parsed.success, false);
});

// A shape-check failure becomes a SKIP_RESULT and the record never reaches
// the owner's store, so this is the test that proves the unmodelled segment
// survives the whole path rather than just the parser.
test("timeline_segments schema accepts an unrecognized segment and keeps the provider key", () => {
  const result = parseGoogleMapsExport({
    semanticSegments: [
      {
        startTime: "2024-06-05T13:00:00Z",
        timelineMemory: { trip: { destinations: [{ identifier: "places/ChIJ-test" }] } },
      },
    ],
  });
  const [segment] = result.segments;
  assert.ok(segment);

  const parsed = timelineSegmentSchema.safeParse(segment);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assert.equal(validateRecord("timeline_segments", { ...segment }).ok, true);
  assert.equal(parsed.data?.unrecognized_kind, "timelineMemory");
});

test("timeline_segments schema still rejects a wrong-typed segment_kind", () => {
  const parsed = timelineSegmentSchema.safeParse({
    id: "0123456789abcdef01234567",
    start_time: "2024-06-05T13:00:00.000Z",
    end_time: null,
    segment_kind: 7,
    source_format: "semantic_segments",
    latitude: null,
    longitude: null,
    place_id: null,
    semantic_type: null,
    activity_type: null,
    probability: null,
    unrecognized_kind: null,
  });
  assert.equal(parsed.success, false);
});

test("validateRecord routes known streams and passes unknown streams through", () => {
  const result = parseGoogleMapsExport({
    locations: [
      {
        timestampMs: "1717595122000",
        latitudeE7: 377_749_000,
        longitudeE7: -1_224_194_000,
      },
    ],
  });
  const [point] = result.points;
  assert.ok(point);
  assert.equal(validateRecord("timeline_points", { ...point }).ok, true);
  assert.equal(validateRecord("unknown_stream", { x: 1 }).ok, true);
});
