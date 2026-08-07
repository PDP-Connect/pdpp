// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure parsers for the Netflix export connector. Kept free of runtime I/O
// orchestration so they can be unit-tested in isolation (see parsers.test.ts).
// CSV reading and the emit loop live in index.ts.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { join, sep } from "node:path";
import {
  hasZipLocalFileSignature,
  readZipEntries,
  ZipPolicyViolationError,
  type ZipReadPolicy,
  zipBasename,
} from "../../src/bounded-zip-archive.ts";
import type { ViewingActivityCSVRow, ViewingActivityRecord, ViewingActivitySourceSchema } from "./types.ts";

// The manifest's manual-upload max_file_bytes is set to this same value: the
// parser will never usefully read a larger ViewingActivity.csv anyway, so a
// looser upload cap would just accept files certain to be rejected later.
// Limitation: Netflix's official getmyinfo archive can bundle many other
// CSVs (ratings, search history, etc.) beyond viewing activity, so a real
// full-archive upload could exceed this cap even when ViewingActivity.csv
// itself is small — see the manifest's large_file_fallback guidance.
const MAX_CSV_BYTES = 50 * 1024 * 1024;
const MAX_ROWS = 100_000;
const ZIP_EXT_RE = /\.zip$/i;
const CSV_EXT_RE = /\.csv$/i;

// Decompression-bomb gate for the getmyinfo zip archive: Netflix's real
// export can legitimately contain dozens of CSV files (ratings, search
// history, devices, etc.) whose combined declared size can exceed
// MAX_CSV_BYTES even though we only ever read ONE of them
// (ViewingActivity.csv). So the total-archive bound is generous (10x
// MAX_CSV_BYTES, comfortably above a real multi-CSV export) while the
// per-entry bound is pinned to MAX_CSV_BYTES — no single entry we might
// inflate can ever exceed the size the CSV parser accepts anyway. A single
// oversized entry or a many-small-bomb archive is rejected before (or
// during, via zlib's own maxOutputLength) inflation; see
// bounded-zip-archive.ts for how the bound is enforced inside inflateRawSync
// itself, not just as a post-inflate length check.
const NETFLIX_ZIP_POLICY: ZipReadPolicy = {
  maxEntries: 5000,
  maxEntryUncompressedBytes: MAX_CSV_BYTES,
  maxTotalUncompressedBytes: MAX_CSV_BYTES * 10,
};
const VIEWING_ACTIVITY_ENTRY_RE = /viewingactivity\.csv$/i;

// Length of sha256-derived record IDs — 24 hex chars = 96 bits of entropy.
const RECORD_ID_HASH_LENGTH = 24;

export function hashId(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, RECORD_ID_HASH_LENGTH);
}

/**
 * Parse a CSV file with proper quote and newline handling.
 * Supports RFC 4180 CSV format: quoted fields may contain commas and newlines,
 * escaped quotes are doubled ("").
 */
export function parseCSVLine(line: string, headers: string[]): Record<string, string | undefined> {
  const fields = splitCSVFields(line);
  return buildRecord(fields, headers);
}

function splitCSVFields(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  fields.push(current.trim());
  return fields;
}

function buildRecord(fields: string[], headers: string[]): Record<string, string | undefined> {
  const record: Record<string, string | undefined> = {};
  for (let i = 0; i < headers.length; i += 1) {
    const header = headers[i];
    if (header) {
      record[header] = fields[i] === "" ? undefined : fields[i];
    }
  }
  return record;
}

/**
 * Validate that a file path is within expectedDir and not a symlink escape.
 * Resolves both paths to absolute, checks containment, rejects symlinks.
 */
