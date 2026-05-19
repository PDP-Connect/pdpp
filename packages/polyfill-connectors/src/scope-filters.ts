/**
 * Scope filtering helpers — shared across connectors so every connector
 * honors START.scope.streams[].resources and .time_range consistently.
 *
 * Also provides a tombstone emitter for mutable_state streams: given a prior
 * ID set and the set of IDs actually emitted, emit delete records for IDs
 * that vanished upstream.
 */

import type { AuthStrategyContext, Credentials } from "./auth.ts";
import type { EmittedMessage, InteractionRequest, InteractionResponse } from "./connector-runtime-protocol.ts";

export interface TimeRange {
  since?: string;
  until?: string;
}

export interface StreamRequest {
  resources?: readonly unknown[];
  time_range?: TimeRange;
}

/**
 * Returns a Set of canonical-key strings if resources were requested, else
 * null (meaning "all records allowed").
 */
export function resourceSet(streamRequest: StreamRequest | null | undefined): Set<string> | null {
  if (!(streamRequest && Array.isArray(streamRequest.resources) && streamRequest.resources.length)) {
    return null;
  }
  const s = new Set<string>();
  for (const r of streamRequest.resources) {
    s.add(String(r));
  }
  return s;
}

/**
 * True if the record should be emitted given the stream's resources filter.
 *   null set = allow everything. Otherwise require exact primary-key match.
 * Primary key may be a string or an array; we normalize both to canonical
 * key-string form matching the core spec (minified JSON array for compound).
 */
export function passesResourceFilter(resSet: ReadonlySet<string> | null, primaryKey: unknown): boolean {
  if (!resSet) {
    return true;
  }
  const canonical = Array.isArray(primaryKey) ? JSON.stringify(primaryKey.map(String)) : String(primaryKey);
  return resSet.has(canonical);
}

/**
 * True if an ISO date/datetime string falls within the stream's time_range.
 */
export function passesTimeRange(isoValue: string | null | undefined, timeRange: TimeRange | null | undefined): boolean {
  if (!timeRange) {
    return true;
  }
  if (!isoValue) {
    // connector-side: if we can't determine, let RS do enforcement
    return true;
  }
  if (timeRange.since && isoValue < timeRange.since) {
    return false;
  }
  if (timeRange.until && isoValue >= timeRange.until) {
    return false;
  }
  return true;
}

export interface EmitGateRecord {
  [field: string]: unknown;
}

export interface EmitGate {
  emittedSet: () => Set<string>;
  (stream: string, data: EmitGateRecord, keyField?: string): boolean;
}

export interface MakeEmitGateOptions {
  consentTimeField?: string;
}

/**
 * Create a RECORD-emission gate for a stream. Usage:
 *   const gate = makeEmitGate(emitRecord, streamRequest, { consentTimeField });
 *   gate('transactions', recordObj, record.date);  // only emits if allowed
 *
 * Collects emitted IDs internally so you can use them for tombstone diffing.
 */
export function makeEmitGate(
  emitRecord: (stream: string, data: EmitGateRecord) => void,
  streamRequest: StreamRequest | null | undefined,
  { consentTimeField }: MakeEmitGateOptions = {}
): EmitGate {
  const resSet = resourceSet(streamRequest);
  const emitted = new Set<string>();

  const gate = ((stream: string, data: EmitGateRecord, keyField = "id"): boolean => {
    const key = data[keyField];
    if (key == null) {
      return false;
    }
    const canonical = Array.isArray(key) ? JSON.stringify(key.map(String)) : String(key);
    if (resSet && !resSet.has(canonical)) {
      return false;
    }
    if (consentTimeField && streamRequest?.time_range) {
      const v = data[consentTimeField];
      const iso = typeof v === "string" ? v : undefined;
      if (!passesTimeRange(iso, streamRequest.time_range)) {
        return false;
      }
    }
    emitted.add(canonical);
    emitRecord(stream, data);
    return true;
  }) as EmitGate;
  gate.emittedSet = (): Set<string> => emitted;
  return gate;
}

export interface EmitTombstonesArgs {
  currentIds: ReadonlySet<string>;
  emit: (msg: EmittedMessage) => unknown;
  emittedAt: string;
  priorIds: Iterable<string> | null | undefined;
  stream: string;
}

/**
 * Emit tombstones for record IDs present in `priorIds` but absent from
 * `currentIds`. For mutable_state streams only.
 */
export function emitTombstones({ emit, stream, priorIds, currentIds, emittedAt }: EmitTombstonesArgs): number {
  let count = 0;
  for (const id of priorIds || []) {
    if (!currentIds.has(id)) {
      emit({
        type: "RECORD",
        stream,
        key: id,
        data: { id },
        emitted_at: emittedAt,
        op: "delete",
      });
      count++;
    }
  }
  return count;
}

export interface RequireCredentialsOrAskArgs {
  connectorName: string;
  required: ReadonlyArray<string | readonly string[]>;
  sendInteraction: (req: InteractionRequest) => Promise<InteractionResponse>;
}

/**
 * Required-env or emit INTERACTION kind=credentials.
 *
 * Shim for connectors not yet migrated to the runtime's `auth` config.
 * New connectors should declare `auth: { kind: 'env', required: [...] }`
 * in runConnector() instead — the runtime resolves credentials before
 * collect() is called. This helper exists only for gmail and pocket which
 * have structural reasons not to use the runtime yet.
 */
export async function requireCredentialsOrAsk({
  required,
  connectorName,
  sendInteraction,
}: RequireCredentialsOrAskArgs): Promise<Credentials> {
  const { resolveAuth } = await import("./auth.ts");
  const ctx: AuthStrategyContext = { sendInteraction, connectorName };
  return resolveAuth({ kind: "env", required }, ctx);
}
