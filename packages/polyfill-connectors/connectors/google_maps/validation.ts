// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { JSONParser } from "@streamparser/json";
import { parseGoogleMapsExport } from "./parsers.ts";
import type { GoogleMapsSourceFormat } from "./types.ts";

export type TimelineValidationStatus = "valid" | "duplicate" | "stale" | "empty" | "unsupported" | "too_large";

export interface GoogleMapsTimelineValidationOptions {
  readonly existingFileHashes?: readonly string[];
  readonly importedThrough?: string | null;
  readonly maxFileBytes?: number | null;
}

export interface GoogleMapsTimelineValidation {
  readonly date_range: { readonly end: string | null; readonly start: string | null };
  readonly detected_format: GoogleMapsSourceFormat | "unsupported";
  readonly estimated_points: number;
  readonly estimated_segments: number;
  readonly file_sha256: string;
  readonly remediation: string | null;
  readonly status: TimelineValidationStatus;
}

// Read-buffer size for the streaming JSON pass — matches the size already
// proven for twitter_archive's own @streamparser/json reader
// (archive-stream.ts), the one other file-backed JSON-streaming primitive in
// this codebase.
const STREAM_READ_BUFFER_SIZE = 65_536;

// @streamparser/json must fully materialize one array element's value
// before emitting it, so total-file boundedness alone doesn't bound a
// single element's size. 4 MiB is generous for any real Timeline record
// (a point or segment is a few hundred bytes) while keeping one adversarial
// or corrupted record from exhausting memory on its own.
const MAX_SINGLE_ELEMENT_BYTES = 4 * 1024 * 1024;

class GoogleMapsElementTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleMapsElementTooLargeError";
  }
}

class GoogleMapsMixedShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleMapsMixedShapeError";
  }
}

// The single source of truth for the 3 keyed (non-bare-array) shapes'
// key -> format mapping, shared by BOTH the buffer-backed detector
// (detectFormat) and the streaming detector (handleContainerKeySignal /
// formatForElementEvent), so the two paths' notion of "which key means
// which shape" can never drift apart into two maps someone updates only
// one of.
const SHAPE_KEYS = ["locations", "semanticSegments", "timelineObjects"] as const;
const SHAPE_KEY_TO_FORMAT: Readonly<Record<(typeof SHAPE_KEYS)[number], GoogleMapsSourceFormat>> = {
  locations: "legacy_records",
  semanticSegments: "semantic_segments",
  timelineObjects: "timeline_objects",
};

/** Safe lookup for a key of unknown provenance (e.g. a string observed from
 *  a streamed JSON key event) against {@link SHAPE_KEY_TO_FORMAT}, which is
 *  typed as a closed record over the known shape keys and so cannot be
 *  indexed directly by an arbitrary string. */
function formatForShapeKey(key: string): GoogleMapsSourceFormat | null {
  return (SHAPE_KEY_TO_FORMAT as Readonly<Record<string, GoogleMapsSourceFormat | undefined>>)[key] ?? null;
}

/** Shape keys that actually have at least one element -- a present-but-EMPTY
 *  sibling array (e.g. `{ locations: [...], semanticSegments: [] }`) is not
 *  mixing, it's a single-shape export with an unused key still in the
 *  object. Mixing means more than one shape has at least one element. */
function nonEmptyShapeKeys(obj: Record<string, unknown>): string[] {
  return SHAPE_KEYS.filter((key) => {
    const value = obj[key];
    return Array.isArray(value) && value.length > 0;
  });
}