export function validateArchivePath(filePath: string, expectedDir: string): { ok: boolean; error?: string } {
  try {
    const realFile = realpathSync(filePath);
    const realDir = realpathSync(expectedDir);

    if (!realFile.startsWith(realDir + sep) && realFile !== realDir) {
      return { ok: false, error: "Path traversal detected: file outside expected directory" };
    }

    const stats = statSync(filePath);
    if (stats.isSymbolicLink()) {
      return { ok: false, error: "Symbolic links not allowed in archive imports" };
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `Archive path validation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function hasBalancedQuotes(line: string): boolean {
  let quoteCount = 0;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '"') {
      if (line[i + 1] === '"') {
        i += 1;
      } else {
        quoteCount += 1;
      }
    }
  }
  return quoteCount % 2 === 0;
}

async function readFileBounded(filePath: string): Promise<string | null> {
  const fd = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let content = "";
    let totalBytes = 0;

    while (totalBytes < MAX_CSV_BYTES) {
      const toRead = Math.min(buffer.length, MAX_CSV_BYTES - totalBytes);
      const { bytesRead } = await fd.read(buffer, 0, toRead);
      if (bytesRead === 0) {
        break;
      }

      content += buffer.toString("utf8", 0, bytesRead);
      totalBytes += bytesRead;
    }

    // If we've read exactly MAX_CSV_BYTES, probe to detect oversized files.
    // The probe checks if there's more data; if so, the file exceeds the cap.
    if (totalBytes === MAX_CSV_BYTES) {
      const probe = await fd.read(Buffer.alloc(1));
      if (probe.bytesRead > 0) {
        return null;
      }
    } else if (totalBytes > MAX_CSV_BYTES) {
      // This shouldn't happen due to the loop condition, but catch it as defensive check
      return null;
    }

    return content;
  } catch {
    return null;
  } finally {
    await fd.close();
  }
}

export async function parseCSVFile(filePath: string): Promise<{
  headers: string[];
  rows: Record<string, string | undefined>[];
  malformedCount: number;
  error?: string;
}> {
  if (!existsSync(filePath)) {
    return { headers: [], rows: [], malformedCount: 0 };
  }

  const sizeCheck = checkFileSize(filePath);
  if (sizeCheck) {
    return sizeCheck;
  }

  const content = await readFileBounded(filePath);
  if (content === null) {
    return {
      headers: [],
      rows: [],
      malformedCount: 0,
      error: `CSV file exceeds maximum size (${MAX_CSV_BYTES})`,
    };
  }

  return parseCSVContent(content);
}

function checkFileSize(
  filePath: string
): { headers: string[]; rows: Record<string, string | undefined>[]; malformedCount: number; error: string } | null {
  try {
    const stat = statSync(filePath);
    if (stat.size > MAX_CSV_BYTES) {
      return {
        headers: [],
        rows: [],
        malformedCount: 0,
        error: `CSV file exceeds maximum size (${stat.size} > ${MAX_CSV_BYTES})`,
      };
    }
  } catch (err) {
    return {
      headers: [],
      rows: [],
      malformedCount: 0,
      error: `Failed to stat file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return null;
}

export function parseCSVContentForValidation(content: string): {
  headers: string[];
  rows: Record<string, string | undefined>[];
  malformedCount: number;
  error?: string;
} {
  if (Buffer.byteLength(content, "utf8") > MAX_CSV_BYTES) {
    return { headers: [], rows: [], malformedCount: 0, error: `CSV file exceeds maximum size (${MAX_CSV_BYTES})` };
  }
  return parseCSVContent(content);
}

function parseCSVContent(content: string): {
  headers: string[];
  rows: Record<string, string | undefined>[];
  malformedCount: number;
  error?: string;
} {
  const lines = content.split("\n");
  if (lines.length === 0 || !lines[0]) {
    return { headers: [], rows: [], malformedCount: 0 };
  }

  const headers = parseHeaders(lines[0]);
  const rows: Record<string, string | undefined>[] = [];
  let malformedCount = 0;
  let currentLine = "";

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) {
      continue;
    }

    currentLine = currentLine === "" ? line : `${currentLine}\n${line}`;

    if (hasBalancedQuotes(currentLine)) {
      if (rows.length >= MAX_ROWS) {
        return { headers, rows, malformedCount, error: `CSV exceeds maximum rows (${MAX_ROWS})` };
      }

      if (isValidRow()) {
        rows.push(parseCSVLine(currentLine, headers));
      } else {
        malformedCount += 1;
      }

      currentLine = "";
    }
  }

  if (currentLine !== "" && !hasBalancedQuotes(currentLine)) {
    malformedCount += 1;
  }

  return { headers, rows, malformedCount };
}

function parseHeaders(line: string): string[] {
  return line.split(",").map((h) => h.trim().toLowerCase());
}

function isValidRow(): boolean {
  return true;
}

