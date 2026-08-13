// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * File-backed streaming Google Maps Timeline validation.
 *
 * Proves: (1) parity — the streaming path produces identical validation
 * results to the buffer-backed path across all 4 real top-level shapes;
 * (2) no-whole-buffer outcome proofs (readFile-call interception, memory
 * delta) at scale, for both sparse (many small elements) and dense (one
 * oversized element) content shapes; (3) truncated/incomplete documents and
 * mixed/ambiguous top-level shapes are handled explicitly, not silently.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
// biome-ignore lint/performance/noNamespaceImport: test.mock.module's namedExports needs the FULL real node:fs/promises export surface to spread from; a named-import subset would silently drop every other export this module transitively uses.
import * as realFsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateGoogleMapsTimelineArtifact, validateGoogleMapsTimelineArtifactFromFile } from "./validation.ts";

const readFileCallArgs: unknown[][] = [];

const MODULE_MOCKS_AVAILABLE = typeof (test.mock as { module?: unknown }).module === "function";

if (MODULE_MOCKS_AVAILABLE) {
  test.mock.module("node:fs/promises", {
    namedExports: {
      ...realFsPromises,
      readFile: (...args: Parameters<typeof realFsPromises.readFile>) => {
        readFileCallArgs.push(args);
        return (realFsPromises.readFile as typeof realFsPromises.readFile)(...args);
      },
    },
  });
}

const VALID_LEGACY = {
  locations: [{ latitudeE7: 377_749_000, longitudeE7: -1_224_194_000, timestampMs: "1717595122000" }],
};
const VALID_SEMANTIC = {
  semanticSegments: [
    {
      activity: { activityType: "WALKING", topCandidate: { probability: 0.9, type: "WALKING" } },
      duration: { endTimestamp: "2024-06-05T14:00:00.000Z", startTimestamp: "2024-06-05T13:45:22.000Z" },
    },
  ],
};
const VALID_TIMELINE_OBJECTS_ROOT_ARRAY = [
  {
    activitySegment: {
      activityType: "WALKING",
      duration: { endTimestamp: "2024-06-05T14:00:00.000Z", startTimestamp: "2024-06-05T13:45:22.000Z" },
      startLocation: { latitudeE7: 377_749_000, longitudeE7: -1_224_194_000 },
    },
  },
];
const VALID_TIMELINE_OBJECTS_WRAPPED = { timelineObjects: VALID_TIMELINE_OBJECTS_ROOT_ARRAY };

function writeTmpFile(content: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-google-maps-file-validation-"));
  const path = join(dir, "Timeline.json");
  writeFileSync(path, content);
  return { dir, path };
}

