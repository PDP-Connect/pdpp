// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proves apple_photos emits an honest coverage_diagnostics row for its one
 * known local store (export_dir) on every run — including when the export
 * directory is missing or empty — so the connection-health rollup never
 * gets stuck at coverage_unknown for a genuinely-drained local collector.
 * See index.ts's COVERAGE_DIAGNOSTICS header comment and
 * src/local-source-inventory.ts's buildLocalSourceInventory (the shared
 * emitter this connector uses, same as claude_code/codex).
 */

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";
import { buildEmptyExportDirFixture, buildExportDirFixture } from "./fixtures.ts";

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
const ENTRYPOINT = join(PACKAGE_ROOT, "connectors", "apple_photos", "index.ts");

function records(messages: readonly EmittedMessage[], stream: string): Record<string, unknown>[] {
  return messages
    .filter((m): m is Extract<EmittedMessage, { type: "RECORD" }> => m.type === "RECORD")
    .filter((m) => m.stream === stream)
    .map((m) => m.data);
}

function runApplePhotos(exportDir: string, streams: string[]) {
  return runConnectorProtocolSubprocess({
    cwd: PACKAGE_ROOT,
    entrypoint: ENTRYPOINT,
    env: {
      APPLE_PHOTOS_EXPORT_DIR: exportDir,
      PDPP_OWNER_TOKEN: "",
      PDPP_RS_URL: "",
      RS_URL: "",
    },
    start: {
      scope: { streams: streams.map((name) => ({ name })) },
      state: {},
      type: "START",
    },
  });
}

test("coverage_diagnostics reports status=missing when the export directory does not exist", async () => {
  const nonexistentDir = join(process.cwd(), "does-not-exist-apple-photos-coverage");
  const result = await runApplePhotos(nonexistentDir, ["photos", "coverage_diagnostics"]);
  const coverage = records(result.messages, "coverage_diagnostics");
  assert.equal(coverage.length, 1);
  assert.equal(coverage[0]?.store, "export_dir");
  assert.equal(coverage[0]?.stream, "photos");
  assert.equal(coverage[0]?.status, "missing");
});

test("coverage_diagnostics reports status=collected when the export directory exists (even if empty)", async () => {
  const dir = buildEmptyExportDirFixture();
  try {
    const result = await runApplePhotos(dir, ["photos", "coverage_diagnostics"]);
    const coverage = records(result.messages, "coverage_diagnostics");
    assert.equal(coverage.length, 1);
    assert.equal(coverage[0]?.status, "collected");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("coverage_diagnostics is still emitted alongside real photo records on a healthy run", async () => {
  const dir = buildExportDirFixture([{ relPath: "IMG_0001.jpg", contents: Buffer.from("fake-jpeg") }]);
  try {
    const result = await runApplePhotos(dir, ["photos", "coverage_diagnostics"]);
    assert.equal(records(result.messages, "photos").length, 1);
    const coverage = records(result.messages, "coverage_diagnostics");
    assert.equal(coverage.length, 1);
    assert.equal(coverage[0]?.status, "collected");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("coverage_diagnostics is skipped (not emitted) when not requested", async () => {
  const dir = buildEmptyExportDirFixture();
  try {
    const result = await runApplePhotos(dir, ["photos"]);
    assert.equal(records(result.messages, "coverage_diagnostics").length, 0);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
