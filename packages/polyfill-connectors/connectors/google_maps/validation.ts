import { createHash } from "node:crypto";
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

function detectFormat(json: unknown): GoogleMapsSourceFormat | "unsupported" {
  if (Array.isArray(json)) {
    return "timeline_objects";
  }
  if (!json || typeof json !== "object") {
    return "unsupported";
  }
  const obj = json as Record<string, unknown>;
  if (Array.isArray(obj.locations)) {
    return "legacy_records";
  }
  if (Array.isArray(obj.semanticSegments)) {
    return "semantic_segments";
  }
  if (Array.isArray(obj.timelineObjects)) {
    return "timeline_objects";
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
      return "This file is larger than the upload limit. Use the import-folder handoff for large archives.";
    case "unsupported":
      return "Choose the Timeline JSON export from Google Maps on your phone. Google account passwords and Data Portability archives are not Timeline exports.";
    case "valid":
      return null;
    default:
      return null;
  }
}

export function validateGoogleMapsTimelineArtifact(
  input: Uint8Array | string,
  options: GoogleMapsTimelineValidationOptions = {}
): GoogleMapsTimelineValidation {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  const fileSha256 = createHash("sha256").update(bytes).digest("hex");
  if (options.maxFileBytes != null && bytes.byteLength > options.maxFileBytes) {
    return {
      date_range: { end: null, start: null },
      detected_format: "unsupported",
      estimated_points: 0,
      estimated_segments: 0,
      file_sha256: fileSha256,
      remediation: remediationFor("too_large"),
      status: "too_large",
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    return {
      date_range: { end: null, start: null },
      detected_format: "unsupported",
      estimated_points: 0,
      estimated_segments: 0,
      file_sha256: fileSha256,
      remediation: remediationFor("unsupported"),
      status: "unsupported",
    };
  }

  const detectedFormat = detectFormat(json);
  if (detectedFormat === "unsupported") {
    return {
      date_range: { end: null, start: null },
      detected_format: detectedFormat,
      estimated_points: 0,
      estimated_segments: 0,
      file_sha256: fileSha256,
      remediation: remediationFor("unsupported"),
      status: "unsupported",
    };
  }

  const parsed = parseGoogleMapsExport(json);
  const dateRange = minMax([
    ...parsed.points.map((point) => point.timestamp),
    ...parsed.segments.map((segment) => segment.start_time),
  ]);
  let status: TimelineValidationStatus = "valid";
  const previousHashes = new Set(options.existingFileHashes ?? []);
  if (previousHashes.has(fileSha256)) {
    status = "duplicate";
  } else if (parsed.points.length === 0 && parsed.segments.length === 0) {
    status = "empty";
  } else if (options.importedThrough && dateRange.end && dateRange.end <= options.importedThrough) {
    status = "stale";
  }

  return {
    date_range: dateRange,
    detected_format: detectedFormat,
    estimated_points: parsed.points.length,
    estimated_segments: parsed.segments.length,
    file_sha256: fileSha256,
    remediation: remediationFor(status),
    status,
  };
}
