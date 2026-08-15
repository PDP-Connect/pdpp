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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  state: Record<string, unknown> = {},
  streams: readonly string[] = ["timeline_points"]
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
      scope: { streams: streams.map((name) => ({ name })) },
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

test("google_maps dedupes duplicate archive files and proves both declared streams", async () => {
  const importRoot = await mkdtemp(join(tmpdir(), "pdpp-google-maps-dedupe-"));
  try {
    await writeFile(join(importRoot, "Records.json"), JSON.stringify(EXPORT_FIXTURE));
    await writeFile(join(importRoot, "location-history.json"), JSON.stringify(EXPORT_FIXTURE));
    await writeFile(
      join(importRoot, "Timeline.json"),
      JSON.stringify({
        semanticSegments: [
          {
            activity: { activityType: "WALKING" },
            duration: { startTimestamp: "2024-06-05T13:45:22.000Z" },
          },
        ],
      })
    );
    const { messages } = await runImport(importRoot, {}, ["timeline_points", "timeline_segments"]);

    const pointRecords = messages.filter(
      (message) => message.type === "RECORD" && message.stream === "timeline_points"
    );
    const segmentRecords = messages.filter(
      (message) => message.type === "RECORD" && message.stream === "timeline_segments"
    );
    assert.equal(pointRecords.length, 2, "duplicate archive files must not duplicate stable point IDs");
    assert.equal(segmentRecords.length, 1, "the semantic segment should be emitted once");

    const segmentCoverage = messages.find(
      (message): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
        message.type === "DETAIL_COVERAGE" && message.stream === "timeline_segments"
    );
    assert.ok(segmentCoverage, "expected timeline_segments DETAIL_COVERAGE");
    assert.equal(segmentCoverage.considered, 1);
    assert.equal(segmentCoverage.covered, 1);
    const pointCoverage = messages.find(
      (message): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
        message.type === "DETAIL_COVERAGE" && message.stream === "timeline_points"
    );
    assert.ok(pointCoverage, "expected timeline_points DETAIL_COVERAGE");
    assert.equal(pointCoverage.considered, 2);
    assert.equal(pointCoverage.covered, 2);
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});

test("google_maps imports a large semantic segment on both streams without terminal record_too_large gaps", async () => {
  const importRoot = await mkdtemp(join(tmpdir(), "pdpp-google-maps-large-segment-"));
  try {
    const timelinePath = Array.from({ length: 80_000 }, (_, index) => ({
      point: `geo:37.${String(index % 10).padStart(6, "0")},-122.${String(index % 10).padStart(6, "0")}`,
      time: `2024-06-05T13:${String(Math.floor(index / 60) % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z`,
    }));
    const exportContent = JSON.stringify({
      semanticSegments: [
        {
          duration: { startTimestamp: "2024-06-05T13:45:22.000Z" },
          timelinePath,
        },
      ],
    });
    assert.ok(Buffer.byteLength(exportContent, "utf8") > 4 * 1024 * 1024, "fixture must exceed the old element bound");
    await writeFile(join(importRoot, "Timeline.json"), exportContent);

    const { messages } = await runImport(importRoot, {}, ["timeline_points", "timeline_segments"]);
    for (const stream of ["timeline_points", "timeline_segments"]) {
      assert.equal(
        messages.some(
          (message) =>
            message.type === "SKIP_RESULT" && message.stream === stream && message.reason === "record_too_large"
        ),
        false,
        `${stream} must not receive a terminal record_too_large gap`
      );
    }
    assert.ok(messages.some((message) => message.type === "RECORD" && message.stream === "timeline_points"));
    assert.ok(messages.some((message) => message.type === "RECORD" && message.stream === "timeline_segments"));
    assert.ok(messages.some((message) => message.type === "STATE" && message.stream === "timeline_points"));
    assert.ok(messages.some((message) => message.type === "STATE" && message.stream === "timeline_segments"));
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});

test("google_maps with a malformed archive does not emit STATE or coverage", async () => {
  const importRoot = await mkdtemp(join(tmpdir(), "pdpp-google-maps-invalid-"));
  try {
    await writeFile(join(importRoot, "Records.json"), JSON.stringify(EXPORT_FIXTURE));
    await writeFile(join(importRoot, "Timeline.json"), '{"locations":[');
    const { messages } = await runImport(importRoot);

    assert.equal(
      messages.filter((message) => message.type === "RECORD" && message.stream === "timeline_points").length,
      2,
      "valid records before the malformed file may be retained"
    );
    assert.ok(
      messages.some((message) => message.type === "SKIP_RESULT" && message.reason === "invalid_json"),
      "the malformed archive must be visible as a source failure"
    );
    assert.equal(
      messages.some((message) => message.type === "STATE" && message.stream === "timeline_points"),
      false,
      "a source failure must prevent the cursor checkpoint"
    );
    assert.equal(
      messages.some((message) => message.type === "DETAIL_COVERAGE" && message.stream === "timeline_points"),
      false,
      "a source failure must prevent a complete-coverage claim"
    );
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});

test("google_maps rejects trailing non-whitespace after a valid archive", async () => {
  const importRoot = await mkdtemp(join(tmpdir(), "pdpp-google-maps-trailing-"));
  try {
    await writeFile(join(importRoot, "Records.json"), `${JSON.stringify(EXPORT_FIXTURE)}${" ".repeat(65_536)}trailing`);
    const { messages } = await runImport(importRoot);

    assert.equal(
      messages.filter((message) => message.type === "RECORD" && message.stream === "timeline_points").length,
      2,
      "records emitted before the trailing bytes may be retained"
    );
    assert.ok(messages.some((message) => message.type === "SKIP_RESULT" && message.reason === "invalid_json"));
    assert.equal(
      messages.some((message) => message.type === "STATE"),
      false
    );
    assert.equal(
      messages.some((message) => message.type === "DETAIL_COVERAGE"),
      false
    );
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});

test("google_maps rejects recognized non-array keys without state or coverage on either stream", async () => {
  const cases: readonly [string, unknown][] = [
    ["locations", {}],
    ["locations", null],
    ["locations", "not-an-array"],
    ["locations", { "0": { latitudeE7: 377_749_000, longitudeE7: -1_224_194_000, timestampMs: "1717595122000" } }],
    ["semanticSegments", {}],
    ["timelineObjects", {}],
  ];

  const runCase = async ([key, value]: (typeof cases)[number]): Promise<void> => {
    const importRoot = await mkdtemp(join(tmpdir(), "pdpp-google-maps-shape-"));
    try {
      await writeFile(join(importRoot, "Timeline.json"), JSON.stringify({ [key]: value }));
      const { messages } = await runImport(importRoot, {}, ["timeline_points", "timeline_segments"]);

      for (const stream of ["timeline_points", "timeline_segments"]) {
        assert.ok(
          messages.some(
            (message) =>
              message.type === "SKIP_RESULT" && message.stream === stream && message.reason === "unsupported_shape"
          ),
          `${key}=${String(value)} must reject ${stream}`
        );
        assert.equal(
          messages.some((message) => message.type === "STATE" && message.stream === stream),
          false,
          `${key}=${String(value)} must not checkpoint ${stream}`
        );
        assert.equal(
          messages.some((message) => message.type === "DETAIL_COVERAGE" && message.stream === stream),
          false,
          `${key}=${String(value)} must not claim coverage for ${stream}`
        );
      }
      assert.equal(
        messages.some((message) => message.type === "RECORD"),
        false
      );
    } finally {
      await rm(importRoot, { force: true, recursive: true });
    }
  };
  await cases.reduce((previous, entry) => previous.then(() => runCase(entry)), Promise.resolve());
});

test("google_maps rejects scalar, empty, and unknown-key-only roots without zero-coverage claims", async () => {
  const cases = [
    "null",
    "42",
    JSON.stringify({}),
    JSON.stringify({ archive_jobs: [] }),
    JSON.stringify({ archive_jobs: [EXPORT_FIXTURE] }),
  ];
  const runCase = async (content: string): Promise<void> => {
    const importRoot = await mkdtemp(join(tmpdir(), "pdpp-google-maps-root-shape-"));
    try {
      await writeFile(join(importRoot, "Timeline.json"), content);
      const { messages } = await runImport(importRoot, {}, ["timeline_points", "timeline_segments"]);

      assert.equal(
        messages.some((message) => message.type === "RECORD"),
        false,
        content
      );
      for (const stream of ["timeline_points", "timeline_segments"]) {
        assert.ok(
          messages.some(
            (message) =>
              message.type === "SKIP_RESULT" && message.stream === stream && message.reason === "unsupported_shape"
          ),
          `${content} must be unsupported for ${stream}`
        );
        assert.equal(
          messages.some((message) => message.type === "STATE" && message.stream === stream),
          false,
          content
        );
        assert.equal(
          messages.some((message) => message.type === "DETAIL_COVERAGE" && message.stream === stream),
          false,
          content
        );
        assert.equal(
          messages.some(
            (message) =>
              message.type === "SKIP_RESULT" && message.stream === stream && message.reason.endsWith("_not_found")
          ),
          false,
          content
        );
      }
    } finally {
      await rm(importRoot, { force: true, recursive: true });
    }
  };
  await Promise.all(cases.map(runCase));
});

test("google_maps keeps a recognized empty array as a valid empty counterweight", async () => {
  const importRoot = await mkdtemp(join(tmpdir(), "pdpp-google-maps-empty-shape-"));
  try {
    await writeFile(join(importRoot, "Timeline.json"), JSON.stringify({ timelineObjects: [] }));
    const { messages } = await runImport(importRoot);

    assert.ok(
      messages.some((message) => message.type === "SKIP_RESULT" && message.reason === "timeline_points_not_found")
    );
    assert.ok(messages.some((message) => message.type === "STATE" && message.stream === "timeline_points"));
    const coverage = pointsCoverage(messages);
    assert.equal(coverage.considered, 0);
    assert.equal(coverage.covered, 0);
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});

test("google_maps with a schema-rejected unknown segment withholds its cursor and coverage", async () => {
  const importRoot = await mkdtemp(join(tmpdir(), "pdpp-google-maps-schema-rejection-"));
  try {
    const oversizedKey = "x".repeat(201);
    await writeFile(
      join(importRoot, "Timeline.json"),
      JSON.stringify({
        semanticSegments: [
          {
            startTime: "2024-06-05T13:45:22.000Z",
            [oversizedKey]: {},
          },
        ],
      })
    );
    const { messages } = await runImport(importRoot, {}, ["timeline_points", "timeline_segments"]);

    assert.ok(
      messages.some(
        (message) =>
          message.type === "SKIP_RESULT" &&
          message.stream === "timeline_segments" &&
          message.reason === "shape_check_failed"
      )
    );
    assert.equal(
      messages.some((message) => message.type === "RECORD" && message.stream === "timeline_segments"),
      false
    );
    assert.equal(
      messages.some((message) => message.type === "STATE" && message.stream === "timeline_segments"),
      false
    );
    assert.equal(
      messages.some((message) => message.type === "DETAIL_COVERAGE" && message.stream === "timeline_segments"),
      false
    );
    assert.equal(
      messages.some((message) => message.type === "STATE" && message.stream === "timeline_points"),
      false
    );
    assert.equal(
      messages.some((message) => message.type === "DETAIL_COVERAGE" && message.stream === "timeline_points"),
      false
    );
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});

test("google_maps fails closed when discovery misses the source boundary", async () => {
  const missingRoot = join(tmpdir(), `pdpp-google-maps-missing-${String(process.pid)}-${Date.now()}`);
  const readErrorRoot = join(tmpdir(), `pdpp-google-maps-not-a-directory-${String(process.pid)}-${Date.now()}`);
  const deepRoot = await mkdtemp(join(tmpdir(), "pdpp-google-maps-deep-"));
  const cappedRoot = await mkdtemp(join(tmpdir(), "pdpp-google-maps-capped-"));
  try {
    await writeFile(readErrorRoot, "not a directory");
    const deepPaths: string[] = [];
    let deepPath = deepRoot;
    for (let level = 0; level < 6; level += 1) {
      deepPath = join(deepPath, `level-${String(level)}`);
      deepPaths.push(deepPath);
    }
    await deepPaths.reduce((previous, path) => previous.then(() => mkdir(path)), Promise.resolve());
    await Promise.all(
      Array.from({ length: 2001 }, (_, index) =>
        writeFile(join(cappedRoot, `unrelated-${String(index).padStart(4, "0")}.txt`), "")
      )
    );

    const runDiscoveryCase = async (importRoot: string): Promise<void> => {
      const { messages } = await runImport(importRoot, {}, ["timeline_points", "timeline_segments"]);
      assert.equal(
        messages.filter((message) => message.type === "SKIP_RESULT" && message.reason === "source_incomplete").length,
        2,
        `discovery must report an incomplete source boundary for ${importRoot}`
      );
      assert.equal(
        messages.some((message) => message.type === "STATE"),
        false
      );
      assert.equal(
        messages.some((message) => message.type === "DETAIL_COVERAGE"),
        false
      );
      assert.equal(
        messages.some((message) => message.type === "SKIP_RESULT" && message.reason.endsWith("_not_found")),
        false
      );
    };
    await [missingRoot, readErrorRoot, deepRoot, cappedRoot].reduce(
      (previous, importRoot) => previous.then(() => runDiscoveryCase(importRoot)),
      Promise.resolve()
    );
  } finally {
    await rm(readErrorRoot, { force: true, recursive: true });
    await rm(deepRoot, { force: true, recursive: true });
    await rm(cappedRoot, { force: true, recursive: true });
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
