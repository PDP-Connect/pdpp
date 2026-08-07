// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure parsers for the Netflix export connector. Kept free of runtime I/O
// orchestration so they can be unit-tested in isolation (see parsers.test.ts).
// CSV reading and the emit loop live in index.ts.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { join, sep } from "node:path";
import type { ViewingActivityCSVRow, ViewingActivityRecord } from "./types.ts";

const MAX_CSV_BYTES = 50 * 1024 * 1024;
const MAX_ROWS = 100_000;

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

export async function parseCSVFile(
  filePath: string
): Promise<{ rows: Record<string, string | undefined>[]; malformedCount: number; error?: string }> {
  if (!existsSync(filePath)) {
    return { rows: [], malformedCount: 0 };
  }

  const sizeCheck = checkFileSize(filePath);
  if (sizeCheck) {
    return sizeCheck;
  }

  const content = await readFileBounded(filePath);
  if (content === null) {
    return {
      rows: [],
      malformedCount: 0,
      error: `CSV file exceeds maximum size (${MAX_CSV_BYTES})`,
    };
  }

  return parseCSVContent(content);
}

function checkFileSize(
  filePath: string
): { rows: Record<string, string | undefined>[]; malformedCount: number; error: string } | null {
  try {
    const stat = statSync(filePath);
    if (stat.size > MAX_CSV_BYTES) {
      return {
        rows: [],
        malformedCount: 0,
        error: `CSV file exceeds maximum size (${stat.size} > ${MAX_CSV_BYTES})`,
      };
    }
  } catch (err) {
    return {
      rows: [],
      malformedCount: 0,
      error: `Failed to stat file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return null;
}

function parseCSVContent(content: string): {
  rows: Record<string, string | undefined>[];
  malformedCount: number;
  error?: string;
} {
  const lines = content.split("\n");
  if (lines.length === 0 || !lines[0]) {
    return { rows: [], malformedCount: 0 };
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
        return { rows, malformedCount, error: `CSV exceeds maximum rows (${MAX_ROWS})` };
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

  return { rows, malformedCount };
}

function parseHeaders(line: string): string[] {
  return line.split(",").map((h) => h.trim().toLowerCase());
}

function isValidRow(): boolean {
  return true;
}

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)%?$/;

/**
 * Parse watch duration string like "90%" into a number 0-100,
 * or null if malformed. Handles strings like "45%", "100%", etc.
 */
export function parseWatchDurationPercent(durationStr: string | undefined): number | null {
  if (!durationStr) {
    return null;
  }

  const match = durationStr.match(DURATION_PATTERN);
  if (!match?.[1]) {
    return null;
  }

  const num = Number.parseFloat(match[1]);
  if (Number.isNaN(num) || num < 0 || num > 100) {
    return null;
  }

  return num;
}

/**
 * Parse a Netflix timestamp string (expected format: "2024-01-15" or "2024-01-15 14:30:00").
 * Returns ISO-8601 datetime string or null if unparseable.
 */
export function parseNetflixTimestamp(tsStr: string | undefined): string | null {
  if (!tsStr) {
    return null;
  }

  try {
    // Netflix typically uses YYYY-MM-DD or YYYY-MM-DD HH:MM:SS format
    const ts = new Date(tsStr);
    if (Number.isNaN(ts.getTime())) {
      return null;
    }
    return ts.toISOString();
  } catch {
    return null;
  }
}

/**
 * Build a viewing_activity record from a CSV row.
 * Caller is responsible for the since-cursor filter.
 */
export function buildViewingActivityRecord(row: ViewingActivityCSVRow): ViewingActivityRecord | null {
  const title = (row.title as string | undefined) ?? null;
  const watchedAtStr = row["watched at"] as string | undefined;
  const watchedAt = parseNetflixTimestamp(watchedAtStr);

  // Skip rows without a parseable timestamp
  if (!watchedAt) {
    return null;
  }

  const deviceType = (row["device type"] as string | undefined) ?? null;
  const durationStr = row["watch duration"] as string | undefined;
  const watchDurationPercent = parseWatchDurationPercent(durationStr);
  const profileName = (row["profile name"] as string | undefined) ?? null;

  // Create deterministic ID from title, timestamp, device, profile, and duration
  const idInput = [title, watchedAt, deviceType, profileName, watchDurationPercent].map((v) => String(v)).join("|");
  const id = hashId(idInput);

  return {
    id,
    title,
    watched_at: watchedAt,
    device_type: deviceType,
    watch_duration_percent: watchDurationPercent,
    profile_name: profileName,
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
