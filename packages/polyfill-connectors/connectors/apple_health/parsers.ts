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
import type {
  AppleHealthAttrs,
  AppleHealthElement,
  AppleHealthGapCounts,
  AppleHealthWorkoutEvent,
  HealthRecordOut,
  WorkoutRecordOut,
} from "./types.ts";

// ─── Module-scoped regexes (Biome useTopLevelRegex) ────────────────────

// Matches the opening tag of any element the streaming scanner in index.ts
// tracks: the two top-level record kinds (Record, Workout), their nested
// children (MetadataEntry, WorkoutEvent, WorkoutStatistics), and the two
// top-level close tags needed to know when a Record/Workout span ends.
// Longest-name-first ordering matters: regex alternation is first-match, not
// longest-match, so "Workout" would otherwise shadow "WorkoutStatistics"/
// "WorkoutEvent" and fail the tag (no immediate whitespace/`>` after the
// "Workout" prefix), silently losing those elements.
//
// The attribute-span group matches only well-formed `key="value"` pairs
// (`(?:\s+\w+="[^"]*")*`), NOT "any char but / or >". A prior version used
// `[^/>]*`, which excludes literal `/` from attribute VALUES — but Apple
// Health's own units routinely contain `/` (`count/min` for heart rate,
// `mL/min·kg` for VO2max), so that version silently failed to match, and
// silently dropped, every Record carrying such a unit. Matching only real
// attribute syntax makes the tag boundary depend on quote structure, not on
// which characters happen to appear inside a quoted value.
// WorkoutRoute is matched only as an open tag (never captured as a full
// element with children — see workoutRoutesUncaptured) so the scanner can
// count it once per occurrence instead of it vanishing into the "any
// other tag" fallthrough alongside its nested Location/MetadataEntry
// children, which would double- or triple-count one GPS route.
export const APPLE_HEALTH_TAG_RE =
  /<(WorkoutStatistics|WorkoutEvent|MetadataEntry|WorkoutRoute|Workout|Record)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>|<\/(Record|Workout)>/g;
const APPLE_HEALTH_ATTR_RE = /([\w:-]+)="([^"]*)"/g;
const XML_ENTITY_RE = /&(lt|gt|amp|quot|apos|#x[0-9a-fA-F]+|#\d+);/g;
const APPLE_HEALTH_TYPE_PREFIX_RE = /^HKQuantityTypeIdentifier|^HKCategoryTypeIdentifier|^HKDataType/;
const APPLE_HEALTH_KNOWN_TYPE_RE =
  /^HKQuantityTypeIdentifier|^HKCategoryTypeIdentifier|^HKDataType|^HKCorrelationTypeIdentifier/;
const APPLE_HEALTH_WORKOUT_PREFIX_RE = /^HKWorkoutActivityType/;
const APPLE_HEALTH_WORKOUT_EVENT_PREFIX_RE = /^HKWorkoutEventType/;

// Bound nested-child accumulation per element so one pathological export
// (e.g. thousands of MetadataEntry on a single Workout) cannot balloon
// memory — the streaming design must survive a 500MB export.
const MAX_TRACKED_CHILDREN_PER_ELEMENT = 500;

// Record ID length (hex). 24 chars = 96 bits of entropy — safe for a user's
// personal health-event set.
const RECORD_ID_HASH_LENGTH = 24;

// ─── Small pure helpers ────────────────────────────────────────────────

export function hashId(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, RECORD_ID_HASH_LENGTH);
}

// Attribute values are XML text: real exports carry entity-escaped `<`,
// `>`, `&`, `"`, `'` (e.g. a device string embedding a Swift description
// like "<<HKDevice: ...>>", or a Withings deep-link URL with `&` between
// query params). Decoding here — the one place every attribute value
// passes through — means every downstream consumer sees the real
// character, not its escaped form.
function decodeXmlEntities(s: string): string {
  return s.replace(XML_ENTITY_RE, (_entity, name: string) => {
    switch (name) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        if (name.startsWith("#x")) {
          return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
        }
        return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    }
  });
}

