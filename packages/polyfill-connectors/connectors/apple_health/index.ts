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
import { createInterface } from "node:readline";
import type {
  EmittedMessage,
  RecordData,
  StreamScope,
} from "../../src/connector-runtime.ts";
import { stringifyForJsonl } from "../../src/safe-emit.ts";
import { resourceSet } from "../../src/scope-filters.ts";

interface StartMessage {
  scope?: { streams?: readonly StreamScope[] };
  state?: {
    records?: { last_start_date?: string };
    workouts?: { last_start_date?: string };
  };
  type: string;
}

type AppleHealthAttrs = Record<string, string | undefined>;

interface StreamParseArgs {
  onProgress: (recordCount: number, workoutCount: number) => void;
  onRecord: (attrs: AppleHealthAttrs) => void;
  onWorkout: (attrs: AppleHealthAttrs) => void;
  path: string;
}

const rl = createInterface({ input: process.stdin, terminal: false });
const emit = (m: EmittedMessage): boolean =>
  process.stdout.write(stringifyForJsonl(m));
const flushAndExit = (code: number): void => {
  if (process.stdout.writableLength > 0) {
    process.stdout.once("drain", () => process.exit(code));
    setTimeout(() => process.exit(code), 3000).unref();
  } else {
    process.exit(code);
  }
};
const fail = (m: string, r = false): void => {
  emit({
    type: "DONE",
    status: "failed",
    records_emitted: 0,
    error: { message: m, retryable: r },
  });
  flushAndExit(1);
};
const nowIso = (): string => new Date().toISOString();
const hashId = (s: string): string =>
  createHash("sha256").update(s).digest("hex").slice(0, 24);

function parseAttrs(tag: string): AppleHealthAttrs {
  const attrs: AppleHealthAttrs = {};
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) {
    const key = m[1];
    if (key) {
      attrs[key] = m[2];
    }
  }
  return attrs;
}

function healthTypeShort(t: string | undefined): string | null {
  if (!t) {
    return null;
  }
  return t.replace(
    /^HKQuantityTypeIdentifier|^HKCategoryTypeIdentifier|^HKDataType/,
    ""
  );
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

function streamParse({
  path,
  onRecord,
  onWorkout,
  onProgress,
}: StreamParseArgs): Promise<void> {
  let buf = "";
  const stream = createReadStream(path, {
    encoding: "utf8",
    highWaterMark: 1 << 16,
  });
  let recordCount = 0;
  let workoutCount = 0;
  return new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: string | Buffer) => {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      // Process self-closing Record and Workout tags.
      const re = /<(Record|Workout)\s+([^/>]+)\/?>/g;
      let m: RegExpExecArray | null;
      let lastEnd = 0;
      while ((m = re.exec(buf)) !== null) {
        const tag = m[1];
        const attrs = parseAttrs(m[2] ?? "");
        if (tag === "Record") {
          onRecord(attrs);
          recordCount++;
        } else if (tag === "Workout") {
          onWorkout(attrs);
          workoutCount++;
        }
        lastEnd = re.lastIndex;
      }
      buf = buf.slice(lastEnd);
      if (
        recordCount + workoutCount > 0 &&
        (recordCount + workoutCount) % 10_000 === 0
      ) {
        onProgress(recordCount, workoutCount);
      }
    });
    stream.on("end", () => {
      onProgress(recordCount, workoutCount);
      resolve();
    });
    stream.on("error", reject);
  });
}

async function main(): Promise<void> {
  const startMsg = await new Promise<StartMessage>((r, j) =>
    rl.once("line", (l) => {
      try {
        r(JSON.parse(l) as StartMessage);
      } catch (e) {
        j(e);
      }
    })
  );
  if (startMsg.type !== "START") {
    return fail("Expected START");
  }

  const requested = new Map<string, StreamScope>(
    (startMsg.scope?.streams || []).map((s) => [s.name, s])
  );
  if (!requested.size) {
    return fail("START.scope.streams is required");
  }

  const dir =
    process.env.APPLE_HEALTH_EXPORT_DIR ||
    join(homedir(), ".pdpp/imports/apple_health");
  const path = existsSync(join(dir, "export.xml"))
    ? join(dir, "export.xml")
    : existsSync(join(dir, "apple_health_export", "export.xml"))
      ? join(dir, "apple_health_export", "export.xml")
      : null;
  if (!path) {
    emit({
      type: "SKIP_RESULT",
      stream: "records",
      reason: "export_not_found",
      message: `no export.xml in ${dir}/ or ${dir}/apple_health_export/`,
    });
    emit({ type: "DONE", status: "succeeded", records_emitted: 0 });
    process.exit(0);
  }

  const state = startMsg.state || {};
  const emittedAt = nowIso();
  let total = 0;
  const _resFilters = new Map<string, ReadonlySet<string> | null>(
    (startMsg.scope?.streams || []).map((sr) => [sr.name, resourceSet(sr)])
  );
  const emitRecord = (s: string, d: RecordData): void => {
    if (d.id == null) {
      return;
    }
    const _rs = _resFilters.get(s);
    if (_rs && !_rs.has(String(d.id))) {
      return;
    }
    emit({
      type: "RECORD",
      stream: s,
      key: d.id,
      data: d,
      emitted_at: emittedAt,
    });
    total++;
  };

  const sinceRec = state.records?.last_start_date;
  const sinceWork = state.workouts?.last_start_date;
  let latestRec: string | undefined = sinceRec;
  let latestWork: string | undefined = sinceWork;

  emit({ type: "PROGRESS", message: `Streaming ${path}` });

  await streamParse({
    path,
    onProgress: (rc, wc) =>
      emit({
        type: "PROGRESS",
        message: `Parsed ${rc} records, ${wc} workouts`,
      }),
    onRecord: (attrs) => {
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
      emitRecord("records", {
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
    onWorkout: (attrs) => {
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
      emitRecord("workouts", {
        id,
        workout_activity_type: attrs.workoutActivityType
          ? attrs.workoutActivityType.replace(/^HKWorkoutActivityType/, "")
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
    emit({
      type: "STATE",
      stream: "records",
      cursor: { last_start_date: latestRec },
    });
  }
  if (requested.has("workouts")) {
    emit({
      type: "STATE",
      stream: "workouts",
      cursor: { last_start_date: latestWork },
    });
  }

  emit({ type: "DONE", status: "succeeded", records_emitted: total });
  flushAndExit(0);
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  emit({
    type: "DONE",
    status: "failed",
    records_emitted: 0,
    error: { message: msg, retryable: false },
  });
  flushAndExit(1);
});
