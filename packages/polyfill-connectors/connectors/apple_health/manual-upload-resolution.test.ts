// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { findUploadedExportCandidate, resolveUploadedExportPath, scanExportXmlSummary } from "./parsers.ts";

const REAL_EXPORT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
<ExportDate value="2026-09-01 12:00:00 -0500"/>
<Me HKCharacteristicTypeIdentifierDateOfBirth="1990-01-01" HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexNotSet" HKCharacteristicTypeIdentifierBloodType="HKBloodTypeNotSet" HKCharacteristicTypeIdentifierFitzpatrickSkinType="HKFitzpatrickSkinTypeNotSet"/>
<Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" creationDate="2018-01-30 08:59:38 -0800" startDate="2018-01-30 08:59:38 -0800" endDate="2018-01-30 09:00:38 -0800" value="120"/>
<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Apple Watch" unit="count/min" creationDate="2018-02-01 08:59:38 -0800" startDate="2018-02-01 08:59:38 -0800" endDate="2018-02-01 08:59:38 -0800" value="61"/>
<Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" sourceName="iPhone" creationDate="2018-01-15 07:00:00 -0800" startDate="2018-01-15 07:00:00 -0800" endDate="2018-01-15 07:30:00 -0800"/>
</HealthData>
`;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pdpp-apple-health-manual-upload-"));
}

function buildZipEntry(name: string, content: Buffer): Buffer {
  const nameBuf = Buffer.from(name, "utf8");
  const compressed = deflateRawSync(content);

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04_03_4b_50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0x08_00, 6);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(content.length, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  const localEntry = Buffer.concat([localHeader, nameBuf, compressed]);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02_01_4b_50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0x08_00, 8);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt32LE(compressed.length, 20);
  centralHeader.writeUInt32LE(content.length, 24);
  centralHeader.writeUInt16LE(nameBuf.length, 28);
  const centralDir = Buffer.concat([centralHeader, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06_05_4b_50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(localEntry.length, 16);

  return Buffer.concat([localEntry, centralDir, eocd]);
}

// ─── findUploadedExportCandidate ────────────────────────────────────────

test("findUploadedExportCandidate: finds a flat .xml file", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "my-export.xml"), REAL_EXPORT_XML);
    assert.equal(findUploadedExportCandidate(dir), join(dir, "my-export.xml"));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("findUploadedExportCandidate: finds a .zip nested one level under an artifact-id directory", () => {
  const dir = tempDir();
  try {
    const artifactDir = join(dir, "mua_abc123");
    mkdirSync(artifactDir);
    writeFileSync(
      join(artifactDir, "export.zip"),
      buildZipEntry("apple_health_export/export.xml", Buffer.from(REAL_EXPORT_XML))
    );
    assert.equal(findUploadedExportCandidate(dir), join(artifactDir, "export.zip"));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("findUploadedExportCandidate: prefers the most-recently-modified candidate when several exist", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "older.xml"), REAL_EXPORT_XML);
    // Force a real mtime gap -- same-millisecond writes can tie on some filesystems.
    const older = join(dir, "older.xml");
    const now = new Date();
    utimesSync(older, new Date(now.getTime() - 60_000), new Date(now.getTime() - 60_000));
    writeFileSync(join(dir, "newer.xml"), REAL_EXPORT_XML);
    assert.equal(findUploadedExportCandidate(dir), join(dir, "newer.xml"));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("findUploadedExportCandidate: ignores unrelated file extensions and returns null when none match", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "readme.txt"), "not an export");
    writeFileSync(join(dir, "photo.png"), "binary-ish");
    assert.equal(findUploadedExportCandidate(dir), null);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("findUploadedExportCandidate: returns null for a missing directory instead of throwing", () => {
  assert.equal(findUploadedExportCandidate("/nonexistent/pdpp-apple-health-test-dir"), null);
});

// ─── resolveUploadedExportPath ──────────────────────────────────────────

test("resolveUploadedExportPath: a bare .xml candidate that looks like a real export resolves directly", async () => {
  const dir = tempDir();
  try {
    const xmlPath = join(dir, "export.xml");
    writeFileSync(xmlPath, REAL_EXPORT_XML);
    const outcome = await resolveUploadedExportPath(xmlPath);
    assert.deepEqual(outcome, { kind: "resolved", resolved: { extractedFromZip: false, path: xmlPath } });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("resolveUploadedExportPath: a .zip containing apple_health_export/export.xml is extracted and resolves", async () => {
  const dir = tempDir();
  try {
    const zipPath = join(dir, "export.zip");
    writeFileSync(zipPath, buildZipEntry("apple_health_export/export.xml", Buffer.from(REAL_EXPORT_XML)));
    const outcome = await resolveUploadedExportPath(zipPath);
    assert.equal(outcome.kind, "resolved");
    if (outcome.kind === "resolved") {
      assert.equal(outcome.resolved.extractedFromZip, true);
      assert.equal(readFileSync(outcome.resolved.path, "utf8"), REAL_EXPORT_XML);
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("resolveUploadedExportPath: extraction is cached — a second call reuses the sibling file without re-extracting", async () => {
  const dir = tempDir();
  try {
    const zipPath = join(dir, "export.zip");
    writeFileSync(zipPath, buildZipEntry("apple_health_export/export.xml", Buffer.from(REAL_EXPORT_XML)));
    const first = await resolveUploadedExportPath(zipPath);
    assert.equal(first.kind, "resolved");
    const extractedPath = first.kind === "resolved" ? first.resolved.path : "";
    const firstMtime = statSync(extractedPath).mtimeMs;

    const second = await resolveUploadedExportPath(zipPath);
    assert.equal(second.kind, "resolved");
    const secondMtime = statSync(extractedPath).mtimeMs;
    assert.equal(firstMtime, secondMtime, "cached extraction must not rewrite the sibling file on a second call");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("resolveUploadedExportPath: a .zip with no export.xml entry fails loudly with an actionable message", async () => {
  const dir = tempDir();
  try {
    const zipPath = join(dir, "export.zip");
    writeFileSync(zipPath, buildZipEntry("some-other-file.txt", Buffer.from("not a health export")));
    const outcome = await resolveUploadedExportPath(zipPath);
    assert.equal(outcome.kind, "extraction_failed");
    if (outcome.kind === "extraction_failed") {
      assert.match(outcome.message, /does not contain an export\.xml/);
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("resolveUploadedExportPath: a bare .xml file that is NOT a health export fails loudly, never silently succeeds", async () => {
  const dir = tempDir();
  try {
    const xmlPath = join(dir, "not-a-health-export.xml");
    writeFileSync(xmlPath, '<?xml version="1.0"?>\n<SomethingElse><Item/></SomethingElse>\n');
    const outcome = await resolveUploadedExportPath(xmlPath);
    assert.equal(outcome.kind, "extraction_failed");
    if (outcome.kind === "extraction_failed") {
      assert.match(outcome.message, /does not look like an Apple Health export/);
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("resolveUploadedExportPath: a completely unrelated file extension is not_found, not silently accepted", async () => {
  const dir = tempDir();
  try {
    const path = join(dir, "readme.txt");
    writeFileSync(path, "hello");
    const outcome = await resolveUploadedExportPath(path);
    assert.deepEqual(outcome, { kind: "not_found" });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

// ─── scanExportXmlSummary ───────────────────────────────────────────────

test("scanExportXmlSummary: counts Records and Workouts exactly once, computes the date range", async () => {
  const dir = tempDir();
  try {
    const xmlPath = join(dir, "export.xml");
    writeFileSync(xmlPath, REAL_EXPORT_XML);
    const summary = await scanExportXmlSummary(xmlPath);
    assert.equal(summary.looksLikeHealthExport, true);
    assert.equal(summary.recordCount, 2);
    assert.equal(summary.workoutCount, 1);
    assert.equal(summary.earliestStartDate, "2018-01-15T15:00:00.000Z");
    assert.equal(summary.latestStartDate, "2018-02-01T16:59:38.000Z");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("scanExportXmlSummary: does not double-count a Workout with nested MetadataEntry/WorkoutEvent children", async () => {
  const dir = tempDir();
  try {
    const xmlPath = join(dir, "export.xml");
    writeFileSync(
      xmlPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
<Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" sourceName="iPhone" startDate="2018-01-15 07:00:00 -0800" endDate="2018-01-15 07:30:00 -0800">
<MetadataEntry key="HKIndoorWorkout" value="0"/>
<WorkoutEvent type="HKWorkoutEventTypePause" date="2018-01-15 07:10:00 -0800"/>
</Workout>
</HealthData>
`
    );
    const summary = await scanExportXmlSummary(xmlPath);
    assert.equal(
      summary.workoutCount,
      1,
      "nested children must not be miscounted as additional Workout/Record elements"
    );
    assert.equal(summary.recordCount, 0);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("scanExportXmlSummary: a file without the <HealthData root reports looksLikeHealthExport=false, zero counts", async () => {
  const dir = tempDir();
  try {
    const xmlPath = join(dir, "not-health.xml");
    writeFileSync(xmlPath, '<?xml version="1.0"?>\n<Something><Record type="x" startDate="2018-01-01"/></Something>\n');
    const summary = await scanExportXmlSummary(xmlPath);
    assert.equal(summary.looksLikeHealthExport, false);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("scanExportXmlSummary: an empty HealthData document (no records/workouts) is still recognized as a health export with zero counts", async () => {
  const dir = tempDir();
  try {
    const xmlPath = join(dir, "empty.xml");
    writeFileSync(
      xmlPath,
      '<?xml version="1.0"?>\n<HealthData locale="en_US">\n<ExportDate value="2026-09-01 12:00:00 -0500"/>\n</HealthData>\n'
    );
    const summary = await scanExportXmlSummary(xmlPath);
    assert.equal(summary.looksLikeHealthExport, true);
    assert.equal(summary.recordCount, 0);
    assert.equal(summary.workoutCount, 0);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
