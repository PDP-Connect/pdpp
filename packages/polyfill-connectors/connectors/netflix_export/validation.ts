// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { buildViewingActivityRecord, extractViewingActivityArtifact, parseCSVContentForValidation } from "./parsers.ts";
import type { ViewingActivityRecord } from "./types.ts";

export type NetflixExportValidationStatus = "valid" | "duplicate" | "empty" | "unsupported" | "too_large";

export interface NetflixExportValidationOptions {
  readonly existingFileHashes?: readonly string[];
  readonly fileName?: string | null;
  readonly maxFileBytes?: number | null;
}

export interface NetflixExportValidation {
  readonly date_range: { readonly end: string | null; readonly start: string | null };
  readonly detected_format: "viewing_activity_csv" | "viewing_activity_zip" | "unsupported";
  readonly estimated_records: number;
  readonly file_sha256: string;
  readonly remediation: string | null;
  readonly status: NetflixExportValidationStatus;
}

function minMax(values: readonly string[]): { end: string | null; start: string | null } {
  const sorted = values.filter(Boolean).sort();
  return { end: sorted.at(-1) ?? null, start: sorted[0] ?? null };
}

function remediationFor(status: NetflixExportValidationStatus): string | null {
  switch (status) {
    case "duplicate":
      return "This export was already imported. Request a newer export from netflix.com/account/getmyinfo if you need more recent activity.";
    case "empty":
      return "This looks like a Netflix viewing activity export, but it does not contain importable rows.";
    case "too_large":
      return "This export is larger than the upload limit. Use the import-folder handoff for large archives.";
    case "unsupported":
      return "Choose ViewingActivity.csv, or the .zip archive from netflix.com/account/getmyinfo. Other Netflix export files are not supported.";
    case "valid":
      return null;
    default:
      return null;
  }
}

export function validateNetflixExportArtifact(
  input: Buffer | Uint8Array | string,
  options: NetflixExportValidationOptions = {}
): NetflixExportValidation {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  const fileSha256 = createHash("sha256").update(bytes).digest("hex");
  const base = {
    date_range: { end: null, start: null },
    detected_format: "unsupported" as const,
    estimated_records: 0,
    file_sha256: fileSha256,
  };

  if (options.maxFileBytes !== null && options.maxFileBytes !== undefined && bytes.byteLength > options.maxFileBytes) {
    return { ...base, remediation: remediationFor("too_large"), status: "too_large" };
  }

  const artifact = extractViewingActivityArtifact(options.fileName ?? "ViewingActivity.csv", bytes);
  if (!artifact) {
    return { ...base, remediation: remediationFor("unsupported"), status: "unsupported" };
  }

  const { rows } = parseCSVContentForValidation(artifact.csvText);
  const records = rows
    .map((row) => buildViewingActivityRecord(row))
    .filter((rec): rec is ViewingActivityRecord => rec !== null);
  const dateRange = minMax(records.map((rec) => rec.watched_at));

  let status: NetflixExportValidationStatus = "valid";
  if (new Set(options.existingFileHashes ?? []).has(fileSha256)) {
    status = "duplicate";
  } else if (records.length === 0) {
    status = "empty";
  }

  return {
    date_range: dateRange,
    detected_format: artifact.format,
    estimated_records: records.length,
    file_sha256: fileSha256,
    remediation: remediationFor(status),
    status,
  };
}
