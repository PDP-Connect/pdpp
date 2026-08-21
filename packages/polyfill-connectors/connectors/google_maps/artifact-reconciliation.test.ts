// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Artifact reconciliation for the Google Maps one-time import.
 *
 * The anchor for this connector is the ARTIFACT, not the account. The
 * denominator is every element the parser produced from the uploaded file;
 * the numerator is only what this run could key, dedupe and ingest. An element
 * the artifact held but the run could not account for (no usable id /
 * timestamp) must stay in the denominator, so the stream reads `partial`.
 *
 * Before this was bound, such an element was dropped by a bare `continue`:
 * a 3-element artifact reported `considered: 2, covered: 2` with zero skips —
 * a fabricated denominator computed from the same survivors it claimed to
 * verify. These tests pin the drop into view.
 *
 * SCOPE LIMIT, stated plainly: a fully-reconciled artifact proves only that
 * this run ingested everything the FILE contained. It says nothing about
 * whether Google chose to export everything the provider holds. There is no
 * provider-side assertion available for a file drop, and none is invented here.
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

async function runImport(
  importRoot: string,
  streams: readonly string[] = ["timeline_points"]
): Promise<EmittedMessage[]> {
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
      scope: { streams: streams.map((name) => ({ name })) },
      state: {},
      type: "START",
    },
  });
  return result.messages;
}

/**
 * The stream's single coverage verdict.
 *
 * Asserting there is EXACTLY one is load-bearing, not defensive tidiness. A
 * missing early-return lets the drop-aware declaration be followed by a
 * `buildFullScanCoverageMessage` fallback, so the stream emits an honest
 * `2/1` and then a fabricated `1/1`. Taking the first match would call that
 * mutant a pass; a consumer reading the last one would call it `complete`.
 * A stream must state its coverage once.
 */
function coverageFor(
  messages: readonly EmittedMessage[],
  stream: string
): Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> {
  const all = messages.filter(
    (message): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
      message.type === "DETAIL_COVERAGE" && message.stream === stream
  );
  assert.equal(all.length, 1, `expected exactly one ${stream} DETAIL_COVERAGE, got ${String(all.length)}`);
  return all[0] as Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }>;
}

test("a point element with no timestamp stays in the denominator as considered-but-not-covered", async () => {
  const importRoot = await mkdtemp(join(tmpdir(), "pdpp-gm-unaccounted-point-"));
  try {
    // Three location elements. The middle one carries no `timestampMs`, so it
    // can never be keyed — but the artifact did contain it.
    await writeFile(
      join(importRoot, "Records.json"),
      JSON.stringify({
        locations: [
          { timestampMs: "1717595122000", latitudeE7: 377_749_000, longitudeE7: -1_224_194_000, accuracy: 12.4 },
          { latitudeE7: 377_800_000, longitudeE7: -1_224_100_000, accuracy: 9.1 },
          { timestampMs: "1717598722000", latitudeE7: 377_800_000, longitudeE7: -1_224_100_000, accuracy: 9.1 },
        ],
      })
    );
    const messages = await runImport(importRoot);

    const emitted = messages.filter((m) => m.type === "RECORD" && m.stream === "timeline_points").length;
    assert.equal(emitted, 2, "only the two keyable points can be ingested");

    const coverage = coverageFor(messages, "timeline_points");
    // The load-bearing assertion: the artifact held 3 elements, so 3 is the
    // denominator. A regression that drops the element silently reports 2/2.
    assert.equal(coverage.considered, 3, "the artifact's third element must remain in the denominator");
    assert.equal(coverage.covered, 2, "only accounted-for elements may be claimed as covered");
    assert.ok(coverage.covered < coverage.considered, "an unaccounted element must read partial, never complete");
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});

test("an unaccounted point element surfaces an element_unaccounted skip naming the true denominator", async () => {
  const importRoot = await mkdtemp(join(tmpdir(), "pdpp-gm-unaccounted-skip-"));
  try {
    await writeFile(
      join(importRoot, "Records.json"),
      JSON.stringify({
        locations: [
          { timestampMs: "1717595122000", latitudeE7: 377_749_000, longitudeE7: -1_224_194_000, accuracy: 12.4 },
          { latitudeE7: 377_800_000, longitudeE7: -1_224_100_000, accuracy: 9.1 },
        ],
      })
    );
    const messages = await runImport(importRoot);

    const skip = messages.find(
      (m) => m.type === "SKIP_RESULT" && m.stream === "timeline_points" && m.reason === "element_unaccounted"
    );
    assert.ok(skip, "a dropped element must be visible as a skip, not swallowed");
    assert.equal((skip as { diagnostics?: { considered?: number; unaccounted?: number } }).diagnostics?.unaccounted, 1);
    assert.equal((skip as { diagnostics?: { considered?: number } }).diagnostics?.considered, 2);
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});

test("a segment element with no start time stays in the denominator", async () => {
  const importRoot = await mkdtemp(join(tmpdir(), "pdpp-gm-unaccounted-segment-"));
  try {
    // Two semantic segments; the second has no duration/startTimestamp at all,
    // so no `start_time` can be derived and the element cannot be keyed.
    await writeFile(
      join(importRoot, "Timeline.json"),
      JSON.stringify({
        semanticSegments: [
          { activity: { activityType: "WALKING" }, duration: { startTimestamp: "2024-06-05T13:45:22.000Z" } },
          { activity: { activityType: "CYCLING" } },
        ],
      })
    );
    const messages = await runImport(importRoot, ["timeline_segments"]);

    const coverage = coverageFor(messages, "timeline_segments");
    assert.equal(coverage.considered, 2, "both artifact elements are in the denominator");
    assert.equal(coverage.covered, 1, "only the keyable segment is covered");
    assert.ok(
      messages.some(
        (m) => m.type === "SKIP_RESULT" && m.stream === "timeline_segments" && m.reason === "element_unaccounted"
      ),
      "the dropped segment must be visible"
    );
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});

test("a fully accountable artifact still reconciles as complete on both streams", async () => {
  const importRoot = await mkdtemp(join(tmpdir(), "pdpp-gm-fully-accounted-"));
  try {
    await writeFile(
      join(importRoot, "Records.json"),
      JSON.stringify({
        locations: [
          { timestampMs: "1717595122000", latitudeE7: 377_749_000, longitudeE7: -1_224_194_000, accuracy: 12.4 },
          { timestampMs: "1717598722000", latitudeE7: 377_800_000, longitudeE7: -1_224_100_000, accuracy: 9.1 },
        ],
      })
    );
    await writeFile(
      join(importRoot, "Timeline.json"),
      JSON.stringify({
        semanticSegments: [
          { activity: { activityType: "WALKING" }, duration: { startTimestamp: "2024-06-05T13:45:22.000Z" } },
        ],
      })
    );
    const messages = await runImport(importRoot, ["timeline_points", "timeline_segments"]);

    // No drop => no skip, and the reconciliation reads complete. This guards the
    // opposite failure: a guard that counts every element as unaccounted would
    // make every clean import read a false `partial`.
    assert.equal(
      messages.some((m) => m.type === "SKIP_RESULT" && m.reason === "element_unaccounted"),
      false,
      "a clean artifact must not report an unaccounted element"
    );
    const points = coverageFor(messages, "timeline_points");
    assert.equal(points.considered, 2);
    assert.equal(points.covered, 2);
    const segments = coverageFor(messages, "timeline_segments");
    assert.equal(segments.considered, 1);
    assert.equal(segments.covered, 1);
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});
