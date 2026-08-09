// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `considered` + `covered` declaration on the `timeline_points` stream.
 *
 * The import is a full re-scan of every Timeline file every run, gated by the
 * incremental `last_timestamp` cursor: a point at or before the cursor is
 * skipped because a prior run already covered it. Comparing the denominator
 * against the emitted count would therefore read a false `partial` on every
 * steady-state re-import, so the connector declares `covered` from the same
 * merged boundary it enumerated.
 *
 * The denominator is the merged, deduplicated point array — measured at the
 * enumeration site, never aliased to the emit count. These tests pin both ends
 * of that distinction: a fresh run where emitted === considered, and an
 * incremental run where the cursor suppresses every point and the declaration
 * still reads fully covered.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENTRYPOINT = join(PACKAGE_ROOT, "connectors", "google_maps", "index.ts");

/** Two legacy Takeout points, one per timestamp, in a discoverable Records.json. */
const EXPORT_FIXTURE = {
  locations: [
    {
      timestampMs: "1717595122000",
      latitudeE7: 377_749_000,
      longitudeE7: -1_224_194_000,
      accuracy: 12.4,
    },
    {
      timestampMs: "1717598722000",
      latitudeE7: 377_800_000,
      longitudeE7: -1_224_100_000,
      accuracy: 9.1,
    },
  ],
};

async function runImport(
  importRoot: string,
  state: Record<string, unknown> = {}
): Promise<{ messages: EmittedMessage[] }> {
  const result = await runConnectorProtocolSubprocess({
    cwd: PACKAGE_ROOT,
    entrypoint: ENTRYPOINT,
    env: {
      GOOGLE_MAPS_TIMELINE_DIR: importRoot,
      PDPP_OWNER_TOKEN: "",
      PDPP_RS_URL: "",
      RS_URL: "",
    },
    start: {
      scope: { streams: [{ name: "timeline_points" }] },
      state,
      type: "START",
    },
  });
  return { messages: result.messages };
}

function pointsCoverage(messages: readonly EmittedMessage[]): Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> {
  const coverage = messages.find(
    (message): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
      message.type === "DETAIL_COVERAGE" && message.stream === "timeline_points"
  );
  assert.ok(coverage, "expected timeline_points DETAIL_COVERAGE");
  return coverage;
}

test("google_maps declares the merged point boundary as the timeline_points denominator", async () => {
  const importRoot = await mkdtemp(join(tmpdir(), "pdpp-google-maps-coverage-"));
  try {
    await writeFile(join(importRoot, "Records.json"), JSON.stringify(EXPORT_FIXTURE));
    const { messages } = await runImport(importRoot);

    const emitted = messages.filter(
      (message) => message.type === "RECORD" && message.stream === "timeline_points"
    ).length;
    assert.equal(emitted, 2, "fixture should emit both points on a fresh run");

    const coverage = pointsCoverage(messages);
    assert.equal(coverage.state_stream, "timeline_points");
    assert.equal(coverage.considered, 2);
    assert.equal(coverage.covered, 2);
    assert.deepEqual(coverage.required_keys, []);
    assert.deepEqual(coverage.hydrated_keys, []);
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});

test("google_maps still declares full coverage when the incremental cursor suppresses every point", async () => {
  const importRoot = await mkdtemp(join(tmpdir(), "pdpp-google-maps-steady-"));
  try {
    await writeFile(join(importRoot, "Records.json"), JSON.stringify(EXPORT_FIXTURE));
    // A cursor past the newest fixture point: the re-import re-enumerates the
    // whole boundary and emits nothing.
    const { messages } = await runImport(importRoot, {
      timeline_points: { last_timestamp: "2030-01-01T00:00:00.000Z" },
    });

    const emitted = messages.filter(
      (message) => message.type === "RECORD" && message.stream === "timeline_points"
    ).length;
    assert.equal(emitted, 0, "cursor should suppress every point");

    // The honesty property: covered comes from the enumerated boundary, so a
    // zero-emit steady-state run is covered, not a fabricated or false partial.
    const coverage = pointsCoverage(messages);
    assert.equal(coverage.considered, 2);
    assert.equal(coverage.covered, 2);
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});
