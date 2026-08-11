// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
  GOOGLE_MAPS_SHAPE_KEY_TO_FORMAT,
  GOOGLE_MAPS_SHAPE_KEYS,
  GoogleMapsElementTooLargeError,
  GoogleMapsUnsupportedShapeError,
  streamGoogleMapsExport,
} from "./archive-stream.ts";
import { parseGoogleMapsExport, parseGoogleMapsExportElement } from "./parsers.ts";
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

class GoogleMapsMixedShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleMapsMixedShapeError";
  }
}

// The keyed-shape map is shared by the buffer-backed detector and the
// streaming event reader, so their format labels cannot drift apart.
const SHAPE_KEYS = GOOGLE_MAPS_SHAPE_KEYS;
const SHAPE_KEY_TO_FORMAT = GOOGLE_MAPS_SHAPE_KEY_TO_FORMAT;

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

function nonArrayShapeKeys(obj: Record<string, unknown>): string[] {
  return SHAPE_KEYS.filter((key) => Object.hasOwn(obj, key) && !Array.isArray(obj[key]));
}

function detectFormat(json: unknown): GoogleMapsSourceFormat | "unsupported" | "mixed" {
  if (Array.isArray(json)) {
    return "timeline_objects";
  }
  if (!json || typeof json !== "object") {
    return "unsupported";
  }
  const obj = json as Record<string, unknown>;
  if (nonArrayShapeKeys(obj).length > 0) {
    return "unsupported";
  }
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

/**
 * Parses one streamed element via {@link parseGoogleMapsExport} (through
 * {@link parseGoogleMapsExportElement}) and folds its points/segments into the
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
  const parsed = parseGoogleMapsExportElement(format, value);
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
 * {@link parseGoogleMapsExportElement} one at a time.
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

  await streamGoogleMapsExport(path, (event) => {
    if (event.kind === "shape") {
      counts.recognizedFormatsSeen.add(event.format);
      return;
    }
    accumulateElement(counts, event.format, event.value);
  });
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
    if (err instanceof GoogleMapsUnsupportedShapeError) {
      return unsupportedResult(options.fileSha256);
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
