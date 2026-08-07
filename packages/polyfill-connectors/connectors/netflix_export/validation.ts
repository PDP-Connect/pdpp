// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
  buildViewingActivityRecord,
  detectViewingActivitySchema,
  extractViewingActivityArtifact,
  parseCSVContentForValidation,
} from "./parsers.ts";
import type { ViewingActivityRecord, ViewingActivitySourceSchema } from "./types.ts";

export type NetflixExportValidationStatus = "valid" | "duplicate" | "empty" | "unsupported" | "too_large";

export interface NetflixExportValidationOptions {
  readonly existingFileHashes?: readonly string[];
  readonly fileName?: string | null;
  readonly maxFileBytes?: number | null;
}

export interface NetflixExportValidation {
  readonly date_range: { readonly end: string | null; readonly start: string | null };
  readonly detected_format: "viewing_activity_csv" | "viewing_activity_zip" | "unsupported";
  readonly detected_schema: ViewingActivitySourceSchema | null;
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
      return "This is a real Netflix export, but it (or the ViewingActivity.csv inside it) is larger than PDPP can safely process from a browser upload. Extract the archive yourself and upload just CONTENT_INTERACTION/ViewingActivity.csv, or use the server import-folder handoff.";
    case "unsupported":
      return "Choose the CSV from Download all on netflix.com/viewingactivity, ViewingActivity.csv, or the .zip archive from netflix.com/account/getmyinfo. Other files are not supported.";
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
    detected_schema: null,
    estimated_records: 0,
    file_sha256: fileSha256,
  };

  if (options.maxFileBytes !== null && options.maxFileBytes !== undefined && bytes.byteLength > options.maxFileBytes) {
    return { ...base, remediation: remediationFor("too_large"), status: "too_large" };
  }

  const artifact = extractViewingActivityArtifact(options.fileName ?? "ViewingActivity.csv", bytes);
  if (!artifact.ok) {
    // entry_too_large / total_too_large / too_many_entries mean this IS a
    // real (or plausibly real) export that tripped the decompression-bomb
    // policy — report too_large, not unsupported, so the owner gets
    // actionable guidance instead of being told their real export is
    // unrecognized. no_viewing_activity_entry / unsupported_shape mean the
    // artifact genuinely isn't (or doesn't contain) a Netflix export.
    const isSizePolicyRejection =
      artifact.code === "entry_too_large" ||
      artifact.code === "total_too_large" ||
      artifact.code === "too_many_entries";
    const status: NetflixExportValidationStatus = isSizePolicyRejection ? "too_large" : "unsupported";
    return { ...base, remediation: remediationFor(status), status };
  }

  const { headers, rows } = parseCSVContentForValidation(artifact.csvText);
  const schema = detectViewingActivitySchema(headers);
  if (!schema) {
    // Neither direct_history nor full_export header set matched — including
    // a mixed/partial header row. Never guessed at; reported as unsupported.
    return { ...base, remediation: remediationFor("unsupported"), status: "unsupported" };
  }

  const records = rows
    .map((row) => buildViewingActivityRecord(row, schema))
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
    detected_schema: schema,
    estimated_records: records.length,
    file_sha256: fileSha256,
    remediation: remediationFor(status),
    status,
  };
}
