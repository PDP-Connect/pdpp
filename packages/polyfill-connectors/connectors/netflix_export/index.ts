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

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CollectContext } from "../../src/connector-runtime.ts";
import { runConnector } from "../../src/connector-runtime.ts";
import { buildViewingActivityRecord, parseCSVFile, resolveViewingActivityFile } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { NetflixExportState, StreamTimestampState } from "./types.ts";

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

  const fileResult = resolveViewingActivityFile(canonicalImportDir);
  if (fileResult.error) {
    await emit({
      type: "SKIP_RESULT",
      stream,
      reason: "archive_security_violation",
      message: fileResult.error,
    });
    return;
  }

  if (!fileResult.path) {
    await emit({
      type: "SKIP_RESULT",
      stream,
      reason: "records_not_found",
      message:
        "Netflix export ViewingActivity.csv was not found in the configured import directory (expected: CONTENT_INTERACTION/ViewingActivity.csv)",
    });
    return;
  }

  const parseResult = await parseCSVFile(fileResult.path);
  if (parseResult.error) {
    await emit({
      type: "SKIP_RESULT",
      stream,
      reason: "csv_parse_error",
      message: parseResult.error,
    });
    return;
  }

  const { rows, malformedCount } = parseResult;

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
