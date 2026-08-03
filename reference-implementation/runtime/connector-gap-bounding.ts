// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Connector-output bounding and gap/collection projection POLICY.
//
// Owns the cluster of functions and constants that govern how connector-authored
// gap/diagnostic/scope/recovery payloads are sanitised, size-bounded, and
// normalised before being persisted to spine events. This is not a neutral
// constants bucket — every symbol here participates in the bounding/projection
// policy for connector output. See the §E contract:
// tmp/workstreams/refactor-loop/decomp-loop/contract.runtime-bound-diagnostics.yaml
//
// Public facade (what runtime/index.js imports):
//   Functions: boundString, boundStringList, boundGapString,
//              boundConnectorErrorMessage, boundConsideredCount,
//              normalizeRecoveryHint, normalizeGapScope,
//              buildCollectionFacts, buildRecoveryGapClosureFacts, buildKnownGap
//   Constants: VIOLATION_LIST_MAX, GAP_STRING_MAX
//   Re-exported (owned by @pdpp/reference-contract/common): RECOVERY_ACTIONS
//
// Private (not exported): projectDiagnosticsNode, classifyKnownGapSeverity,
//   normalizeConsideredInDiagnostics, GAP_SEVERITIES, INFORMATIONAL_GAP_REASONS,
//   TRANSIENT_GAP_REASONS, VIOLATION_STRING_MAX, GAP_LIST_MAX,
//   CONNECTOR_ERROR_MESSAGE_MAX, GAP_DIAGNOSTICS_BYTES_MAX,
//   GAP_DIAGNOSTICS_DEPTH_MAX, GAP_DIAGNOSTICS_LIST_MAX, inferRecoveryAction.
//
// No back-edge: this module must NOT import runtime/index.js.
// No Playwright/CDP/raw-DOM terms. Closed connector evidence is revalidated
// here before it can enter the durable spine.

import { RECOVERY_ACTIONS } from "@pdpp/reference-contract/common";
import { isNullish } from "../lib/nullish.ts";
import {
  collectionFactSkipFromGap,
  isBrowserRuntimeCapability,
  recoveryHintAction,
} from "./capability-absence.ts";
import { redactStderrTail } from "./stderr-redact.ts";

// ── CLUSTER-EXCLUSIVE CONSTANTS ───────────────────────────────────────────────

const VIOLATION_STRING_MAX = 200;
export const VIOLATION_LIST_MAX = 20;
export const GAP_STRING_MAX = 200;
const GAP_LIST_MAX = 20;
const CONNECTOR_ERROR_MESSAGE_MAX = 500;
const GAP_DIAGNOSTICS_BYTES_MAX = 8 * 1024;
const GAP_DIAGNOSTICS_DEPTH_MAX = 6;
const GAP_DIAGNOSTICS_LIST_MAX = 32;
const BROWSER_SURFACE_COUNT_MAX = 1_000_000;
const BROWSER_SURFACE_FIELDS = [
  "account_detail_marker_count",
  "activity_table_marker_count",
  "dashboard_marker_count",
  "managed_surface",
  "navigation_marker_count",
  "parser_count",
  "phase",
  "posture",
  "read_count",
  "route",
  "surface",
  "target_count",
  "transaction_marker_count",
  "verified_empty_marker_count",
  "wait_outcome",
];
const BROWSER_SURFACE_KINDS = new Set(["chase_current_activity", "usaa_transaction_export"]);
const BROWSER_SURFACE_MANAGED_STATES = new Set(["isolated", "legacy_remote", "managed", "unknown"]);
const BROWSER_SURFACE_POSTURES = new Set(["recognized", "verified_empty", "parser_zero", "unexpected"]);
const BROWSER_SURFACE_ROUTES = new Set(["expected", "interstitial", "unknown"]);
const BROWSER_SURFACE_WAITS = new Set(["not_needed", "resolved", "timed_out", "unknown"]);

const GAP_SEVERITIES = new Set(["actionable", "informational", "recoverable", "transient"]);
const INFORMATIONAL_GAP_REASONS = new Set(["not_available_in_mode", "out_of_scope", "user_disabled"]);
const TRANSIENT_GAP_REASONS = new Set([
  "http_429",
  "manifest_stream_unresolved",
  "rate_limited",
  "retry_exhausted",
  "temporary_unavailable",
  "upstream_pressure",
  "upstream_pressure_deferred",
]);

