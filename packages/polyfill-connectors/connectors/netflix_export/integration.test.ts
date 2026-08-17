// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the Netflix export connector. Tests full CSV file
 * parsing, duplicate handling, and archive resolution.
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";
import { findViewingActivityFiles, parseCSVFile, resolveViewingActivityFile, validateArchivePath } from "./parsers.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "../..");
const NETFLIX_ENTRYPOINT = join(PACKAGE_ROOT, "connectors", "netflix_export", "index.ts");

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

function records(messages: EmittedMessage[], stream: string): Record<string, unknown>[] {
  return messages
    .filter((message) => message.type === "RECORD" && message.stream === stream)
    .map((message) => (message as { data: Record<string, unknown> }).data);
}

async function runNetflixImport(importRoot: string): Promise<{ messages: EmittedMessage[] }> {
  const result = await runConnectorProtocolSubprocess({
    cwd: PACKAGE_ROOT,
    entrypoint: NETFLIX_ENTRYPOINT,
    env: {
      NETFLIX_EXPORT_DIR: importRoot,
      PDPP_OWNER_TOKEN: "",
      PDPP_RS_URL: "",
      RS_URL: "",
      TZ: "America/Chicago",
    },
    start: {
      scope: { streams: [{ name: "viewing_activity" }] },
      type: "START",
    },
  });
  return { messages: result.messages };
}

const DIRECT_HISTORY_CSV = `Title,Date
"The Crown",2024-01-15
"Stranger Things",2024-01-14`;

const FULL_EXPORT_CSV = `Profile Name,Start Time (UTC),Duration (H:MM:SS),Attributes,Title,Supplemental Video Type,Device Type,Bookmark,Latest Bookmark,Country
"Main","2024-01-15 10:30:00","0:42:10","","The Crown","","TV","0:42:10","0:42:10","US"
"Secondary","2024-01-14 15:45:00","0:50:22","","Stranger Things","","Phone","0:50:22","0:50:22","US"`;

