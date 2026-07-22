// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
    isSemantic: true,
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
      isSemantic: false,
      label: "emitted",
      value: "2026-05-22T18:00:00Z",
    }
  );
});

test("pickSearchDisplayTimestamp is non-semantic when the stream declares no time field at all (Gmail labels case)", () => {
  // Gmail's `labels` stream has no consent_time_field/cursor_field declared (the
  // IMAP LIST response carries no label creation/modification timestamp) — the
  // manifest correctly omits both, so `metadata` itself is null here, not just
  // missing the fields on `data`. Regression guard for the bug where a stale
  // label re-collected moments ago rendered as if "6 minutes ago" were its own
  // age, when it is really just-now ingestion time.
  assert.deepEqual(
    pickSearchDisplayTimestamp({
      data: { name: "Uniwrap", canonical_name: "uniwrap" },
      emittedAt: "2026-07-13T12:00:00Z",
      metadata: null,
    }),
    {
      emittedAt: "2026-07-13T12:00:00Z",
      isSemantic: false,
      label: "emitted",
      value: "2026-07-13T12:00:00Z",
    }
  );
});

test("lookupSearchTimestampMetadata returns null when connector id is not in the map", () => {
  const metadata = new Map([
    [searchTimestampMetadataKey("codex", "messages"), { consent_time_field: "timestamp", cursor_field: "timestamp" }],
  ]);
  assert.equal(lookupSearchTimestampMetadata(metadata, "gmail", "messages"), null);
});

test("lookupSearchTimestampMetadata looks up by canonical connector key", () => {
  const metadata = new Map([
    [searchTimestampMetadataKey("codex", "messages"), { consent_time_field: "timestamp", cursor_field: "timestamp" }],
  ]);
  assert.deepEqual(lookupSearchTimestampMetadata(metadata, "codex", "messages"), {
    consent_time_field: "timestamp",
    cursor_field: "timestamp",
  });
});