// RECOVERY_ACTIONS is re-exported here (not owned here) so existing
// consumers of this module's public facade (`runtime/index.ts` and any
// test that imports it from this path) don't need to also learn the
// `@pdpp/reference-contract` import path. The single source of truth for
// the value set lives in packages/reference-contract/src/common/recovery-actions.ts.
// biome-ignore lint/performance/noBarrelFile: intentional single-symbol re-export preserving this module's existing public facade, not a barrel file.
export { RECOVERY_ACTIONS } from "@pdpp/reference-contract/common";

// ── BOUNDING FUNCTIONS ────────────────────────────────────────────────────────

export function boundString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  if (value.length <= VIOLATION_STRING_MAX) {
    return value;
  }
  return `${value.slice(0, VIOLATION_STRING_MAX - 1)}…`;
}

export function boundStringList(values: unknown): string[] | null {
  if (!Array.isArray(values)) {
    return null;
  }
  const safe = values.filter((v) => typeof v === "string" && v.length > 0) as string[];
  if (safe.length <= VIOLATION_LIST_MAX) {
    return safe.map((v) => boundString(v) as string);
  }
  return safe.slice(0, VIOLATION_LIST_MAX).map((v) => boundString(v) as string);
}

export function boundGapString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const redacted = trimmed
    .replace(/\b(bearer|token|password|passwd|cookie|secret|otp)\b\s*[:=]\s*["']?[^"',\s}]+/gi, "$1=[REDACTED]")
    .replace(/\b\d{6}\b/g, "[REDACTED_OTP]");
  if (redacted.length <= GAP_STRING_MAX) {
    return redacted;
  }
  return `${redacted.slice(0, GAP_STRING_MAX - 1)}…`;
}

/**
 * Sanitize a connector-authored error message before persisting it as
 * `connector_error_message` on a terminal spine event.  The message is
 * connector-authored and therefore untrusted: apply the same redaction
 * as redactStderrTail and cap the length.
 */
export function boundConnectorErrorMessage(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const { text } = redactStderrTail(value);
  if (text.length <= CONNECTOR_ERROR_MESSAGE_MAX) {
    return text;
  }
  return `${text.slice(0, CONNECTOR_ERROR_MESSAGE_MAX - 1)}…`;
}

export function boundGapStringList(values: unknown): string[] | null {
  if (!Array.isArray(values)) {
    return null;
  }
  const bounded = values.map((value) => boundGapString(value)).filter((v): v is string => v !== null);
  if (!bounded.length) {
    return null;
  }
  return bounded.slice(0, GAP_LIST_MAX);
}

/**
 * Walk a connector-authored diagnostics object, applying secret-redaction
 * to every string leaf and bounding nested array length / object depth.
 * Returns the bounded projection, null for non-object top-level values, or a
 * sentinel object if the input exceeds the depth/list cap or total JSON byte cap.
 *
 * Used to propagate `SKIP_RESULT.diagnostics` to the run.stream_skipped
 * spine event without leaking secrets or unbounded payloads. See
 * openspec/changes/propagate-skip-result-diagnostics.
 */
export function boundGapDiagnostics(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  if (Object.hasOwn(value, "browser_surface")) {
    const browserSurface = boundBrowserSurfaceDiagnostic((value as Record<string, unknown>).browser_surface);
    return browserSurface ? { browser_surface: browserSurface } : null;
  }
  const projected = projectDiagnosticsNode(value as Record<string, unknown>, 0);
  if (projected === null) {
    return { reason: "depth_overflow", truncated: true };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(projected);
  } catch {
    return { reason: "serialization_failed", truncated: true };
  }
  if (serialized.length > GAP_DIAGNOSTICS_BYTES_MAX) {
    return { reason: "size_overflow", truncated: true };
  }
  return projected as Record<string, unknown>;
}

/**
 * The only browser-derived evidence admitted to the spine. Build a fresh
 * object from a closed schema so sibling diagnostics, extra keys, free text,
 * route URLs, selector strings, and identifiers cannot survive this boundary.
 */
function boundBrowserSurfaceDiagnostic(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const input = value as Record<string, unknown>;
  const validCategories = [
    BROWSER_SURFACE_KINDS.has(input.surface as string),
    BROWSER_SURFACE_MANAGED_STATES.has(input.managed_surface as string),
    BROWSER_SURFACE_POSTURES.has(input.posture as string),
    BROWSER_SURFACE_ROUTES.has(input.route as string),
    BROWSER_SURFACE_WAITS.has(input.wait_outcome as string),
    isBrowserSurfacePhase(input.surface, input.phase),
  ].every(Boolean);
  if (!validCategories) {
    return null;
  }
  for (const field of BROWSER_SURFACE_FIELDS) {
    if (!Object.hasOwn(input, field)) {
      return null;
    }
  }
  const countFields = BROWSER_SURFACE_FIELDS.filter((field) => field.endsWith("_count"));
  if (!countFields.every((field) => isBrowserSurfaceCount(input[field]))) {
    return null;
  }
  if (!hasSurfaceSpecificCounts(input)) {
    return null;
  }
  const posture = deriveBrowserSurfacePosture(input);
  const output: Record<string, unknown> = {};
  for (const field of BROWSER_SURFACE_FIELDS) {
    output[field] = input[field];
  }
  output.posture = posture;
  return output;
}

/** Reject non-zero fields that belong only to the other connector surface. */
function hasSurfaceSpecificCounts(input: Record<string, unknown>): boolean {
  if (input.surface === "chase_current_activity") {
    return (
      input.account_detail_marker_count === 0 &&
      input.navigation_marker_count === 0 &&
      input.transaction_marker_count === 0
    );
  }
  return (
    input.activity_table_marker_count === 0 &&
    input.dashboard_marker_count === 0 &&
    input.parser_count === 0 &&
    input.verified_empty_marker_count === 0
  );
}

/** Derive durable posture from validated counts; caller-authored posture is not trusted. */
function deriveBrowserSurfacePosture(
  input: Record<string, unknown>
): "recognized" | "verified_empty" | "parser_zero" | "unexpected" {
  const targetCount = input.target_count as number;
  if (input.surface === "chase_current_activity") {
    const parserCount = input.parser_count as number;
    const emptyMarkerCount = input.verified_empty_marker_count as number;
    const structuralMarkerCount =
      (input.dashboard_marker_count as number) + (input.activity_table_marker_count as number);
    if (parserCount > 0 || targetCount > 0) {
      return "recognized";
    }
    if (emptyMarkerCount > 0) {
      return "verified_empty";
    }
    if (structuralMarkerCount > 0) {
      return "parser_zero";
    }
    return "unexpected";
  }

  const structuralMarkerCount =
    (input.account_detail_marker_count as number) +
    (input.navigation_marker_count as number) +
    (input.transaction_marker_count as number);
  return targetCount > 0 || structuralMarkerCount > 0 ? "recognized" : "unexpected";
}

function isBrowserSurfacePhase(surface: unknown, phase: unknown): boolean {
  return (
    (surface === "chase_current_activity" && phase === "final_snapshot") ||
    (surface === "usaa_transaction_export" && phase === "no_export_affordance")
  );
}

function isBrowserSurfaceCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= BROWSER_SURFACE_COUNT_MAX;
}

