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
  const ceiling_interval_ms = typeof r.ceiling_interval_ms === "number" ? r.ceiling_interval_ms : null;
  const ceiling_rate_per_min = typeof r.ceiling_rate_per_min === "number" ? r.ceiling_rate_per_min : null;
  const current_interval_ms = typeof r.current_interval_ms === "number" ? r.current_interval_ms : null;
  const effective_rate_per_min = typeof r.effective_rate_per_min === "number" ? r.effective_rate_per_min : null;
  if (
    ceiling_interval_ms === null ||
    ceiling_rate_per_min === null ||
    current_interval_ms === null ||
    effective_rate_per_min === null
  ) {
    return null;
  }
  let last_backoff: CollectionRateSnapshot["last_backoff"] = null;
  if (r.last_backoff != null) {
    const lb = r.last_backoff as Record<string, unknown>;
    const at_interval_ms = typeof lb.at_interval_ms === "number" ? lb.at_interval_ms : null;
    const reason = typeof lb.reason === "string" ? lb.reason : null;
    if (at_interval_ms !== null && reason !== null) {
      last_backoff = { at_interval_ms, reason };
    }
  }
  return { ceiling_interval_ms, ceiling_rate_per_min, current_interval_ms, effective_rate_per_min, last_backoff };
}
