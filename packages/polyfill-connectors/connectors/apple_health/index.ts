#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Apple Health Connector (v0.1.0)
 *
 * Auth: none (file-based). User goes to iPhone → Health app → profile →
 * "Export All Health Data", then either uploads the resulting .zip (or its
 * extracted export.xml) through the console's manual-upload flow, or
 * places it directly under APPLE_HEALTH_EXPORT_DIR (defaults
 * ~/.pdpp/imports/apple_health/) for local/developer use. This connector
 * streams the XML, so even multi-GB exports parse incrementally with low
 * memory — extraction of an uploaded .zip is likewise streamed straight to
 * disk (see parsers.ts's resolveUploadedExportPath), never buffered whole.
 */

import { createReadStream, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runConnector, type StreamScope } from "../../src/connector-runtime.ts";
import {
  APPLE_HEALTH_TAG_RE,
  advanceCursor,
  buildHealthRecord,
  buildWorkoutRecord,
  findUploadedExportCandidate,
  isBeforeCursor,
  parseAttrs,
  resolveUploadedExportPath,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { AppleHealthAttrs, AppleHealthState, StreamParseArgs } from "./types.ts";

// Streaming buffer size — 64 KB balances memory and syscalls on large exports.
const READ_BUFFER_SIZE = 65_536;
// Emit a PROGRESS every N events so operators see progress on multi-GB exports.
const PROGRESS_INTERVAL_EVENTS = 10_000;

export type ResolveExportPathResult =
  | { readonly kind: "found"; readonly path: string }
  | { readonly kind: "not_found" }
  | { readonly kind: "extraction_failed"; readonly message: string };

/**
 * Resolve the export.xml to stream-parse this run, trying (in order):
 *   1. The legacy pre-extracted developer layout (`<dir>/export.xml` or
 *      `<dir>/apple_health_export/export.xml`) — unchanged from v0.1.0, so
 *      an existing developer setup keeps working exactly as before.
 *   2. An owner-uploaded artifact via the manual-upload console flow: a
 *      bare `.xml` used directly, or a `.zip` extracted once (streamed,
 *      cached — see resolveUploadedExportPath) to a sibling file.
 */
async function resolveExportPath(dir: string): Promise<ResolveExportPathResult> {
  const direct = join(dir, "export.xml");
  if (existsSync(direct)) {
    return { kind: "found", path: direct };
  }
  const nested = join(dir, "apple_health_export", "export.xml");
  if (existsSync(nested)) {
    return { kind: "found", path: nested };
  }

  const candidate = findUploadedExportCandidate(dir);
  if (!candidate) {
    return { kind: "not_found" };
  }
  const outcome = await resolveUploadedExportPath(candidate);
  if (outcome.kind === "resolved") {
    return { kind: "found", path: outcome.resolved.path };
  }
  if (outcome.kind === "extraction_failed") {
    return { kind: "extraction_failed", message: outcome.message };
  }
  return { kind: "not_found" };
}

async function streamParse({ path, onRecord, onWorkout, onProgress }: StreamParseArgs): Promise<void> {
  // Async iteration on a Readable pauses the stream between awaits, so we can
  // await async handlers without losing chunks. Older sync-callback form got
  // away with unawaited promises; we cannot.
  const stream = createReadStream(path, {
    encoding: "utf8",
    highWaterMark: READ_BUFFER_SIZE,
  });
  let buf = "";
  let recordCount = 0;
  let workoutCount = 0;
  for await (const chunk of stream as AsyncIterable<string | Buffer>) {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    // Process self-closing Record and Workout tags.
    const re = new RegExp(APPLE_HEALTH_TAG_RE.source, "g");
    let m: RegExpExecArray | null = re.exec(buf);
    let lastEnd = 0;
    while (m !== null) {
      const [, tag] = m;
      const attrs = parseAttrs(m[2] ?? "");
      if (tag === "Record") {
        await onRecord(attrs);
        recordCount += 1;
      } else if (tag === "Workout") {
        await onWorkout(attrs);
        workoutCount += 1;
      }
      lastEnd = re.lastIndex;
      m = re.exec(buf);
    }
    buf = buf.slice(lastEnd);
    if (recordCount + workoutCount > 0 && (recordCount + workoutCount) % PROGRESS_INTERVAL_EVENTS === 0) {
      await onProgress(recordCount, workoutCount);
    }
  }
  await onProgress(recordCount, workoutCount);
}

/** Per-stream cursor state mutated across callbacks. */
interface CursorRef {
  latest: string | undefined;
  since: string | undefined;
}

function handleRecord(
  attrs: AppleHealthAttrs,
  ref: CursorRef,
  requested: ReadonlyMap<string, StreamScope>,
  emitRecord: (stream: string, rec: Record<string, unknown>) => Promise<void>
): Promise<void> {
  if (!requested.has("records")) {
    return Promise.resolve();
  }
  const rec = buildHealthRecord(attrs);
  if (!rec) {
    return Promise.resolve();
  }
  if (isBeforeCursor(rec.start_date, ref.since)) {
    return Promise.resolve();
  }
  ref.latest = advanceCursor(ref.latest, rec.start_date);
  return emitRecord("records", { ...rec });
}

function handleWorkout(
  attrs: AppleHealthAttrs,
  ref: CursorRef,
  requested: ReadonlyMap<string, StreamScope>,
  emitRecord: (stream: string, rec: Record<string, unknown>) => Promise<void>
): Promise<void> {
  if (!requested.has("workouts")) {
    return Promise.resolve();
  }
  const rec = buildWorkoutRecord(attrs);
  if (!rec) {
    return Promise.resolve();
  }
  if (isBeforeCursor(rec.start_date, ref.since)) {
    return Promise.resolve();
  }
  ref.latest = advanceCursor(ref.latest, rec.start_date);
  return emitRecord("workouts", { ...rec });
}

runConnector({
  name: "apple_health",
  validateRecord,
  async collect({ state, requested, emit, emitRecord, progress }) {
    const dir = process.env.APPLE_HEALTH_EXPORT_DIR || join(homedir(), ".pdpp/imports/apple_health");
    const resolved = await resolveExportPath(dir);
    if (resolved.kind === "extraction_failed") {
      await emit({
        type: "SKIP_RESULT",
        stream: "records",
        reason: "export_extraction_failed",
        message: resolved.message,
      });
      return;
    }
    if (resolved.kind === "not_found") {
      await emit({
        type: "SKIP_RESULT",
        stream: "records",
        reason: "export_not_found",
        message: "Apple Health export data was not found in the configured import directory",
      });
      return;
    }
    const { path } = resolved;

    const recordsState = (state.records ?? {}) as AppleHealthState;
    const workoutsState = (state.workouts ?? {}) as AppleHealthState;
    const recordRef: CursorRef = {
      since: recordsState.last_start_date,
      latest: recordsState.last_start_date,
    };
    const workoutRef: CursorRef = {
      since: workoutsState.last_start_date,
      latest: workoutsState.last_start_date,
    };

    await progress("Apple Health phase=emit pass=emit starting stream parse");

    await streamParse({
      path,
      onProgress: (rc, wc): Promise<void> =>
        progress(`Apple Health phase=emit pass=emit records_parsed=${rc} workouts_parsed=${wc}`),
      onRecord: (attrs): Promise<void> => handleRecord(attrs, recordRef, requested, emitRecord),
      onWorkout: (attrs): Promise<void> => handleWorkout(attrs, workoutRef, requested, emitRecord),
    });

    if (requested.has("records")) {
      await emit({
        type: "STATE",
        stream: "records",
        cursor: { last_start_date: recordRef.latest },
      });
    }
    if (requested.has("workouts")) {
      await emit({
        type: "STATE",
        stream: "workouts",
        cursor: { last_start_date: workoutRef.latest },
      });
    }
  },
});