function projectDiagnosticsNode(value: unknown, depth: number): unknown {
  if (isNullish(value)) {
    return null;
  }
  if (typeof value === "string") {
    return boundGapString(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (depth >= GAP_DIAGNOSTICS_DEPTH_MAX) {
    return { reason: "depth_overflow", truncated: true };
  }
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    const limit = Math.min(value.length, GAP_DIAGNOSTICS_LIST_MAX);
    for (let i = 0; i < limit; i += 1) {
      const projected = projectDiagnosticsNode(value[i], depth + 1);
      if (projected !== undefined) {
        items.push(projected);
      }
    }
    if (value.length > GAP_DIAGNOSTICS_LIST_MAX) {
      items.push({ omitted: value.length - GAP_DIAGNOSTICS_LIST_MAX, reason: "list_overflow", truncated: true });
    }
    return items;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const projected = projectDiagnosticsNode(child, depth + 1);
      if (projected !== undefined) {
        out[key] = projected;
      }
    }
    return out;
  }
  // biome-ignore lint/complexity/noUselessReturn: required by TypeScript noImplicitReturns to make the empty result explicit.
  return;
}

export function boundConsideredCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

/**
 * Normalize a top-level `considered` key inside a bounded diagnostics object
 * (SKIP_RESULT.diagnostics). `boundGapDiagnostics` already preserved numbers as
 * raw leaves; this re-validates the one denominator key so an unsafe,
 * fractional, or non-integer `considered` is dropped to `unknown` (deleted)
 * instead of surviving as an untrusted number. A trusted value is rewritten in
 * its normalized form. Truncation sentinels and non-object inputs pass through
 * untouched. Mutates and returns the bounded object in place.
 */