function detectFormat(json: unknown): GoogleMapsSourceFormat | "unsupported" | "mixed" {
  if (Array.isArray(json)) {
    return "timeline_objects";
  }
  if (!json || typeof json !== "object") {
    return "unsupported";
  }
  const obj = json as Record<string, unknown>;
  const nonEmpty = nonEmptyShapeKeys(obj);
  // More than one shape carrying actual elements is genuinely ambiguous.
  if (nonEmpty.length > 1) {
    return "mixed";
  }
  // Exactly one shape has elements: THAT one is the label, regardless of
  // key order -- {locations: [], semanticSegments: [data]} must label as
  // semantic_segments, not legacy_records just because "locations" is
  // checked first below.
  const [onlyNonEmptyKey] = nonEmpty;
  if (onlyNonEmptyKey) {
    return SHAPE_KEY_TO_FORMAT[onlyNonEmptyKey as (typeof SHAPE_KEYS)[number]];
  }
  // Zero shapes have elements: fall back to deterministic first-recognized-
  // array-present (any presence, even empty), so an all-empty document like
  // {locations: [], timelineObjects: []} still labels and reaches "empty",
  // not "unsupported".
  for (const key of SHAPE_KEYS) {
    if (Array.isArray(obj[key])) {
      return SHAPE_KEY_TO_FORMAT[key];
    }
  }
  return "unsupported";
}

function minMax(values: readonly string[]): { end: string | null; start: string | null } {
  const sorted = values.filter(Boolean).sort();
  return { end: sorted.at(-1) ?? null, start: sorted[0] ?? null };
}

function remediationFor(status: TimelineValidationStatus): string | null {
  switch (status) {
    case "duplicate":
      return "This file was already imported for this source. Export a newer Timeline file from your phone.";
    case "empty":
      return "The file is a recognized Timeline export, but it does not contain importable points or segments.";
    case "stale":
      return "This file only covers dates that are already imported. Export a newer Timeline file from your phone.";
    case "too_large":
      return "This file is larger than the upload limit. A Timeline export this large is unusual — ask your PDPP operator to raise the deployment limit if this is a genuine export.";
    case "unsupported":
      return "Choose the Timeline JSON export from Google Maps on your phone. Google account passwords and Data Portability archives are not Timeline exports.";
    case "valid":
      return null;
    default:
      return null;
  }
}

const OVERSIZED_RECORD_REMEDIATION =
  "One record in this export is unusually large and can't be processed. Try re-exporting your Timeline data — if this keeps happening, the export file may be corrupted.";

const MIXED_SHAPE_REMEDIATION =
  "This file has more than one kind of Timeline data mixed together, which isn't a shape a real Timeline export uses. Export a fresh Timeline file instead of a hand-edited or merged one.";

function unsupportedResult(
  fileSha256: string,
  remediation: string = remediationFor("unsupported") ?? ""
): GoogleMapsTimelineValidation {
  return {
    date_range: { end: null, start: null },
    detected_format: "unsupported",
    estimated_points: 0,
    estimated_segments: 0,
    file_sha256: fileSha256,
    remediation,
    status: "unsupported",
  };
}

function tooLargeResult(
  fileSha256: string,
  remediation: string = remediationFor("too_large") ?? ""
): GoogleMapsTimelineValidation {
  return {
    date_range: { end: null, start: null },
    detected_format: "unsupported",
    estimated_points: 0,
    estimated_segments: 0,
    file_sha256: fileSha256,
    remediation,
    status: "too_large",
  };
}

/**
 * Shared tail of both {@link validateGoogleMapsTimelineArtifact} (buffer-
 * backed) and {@link validateGoogleMapsTimelineArtifactFromFile} (file-
 * backed): once a {@link ParseResult}-shaped count/date-range has been
 * produced (however it was accumulated), the duplicate/empty/stale status
 * determination is identical for both entrypoints. Kept as one function so
 * the two cannot silently drift.
 */
