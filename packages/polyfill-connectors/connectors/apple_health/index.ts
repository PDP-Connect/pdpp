#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Apple Health Connector (v0.1.0)
 *
 * Auth: none (file-based). User goes to iPhone → Health app → profile →
 * "Export All Health Data", AirDrop/email the .zip to this machine, and
 * extracts export.xml into APPLE_HEALTH_EXPORT_DIR (defaults
 * ~/.pdpp/imports/apple_health/). This connector streams the XML, so even
 * 500MB exports parse incrementally with low memory.
 */

import { createReadStream, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runConnector, type StreamScope } from "../../src/connector-runtime.ts";
import {
  APPLE_HEALTH_TAG_RE,
  advanceCursor,
  buildHealthRecord,
  buildWorkoutEvent,
  buildWorkoutRecord,
  isBeforeCursor,
  newGapCounts,
  parseAttrs,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type {
  AppleHealthAttrs,
  AppleHealthElement,
  AppleHealthGapCounts,
  AppleHealthState,
  StreamParseArgs,
} from "./types.ts";

// Streaming buffer size — 64 KB balances memory and syscalls on large exports.
const READ_BUFFER_SIZE = 65_536;
// Emit a PROGRESS every N events so operators see progress on multi-GB exports.
const PROGRESS_INTERVAL_EVENTS = 10_000;

function resolveExportPath(dir: string): string | null {
  const direct = join(dir, "export.xml");
  if (existsSync(direct)) {
    return direct;
  }
  const nested = join(dir, "apple_health_export", "export.xml");
  if (existsSync(nested)) {
    return nested;
  }
  return null;
}

function newElement(tag: "Record" | "Workout", attrs: AppleHealthAttrs): AppleHealthElement {
  return { tag, attrs, metadata: [], workoutEvents: [], workoutStatistics: [] };
}

/** Attach a nested MetadataEntry/WorkoutEvent/WorkoutStatistics child to whichever Record/Workout is currently open. */
function attachChild(current: AppleHealthElement, openTag: string, attrString: string): void {
  const attrs = parseAttrs(attrString);
  if (openTag === "MetadataEntry" && attrs.key !== undefined) {
    current.metadata.push({ key: attrs.key, value: attrs.value ?? "" });
  } else if (openTag === "WorkoutEvent") {
    current.workoutEvents.push(buildWorkoutEvent(attrs));
  } else if (openTag === "WorkoutStatistics") {
    current.workoutStatistics.push(attrs);
  }
}

/** Mutable scan state threaded through one streamParse pass. */
interface ScanState {
  current: AppleHealthElement | null;
  recordCount: number;
  workoutCount: number;
}

/** Close out `state.current` on its matching `</Record>`/`</Workout>`, emitting the assembled element. */
async function handleCloseTag(
  closeTag: "Record" | "Workout",
  state: ScanState,
  onRecord: StreamParseArgs["onRecord"],
  onWorkout: StreamParseArgs["onWorkout"]
): Promise<void> {
  if (!(state.current && state.current.tag === closeTag)) {
    return;
  }
  if (closeTag === "Record") {
    await onRecord(state.current);
    state.recordCount += 1;
  } else {
    await onWorkout(state.current);
    state.workoutCount += 1;
  }
  state.current = null;
}

/** Handle a Record/Workout open tag: emit immediately if self-closing, otherwise open a span for nested children. */
async function handleTopLevelOpenTag(
  openTag: "Record" | "Workout",
  attrs: AppleHealthAttrs,
  selfClose: string,
  state: ScanState,
  onRecord: StreamParseArgs["onRecord"],
  onWorkout: StreamParseArgs["onWorkout"]
): Promise<void> {
  if (selfClose !== "/") {
    // Non-self-closing: children (MetadataEntry/WorkoutEvent/
    // WorkoutStatistics) arrive before the matching close tag.
    state.current = newElement(openTag, attrs);
    return;
  }
  if (openTag === "Record") {
    await onRecord(newElement("Record", attrs));
    state.recordCount += 1;
  } else {
    await onWorkout(newElement("Workout", attrs));
    state.workoutCount += 1;
  }
}

/** Handle one regex match against the running scan state, emitting a completed Record/Workout when its span closes. */
async function handleTagMatch(
  m: RegExpExecArray,
  state: ScanState,
  onRecord: StreamParseArgs["onRecord"],
  onWorkout: StreamParseArgs["onWorkout"]
): Promise<void> {
  const [, openTag, attrString, selfClose, closeTag] = m;
  if (closeTag === "Record" || closeTag === "Workout") {
    await handleCloseTag(closeTag, state, onRecord, onWorkout);
    return;
  }
  if (openTag === "Record" || openTag === "Workout") {
    await handleTopLevelOpenTag(openTag, parseAttrs(attrString ?? ""), selfClose ?? "", state, onRecord, onWorkout);
    return;
  }
  if (state.current && openTag) {
    attachChild(state.current, openTag, attrString ?? "");
  }
}

/**
 * Streaming scanner: walks Record/Workout open tags, their nested
 * MetadataEntry/WorkoutEvent/WorkoutStatistics children, and the matching
 * close tags, in document order across chunk boundaries. Because the export
 * is scanned strictly in order, "currently open Record/Workout" is enough
 * context to attribute a nested child to its parent without building a DOM —
 * this keeps the parser streaming-safe on a 500MB export. Apple Health does
 * not nest Record inside Workout or vice versa, so a single current-element
 * slot (not a stack) is sufficient.
 */
async function streamParse({ path, onRecord, onWorkout, onProgress }: StreamParseArgs): Promise<void> {
  // Async iteration on a Readable pauses the stream between awaits, so we can
  // await async handlers without losing chunks. Older sync-callback form got
  // away with unawaited promises; we cannot.
  const stream = createReadStream(path, {
    encoding: "utf8",
    highWaterMark: READ_BUFFER_SIZE,
  });
  let buf = "";
  const state: ScanState = { current: null, recordCount: 0, workoutCount: 0 };
  for await (const chunk of stream as AsyncIterable<string | Buffer>) {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const re = new RegExp(APPLE_HEALTH_TAG_RE.source, "g");
    let m: RegExpExecArray | null = re.exec(buf);
    let lastEnd = 0;
    while (m !== null) {
      await handleTagMatch(m, state, onRecord, onWorkout);
      lastEnd = re.lastIndex;
      m = re.exec(buf);
    }
    buf = buf.slice(lastEnd);
    const total = state.recordCount + state.workoutCount;
    if (total > 0 && total % PROGRESS_INTERVAL_EVENTS === 0) {
      await onProgress(state.recordCount, state.workoutCount);
    }
  }
  await onProgress(state.recordCount, state.workoutCount);
}

/** Per-stream cursor state mutated across callbacks. */
interface CursorRef {
  latest: string | undefined;
  since: string | undefined;
}

function handleRecord(
  el: AppleHealthElement,
  ref: CursorRef,
  gaps: AppleHealthGapCounts,
  requested: ReadonlyMap<string, StreamScope>,
  emitRecord: (stream: string, rec: Record<string, unknown>) => Promise<void>
): Promise<void> {
  if (!requested.has("records")) {
    return Promise.resolve();
  }
  const rec = buildHealthRecord(el, gaps);
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
  el: AppleHealthElement,
  ref: CursorRef,
  gaps: AppleHealthGapCounts,
  requested: ReadonlyMap<string, StreamScope>,
  emitRecord: (stream: string, rec: Record<string, unknown>) => Promise<void>
): Promise<void> {
  if (!requested.has("workouts")) {
    return Promise.resolve();
  }
  const rec = buildWorkoutRecord(el, gaps);
  if (!rec) {
    return Promise.resolve();
  }
  if (isBeforeCursor(rec.start_date, ref.since)) {
    return Promise.resolve();
  }
  ref.latest = advanceCursor(ref.latest, rec.start_date);
  return emitRecord("workouts", { ...rec });
}

/** Render the gap tally as a single human-readable progress line. Never silent — an empty tally still reports "no gaps". */
function formatGapSummary(gaps: AppleHealthGapCounts): string {
  const parts: string[] = [];
  if (gaps.recordsMissingStartDate > 0) {
    parts.push(`records_dropped_missing_start_date=${gaps.recordsMissingStartDate}`);
  }
  if (gaps.workoutsMissingStartDate > 0) {
    parts.push(`workouts_dropped_missing_start_date=${gaps.workoutsMissingStartDate}`);
  }
  if (gaps.unrecognizedRecordTypes.size > 0) {
    const byType = [...gaps.unrecognizedRecordTypes.entries()].map(([type, count]) => `${type}:${count}`).join(",");
    parts.push(`unrecognized_record_types=${byType}`);
  }
  if (parts.length === 0) {
    return "Apple Health phase=emit pass=emit gaps=none";
  }
  return `Apple Health phase=emit pass=emit gaps: ${parts.join(" ")}`;
}

runConnector({
  name: "apple_health",
  validateRecord,
  async collect({ state, requested, emit, emitRecord, progress }) {
    const dir = process.env.APPLE_HEALTH_EXPORT_DIR || join(homedir(), ".pdpp/imports/apple_health");
    const path = resolveExportPath(dir);
    if (!path) {
      await emit({
        type: "SKIP_RESULT",
        stream: "records",
        reason: "export_not_found",
        message: "Apple Health export data was not found in the configured import directory",
      });
      return;
    }

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
    const gaps = newGapCounts();

    await progress("Apple Health phase=emit pass=emit starting stream parse");

    await streamParse({
      path,
      onProgress: (rc, wc): Promise<void> =>
        progress(`Apple Health phase=emit pass=emit records_parsed=${rc} workouts_parsed=${wc}`),
      onRecord: (el): Promise<void> => handleRecord(el, recordRef, gaps, requested, emitRecord),
      onWorkout: (el): Promise<void> => handleWorkout(el, workoutRef, gaps, requested, emitRecord),
    });

    await progress(formatGapSummary(gaps));

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
