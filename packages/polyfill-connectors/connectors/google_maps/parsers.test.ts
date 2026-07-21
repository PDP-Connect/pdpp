import assert from "node:assert/strict";
import { test } from "node:test";
import { hashId, parseGoogleMapsExport } from "./parsers.ts";

test("parseGoogleMapsExport: parses legacy Takeout Records.json points", () => {
  const result = parseGoogleMapsExport({
    locations: [
      {
        timestampMs: "1717595122000",
        latitudeE7: 377_749_000,
        longitudeE7: -1_224_194_000,
        accuracy: 12.4,
        velocity: 3.1,
        altitude: 30.5,
        activity: [{ activity: [{ type: "STILL" }] }],
      },
    ],
  });

  assert.equal(result.segments.length, 0);
  assert.equal(result.points.length, 1);
  assert.equal(result.points[0]?.timestamp, "2024-06-05T13:45:22.000Z");
  assert.equal(result.points[0]?.latitude, 37.7749);
  assert.equal(result.points[0]?.longitude, -122.4194);
  assert.equal(result.points[0]?.accuracy_meters, 12.4);
  assert.equal(result.points[0]?.activity_type, "STILL");
  assert.equal(result.points[0]?.source_format, "legacy_records");
  assert.equal(result.points[0]?.source_kind, "raw_location");
});

test("parseGoogleMapsExport: skips invalid legacy coordinates", () => {
  const result = parseGoogleMapsExport({
    locations: [
      {
        timestampMs: "1717595122000",
        latitudeE7: 9_999_999_999,
        longitudeE7: -1_224_194_000,
      },
    ],
  });

  assert.deepEqual(result, { points: [], segments: [] });
});

test("parseGoogleMapsExport: parses semantic segment visits and path points", () => {
  const result = parseGoogleMapsExport({
    semanticSegments: [
      {
        startTime: "2024-06-05T13:00:00Z",
        endTime: "2024-06-05T14:00:00Z",
        visit: {
          topCandidate: {
            placeID: "ChIJ-test",
            semanticType: "TYPE_HOME",
            probability: 0.91,
            placeLocation: { latLng: "geo:37.4219999,-122.0840575" },
          },
        },
        timelinePath: [
          { point: "geo:37.4219999,-122.0840575", time: "2024-06-05T13:15:00Z" },
          { point: "37.4221000, -122.0841000", time: "2024-06-05T13:30:00Z" },
        ],
      },
    ],
  });

  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0]?.segment_kind, "visit");
  assert.equal(result.segments[0]?.place_id, "ChIJ-test");
  assert.equal(result.segments[0]?.probability, 0.91);
  assert.equal(result.segments[0]?.source_format, "semantic_segments");
  assert.equal(result.points.length, 3);
  assert.equal(result.points[0]?.source_kind, "visit_location");
  assert.equal(result.points[1]?.source_kind, "timeline_path");
  assert.equal(result.points[1]?.segment_id, result.segments[0]?.id);
});

test("parseGoogleMapsExport: parses timelineObjects activity start and end points", () => {
  const result = parseGoogleMapsExport({
    timelineObjects: [
      {
        activitySegment: {
          duration: {
            startTimestamp: "2024-06-05T15:00:00Z",
            endTimestamp: "2024-06-05T15:30:00Z",
          },
          activityType: "IN_PASSENGER_VEHICLE",
          startLocation: { latitudeE7: 377_749_000, longitudeE7: -1_224_194_000 },
          endLocation: { latitudeE7: 377_760_000, longitudeE7: -1_224_180_000 },
        },
      },
    ],
  });

  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0]?.segment_kind, "activity");
  assert.equal(result.segments[0]?.activity_type, "IN_PASSENGER_VEHICLE");
  assert.equal(result.points.length, 2);
  assert.equal(result.points[0]?.source_kind, "activity_start");
  assert.equal(result.points[1]?.source_kind, "activity_end");
  assert.equal(result.points[0]?.segment_id, result.segments[0]?.id);
});

test("parseGoogleMapsExport: accepts an array of timelineObjects", () => {
  const result = parseGoogleMapsExport([
    {
      placeVisit: {
        duration: {
          startTimestamp: "2024-06-05T16:00:00Z",
          endTimestamp: "2024-06-05T17:00:00Z",
        },
        location: {
          placeId: "place-array",
          semanticType: "TYPE_WORK",
          latitudeE7: 407_128_000,
          longitudeE7: -740_060_000,
        },
      },
    },
  ]);

  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0]?.source_format, "timeline_objects");
  assert.equal(result.segments[0]?.semantic_type, "TYPE_WORK");
  assert.equal(result.points.length, 1);
  assert.equal(result.points[0]?.latitude, 40.7128);
});

test("parseGoogleMapsExport: stable ids dedupe repeated files", () => {
  const payload = {
    locations: [
      {
        timestampMs: "1717595122000",
        latitudeE7: 377_749_000,
        longitudeE7: -1_224_194_000,
      },
      {
        timestampMs: "1717595122000",
        latitudeE7: 377_749_000,
        longitudeE7: -1_224_194_000,
      },
    ],
  };

  const first = parseGoogleMapsExport(payload);
  const second = parseGoogleMapsExport(payload);
  assert.equal(first.points.length, 1);
  assert.equal(first.points[0]?.id, second.points[0]?.id);
});

test("hashId: deterministic 24-char hex output", () => {
  const id = hashId("google|maps|timeline");
  assert.match(id, /^[0-9a-f]{24}$/);
  assert.equal(id, hashId("google|maps|timeline"));
});
