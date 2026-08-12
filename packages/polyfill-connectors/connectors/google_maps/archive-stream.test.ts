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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GoogleMapsElementTooLargeError,
  GoogleMapsUnsupportedShapeError,
  streamGoogleMapsExport,
} from "./archive-stream.ts";

function writeTmpFile(content: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-google-maps-archive-stream-"));
  const path = join(dir, "Timeline.json");
  writeFileSync(path, content);
  return { dir, path };
}

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