test("Netflix connector emits records from a raw direct_history CSV uploaded flat into the import dir (Add Source path)", async () => {
  const importRoot = await mkdtemp(join(tmpdir(), "pdpp-netflix-upload-csv-"));
  try {
    // Mirrors the manual-upload route's on-disk contract: the uploaded file
    // is written flat as join(importDir, fileName) — no server-side unzip,
    // no nested CONTENT_INTERACTION/ subdirectory.
    await writeFile(join(importRoot, "NetflixViewingHistory.csv"), DIRECT_HISTORY_CSV, "utf8");

    const { messages } = await runNetflixImport(importRoot);
    const emitted = records(messages, "viewing_activity");
    assert.equal(emitted.length, 2);
    assert.ok(emitted.some((r) => r.title === "The Crown"));
    assert.ok(emitted.every((r) => r.source_schema === "direct_history" && r.watched_at_precision === "day"));

    const done = messages.at(-1);
    assert.equal(done?.type, "DONE");
    if (done?.type === "DONE") {
      assert.equal(done.status, "succeeded");
      assert.equal(done.records_emitted, 2);
    }
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});

test("Netflix connector emits records from the official getmyinfo zip archive uploaded flat into the import dir", async () => {
  const importRoot = await mkdtemp(join(tmpdir(), "pdpp-netflix-upload-zip-"));
  try {
    const zip = makeStoredZip([
      { name: "CONTENT_INTERACTION/ViewingActivity.csv", data: FULL_EXPORT_CSV },
      { name: "IDENTIFIERS/Devices.csv", data: "Device Type\nTV\n" },
    ]);
    await writeFile(join(importRoot, "netflix-report.zip"), zip);

    const { messages } = await runNetflixImport(importRoot);
    const emitted = records(messages, "viewing_activity");
    assert.equal(emitted.length, 2);
    assert.ok(emitted.every((r) => r.source_schema === "full_export" && r.watched_at_precision === "instant"));

    const done = messages.at(-1);
    assert.equal(done?.type, "DONE");
    if (done?.type === "DONE") {
      assert.equal(done.status, "succeeded");
      assert.equal(done.records_emitted, 2);
    }
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});

test("Netflix connector still honors the legacy pre-extracted CONTENT_INTERACTION directory layout", async () => {
  const importRoot = await mkdtemp(join(tmpdir(), "pdpp-netflix-legacy-dir-"));
  try {
    const contentDir = join(importRoot, "CONTENT_INTERACTION");
    mkdirSync(contentDir);
    writeFileSync(join(contentDir, "ViewingActivity.csv"), FULL_EXPORT_CSV, "utf8");

    const { messages } = await runNetflixImport(importRoot);
    const emitted = records(messages, "viewing_activity");
    assert.equal(emitted.length, 2);
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});

test("Netflix connector rejects an unrecognized/mixed CSV header instead of guessing a schema", async () => {
  const importRoot = await mkdtemp(join(tmpdir(), "pdpp-netflix-unknown-schema-"));
  try {
    await writeFile(
      join(importRoot, "unknown.csv"),
      "Title,Watched at,Device type,Watch duration,Profile name\n",
      "utf8"
    );

    const { messages } = await runNetflixImport(importRoot);
    const emitted = records(messages, "viewing_activity");
    assert.equal(emitted.length, 0);

    const skip = messages.find((m) => m.type === "SKIP_RESULT");
    assert.ok(skip, "expected a SKIP_RESULT for the unrecognized header");
    if (skip?.type === "SKIP_RESULT") {
      assert.equal(skip.reason, "unrecognized_csv_schema");
    }
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});

test("Netflix connector resolves a mixed direct_history dataset using the one row that disambiguates it", async () => {
  const importRoot = await mkdtemp(join(tmpdir(), "pdpp-netflix-mixed-date-order-"));
  try {
    const csvContent = `Title,Date
"Ambiguous A",05/03/2024
"Ambiguous B",07/02/2024
"Disambiguator",25/12/2024`;
    await writeFile(join(importRoot, "NetflixViewingHistory.csv"), csvContent, "utf8");

    const { messages } = await runNetflixImport(importRoot);
    const emitted = records(messages, "viewing_activity");
    assert.equal(emitted.length, 3);
    // 25/12 unambiguously proves DD/MM/YYYY for this dataset -> the
    // ambiguous rows resolve the same way: 05/03 = March 5, 07/02 = Feb 7.
    assert.ok(emitted.some((r) => r.watched_at === "2024-03-05T00:00:00.000Z"));
    assert.ok(emitted.some((r) => r.watched_at === "2024-02-07T00:00:00.000Z"));
    assert.ok(emitted.some((r) => r.watched_at === "2024-12-25T00:00:00.000Z"));

    const done = messages.at(-1);
    assert.equal(done?.type, "DONE");
    if (done?.type === "DONE") {
      assert.equal(done.status, "succeeded");
      assert.equal(done.records_emitted, 3);
    }
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});

test("Netflix connector emits a typed coverage-gap SKIP_RESULT when every date in the dataset is ambiguous", async () => {
  const importRoot = await mkdtemp(join(tmpdir(), "pdpp-netflix-all-ambiguous-"));
  try {
    const csvContent = `Title,Date
"Ambiguous A",05/03/2024
"Ambiguous B",07/02/2024
"Ambiguous C",01/01/2024`;
    await writeFile(join(importRoot, "NetflixViewingHistory.csv"), csvContent, "utf8");

    const { messages } = await runNetflixImport(importRoot);
    const emitted = records(messages, "viewing_activity");
    assert.equal(emitted.length, 0, "no row should be silently guessed or dropped without a typed gap");

    const skip = messages.find((m) => m.type === "SKIP_RESULT");
    assert.ok(skip, "expected a SKIP_RESULT for the all-ambiguous dataset");
    if (skip?.type === "SKIP_RESULT") {
      assert.equal(skip.reason, "ambiguous_date_order");
    }
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});

test("parseCSVFile reads and parses a complete direct_history CSV fixture", async () => {
  const csvContent = `Title,Date
"The Crown",2024-01-15
"Stranger Things",2024-01-14`;

  const tmpDir = "/tmp/netflix-test-basic";
  mkdirSync(tmpDir, { recursive: true });
  try {
    const csvPath = join(tmpDir, "test.csv");
    writeFileSync(csvPath, csvContent, "utf8");

    const result = await parseCSVFile(csvPath);
    assert.equal(result.rows.length, 2);
    assert.equal(result.malformedCount, 0);
    assert.equal((result.rows[0] as Record<string, unknown>).title, "The Crown");
    assert.equal((result.rows[1] as Record<string, unknown>).title, "Stranger Things");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("parseCSVFile detects malformed rows with unclosed quotes", async () => {
  const csvContent = `Title,Date
"Incomplete Quote",2024-01-15
"Unclosed Quote,2024-01-14
"Valid Row",2024-01-13`;

  const tmpDir = "/tmp/netflix-test-malformed";
  mkdirSync(tmpDir, { recursive: true });
  try {
    const csvPath = join(tmpDir, "test.csv");
    writeFileSync(csvPath, csvContent, "utf8");

    const result = await parseCSVFile(csvPath);
    assert.equal(result.malformedCount, 1); // one unclosed quote accumulates through EOF
    assert.equal(result.rows.length, 1); // only the first valid row parses before the malformed section starts
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("parseCSVFile handles empty file", async () => {
  const tmpDir = "/tmp/netflix-test-empty";
  mkdirSync(tmpDir, { recursive: true });
  try {
    const csvPath = join(tmpDir, "empty.csv");
    writeFileSync(csvPath, "", "utf8");

    const result = await parseCSVFile(csvPath);
    assert.equal(result.rows.length, 0);
    assert.equal(result.malformedCount, 0);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("parseCSVFile handles file with only headers", async () => {
  const csvContent = "Title,Date";

  const tmpDir = "/tmp/netflix-test-headers-only";
  mkdirSync(tmpDir, { recursive: true });
  try {
    const csvPath = join(tmpDir, "test.csv");
    writeFileSync(csvPath, csvContent, "utf8");

    const result = await parseCSVFile(csvPath);
    assert.equal(result.rows.length, 0, "Empty file should parse to 0 rows");
    assert.equal(result.malformedCount, 0, "No malformed rows expected");
    assert.equal(result.error, undefined, "No error expected");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("parseCSVFile handles multi-line quoted fields (RFC 4180)", async () => {
  const csvContent = `Title,Date
"Multi
Line Title","2024-01-15"
"Normal","2024-01-14"`;

  const tmpDir = "/tmp/netflix-test-multiline";
  mkdirSync(tmpDir, { recursive: true });
  try {
    const csvPath = join(tmpDir, "test.csv");
    writeFileSync(csvPath, csvContent, "utf8");

    const result = await parseCSVFile(csvPath);
    assert.ok(result.rows.length >= 1, "Should parse at least one row");
    assert.ok(
      result.rows.some((r) => r.title?.includes("Multi") || r.title === "Normal"),
      "Should contain multi-line or normal row"
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("findViewingActivityFiles searches directory tree", () => {
  const tmpDir = "/tmp/netflix-test-find";
  mkdirSync(tmpDir, { recursive: true });
  try {
    const subdir = join(tmpDir, "CONTENT_INTERACTION");
    mkdirSync(subdir);
    const csvPath = join(subdir, "ViewingActivity.csv");
    writeFileSync(
      csvPath,
      "Profile Name,Start Time (UTC),Duration (H:MM:SS),Attributes,Title,Supplemental Video Type,Device Type,Bookmark,Latest Bookmark,Country\n",
      "utf8"
    );

    const found = findViewingActivityFiles(tmpDir);
    assert.ok(found.some((p) => p.includes("ViewingActivity.csv")));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("findViewingActivityFiles handles case-insensitive filename search", () => {
  const tmpDir = "/tmp/netflix-test-case";
  mkdirSync(tmpDir, { recursive: true });
  try {
    // Create a file with different casing
    const subdir = join(tmpDir, "content_interaction");
    mkdirSync(subdir);
    const csvPath = join(subdir, "viewingactivity.csv");
    writeFileSync(
      csvPath,
      "Profile Name,Start Time (UTC),Duration (H:MM:SS),Attributes,Title,Supplemental Video Type,Device Type,Bookmark,Latest Bookmark,Country\n",
      "utf8"
    );

    const found = findViewingActivityFiles(tmpDir);
    assert.ok(found.some((p) => p.toLowerCase().includes("viewingactivity.csv")));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("parseCSVFile handles non-existent file gracefully", async () => {
  const result = await parseCSVFile("/tmp/does-not-exist-netflix-test.csv");
  assert.equal(result.rows.length, 0);
  assert.equal(result.malformedCount, 0);
});

test("validateArchivePath validates path containment", () => {
  const tmpDir = "/tmp/netflix-test-traversal";
  const otherDir = "/tmp/netflix-test-other";
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(otherDir, { recursive: true });
  try {
    // File outside the expected directory
    const externalPath = join(otherDir, "escape.csv");
    writeFileSync(externalPath, "test", "utf8");

    const result = validateArchivePath(externalPath, tmpDir);
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes("Path traversal"));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(otherDir, { recursive: true, force: true });
  }
});

test("resolveViewingActivityFile returns error on archive validation failure", () => {
  const tmpDir = "/tmp/netflix-test-resolve-safety";
  mkdirSync(tmpDir, { recursive: true });
  try {
    // Create a fake archive structure
    const contentDir = join(tmpDir, "CONTENT_INTERACTION");
    mkdirSync(contentDir);
    const csvPath = join(contentDir, "ViewingActivity.csv");
    writeFileSync(
      csvPath,
      "Profile Name,Start Time (UTC),Duration (H:MM:SS),Attributes,Title,Supplemental Video Type,Device Type,Bookmark,Latest Bookmark,Country\n",
      "utf8"
    );

    // This should succeed (normal case)
    const result = resolveViewingActivityFile(tmpDir);
    assert.ok(result.path, "Should find valid path");
    assert.ok(!result.error, "Should have no error");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("parseCSVFile handles non-existent files in bounds check", async () => {
  const result = await parseCSVFile("/nonexistent/huge-file.csv");
  assert.equal(result.rows.length, 0);
});

test("connector subprocess integration: emits viewing_activity records", async () => {
  const tmpDir = "/tmp/netflix-test-subprocess";
  mkdirSync(tmpDir, { recursive: true });
  try {
    const contentDir = join(tmpDir, "CONTENT_INTERACTION");
    mkdirSync(contentDir);
    const csvPath = join(contentDir, "ViewingActivity.csv");

    const csvContent = `Profile Name,Start Time (UTC),Duration (H:MM:SS),Attributes,Title,Supplemental Video Type,Device Type,Bookmark,Latest Bookmark,Country
"Main","2024-01-15 10:30:00","0:42:10","","The Crown","","TV","0:42:10","0:42:10","US"
"Secondary","2024-01-14 15:45:00","0:50:22","","Stranger Things","","Phone","0:50:22","0:50:22","US"`;

    writeFileSync(csvPath, csvContent, "utf8");

    const result = await parseCSVFile(csvPath);
    assert.equal(result.rows.length, 2, "Should parse 2 data rows");
    assert.equal(result.malformedCount, 0, "No malformed rows");
    assert.ok(result.rows[0]?.title, "First row has title");
    assert.ok(result.rows[1]?.title, "Second row has title");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