async function validateFile(
  content: string,
  fileSha256 = "abc"
): ReturnType<typeof validateGoogleMapsTimelineArtifactFromFile> {
  const { dir, path } = writeTmpFile(content);
  try {
    return await validateGoogleMapsTimelineArtifactFromFile(path, Buffer.byteLength(content, "utf8"), { fileSha256 });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

test("validateGoogleMapsTimelineArtifactFromFile: legacy_records shape parity with the buffer-backed path", async () => {
  const content = JSON.stringify(VALID_LEGACY);
  const buffered = validateGoogleMapsTimelineArtifact(content, { existingFileHashes: [] });
  const streamed = await validateFile(content, buffered.file_sha256);

  assert.equal(streamed.status, "valid");
  assert.equal(streamed.detected_format, buffered.detected_format);
  assert.equal(streamed.estimated_points, buffered.estimated_points);
  assert.equal(streamed.estimated_segments, buffered.estimated_segments);
  assert.deepEqual(streamed.date_range, buffered.date_range);
});

test("validateGoogleMapsTimelineArtifactFromFile: semantic_segments shape parity with the buffer-backed path", async () => {
  const content = JSON.stringify(VALID_SEMANTIC);
  const buffered = validateGoogleMapsTimelineArtifact(content);
  const streamed = await validateFile(content, buffered.file_sha256);

  assert.equal(streamed.detected_format, buffered.detected_format);
  assert.equal(streamed.estimated_points, buffered.estimated_points);
  assert.equal(streamed.estimated_segments, buffered.estimated_segments);
  assert.deepEqual(streamed.date_range, buffered.date_range);
});

test("validateGoogleMapsTimelineArtifactFromFile: timelineObjects (wrapped) shape parity with the buffer-backed path", async () => {
  const content = JSON.stringify(VALID_TIMELINE_OBJECTS_WRAPPED);
  const buffered = validateGoogleMapsTimelineArtifact(content);
  const streamed = await validateFile(content, buffered.file_sha256);

  assert.equal(streamed.detected_format, buffered.detected_format);
  assert.equal(streamed.estimated_points, buffered.estimated_points);
  assert.equal(streamed.estimated_segments, buffered.estimated_segments);
  assert.deepEqual(streamed.date_range, buffered.date_range);
});

test("validateGoogleMapsTimelineArtifactFromFile: bare top-level array (timeline_objects) shape parity with the buffer-backed path", async () => {
  const content = JSON.stringify(VALID_TIMELINE_OBJECTS_ROOT_ARRAY);
  const buffered = validateGoogleMapsTimelineArtifact(content);
  const streamed = await validateFile(content, buffered.file_sha256);

  assert.equal(streamed.detected_format, buffered.detected_format);
  assert.equal(streamed.estimated_points, buffered.estimated_points);
  assert.equal(streamed.estimated_segments, buffered.estimated_segments);
  assert.deepEqual(streamed.date_range, buffered.date_range);
});

test("validateGoogleMapsTimelineArtifactFromFile: identifies empty recognized Timeline files", async () => {
  const streamed = await validateFile(JSON.stringify({ timelineObjects: [] }));
  assert.equal(streamed.status, "empty");
  assert.equal(streamed.detected_format, "timeline_objects");
  assert.equal(streamed.estimated_points, 0);
  assert.equal(streamed.estimated_segments, 0);
});

test("validateGoogleMapsTimelineArtifactFromFile: identifies unsupported (unrecognized top-level shape) artifacts", async () => {
  const streamed = await validateFile(JSON.stringify({ archive_jobs: [] }));
  assert.equal(streamed.status, "unsupported");
  assert.equal(streamed.detected_format, "unsupported");
  assert.match(streamed.remediation ?? "", /Timeline JSON export/i);
});

test("validateGoogleMapsTimelineArtifactFromFile rejects recognized non-array keys", async () => {
  await Promise.all(
    [{}, null, "not-an-array"].map(async (value) => {
      const content = JSON.stringify({ semanticSegments: value });
      const buffered = validateGoogleMapsTimelineArtifact(content);
      const streamed = await validateFile(content, buffered.file_sha256);
      assert.equal(buffered.status, "unsupported");
      assert.equal(streamed.status, "unsupported");
      assert.equal(streamed.detected_format, "unsupported");
      assert.equal(streamed.estimated_points, 0);
      assert.equal(streamed.estimated_segments, 0);
    })
  );
});

test("a document with both locations and semanticSegments populated is rejected as unsupported, matching the buffer-backed path", async () => {
  const mixed = {
    locations: [{ latitudeE7: 377_749_000, longitudeE7: -1_224_194_000, timestampMs: "1717595122000" }],
    semanticSegments: [
      { duration: { endTimestamp: "2024-06-05T14:00:00.000Z", startTimestamp: "2024-06-05T13:45:22.000Z" } },
    ],
  };
  const content = JSON.stringify(mixed);
  const buffered = validateGoogleMapsTimelineArtifact(content);
  assert.equal(
    buffered.status,
    "unsupported",
    "sanity check: the buffer-backed path must also reject a mixed-shape document"
  );

  const streamed = await validateFile(content, buffered.file_sha256);
  assert.equal(streamed.status, "unsupported");
  assert.match(streamed.remediation ?? "", /more than one kind/i);
});

test("mixed-shape rejection is order-independent (semanticSegments before locations still rejects)", async () => {
  const content = JSON.stringify({
    semanticSegments: [
      { duration: { endTimestamp: "2024-06-05T14:00:00.000Z", startTimestamp: "2024-06-05T13:45:22.000Z" } },
    ],
    locations: [{ latitudeE7: 377_749_000, longitudeE7: -1_224_194_000, timestampMs: "1717595122000" }],
  });
  const buffered = validateGoogleMapsTimelineArtifact(content);
  assert.equal(buffered.status, "unsupported");

  const streamed = await validateFile(content, buffered.file_sha256);
  assert.equal(streamed.status, "unsupported");
});

// Counterweight: a populated shape plus an EMPTY sibling array is a single-
// shape export with an unused key present, NOT mixing -- both key orders
// must label correctly and stay "valid", on both paths.

test("a populated locations with an empty semanticSegments sibling is valid and labeled legacy_records (populated-first order)", async () => {
  const content = JSON.stringify({
    locations: [{ latitudeE7: 377_749_000, longitudeE7: -1_224_194_000, timestampMs: "1717595122000" }],
    semanticSegments: [],
  });
  const buffered = validateGoogleMapsTimelineArtifact(content);
  assert.equal(buffered.status, "valid");
  assert.equal(buffered.detected_format, "legacy_records");

  const streamed = await validateFile(content, buffered.file_sha256);
  assert.equal(streamed.status, "valid");
  assert.equal(streamed.detected_format, "legacy_records");
  assert.equal(streamed.estimated_points, 1);
});

test("an empty locations with a populated semanticSegments sibling is valid and labeled semantic_segments (empty-first order)", async () => {
  const content = JSON.stringify({
    locations: [],
    semanticSegments: [
      { duration: { endTimestamp: "2024-06-05T14:00:00.000Z", startTimestamp: "2024-06-05T13:45:22.000Z" } },
    ],
  });
  const buffered = validateGoogleMapsTimelineArtifact(content);
  assert.equal(buffered.status, "valid");
  assert.equal(
    buffered.detected_format,
    "semantic_segments",
    "the non-empty shape must win the label even though the empty 'locations' key appears first"
  );

  const streamed = await validateFile(content, buffered.file_sha256);
  assert.equal(streamed.status, "valid");
  assert.equal(streamed.detected_format, "semantic_segments");
  assert.equal(streamed.estimated_segments, 1);
});

// Counterweight: ALL recognized shapes present but empty must be
// deterministic (first-recognized-key-in-document-order wins the label)
// and non-erroring on both paths, for both key orders.

test("all-empty document (locations then timelineObjects) is deterministically empty, labeled by fixed shape priority", async () => {
  const content = JSON.stringify({ locations: [], timelineObjects: [] });
  const buffered = validateGoogleMapsTimelineArtifact(content);
  assert.equal(buffered.status, "empty");
  assert.equal(buffered.detected_format, "legacy_records");

  const streamed = await validateFile(content, buffered.file_sha256);
  assert.equal(streamed.status, "empty");
  assert.equal(streamed.detected_format, "legacy_records");
});

test("all-empty document (timelineObjects then locations) is still deterministically empty, by existing shape priority regardless of key order", async () => {
  // Key order in the source document does NOT change the fallback label --
  // it's the same fixed priority (locations > semanticSegments >
  // timelineObjects) as the "populated" label pick, applied consistently
  // whether or not any shape actually has elements.
  const content = JSON.stringify({ timelineObjects: [], locations: [] });
  const buffered = validateGoogleMapsTimelineArtifact(content);
  assert.equal(buffered.status, "empty");
  assert.equal(buffered.detected_format, "legacy_records");

  const streamed = await validateFile(content, buffered.file_sha256);
  assert.equal(streamed.status, "empty");
  assert.equal(streamed.detected_format, "legacy_records");
});

test("validateGoogleMapsTimelineArtifactFromFile: identifies unsupported (malformed JSON) artifacts without buffering", async () => {
  const { dir, path } = writeTmpFile("{ this is not valid json [[[");
  try {
    const streamed = await validateGoogleMapsTimelineArtifactFromFile(path, 30, { fileSha256: "x" });
    assert.equal(streamed.status, "unsupported");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a document truncated mid-array (well-formed up to the cut) reports unsupported, not a silently partial valid result", async () => {
  // Distinct from malformed-from-byte-0 above (a different code path --
  // the tokenizer rejects that synchronously on the first write()). This
  // is a valid 3-element document with the tail sliced off mid-stream,
  // simulating a real truncated upload (network drop, disk-full mid-write).
  const full = JSON.stringify({
    timelineObjects: [
      {
        activitySegment: {
          activityType: "WALKING",
          startLocation: { latitudeE7: 1, longitudeE7: 1 },
          startTime: "2024-01-01T00:00:00Z",
        },
      },
      {
        activitySegment: {
          activityType: "WALKING",
          startLocation: { latitudeE7: 2, longitudeE7: 2 },
          startTime: "2024-01-02T00:00:00Z",
        },
      },
      {
        activitySegment: {
          activityType: "WALKING",
          startLocation: { latitudeE7: 3, longitudeE7: 3 },
          startTime: "2024-01-03T00:00:00Z",
        },
      },
    ],
  });
  const truncated = full.slice(0, Math.floor(full.length * 0.6));
  const { dir, path } = writeTmpFile(truncated);
  try {
    const streamed = await validateGoogleMapsTimelineArtifactFromFile(path, Buffer.byteLength(truncated, "utf8"), {
      fileSha256: "x",
    });
    assert.equal(
      streamed.status,
      "unsupported",
      `expected a truncated document to report unsupported (not a silently partial "valid"), got: ${JSON.stringify(streamed)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a truncated single-element timelineObjects document reports unsupported, matching the buffer-backed path", async () => {
  const buffered = validateGoogleMapsTimelineArtifact(
    '{"timelineObjects":[{"activitySegment":{"startTime":"2024-01-01T00:00:00Z","startLocation":{"latitudeE7":407128000,"longitudeE7":-740060000}}}'
  );
  assert.equal(
    buffered.status,
    "unsupported",
    "sanity check: the buffer-backed path must also report unsupported for this exact input"
  );

  const { dir, path } = writeTmpFile(
    '{"timelineObjects":[{"activitySegment":{"startTime":"2024-01-01T00:00:00Z","startLocation":{"latitudeE7":407128000,"longitudeE7":-740060000}}}'
  );
  try {
    const content =
      '{"timelineObjects":[{"activitySegment":{"startTime":"2024-01-01T00:00:00Z","startLocation":{"latitudeE7":407128000,"longitudeE7":-740060000}}}';
    const streamed = await validateGoogleMapsTimelineArtifactFromFile(path, Buffer.byteLength(content, "utf8"), {
      fileSha256: "x",
    });
    assert.equal(streamed.status, buffered.status);
    assert.equal(streamed.estimated_points, 0);
    assert.equal(streamed.estimated_segments, 0);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a single oversized array element reports too_large, not an OOM crash or a silent valid pass", async () => {
  // Dense (one giant element), not the sparse-many-small-elements shape
  // every other test in this suite exercises.
  const junk = "x".repeat(6 * 1024 * 1024);
  const content = JSON.stringify({ locations: [{ note: junk, timestampMs: "1717595122000" }] });
  const { dir, path } = writeTmpFile(content);
  try {
    const streamed = await validateGoogleMapsTimelineArtifactFromFile(path, Buffer.byteLength(content, "utf8"), {
      fileSha256: "x",
      maxFileBytes: 100 * 1024 * 1024,
    });
    assert.equal(streamed.status, "too_large");
    // Must not claim the whole FILE exceeds the upload limit -- the file
    // here is well under maxFileBytes; only one record is oversized.
    assert.doesNotMatch(streamed.remediation ?? "", /larger than the upload limit/i);
    assert.match(streamed.remediation ?? "", /record/i);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a document made entirely of many small elements is unaffected by the per-element bound", async () => {
  const points = Array.from({ length: 5000 }, (_, i) => ({
    latitudeE7: 377_749_000 + i,
    longitudeE7: -1_224_194_000 - i,
    timestampMs: String(1_717_595_122_000 + i * 1000),
  }));
  const content = JSON.stringify({ locations: points });
  const { dir, path } = writeTmpFile(content);
  try {
    const streamed = await validateGoogleMapsTimelineArtifactFromFile(path, Buffer.byteLength(content, "utf8"), {
      fileSha256: "x",
    });
    assert.equal(streamed.status, "valid");
    assert.equal(streamed.estimated_points, 5000);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("validateGoogleMapsTimelineArtifactFromFile: identifies duplicate artifacts by the caller-supplied file hash", async () => {
  const content = JSON.stringify(VALID_LEGACY);
  const { dir, path } = writeTmpFile(content);
  try {
    const streamed = await validateGoogleMapsTimelineArtifactFromFile(path, Buffer.byteLength(content, "utf8"), {
      existingFileHashes: ["known-hash"],
      fileSha256: "known-hash",
    });
    assert.equal(streamed.status, "duplicate");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("validateGoogleMapsTimelineArtifactFromFile: identifies stale artifacts by imported-through frontier", async () => {
  const content = JSON.stringify(VALID_LEGACY);
  const { dir, path } = writeTmpFile(content);
  try {
    const streamed = await validateGoogleMapsTimelineArtifactFromFile(path, Buffer.byteLength(content, "utf8"), {
      fileSha256: "x",
      importedThrough: "2024-06-06T00:00:00.000Z",
    });
    assert.equal(streamed.status, "stale");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("validateGoogleMapsTimelineArtifactFromFile: too_large is decided from fileSize alone, before any read", async () => {
  const { dir, path } = writeTmpFile(JSON.stringify(VALID_LEGACY));
  try {
    const streamed = await validateGoogleMapsTimelineArtifactFromFile(path, 999_999_999, {
      fileSha256: "x",
      maxFileBytes: 100,
    });
    assert.equal(streamed.status, "too_large");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("validateGoogleMapsTimelineArtifactFromFile: a large sparse export never calls fs/promises.readFile against its own path", {
  skip: MODULE_MOCKS_AVAILABLE ? false : "requires --experimental-test-module-mocks",
}, async () => {
  // "Sparse" — many small, independently-timestamped elements spread across
  // the file, the real shape of a multi-year Timeline export, not one giant
  // element. 20,000 legacy-record points, each tiny, well beyond the 100
  // MiB manifest cap in aggregate element count (proving the streaming path
  // handles many elements, not just a big single one).
  const points = Array.from({ length: 20_000 }, (_, i) => ({
    latitudeE7: 377_749_000 + i,
    longitudeE7: -1_224_194_000 - i,
    timestampMs: String(1_717_595_122_000 + i * 1000),
  }));
  const content = JSON.stringify({ locations: points });
  const { dir, path } = writeTmpFile(content);
  try {
    const callsBefore = readFileCallArgs.length;
    const streamed = await validateGoogleMapsTimelineArtifactFromFile(path, Buffer.byteLength(content, "utf8"), {
      fileSha256: "x",
    });
    assert.equal(streamed.status, "valid");
    assert.equal(streamed.estimated_points, 20_000);
    const callsAfter = readFileCallArgs.slice(callsBefore);
    const callsOnThisPath = callsAfter.filter(([pathArg]) => String(pathArg) === path);
    assert.deepEqual(
      callsOnThisPath,
      [],
      `expected zero readFile() calls against the streamed artifact's own path, found: ${JSON.stringify(callsOnThisPath)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("outcome proof: a 110 MiB sparse Timeline export separates streaming from whole-buffer parsing at one heap limit", async () => {
  // Deterministic child-process oracle, not an in-process memory-delta
  // measurement (the prior in-process external-memory-delta test here was
  // proven decorative by mutation testing -- it passed even when reverted
  // to a whole-buffer readFile+JSON.parse implementation). Sparse: many
  // small elements, not one huge one -- the realistic shape of a real
  // multi-year export. Fixture construction happens in this (unconstrained)
  // process; the child only receives the finished file's path and size, so
  // its heap budget is spent solely on validation.
  const TARGET_BYTES = 110 * 1024 * 1024;
  const template = { accuracy: 5, latitudeE7: 377_749_000, longitudeE7: -1_224_194_000, timestampMs: "1717595122000" };
  const perElementBytes = Buffer.byteLength(JSON.stringify(template), "utf8") + 1;
  const elementCount = Math.ceil(TARGET_BYTES / perElementBytes);
  const dir = mkdtempSync(join(tmpdir(), "pdpp-google-maps-sparse-oracle-"));
  const path = join(dir, "Timeline.json");
  try {
    // Written streamingly so fixture construction itself never buffers
    // TARGET_BYTES of content.
    const { createWriteStream } = await import("node:fs");
    const out = createWriteStream(path);
    out.write('{"locations":[');
    for (let i = 0; i < elementCount; i += 1) {
      out.write((i === 0 ? "" : ",") + JSON.stringify({ ...template, timestampMs: String(1_717_595_122_000 + i) }));
    }
    out.write("]}");
    await new Promise((resolve, reject) => {
      out.end((err?: Error | null) => (err ? reject(err) : resolve(undefined)));
    });

    const { statSync } = await import("node:fs");
    const fileSize = statSync(path).size;
    assert.ok(fileSize > 50 * 1024 * 1024, `fixture must exceed the manifest cap, got ${fileSize} bytes`);

    const { spawnSync } = await import("node:child_process");
    const childPath = new URL("./oversized-element-oracle.test.child.ts", import.meta.url);
    // Keep a wide margin between the 110 MiB input and the heap ceiling.
    // A 220 MiB ceiling was close enough for V8's string representation to
    // let the whole-buffer mutation survive on some GitHub runners.
    const heapLimitMiB = 128;
    const wholeBuffer = spawnSync(
      process.execPath,
      [
        `--max-old-space-size=${heapLimitMiB}`,
        "--import",
        "tsx",
        childPath.pathname,
        path,
        String(fileSize),
        "whole-buffer",
      ],
      { encoding: "utf8", timeout: 30_000 }
    );
    assert.notEqual(
      wholeBuffer.status,
      0,
      `whole-buffer mutation unexpectedly survived the heap discriminator: status=${wholeBuffer.status} signal=${wholeBuffer.signal}`
    );
    const result = spawnSync(
      process.execPath,
      [`--max-old-space-size=${heapLimitMiB}`, "--import", "tsx", childPath.pathname, path, String(fileSize)],
      { encoding: "utf8", timeout: 30_000 }
    );

    assert.equal(
      result.status,
      0,
      `expected the child to exit cleanly, got status=${result.status} signal=${result.signal} stderr=${result.stderr}`
    );
    assert.equal(result.signal, null);
    const stdout = JSON.parse(result.stdout.trim());
    assert.equal(stdout.status, "valid");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("outcome proof: large wrapped locations and semanticSegments arrays stay below a hard heap limit", async () => {
  // This complementary shape probe uses a still-large 20 MiB array. The
  // separate 110 MiB sparse oracle above is the whole-buffer discriminator;
  // this test keeps both wrapped shapes covered without making parser/runtime
  // allocation overhead the false failure signal on CI Node versions.
  const TARGET_BYTES = 20 * 1024 * 1024;
  const shapes = [
    {
      key: "locations",
      makeItem: () => ({
        latitudeE7: 377_749_000,
        longitudeE7: -1_224_194_000,
        timestampMs: "1717595122000",
      }),
    },
    {
      key: "semanticSegments",
      makeItem: () => ({
        activity: { activityType: "WALKING" },
        duration: { startTimestamp: "2024-06-05T13:45:22.000Z" },
      }),
    },
  ] as const;
  const dir = mkdtempSync(join(tmpdir(), "pdpp-google-maps-wrapped-heap-oracle-"));
  try {
    const runShape = async (shape: (typeof shapes)[number]): Promise<void> => {
      const path = join(dir, `${shape.key}.json`);
      const itemText = JSON.stringify(shape.makeItem());
      const itemCount = Math.ceil((TARGET_BYTES - 32) / (Buffer.byteLength(itemText, "utf8") + 1));
      const { createWriteStream } = await import("node:fs");
      const out = createWriteStream(path);
      out.write(`{"${shape.key}":[`);
      for (let index = 0; index < itemCount; index += 1) {
        out.write((index === 0 ? "" : ",") + itemText);
      }
      out.write("]}");
      await new Promise((resolve, reject) => {
        out.end((err?: Error | null) => (err ? reject(err) : resolve(undefined)));
      });

      const { statSync } = await import("node:fs");
      const fileSize = statSync(path).size;
      assert.ok(fileSize > 15 * 1024 * 1024, `${shape.key} fixture must be large enough, got ${fileSize} bytes`);

      const { spawnSync } = await import("node:child_process");
      const childPath = new URL("./oversized-element-oracle.test.child.ts", import.meta.url);
      const result = spawnSync(
        process.execPath,
        ["--max-old-space-size=96", "--import", "tsx", childPath.pathname, path, String(fileSize)],
        { encoding: "utf8", timeout: 60_000 }
      );

      assert.equal(
        result.status,
        0,
        `${shape.key} wrapped array must validate under the hard heap limit; status=${String(result.status)} signal=${String(result.signal)} stderr=${result.stderr}`
      );
      assert.equal(result.signal, null);
      assert.equal(JSON.parse(result.stdout.trim()).status, "valid");
    };
    await shapes.reduce((previous, shape) => previous.then(() => runShape(shape)), Promise.resolve());
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("outcome proof: a single oversized array element is rejected under a hard heap limit, not OOM-crashed", async () => {
  // Deterministic child-process oracle, not an in-process memory-delta
  // measurement: builds the fixture in this (unconstrained) process, then
  // runs validation in a separate child under a hard V8 heap limit via
  // oversized-element-oracle.test.child.ts. A regression that fails to bound the
  // element crashes the child (OOM, non-zero exit via SIGABRT); the fix
  // exits 0. Fixture construction happens here, never inside the
  // constrained child, so the child's heap budget is spent solely on
  // validation.
  const ELEMENT_BYTES = 80 * 1024 * 1024;
  const junk = "x".repeat(ELEMENT_BYTES);
  const content = JSON.stringify({ locations: [{ note: junk, timestampMs: "1717595122000" }] });
  const dir = mkdtempSync(join(tmpdir(), "pdpp-google-maps-p1-oracle-"));
  const path = join(dir, "Timeline.json");
  try {
    writeFileSync(path, content);
    const { statSync } = await import("node:fs");
    const fileSize = statSync(path).size;

    const { spawnSync } = await import("node:child_process");
    const childPath = new URL("./oversized-element-oracle.test.child.ts", import.meta.url);
    const result = spawnSync(
      process.execPath,
      ["--max-old-space-size=100", "--import", "tsx", childPath.pathname, path, String(fileSize)],
      { encoding: "utf8", timeout: 30_000 }
    );

    assert.equal(
      result.status,
      0,
      `expected the child to exit cleanly, got status=${result.status} signal=${result.signal} stderr=${result.stderr}`
    );
    assert.equal(result.signal, null);
    const stdout = JSON.parse(result.stdout.trim());
    assert.equal(stdout.status, "too_large");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("outcome proof: an oversized primitive element fails before tokenizer buffering can OOM", async () => {
  const ELEMENT_BYTES = 80 * 1024 * 1024;
  const primitive = "x".repeat(ELEMENT_BYTES);
  const content = JSON.stringify({ locations: [primitive] });
  const dir = mkdtempSync(join(tmpdir(), "pdpp-google-maps-primitive-p1-oracle-"));
  const path = join(dir, "Timeline.json");
  try {
    writeFileSync(path, content);
    const { statSync } = await import("node:fs");
    const fileSize = statSync(path).size;

    const { spawnSync } = await import("node:child_process");
    const childPath = new URL("./oversized-element-oracle.test.child.ts", import.meta.url);
    const result = spawnSync(
      process.execPath,
      ["--max-old-space-size=100", "--import", "tsx", childPath.pathname, path, String(fileSize)],
      { encoding: "utf8", timeout: 30_000 }
    );

    assert.equal(
      result.status,
      0,
      `expected the primitive child to exit cleanly, got status=${result.status} signal=${result.signal} stderr=${result.stderr}`
    );
    assert.equal(result.signal, null);
    assert.equal(JSON.parse(result.stdout.trim()).status, "too_large");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
