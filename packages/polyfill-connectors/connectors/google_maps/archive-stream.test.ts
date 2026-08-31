// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Discriminates the per-element size bound in `streamGoogleMapsExport` from
 * whole-tail byte accounting.
 *
 * Fail-before/pass-after: a document with many small supported elements
 * followed by an oversized UNRELATED trailing root field must NOT throw
 * `GoogleMapsElementTooLargeError` -- that field is never selected as an
 * element, so it cannot manufacture a false too-large. The counter-test
 * proves the bound still fires for a genuinely oversized SUPPORTED element,
 * so the fix cannot be "always pass" in disguise.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createWriteStream, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GoogleMapsElementTooLargeError,
  GoogleMapsUnsupportedShapeError,
  streamGoogleMapsExport,
} from "./archive-stream.ts";
import { parseGoogleMapsExport, parseGoogleMapsExportElement } from "./parsers.ts";

function writeTmpFile(content: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-google-maps-archive-stream-"));
  const path = join(dir, "Timeline.json");
  writeFileSync(path, content);
  return { dir, path };
}

test("semantic unknown-key tracking stays indexed to semanticSegments after another root array", async () => {
  const content = JSON.stringify({
    locations: [{ latitudeE7: 377_749_000, longitudeE7: -1_224_194_000, timestampMs: "1717595122000" }],
    semanticSegments: [
      {
        duration: { startTimestamp: "2024-06-05T13:45:22Z" },
        providerFutureField: { preserved: true },
      },
    ],
  });
  const { dir, path } = writeTmpFile(content);
  try {
    const semanticValues: unknown[] = [];
    await streamGoogleMapsExport(path, (event) => {
      if (event.kind === "element" && event.format === "semantic_segments") {
        semanticValues.push(event.value);
      }
    });
    assert.equal(semanticValues.length, 1);
    assert.deepEqual((semanticValues[0] as Record<string, unknown>).providerFutureField, {});
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("an oversized UNRELATED trailing root field after the last recognized element does not throw too-large", async () => {
  const segments = Array.from({ length: 200 }, () => ({
    activity: { activityType: "WALKING" },
    duration: { endTimestamp: "2024-06-05T14:00:00.000Z", startTimestamp: "2024-06-05T13:45:22.000Z" },
  }));
  const maxSingleElementBytes = 4 * 1024 * 1024;
  // Larger than the bound, but not a Timeline array element -- an unselected
  // sibling field at the document root.
  const unrelatedTrailingValue = "x".repeat(maxSingleElementBytes + 1024 * 1024);
  const content = JSON.stringify({
    semanticSegments: segments,
    unrelatedTrailingField: unrelatedTrailingValue,
  });
  const { dir, path } = writeTmpFile(content);
  try {
    let elementCount = 0;
    await streamGoogleMapsExport(
      path,
      (event) => {
        if (event.kind === "element") {
          elementCount += 1;
        }
      },
      { maxSingleElementBytes }
    );
    assert.equal(
      elementCount,
      segments.length,
      "every recognized element must still be emitted despite the oversized unrelated trailing field"
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a genuinely oversized SUPPORTED array element still throws GoogleMapsElementTooLargeError", async () => {
  const maxSingleElementBytes = 4 * 1024 * 1024;
  const oversizedNote = "x".repeat(maxSingleElementBytes + 1024 * 1024);
  const content = JSON.stringify({
    locations: [{ note: oversizedNote, timestampMs: "1717595122000" }],
  });
  const { dir, path } = writeTmpFile(content);
  try {
    await assert.rejects(
      () => streamGoogleMapsExport(path, () => undefined, { maxSingleElementBytes }),
      GoogleMapsElementTooLargeError
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a large semanticSegments aggregate is normalized incrementally instead of rejected as record_too_large", async () => {
  const pathPoints = Array.from({ length: 80_000 }, (_, index) => ({
    point: `geo:37.${String(index % 10).padStart(6, "0")},-122.${String(index % 10).padStart(6, "0")}`,
    time: `2024-06-05T13:${String(Math.floor(index / 60) % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z`,
  }));
  const content = JSON.stringify({
    semanticSegments: [
      {
        duration: { startTimestamp: "2024-06-05T13:45:22.000Z" },
        timelinePath: pathPoints,
      },
    ],
  });
  assert.ok(Buffer.byteLength(content, "utf8") > 4 * 1024 * 1024, "fixture must exceed the old element bound");
  const { dir, path } = writeTmpFile(content);
  try {
    let elementCount = 0;
    await streamGoogleMapsExport(path, (event) => {
      if (event.kind === "element") {
        elementCount += 1;
      }
    });
    assert.equal(elementCount, pathPoints.length, "each path point must reach the normalizer exactly once");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("streamed semantic segments match buffered segments in either field order without synthetic duplicates", async () => {
  const segmentBeforePath = {
    duration: { startTimestamp: "2024-06-05T13:45:22Z", endTimestamp: "2024-06-05T14:00:00Z" },
    activity: { activityType: "WALKING" },
    timelinePath: [{ point: "geo:37.4219999,-122.0840575", time: "2024-06-05T13:45:22Z" }],
  };
  const segmentAfterPath = {
    timelinePath: [{ point: "geo:37.4219999,-122.0840575", time: "2024-06-05T13:45:22Z" }],
    activity: { activityType: "WALKING" },
    duration: { startTimestamp: "2024-06-05T13:45:22Z", endTimestamp: "2024-06-05T14:00:00Z" },
  };
  for (const segment of [segmentBeforePath, segmentAfterPath]) {
    const content = JSON.stringify({ semanticSegments: [segment] });
    const { dir, path } = writeTmpFile(content);
    try {
      const streamedValues: unknown[] = [];
      await streamGoogleMapsExport(path, (event) => {
        if (event.kind === "element" && event.format === "semantic_segments") {
          streamedValues.push(event.value);
        }
      });
      const streamedSegments = streamedValues.flatMap(
        (value) => parseGoogleMapsExportElement("semantic_segments", value).segments
      );
      const bufferedSegments = parseGoogleMapsExport(JSON.parse(content)).segments;
      assert.equal(streamedSegments.length, bufferedSegments.length);
      assert.deepEqual(
        streamedSegments.map(({ id, segment_kind }) => ({ id, segment_kind })),
        bufferedSegments.map(({ id, segment_kind }) => ({ id, segment_kind }))
      );
      assert.deepEqual(
        streamedSegments[0],
        bufferedSegments[0],
        "streaming must preserve the complete semantic segment"
      );
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

test("a huge timelinePath stays bounded under a hard heap limit while unrelated fields remain guarded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-google-maps-huge-path-oracle-"));
  const path = join(dir, "Timeline.json");
  try {
    const point = JSON.stringify({ point: "geo:37.4219999,-122.0840575", time: "2024-06-05T13:45:22Z" });
    const out = createWriteStream(path);
    out.write('{"semanticSegments":[{"duration":{"startTimestamp":"2024-06-05T13:45:22Z"},"timelinePath":[');
    const repetitions = Math.ceil((70 * 1024 * 1024) / (point.length + 1));
    for (let index = 0; index < repetitions; index += 1) {
      out.write((index === 0 ? "" : ",") + point);
    }
    out.write("]}]}");
    await new Promise<void>((resolve, reject) =>
      out.end((error?: Error | null) => (error ? reject(error) : resolve()))
    );

    const childPath = new URL("./oversized-element-oracle.test.child.ts", import.meta.url);
    const result = spawnSync(
      process.execPath,
      ["--max-old-space-size=96", "--import", "tsx", childPath.pathname, path, String(statSync(path).size), "stream"],
      { encoding: "utf8", timeout: 60_000 }
    );
    assert.equal(result.status, 0, `huge path must stream under the heap limit: ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout.trim()).status, "valid");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a giant non-path field inside a semantic segment still trips the element guard", async () => {
  const maxSingleElementBytes = 4 * 1024 * 1024;
  const content = JSON.stringify({
    semanticSegments: [
      {
        startTime: "2024-06-05T13:45:22Z",
        providerExtension: "x".repeat(maxSingleElementBytes + 1),
      },
    ],
  });
  const { dir, path } = writeTmpFile(content);
  try {
    await assert.rejects(
      () => streamGoogleMapsExport(path, () => undefined, { maxSingleElementBytes }),
      GoogleMapsElementTooLargeError
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("an oversized PRIMITIVE array element (a bare string, not wrapped in an object) still throws GoogleMapsElementTooLargeError", async () => {
  // Regression counter-test: a supported array's element need not be an
  // object -- the byte tracker must also account for a
  // primitive element's own bytes while its single (possibly multi-chunk)
  // token is being tokenized, not just for bytes belonging to a nested
  // object/array frame. A predicate that only recognizes "nested container
  // frame present" silently admits this case with zero bytes counted.
  const maxSingleElementBytes = 4 * 1024 * 1024;
  const oversizedPrimitive = "x".repeat(maxSingleElementBytes + 1024 * 1024);
  const content = JSON.stringify({ locations: [oversizedPrimitive] });
  const { dir, path } = writeTmpFile(content);
  try {
    let elementCount = 0;
    await assert.rejects(
      () =>
        streamGoogleMapsExport(
          path,
          (event) => {
            if (event.kind === "element") {
              elementCount += 1;
            }
          },
          { maxSingleElementBytes }
        ),
      GoogleMapsElementTooLargeError
    );
    assert.equal(elementCount, 0, "the oversized primitive must never be emitted as an element");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("many small PRIMITIVE array elements, none oversized, are unaffected by the per-element bound", async () => {
  const maxSingleElementBytes = 4 * 1024 * 1024;
  const primitives = Array.from({ length: 3000 }, (_, i) => `point-${i}`);
  const content = JSON.stringify({ locations: primitives });
  const { dir, path } = writeTmpFile(content);
  try {
    let elementCount = 0;
    await streamGoogleMapsExport(
      path,
      (event) => {
        if (event.kind === "element") {
          elementCount += 1;
        }
      },
      { maxSingleElementBytes }
    );
    assert.equal(elementCount, primitives.length);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("primitive string, number, boolean, and null boundaries count the exact element bytes", async () => {
  const values = [
    { label: "string", value: "boundary" },
    { label: "number", value: 123_456_789 },
    { label: "boolean", value: true },
    { label: "null", value: null },
  ] as const;

  await Promise.all(
    values.map(async ({ label, value }) => {
      const encoded = JSON.stringify(value);
      const content = JSON.stringify({ locations: [value] });
      const { dir, path } = writeTmpFile(content);
      try {
        await streamGoogleMapsExport(path, () => undefined, {
          maxSingleElementBytes: Buffer.byteLength(encoded, "utf8"),
        });
        await assert.rejects(
          () =>
            streamGoogleMapsExport(path, () => undefined, {
              maxSingleElementBytes: Buffer.byteLength(encoded, "utf8") - 1,
            }),
          GoogleMapsElementTooLargeError,
          `${label} element must fail one byte below its exact bound`
        );
      } finally {
        rmSync(dir, { force: true, recursive: true });
      }
    })
  );
});

test("object and nested-array elements count across read-buffer boundaries", async () => {
  const maxSingleElementBytes = 70_000;
  const objectElement = { note: "x".repeat(maxSingleElementBytes - 20) };
  const objectContent = JSON.stringify({ locations: [objectElement] });
  const { dir: objectDir, path: objectPath } = writeTmpFile(objectContent);
  try {
    const objectBytes = Buffer.byteLength(JSON.stringify(objectElement), "utf8");
    await streamGoogleMapsExport(objectPath, () => undefined, { maxSingleElementBytes: objectBytes });
    await assert.rejects(
      () => streamGoogleMapsExport(objectPath, () => undefined, { maxSingleElementBytes: objectBytes - 1 }),
      GoogleMapsElementTooLargeError
    );
  } finally {
    rmSync(objectDir, { force: true, recursive: true });
  }

  const arrayElement = ["x".repeat(maxSingleElementBytes - 20)];
  const arrayContent = JSON.stringify([arrayElement]);
  const { dir: arrayDir, path: arrayPath } = writeTmpFile(arrayContent);
  try {
    const arrayBytes = Buffer.byteLength(JSON.stringify(arrayElement), "utf8");
    await streamGoogleMapsExport(arrayPath, () => undefined, { maxSingleElementBytes: arrayBytes });
    await assert.rejects(
      () => streamGoogleMapsExport(arrayPath, () => undefined, { maxSingleElementBytes: arrayBytes - 1 }),
      GoogleMapsElementTooLargeError
    );
  } finally {
    rmSync(arrayDir, { force: true, recursive: true });
  }
});

test("large whitespace between selected elements is not attributed to either element", async () => {
  const maxSingleElementBytes = 64;
  const content = `{"locations":[{"id":1}${" ".repeat(4096)},{"id":2}]}`;
  const { dir, path } = writeTmpFile(content);
  try {
    let elementCount = 0;
    await streamGoogleMapsExport(
      path,
      (event) => {
        if (event.kind === "element") {
          elementCount += 1;
        }
      },
      { maxSingleElementBytes }
    );
    assert.equal(elementCount, 2);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a recognized key with a malformed non-array value reports unsupported, not too-large", async () => {
  const content = JSON.stringify({ locations: { note: "not an array" }, trailing: "x".repeat(4096) });
  const { dir, path } = writeTmpFile(content);
  try {
    await assert.rejects(
      () => streamGoogleMapsExport(path, () => undefined, { maxSingleElementBytes: 16 }),
      GoogleMapsUnsupportedShapeError
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("many small elements across all three shapes stay unaffected by the per-element bound", async () => {
  const maxSingleElementBytes = 4 * 1024 * 1024;
  const points = Array.from({ length: 2000 }, (_, i) => ({
    latitudeE7: 377_749_000 + i,
    longitudeE7: -1_224_194_000 - i,
    timestampMs: String(1_717_595_122_000 + i * 1000),
  }));
  const content = JSON.stringify({ locations: points });
  const { dir, path } = writeTmpFile(content);
  try {
    let elementCount = 0;
    await streamGoogleMapsExport(
      path,
      (event) => {
        if (event.kind === "element") {
          elementCount += 1;
        }
      },
      { maxSingleElementBytes }
    );
    assert.equal(elementCount, points.length);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a large archive of small elements is bounded by one element, not by archive size", async () => {
  const count = 299_000;
  const maxSingleElementBytes = 4 * 1024 * 1024;
  const points = Array.from({ length: count }, (_, i) => ({
    latitudeE7: 377_749_000 + (i % 1000),
    longitudeE7: -1_224_194_000 - (i % 1000),
    timestampMs: String(1_717_595_122_000 + i),
  }));
  const { dir, path } = writeTmpFile(JSON.stringify({ locations: points }));
  try {
    let elementCount = 0;
    await streamGoogleMapsExport(
      path,
      (event) => {
        if (event.kind === "element") {
          elementCount += 1;
        }
      },
      { maxSingleElementBytes }
    );
    assert.equal(elementCount, count);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