function buildValidationFromCounts(
  detectedFormat: GoogleMapsSourceFormat,
  pointCount: number,
  segmentCount: number,
  dateRange: { end: string | null; start: string | null },
  fileSha256: string,
  options: Pick<GoogleMapsTimelineValidationOptions, "existingFileHashes" | "importedThrough">
): GoogleMapsTimelineValidation {
  let status: TimelineValidationStatus = "valid";
  const previousHashes = new Set(options.existingFileHashes ?? []);
  if (previousHashes.has(fileSha256)) {
    status = "duplicate";
  } else if (pointCount === 0 && segmentCount === 0) {
    status = "empty";
  } else if (options.importedThrough && dateRange.end && dateRange.end <= options.importedThrough) {
    status = "stale";
  }

  return {
    date_range: dateRange,
    detected_format: detectedFormat,
    estimated_points: pointCount,
    estimated_segments: segmentCount,
    file_sha256: fileSha256,
    remediation: remediationFor(status),
    status,
  };
}

export function validateGoogleMapsTimelineArtifact(
  input: Uint8Array | string,
  options: GoogleMapsTimelineValidationOptions = {}
): GoogleMapsTimelineValidation {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  const fileSha256 = createHash("sha256").update(bytes).digest("hex");
  if (options.maxFileBytes !== null && options.maxFileBytes !== undefined && bytes.byteLength > options.maxFileBytes) {
    return tooLargeResult(fileSha256);
  }

  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    return unsupportedResult(fileSha256);
  }

  const detectedFormat = detectFormat(json);
  if (detectedFormat === "mixed") {
    return unsupportedResult(fileSha256, MIXED_SHAPE_REMEDIATION);
  }
  if (detectedFormat === "unsupported") {
    return unsupportedResult(fileSha256);
  }

  const parsed = parseGoogleMapsExport(json);
  const dateRange = minMax([
    ...parsed.points.map((point) => point.timestamp),
    ...parsed.segments.map((segment) => segment.start_time),
  ]);
  return buildValidationFromCounts(
    detectedFormat,
    parsed.points.length,
    parsed.segments.length,
    dateRange,
    fileSha256,
    options
  );
}

export interface GoogleMapsTimelineFileValidationOptions {
  readonly existingFileHashes?: readonly string[];
  /** Already-known SHA-256 of the file (e.g. computed once during the
   *  streaming upload write) — passed in rather than recomputed, so this
   *  validator never needs a second whole-file read just to hash it again. */
  readonly fileSha256: string;
  readonly importedThrough?: string | null;
  readonly maxFileBytes?: number | null;
}

/**
 * Wraps one streamed top-level array element in the minimal single-item
 * container {@link parseGoogleMapsExport} expects for the shape it came
 * from, so the SAME pure per-item parsing logic (buildPoint/buildSegment
 * dispatch, id hashing, field extraction) is reused verbatim -- never
 * duplicated into a second parser. This costs one extra dispatch call per
 * item versus one call for the whole file; negligible next to avoiding a
 * second parser implementation to keep in sync.
 */
function wrapStreamedElement(detectedFormat: GoogleMapsSourceFormat, value: unknown): unknown {
  if (detectedFormat === "legacy_records") {
    return { locations: [value] };
  }
  if (detectedFormat === "semantic_segments") {
    return { semanticSegments: [value] };
  }
  return [value];
}

/**
 * Peeks at the first non-whitespace byte of the file to determine whether
 * the root JSON value is an array (bare `timeline_objects` shape) without
 * parsing or buffering the document — the streaming equivalent of the
 * buffer-backed detector's own `Array.isArray(json)` root check. Reads a
 * small, fixed-size window (matching this codebase's own bounded-peek
 * precedent for the ZIP EOCD scan), never the whole file.
 */
async function peekRootIsArray(path: string): Promise<boolean> {
  const PEEK_BYTES = 64;
  const stream = createReadStream(path, { encoding: "utf8", end: PEEK_BYTES - 1 });
  try {
    for await (const chunk of stream as AsyncIterable<string>) {
      const trimmed = chunk.trimStart();
      if (trimmed.length > 0) {
        return trimmed[0] === "[";
      }
    }
    return false;
  } finally {
    stream.destroy();
  }
}

