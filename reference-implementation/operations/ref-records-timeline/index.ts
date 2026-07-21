// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical `ref.records.timeline` operation.
 *
 * Owns the envelope semantics for the reference-only operator-console
 * timeline view that powers `GET /_ref/records/timeline`. Host adapters
 * (Fastify route in `reference-implementation/server/index.js`) supply
 * the merged-and-sorted timeline entries via the dependency contract;
 * the operation owns:
 *
 *   - input normalization (limit clamp, `order` default of `desc`,
 *     `timestamp_mode` default of `native`, null-by-default filters);
 *   - the final `data` slice to the effective limit;
 *   - the `{object: 'list', data, meta}` envelope shape, including the
 *     `bounded: true` flag, the `ordering` string, and the echoed
 *     `filters` block.
 *
 * This is reference/operator surface, not PDPP protocol. Clients must
 * not depend on the response shape.
 *
 * Boundary rules (see openspec/changes/complete-reference-operation-refactor):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite,
 *   Postgres, a raw SQL handle, sandbox modules,
 *   `reference-implementation/server/*` route or auth modules, or
 *   `process` / `process.env`.
 * - Substrate reads (per-(connector, stream) candidate enumeration,
 *   per-pair record SELECT, manifest-stream resolution) flow in through
 *   the dependency contract. The host wires the concrete read (the
 *   existing `collectRecordsTimelineEntries` helper in
 *   `server/ref-control.ts`); the operation does not look at storage
 *   internals.
 */

export type RefRecordsTimelineOrder = "asc" | "desc";
export type RefRecordsTimelineTimestampMode = "emitted" | "native";

export interface RefRecordsTimelineSemanticTimestamp {
  readonly value: string;
  readonly source?: unknown;
}

export interface RefRecordsTimelineEntry {
  readonly connector_id: string;
  readonly data: unknown;
  readonly display_timestamp: string;
  readonly emitted_at: string;
  readonly id: string;
  readonly object: "timeline_entry";
  readonly semantic_timestamp: RefRecordsTimelineSemanticTimestamp | null;
  readonly stream: string;
  readonly version: number | null;
}

export interface RefRecordsTimelineInput {
  readonly connectorId?: string | null;
  readonly stream?: string | null;
  readonly since?: string | null;
  readonly until?: string | null;
  readonly limit?: number | null;
  readonly order?: RefRecordsTimelineOrder | string | null;
  readonly timestampMode?: RefRecordsTimelineTimestampMode | string | null;
}

export interface RefRecordsTimelineCollectInput {
  readonly connectorId: string | null;
  readonly stream: string | null;
  readonly since: string | null;
  readonly until: string | null;
  readonly limit: number;
  readonly order: RefRecordsTimelineOrder;
  readonly timestampMode: RefRecordsTimelineTimestampMode;
}

export interface RefRecordsTimelineDependencies {
  /**
   * Resolve the merged-and-sorted timeline entries for the requested
   * window. The host implementation (currently
   * `collectRecordsTimelineEntries` in `server/ref-control.ts`) owns the
   * substrate read, manifest-driven semantic-time projection, and
   * cross-pair sort. The operation owns the final slice to the
   * effective limit and the envelope assembly.
   *
   * The dependency MAY return more entries than the input limit; the
   * operation will clip to the limit. Returning fewer is fine and is
   * surfaced as-is.
   */
  collectEntries(
    input: RefRecordsTimelineCollectInput,
  ): Promise<readonly RefRecordsTimelineEntry[]> | readonly RefRecordsTimelineEntry[];
}

export interface RefRecordsTimelineEnvelope {
  readonly object: "list";
  readonly data: RefRecordsTimelineEntry[];
  readonly meta: {
    readonly bounded: true;
    readonly ordering: string;
    readonly limit: number;
    readonly timestamp_mode: RefRecordsTimelineTimestampMode;
    readonly filters: {
      readonly connector_id: string | null;
      readonly stream: string | null;
      readonly since: string | null;
      readonly until: string | null;
    };
  };
}

const DEFAULT_LIMIT = 50;

function normalizeLimit(raw: number | null | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.floor(raw);
}

function normalizeOrder(raw: unknown): RefRecordsTimelineOrder {
  return raw === "asc" ? "asc" : "desc";
}

function normalizeTimestampMode(raw: unknown): RefRecordsTimelineTimestampMode {
  return raw === "emitted" ? "emitted" : "native";
}

function normalizeStringFilter(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Execute the canonical `ref.records.timeline` operation.
 *
 * Hosts pass capability-shaped dependencies; the operation normalizes
 * the input, calls `collectEntries`, slices to the effective limit, and
 * assembles the timeline envelope. The operation has no notion of HTTP,
 * owner sessions, headers, or framework — it returns the envelope and
 * lets the host write the response.
 */
export async function executeRefRecordsTimeline(
  input: RefRecordsTimelineInput,
  dependencies: RefRecordsTimelineDependencies,
): Promise<RefRecordsTimelineEnvelope> {
  const limit = normalizeLimit(input.limit ?? null);
  const order = normalizeOrder(input.order);
  const timestampMode = normalizeTimestampMode(input.timestampMode);
  const connectorId = normalizeStringFilter(input.connectorId);
  const stream = normalizeStringFilter(input.stream);
  const since = normalizeStringFilter(input.since);
  const until = normalizeStringFilter(input.until);

  const collected = await dependencies.collectEntries({
    connectorId,
    stream,
    since,
    until,
    limit,
    order,
    timestampMode,
  });

  return {
    object: "list",
    data: [...collected].slice(0, limit),
    meta: {
      bounded: true,
      ordering: `semantic_or_emitted ${order}`,
      limit,
      timestamp_mode: timestampMode,
      filters: {
        connector_id: connectorId,
        stream,
        since,
        until,
      },
    },
  };
}