// Netflix's immediate "Download all" button on netflix.com/viewingactivity
// produces NetflixViewingHistory.csv with exactly these two headers.
const DIRECT_HISTORY_HEADERS = ["title", "date"];
// The official getmyinfo export's CONTENT_INTERACTION/ViewingActivity.csv
// has this fixed header set (Netflix's documented data-dictionary columns).
const FULL_EXPORT_HEADERS = [
  "profile name",
  "start time",
  "duration",
  "attributes",
  "title",
  "supplemental video type",
  "device type",
  "bookmark",
  "latest bookmark",
  "country",
];

/**
 * Detect which of Netflix's two distinct CSV schemas a parsed header row
 * matches. Headers are matched by normalized substring (Netflix appends unit
 * suffixes like "(UTC)"/"(H:MM:SS)" that we don't want to hard-code exact
 * matches against), and BOTH schemas' full header sets must be present — a
 * header row that's neither, or a mix of both, is rejected as unrecognized
 * rather than guessed at.
 */
export function detectViewingActivitySchema(headers: string[]): ViewingActivitySourceSchema | null {
  const normalized = headers.map((h) => h.trim().toLowerCase());
  const hasAll = (required: string[]) =>
    required.every((req) => normalized.some((h) => h === req || h.startsWith(`${req} `) || h.startsWith(`${req}(`)));

  const isDirectHistory = hasAll(DIRECT_HISTORY_HEADERS) && normalized.length <= DIRECT_HISTORY_HEADERS.length + 1;
  const isFullExport = hasAll(FULL_EXPORT_HEADERS);

  if (isFullExport) {
    return "full_export";
  }
  if (isDirectHistory) {
    return "direct_history";
  }
  return null;
}

function findHeaderKey(row: ViewingActivityCSVRow, prefix: string): string | undefined {
  return Object.keys(row).find((k) => k === prefix || k.startsWith(`${prefix} `) || k.startsWith(`${prefix}(`));
}

function rowValue(row: ViewingActivityCSVRow, prefix: string): string | undefined {
  const key = findHeaderKey(row, prefix);
  return key ? (row[key] as string | undefined) : undefined;
}

const ISO_DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SLASH_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/**
 * Parse a direct_history "Date" value into a calendar day. Netflix's direct
 * download uses locale-dependent date formats (observed: DD/MM/YYYY and
 * MM/DD/YYYY depending on account region) plus ISO YYYY-MM-DD. Only the
 * unambiguous forms are honestly supported: ISO (YYYY-MM-DD) and DD/MM/YYYY
 * with a day > 12 (which disambiguates the field order). An ambiguous
 * DD/MM/YYYY-vs-MM/DD/YYYY date (both fields <= 12) cannot be resolved
 * without knowing the account's locale, so it is rejected rather than
 * guessed — a wrong guess would silently corrupt the date.
 */
export function parseDirectHistoryDate(dateStr: string | undefined): string | null {
  if (!dateStr) {
    return null;
  }
  const trimmed = dateStr.trim();

  const isoMatch = trimmed.match(ISO_DATE_ONLY_RE);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return isoDayToUtcMidnight(Number(y), Number(m), Number(d));
  }

  const slashMatch = trimmed.match(SLASH_DATE_RE);
  if (slashMatch) {
    const [, aRaw, bRaw, yRaw] = slashMatch;
    const a = Number(aRaw);
    const b = Number(bRaw);
    const y = Number(yRaw);
    if (a > 12 && b <= 12) {
      // Unambiguous DD/MM/YYYY (first field can't be a month).
      return isoDayToUtcMidnight(y, b, a);
    }
    if (b > 12 && a <= 12) {
      // Unambiguous MM/DD/YYYY (second field can't be a month).
      return isoDayToUtcMidnight(y, a, b);
    }
    // Both fields <= 12: genuinely ambiguous between DD/MM and MM/DD without
    // locale context. Refuse to guess.
    return null;
  }

  return null;
}

function isoDayToUtcMidnight(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date.toISOString();
}

const FULL_EXPORT_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/;

/**
 * Parse full_export's "Start Time (UTC)" — Netflix documents this column as
 * already UTC, so no timezone conversion is applied; only ISO-8601-parseable
 * forms are accepted (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS).
 */
