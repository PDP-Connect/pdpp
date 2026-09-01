// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure parsers for the Apple Health connector. Kept free of Node I/O so
// they can be unit-tested in isolation (see parsers.test.ts). The
// streaming XML reader and record emitter live in index.ts.
//
// The zip-extraction helpers below are the one exception: they need real
// filesystem access (a manual-upload export.xml can legitimately be
// hundreds of MB to multiple GB, so extraction must stream to disk, never
// buffer in memory — see streamZipEntryToFile's own doc comment). Kept here
// rather than index.ts so both index.ts (collect) and validation.ts
// (manual-upload preview) share exactly one extraction implementation.

import { createHash } from "node:crypto";
import { closeSync, createReadStream, type Dirent, existsSync, openSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { streamZipEntryToFile, type ZipReadPolicy } from "../../src/bounded-zip-archive.ts";
import type { AppleHealthAttrs, HealthRecordOut, WorkoutRecordOut } from "./types.ts";

// ─── Module-scoped regexes (Biome useTopLevelRegex) ────────────────────

export const APPLE_HEALTH_TAG_RE = /<(Record|Workout)\s+([^/>]+)\/?>/g;
const APPLE_HEALTH_ATTR_RE = /(\w+)="([^"]*)"/g;
const APPLE_HEALTH_TYPE_PREFIX_RE = /^HKQuantityTypeIdentifier|^HKCategoryTypeIdentifier|^HKDataType/;
const APPLE_HEALTH_WORKOUT_PREFIX_RE = /^HKWorkoutActivityType/;

// Record ID length (hex). 24 chars = 96 bits of entropy — safe for a user's
// personal health-event set.
const RECORD_ID_HASH_LENGTH = 24;

// ─── Small pure helpers ────────────────────────────────────────────────

export function hashId(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, RECORD_ID_HASH_LENGTH);
}

export function parseAttrs(tag: string): AppleHealthAttrs {
  const attrs: AppleHealthAttrs = {};
  const re = new RegExp(APPLE_HEALTH_ATTR_RE.source, "g");
  let m: RegExpExecArray | null = re.exec(tag);
  while (m !== null) {
    const [, key] = m;
    if (key) {
      attrs[key] = m[2];
    }
    m = re.exec(tag);
  }
  return attrs;
}

export function healthTypeShort(t: string | undefined): string | null {
  if (!t) {
    return null;
  }
  return t.replace(APPLE_HEALTH_TYPE_PREFIX_RE, "");
}

