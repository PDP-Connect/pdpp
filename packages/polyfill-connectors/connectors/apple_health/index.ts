#!/usr/bin/env node

/**
 * PDPP Apple Health Connector (v0.1.0)
 *
 * Auth: none (file-based). User goes to iPhone → Health app → profile →
 * "Export All Health Data", AirDrop/email the .zip to this machine, and
 * extracts export.xml into APPLE_HEALTH_EXPORT_DIR (defaults
 * ~/.pdpp/imports/apple_health/). This connector streams the XML, so even
 * 500MB exports parse incrementally with low memory.
 */

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runConnector } from "../../src/connector-runtime.ts";

type AppleHealthAttrs = Record<string, string | undefined>;

interface StreamParseArgs {
  onProgress: (recordCount: number, workoutCount: number) => Promise<void>;
  onRecord: (attrs: AppleHealthAttrs) => Promise<void>;
  onWorkout: (attrs: AppleHealthAttrs) => Promise<void>;
  path: string;
}

interface AppleHealthState {
  last_start_date?: string;
}

// Streaming buffer size — 64 KB balances memory and syscalls on large exports.
const READ_BUFFER_SIZE = 1 << 16;
// Emit a PROGRESS every N events so operators see progress on multi-GB exports.
const PROGRESS_INTERVAL_EVENTS = 10_000;
// Module-level regexes (Biome useTopLevelRegex).
const APPLE_HEALTH_TAG_RE = /<(Record|Workout)\s+([^/>]+)\/?>/g;
const APPLE_HEALTH_ATTR_RE = /(\w+)="([^"]*)"/g;
const APPLE_HEALTH_TYPE_PREFIX_RE =
  /^HKQuantityTypeIdentifier|^HKCategoryTypeIdentifier|^HKDataType/;
const APPLE_HEALTH_WORKOUT_PREFIX_RE = /^HKWorkoutActivityType/;

const hashId = (s: string): string =>
  createHash("sha256").update(s).digest("hex").slice(0, 24);

function parseAttrs(tag: string): AppleHealthAttrs {
  const attrs: AppleHealthAttrs = {};
  let m: RegExpExecArray | null = APPLE_HEALTH_ATTR_RE.exec(tag);
  while (m !== null) {
    const key = m[1];
    if (key) {
      attrs[key] = m[2];
    }
    m = APPLE_HEALTH_ATTR_RE.exec(tag);
  }
  return attrs;
}

function healthTypeShort(t: string | undefined): string | null {
  if (!t) {
    return null;
  }
  return t.replace(APPLE_HEALTH_TYPE_PREFIX_RE, "");
}

function isoDate(v: string | undefined): string | null {
  if (!v) {
    return null;
  }
  // Apple Health dates look like "2024-06-05 13:45:22 -0700"
  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) {
    return d.toISOString();
  }
  return null;
}

async function streamParse({
  path,
  onRecord,
  onWorkout,
  onProgress,
}: StreamParseArgs): Promise<void> {
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
      const tag = m[1];
      const attrs = parseAttrs(m[2] ?? "");
      if (tag === "Record") {
        await onRecord(attrs);
        recordCount++;
      } else if (tag === "Workout") {
        await onWorkout(attrs);
        workoutCount++;
      }
      lastEnd = re.lastIndex;
      m = re.exec(buf);
    }
    buf = buf.slice(lastEnd);
    if (
      recordCount + workoutCount > 0 &&
      (recordCount + workoutCount) % PROGRESS_INTERVAL_EVENTS === 0
    ) {
      await onProgress(recordCount, workoutCount);
    }
  }
  await onProgress(recordCount, workoutCount);
}

runConnector({
  name: "apple_health",
  async collect({ state, requested, emit, emitRecord, progress }) {
    const dir =
      process.env.APPLE_HEALTH_EXPORT_DIR ||
      join(homedir(), ".pdpp/imports/apple_health");
    const path = existsSync(join(dir, "export.xml"))
      ? join(dir, "export.xml")
      : existsSync(join(dir, "apple_health_export", "export.xml"))
        ? join(dir, "apple_health_export", "export.xml")
        : null;
    if (!path) {
      await emit({
        type: "SKIP_RESULT",
        stream: "records",
        reason: "export_not_found",
        message: `no export.xml in ${dir}/ or ${dir}/apple_health_export/`,
      });
      return;
    }

    const recordsState = (state.records ?? {}) as AppleHealthState;
    const workoutsState = (state.workouts ?? {}) as AppleHealthState;
    const sinceRec = recordsState.last_start_date;
    const sinceWork = workoutsState.last_start_date;
    let latestRec: string | undefined = sinceRec;
    let latestWork: string | undefined = sinceWork;

    await progress(`Streaming ${path}`);

    await streamParse({
      path,
      onProgress: (rc, wc): Promise<void> =>
        progress(`Parsed ${rc} records, ${wc} workouts`),
      onRecord: async (attrs): Promise<void> => {
        if (!requested.has("records")) {
          return;
        }
        const startDate = isoDate(attrs.startDate);
        if (!startDate) {
          return;
        }
        if (sinceRec && startDate <= sinceRec) {
          return;
        }
        const type = healthTypeShort(attrs.type) || attrs.type || "Unknown";
        const value = attrs.value == null ? null : Number(attrs.value);
        const id = hashId(
          `${type}|${attrs.sourceName || ""}|${startDate}|${attrs.value || ""}`
        );
        await emitRecord("records", {
          id,
          type,
          source_name: attrs.sourceName || null,
          source_version: attrs.sourceVersion || null,
          unit: attrs.unit || null,
          value: value != null && Number.isFinite(value) ? value : null,
          value_raw:
            (value == null || !Number.isFinite(value)) && attrs.value
              ? attrs.value
              : null,
          start_date: startDate,
          end_date: isoDate(attrs.endDate),
        });
        if (!latestRec || startDate > latestRec) {
          latestRec = startDate;
        }
      },
      onWorkout: async (attrs): Promise<void> => {
        if (!requested.has("workouts")) {
          return;
        }
        const startDate = isoDate(attrs.startDate);
        if (!startDate) {
          return;
        }
        if (sinceWork && startDate <= sinceWork) {
          return;
        }
        const id = hashId(
          `${attrs.workoutActivityType || ""}|${attrs.sourceName || ""}|${startDate}`
        );
        await emitRecord("workouts", {
          id,
          workout_activity_type: attrs.workoutActivityType
            ? attrs.workoutActivityType.replace(
                APPLE_HEALTH_WORKOUT_PREFIX_RE,
                ""
              )
            : null,
          duration_minutes: attrs.duration ? Number(attrs.duration) : null,
          total_energy_burned_kcal: attrs.totalEnergyBurned
            ? Number(attrs.totalEnergyBurned)
            : null,
          total_distance_km: attrs.totalDistance
            ? Number(attrs.totalDistance)
            : null,
          source_name: attrs.sourceName || null,
          start_date: startDate,
          end_date: isoDate(attrs.endDate),
        });
        if (!latestWork || startDate > latestWork) {
          latestWork = startDate;
        }
      },
    });

    if (requested.has("records")) {
      await emit({
        type: "STATE",
        stream: "records",
        cursor: { last_start_date: latestRec },
      });
    }
    if (requested.has("workouts")) {
      await emit({
        type: "STATE",
        stream: "workouts",
        cursor: { last_start_date: latestWork },
      });
    }
  },
});