export function parseFullExportStartTime(tsStr: string | undefined): string | null {
  if (!tsStr) {
    return null;
  }
  const trimmed = tsStr.trim();
  if (!FULL_EXPORT_TIMESTAMP_RE.test(trimmed)) {
    return null;
  }
  const normalized = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  const withZ = normalized.length === 10 ? `${normalized}T00:00:00Z` : `${normalized}Z`;
  const parsed = new Date(withZ);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

const DURATION_HMS_RE = /^(\d+):([0-5]\d):([0-5]\d)$/;

/**
 * Parse full_export's "Duration (H:MM:SS)" into whole seconds. Returns null
 * for anything that doesn't match the documented H:MM:SS shape — no percent
 * or fractional-guessing, since Netflix's own column is already a duration,
 * not a completion percentage (the prior watch_duration_percent field was a
 * fabricated shape not grounded in either real Netflix CSV schema).
 */
export function parseFullExportDurationSeconds(durationStr: string | undefined): number | null {
  if (!durationStr) {
    return null;
  }
  const match = DURATION_HMS_RE.exec(durationStr.trim());
  if (!match) {
    return null;
  }
  const [, h, m, s] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

/**
 * Build a viewing_activity record from a CSV row, dispatching on the
 * detected schema. Returns null for rows that don't carry a parseable
 * date/timestamp for their schema — caller is responsible for the
 * since-cursor filter.
 */
export function buildViewingActivityRecord(
  row: ViewingActivityCSVRow,
  schema: ViewingActivitySourceSchema
): ViewingActivityRecord | null {
  if (schema === "direct_history") {
    return buildDirectHistoryRecord(row);
  }
  return buildFullExportRecord(row);
}

function buildDirectHistoryRecord(row: ViewingActivityCSVRow): ViewingActivityRecord | null {
  const title = rowValue(row, "title") ?? null;
  const watchedAt = parseDirectHistoryDate(rowValue(row, "date"));
  if (!watchedAt) {
    return null;
  }
  const idInput = [title, watchedAt].map((v) => String(v)).join("|");
  return {
    country: null,
    device_type: null,
    duration_seconds: null,
    id: hashId(idInput),
    profile_name: null,
    source_schema: "direct_history",
    title,
    watched_at: watchedAt,
    watched_at_precision: "day",
  };
}

function buildFullExportRecord(row: ViewingActivityCSVRow): ViewingActivityRecord | null {
  const title = rowValue(row, "title") ?? null;
  const watchedAt = parseFullExportStartTime(rowValue(row, "start time"));
  if (!watchedAt) {
    return null;
  }
  const deviceType = rowValue(row, "device type") ?? null;
  const profileName = rowValue(row, "profile name") ?? null;
  const durationSeconds = parseFullExportDurationSeconds(rowValue(row, "duration"));
  const country = rowValue(row, "country") ?? null;

  const idInput = [title, watchedAt, deviceType, profileName, durationSeconds].map((v) => String(v)).join("|");
  return {
    country,
    device_type: deviceType,
    duration_seconds: durationSeconds,
    id: hashId(idInput),
    profile_name: profileName,
    source_schema: "full_export",
    title,
    watched_at: watchedAt,
    watched_at_precision: "instant",
  };
}

/**
 * Resolve the ViewingActivity.csv file path within an extracted Netflix export archive.
 * Validates path containment and rejects symlink escapes.
 */
export function resolveViewingActivityFile(importDir: string): {
  path: string | null;
  error?: string | undefined;
} {
  const candidates = [
    join(importDir, "CONTENT_INTERACTION", "ViewingActivity.csv"),
    join(importDir, "content_interaction", "ViewingActivity.csv"),
    join(importDir, "Content Interaction", "ViewingActivity.csv"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const validation = validateArchivePath(candidate, importDir);
      if (!validation.ok) {
        return { path: null, error: validation.error ?? "unknown error" };
      }
      return { path: candidate, error: undefined };
    }
  }

  return { path: null, error: undefined };
}

/**
 * Search for and list all ViewingActivity.csv files in an import directory tree.
 * Used for archive traversal validation and diagnostics.
 */
export function findViewingActivityFiles(importDir: string): string[] {
  const found: string[] = [];

  function walkDir(dir: string, depth: number): void {
    if (depth > 10) {
      return;
    }

    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          walkDir(fullPath, depth + 1);
        } else if (entry.name.toLowerCase() === "viewingactivity.csv") {
          found.push(fullPath);
        }
      }
    } catch {
      // Permission denied or other FS error; skip this directory
    }
  }

  walkDir(importDir, 0);
  return found;
}

