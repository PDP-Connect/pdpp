// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { resolveStreamDisplayLabel } from "./explore-data-assembler.ts";

test("Stream display labels: timeline_points displays as human label, not protocol ID", () => {
  const streamDisplayLabels = new Map<string, string>([
    ["google-maps::timeline_points", "Your Google Maps location points"],
    ["google-maps::timeline_segments", "Your Google Maps visits and activities"],
  ]);

  const label = resolveStreamDisplayLabel(streamDisplayLabels, "google-maps", "timeline_points");
  assert.equal(label, "Your Google Maps location points");
  assert.notEqual(label, "timeline_points");
});

test("Stream display labels: missing label falls back to stream name in filter", () => {
  const streamDisplayLabels = new Map<string, string>();
  const label = resolveStreamDisplayLabel(streamDisplayLabels, "gmail", "messages");
  assert.equal(label, "messages");
});

test("Stream display labels: preserves protocol stream names when no label exists", () => {
  const streamDisplayLabels = new Map<string, string>([
    ["google-maps::timeline_points", "Your Google Maps location points"],
  ]);

  assert.equal(resolveStreamDisplayLabel(streamDisplayLabels, "google-maps", "unknown_stream"), "unknown_stream");
});