function normalizeConsideredInDiagnostics(
  boundedDiagnostics: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (
    boundedDiagnostics === null ||
    typeof boundedDiagnostics !== "object" ||
    Array.isArray(boundedDiagnostics) ||
    !Object.hasOwn(boundedDiagnostics, "considered")
  ) {
    return boundedDiagnostics;
  }
  const considered = boundConsideredCount(boundedDiagnostics.considered);
  if (considered === null) {
    const { considered: _dropped, ...rest } = boundedDiagnostics;
    return rest;
  }
  boundedDiagnostics.considered = considered;
  return boundedDiagnostics;
}

// ── COLLECTION FACTS ──────────────────────────────────────────────────────────

interface DetailCoverageEntry {
  considered?: number;
  covered?: number;
  requiredKeys?: unknown[];
  stream?: string;
}

interface KnownGap {
  kind: string;
  reason?: string;
  recovery_hint?: unknown;
  severity?: string;
  status?: string;
  stream?: string;
}

function skipEvidenceRank(gap: KnownGap): number {
  const action = recoveryHintAction(gap.recovery_hint);
  // Multiple connector accounts can produce multiple SKIP_RESULTs for one
  // collection stream. Keep explicit owner/maintainer evidence above a
  // runtime retry, and keep a retry above an unclassified diagnostic.
  if (action === null || action === "unknown") {
    return 0;
  }
  return action === "retry_by_runtime" ? 1 : 2;
}

function selectMostDegradingSkip(knownGaps: KnownGap[], stream: string): KnownGap | null {
  let selected: KnownGap | null = null;
  for (const candidate of knownGaps) {
    if (candidate.kind !== "skip_result" || candidate.stream !== stream) {
      continue;
    }
    if (selected === null || skipEvidenceRank(candidate) > skipEvidenceRank(selected)) {
      selected = candidate;
    }
  }
  return selected;
}

interface BuildCollectionFactsInput {
  committedStateStreams: Set<string> | string[];
  detailCoverageByStateStream: Map<string, DetailCoverageEntry[]>;
  durableDetailGaps: KnownGap[];
  emittedByStream: Map<string, number>;
  knownGaps: KnownGap[];
  /**
   * Manifest-declared checkpoint parent per stream (`state_stream`). Co-emitted
   * streams that ride a parent list stream's cursor and emit no DETAIL_COVERAGE
   * (Slack reactions / message_attachments, Gmail message_bodies) declare their
   * checkpoint parent here so their `checkpoint` reflects the parent's committed
   * cursor instead of a spurious `not_staged`. DETAIL_COVERAGE wins when both
   * are present.
   */
  manifestStateStreamByStream?: Map<string, string>;
  newState: Record<string, unknown> | null | undefined;
  persistState: boolean;
  /**
   * When true, this run only drained pending detail gaps
   * (`START.recovery_only`) and by definition performed no forward/list
   * inventory pass against the manifest scope — so it cannot produce a
   * trustworthy per-stream inventory fact (`checkpoint`/`considered`/
   * `covered`) for ANY stream. `buildCollectionFacts` returns `null`
   * unconditionally in this case (see below): there is no existing runtime
   * contract that proves a STATE commit observed during a recovery-only run
   * came from a genuine list-pass measurement rather than a detail-recovery
   * cursor, so no exception is taken on that basis. The durable detail-gap
   * store (current pending/recovered/terminal gap rows) and detail-gap
   * spine events already own current gap/recovery state authoritatively —
   * this block is never the source for that. See
   * openspec/changes/fix-recovery-run-lifecycle.
   */
  recoveryOnly?: boolean;
  scopeByStream: Map<string, unknown>;
}

