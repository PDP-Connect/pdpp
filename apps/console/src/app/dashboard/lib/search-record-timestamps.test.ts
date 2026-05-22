import assert from "node:assert/strict";
import test from "node:test";
import {
  lookupSearchTimestampMetadata,
  pickSearchDisplayTimestamp,
  searchTimestampMetadataKey,
} from "./search-record-timestamps.ts";

test("pickSearchDisplayTimestamp prefers manifest-declared record time over emitted time", () => {
  const display = pickSearchDisplayTimestamp({
    data: { date: "2026-05-14", emitted_at: "ignored" },
    emittedAt: "2026-05-22T18:00:00Z",
    metadata: { consent_time_field: "date", cursor_field: "date" },
  });
  assert.deepEqual(display, {
    emittedAt: "2026-05-22T18:00:00Z",
    label: "date",
    value: "2026-05-14",
  });
});

test("pickSearchDisplayTimestamp falls back to emitted time when record time is absent", () => {
  assert.deepEqual(
    pickSearchDisplayTimestamp({
      data: { title: "no timestamp here" },
      emittedAt: "2026-05-22T18:00:00Z",
      metadata: { consent_time_field: "created_at", cursor_field: "updated_at" },
    }),
    {
      emittedAt: "2026-05-22T18:00:00Z",
      label: "emitted",
      value: "2026-05-22T18:00:00Z",
    }
  );
});

test("lookupSearchTimestampMetadata resolves local-device connector ids to registry manifests", () => {
  const metadata = new Map([
    [
      searchTimestampMetadataKey("https://registry.pdpp.org/connectors/codex", "messages"),
      { consent_time_field: "timestamp", cursor_field: "timestamp" },
    ],
  ]);
  assert.deepEqual(lookupSearchTimestampMetadata(metadata, "local-device:codex", "messages"), {
    consent_time_field: "timestamp",
    cursor_field: "timestamp",
  });
});
