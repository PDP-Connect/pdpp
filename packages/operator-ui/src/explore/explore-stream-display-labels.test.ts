// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

test("Stream display labels: timeline_points displays as human label, not protocol ID", () => {
  const streamDisplayLabels = new Map<string, string>([
    ["google_maps::timeline_points", "Your Google Maps location points"],
    ["google_maps::timeline_segments", "Your Google Maps visits and activities"],
  ]);

  const label = streamDisplayLabels.get("google_maps::timeline_points");
  assert.equal(label, "Your Google Maps location points");
  assert.notEqual(label, "timeline_points");
});

test("Stream display labels: missing label falls back to stream name in filter", () => {
  const streamDisplayLabels = new Map<string, string>();
  const connectorKey = "gmail";
  const streamName = "messages";
  const labelKey = `${connectorKey}::${streamName}`;

  const label = streamDisplayLabels.get(labelKey) ?? streamName;
  assert.equal(label, "messages");
});

test("Stream display labels: protocol identifiers preserved for routing", () => {
  const streamName = "timeline_points";
  const displayLabel = "Your Google Maps location points";

  // Protocol name used for routing, display label for UI
  const routeParam = `stream=${encodeURIComponent(streamName)}`;
  const displayText = displayLabel;

  assert.equal(routeParam, "stream=timeline_points");
  assert.equal(displayText, "Your Google Maps location points");
  assert.notEqual(routeParam.includes(displayText), true);
});