/**
 * Build the per-stream runtime collection-fact block attached to the terminal
 * event (`run.completed` / `run.failed` / `run.cancelled`).
 *
 * This is the runtime half of the two-layer Collection Report construction
 * (openspec/changes/define-connector-progress-evidence-contract, task 2.2a). It
 * is pure and run-local: it carries ONLY the objective facts the per-connector
 * run subprocess owns at completion — per-stream `collected` count, a declared
 * `considered` value or `unknown` (never inferred from collected), the committed
 * checkpoint status, the `SKIP_RESULT` reason, and the pending recoverable
 * detail-gap count.
 *
 * It deliberately does NOT derive a coverage condition or a forward
 * disposition. Both require freshness, refresh-policy, attention, and the
 * cross-stream rollup that only the control-plane projection (ref-control ->
 * connection-health) holds. The projection derives those on read (Tranche C).
 *
 * Honesty rules pinned by the layer-boundary tests:
 *   - one entry per in-scope stream, including zero-record streams;
 *   - `considered` is OMITTED (reads `unknown`) unless a trusted declared value
 *     exists; it is NEVER set to `collected`;
 *   - declared `DETAIL_COVERAGE.considered` wins over `required_keys.length`;
 *   - `covered` (the items the run accounted for: emitted + suppressed-unchanged)
 *     is OMITTED unless a trusted declared `DETAIL_COVERAGE.covered` exists; it is
 *     NEVER inferred from `collected`. When present, the projection compares
 *     `considered` against `covered` so a steady-state full-sync run that
 *     suppressed every unchanged record reads `complete`, not a false `partial`;
 *   - multiple same-stream `SKIP_RESULT`s preserve the most-degrading bounded
 *     recovery action, so an explicit maintainer action cannot be hidden by a
 *     retryable diagnostic emitted for another item;
 *   - no `coverage`, `coverage_axis`, `forward_disposition`, `freshness`, or
 *     `refresh` key, on the block or on any entry.
 *
 * @returns the block, or null when there is no in-scope stream universe.
 */
export function buildCollectionFacts({
  scopeByStream,
  emittedByStream,
  knownGaps,
  durableDetailGaps,
  detailCoverageByStateStream,
  manifestStateStreamByStream,
  newState,
  committedStateStreams,
  persistState,
  recoveryOnly = false,
}: BuildCollectionFactsInput): { reference_only: true; schema_version: number; streams: object[] } | null {
  if (recoveryOnly) {
    // Recovery-only runs perform no forward/list inventory pass by
    // definition, so they cannot produce a trustworthy per-stream inventory
    // fact for any stream. See the `recoveryOnly` doc comment above for why
    // no exception is taken here.
    return null;
  }

  const inScopeStreams = [...scopeByStream.keys()];
  if (!inScopeStreams.length) {
    return null;
  }

  // Map each data `stream` to the `state_stream` whose checkpoint covers it.
  // Default: a stream checkpoints itself (state_stream === stream). Two ways a
  // stream can be covered by a different state_stream:
  //   - list-plus-detail hydration lanes: the detail `stream` (e.g. other_items)
  //     is covered by the list `state_stream` (e.g. items); DETAIL_COVERAGE
  //     entries carry both, so we learn the mapping from them (authoritative
  //     runtime evidence);
  //   - co-emitted streams with no hydration lane (Slack reactions /
  //     message_attachments, Gmail message_bodies) that ride the parent list
  //     stream's cursor: they emit no DETAIL_COVERAGE, so the mapping is declared
  //     in the manifest via `state_stream` and threaded in here. DETAIL_COVERAGE
  //     wins when both are present.
  const streamToStateStream = new Map<string, string>();
  for (const [stateStream, entries] of detailCoverageByStateStream) {
    for (const entry of entries) {
      if (entry?.stream && !streamToStateStream.has(entry.stream)) {
        streamToStateStream.set(entry.stream, stateStream);
      }
    }
  }
  for (const [stream, stateStream] of manifestStateStreamByStream || []) {
    if (!streamToStateStream.has(stream)) {
      streamToStateStream.set(stream, stateStream);
    }
  }

  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  const committed = committedStateStreams instanceof Set ? committedStateStreams : new Set(committedStateStreams || []);
  const stagedStateStreams = new Set(Object.keys(newState || {}));

  const checkpointForStateStream = (stateStream: string): string => {
    if (!persistState) {
      return "disabled";
    }
    if (committed.has(stateStream)) {
      return "committed";
    }
    if (stagedStateStreams.has(stateStream)) {
      return "not_committed";
    }
    return "not_staged";
  };

  // First declared considered (DETAIL_COVERAGE.considered) wins, else the
  // required-keys count, else unknown (omitted). Never derived from collected.
  const declaredConsideredForStream = (stream: string): number | null => {
    let requiredKeysFallback: number | null = null;
    for (const entries of detailCoverageByStateStream.values()) {
      for (const entry of entries) {
        if (entry?.stream !== stream) {
          continue;
        }
        if (typeof entry.considered === "number") {
          return entry.considered;
        }
        if (requiredKeysFallback === null && Array.isArray(entry.requiredKeys)) {
          requiredKeysFallback = entry.requiredKeys.length;
        }
      }
    }
    return requiredKeysFallback;
  };

  // First declared covered count (DETAIL_COVERAGE.covered) wins, else unknown
  // (omitted). Mirrors declaredConsideredForStream. The projection compares
  // `considered` against `covered` when present so a full-sync stream that
  // suppressed every unchanged record reads `complete`. Never inferred from
  // collected; there is no required-keys fallback (covered is a run-outcome count,
  // not a declared key set).
  const declaredCoveredForStream = (stream: string): number | null => {
    for (const entries of detailCoverageByStateStream.values()) {
      for (const entry of entries) {
        if (entry?.stream !== stream) {
          continue;
        }
        if (typeof entry.covered === "number") {
          return entry.covered;
        }
      }
    }
    return null;
  };

  const skipForStream = (
    stream: string
  ): ReturnType<typeof collectionFactSkipFromGap> | null => {
    const selected = selectMostDegradingSkip(knownGaps, stream);
    if (!selected) {
      return null;
    }
    return collectionFactSkipFromGap(selected);
  };

  const pendingDetailGapsForStream = (stream: string): number =>
    durableDetailGaps.filter((gap) => gap.stream === stream && gap.status === "pending").length;

  const streams = inScopeStreams.map((stream) => {
    const considered = declaredConsideredForStream(stream);
    const covered = declaredCoveredForStream(stream);
    const stateStream = streamToStateStream.get(stream) || stream;
    return {
      collected: emittedByStream.get(stream) || 0,
      stream,
      // Omit when unknown — absence reads as `unknown` downstream; never
      // inferred from collected count.
      ...(considered === null ? {} : { considered }),
      // Optional covered count (task 4.4): omit when unknown. When present the
      // projection compares `considered` against this instead of `collected`.
      ...(covered === null ? {} : { covered }),
      checkpoint: checkpointForStateStream(stateStream),
      pending_detail_gaps: pendingDetailGapsForStream(stream),
      skipped: skipForStream(stream),
    };
  });

  return {
    reference_only: true,
    schema_version: 1,
    streams,
  };
}