// ─── Uploaded-artifact extraction (browser Add Source / manual-upload path) ──
//
// The manual-upload route writes the raw uploaded file flat into the import
// dir (no server-side unzip). A raw ViewingActivity.csv is accepted directly;
// Netflix's official "getmyinfo" archive is a zip, so we search its entries
// (via the shared bounded zip reader used by other manual-upload connectors)
// for a *ViewingActivity.csv file at any depth.

export type NetflixExportArtifactFormat = "viewing_activity_csv" | "viewing_activity_zip";

export interface ExtractedNetflixExportArtifact {
  csvText: string;
  format: NetflixExportArtifactFormat;
  sourceEntryName: string;
}

/**
 * Why an artifact extraction failed, distinguishing "this archive is too
 * large to safely process" (a real, valid Netflix export the owner should be
 * told to shrink or use a fallback for) from "this isn't a recognizable
 * Netflix export at all" (corrupt, wrong file type, or missing
 * ViewingActivity.csv). Callers (validation.ts, index.ts) MUST preserve this
 * distinction in what they report — collapsing both into one generic
 * "unsupported" status hides an actionable, honest signal from the owner.
 */
export type NetflixExportExtractionFailureCode =
  | "entry_too_large"
  | "no_viewing_activity_entry"
  | "too_many_entries"
  | "total_too_large"
  | "unsupported_shape";

export interface NetflixExportExtractionFailure {
  readonly code: NetflixExportExtractionFailureCode;
  readonly message: string;
}

export type NetflixExportExtractionResult =
  | ({ ok: true } & ExtractedNetflixExportArtifact)
  | ({ ok: false } & NetflixExportExtractionFailure);

const ZIP_POLICY_CODE_TO_EXTRACTION_CODE: Record<
  InstanceType<typeof ZipPolicyViolationError>["code"],
  NetflixExportExtractionFailureCode
> = {
  entry_too_large: "entry_too_large",
  too_many_entries: "too_many_entries",
  total_too_large: "total_too_large",
};

/**
 * Extract ViewingActivity.csv text from an uploaded artifact: either the CSV
 * file directly, or Netflix's official export zip. Returns a discriminated
 * result rather than null so callers can distinguish an oversized-but-real
 * export (`entry_too_large`/`total_too_large`/`too_many_entries` — a
 * decompression-bomb-policy rejection) from a genuinely unrecognized/corrupt
 * artifact (`unsupported_shape`/`no_viewing_activity_entry`).
 */
export function extractViewingActivityArtifact(
  filename: string,
  input: Buffer | Uint8Array | string
): NetflixExportExtractionResult {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);

  if (ZIP_EXT_RE.test(filename) || hasZipLocalFileSignature(bytes)) {
    let entries: ReturnType<typeof readZipEntries>;
    try {
      entries = readZipEntries(bytes, NETFLIX_ZIP_POLICY);
    } catch (err) {
      if (err instanceof ZipPolicyViolationError) {
        return {
          ok: false,
          code: ZIP_POLICY_CODE_TO_EXTRACTION_CODE[err.code],
          message: err.message,
        };
      }
      return { ok: false, code: "unsupported_shape", message: "The uploaded zip could not be read." };
    }
    const match = entries.find((entry) => VIEWING_ACTIVITY_ENTRY_RE.test(zipBasename(entry.name)));
    if (!match) {
      return {
        ok: false,
        code: "no_viewing_activity_entry",
        message: "No ViewingActivity.csv entry was found in the uploaded zip archive.",
      };
    }
    let csvText: string;
    try {
      csvText = match.data().toString("utf8");
    } catch (err) {
      if (err instanceof ZipPolicyViolationError) {
        return {
          ok: false,
          code: ZIP_POLICY_CODE_TO_EXTRACTION_CODE[err.code],
          message: err.message,
        };
      }
      return {
        ok: false,
        code: "unsupported_shape",
        message: "The ViewingActivity.csv entry in the uploaded zip could not be extracted.",
      };
    }
    return { ok: true, csvText, format: "viewing_activity_zip", sourceEntryName: match.name };
  }

  if (CSV_EXT_RE.test(filename)) {
    return { ok: true, csvText: bytes.toString("utf8"), format: "viewing_activity_csv", sourceEntryName: filename };
  }

  return {
    ok: false,
    code: "unsupported_shape",
    message: "Choose ViewingActivity.csv, or the .zip archive from netflix.com/account/getmyinfo.",
  };
}
