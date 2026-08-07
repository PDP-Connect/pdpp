// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { validateNetflixExportArtifact } from "./validation.ts";

const VALID_DIRECT_HISTORY_CSV = `Title,Date
"The Crown",2024-01-15
"Stranger Things",2024-01-14`;

const VALID_FULL_EXPORT_CSV = `Profile Name,Start Time (UTC),Duration (H:MM:SS),Attributes,Title,Supplemental Video Type,Device Type,Bookmark,Latest Bookmark,Country
"Main","2024-01-15 20:14:03","0:42:10","","The Crown","","TV","0:42:10","0:42:10","US"
"Shared","2024-01-14 19:00:00","0:50:22","","Stranger Things","","Phone","0:50:22","0:50:22","US"`;

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

test("validateNetflixExportArtifact accepts a raw direct_history CSV upload (immediate Download all)", () => {
  const validation = validateNetflixExportArtifact(VALID_DIRECT_HISTORY_CSV, { fileName: "NetflixViewingHistory.csv" });

  assert.equal(validation.status, "valid");
  assert.equal(validation.detected_format, "viewing_activity_csv");
  assert.equal(validation.detected_schema, "direct_history");
  assert.equal(validation.estimated_records, 2);
  assert.equal(validation.date_range.start, "2024-01-14T00:00:00.000Z");
  assert.equal(validation.date_range.end, "2024-01-15T00:00:00.000Z");
  assert.match(validation.file_sha256, /^[0-9a-f]{64}$/);
  assert.equal(validation.remediation, null);
});

test("validateNetflixExportArtifact accepts a raw full_export ViewingActivity.csv upload", () => {
  const validation = validateNetflixExportArtifact(VALID_FULL_EXPORT_CSV, { fileName: "ViewingActivity.csv" });

  assert.equal(validation.status, "valid");
  assert.equal(validation.detected_format, "viewing_activity_csv");
  assert.equal(validation.detected_schema, "full_export");
  assert.equal(validation.estimated_records, 2);
});

test("validateNetflixExportArtifact accepts the official Netflix export zip archive", () => {
  const zip = makeStoredZip([
    { name: "CONTENT_INTERACTION/ViewingActivity.csv", data: VALID_FULL_EXPORT_CSV },
    { name: "IDENTIFIERS/Devices.csv", data: "Device Type\nTV\n" },
  ]);
  const validation = validateNetflixExportArtifact(zip, { fileName: "netflix-report.zip" });

  assert.equal(validation.status, "valid");
  assert.equal(validation.detected_format, "viewing_activity_zip");
  assert.equal(validation.detected_schema, "full_export");
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

test("validateNetflixExportArtifact rejects a CSV with an unrecognized/mixed header row, never guessing a schema", () => {
  const validation = validateNetflixExportArtifact("Title,Watched at,Device type,Watch duration,Profile name", {
    fileName: "ViewingActivity.csv",
  });
  assert.equal(validation.status, "unsupported");
  assert.equal(validation.detected_schema, null);
});

test("validateNetflixExportArtifact reports empty for a headers-only direct_history CSV", () => {
  const validation = validateNetflixExportArtifact("Title,Date", { fileName: "NetflixViewingHistory.csv" });
  assert.equal(validation.status, "empty");
  assert.equal(validation.detected_schema, "direct_history");
});

test("validateNetflixExportArtifact identifies duplicate artifacts by hash", () => {
  const first = validateNetflixExportArtifact(VALID_DIRECT_HISTORY_CSV, { fileName: "NetflixViewingHistory.csv" });
  const duplicate = validateNetflixExportArtifact(VALID_DIRECT_HISTORY_CSV, {
    fileName: "NetflixViewingHistory.csv",
    existingFileHashes: [first.file_sha256],
  });

  assert.equal(duplicate.status, "duplicate");
  assert.match(duplicate.remediation ?? "", /already imported/i);
});

test("validateNetflixExportArtifact rejects files exceeding the size limit", () => {
  const tooLarge = validateNetflixExportArtifact(VALID_DIRECT_HISTORY_CSV, {
    fileName: "NetflixViewingHistory.csv",
    maxFileBytes: 4,
  });
  assert.equal(tooLarge.status, "too_large");
});

test("a zip whose ViewingActivity.csv entry trips the decompression-bomb policy classifies as too_large, NOT unsupported", () => {
  // A real (well-formed, honestly-labeled) Netflix export zip whose
  // ViewingActivity.csv entry is bigger than MAX_CSV_BYTES. This is a
  // genuine Netflix export the parser simply can't safely process — the
  // user-facing status must distinguish this from "not a Netflix export at
  // all" (unsupported), since the remediation and owner-facing meaning are
  // different: "shrink or use the fallback" vs "wrong file."
  const oversizedCsv = Buffer.alloc(60 * 1024 * 1024, 65); // 60 MiB, over the 50 MiB MAX_CSV_BYTES cap
  const zip = makeStoredZip([{ name: "CONTENT_INTERACTION/ViewingActivity.csv", data: oversizedCsv }]);
  const validation = validateNetflixExportArtifact(zip, { fileName: "netflix-report.zip" });

  assert.equal(validation.status, "too_large");
  assert.notEqual(validation.status, "unsupported");
  assert.match(validation.remediation ?? "", /real Netflix export|too large to safely process/i);
});

test("a zip declaring far more entries than the policy allows classifies as too_large, NOT unsupported", () => {
  const entries = Array.from({ length: 6000 }, (_, i) => ({ data: "x", name: `file-${i}.csv` }));
  const zip = makeStoredZip(entries);
  const validation = validateNetflixExportArtifact(zip, { fileName: "netflix-report.zip" });

  assert.equal(validation.status, "too_large");
});