// ── RECOVERY GAP-CLOSURE FACTS ─────────────────────────────────────────────────

interface BuildRecoveryGapClosureFactsInput {
  durableDetailGaps: Array<KnownGap & { gap_id?: string }>;
  recoveryOnly?: boolean;
}

/**
 * Build a run-terminal fact block reporting, per stream, how many of a
 * recovery-only run's durably-recorded gap recoveries (`DETAIL_GAP_RECOVERED`
 * -> `detailGapStore.settleLeasedGapRecovered`/`markGapStatus("recovered")`)
 * this run settled. Distinct from `buildCollectionFacts`'s `collection_facts`
 * block by design: `buildCollectionFacts` returns `null` unconditionally for
 * a recovery-only run because NO signal a recovery-only run produces proves a
 * genuine forward/list-pass inventory measurement occurred — that includes
 * this run's own DETAIL_COVERAGE `considered`/`covered` counts, which are
 * connector-self-declared and were explicitly rejected as inventory proof
 * (see `buildCollectionFacts`'s `recoveryOnly` doc comment).
 *
 * This block makes a narrower, different claim: not "the stream's inventory
 * is N/M", but "N previously-open detail gaps for this stream are now
 * durably closed". The count comes from `durableDetailGaps` entries this run
 * itself transitioned to `status: "recovered"` — a real store-backed state
 * transition the runtime performed, not a connector-declared number. It says
 * nothing about the stream's total inventory (`considered`) and is never
 * treated as list-pass proof; the read-model fold (`connector-summary-read-
 * model.ts`) only ever uses it to narrow an EXISTING durably-proven fact's
 * gap count, never to originate a fresh `considered`/`checkpoint` for a
 * stream this run did not otherwise measure.
 *
 * Duplicate entries for the same gap_id are deduplicated before counting:
 * only the stable gap_id identity matters. Malformed entries (no stream, no
 * gap_id, status != "recovered") are silently excluded from the proof.
 *
 * @returns the block, or null when there is nothing to report (not a
 *   recovery-only run, or the run recovered no durable gaps).
 */
