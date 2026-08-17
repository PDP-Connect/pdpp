// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { DetailCoverageMessage, StreamScope } from "../../src/connector-runtime.ts";
import { openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import { makeRecordingEmit, type RecordingEmit } from "../../src/test-harness.ts";
import { FINGERPRINT_EXCLUDE, runFilesStream, type StreamDeps } from "./index.ts";
import { buildFileRecord } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { FileRow } from "./types.ts";

interface FileFixture {
  data: Record<string, unknown>;
  filename: string | null;
  id: string;
  mode: string | null;
  url: string | null;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const tombstoneFixture = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__", "file-tombstone.json"), "utf8")
) as FileFixture;

function makeFileDb(rows: readonly FileRow[]): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE FILE (ID TEXT, FILENAME TEXT, URL TEXT, MODE TEXT, DATA TEXT, CHUNK_ID INTEGER)");
  const insert = db.prepare("INSERT INTO FILE (ID, FILENAME, URL, MODE, DATA, CHUNK_ID) VALUES (?, ?, ?, ?, ?, ?)");
  for (const [index, row] of rows.entries()) {
    insert.run(row.id, row.filename, row.url, row.mode, row.data, index + 1);
  }
  return db;
}

function makeDeps(db: DatabaseSync, recording: RecordingEmit): StreamDeps {
  return {
    db,
    emit: recording.emit,
    emitRecord: recording.emitRecord,
    emittedAt: "2026-08-11T00:00:00.000Z",
    fingerprintCursors: new Map([
      ["files", openFingerprintCursor({ fingerprints: {} }, { excludeFromFingerprint: FINGERPRINT_EXCLUDE.files })],
    ]),
    progress: () => Promise.resolve(),
    requested: new Map<string, StreamScope>([["files", { name: "files" }]]),
  };
}

function coverageFor(recording: RecordingEmit): DetailCoverageMessage | null {
  const message = recording.protocolMessages.find(
    (candidate): candidate is DetailCoverageMessage =>
      candidate.type === "DETAIL_COVERAGE" && candidate.stream === "files"
  );
  return message ?? null;
}

function tombstoneRows(): FileRow[] {
  return Array.from({ length: 6 }, (_, index) => {
    const id = `F000000000${String(index + 1)}`;
    return {
      id,
      filename: tombstoneFixture.filename,
      url: tombstoneFixture.url,
      mode: tombstoneFixture.mode,
      data: JSON.stringify({ ...tombstoneFixture.data, id }),
    };
  });
}

test("files: six exact Slack tombstones pass the production shape gate and count as covered", async () => {
  const normalRow: FileRow = {
    id: "F0999999999",
    filename: "report.pdf",
    url: "https://files.slack.com/report.pdf",
    mode: "stored",
    data: JSON.stringify({
      created: 1_700_000_000,
      external_type: null,
      filetype: "pdf",
      is_external: false,
      is_public: false,
      is_starred: false,
      mimetype: "application/pdf",
      mode: "stored",
      name: "report.pdf",
      original_h: null,
      original_w: null,
      permalink: "https://example.slack.com/files/F0999999999/report.pdf",
      pretty_type: "PDF Document",
      size: 1024,
      title: "Monthly Report",
      url_private: "https://files.slack.com/report.pdf",
      user: "U0987654321",
    }),
  };
  const rows = [...tombstoneRows(), normalRow];
  const db = makeFileDb(rows);
  const recording = makeRecordingEmit(validateRecord);

  try {
    await runFilesStream(makeDeps(db, recording));
  } finally {
    db.close();
  }

  assert.deepEqual(recording.skipped, [], "no tombstone or normal file may become a shape skip");
  const emitted = recording.emitted.filter((record) => record.stream === "files");
  assert.equal(emitted.length, 7, "all six tombstones and the normal file are retained");

  const tombstones = emitted.filter((record) => record.data.mode === "tombstone");
  assert.equal(tombstones.length, 6);
  assert.deepEqual(
    tombstones.map((record) => record.data.id).sort((a, b) => String(a).localeCompare(String(b))),
    ["F0000000001", "F0000000002", "F0000000003", "F0000000004", "F0000000005", "F0000000006"]
  );
  for (const tombstone of tombstones) {
    assert.equal(tombstone.data.created, 0, "provider sentinel remains provider metadata");
    assert.equal(tombstone.data.created_at, null, "unset provider time remains absent");
    assert.equal(tombstone.data.mode, "tombstone");
  }

  const normal = emitted.find((record) => record.data.id === normalRow.id);
  assert.ok(normal, "normal file must still emit");
  assert.deepEqual(normal.data, {
    created: 1_700_000_000,
    created_at: "2023-11-14T22:13:20.000Z",
    external_type: null,
    filetype: "pdf",
    id: "F0999999999",
    is_external: false,
    is_public: false,
    is_starred: false,
    mimetype: "application/pdf",
    mode: "stored",
    name: "report.pdf",
    original_h: null,
    original_w: null,
    permalink: "https://example.slack.com/files/F0999999999/report.pdf",
    pretty_type: "PDF Document",
    size: 1024,
    title: "Monthly Report",
    uploader_id: "U0987654321",
    url_private: "https://files.slack.com/report.pdf",
  });
  assert.deepEqual(normal.data, buildFileRecord(normalRow), "the normal transform remains unchanged");

  const coverage = coverageFor(recording);
  assert.ok(coverage, "files must declare self-coverage");
  assert.equal(coverage?.considered, 7);
  assert.equal(coverage?.covered, 7, "six tombstones plus the normal file are all accounted for");
});
