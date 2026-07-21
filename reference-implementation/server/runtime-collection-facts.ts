// Pure parsers for the runtime-stamped `collection_facts` and `collection_rate`
// blocks that ride on a run's terminal event / progress events. Each takes an
// opaque payload (parsed JSON of unknown shape) and defensively re-validates it
// into a typed fact object, collapsing any malformed/absent shape to `null` or a
// safe fallback — never a fabricated denominator. Extracted from `ref-control.ts`
// so the god-file no longer carries the runtime-fact parsing taxonomy; the
// DB-bound reader that *fetches* the payloads stays in `ref-control.ts` and calls
// `parseCollectionRatePayload` from here.

import type { CollectionRateSnapshot } from "../runtime/connection-health.ts";
import type { RuntimeCollectionFact, RuntimeCollectionFactSkip, RuntimeCollectionFacts } from "./ref-control.ts";

const COLLECTION_RATE_NUMBER_FIELDS = [
  "ceiling_interval_ms",
  "ceiling_rate_per_min",
  "current_interval_ms",
  "effective_rate_per_min",
] as const;

type CollectionRateNumberField = (typeof COLLECTION_RATE_NUMBER_FIELDS)[number];
type CollectionRateNumbers = Pick<CollectionRateSnapshot, CollectionRateNumberField>;

export function readSafeNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function readFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function readRuntimeCollectionFact(raw: unknown): RuntimeCollectionFact | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const entry = raw as Record<string, unknown>;
  if (typeof entry.stream !== "string" || !entry.stream) {
    return null;
  }
  return {
    checkpoint: typeof entry.checkpoint === "string" ? entry.checkpoint : null,
    collected: readFiniteNumber(entry.collected, 0),
    // `considered` and `covered` are OMITTED upstream when unknown. Re-validate
    // defensively: anything not a safe non-negative integer reads as absent,
    // never as a fabricated denominator or numerator.
    considered: readSafeNonNegativeInteger(entry.considered),
    covered: readSafeNonNegativeInteger(entry.covered),
    pending_detail_gaps: readFiniteNumber(entry.pending_detail_gaps, 0),
    skipped: readCollectionFactSkip(entry.skipped),
    stream: entry.stream,
  };
}

/**
 * Read the runtime `collection_facts` block (the Tranche B per-stream fact
 * block) off a terminal-event payload. The runtime attaches only objective,
 * run-local facts here (collected count, considered-or-`unknown`, checkpoint,
 * skip, pending-detail-gap count) and stamps NO coverage condition or forward
 * disposition — those are derived on read by the control-plane projection
 * (`buildCollectionReport`). Returns `null` for an old run that predates the
 * block, a `run.failed` that exited before the terminal builder ran, or any
 * malformed payload — absence reads as "no facts", never as `complete`.
 */
export function readCollectionFactsFromTerminalData(
  data: Record<string, unknown> | null
): RuntimeCollectionFacts | null {
  if (!data) {
    return null;
  }
  const block = data.collection_facts;
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    return null;
  }
  const streams = (block as { streams?: unknown }).streams;
  if (!Array.isArray(streams)) {
    return null;
  }
  const entries: RuntimeCollectionFact[] = [];
  for (const raw of streams) {
    const fact = readRuntimeCollectionFact(raw);
    if (fact) {
      entries.push(fact);
    }
  }
  return { streams: entries };
}

export function readCollectionFactSkip(value: unknown): RuntimeCollectionFactSkip | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const skip = value as Record<string, unknown>;
  const reason = typeof skip.reason === "string" ? skip.reason : null;
  if (reason === null) {
    return null;
  }
  const recoveryAction = typeof skip.recovery_action === "string" ? skip.recovery_action : null;
  return { reason, ...(recoveryAction ? { recovery_action: recoveryAction } : {}) };
}

function readCollectionRateNumbers(entry: Record<string, unknown>): CollectionRateNumbers | null {
  const values = COLLECTION_RATE_NUMBER_FIELDS.map((field) => [field, entry[field]] as const);
  if (values.some(([, value]) => typeof value !== "number")) {
    return null;
  }
  return Object.fromEntries(values) as CollectionRateNumbers;
}

function readCollectionRateLastBackoff(entry: Record<string, unknown>): CollectionRateSnapshot["last_backoff"] {
  if (entry.last_backoff == null) {
    return null;
  }
  const backoff = entry.last_backoff as Record<string, unknown>;
  const atIntervalMs = typeof backoff.at_interval_ms === "number" ? backoff.at_interval_ms : null;
  const reason = typeof backoff.reason === "string" ? backoff.reason : null;
  return atIntervalMs !== null && reason !== null ? { at_interval_ms: atIntervalMs, reason } : null;
}

/**
 * Parse and validate a raw `collection_rate` payload from a spine event's
 * `data_json`. Returns `null` for any shape that does not match the expected
 * structure — old runs predating the field, missing payloads, or malformed
 * data all collapse to the honest `null` unknown.
 */
export function parseCollectionRatePayload(raw: unknown): CollectionRateSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (r.object !== "collection_rate") {
    return null;
  }
  const numbers = readCollectionRateNumbers(r);
  if (!numbers) {
    return null;
  }
  return { ...numbers, last_backoff: readCollectionRateLastBackoff(r) };
}