export function buildRecoveryGapClosureFacts({
  durableDetailGaps,
  recoveryOnly = false,
}: BuildRecoveryGapClosureFactsInput): { reference_only: true; schema_version: number; streams: object[] } | null {
  if (!recoveryOnly) {
    return null;
  }
  const recoveredCountByStream = new Map<string, number>();
  const seenGapIds = new Set<string>();
  for (const gap of durableDetailGaps) {
    if (gap.status !== "recovered" || !gap.stream || !gap.gap_id || seenGapIds.has(gap.gap_id)) {
      continue;
    }
    seenGapIds.add(gap.gap_id);
    recoveredCountByStream.set(gap.stream, (recoveredCountByStream.get(gap.stream) || 0) + 1);
  }
  if (!recoveredCountByStream.size) {
    return null;
  }
  const streams = [...recoveredCountByStream.entries()].map(([stream, recoveredCount]) => ({
    recovered_count: recoveredCount,
    stream,
  }));
  return {
    reference_only: true,
    schema_version: 1,
    streams,
  };
}

// ── RECOVERY HINT NORMALISATION ───────────────────────────────────────────────

const RE_MANUAL = /\b(otp|mfa|2fa|manual|captcha|anti[-_ ]?bot)\b/;
const RE_CREDENTIALS = /\b(credential|credentials|auth|login|session_expired|reauth|token)\b/;
const RE_TRANSIENT = /\b(rate|429|timeout|timed out|5\d\d|network|temporar|retry)\b/;
const RE_UPGRADE = /\b(template|parser|schema|version|unsupported|capability)\b/;
const RE_SELECTOR = /\b(selector|selectors|dom|drift)\b/;
const RE_UPSTREAM = /\b(blocked|locked|unavailable|upstream)\b/;

function inferRecoveryAction(
  reason: string | null,
  message: string | null,
  interactionKind: string | null = null
): string {
  const text = `${reason || ""} ${message || ""} ${interactionKind || ""}`.toLowerCase();
  if (RE_MANUAL.test(text)) {
    return "manual_action_required";
  }
  if (RE_CREDENTIALS.test(text)) {
    return "refresh_credentials";
  }
  if (RE_TRANSIENT.test(text)) {
    return "retry_by_runtime";
  }
  if (RE_UPGRADE.test(text)) {
    return "retry_on_connector_upgrade";
  }
  if (RE_SELECTOR.test(text)) {
    return "update_selector";
  }
  if (RE_UPSTREAM.test(text)) {
    return "upstream_unblock";
  }
  return "unknown";
}

interface RecoveryHintInput {
  action?: unknown;
  retryable?: unknown;
}

export function normalizeRecoveryHint(
  input: unknown,
  {
    reason = null,
    message = null,
    interactionKind = null,
  }: { reason?: string | null; message?: string | null; interactionKind?: string | null } = {}
): { action: string; retryable: boolean } {
  const inferredAction = inferRecoveryAction(reason, message, interactionKind);
  if (typeof input === "string" && RECOVERY_ACTIONS.has(input)) {
    return { action: input, retryable: input === "retry_by_runtime" };
  }
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const r = input as RecoveryHintInput;
    const action = RECOVERY_ACTIONS.has(r.action as string) ? (r.action as string) : inferredAction;
    return {
      action,
      retryable: typeof r.retryable === "boolean" ? r.retryable : action === "retry_by_runtime",
    };
  }
  return {
    action: inferredAction,
    retryable: inferredAction === "retry_by_runtime",
  };
}

// ── GAP SCOPE + SEVERITY ──────────────────────────────────────────────────────

export function normalizeGapScope(msg: Record<string, unknown>): Record<string, unknown> | null {
  const scope: Record<string, unknown> = {};
  const resourceIds = boundGapStringList((msg.resource_ids || msg.resources) as unknown);
  if (resourceIds) {
    scope.resource_ids = resourceIds;
    if (
      Array.isArray(msg.resource_ids || msg.resources) &&
      ((msg.resource_ids || msg.resources) as unknown[]).length > GAP_LIST_MAX
    ) {
      scope.truncated = true;
    }
  }
  if (msg.time_range && typeof msg.time_range === "object" && !Array.isArray(msg.time_range)) {
    const tr = msg.time_range as Record<string, unknown>;
    const since = boundGapString(tr.since);
    const until = boundGapString(tr.until);
    if (since || until) {
      scope.time_range = {
        ...(since ? { since } : {}),
        ...(until ? { until } : {}),
      };
    }
  }
  return Object.keys(scope).length ? scope : null;
}

