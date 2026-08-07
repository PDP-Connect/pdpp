// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { validateNetflixExportArtifact } from "./validation.ts";

const VALID_CSV = `Title,Watched at,Device type,Watch duration,Profile name
"The Crown","2024-01-15","TV","85%","Main"
"Stranger Things","2024-01-14","Phone","92%","Shared"`;

function zipHeader(signature: number, size: number): Buffer {
  const header = Buffer.alloc(size);
  header.writeUInt32LE(signature, 0);
  return header;
}

function makeStoredZip(entries: readonly { name: string; data: string | Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const local = zipHeader(0x04_03_4b_50, 30);
    local.writeUInt16LE(0x08_00, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, data);

    const directory = zipHeader(0x02_01_4b_50, 46);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x08_00, 8);
    directory.writeUInt16LE(0, 10);
    directory.writeUInt32LE(0, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += local.length + name.length + data.length;
  }
  const centralStart = offset;
  const centralBytes = Buffer.concat(central);
  const end = zipHeader(0x06_05_4b_50, 22);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...chunks, centralBytes, end]);
}

test("validateNetflixExportArtifact accepts a raw ViewingActivity.csv upload", () => {
  const validation = validateNetflixExportArtifact(VALID_CSV, { fileName: "ViewingActivity.csv" });

  assert.equal(validation.status, "valid");
  assert.equal(validation.detected_format, "viewing_activity_csv");
  assert.equal(validation.estimated_records, 2);
  assert.equal(validation.date_range.start, "2024-01-14T00:00:00.000Z");
  assert.equal(validation.date_range.end, "2024-01-15T00:00:00.000Z");
  assert.match(validation.file_sha256, /^[0-9a-f]{64}$/);
  assert.equal(validation.remediation, null);
});

test("validateNetflixExportArtifact accepts the official Netflix export zip archive", () => {
  const zip = makeStoredZip([
    { name: "CONTENT_INTERACTION/ViewingActivity.csv", data: VALID_CSV },
    { name: "IDENTIFIERS/Devices.csv", data: "Device Type\nTV\n" },
  ]);
  const validation = validateNetflixExportArtifact(zip, { fileName: "netflix-report.zip" });

  assert.equal(validation.status, "valid");
  assert.equal(validation.detected_format, "viewing_activity_zip");
  assert.equal(validation.estimated_records, 2);
});

test("validateNetflixExportArtifact rejects a zip without ViewingActivity.csv", () => {
  const zip = makeStoredZip([{ name: "IDENTIFIERS/Devices.csv", data: "Device Type\nTV\n" }]);
  const validation = validateNetflixExportArtifact(zip, { fileName: "netflix-report.zip" });

  assert.equal(validation.status, "unsupported");
  assert.equal(validation.detected_format, "unsupported");
});

test("validateNetflixExportArtifact rejects an unrecognized file extension", () => {
  const validation = validateNetflixExportArtifact("some text", { fileName: "notes.txt" });
  assert.equal(validation.status, "unsupported");
});

test("validateNetflixExportArtifact reports empty for a headers-only CSV", () => {
  const validation = validateNetflixExportArtifact("Title,Watched at,Device type,Watch duration,Profile name", {
    fileName: "ViewingActivity.csv",
  });
  assert.equal(validation.status, "empty");
});

test("validateNetflixExportArtifact identifies duplicate artifacts by hash", () => {
  const first = validateNetflixExportArtifact(VALID_CSV, { fileName: "ViewingActivity.csv" });
  const duplicate = validateNetflixExportArtifact(VALID_CSV, {
    fileName: "ViewingActivity.csv",
    existingFileHashes: [first.file_sha256],
  });

  assert.equal(duplicate.status, "duplicate");
  assert.match(duplicate.remediation ?? "", /already imported/i);
});

test("validateNetflixExportArtifact rejects files exceeding the size limit", () => {
  const tooLarge = validateNetflixExportArtifact(VALID_CSV, { fileName: "ViewingActivity.csv", maxFileBytes: 4 });
  assert.equal(tooLarge.status, "too_large");
});