interface StreamedCounts {
  /** Formats that actually accumulated at least one element. 0 entries at
   *  the end of the stream means "recognized but all-empty" (falls back to
   *  recognizedFormatsSeen by priority); 1 entry is the real label; >1 is a
   *  mixed-shape document, rejected via {@link GoogleMapsMixedShapeError}. */
  formatsWithElements: Set<GoogleMapsSourceFormat>;
  maxTimestamp: string | null;
  minTimestamp: string | null;
  pointCount: number;
  /** Every recognized key seen (regardless of whether it turns out empty) --
   *  the all-empty fallback resolves from this set using the SAME fixed
   *  shape priority as the buffer-backed detectFormat's own fallback
   *  (locations > semanticSegments > timelineObjects), not stream/document
   *  order. */
  recognizedFormatsSeen: Set<GoogleMapsSourceFormat>;
  segmentCount: number;
}

type StreamStackKey = string | number | undefined;
interface StreamStackFrame {
  key: StreamStackKey;
}

/**
 * Handles a KEY-position partial event (`stack.length === 1`, `key` is the
 * string key just seen on the root object, value not yet parsed). Only
 * records the key into `recognizedFormatsSeen` -- never throws here: seeing
 * a second container KEY does not by itself mean the document is mixed (a
 * present-but-empty sibling array is a single-shape export with an unused
 * key). Mixing is decided later, from {@link accumulateElement}'s
 * `formatsWithElements`, which only grows when a shape actually has data.
 */
function handleContainerKeySignal(
  counts: StreamedCounts,
  key: StreamStackKey,
  stack: readonly StreamStackFrame[]
): void {
  if (stack.length !== 1 || typeof key !== "string") {
    return;
  }
  const format = formatForShapeKey(key);
  if (format) {
    counts.recognizedFormatsSeen.add(format);
  }
}

/**
 * Determines which of the 4 shapes a non-partial `onValue` element event
 * belongs to, or `null` if it isn't one of their own array elements.
 *
 * A top-level-array element (`stack.length === 1`) has a numeric key.
 * `"$.*"` ALSO matches every direct child of a top-level OBJECT (its
 * property values, string-keyed) -- that case is entirely out of scope here
 * (object property values are handled by {@link handleContainerKeySignal},
 * never here), so a string key at `stack.length === 1` must be ignored, not
 * misread as an array element (a real bug caught by the "unrecognized
 * top-level shape" test: an unrelated top-level property was silently
 * treated as an empty `timeline_objects` array before this check existed).
 *
 * A nested-array element (`stack.length === 2`, matched by
 * `"$.locations.*"`/`"$.semanticSegments.*"`/`"$.timelineObjects.*"`) sits
 * under its parent object's own key -- that key IS the shape signal.
 */
function formatForElementEvent(key: StreamStackKey, stack: readonly StreamStackFrame[]): GoogleMapsSourceFormat | null {
  if (stack.length === 1) {
    return typeof key === "number" ? "timeline_objects" : null;
  }
  if (stack.length === 2) {
    const parentKey = stack[1]?.key;
    return typeof parentKey === "string" ? formatForShapeKey(parentKey) : null;
  }
  return null;
}

/**
 * Parses one streamed element via {@link parseGoogleMapsExport} (through
 * {@link wrapStreamedElement}) and folds its points/segments into the
 * running counts and min/max timestamp -- the per-element accumulation step
 * of {@link streamCounts}, extracted so that function's own dispatch logic
 * stays simple enough to read at a glance. Throws once a SECOND distinct
 * format accumulates an element -- mirrors the buffer-backed detector's own
 * "more than one shape has elements" mixed-shape rejection, checked here
 * (not when a container key is merely seen) so a present-but-empty sibling
 * array never false-positives as mixing.
 */
