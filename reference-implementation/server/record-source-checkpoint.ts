// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reset-safe record-source checkpoint.
 *
 * The composite of a per-connection `record_reset_generation` and the
 * sorted per-stream `version_counter` vector. Authoritative for whether
 * stored record facts (in `connector_summary_evidence`) match the current
 * record namespace. A stream/connector-wide reset advances the generation
 * over the union of distinct pre-reset stream namespaces that held a
 * `version_counter` row or a live canonical record — closing the ABA
 * collision a bare version vector has (reset deletes `version_counter`;
 * reinsertion can recreate the same vector around different canonical
 * records).
 *
 * Normalized shape (byte-identical across backends, no JS `Number`):
 *
 *   { reset_generation: "<unsigned base-10 string, no leading zeros>",
 *     streams: [ { stream, max_version: "<unsigned base-10 string>" }, ... ] }
 *
 * `streams` is sorted by the UTF-8 byte sequence of the exact stream name.
 * Both backends read the integer columns as decimal TEXT (`CAST ... AS
 * TEXT` / `::text`) so values beyond 2^53-1 normalize identically instead
 * of losing precision through JS's default double-precision number
 * binding.
 *
 * Spec: openspec/changes/reconcile-active-summary-evidence/design.md
 *       "Exact reset-safe record checkpoint"
 */

import { allowUnboundedReadAcknowledged, getOne, referenceQueries } from "../lib/db.ts";
import { isPostgresStorageBackend, postgresQuery } from "./postgres-storage.js";

const LEADING_ZERO_RE = /^0+(?=\d)/;

export interface RecordSourceCheckpointStream {
  readonly max_version: string;
  readonly stream: string;
}

export interface RecordSourceCheckpoint {
  readonly reset_generation: string;
  readonly streams: readonly RecordSourceCheckpointStream[];
}

/** Strips leading zeros from an unsigned base-10 digit string; "0" for all-zero input. */
function stripLeadingZeros(digits: string): string {
  const stripped = digits.replace(LEADING_ZERO_RE, "");
  return stripped.length > 0 ? stripped : "0";
}

/**
 * UTF-8 byte-sequence comparator for stream names. JS string comparison
 * (`<`, `.localeCompare` without options) is UTF-16 code-unit order, which
 * disagrees with UTF-8 byte order for codepoints outside the BMP. Comparing
 * `Buffer`s (or `TextEncoder` output) directly compares UTF-8 bytes.
 */
function compareUtf8Bytes(a: string, b: string): number {
  const bytesA = Buffer.from(a, "utf8");
  const bytesB = Buffer.from(b, "utf8");
  return Buffer.compare(bytesA, bytesB);
}

/**
 * Normalize raw checkpoint parts into the exact composite shape: strips
 * leading zeros from every decimal string (defensive — the read queries
 * already CAST to TEXT, but a caller may pass through unnormalized input),
 * and sorts `streams` by UTF-8 byte order of the stream name. Pure —
 * no I/O, no JS `Number` coercion of any value.
 */
export function normalizeRecordSourceCheckpoint(input: {
  resetGeneration: string;
  streams: readonly { stream: string; maxVersion: string }[];
}): RecordSourceCheckpoint {
  const streams = input.streams
    .map((entry) => ({
      stream: entry.stream,
      max_version: stripLeadingZeros(entry.maxVersion),
    }))
    .sort((a, b) => compareUtf8Bytes(a.stream, b.stream));
  return {
    reset_generation: stripLeadingZeros(input.resetGeneration),
    streams,
  };
}

/**
 * Deep-equal comparison of two normalized checkpoints by exact string
 * value — never numeric coercion. Two checkpoints are equal only when the
 * generation string matches exactly and every stream entry matches in the
 * same sorted position.
 */
export function recordSourceCheckpointsEqual(a: RecordSourceCheckpoint, b: RecordSourceCheckpoint): boolean {
  if (a.reset_generation !== b.reset_generation) {
    return false;
  }
  if (a.streams.length !== b.streams.length) {
    return false;
  }
  for (let i = 0; i < a.streams.length; i += 1) {
    const streamA = a.streams[i];
    const streamB = b.streams[i];
    if (!(streamA && streamB) || streamA.stream !== streamB.stream || streamA.max_version !== streamB.max_version) {
      return false;
    }
  }
  return true;
}

interface Row {
  [key: string]: unknown;
}

function readSqliteCheckpoint(connectorInstanceId: string): RecordSourceCheckpoint {
  const generationRow = getOne<Row>(referenceQueries.recordsDeleteGetRecordResetGeneration, [connectorInstanceId]);
  const resetGeneration = generationRow?.reset_generation == null ? "0" : String(generationRow.reset_generation);
  const streamRows = allowUnboundedReadAcknowledged<Row>(referenceQueries.recordsIngestListVersionCountersByInstance, [
    connectorInstanceId,
  ]);
  return normalizeRecordSourceCheckpoint({
    resetGeneration,
    streams: streamRows.map((row) => ({
      stream: String(row.stream),
      maxVersion: String(row.max_version),
    })),
  });
}

async function readPostgresCheckpoint(connectorInstanceId: string): Promise<RecordSourceCheckpoint> {
  const generationResult = await postgresQuery(
    "SELECT record_reset_generation::text AS reset_generation FROM connector_instances WHERE connector_instance_id = $1",
    [connectorInstanceId]
  );
  const resetGeneration =
    generationResult.rows[0]?.reset_generation == null ? "0" : String(generationResult.rows[0].reset_generation);
  const streamsResult = await postgresQuery(
    "SELECT stream, max_version::text AS max_version FROM version_counter WHERE connector_instance_id = $1",
    [connectorInstanceId]
  );
  return normalizeRecordSourceCheckpoint({
    resetGeneration,
    streams: (streamsResult.rows as Row[]).map((row) => ({
      stream: String(row.stream),
      maxVersion: String(row.max_version),
    })),
  });
}

/**
 * Read one connection's current normalized reset-safe record checkpoint
 * from canonical state. Backend-dispatched; both paths read the integer
 * columns as decimal text so the composite never loses precision through
 * JS `Number`.
 */
export async function readRecordSourceCheckpoint(connectorInstanceId: string): Promise<RecordSourceCheckpoint> {
  if (isPostgresStorageBackend()) {
    return await readPostgresCheckpoint(connectorInstanceId);
  }
  return await readSqliteCheckpoint(connectorInstanceId);
}

/** Synchronous SQLite read for callers already inside one better-sqlite3 transaction. */
export function readRecordSourceCheckpointSqliteSync(connectorInstanceId: string): RecordSourceCheckpoint {
  return readSqliteCheckpoint(connectorInstanceId);
}