export function isoDate(v: string | undefined): string | null {
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

// ─── Record / workout builders ─────────────────────────────────────────

/**
 * Build a single `records`-stream record from a parsed HKRecord element.
 * Returns null when startDate is missing or unparseable; index.ts treats
 * that as "skip silently" since Apple Health emits some records without
 * a usable timestamp (e.g. metadata rows).
 */
export function buildHealthRecord(attrs: AppleHealthAttrs): HealthRecordOut | null {
  const startDate = isoDate(attrs.startDate);
  if (!startDate) {
    return null;
  }
  const type = healthTypeShort(attrs.type) || attrs.type || "Unknown";
  const value = attrs.value === undefined ? null : Number(attrs.value);
  const finite = value !== null && Number.isFinite(value);
  const id = hashId(`${type}|${attrs.sourceName || ""}|${startDate}|${attrs.value || ""}`);
  return {
    id,
    type,
    source_name: attrs.sourceName || null,
    source_version: attrs.sourceVersion || null,
    unit: attrs.unit || null,
    value: finite && value !== null ? value : null,
    value_raw: !finite && attrs.value ? attrs.value : null,
    start_date: startDate,
    end_date: isoDate(attrs.endDate),
  };
}

/**
 * Build a single `workouts`-stream record from a parsed HKWorkout element.
 * Returns null when startDate is missing or unparseable.
 */
export function buildWorkoutRecord(attrs: AppleHealthAttrs): WorkoutRecordOut | null {
  const startDate = isoDate(attrs.startDate);
  if (!startDate) {
    return null;
  }
  const id = hashId(`${attrs.workoutActivityType || ""}|${attrs.sourceName || ""}|${startDate}`);
  return {
    id,
    workout_activity_type: attrs.workoutActivityType
      ? attrs.workoutActivityType.replace(APPLE_HEALTH_WORKOUT_PREFIX_RE, "")
      : null,
    duration_minutes: attrs.duration ? Number(attrs.duration) : null,
    total_energy_burned_kcal: attrs.totalEnergyBurned ? Number(attrs.totalEnergyBurned) : null,
    total_distance_km: attrs.totalDistance ? Number(attrs.totalDistance) : null,
    source_name: attrs.sourceName || null,
    start_date: startDate,
    end_date: isoDate(attrs.endDate),
  };
}

// ─── Cursor / watermark helpers ────────────────────────────────────────

/**
 * Return true if `startDate` falls on or before the incremental cursor
 * `since`. index.ts uses this to skip already-emitted records.
 */
export function isBeforeCursor(startDate: string, since: string | undefined): boolean {
  return Boolean(since && startDate <= since);
}

/** Monotonic max of an existing cursor and a new ISO date string. */
export function advanceCursor(prev: string | undefined, next: string): string {
  if (!prev || next > prev) {
    return next;
  }
  return prev;
}

// ─── Manual-upload discovery / zip extraction ──────────────────────────

// A real iOS Health app export.xml is commonly hundreds of MB and can reach
// several GB for a long-lived, densely-instrumented account. This ceiling
// exists to reject genuinely adversarial archives (see
// streamZipEntryToFile's actual-bytes enforcement, which this bounds), not
// to reject real exports — set well above any real single-user export.
const MAX_EXPORT_XML_BYTES = 8 * 1024 * 1024 * 1024;
const APPLE_HEALTH_ZIP_POLICY: ZipReadPolicy = {
  maxEntries: 5000,
  maxEntryUncompressedBytes: MAX_EXPORT_XML_BYTES,
  maxTotalUncompressedBytes: MAX_EXPORT_XML_BYTES,
};
const ZIP_EXT_RE = /\.zip$/i;
const XML_EXT_RE = /\.xml$/i;
const EXPORT_XML_ENTRY_RE = /(^|\/)export\.xml$/i;
// Bounded recursive scan for an owner-uploaded artifact, matching the same
// depth WhatsApp's discoverExportFiles uses for the same reason: a
// manual-upload artifact can land flat (join(importDir, fileName)) OR
// nested one level under its artifact id
// (join(importDir, artifactId, fileName)) depending on which upload route
// created it -- see ref-manual-upload-draft-connection.ts's two write
// paths. Depth 3 comfortably covers both without an unbounded walk.
const MAX_DISCOVERY_DEPTH = 3;
const MAX_DISCOVERY_ENTRIES = 10_000;

export function appleHealthZipPolicy(): ZipReadPolicy {
  return APPLE_HEALTH_ZIP_POLICY;
}

/**
 * Find the single most-recently-modified owner-uploaded `.xml` or `.zip` in
 * `importDir` (bounded recursive scan — see MAX_DISCOVERY_DEPTH/ENTRIES).
 * Apple Health supports exactly one export per connection (a full snapshot,
 * not a per-chat append like WhatsApp), so "most recent" is the correct
 * choice when more than one candidate is present (e.g. after a re-upload
 * that landed in a new artifact subdirectory rather than overwriting the
 * old one). Returns null when the directory has no candidate file at all —
 * callers then fall back to the legacy pre-extracted directory layout.
 */
export function findUploadedExportCandidate(importDir: string): string | null {
  let best: { mtimeMs: number; path: string } | null = null;
  let visited = 0;
  function walk(dir: string, depth: number): void {
    if (depth > MAX_DISCOVERY_DEPTH || visited >= MAX_DISCOVERY_ENTRIES) {
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_DISCOVERY_ENTRIES) {
        return;
      }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path, depth + 1);
      } else if (entry.isFile() && (XML_EXT_RE.test(entry.name) || ZIP_EXT_RE.test(entry.name))) {
        const mtimeMs = statSync(path).mtimeMs;
        if (!best || mtimeMs > best.mtimeMs) {
          best = { mtimeMs, path };
        }
      }
    }
  }
  walk(importDir, 0);
  return best ? (best as { mtimeMs: number; path: string }).path : null;
}

export interface ResolvedExportExtraction {
  readonly extractedFromZip: boolean;
  readonly path: string;
}

export type ResolvedExportOutcome =
  | { readonly kind: "resolved"; readonly resolved: ResolvedExportExtraction }
  | { readonly kind: "not_found" }
  | { readonly kind: "extraction_failed"; readonly message: string };

/**
 * Resolve the real, ready-to-stream `export.xml` path for one collect run,
 * given an owner-uploaded candidate (`.xml` used directly, `.zip`
 * extracted). Extraction writes to a SIBLING file next to the uploaded zip
 * (`<zip-dir>/.extracted-export.xml`) via {@link streamZipEntryToFile} —
 * never buffering the inflated XML in memory (a real export.xml can be
 * hundreds of MB to multiple GB; see that function's own doc comment for
 * why this matters). Extraction is CACHED: if the sibling file already
 * exists and is newer than the zip, re-extraction is skipped, so a second
 * `collect` run against the same uploaded zip (e.g. a later incremental
 * sync) does not re-pay the extraction cost every time.
 */