function classifyKnownGapSeverity({
  kind,
  reason,
  recoveryHint,
  explicitSelection = false,
  severity = null,
  streamRequired = true,
  unsupportedInDefaultScope = false,
}: {
  kind: string;
  reason: string;
  recoveryHint: unknown;
  explicitSelection?: boolean;
  severity?: string | null;
  streamRequired?: boolean;
  unsupportedInDefaultScope?: boolean;
}): string {
  if (typeof severity === "string" && GAP_SEVERITIES.has(severity)) {
    return severity;
  }
  if (kind === "detail_gap") {
    return "recoverable";
  }
  if (kind === "run_failed" || kind === "checkpoint_commit" || kind === "interaction_required") {
    return "actionable";
  }
  if (reason === "not_available" && unsupportedInDefaultScope && !explicitSelection) {
    return "informational";
  }
  if (explicitSelection && INFORMATIONAL_GAP_REASONS.has(reason)) {
    return "actionable";
  }
  if (INFORMATIONAL_GAP_REASONS.has(reason)) {
    return "informational";
  }
  if (TRANSIENT_GAP_REASONS.has(reason)) {
    return "transient";
  }
  const action = recoveryHintAction(recoveryHint);
  if (action === "retry_by_runtime") {
    return "transient";
  }
  if (isBrowserRuntimeCapability(recoveryHint, true)) {
    return "transient";
  }
  // Not owner-fixable and not runtime-retryable: the remedy is an
  // operational/placement decision (running this connector on a runtime
  // that advertises the required capability), which is a maintainer/system
  // concern, not something the owner can act on. Out of scope by design,
  // same as any other informational gap — but ONLY for a stream the
  // manifest itself marks non-required (`streamRequired === false`).
  // A required stream hitting this must stay actionable: the connector
  // cannot serve a mandatory stream, which the manifest promised it could.
  // Mirrors the explicitSelection override above: if the owner explicitly
  // asked for this stream, its absence is worth their attention even
  // though the underlying cause is a runtime placement issue.
  if (isBrowserRuntimeCapability(recoveryHint, false) && !streamRequired && !explicitSelection) {
    return "informational";
  }
  return "actionable";
}

// ── KNOWN GAP BUILDER ─────────────────────────────────────────────────────────

interface BuildKnownGapInput {
  diagnostics?: unknown;
  explicitSelection?: boolean;
  interactionKind?: string | null;
  kind: string;
  message?: string | null;
  reason?: string | null;
  recoveryHint?: unknown;
  scope?: Record<string, unknown> | null;
  severity?: string | null;
  stream?: string | null;
  streamRequired?: boolean;
  unsupportedInDefaultScope?: boolean;
}

export function buildKnownGap({
  kind,
  stream = null,
  reason = null,
  message = null,
  recoveryHint = null,
  scope = null,
  interactionKind = null,
  explicitSelection = false,
  severity = null,
  streamRequired = true,
  unsupportedInDefaultScope = false,
  diagnostics = null,
}: BuildKnownGapInput): Record<string, unknown> {
  const safeReason = boundGapString(reason) || "unknown";
  const safeMessage = boundGapString(message);
  const normalizedSeverity = classifyKnownGapSeverity({
    explicitSelection,
    kind,
    reason: safeReason,
    recoveryHint,
    severity,
    streamRequired,
    unsupportedInDefaultScope,
  });
  const boundedDiagnostics = normalizeConsideredInDiagnostics(boundGapDiagnostics(diagnostics));
  return {
    kind,
    reason: safeReason,
    severity: normalizedSeverity,
    stream: boundGapString(stream),
    ...(safeMessage ? { message: safeMessage } : {}),
    ...(scope ? { scope } : {}),
    recovery_hint: normalizeRecoveryHint(recoveryHint, {
      interactionKind,
      message: safeMessage,
      reason: safeReason,
    }),
    ...(boundedDiagnostics ? { diagnostics: boundedDiagnostics } : {}),
  };
}