export function parseAttrs(tag: string): AppleHealthAttrs {
  const attrs: AppleHealthAttrs = {};
  const re = new RegExp(APPLE_HEALTH_ATTR_RE.source, "g");
  let m: RegExpExecArray | null = re.exec(tag);
  while (m !== null) {
    const [, key, value] = m;
    if (key) {
      attrs[key] = decodeXmlEntities(value ?? "");
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

// ─── Metadata / nested-child helpers ────────────────────────────────────

/** Build a `{key: value}` map from accumulated MetadataEntry children, bounded and null when empty. */
function buildMetadataMap(entries: readonly { key: string; value: string }[]): Record<string, string> | null {
  if (entries.length === 0) {
    return null;
  }
  const capped = entries.slice(0, MAX_TRACKED_CHILDREN_PER_ELEMENT);
  const out: Record<string, string> = {};
  for (const e of capped) {
    out[e.key] = e.value;
  }
  return out;
}

/** Build a WorkoutEvent record from its raw attrs (type, date, optional duration/durationUnit). */
export function buildWorkoutEvent(attrs: AppleHealthAttrs): AppleHealthWorkoutEvent {
  return {
    type: attrs.type ? attrs.type.replace(APPLE_HEALTH_WORKOUT_EVENT_PREFIX_RE, "") : null,
    date: isoDate(attrs.date),
    duration_minutes: attrs.duration ? Number(attrs.duration) : null,
  };
}

/**
 * Record a Record element's `type` in the gap tally when it does not match
 * any known HK*TypeIdentifier prefix. Apple Health's export format is
 * undocumented and has shifted across iOS versions (see
 * ai/research/apple-health-export-format/), so a new/unrecognized type
 * prefix is expected eventually — this project never drops that silently.
 */
export function trackUnrecognizedType(type: string | undefined, gaps: AppleHealthGapCounts): void {
  if (!type || APPLE_HEALTH_KNOWN_TYPE_RE.test(type)) {
    return;
  }
  gaps.unrecognizedRecordTypes.set(type, (gaps.unrecognizedRecordTypes.get(type) ?? 0) + 1);
}

export function newGapCounts(): AppleHealthGapCounts {
  return {
    unrecognizedRecordTypes: new Map(),
    recordsMissingStartDate: 0,
    workoutsMissingStartDate: 0,
    workoutRoutesUncaptured: 0,
  };
}

// ─── Record / workout builders ─────────────────────────────────────────

/**
 * Build a single `records`-stream record from a parsed HKRecord element
 * (attrs + any nested MetadataEntry children). Returns null when startDate
 * is missing or unparseable; index.ts counts that in `gaps` rather than
 * dropping it silently, since Apple Health emits some records without a
 * usable timestamp (e.g. metadata rows).
 */
export function buildHealthRecord(el: AppleHealthElement, gaps: AppleHealthGapCounts): HealthRecordOut | null {
  const { attrs } = el;
  trackUnrecognizedType(attrs.type, gaps);
  const startDate = isoDate(attrs.startDate);
  if (!startDate) {
    gaps.recordsMissingStartDate += 1;
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
    device: attrs.device || null,
    unit: attrs.unit || null,
    value: finite && value !== null ? value : null,
    value_raw: !finite && attrs.value ? attrs.value : null,
    start_date: startDate,
    end_date: isoDate(attrs.endDate),
    creation_date: isoDate(attrs.creationDate),
    metadata: buildMetadataMap(el.metadata),
  };
}

/**
 * Build a single `workouts`-stream record from a parsed HKWorkout element
 * (attrs + nested MetadataEntry/WorkoutEvent/WorkoutStatistics children).
 * Returns null when startDate is missing or unparseable.
 */
export function buildWorkoutRecord(el: AppleHealthElement, gaps: AppleHealthGapCounts): WorkoutRecordOut | null {
  const { attrs } = el;
  const startDate = isoDate(attrs.startDate);
  if (!startDate) {
    gaps.workoutsMissingStartDate += 1;
    return null;
  }
  const id = hashId(`${attrs.workoutActivityType || ""}|${attrs.sourceName || ""}|${startDate}`);
  return {
    id,
    workout_activity_type: attrs.workoutActivityType
      ? attrs.workoutActivityType.replace(APPLE_HEALTH_WORKOUT_PREFIX_RE, "")
      : null,
    source_version: attrs.sourceVersion || null,
    device: attrs.device || null,
    metadata: buildMetadataMap(el.metadata),
    events: el.workoutEvents.length > 0 ? el.workoutEvents.slice(0, MAX_TRACKED_CHILDREN_PER_ELEMENT) : null,
    statistics:
      el.workoutStatistics.length > 0 ? el.workoutStatistics.slice(0, MAX_TRACKED_CHILDREN_PER_ELEMENT) : null,
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
const HEALTH_DATA_ROOT_RE = /<HealthData[\s>]/;
// Cap how much of a candidate file we read hunting for the <HealthData root
// element before giving up -- a real export.xml declares it within its
// first few hundred bytes (XML decl + one root open tag), so a file that
// still hasn't shown it after 1 MiB is not a health export at all, not a
// slow-starting valid one. Bounds worst-case sniff cost on an oversized
// wrong-file upload to a few chunk reads, not a whole-file scan.
const ROOT_SNIFF_WINDOW_BYTES = 1024 * 1024;
const ROOT_SNIFF_READ_CHUNK_BYTES = 65_536;
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
interface DiscoveryState {
  best: { mtimeMs: number; path: string } | null;
  visited: number;
}

function considerDiscoveredFile(state: DiscoveryState, path: string): void {
  const { mtimeMs } = statSync(path);
  if (!state.best || mtimeMs > state.best.mtimeMs) {
    state.best = { mtimeMs, path };
  }
}

function walkForUploadedExportCandidate(state: DiscoveryState, dir: string, depth: number): void {
  if (depth > MAX_DISCOVERY_DEPTH || state.visited >= MAX_DISCOVERY_ENTRIES) {
    return;
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    state.visited += 1;
    if (state.visited > MAX_DISCOVERY_ENTRIES) {
      return;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkForUploadedExportCandidate(state, path, depth + 1);
    } else if (entry.isFile() && (XML_EXT_RE.test(entry.name) || ZIP_EXT_RE.test(entry.name))) {
      considerDiscoveredFile(state, path);
    }
  }
}

export function findUploadedExportCandidate(importDir: string): string | null {
  const state: DiscoveryState = { best: null, visited: 0 };
  walkForUploadedExportCandidate(state, importDir, 0);
  return state.best?.path ?? null;
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
 * Bounded, streaming sniff for the `<HealthData` root element -- reads at
 * most ROOT_SNIFF_WINDOW_BYTES regardless of file size, so a large
 * not-actually-a-health-export upload fails fast instead of being scanned
 * to its end just to discover it never had the root element at all.
 */
async function looksLikeHealthExportFile(path: string): Promise<boolean> {
  const stream = createReadStream(path, {
    encoding: "utf8",
    highWaterMark: ROOT_SNIFF_READ_CHUNK_BYTES,
  });
  let buf = "";
  let sniffedBytes = 0;
  try {
    for await (const chunk of stream as AsyncIterable<string | Buffer>) {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      buf += text;
      sniffedBytes += Buffer.byteLength(text, "utf8");
      if (HEALTH_DATA_ROOT_RE.test(buf)) {
        return true;
      }
      if (sniffedBytes > ROOT_SNIFF_WINDOW_BYTES) {
        return false;
      }
    }
  } finally {
    stream.destroy();
  }
  return false;
}

/**
 * Validate that `path` (an already-resolved bare .xml, or a freshly
 * extracted export.xml) genuinely looks like an Apple Health export before
 * handing it to the streaming parser -- WITHOUT this check, a wrong file
 * that happens to end in .xml (or a .zip whose export.xml entry is garbage)
 * would silently parse to zero Record/Workout tags and report a
 * misleadingly successful "0 records" run instead of a clear, actionable
 * failure. This is the collect-time backstop: the manual-upload route's own
 * validation preview (validation.ts) already rejects this case before a run
 * is even created, but a developer placing a file directly under
 * APPLE_HEALTH_EXPORT_DIR (the legacy layout) never goes through that
 * preview, so collect() must fail closed on its own too.
 */
async function resolveIfLooksLikeHealthExport(path: string, extractedFromZip: boolean): Promise<ResolvedExportOutcome> {
  if (await looksLikeHealthExportFile(path)) {
    return { kind: "resolved", resolved: { extractedFromZip, path } };
  }
  return {
    kind: "extraction_failed",
    message: extractedFromZip
      ? "The export.xml extracted from the uploaded .zip does not look like an Apple Health export (no <HealthData root element found). Choose the .zip from Health app > profile > Export All Health Data."
      : "The uploaded file does not look like an Apple Health export.xml (no <HealthData root element found). Choose the export.xml extracted from Health app > profile > Export All Health Data, or upload the .zip directly.",
  };
}

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
    return await resolveIfLooksLikeHealthExport(candidatePath, false);
  }
  if (!ZIP_EXT_RE.test(candidatePath)) {
    return { kind: "not_found" };
  }

  const destPath = join(`${candidatePath.slice(0, -".zip".length)}.export.xml`);
  if (existsSync(destPath)) {
    const zipStat = statSync(candidatePath);
    const destStat = statSync(destPath);
    if (destStat.mtimeMs >= zipStat.mtimeMs) {
      return await resolveIfLooksLikeHealthExport(destPath, true);
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
    return await resolveIfLooksLikeHealthExport(destPath, true);
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

const SCAN_READ_BUFFER_SIZE = 65_536;

export interface ExportXmlSummary {
  readonly earliestStartDate: string | null;
  readonly latestStartDate: string | null;
  readonly looksLikeHealthExport: boolean;
  readonly recordCount: number;
  readonly workoutCount: number;
}

/** Mutable accumulator threaded through one scanExportXmlSummary pass. */
interface SummaryScanState {
  earliestStartDate: string | null;
  latestStartDate: string | null;
  looksLikeHealthExport: boolean;
  recordCount: number;
  sniffedBytes: number;
  workoutCount: number;
}

/**
 * Update `state.looksLikeHealthExport` from the current buffer, honoring
 * the bounded sniff window. Returns `true` when the caller should stop
 * reading entirely (window exhausted with no root element found yet).
 */
function updateHealthDataRootSniff(state: SummaryScanState, buf: string, chunkText: string): boolean {
  if (state.looksLikeHealthExport) {
    return false;
  }
  state.sniffedBytes += Buffer.byteLength(chunkText, "utf8");
  if (HEALTH_DATA_ROOT_RE.test(buf)) {
    state.looksLikeHealthExport = true;
    return false;
  }
  return state.sniffedBytes > ROOT_SNIFF_WINDOW_BYTES;
}

function recordStartDateBounds(state: SummaryScanState, startDate: string): void {
  if (!state.earliestStartDate || startDate < state.earliestStartDate) {
    state.earliestStartDate = startDate;
  }
  if (!state.latestStartDate || startDate > state.latestStartDate) {
    state.latestStartDate = startDate;
  }
}

/**
 * APPLE_HEALTH_TAG_RE also matches nested MetadataEntry/WorkoutEvent/
 * WorkoutStatistics open tags and </Record>/</Workout> close tags (see its
 * own doc comment) -- only count a Record/Workout on its OPEN tag (group
 * 1), exactly once per element regardless of whether it is self-closing or
 * has nested children, mirroring index.ts's handleTopLevelOpenTag. Counting
 * on close tags too, or counting every match unconditionally, would
 * double-count non-self-closing elements.
 */
function applyTagMatch(state: SummaryScanState, openTag: string | undefined, attrString: string | undefined): void {
  if (!(openTag === "Record" || openTag === "Workout")) {
    return;
  }
  const attrs = parseAttrs(attrString ?? "");
  const startDate = isoDate(attrs.startDate);
  if (openTag === "Record") {
    state.recordCount += 1;
  } else {
    state.workoutCount += 1;
  }
  if (startDate) {
    recordStartDateBounds(state, startDate);
  }
}

/** Scan every Record/Workout open tag in `buf`, returning the unconsumed tail past the last full match. */
function scanTagMatches(state: SummaryScanState, buf: string): string {
  const re = new RegExp(APPLE_HEALTH_TAG_RE.source, "g");
  let m: RegExpExecArray | null = re.exec(buf);
  let lastEnd = 0;
  while (m !== null) {
    const [, openTag, attrString] = m;
    applyTagMatch(state, openTag, attrString);
    lastEnd = re.lastIndex;
    m = re.exec(buf);
  }
  return buf.slice(lastEnd);
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
  const state: SummaryScanState = {
    earliestStartDate: null,
    latestStartDate: null,
    looksLikeHealthExport: false,
    recordCount: 0,
    sniffedBytes: 0,
    workoutCount: 0,
  };
  let buf = "";

  for await (const chunk of stream as AsyncIterable<string | Buffer>) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    buf += text;
    if (updateHealthDataRootSniff(state, buf, text)) {
      // Never found <HealthData within the sniff window -- stop reading
      // early rather than scanning a large unsupported file to its end.
      stream.destroy();
      break;
    }
    buf = scanTagMatches(state, buf);
  }

  const { earliestStartDate, latestStartDate, looksLikeHealthExport, recordCount, workoutCount } = state;
  return { earliestStartDate, latestStartDate, looksLikeHealthExport, recordCount, workoutCount };
}
