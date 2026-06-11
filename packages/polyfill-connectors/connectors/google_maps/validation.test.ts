import assert from "node:assert/strict";
import { test } from "node:test";
import { validateGoogleMapsTimelineArtifact } from "./validation.ts";

const VALID_LEGACY = JSON.stringify({
  locations: [
    {
      timestampMs: "1717595122000",
      latitudeE7: 377_749_000,
      longitudeE7: -1_224_194_000,
    },
  ],
});

test("validateGoogleMapsTimelineArtifact reports format, counts, date range, and valid status", () => {
  const validation = validateGoogleMapsTimelineArtifact(VALID_LEGACY);

  assert.equal(validation.status, "valid");
  assert.equal(validation.detected_format, "legacy_records");
  assert.equal(validation.estimated_points, 1);
  assert.equal(validation.estimated_segments, 0);
  assert.equal(validation.date_range.start, "2024-06-05T13:45:22.000Z");
  assert.equal(validation.date_range.end, "2024-06-05T13:45:22.000Z");
  assert.match(validation.file_sha256, /^[0-9a-f]{64}$/);
});

test("validateGoogleMapsTimelineArtifact identifies duplicate artifacts by stable file hash", () => {
  const first = validateGoogleMapsTimelineArtifact(VALID_LEGACY);
  const duplicate = validateGoogleMapsTimelineArtifact(VALID_LEGACY, {
    existingFileHashes: [first.file_sha256],
  });

  assert.equal(duplicate.status, "duplicate");
  assert.match(duplicate.remediation ?? "", /already imported/i);
});

test("validateGoogleMapsTimelineArtifact identifies stale artifacts by imported-through frontier", () => {
  const validation = validateGoogleMapsTimelineArtifact(VALID_LEGACY, {
    importedThrough: "2024-06-06T00:00:00.000Z",
  });

  assert.equal(validation.status, "stale");
  assert.match(validation.remediation ?? "", /newer Timeline file/i);
});

test("validateGoogleMapsTimelineArtifact identifies empty recognized Timeline files", () => {
  const validation = validateGoogleMapsTimelineArtifact(JSON.stringify({ timelineObjects: [] }));

  assert.equal(validation.status, "empty");
  assert.equal(validation.detected_format, "timeline_objects");
  assert.equal(validation.estimated_points, 0);
  assert.equal(validation.estimated_segments, 0);
});

test("validateGoogleMapsTimelineArtifact identifies unsupported artifacts", () => {
  const validation = validateGoogleMapsTimelineArtifact(JSON.stringify({ archive_jobs: [] }));

  assert.equal(validation.status, "unsupported");
  assert.equal(validation.detected_format, "unsupported");
  assert.match(validation.remediation ?? "", /Timeline JSON export/i);
});

test("validateGoogleMapsTimelineArtifact identifies artifacts over the manifest limit", () => {
  const validation = validateGoogleMapsTimelineArtifact(VALID_LEGACY, { maxFileBytes: 8 });

  assert.equal(validation.status, "too_large");
  assert.match(validation.remediation ?? "", /import-folder/i);
});
