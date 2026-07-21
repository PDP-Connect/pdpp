// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema tests for the Loom connector.
 *
 * IMPORTANT: loom/index.ts does not yet emit any RECORD (Apollo extraction is
 * deferred; it emits SKIP_RESULT). So unlike the other Lane A connectors, these
 * fixtures are NOT parser-derived — they are records shaped to the connector's
 * MANIFEST stream contract (manifests/loom.json). They prove the schema accepts
 * the declared contract and rejects representative drift, so the first real emit
 * is shape-checked. Whoever wires extraction MUST replace these with
 * fixture-proven records and tighten the id shapes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { transcriptsSchema, validateRecord, videosSchema } from "./schemas.ts";

// Manifest-contract-shaped video record (videos stream).
const VIDEO_RECORD = {
  id: "abc123def456",
  title: "Sprint demo",
  description: "Walkthrough of the new dashboard.",
  duration_seconds: 312,
  view_count: 7,
  created_at: "2024-06-05T13:45:22.000Z",
  share_url: "https://www.loom.com/share/abc123def456",
  has_transcript: true,
};

// Manifest-contract-shaped transcript record (transcripts stream).
const TRANSCRIPT_RECORD = {
  id: "abc123def456:transcript",
  video_id: "abc123def456",
  text: "Hi everyone, today I'll walk through the new dashboard...",
};

test("videos schema accepts a contract-shaped record", () => {
  const result = videosSchema.safeParse(VIDEO_RECORD);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("videos schema accepts a minimal record (only id, rest null)", () => {
  const result = videosSchema.safeParse({
    id: "abc123def456",
    title: null,
    description: null,
    duration_seconds: null,
    view_count: null,
    created_at: null,
    share_url: null,
    has_transcript: null,
  });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("transcripts schema accepts a contract-shaped record", () => {
  const result = transcriptsSchema.safeParse(TRANSCRIPT_RECORD);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("videos schema rejects a negative view_count", () => {
  assert.equal(videosSchema.safeParse({ ...VIDEO_RECORD, view_count: -1 }).success, false);
});

test("videos schema rejects a non-URL share_url", () => {
  assert.equal(videosSchema.safeParse({ ...VIDEO_RECORD, share_url: "not a url" }).success, false);
});

test("validateRecord routes both streams and passes unknown streams through", () => {
  assert.equal(validateRecord("videos", VIDEO_RECORD).ok, true);
  assert.equal(validateRecord("transcripts", TRANSCRIPT_RECORD).ok, true);
  assert.equal(validateRecord("unknown_stream", { x: 1 }).ok, true);
});
