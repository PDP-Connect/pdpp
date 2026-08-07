#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Netflix Export Connector (v0.1.0) — file-based.
 *
 * Auth: none. User goes to https://netflix.com/account/getmyinfo, requests an archive
 * (up to 30 days to prepare), downloads the ZIP, extracts it into NETFLIX_EXPORT_DIR
 * (defaults to ~/.pdpp/imports/netflix_export/).
 *
 * Streams:
 *   - viewing_activity (CONTENT_INTERACTION/ViewingActivity.csv)
 *
 * Incremental: track latest timestamp per stream in state. Full snapshot export
 * diffed locally against prior state for new/deleted records.
 */

import { existsSync, readdirSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CollectContext } from "../../src/connector-runtime.ts";
import { runConnector } from "../../src/connector-runtime.ts";
import {
  buildViewingActivityRecord,
  extractViewingActivityArtifact,
  parseCSVContentForValidation,
  parseCSVFile,
  resolveViewingActivityFile,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { NetflixExportState, StreamTimestampState } from "./types.ts";

const UPLOADED_ARTIFACT_RE = /\.(csv|zip)$/i;

/**
 * Find an owner-uploaded artifact (raw ViewingActivity.csv or the official
 * Netflix export zip) written flat into the import dir by the manual-upload
 * route. Falls back to null so callers can try the legacy pre-extracted
 * CONTENT_INTERACTION/ViewingActivity.csv directory layout.
 */
function findUploadedArtifact(importDir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(importDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && UPLOADED_ARTIFACT_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return null;
  }
  return entries[0] ?? null;
}

interface LoadedRows {
  malformedCount: number;
  rows: Record<string, string | undefined>[];
}

interface LoadRowsSkip {
  message: string;
  reason: "archive_security_violation" | "csv_parse_error" | "records_not_found" | "import_exceeds_bounded_read_policy";
}

async function loadUploadedArtifactRows(
  canonicalImportDir: string,
  uploadedFileName: string
): Promise<LoadedRows | LoadRowsSkip> {
  const uploadedBytes = await readFile(join(canonicalImportDir, uploadedFileName)).catch((): Buffer => Buffer.alloc(0));
  const artifact = extractViewingActivityArtifact(uploadedFileName, uploadedBytes);
  if (!artifact.ok) {
    // entry_too_large / total_too_large / too_many_entries: a real (or
    // plausibly real) export that tripped the decompression-bomb policy —
    // distinct SKIP_RESULT reason so this never reads as "not a Netflix
    // export" when it actually is one, just too large to safely process.
    const isSizePolicyRejection =
      artifact.code === "entry_too_large" ||
      artifact.code === "total_too_large" ||
      artifact.code === "too_many_entries";
    return {
      reason: isSizePolicyRejection ? "import_exceeds_bounded_read_policy" : "csv_parse_error",
      message: isSizePolicyRejection
        ? `Uploaded file '${uploadedFileName}' exceeds the safe read policy: ${artifact.message}`
        : `Uploaded file '${uploadedFileName}' does not contain a recognizable ViewingActivity.csv (expected a raw CSV export or the official Netflix getmyinfo zip archive).`,
    };
  }
  const parseResult = parseCSVContentForValidation(artifact.csvText);
  if (parseResult.error) {
    return { reason: "csv_parse_error", message: parseResult.error };
  }
  return parseResult;
}

async function loadLegacyDirectoryRows(canonicalImportDir: string): Promise<LoadedRows | LoadRowsSkip> {
  const fileResult = resolveViewingActivityFile(canonicalImportDir);
  if (fileResult.error) {
    return { reason: "archive_security_violation", message: fileResult.error };
  }
  if (!fileResult.path) {
    return {
      reason: "records_not_found",
      message:
        "Netflix export ViewingActivity.csv was not found in the configured import directory (expected: CONTENT_INTERACTION/ViewingActivity.csv, or an uploaded ViewingActivity.csv/.zip)",
    };
  }
  const parseResult = await parseCSVFile(fileResult.path);
  if (parseResult.error) {
    return { reason: "csv_parse_error", message: parseResult.error };
  }
  return parseResult;
}

function isLoadRowsSkip(result: LoadedRows | LoadRowsSkip): result is LoadRowsSkip {
  return "reason" in result;
}

async function collectViewingActivity(
  ctx: CollectContext,
  importDir: string,
  streamState: StreamTimestampState | undefined
): Promise<void> {
  const { emit, emitRecord } = ctx;
  const stream = "viewing_activity";

  let canonicalImportDir: string;
  try {
    canonicalImportDir = realpathSync(importDir);
  } catch (err) {
    await emit({
      type: "SKIP_RESULT",
      stream,
      reason: "archive_security_violation",
      message: `Failed to resolve import directory: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  const uploadedFileName = findUploadedArtifact(canonicalImportDir);
  const loaded = uploadedFileName
    ? await loadUploadedArtifactRows(canonicalImportDir, uploadedFileName)
    : await loadLegacyDirectoryRows(canonicalImportDir);

  if (isLoadRowsSkip(loaded)) {
    await emit({ type: "SKIP_RESULT", stream, reason: loaded.reason, message: loaded.message });
    return;
  }

  const { rows, malformedCount } = loaded;

  if (malformedCount > 0) {
    await emit({
      type: "PROGRESS",
      stream,
      message: `Netflix phase=emit pass=emit stream=viewing_activity note=malformed_rows count=${malformedCount}`,
    });
  }

  const since = streamState?.last_timestamp;
  let latest: string | undefined = since;
  let skippedCount = 0;
  let emittedCount = 0;

  await emit({
    type: "PROGRESS",
    stream,
    message: `Netflix phase=emit pass=emit stream=viewing_activity total_items=${rows.length} malformed=${malformedCount}`,
  });

  for (const row of rows) {
    const rec = buildViewingActivityRecord(row);

    // Skip rows that couldn't be parsed
    if (!rec) {
      skippedCount += 1;
      continue;
    }

    // Skip rows before the since cursor
    if (since && rec.watched_at <= since) {
      skippedCount += 1;
      continue;
    }

    await emitRecord(stream, { ...rec });
    emittedCount += 1;

    if (!latest || rec.watched_at > latest) {
      latest = rec.watched_at;
    }

    if (emittedCount % 100 === 0) {
      await emit({
        type: "PROGRESS",
        stream,
        message: `Netflix phase=emit pass=emit stream=viewing_activity emitted=${emittedCount} skipped=${skippedCount}`,
      });
    }
  }

  // Update state with the latest timestamp seen
  await emit({ type: "STATE", stream, cursor: { last_timestamp: latest } });
}

runConnector({
  name: "netflix_export",
  validateRecord,
  async collect(ctx) {
    const importDir = process.env.NETFLIX_EXPORT_DIR || join(homedir(), ".pdpp", "imports", "netflix_export");

    if (!existsSync(importDir)) {
      await ctx.emit({
        type: "PROGRESS",
        message: `Netflix export import directory not found: ${importDir}. Set NETFLIX_EXPORT_DIR or extract the downloaded archive to ~/.pdpp/imports/netflix_export/`,
      });
      return;
    }

    const typedState = ctx.state as NetflixExportState | undefined;
    if (ctx.requested.has("viewing_activity")) {
      await collectViewingActivity(ctx, importDir, typedState?.viewing_activity);
    }
  },
});
