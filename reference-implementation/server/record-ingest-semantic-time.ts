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
 *   computeIngestSemanticTime  — the semantic timestamp to stamp, or
 *                                SEMANTIC_TIME_UNKNOWN when the record has none
 *   validateRecordIdentity     — asserts primary-key field/value consistency
 *
 * Additional exports (used by the SQLite dataset-summary read-model + stream
 * projections in records.js):
 *   getManifestConsentTimeField
 *   getManifestPrimaryKeyFields
 *
 * The pure coercion primitives (coerceSemanticTimeValue,
 * SEMANTIC_TIME_EPOCH_MS_THRESHOLD, SEMANTIC_TIME_UNKNOWN) live in the leaf
 * module semantic-time-coercion.ts so the SQLite and Postgres ingest paths
 * share ONE definition; import them from there.
 */

import { getOne, referenceQueries } from "../lib/db.ts";
import { assertRecordIdentity, normalizePrimaryKey } from "./record-expand-helpers.ts";
import { coerceSemanticTimeValue, SEMANTIC_TIME_UNKNOWN } from "./semantic-time-coercion.ts";

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
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  const stream = Array.isArray(manifest?.streams)
    ? (manifest.streams as ManifestStreamShape[]).find((candidate) => candidate?.name === streamName)
    : null;
  const field = stream?.consent_time_field;
  return typeof field === "string" && field ? field : null;
}

// Compute the SEMANTIC time (when the thing happened) to stamp on a record at
// ingest. Resolves the stream's manifest consent_time_field (preferred) then
// cursor_field, reads that field from the record `data`, and coerces it
// epoch-aware. Yields SEMANTIC_TIME_UNKNOWN when no semantic field is declared
// or the value is missing/unparseable, so an unknown date is stored as absent
// rather than backfilled with ingest time; readers COALESCE to emitted_at for
// ordering. Loads the manifest via the same query getManifestConsentTimeField
// uses. `effectiveEmittedAt` is no longer consulted and is not a parameter.
export function computeIngestSemanticTime(connectorId: string, streamName: string, data: unknown): string {
  if (!data || typeof data !== "object") {
    return SEMANTIC_TIME_UNKNOWN;
  }
  const row = getOne<ManifestRow>(referenceQueries.authConnectorsGetManifestById, [connectorId]);
  if (!row?.manifest) {
    return SEMANTIC_TIME_UNKNOWN;
  }
  let manifest: ParsedManifest;
  try {
    manifest = JSON.parse(row.manifest) as ParsedManifest;
  } catch {
    return SEMANTIC_TIME_UNKNOWN;
  }
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  const stream = Array.isArray(manifest?.streams)
    ? (manifest.streams as ManifestStreamShape[]).find((candidate) => candidate?.name === streamName)
    : null;
  if (!stream) {
    return SEMANTIC_TIME_UNKNOWN;
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
  return SEMANTIC_TIME_UNKNOWN;
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
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
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