function accumulateElement(counts: StreamedCounts, format: GoogleMapsSourceFormat, value: unknown): void {
  counts.formatsWithElements.add(format);
  if (counts.formatsWithElements.size > 1) {
    throw new GoogleMapsMixedShapeError(
      `more than one Timeline shape has elements: ${[...counts.formatsWithElements].join(", ")}`
    );
  }
  const parsed = parseGoogleMapsExport(wrapStreamedElement(format, value));
  counts.pointCount += parsed.points.length;
  counts.segmentCount += parsed.segments.length;
  for (const timestamp of [
    ...parsed.points.map((point) => point.timestamp),
    ...parsed.segments.map((segment) => segment.start_time),
  ]) {
    if (counts.minTimestamp === null || timestamp < counts.minTimestamp) {
      counts.minTimestamp = timestamp;
    }
    if (counts.maxTimestamp === null || timestamp > counts.maxTimestamp) {
      counts.maxTimestamp = timestamp;
    }
  }
}

/**
 * Streams `path`'s top-level array elements (whichever of the 4 shapes is
 * present) through `@streamparser/json` -- the same streaming JSON parser
 * already proven for twitter_archive's multi-hundred-MB `.js` archives
 * (`archive-stream.ts`) -- feeding each element through
 * {@link parseGoogleMapsExport} one at a time via {@link wrapStreamedElement}.
 * Only running counts and a running min/max timestamp are retained. The
 * `paths` list matches each container's per-element children
 * (`$.locations.*` etc), never the container array itself: matching the
 * container path retains every element's full value in its own slots until
 * the array closes, which would defeat streaming for a large export.
 */
async function streamCounts(path: string): Promise<StreamedCounts> {
  const counts: StreamedCounts = {
    formatsWithElements: new Set(),
    maxTimestamp: null,
    minTimestamp: null,
    pointCount: 0,
    recognizedFormatsSeen: new Set(),
    segmentCount: 0,
  };

  // "$.*" matches array elements of a bare top-level array (numeric key) --
  // the ONLY thing it's used for here, since a bare top-level array's own
  // presence-when-empty is separately detected via peekRootIsArray, not
  // through this parser instance at all. emitPartialValues + the KEY-state
  // partial event on "$.locations"/"$.semanticSegments"/"$.timelineObjects"
  // fires the moment each key is SEEN, before its value is parsed at all --
  // giving recognizedFormatsSeen for free, without ever matching (and therefore
  // never retaining) the container's own array value.
  const parser = new JSONParser({
    emitPartialValues: true,
    keepStack: false,
    paths: ["$.*", "$.locations.*", "$.semanticSegments.*", "$.timelineObjects.*"],
  });
  let parseError: unknown;
  // Bounds each array element's byte span BEFORE those bytes reach the
  // parser: @streamparser/json's tokenizer doesn't emit a STRING token
  // until the whole string value is already materialized, so checking at
  // the token or value level is too late for a giant string. Counting raw
  // chunk bytes since the last element boundary and refusing to feed a
  // chunk that would cross the bound is the only point early enough.
  let bytesSinceElementStart = 0;
  parser.onValue = (info) => {
    if (info.partial) {
      handleContainerKeySignal(counts, info.key, info.stack);
      return;
    }
    // Any completed element (recognized shape or not) closes the current
    // element's measurement window -- the NEXT element starts fresh.
    bytesSinceElementStart = 0;
    const format = formatForElementEvent(info.key, info.stack);
    if (!format) {
      return;
    }
    try {
      accumulateElement(counts, format, info.value);
    } catch (err) {
      parseError = err;
    }
  };

  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: STREAM_READ_BUFFER_SIZE });
  try {
    for await (const chunk of stream as AsyncIterable<string | Buffer>) {
      if (parser.isEnded) {
        break;
      }
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      bytesSinceElementStart += Buffer.byteLength(text, "utf8");
      if (bytesSinceElementStart > MAX_SINGLE_ELEMENT_BYTES) {
        throw new GoogleMapsElementTooLargeError(
          `a single Timeline array element exceeded ${MAX_SINGLE_ELEMENT_BYTES} bytes`
        );
      }
      parser.write(text);
      if (parseError) {
        throw parseError;
      }
    }
  } finally {
    stream.destroy();
  }
  if (parseError) {
    throw parseError;
  }
  // The stream ending does not mean the document is well-formed: write()
  // doesn't throw on a syntactically-incomplete-but-so-far-valid document,
  // it just stops emitting events, leaving isEnded false. A truncated
  // upload must fail closed here rather than silently report a valid,
  // undercounted result -- mirrors archive-stream.ts's own isEnded check.
  if (!parser.isEnded) {
    try {
      parser.end();
    } catch {
      // The throw itself is the truncation signal.
    }
    if (!parser.isEnded) {
      throw new Error("google_maps: Timeline document did not close (truncated or malformed)");
    }
  }
  if (counts.recognizedFormatsSeen.size === 0 && (await peekRootIsArray(path))) {
    counts.recognizedFormatsSeen.add("timeline_objects");
  }
  return counts;
}