export async function resolveUploadedExportPath(candidatePath: string): Promise<ResolvedExportOutcome> {
  if (XML_EXT_RE.test(candidatePath)) {
    return { kind: "resolved", resolved: { extractedFromZip: false, path: candidatePath } };
  }
  if (!ZIP_EXT_RE.test(candidatePath)) {
    return { kind: "not_found" };
  }

  const destPath = join(candidatePath.slice(0, -".zip".length) + ".export.xml");
  if (existsSync(destPath)) {
    const zipStat = statSync(candidatePath);
    const destStat = statSync(destPath);
    if (destStat.mtimeMs >= zipStat.mtimeMs) {
      return { kind: "resolved", resolved: { extractedFromZip: true, path: destPath } };
    }
  }

  const fileSize = statSync(candidatePath).size;
  const fd = openSync(candidatePath, "r");
  try {
    const result = await streamZipEntryToFile(fd, fileSize, "export.xml", destPath, APPLE_HEALTH_ZIP_POLICY);
    if (!result.found) {
      return {
        kind: "extraction_failed",
        message:
          "The uploaded .zip does not contain an export.xml. Apple Health exports look like 'export.zip' containing 'apple_health_export/export.xml' — choose the .zip from Health app > profile > Export All Health Data, or extract it yourself and upload export.xml directly.",
      };
    }
    return { kind: "resolved", resolved: { extractedFromZip: true, path: destPath } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: "extraction_failed",
      message: `Failed to extract export.xml from the uploaded .zip: ${message}`,
    };
  } finally {
    closeSync(fd);
  }
}

/** Matches export.xml at any depth inside a zip's central directory — used
 *  by validation to sniff for the entry without extracting it. */
export function isExportXmlEntryName(name: string): boolean {
  return EXPORT_XML_ENTRY_RE.test(name);
}

// ─── Manual-upload validation summary scan ─────────────────────────────

const HEALTH_DATA_ROOT_RE = /<HealthData[\s>]/;
// Cap how much of a non-export.xml file we read hunting for a root-element
// sniff before giving up -- a real export.xml declares <HealthData within
// its first few hundred bytes (XML decl + one root open tag), so a file
// that still hasn't shown it after 1 MiB is not a health export at all, not
// a slow-starting valid one. Bounds worst-case sniff cost on an oversized
// unsupported upload to one chunk read, not a whole-file scan.
const ROOT_SNIFF_WINDOW_BYTES = 1024 * 1024;
const SCAN_READ_BUFFER_SIZE = 65_536;

export interface ExportXmlSummary {
  readonly earliestStartDate: string | null;
  readonly latestStartDate: string | null;
  readonly looksLikeHealthExport: boolean;
  readonly recordCount: number;
  readonly workoutCount: number;
}

/**
 * Stream-scan `path` (an export.xml, however it got there — direct upload
 * or already-extracted from a zip) to produce validation-preview stats
 * WITHOUT emitting or retaining individual records — mirrors index.ts's
 * streamParse loop (same tag regex, same chunk size) but accumulates only
 * counts and a min/max date range, so peak memory stays O(1) regardless of
 * export size, matching the collect-time streaming guarantee this connector
 * makes everywhere else.
 */
export async function scanExportXmlSummary(path: string): Promise<ExportXmlSummary> {
  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: SCAN_READ_BUFFER_SIZE });
  let buf = "";
  let sniffedBytes = 0;
  let looksLikeHealthExport = false;
  let recordCount = 0;
  let workoutCount = 0;
  let earliestStartDate: string | null = null;
  let latestStartDate: string | null = null;

  for await (const chunk of stream as AsyncIterable<string | Buffer>) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    buf += text;
    if (!looksLikeHealthExport) {
      sniffedBytes += Buffer.byteLength(text, "utf8");
      if (HEALTH_DATA_ROOT_RE.test(buf)) {
        looksLikeHealthExport = true;
      } else if (sniffedBytes > ROOT_SNIFF_WINDOW_BYTES) {
        // Never found <HealthData within the sniff window -- stop reading
        // early rather than scanning a large unsupported file to its end.
        stream.destroy();
        break;
      }
    }

    const re = new RegExp(APPLE_HEALTH_TAG_RE.source, "g");
    let m: RegExpExecArray | null = re.exec(buf);
    let lastEnd = 0;
    while (m !== null) {
      const [, tag] = m;
      const attrs = parseAttrs(m[2] ?? "");
      const startDate = isoDate(attrs.startDate);
      if (tag === "Record") {
        recordCount += 1;
      } else if (tag === "Workout") {
        workoutCount += 1;
      }
      if (startDate) {
        if (!earliestStartDate || startDate < earliestStartDate) {
          earliestStartDate = startDate;
        }
        if (!latestStartDate || startDate > latestStartDate) {
          latestStartDate = startDate;
        }
      }
      lastEnd = re.lastIndex;
      m = re.exec(buf);
    }
    buf = buf.slice(lastEnd);
  }

  return { earliestStartDate, latestStartDate, looksLikeHealthExport, recordCount, workoutCount };
}
