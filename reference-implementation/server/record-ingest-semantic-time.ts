// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SQLite-path manifest-resolved semantic-time coercion + record-identity
 * validation for ingest. (The Postgres backend has its OWN parallel
 * semantic-time path in postgres-records.js — this module is NOT a single
 * source of truth across backends, and read/query/aggregate time semantics
 * still live in records.js. Scope here is deliberately the SQLite ingest-stamp
 * helpers; a cross-backend "semantic time" consolidation is a separate, larger
 * tranche.)
 *
 * Invariant (within the SQLite ingest path): how connectorId+streamName resolve
 * to consent_time_field / primary_key, and epoch-aware semantic-time coercion
 * for the stored ingest stamp, are centralized here rather than inlined at the
 * bottom of records.js.
 *
 * Entry points called by the SQLite ingest path in records.js:
 *   computeIngestSemanticTime  — returns the ISO semantic timestamp to stamp
 *   validateRecordIdentity     — asserts primary-key field/value consistency
 *
 * Additional exports (used by the SQLite dataset-summary read-model + stream
 * projections in records.js):
 *   getManifestConsentTimeField
 *   getManifestPrimaryKeyFields
 *   coerceSemanticTimeValue
 *   SEMANTIC_TIME_EPOCH_MS_THRESHOLD
 */

import { getOne, referenceQueries } from "../lib/db.ts";
import { assertRecordIdentity, normalizePrimaryKey } from "./record-expand-helpers.js";

// Row shape returned by the manifest lookup query: a single `manifest`
// column holding the JSON-serialized connector manifest (or absent).
interface ManifestRow {
  manifest?: string;
}

// Structural view of a manifest stream entry: only the fields read here.
interface ManifestStreamShape {
  consent_time_field?: unknown;
  cursor_field?: unknown;
  name?: unknown;
  primary_key?: unknown;
}

interface ParsedManifest {
  streams?: unknown;
}

// Below this, a numeric timestamp is treated as Unix SECONDS; at or above it,
// as Unix MILLISECONDS. 1e12 seconds is the year 33658 and 1e12 ms is 2001 —
// any real record date is unambiguous against this boundary. Mirrors the
// constant in packages/operator-ui/src/lib/search-record-timestamps.ts so
// ingest and search coerce timestamps identically.
export const SEMANTIC_TIME_EPOCH_MS_THRESHOLD = 1e12;

// A valid SQL/manifest field identifier: a letter or underscore followed by
// word characters. Used to reject injection-shaped consent_time_field names.
const FIELD_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function getManifestConsentTimeField(connectorId: string, streamName: string): string | null {
  const row = getOne<ManifestRow>(referenceQueries.authConnectorsGetManifestById, [connectorId]);
  if (!row?.manifest) {
    return null;
  }

  let manifest: ParsedManifest;
  try {
    manifest = JSON.parse(row.manifest) as ParsedManifest;
  } catch {
    return null;
  }
  const stream = Array.isArray(manifest?.streams)
    ? (manifest.streams as ManifestStreamShape[]).find((candidate) => candidate?.name === streamName)
    : null;
  const field = stream?.consent_time_field;
  if (typeof field !== "string" || !field) {
    return null;
  }
  return FIELD_IDENTIFIER_PATTERN.test(field) ? field : null;
}

// Coerce a manifest-declared timestamp field value to a clean ISO-8601 string,
// matching coerceTimestampValue in search-record-timestamps.ts: an ISO string
// passes through (trimmed); a positive finite NUMBER is a Unix epoch (seconds
// below the threshold, ms at/above) -> ISO. Anything else -> null so the
// caller falls back to emitted_at.
export function coerceSemanticTimeValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value >= SEMANTIC_TIME_EPOCH_MS_THRESHOLD ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

// Compute the SEMANTIC time (when the thing happened) to stamp on a record at
// ingest. Resolves the stream's manifest consent_time_field (preferred) then
// cursor_field, reads that field from the record `data`, and coerces it
// epoch-aware. Falls back to `effectiveEmittedAt` when no semantic field is
// declared or the value is missing/unparseable — so semantic_time is never
// empty and the merged-timeline sort degrades gracefully to ingest order. Loads
// the manifest via the same query getManifestConsentTimeField uses.
export function computeIngestSemanticTime(
  connectorId: string,
  streamName: string,
  data: unknown,
  effectiveEmittedAt: string
): string {
  if (!data || typeof data !== "object") {
    return effectiveEmittedAt;
  }
  const row = getOne<ManifestRow>(referenceQueries.authConnectorsGetManifestById, [connectorId]);
  if (!row?.manifest) {
    return effectiveEmittedAt;
  }
  let manifest: ParsedManifest;
  try {
    manifest = JSON.parse(row.manifest) as ParsedManifest;
  } catch {
    return effectiveEmittedAt;
  }
  const stream = Array.isArray(manifest?.streams)
    ? (manifest.streams as ManifestStreamShape[]).find((candidate) => candidate?.name === streamName)
    : null;
  if (!stream) {
    return effectiveEmittedAt;
  }
  // consent_time_field is the declared semantic/authored time; cursor_field is
  // the incremental sort field (often the same authored time). Prefer the former.
  const candidates: string[] = [];
  for (const field of [stream.consent_time_field, stream.cursor_field]) {
    if (typeof field === "string" && field && !candidates.includes(field)) {
      candidates.push(field);
    }
  }
  const record = data as Record<string, unknown>;
  for (const field of candidates) {
    const coerced = coerceSemanticTimeValue(record[field]);
    if (coerced) {
      return coerced;
    }
  }
  return effectiveEmittedAt;
}

// Returns the manifest-declared primary_key field names for a stream, or null
// when the manifest/stream is unavailable. Mirrors getManifestConsentTimeField's
// load path so identity validation uses the same manifest source of truth.
export function getManifestPrimaryKeyFields(connectorId: string, streamName: string): string[] | null {
  const row = getOne<ManifestRow>(referenceQueries.authConnectorsGetManifestById, [connectorId]);
  if (!row?.manifest) {
    return null;
  }

  let manifest: ParsedManifest;
  try {
    manifest = JSON.parse(row.manifest) as ParsedManifest;
  } catch {
    return null;
  }
  const stream = Array.isArray(manifest?.streams)
    ? (manifest.streams as ManifestStreamShape[]).find((candidate) => candidate?.name === streamName)
    : null;
  const fields = normalizePrimaryKey(stream?.primary_key);
  return fields.length > 0 ? fields : null;
}

// Validate the record `key` tuple against manifest-declared primary-key fields,
// delegating to the shared assertRecordIdentity guard so SQLite and Postgres
// stores enforce identical identity rules.
export function validateRecordIdentity({
  connectorId,
  stream,
  key,
  data,
}: {
  connectorId: string;
  stream: string;
  key: unknown;
  data: unknown;
}): void {
  const fields = getManifestPrimaryKeyFields(connectorId, stream) ?? [];
  assertRecordIdentity(fields, key, data);
}