/**
 * Resolves {@link StreamedCounts} into the single format label
 * `buildValidationFromCounts` needs, using the SAME precedence as the
 * buffer-backed `detectFormat`: exactly one format with elements wins
 * outright; zero formats with elements falls back to whichever recognized
 * shape ranks highest by FIXED priority (locations > semanticSegments >
 * timelineObjects) among those actually seen -- not stream order, matching
 * detectFormat's own fallback exactly; more than one format with elements
 * is unreachable here (accumulateElement already throws before a second
 * format's element is counted).
 */
function resolveStreamedFormat(counts: StreamedCounts): GoogleMapsSourceFormat | null {
  if (counts.formatsWithElements.size === 1) {
    const [onlyFormat] = counts.formatsWithElements;
    return onlyFormat ?? null;
  }
  for (const key of SHAPE_KEYS) {
    const format = SHAPE_KEY_TO_FORMAT[key];
    if (counts.recognizedFormatsSeen.has(format)) {
      return format;
    }
  }
  return null;
}

/**
 * File-descriptor-backed variant of {@link validateGoogleMapsTimelineArtifact}:
 * the artifact's bytes are never buffered whole and the document is never
 * `JSON.parse`d as one value -- `@streamparser/json` (already proven for
 * twitter_archive's own multi-hundred-MB streaming reader) parses the file
 * token-by-token off disk, and only running point/segment counts plus a
 * running min/max timestamp are retained, matching the fd-backed pattern
 * already proven for WhatsApp and Netflix in this same dispatch table.
 * `path` is caller-owned; this function only opens a read stream from it, it
 * neither creates nor deletes the file.
 */
export async function validateGoogleMapsTimelineArtifactFromFile(
  path: string,
  fileSize: number,
  options: GoogleMapsTimelineFileValidationOptions
): Promise<GoogleMapsTimelineValidation> {
  if (options.maxFileBytes !== null && options.maxFileBytes !== undefined && fileSize > options.maxFileBytes) {
    return tooLargeResult(options.fileSha256);
  }

  let counts: StreamedCounts;
  try {
    counts = await streamCounts(path);
  } catch (err) {
    // An oversized record and a mixed-shape document each get their own
    // remediation text distinct from the generic unrecognized-format
    // message.
    if (err instanceof GoogleMapsElementTooLargeError) {
      return tooLargeResult(options.fileSha256, OVERSIZED_RECORD_REMEDIATION);
    }
    if (err instanceof GoogleMapsMixedShapeError) {
      return unsupportedResult(options.fileSha256, MIXED_SHAPE_REMEDIATION);
    }
    return unsupportedResult(options.fileSha256);
  }

  const format = resolveStreamedFormat(counts);
  if (!format) {
    return unsupportedResult(options.fileSha256);
  }

  return buildValidationFromCounts(
    format,
    counts.pointCount,
    counts.segmentCount,
    { end: counts.maxTimestamp, start: counts.minTimestamp },
    options.fileSha256,
    options
  );
}
