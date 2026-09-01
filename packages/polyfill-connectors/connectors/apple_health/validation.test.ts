// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { validateAppleHealthExportArtifact } from "./validation.ts";

const REAL_EXPORT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
<ExportDate value="2026-09-01 12:00:00 -0500"/>
<Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="2018-01-30 08:59:38 -0800" endDate="2018-01-30 09:00:38 -0800" value="120"/>
<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Apple Watch" unit="count/min" startDate="2018-02-01 08:59:38 -0800" endDate="2018-02-01 08:59:38 -0800" value="61"/>
<Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" sourceName="iPhone" startDate="2018-01-15 07:00:00 -0800" endDate="2018-01-15 07:30:00 -0800"/>
</HealthData>
`;

const EMPTY_EXPORT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
<ExportDate value="2026-09-01 12:00:00 -0500"/>
</HealthData>
`;

function buildZip(entries: readonly { name: string; data: Buffer }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04_03_4b_50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x08_00, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    const localEntry = Buffer.concat([localHeader, nameBuf, compressed]);
    localParts.push(localEntry);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02_01_4b_50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x08_00, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(Buffer.concat([centralHeader, nameBuf]));
    offset += localEntry.length;
  }
  const centralDirStart = offset;
  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06_05_4b_50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(centralDirStart, 16);
  return Buffer.concat([...localParts, centralDir, eocd]);
}

test("validateAppleHealthExportArtifact: a real export.xml is valid with correct counts and date range", async () => {
  const result = await validateAppleHealthExportArtifact(REAL_EXPORT_XML, { fileName: "export.xml" });
  assert.equal(result.status, "valid");
  assert.equal(result.detected_format, "apple_health_export_xml");
  assert.equal(result.estimated_records, 2);
  assert.equal(result.estimated_workouts, 1);
  assert.equal(result.remediation, null);
});

test("validateAppleHealthExportArtifact: a real export.zip (apple_health_export/export.xml) is valid", async () => {
  const zip = buildZip([{ data: Buffer.from(REAL_EXPORT_XML), name: "apple_health_export/export.xml" }]);
  const result = await validateAppleHealthExportArtifact(zip, { fileName: "export.zip" });
  assert.equal(result.status, "valid");
  assert.equal(result.detected_format, "apple_health_export_zip");
  assert.equal(result.estimated_records, 2);
});

test("validateAppleHealthExportArtifact: an empty HealthData document is reported as empty, not valid", async () => {
  const result = await validateAppleHealthExportArtifact(EMPTY_EXPORT_XML, { fileName: "export.xml" });
  assert.equal(result.status, "empty");
  assert.match(result.remediation ?? "", /does not contain any records/);
});

test("validateAppleHealthExportArtifact: a wrong file (not a health export) is unsupported with actionable remediation, never reported valid", async () => {
  const result = await validateAppleHealthExportArtifact('<?xml version="1.0"?>\n<NotHealth/>\n', {
    fileName: "export.xml",
  });
  assert.equal(result.status, "unsupported");
  assert.match(result.remediation ?? "", /Export All Health Data/);
});

test("validateAppleHealthExportArtifact: a .zip with no export.xml entry is unsupported, not silently valid", async () => {
  const zip = buildZip([{ data: Buffer.from("not a health export"), name: "readme.txt" }]);
  const result = await validateAppleHealthExportArtifact(zip, { fileName: "export.zip" });
  assert.equal(result.status, "unsupported");
});

test("validateAppleHealthExportArtifact: a file exceeding maxFileBytes is too_large, not silently truncated", async () => {
  const result = await validateAppleHealthExportArtifact(REAL_EXPORT_XML, {
    fileName: "export.xml",
    maxFileBytes: 10,
  });
  assert.equal(result.status, "too_large");
});

test("validateAppleHealthExportArtifact: the same file hash reported as an existing hash is duplicate, not valid", async () => {
  const first = await validateAppleHealthExportArtifact(REAL_EXPORT_XML, { fileName: "export.xml" });
  const second = await validateAppleHealthExportArtifact(REAL_EXPORT_XML, {
    existingFileHashes: [first.file_sha256],
    fileName: "export.xml",
  });
  assert.equal(second.status, "duplicate");
});
