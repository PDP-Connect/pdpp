/**
 * PDPP Connector Runtime
 *
 * Spawns connector processes, manages the JSONL protocol,
 * handles INTERACTION, and ingests RECORDs to the RS via owner token.
 */
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createTraceContext, emitSpineEvent, getCurrentBootEpoch } from '../lib/spine.ts';
import { emitControllerBootedAndStashEpoch } from '../lib/controller-boot.ts';
import { isClosedPipeWriteError } from './pipe-errors.js';
import { deriveTerminalReason } from './terminal-reason.js';
import { createStderrTailBuffer } from './stderr-tail.js';
import { redactStderrTail } from './stderr-redact.js';
import { getDefaultConnectorDetailGapStore } from '../server/stores/connector-detail-gap-store.js';
import { classifyRecoveryError, maybeTerminateGap, terminalGapProfileForConnector } from '../server/stores/terminal-gap-classifier.js';
import { getDefaultConnectorAttentionStore } from '../server/stores/connector-attention-store.js';
import { createAttentionWriter } from './attention-writer.js';
import { canonicalConnectorKey } from '../server/connector-key.js';

// ─── Owned connector-child process-group registry ──────────────────────────
//
// Every connector child is spawned `detached` (its own process group; see the
// spawn site in `runConnector`). The runtime reaps that group on the run's own
// terminal paths (cancel / failure / protocol violation / error). But if the
// PARENT process dies abnormally — an `uncaughtException`/`unhandledRejection`
// that takes `process.exit(1)` (server/index.js handleUncaught), or any
// `process.exit()` with in-flight runs — Node does NOT propagate a signal to
// children, so a still-running connector group would reparent to PID 1 and
// orphan. That is exactly the run_1780436796334 / run_1780436796294 symptom.
//
// This registry closes that last gap: each live child's PID (== its PGID,
// because it leads its own group) is tracked while the run is in flight and
// removed on the run's terminal path. A SINGLE, idempotent `process.on('exit')`
// handler sweeps the registry and best-effort SIGTERMs each surviving group, so
// the runtime never leaves an owned connector subtree behind when its own
// process exits.
//
// `process.on('exit')` handlers must be synchronous; `process.kill(-pgid,...)`
// is synchronous and best-effort, which is the right shape here. The handler is
// installed at most once per module instance (the install-once guard) so the
// many-`runConnector`-calls-per-process test harness can't accumulate
// listeners — the same accumulation hazard that keeps the signal handlers in
// server/index.js behind an `argv[1]` guard.
const ownedConnectorChildPids = new Set();
let connectorChildExitSweepInstalled = false;

function installConnectorChildExitSweepOnce() {
  if (connectorChildExitSweepInstalled) return;
  connectorChildExitSweepInstalled = true;
  // 'exit' fires on normal exit AND on process.exit()/fatal-handler exit, but
  // NOT on SIGKILL/SIGSTOP (uninterceptable) — those are covered at the
  // container/orchestrator layer. Synchronous, best-effort, never throws.
  process.on('exit', () => {
    for (const pid of ownedConnectorChildPids) {
      if (typeof pid !== 'number' || pid <= 1) continue;
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        // Group already gone, or un-signalable; nothing else we can do
        // synchronously from an exit handler.
      }
    }
  });
}

function registerOwnedConnectorChild(pid) {
  if (typeof pid !== 'number' || pid <= 1) return;
  installConnectorChildExitSweepOnce();
  ownedConnectorChildPids.add(pid);
}

function unregisterOwnedConnectorChild(pid) {
  if (typeof pid !== 'number') return;
  ownedConnectorChildPids.delete(pid);
}

function encodeScopeResourceKey(key) {
  return Array.isArray(key) ? JSON.stringify(key) : String(key);
}

function buildRunSourceDescriptor(connectorId) {
  return { kind: 'connector', id: connectorId };
}

function buildStartDetailGap(gap) {
  return {
    gap_id: gap.gap_id,
    stream: gap.stream,
    record_key: gap.record_key ?? null,
    status: gap.status,
    detail_locator: gap.detail_locator ?? null,
    reference_only: true,
  };
}

const DETAIL_GAP_PAGE_MIN_BYTES = 16 * 1024;
const DETAIL_GAP_PAGE_DEFAULT_BYTES = 256 * 1024;
const DETAIL_GAP_PAGE_MAX_BYTES = 1024 * 1024;
const DETAIL_GAP_PAGE_MAX_CANDIDATE_ROWS = 500;
const DETAIL_GAP_PAGE_ASSUMED_AVG_BYTES = 1536;

function boundedPositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function detailGapPageByteBudget(requestedMaxBytes = null) {
  return boundedPositiveInteger(
    requestedMaxBytes ?? process.env.PDPP_DETAIL_GAP_PAGE_TARGET_BYTES,
    DETAIL_GAP_PAGE_DEFAULT_BYTES,
    { min: DETAIL_GAP_PAGE_MIN_BYTES, max: DETAIL_GAP_PAGE_MAX_BYTES },
  );
}

function serializedDetailGapBytes(entry) {
  try {
    return Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1;
  } catch {
    return DETAIL_GAP_PAGE_ASSUMED_AVG_BYTES;
  }
}

function normalizeDetailGapPageStreams(streams, scopeByStream) {
  if (streams == null) return null;
  if (!Array.isArray(streams)) {
    throw new Error('Connector emitted invalid DETAIL_GAPS_PAGE_REQUEST.streams: expected string array');
  }
  const normalized = [];
  const seen = new Set();
  for (const stream of streams) {
    if (typeof stream !== 'string' || !stream.trim()) {
      throw new Error('Connector emitted invalid DETAIL_GAPS_PAGE_REQUEST.streams: expected non-empty string array');
    }
    if (!scopeByStream.has(stream)) {
      throw new Error(`Connector emitted DETAIL_GAPS_PAGE_REQUEST for undeclared stream: ${stream}`);
    }
    if (seen.has(stream)) continue;
    seen.add(stream);
    normalized.push(stream);
  }
  return normalized.length ? normalized : null;
}

function validateDetailGapsPageRequest(msg, scopeByStream) {
  if (msg.reference_only !== true) {
    throw new Error('Connector emitted invalid DETAIL_GAPS_PAGE_REQUEST.reference_only: expected true');
  }
  if (typeof msg.request_id !== 'string' || !msg.request_id.trim()) {
    throw new Error('Connector emitted invalid DETAIL_GAPS_PAGE_REQUEST.request_id: expected non-empty string');
  }
  if (msg.max_bytes != null && (!Number.isFinite(msg.max_bytes) || msg.max_bytes <= 0)) {
    throw new Error('Connector emitted invalid DETAIL_GAPS_PAGE_REQUEST.max_bytes: expected positive number');
  }
  return {
    maxBytes: msg.max_bytes == null ? null : Math.floor(msg.max_bytes),
    requestId: msg.request_id,
    streams: normalizeDetailGapPageStreams(msg.streams, scopeByStream),
  };
}

function createDetailGapPageReader({
  connectorId,
  connectorInstanceId,
  detailGapStore,
  grantId,
  runId,
  allServedGapIds,
}) {
  let observedAverageBytes = DETAIL_GAP_PAGE_ASSUMED_AVG_BYTES;

  return async function readDetailGapPage({ maxBytes = null, streams = null } = {}) {
    const byteBudget = detailGapPageByteBudget(maxBytes);
    const candidateLimit = Math.max(
      1,
      Math.min(
        DETAIL_GAP_PAGE_MAX_CANDIDATE_ROWS,
        Math.ceil((byteBudget / Math.max(1, observedAverageBytes)) * 1.5),
      ),
    );
    const pendingGaps = (await detailGapStore.listPendingGaps({
      connectorId,
      connectorInstanceId,
      grantId,
      streams,
      limit: candidateLimit,
    })) ?? [];
    const detailGaps = [];
    const servedGapIds = [];
    let serializedBytes = 2; // JSON array brackets; exact enough for page sizing.
    let entryBytesTotal = 0;

    for (const gap of pendingGaps) {
      const entry = buildStartDetailGap(gap);
      const entryBytes = serializedDetailGapBytes(entry);
      if (detailGaps.length > 0 && serializedBytes + entryBytes > byteBudget) {
        break;
      }
      detailGaps.push(entry);
      servedGapIds.push(gap.gap_id);
      serializedBytes += entryBytes;
      entryBytesTotal += entryBytes;
      if (serializedBytes >= byteBudget) {
        break;
      }
    }

    if (detailGaps.length > 0) {
      const pageAverage = entryBytesTotal / detailGaps.length;
      observedAverageBytes = Math.max(
        1,
        Math.round((observedAverageBytes * 0.65) + (pageAverage * 0.35)),
      );
      // Mark served gaps in_progress so attempt_count increments before the
      // connector makes any provider requests. Re-deferred gaps (connector
      // emits DETAIL_GAP again) revert to pending via upsertPendingGap while
      // keeping the incremented attempt_count. Recovered gaps advance to
      // 'recovered' via DETAIL_GAP_RECOVERED handling.
      await Promise.all(servedGapIds.map((gapId) => detailGapStore.markGapStatus(gapId, 'in_progress', { runId })));
      if (allServedGapIds) {
        for (const gapId of servedGapIds) allServedGapIds.add(gapId);
      }
    }

    return {
      candidateLimit,
      detailGaps,
      servedGapIds,
      maxBytes: byteBudget,
      serializedBytes,
    };
  };
}

function appendUniqueFields(fields, extraFields) {
  const normalized = [...fields];
  const seen = new Set(fields);
  for (const field of extraFields) {
    if (!field || seen.has(field)) continue;
    normalized.push(field);
    seen.add(field);
  }
  return normalized;
}

function buildScopeFields(streamScope, manifestStream) {
  if (!Array.isArray(streamScope.fields)) {
    return streamScope.fields;
  }

  const requiredFields = manifestStream?.schema?.required || [];
  const primaryKeyFields = Array.isArray(manifestStream?.primary_key)
    ? manifestStream.primary_key
    : (manifestStream?.primary_key ? [manifestStream.primary_key] : []);
  const timeRangeFields = streamScope.time_range && manifestStream?.consent_time_field
    ? [manifestStream.consent_time_field]
    : [];

  return appendUniqueFields(streamScope.fields, [
    ...requiredFields,
    ...primaryKeyFields,
    ...timeRangeFields,
  ]);
}

function buildAvailableBindings(onInteraction) {
  // In this reference runtime, connectors run as local Node child processes
  // with full filesystem access by virtue of being child processes. We
  // advertise `filesystem` so file-based connectors can declare it as a
  // required binding per the Collection Profile spec.
  const bindings = { network: {}, filesystem: {}, browser: {} };
  if (typeof onInteraction === 'function') {
    bindings.interactive = {};
  }
  return bindings;
}

function runtimeFailureReasonFromResponse(status, code) {
  if (status === 401) return 'authentication_error';
  if (status === 403) return code || 'permission_error';
  if (status === 429) return code || 'rate_limit_error';
  if (status >= 400 && status < 500 && code) return code;
  return null;
}

function buildHttpFailure(message, status, bodyText) {
  let code = null;
  try {
    const parsed = JSON.parse(bodyText);
    code = parsed?.error?.code || null;
  } catch {}

  const err = new Error(`${message}: ${status} ${bodyText}`);
  const failureReason = runtimeFailureReasonFromResponse(status, code);
  if (failureReason) {
    err.failure_reason = failureReason;
  }
  if (code) {
    err.pdpp_error_code = code;
  }
  err.response_status = status;
  return err;
}

function responseBodyBytes(bodyText) {
  return Buffer.byteLength(String(bodyText || ''), 'utf8');
}

function buildIngestFailureDetails({
  batchSize,
  bodyText,
  contentType,
  phase,
  status,
  stream,
}) {
  return {
    stream,
    batch_size: batchSize,
    http_status: status,
    phase,
    response_content_type: contentType || null,
    response_body_bytes: responseBodyBytes(bodyText),
  };
}

function buildIngestHttpFailure(message, stream, batchSize, status, bodyText, contentType) {
  const err = buildHttpFailure(message, status, bodyText);
  if (!err.failure_reason) {
    err.failure_reason = 'ingest_http_error';
  }
  err.ingest_failure = buildIngestFailureDetails({
    batchSize,
    bodyText,
    contentType,
    phase: 'http_response',
    status,
    stream,
  });
  return err;
}

function buildInvalidIngestResponseFailure({ batchSize, bodyText, cause, contentType, phase, status, stream }) {
  const err = new Error(`Ingest response for ${stream} was invalid after HTTP ${status}: ${cause}`);
  err.failure_reason = 'ingest_response_invalid';
  err.response_status = status;
  err.ingest_failure = buildIngestFailureDetails({
    batchSize,
    bodyText,
    contentType,
    phase,
    status,
    stream,
  });
  return err;
}

async function readIngestResponse(resp, stream, batchSize) {
  const contentType = resp.headers.get('content-type');
  const bodyText = await resp.text();
  if (!resp.ok) {
    throw buildIngestHttpFailure(`Ingest failed for ${stream}`, stream, batchSize, resp.status, bodyText, contentType);
  }

  let result;
  try {
    result = JSON.parse(bodyText);
  } catch (err) {
    throw buildInvalidIngestResponseFailure({
      batchSize,
      bodyText,
      cause: err instanceof Error ? err.message : String(err),
      contentType,
      phase: 'parse_response',
      status: resp.status,
      stream,
    });
  }

  if (
    !result
    || !Number.isFinite(result.records_accepted)
    || !Number.isFinite(result.records_rejected)
  ) {
    throw buildInvalidIngestResponseFailure({
      batchSize,
      bodyText,
      cause: 'expected numeric records_accepted and records_rejected',
      contentType,
      phase: 'validate_response',
      status: resp.status,
      stream,
    });
  }

  return result;
}

/**
 * Runtime-authored structured diagnosis for a protocol violation.
 *
 * Scope (vertical slice): only `progress_for_undeclared_stream` is emitted
 * today. Remaining subtypes — listed in tmp/opaque-violation-diagnosis-memo.md —
 * are deferred until the shape proves out on a real case. If/when the full
 * enumeration lands, it should land via a dedicated OpenSpec change first.
 *
 * Invariants (must hold for every subtype ever added):
 *   - Runtime-authored only. A connector cannot construct or author this
 *     object — the runtime instantiates it at validator sites.
 *   - Field/stream NAMES are safe; record PAYLOAD and user-supplied VALUES
 *     are NEVER placed in a public field. (`received` is a stream/type name,
 *     not a record body.)
 *   - All fields are size-bounded by `toPublicShape()`.
 *   - Purely additive to the `run.failed` event shape — legacy consumers
 *     that don't know about `data.violation` keep working unchanged.
 */
const VIOLATION_STRING_MAX = 200;
const VIOLATION_LIST_MAX = 20;
const GAP_STRING_MAX = 200;
const GAP_LIST_MAX = 20;
const CONNECTOR_ERROR_MESSAGE_MAX = 500;
const KNOWN_GAPS_MAX = 50;
const GAP_DIAGNOSTICS_BYTES_MAX = 8 * 1024;
const GAP_DIAGNOSTICS_DEPTH_MAX = 6;
const GAP_DIAGNOSTICS_LIST_MAX = 32;
const GAP_SEVERITIES = new Set(['actionable', 'informational', 'recoverable', 'transient']);
const INFORMATIONAL_GAP_REASONS = new Set(['not_available_in_mode', 'out_of_scope', 'user_disabled']);
const TRANSIENT_GAP_REASONS = new Set([
  'http_429',
  'rate_limited',
  'retry_exhausted',
  'temporary_unavailable',
  'upstream_pressure',
  'upstream_pressure_deferred',
]);

const RECOVERY_ACTIONS = new Set([
  'retry_by_runtime',
  'retry_on_connector_upgrade',
  'refresh_credentials',
  'manual_action_required',
  'update_selector',
  'upstream_unblock',
  'not_retriable',
  'unknown',
]);

// Connector stderr-tail diagnostic. `tail` is the {text, bytes_observed,
// bytes_captured, truncated} object returned by the bounded stderr tail
// buffer. Returns the persistable shape:
//
//   {
//     object: 'connector_stderr_tail',
//     encoding: 'utf-8',
//     text: <redacted excerpt>,
//     bytes_observed: <int>,
//     bytes_captured: <int>,
//     truncated: <bool>,
//     redacted: <bool>,
//   }
//
// or null when the connector wrote no stderr.
// Concise runtime-authored failure_message for connector exits before DONE.
// Owner UI uses this as the authoritative line; the connector-authored
// stderr tail is supplementary, untrusted evidence.
function buildConnectorExitFailureMessage({ code, reason, phase }) {
  if (reason === 'connector_stdin_closed') {
    const phaseLabel = phase && phase !== 'unknown' ? ` during ${phase}` : '';
    return `Connector closed its stdin${phaseLabel} before emitting DONE.`;
  }
  if (typeof code === 'number' && Number.isFinite(code)) {
    return `Connector exited with code ${code} before emitting DONE.`;
  }
  return 'Connector exited before emitting DONE.';
}

function buildStderrTailDiagnostic(tail) {
  if (!tail || typeof tail !== 'object') return null;
  if (!tail.text || tail.bytes_captured === 0) return null;
  const { text: redactedText, redacted } = redactStderrTail(tail.text);
  return {
    object: 'connector_stderr_tail',
    encoding: 'utf-8',
    text: redactedText,
    bytes_observed: tail.bytes_observed,
    bytes_captured: tail.bytes_captured,
    truncated: Boolean(tail.truncated),
    redacted,
  };
}

function boundString(value) {
  if (typeof value !== 'string') return null;
  if (value.length <= VIOLATION_STRING_MAX) return value;
  return value.slice(0, VIOLATION_STRING_MAX - 1) + '…';
}

function boundStringList(values) {
  if (!Array.isArray(values)) return null;
  const safe = values.filter((v) => typeof v === 'string' && v.length > 0);
  if (safe.length <= VIOLATION_LIST_MAX) {
    return safe.map((v) => boundString(v));
  }
  return safe.slice(0, VIOLATION_LIST_MAX).map((v) => boundString(v));
}

function boundGapString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const redacted = trimmed
    .replace(/\b(bearer|token|password|passwd|cookie|secret|otp)\b\s*[:=]\s*["']?[^"',\s}]+/gi, '$1=[REDACTED]')
    .replace(/\b\d{6}\b/g, '[REDACTED_OTP]');
  if (redacted.length <= GAP_STRING_MAX) return redacted;
  return redacted.slice(0, GAP_STRING_MAX - 1) + '…';
}

/**
 * Sanitize a connector-authored error message before persisting it as
 * `connector_error_message` on a terminal spine event.  The message is
 * connector-authored and therefore untrusted: apply the same redaction
 * as redactStderrTail and cap the length.
 */
function boundConnectorErrorMessage(value) {
  if (typeof value !== 'string') return null;
  const { text } = redactStderrTail(value);
  if (text.length <= CONNECTOR_ERROR_MESSAGE_MAX) return text;
  return text.slice(0, CONNECTOR_ERROR_MESSAGE_MAX - 1) + '…';
}

function boundGapStringList(values) {
  if (!Array.isArray(values)) return null;
  const bounded = values.map((value) => boundGapString(value)).filter(Boolean);
  if (!bounded.length) return null;
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
function boundGapDiagnostics(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const projected = projectDiagnosticsNode(value, 0);
  if (projected == null) {
    return { truncated: true, reason: 'depth_overflow' };
  }
  let serialized;
  try {
    serialized = JSON.stringify(projected);
  } catch {
    return { truncated: true, reason: 'serialization_failed' };
  }
  if (serialized.length > GAP_DIAGNOSTICS_BYTES_MAX) {
    return { truncated: true, reason: 'size_overflow' };
  }
  return projected;
}

function projectDiagnosticsNode(value, depth) {
  if (value == null) return null;
  if (typeof value === 'string') {
    return boundGapString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (depth >= GAP_DIAGNOSTICS_DEPTH_MAX) {
    return Array.isArray(value)
      ? { truncated: true, reason: 'depth_overflow' }
      : { truncated: true, reason: 'depth_overflow' };
  }
  if (Array.isArray(value)) {
    const items = [];
    const limit = Math.min(value.length, GAP_DIAGNOSTICS_LIST_MAX);
    for (let i = 0; i < limit; i += 1) {
      const projected = projectDiagnosticsNode(value[i], depth + 1);
      if (projected !== undefined) {
        items.push(projected);
      }
    }
    if (value.length > GAP_DIAGNOSTICS_LIST_MAX) {
      items.push({ truncated: true, reason: 'list_overflow', omitted: value.length - GAP_DIAGNOSTICS_LIST_MAX });
    }
    return items;
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      const projected = projectDiagnosticsNode(child, depth + 1);
      if (projected !== undefined) {
        out[key] = projected;
      }
    }
    return out;
  }
  return undefined;
}

/**
 * Normalize an optional connector-declared `considered` denominator into either
 * a trusted safe non-negative integer or `null` (= `unknown`, omit the field).
 *
 * A `considered` value is evidence only: it labels how many items the connector
 * claims it weighed for a stream/boundary. It is never trusted unless it is a
 * safe non-negative integer. Anything else — non-number, NaN/Infinity, negative,
 * fractional, or outside JavaScript's precise integer range — is dropped to
 * `null` so it cannot fabricate a completeness denominator. The
 * runtime never infers `considered` from collected counts (that conflation is
 * explicitly rejected by the progress-evidence contract); absence stays
 * `unknown`. Mirrors the drop-don't-reject posture of `boundGapDiagnostics`:
 * malformed evidence is omitted, not a protocol violation.
 */
function boundConsideredCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
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
function normalizeConsideredInDiagnostics(boundedDiagnostics) {
  if (
    boundedDiagnostics == null
    || typeof boundedDiagnostics !== 'object'
    || Array.isArray(boundedDiagnostics)
    || !Object.prototype.hasOwnProperty.call(boundedDiagnostics, 'considered')
  ) {
    return boundedDiagnostics;
  }
  const considered = boundConsideredCount(boundedDiagnostics.considered);
  if (considered == null) {
    delete boundedDiagnostics.considered;
  } else {
    boundedDiagnostics.considered = considered;
  }
  return boundedDiagnostics;
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
 *   - no `coverage`, `coverage_axis`, `forward_disposition`, `freshness`, or
 *     `refresh` key, on the block or on any entry.
 *
 * @returns {{ reference_only: true, schema_version: number, streams: object[] }
 *           | null} the block, or null when there is no in-scope stream universe.
 */
function buildCollectionFacts({
  scopeByStream,
  emittedByStream,
  knownGaps,
  durableDetailGaps,
  detailCoverageByStateStream,
  newState,
  committedStateStreams,
  persistState,
}) {
  const inScopeStreams = [...scopeByStream.keys()];
  if (!inScopeStreams.length) return null;

  // Map each data `stream` to the `state_stream` whose checkpoint covers it.
  // Default: a stream checkpoints itself (state_stream === stream). For
  // list-plus-detail connectors the detail `stream` (e.g. other_items) is
  // covered by the list `state_stream` (e.g. items); DETAIL_COVERAGE entries
  // carry both, so we learn the mapping from them.
  const streamToStateStream = new Map();
  for (const [stateStream, entries] of detailCoverageByStateStream) {
    for (const entry of entries) {
      if (entry?.stream && !streamToStateStream.has(entry.stream)) {
        streamToStateStream.set(entry.stream, stateStream);
      }
    }
  }

  const committed = committedStateStreams instanceof Set
    ? committedStateStreams
    : new Set(committedStateStreams || []);
  const stagedStateStreams = new Set(Object.keys(newState || {}));

  const checkpointForStateStream = (stateStream) => {
    if (!persistState) return 'disabled';
    if (committed.has(stateStream)) return 'committed';
    if (stagedStateStreams.has(stateStream)) return 'not_committed';
    return 'not_staged';
  };

  // First declared considered (DETAIL_COVERAGE.considered) wins, else the
  // required-keys count, else unknown (omitted). Never derived from collected.
  const declaredConsideredForStream = (stream) => {
    let requiredKeysFallback = null;
    for (const entries of detailCoverageByStateStream.values()) {
      for (const entry of entries) {
        if (entry?.stream !== stream) continue;
        if (typeof entry.considered === 'number') return entry.considered;
        if (requiredKeysFallback == null && Array.isArray(entry.requiredKeys)) {
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
  const declaredCoveredForStream = (stream) => {
    for (const entries of detailCoverageByStateStream.values()) {
      for (const entry of entries) {
        if (entry?.stream !== stream) continue;
        if (typeof entry.covered === 'number') return entry.covered;
      }
    }
    return null;
  };

  const skipForStream = (stream) => {
    const gap = knownGaps.find(
      (candidate) => candidate.kind === 'skip_result' && candidate.stream === stream,
    );
    if (!gap) return null;
    const action = gap.recovery_hint && typeof gap.recovery_hint === 'object'
      ? gap.recovery_hint.action
      : null;
    return {
      reason: gap.reason,
      ...(action ? { recovery_action: action } : {}),
    };
  };

  const pendingDetailGapsForStream = (stream) => durableDetailGaps.filter(
    (gap) => gap.stream === stream && gap.status === 'pending',
  ).length;

  const streams = inScopeStreams.map((stream) => {
    const considered = declaredConsideredForStream(stream);
    const covered = declaredCoveredForStream(stream);
    const stateStream = streamToStateStream.get(stream) || stream;
    return {
      stream,
      collected: emittedByStream.get(stream) || 0,
      // Omit when unknown — absence reads as `unknown` downstream; never
      // inferred from collected count.
      ...(considered == null ? {} : { considered }),
      // Optional covered count (task 4.4): omit when unknown. When present the
      // projection compares `considered` against this instead of `collected`.
      ...(covered == null ? {} : { covered }),
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

function inferRecoveryAction(reason, message, interactionKind = null) {
  const text = `${reason || ''} ${message || ''} ${interactionKind || ''}`.toLowerCase();
  if (/\b(otp|mfa|2fa|manual|captcha|anti[-_ ]?bot)\b/.test(text)) {
    return 'manual_action_required';
  }
  if (/\b(credential|credentials|auth|login|session_expired|reauth|token)\b/.test(text)) {
    return 'refresh_credentials';
  }
  if (/\b(rate|429|timeout|timed out|5\d\d|network|temporar|retry)\b/.test(text)) {
    return 'retry_by_runtime';
  }
  if (/\b(template|parser|schema|version|unsupported|capability)\b/.test(text)) {
    return 'retry_on_connector_upgrade';
  }
  if (/\b(selector|selectors|dom|drift)\b/.test(text)) {
    return 'update_selector';
  }
  if (/\b(blocked|locked|unavailable|upstream)\b/.test(text)) {
    return 'upstream_unblock';
  }
  return 'unknown';
}

function normalizeRecoveryHint(input, { reason = null, message = null, interactionKind = null } = {}) {
  const inferredAction = inferRecoveryAction(reason, message, interactionKind);
  if (typeof input === 'string' && RECOVERY_ACTIONS.has(input)) {
    return { action: input, retryable: input === 'retry_by_runtime' };
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const action = RECOVERY_ACTIONS.has(input.action) ? input.action : inferredAction;
    return {
      action,
      retryable: typeof input.retryable === 'boolean' ? input.retryable : action === 'retry_by_runtime',
    };
  }
  return {
    action: inferredAction,
    retryable: inferredAction === 'retry_by_runtime',
  };
}

function normalizeGapScope(msg) {
  const scope = {};
  const resourceIds = boundGapStringList(msg.resource_ids || msg.resources);
  if (resourceIds) {
    scope.resource_ids = resourceIds;
    if (Array.isArray(msg.resource_ids || msg.resources) && (msg.resource_ids || msg.resources).length > GAP_LIST_MAX) {
      scope.truncated = true;
    }
  }
  if (msg.time_range && typeof msg.time_range === 'object' && !Array.isArray(msg.time_range)) {
    const since = boundGapString(msg.time_range.since);
    const until = boundGapString(msg.time_range.until);
    if (since || until) {
      scope.time_range = {
        ...(since ? { since } : {}),
        ...(until ? { until } : {}),
      };
    }
  }
  return Object.keys(scope).length ? scope : null;
}

function streamUnsupportedInDefaultScope(stream) {
  return stream?.availability?.state === 'unsupported_in_mode';
}

function classifyKnownGapSeverity({
  kind,
  reason,
  recoveryHint,
  explicitSelection = false,
  severity = null,
  unsupportedInDefaultScope = false,
}) {
  if (typeof severity === 'string' && GAP_SEVERITIES.has(severity)) {
    return severity;
  }
  if (kind === 'detail_gap') {
    return 'recoverable';
  }
  if (kind === 'run_failed' || kind === 'checkpoint_commit' || kind === 'interaction_required') {
    return 'actionable';
  }
  if (reason === 'not_available' && unsupportedInDefaultScope && !explicitSelection) {
    return 'informational';
  }
  if (explicitSelection && INFORMATIONAL_GAP_REASONS.has(reason)) {
    return 'actionable';
  }
  if (INFORMATIONAL_GAP_REASONS.has(reason)) {
    return 'informational';
  }
  if (TRANSIENT_GAP_REASONS.has(reason)) {
    return 'transient';
  }
  const action =
    typeof recoveryHint === 'string'
      ? recoveryHint
      : recoveryHint && typeof recoveryHint === 'object'
        ? recoveryHint.action
        : null;
  if (action === 'retry_by_runtime') {
    return 'transient';
  }
  return 'actionable';
}

function buildKnownGap({
  kind,
  stream = null,
  reason = null,
  message = null,
  recoveryHint = null,
  scope = null,
  interactionKind = null,
  explicitSelection = false,
  severity = null,
  unsupportedInDefaultScope = false,
  diagnostics = null,
}) {
  const safeReason = boundGapString(reason) || 'unknown';
  const safeMessage = boundGapString(message);
  const normalizedSeverity = classifyKnownGapSeverity({
    kind,
    reason: safeReason,
    recoveryHint,
    explicitSelection,
    severity,
    unsupportedInDefaultScope,
  });
  const boundedDiagnostics = normalizeConsideredInDiagnostics(boundGapDiagnostics(diagnostics));
  return {
    kind,
    stream: boundGapString(stream),
    reason: safeReason,
    severity: normalizedSeverity,
    ...(safeMessage ? { message: safeMessage } : {}),
    ...(scope ? { scope } : {}),
    recovery_hint: normalizeRecoveryHint(recoveryHint, {
      reason: safeReason,
      message: safeMessage,
      interactionKind,
    }),
    ...(boundedDiagnostics ? { diagnostics: boundedDiagnostics } : {}),
  };
}

function summarizeKnownGaps(gaps) {
  const byReason = {};
  for (const gap of gaps) {
    byReason[gap.reason] = (byReason[gap.reason] || 0) + 1;
  }
  return {
    count: gaps.length,
    truncated: gaps.length > KNOWN_GAPS_MAX,
    by_reason: byReason,
  };
}

function toPublicIngestFailure(value) {
  if (!value || typeof value !== 'object') return null;
  const out = {};
  const stream = boundString(value.stream);
  const phase = boundString(value.phase);
  const contentType = boundString(value.response_content_type);
  if (stream) out.stream = stream;
  if (Number.isFinite(value.batch_size)) out.batch_size = value.batch_size;
  if (Number.isFinite(value.http_status)) out.http_status = value.http_status;
  if (phase) out.phase = phase;
  if (contentType) out.response_content_type = contentType;
  if (Number.isFinite(value.response_body_bytes)) out.response_body_bytes = value.response_body_bytes;
  return Object.keys(out).length ? out : null;
}

class ProtocolViolation extends Error {
  constructor({ subtype, message, ...extras }) {
    super(message);
    this.name = 'ProtocolViolation';
    this.subtype = subtype;
    this.extras = extras;
  }

  /**
   * Bound, sanitized, timeline-safe projection. Returning a plain object
   * here (rather than the raw `extras`) is load-bearing: this is what
   * lands in persisted spine events + gets rendered in the dashboard.
   */
  toPublicShape({ lastValidSpineEvent = null } = {}) {
    const out = { subtype: this.subtype };
    if (this.subtype === 'progress_for_undeclared_stream') {
      const { message_type, stream, expected, received } = this.extras;
      out.message_type = boundString(message_type);
      out.stream = boundString(stream);
      const boundedExpected = boundStringList(expected);
      if (boundedExpected) out.expected = boundedExpected;
      out.received = boundString(received);
      if (Array.isArray(expected) && expected.length > VIOLATION_LIST_MAX) {
        out.truncated = true;
      }
    }
    if (lastValidSpineEvent?.event_id) {
      out.last_valid_event_id = lastValidSpineEvent.event_id;
      if (lastValidSpineEvent.event_type) {
        out.last_valid_event_type = lastValidSpineEvent.event_type;
      }
    }
    return out;
  }
}

function classifyRuntimeFailure(err) {
  if (typeof err?.failure_reason === 'string' && err.failure_reason.trim()) {
    return err.failure_reason;
  }
  const message = err?.message || '';
  if (
    message === 'Interaction handler returned an invalid INTERACTION_RESPONSE envelope'
    || message.startsWith('Invalid INTERACTION_RESPONSE status:')
  ) {
    return 'interaction_handler_invalid_response';
  }
  if (
    message === 'Connector emitted INTERACTION while already waiting'
    || message === 'Connector emitted INTERACTION but START.bindings omitted interactive'
    || message.includes(' while waiting for INTERACTION_RESPONSE')
    || message.startsWith('Connector emitted invalid INTERACTION.')
    || message.startsWith('Connector emitted invalid STATE.')
    || message.startsWith('Connector emitted INTERACTION for undeclared stream:')
    || message.startsWith('Connector emitted invalid PROGRESS.')
    || message.startsWith('Connector emitted invalid ASSISTANCE.')
    || message.startsWith('Connector emitted unsupported ASSISTANCE.')
    || message.startsWith('Connector emitted invalid SKIP_RESULT.')
    || message.startsWith('Connector emitted invalid DETAIL_GAP.')
    || message.startsWith('Connector emitted invalid DETAIL_COVERAGE.')
    || message.startsWith('Connector emitted invalid DETAIL_GAP_RECOVERED.')
    || message.startsWith('Connector emitted DETAIL_COVERAGE for undeclared stream:')
    || message.startsWith('Connector emitted DETAIL_GAP_RECOVERED for undeclared stream:')
    || message.startsWith('Connector detail coverage incomplete:')
    || message.startsWith('Connector emitted PROGRESS for undeclared stream:')
    || message.startsWith('Connector emitted SKIP_RESULT for undeclared stream:')
    || message.startsWith('Connector emitted DETAIL_GAP for undeclared stream:')
    || message.startsWith('Connector emitted invalid DONE status:')
    || message.startsWith('Connector emitted invalid DONE.error')
    || message.startsWith('Connector emitted invalid DONE.records_emitted:')
    || message.startsWith('Connector reported records_emitted ')
    || message.startsWith('Connector emitted RECORD')
    || message.startsWith('Connector emitted STATE')
    || message.startsWith('Connector emitted unknown message type:')
    || message.startsWith('Connector emitted invalid JSONL:')
    || message.startsWith('Connector exit code ')
    || (message.startsWith('Connector emitted ') && message.includes(' after DONE'))
  ) {
    return 'connector_protocol_violation';
  }
  return 'runtime_error';
}

function buildStartScope(manifest, providedScope) {
  const manifestByStream = new Map((manifest?.streams || []).map((stream) => [stream.name, stream]));

  if (providedScope != null) {
    if (!Array.isArray(providedScope.streams) || !providedScope.streams.length) {
      throw new Error('START.scope must include a non-empty streams array');
    }
    return {
      streams: providedScope.streams.map((streamScope) => {
        const manifestStream = manifestByStream.get(streamScope?.name);
        if (typeof streamScope?.name !== 'string' || !streamScope.name.trim()) {
          throw new Error('START.scope streams must include non-empty stream names');
        }
        if (streamScope.name === '*') {
          throw new Error('START.scope must not include wildcard stream names');
        }
        if (!manifestStream) {
          throw new Error(`START.scope stream '${streamScope.name}' does not exist in the manifest`);
        }
        if ('view' in streamScope) {
          throw new Error(`START.scope stream '${streamScope.name}' must not include unresolved view names`);
        }
        if ('necessity' in streamScope) {
          throw new Error(`START.scope stream '${streamScope.name}' must not include issuance-time necessity values`);
        }
        if (streamScope.resources != null) {
          if (!Array.isArray(streamScope.resources) || streamScope.resources.some((resource) => typeof resource !== 'string')) {
            throw new Error(`START.scope stream '${streamScope.name}' resources must be an array of strings`);
          }
        }
        if (streamScope.fields != null) {
          if (!Array.isArray(streamScope.fields) || streamScope.fields.some((field) => typeof field !== 'string' || !field.trim())) {
            throw new Error(`START.scope stream '${streamScope.name}' fields must be an array of non-empty field names`);
          }
        }
        if (streamScope.time_range != null) {
          if (typeof streamScope.time_range !== 'object' || Array.isArray(streamScope.time_range)) {
            throw new Error(`START.scope stream '${streamScope.name}' time_range must be an object`);
          }
          if (
            (streamScope.time_range.since != null && (typeof streamScope.time_range.since !== 'string' || !streamScope.time_range.since.trim()))
            || (streamScope.time_range.until != null && (typeof streamScope.time_range.until !== 'string' || !streamScope.time_range.until.trim()))
          ) {
            throw new Error(`START.scope stream '${streamScope.name}' time_range bounds must be non-empty strings`);
          }
        }
        return {
          ...streamScope,
          ...(Array.isArray(streamScope.fields)
            ? { fields: buildScopeFields(streamScope, manifestStream) }
            : {}),
        };
      }),
    };
  }

  const streams = (manifest?.streams || [])
    .filter((stream) => !streamUnsupportedInDefaultScope(stream))
    .map((stream) => ({ name: stream.name }));
  if (!streams.length) {
    throw new Error('START.scope requires at least one stream');
  }

  return { streams };
}

function validateCollectionMode(collectionMode) {
  if (collectionMode === 'full_refresh' || collectionMode === 'incremental') {
    return collectionMode;
  }
  throw new Error(`START.collection_mode must be 'full_refresh' or 'incremental'; received: ${collectionMode}`);
}

function validateStartState(state) {
  if (state == null) return null;
  if (typeof state === 'object' && !Array.isArray(state)) {
    for (const [stream, cursor] of Object.entries(state)) {
      if (cursor != null && (typeof cursor !== 'object' || Array.isArray(cursor))) {
        throw new Error(`START.state stream '${stream}' must be an object or null`);
      }
    }
    return state;
  }
  throw new Error('START.state must be an object or null');
}

function validateStateMessage(msg, scopeByStream) {
  if (typeof msg.stream !== 'string' || !msg.stream.trim()) {
    throw new Error('Connector emitted invalid STATE.stream: expected non-empty string');
  }
  if (!scopeByStream.has(msg.stream)) {
    throw new Error(`Connector emitted STATE for undeclared stream: ${msg.stream}`);
  }
  if (msg.cursor != null && (typeof msg.cursor !== 'object' || Array.isArray(msg.cursor))) {
    throw new Error('Connector emitted invalid STATE.cursor: expected object or null');
  }
}

function passesTimeRange(data, timeRange, consentTimeField) {
  if (!timeRange || !consentTimeField) return true;
  const value = data?.[consentTimeField];
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return false;
  if (timeRange.since && timestamp < new Date(timeRange.since).getTime()) return false;
  if (timeRange.until && timestamp >= new Date(timeRange.until).getTime()) return false;
  return true;
}

function validateDoneExitCode(doneMessage, exitCode) {
  if (!doneMessage) return null;
  if (doneMessage.status === 'succeeded' && exitCode !== 0) {
    return new Error(`Connector exit code ${exitCode} does not match DONE status: succeeded`);
  }
  if ((doneMessage.status === 'failed' || doneMessage.status === 'cancelled') && exitCode === 0) {
    return new Error(`Connector exit code ${exitCode} does not match DONE status: ${doneMessage.status}`);
  }
  return null;
}

function validateDoneRecordsEmitted(doneMessage, observedRecordsEmitted) {
  if (!doneMessage) return null;
  if (!Number.isInteger(doneMessage.records_emitted) || doneMessage.records_emitted < 0) {
    return new Error(`Connector emitted invalid DONE.records_emitted: ${doneMessage.records_emitted}`);
  }
  if (doneMessage.records_emitted !== observedRecordsEmitted) {
    return new Error(
      `Connector reported records_emitted ${doneMessage.records_emitted} but runtime observed ${observedRecordsEmitted}`
    );
  }
  return null;
}

function validateDoneStatus(status) {
  if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
    return null;
  }
  return new Error(`Connector emitted invalid DONE status: ${status}`);
}

function validateDoneError(status, error) {
  if (error == null) return null;
  if (status === 'succeeded') {
    return new Error('Connector emitted invalid DONE.error: succeeded runs must not include terminal error details');
  }
  if (typeof error !== 'object' || Array.isArray(error)) {
    return new Error('Connector emitted invalid DONE.error: expected object');
  }
  const unsupportedFields = Object.keys(error).filter((field) => field !== 'message' && field !== 'retryable');
  if (unsupportedFields.length) {
    return new Error(`Connector emitted invalid DONE.error: unsupported fields ${unsupportedFields.join(', ')}`);
  }
  if (typeof error.message !== 'string' || !error.message.trim()) {
    return new Error('Connector emitted invalid DONE.error.message: expected non-empty string');
  }
  if (error.retryable != null && typeof error.retryable !== 'boolean') {
    return new Error('Connector emitted invalid DONE.error.retryable: expected boolean');
  }
  return {
    message: error.message.trim(),
    retryable: error.retryable ?? null,
  };
}

function requireOptionalNonEmptyString(value, fieldName) {
  if (value == null) return;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Connector emitted invalid ${fieldName}: expected non-empty string`);
  }
}

function validateOptionalScopedStream(stream, envelopeType, scopeByStream) {
  if (stream == null) return;
  if (!scopeByStream.has(stream)) {
    // String form preserved for back-compat with classifyRuntimeFailure's
    // pattern match (still yields top-level reason: connector_protocol_violation).
    // For PROGRESS specifically we also carry a machine-readable ProtocolViolation;
    // other envelope types keep the legacy plain Error for now (tracked in
    // tmp/opaque-violation-diagnosis-memo.md).
    const message = `Connector emitted ${envelopeType} for undeclared stream: ${stream}`;
    if (envelopeType === 'PROGRESS') {
      throw new ProtocolViolation({
        subtype: 'progress_for_undeclared_stream',
        message,
        message_type: 'PROGRESS',
        stream,
        expected: Array.from(scopeByStream.keys()),
        received: stream,
      });
    }
    throw new Error(message);
  }
}

function validateProgressMessage(msg, scopeByStream) {
  requireOptionalNonEmptyString(msg.stream, 'PROGRESS.stream');
  validateOptionalScopedStream(msg.stream, 'PROGRESS', scopeByStream);
  if (typeof msg.message !== 'string' || !msg.message.trim()) {
    throw new Error('Connector emitted invalid PROGRESS.message: expected non-empty string');
  }
  for (const fieldName of ['count', 'total']) {
    const value = msg[fieldName];
    if (value == null) continue;
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Connector emitted invalid PROGRESS.${fieldName}: expected non-negative number`);
    }
  }
  if (msg.provider_budget != null) {
    validateProgressProviderBudget(msg.provider_budget);
  }
  if (msg.collection_rate != null) {
    validateProgressCollectionRate(msg.collection_rate);
  }
}

const PROVIDER_BUDGET_PROGRESS_OBJECTS = new Set(['provider_budget_circuit_transition']);
const PROVIDER_BUDGET_CIRCUIT_STATES = new Set(['closed', 'half_open', 'open']);
const PROVIDER_BUDGET_CIRCUIT_REASONS = new Set([
  'provider_failure',
  'provider_throttle',
  'reset_timeout',
  'success',
]);
const PROVIDER_BUDGET_CIRCUIT_TRIGGERS = new Set([
  'before_request',
  'provider_failure',
  'provider_throttle',
  'success',
]);

function validateProgressProviderBudget(providerBudget) {
  if (!providerBudget || typeof providerBudget !== 'object' || Array.isArray(providerBudget)) {
    throw new Error('Connector emitted invalid PROGRESS.provider_budget: expected object');
  }
  if (!PROVIDER_BUDGET_PROGRESS_OBJECTS.has(providerBudget.object)) {
    throw new Error('Connector emitted invalid PROGRESS.provider_budget.object');
  }
  const circuit = providerBudget.circuit;
  if (!circuit || typeof circuit !== 'object' || Array.isArray(circuit)) {
    throw new Error('Connector emitted invalid PROGRESS.provider_budget.circuit: expected object');
  }
  if (!PROVIDER_BUDGET_CIRCUIT_STATES.has(circuit.previous_state)) {
    throw new Error('Connector emitted invalid PROGRESS.provider_budget.circuit.previous_state');
  }
  if (!PROVIDER_BUDGET_CIRCUIT_STATES.has(circuit.state)) {
    throw new Error('Connector emitted invalid PROGRESS.provider_budget.circuit.state');
  }
  if (!PROVIDER_BUDGET_CIRCUIT_REASONS.has(circuit.reason)) {
    throw new Error('Connector emitted invalid PROGRESS.provider_budget.circuit.reason');
  }
  if (!PROVIDER_BUDGET_CIRCUIT_TRIGGERS.has(circuit.trigger)) {
    throw new Error('Connector emitted invalid PROGRESS.provider_budget.circuit.trigger');
  }
  for (const fieldName of ['elapsed_ms', 'request_count']) {
    const value = providerBudget[fieldName];
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Connector emitted invalid PROGRESS.provider_budget.${fieldName}`);
    }
  }
  const retryTokensRemaining = providerBudget.retry_tokens_remaining;
  if (
    retryTokensRemaining != null
    && retryTokensRemaining !== 'unbounded'
    && (!Number.isFinite(retryTokensRemaining) || retryTokensRemaining < 0)
  ) {
    throw new Error('Connector emitted invalid PROGRESS.provider_budget.retry_tokens_remaining');
  }
}

const COLLECTION_RATE_BACKOFF_REASONS = new Set(['retry_after', 'throttle']);

function validateProgressCollectionRate(collectionRate) {
  if (!collectionRate || typeof collectionRate !== 'object' || Array.isArray(collectionRate)) {
    throw new Error('Connector emitted invalid PROGRESS.collection_rate: expected object');
  }
  if (collectionRate.object !== 'collection_rate') {
    throw new Error('Connector emitted invalid PROGRESS.collection_rate.object');
  }
  for (const fieldName of ['ceiling_interval_ms', 'ceiling_rate_per_min', 'current_interval_ms', 'effective_rate_per_min']) {
    const value = collectionRate[fieldName];
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Connector emitted invalid PROGRESS.collection_rate.${fieldName}: expected non-negative number`);
    }
  }
  const lastBackoff = collectionRate.last_backoff;
  if (lastBackoff != null) {
    if (!lastBackoff || typeof lastBackoff !== 'object' || Array.isArray(lastBackoff)) {
      throw new Error('Connector emitted invalid PROGRESS.collection_rate.last_backoff: expected object or null');
    }
    if (!Number.isFinite(lastBackoff.at_interval_ms) || lastBackoff.at_interval_ms < 0) {
      throw new Error('Connector emitted invalid PROGRESS.collection_rate.last_backoff.at_interval_ms');
    }
    if (!COLLECTION_RATE_BACKOFF_REASONS.has(lastBackoff.reason)) {
      throw new Error('Connector emitted invalid PROGRESS.collection_rate.last_backoff.reason');
    }
  }
}

function validateSkipResultMessage(msg, scopeByStream) {
  requireOptionalNonEmptyString(msg.stream, 'SKIP_RESULT.stream');
  validateOptionalScopedStream(msg.stream, 'SKIP_RESULT', scopeByStream);
  requireOptionalNonEmptyString(msg.reason, 'SKIP_RESULT.reason');
  requireOptionalNonEmptyString(msg.message, 'SKIP_RESULT.message');
  if (msg.recovery_hint != null) {
    const validRecoveryHint =
      (typeof msg.recovery_hint === 'string' && RECOVERY_ACTIONS.has(msg.recovery_hint))
      || (
        typeof msg.recovery_hint === 'object'
        && !Array.isArray(msg.recovery_hint)
        && (msg.recovery_hint.action == null || RECOVERY_ACTIONS.has(msg.recovery_hint.action))
        && (msg.recovery_hint.retryable == null || typeof msg.recovery_hint.retryable === 'boolean')
      );
    if (!validRecoveryHint) {
      throw new Error('Connector emitted invalid SKIP_RESULT.recovery_hint');
    }
  }
  for (const fieldName of ['resource_ids', 'resources']) {
    if (msg[fieldName] != null && (!Array.isArray(msg[fieldName]) || msg[fieldName].some((value) => typeof value !== 'string' || !value.trim()))) {
      throw new Error(`Connector emitted invalid SKIP_RESULT.${fieldName}: expected non-empty string array`);
    }
  }
  if (msg.time_range != null) {
    if (typeof msg.time_range !== 'object' || Array.isArray(msg.time_range)) {
      throw new Error('Connector emitted invalid SKIP_RESULT.time_range: expected object');
    }
    for (const fieldName of ['since', 'until']) {
      const value = msg.time_range[fieldName];
      if (value != null && (typeof value !== 'string' || !value.trim())) {
        throw new Error(`Connector emitted invalid SKIP_RESULT.time_range.${fieldName}: expected non-empty string`);
      }
    }
  }
}

function validateDetailGapMessage(msg, scopeByStream) {
  requireOptionalNonEmptyString(msg.stream, 'DETAIL_GAP.stream');
  if (!msg.stream) {
    throw new Error('Connector emitted invalid DETAIL_GAP.stream: expected non-empty string');
  }
  validateOptionalScopedStream(msg.stream, 'DETAIL_GAP', scopeByStream);
  requireOptionalNonEmptyString(msg.parent_stream, 'DETAIL_GAP.parent_stream');
  if (msg.record_key != null && typeof msg.record_key !== 'string' && typeof msg.record_key !== 'number') {
    throw new Error('Connector emitted invalid DETAIL_GAP.record_key: expected string or number');
  }
  for (const fieldName of ['detail_locator', 'list_cursor', 'last_error']) {
    if (msg[fieldName] != null && (typeof msg[fieldName] !== 'object' || Array.isArray(msg[fieldName]))) {
      throw new Error(`Connector emitted invalid DETAIL_GAP.${fieldName}: expected object`);
    }
  }
  requireOptionalNonEmptyString(msg.reason, 'DETAIL_GAP.reason');
  if (msg.retryable != null && typeof msg.retryable !== 'boolean') {
    throw new Error('Connector emitted invalid DETAIL_GAP.retryable: expected boolean');
  }
}

function assertCoverageKeyArray(value, fieldName) {
  if (!Array.isArray(value)) {
    throw new Error(`Connector emitted invalid DETAIL_COVERAGE.${fieldName}: expected string/number array`);
  }
  for (const key of value) {
    if (typeof key !== 'string' && typeof key !== 'number') {
      throw new Error(`Connector emitted invalid DETAIL_COVERAGE.${fieldName}: expected string/number array`);
    }
  }
}

function normalizeCoverageKey(key) {
  return String(key);
}

function validateDetailCoverageMessage(msg, scopeByStream) {
  if (msg.reference_only !== true) {
    throw new Error('Connector emitted invalid DETAIL_COVERAGE.reference_only: expected true');
  }
  requireOptionalNonEmptyString(msg.state_stream, 'DETAIL_COVERAGE.state_stream');
  if (!msg.state_stream) {
    throw new Error('Connector emitted invalid DETAIL_COVERAGE.state_stream: expected non-empty string');
  }
  validateOptionalScopedStream(msg.state_stream, 'DETAIL_COVERAGE', scopeByStream);
  requireOptionalNonEmptyString(msg.stream, 'DETAIL_COVERAGE.stream');
  if (!msg.stream) {
    throw new Error('Connector emitted invalid DETAIL_COVERAGE.stream: expected non-empty string');
  }
  validateOptionalScopedStream(msg.stream, 'DETAIL_COVERAGE', scopeByStream);

  assertCoverageKeyArray(msg.required_keys, 'required_keys');
  assertCoverageKeyArray(msg.hydrated_keys, 'hydrated_keys');
  if (msg.gap_keys != null) assertCoverageKeyArray(msg.gap_keys, 'gap_keys');
  if (msg.optional_skip_keys != null) assertCoverageKeyArray(msg.optional_skip_keys, 'optional_skip_keys');
}

function validateDetailGapRecoveredMessage(msg, scopeByStream) {
  requireOptionalNonEmptyString(msg.gap_id, 'DETAIL_GAP_RECOVERED.gap_id');
  if (!msg.gap_id) {
    throw new Error('Connector emitted invalid DETAIL_GAP_RECOVERED.gap_id: expected non-empty string');
  }
  requireOptionalNonEmptyString(msg.stream, 'DETAIL_GAP_RECOVERED.stream');
  if (!msg.stream) {
    throw new Error('Connector emitted invalid DETAIL_GAP_RECOVERED.stream: expected non-empty string');
  }
  validateOptionalScopedStream(msg.stream, 'DETAIL_GAP_RECOVERED', scopeByStream);
  if (msg.reference_only !== true) {
    throw new Error('Connector emitted invalid DETAIL_GAP_RECOVERED.reference_only: expected true');
  }
  if (msg.record_key != null && typeof msg.record_key !== 'string' && typeof msg.record_key !== 'number') {
    throw new Error('Connector emitted invalid DETAIL_GAP_RECOVERED.record_key: expected string or number');
  }
}

function validateInteractionMessage(msg, scopeByStream) {
  if (typeof msg.request_id !== 'string' || !msg.request_id.trim()) {
    throw new Error('Connector emitted invalid INTERACTION.request_id: expected non-empty string');
  }
  if (!['credentials', 'otp', 'manual_action'].includes(msg.kind)) {
    throw new Error(`Connector emitted invalid INTERACTION.kind: ${msg.kind}`);
  }
  requireOptionalNonEmptyString(msg.stream, 'INTERACTION.stream');
  validateOptionalScopedStream(msg.stream, 'INTERACTION', scopeByStream);
  if (typeof msg.message !== 'string' || !msg.message.trim()) {
    throw new Error('Connector emitted invalid INTERACTION.message: expected non-empty string');
  }
  if (msg.schema != null && (typeof msg.schema !== 'object' || Array.isArray(msg.schema))) {
    throw new Error('Connector emitted invalid INTERACTION.schema: expected object');
  }
  if (msg.timeout_seconds != null && (!Number.isFinite(msg.timeout_seconds) || msg.timeout_seconds <= 0)) {
    throw new Error(`Connector emitted invalid INTERACTION.timeout_seconds: ${msg.timeout_seconds}`);
  }
}

const ASSISTANCE_PROGRESS_POSTURES = new Set(['running', 'blocked', 'waiting_retry']);
const ASSISTANCE_OWNER_ACTIONS = new Set(['none', 'act_elsewhere', 'provide_value', 'operate_attachment']);
const ASSISTANCE_RESPONSE_CONTRACTS = new Set(['none', 'response_required']);
const ASSISTANCE_SENSITIVITIES = new Set(['none', 'secret', 'non_secret']);
const ASSISTANCE_ATTACHMENT_KINDS = new Set(['browser_surface', 'url', 'qr', 'file', 'fixture']);
const ASSISTANCE_TERMINAL_STATUSES = new Set(['resolved', 'cancelled', 'timed_out', 'escalated']);

function safeAttachmentString(value, maxLength = 160) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

function sanitizeAssistanceTimelineString(value, maxLength = GAP_STRING_MAX) {
  const redacted = boundGapString(value);
  if (!redacted) return null;
  const sanitized = redacted
    .replace(/\b(?:https?|wss?):\/\/[^\s<>"')]+/gi, '[REDACTED_URL]')
    .replace(/\b((?:qr[_-]?)?(?:secret|token|password|passwd|cookie|otp|bearer))\b\s*[:=]\s*["']?[^"',\s}]+/gi, '$1=[REDACTED]')
    .replace(/\b((?:cdp|playwright|webrtc|neko)[_-]?(?:url|uri|endpoint|token|secret))\b\s*[:=]\s*["']?[^"',\s}]+/gi, '$1=[REDACTED]');
  if (sanitized.length <= maxLength) return sanitized;
  return sanitized.slice(0, maxLength - 1) + '…';
}

function sanitizeAssistanceInputSchema(value, depth = 0) {
  if (depth > 8) return '[REDACTED]';
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => sanitizeAssistanceInputSchema(entry, depth + 1));
  }
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? sanitizeAssistanceTimelineString(value, 200) || '' : value;
  }
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/^(?:default|example|examples|const|enum)$/i.test(key)) {
      out[key] = '[REDACTED]';
      continue;
    }
    if (/(?:password|passwd|secret|token|bearer|cookie|credential|otp|qr)/i.test(key)) {
      out[key] = entry && typeof entry === 'object' && !Array.isArray(entry)
        ? sanitizeAssistanceInputSchema(entry, depth + 1)
        : '[REDACTED]';
      continue;
    }
    out[key] = sanitizeAssistanceInputSchema(entry, depth + 1);
  }
  return out;
}

function safeOpaqueAttachmentRef(value) {
  const ref = safeAttachmentString(value, 200);
  if (!ref) return null;
  // Attachment refs are durable opaque handles. Raw http/ws URLs can carry
  // bearer authority and must stay behind the attachment provider.
  if (!/^[A-Za-z0-9._:-]+$/.test(ref)) return null;
  return ref;
}

function sanitizeAssistanceAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments.map((attachment) => {
    const result = { kind: attachment.kind };
    const rawRole = safeAttachmentString(attachment.role, 80);
    const rawLabel = safeAttachmentString(attachment.label || attachment.title, 160);
    const role = rawRole ? sanitizeAssistanceTimelineString(rawRole, 80) : null;
    const label = rawLabel ? sanitizeAssistanceTimelineString(rawLabel, 160) : null;
    const ref = safeOpaqueAttachmentRef(attachment.ref || attachment.id || attachment.surface_id);
    const rawStatus = safeAttachmentString(attachment.status || attachment.availability, 80);
    const status = rawStatus ? sanitizeAssistanceTimelineString(rawStatus, 80) : null;
    if (role) result.role = role;
    if (label) result.label = label;
    if (ref) result.ref = ref;
    if (status) result.status = status;
    return result;
  });
}

function validateAssistanceMessage(msg, scopeByStream) {
  requireOptionalNonEmptyString(msg.assistance_request_id, 'ASSISTANCE.assistance_request_id');
  requireOptionalNonEmptyString(msg.stream, 'ASSISTANCE.stream');
  validateOptionalScopedStream(msg.stream, 'ASSISTANCE', scopeByStream);
  if (!ASSISTANCE_PROGRESS_POSTURES.has(msg.progress_posture)) {
    throw new Error(`Connector emitted invalid ASSISTANCE.progress_posture: ${msg.progress_posture}`);
  }
  if (!ASSISTANCE_OWNER_ACTIONS.has(msg.owner_action)) {
    throw new Error(`Connector emitted invalid ASSISTANCE.owner_action: ${msg.owner_action}`);
  }
  if (!ASSISTANCE_RESPONSE_CONTRACTS.has(msg.response_contract)) {
    throw new Error(`Connector emitted invalid ASSISTANCE.response_contract: ${msg.response_contract}`);
  }
  if (msg.response_contract !== 'none') {
    throw new Error('Connector emitted unsupported ASSISTANCE.response_contract: response_required is not supported by the nonblocking ASSISTANCE path');
  }
  if (typeof msg.message !== 'string' || !msg.message.trim()) {
    throw new Error('Connector emitted invalid ASSISTANCE.message: expected non-empty string');
  }
  if (msg.sensitivity != null && !ASSISTANCE_SENSITIVITIES.has(msg.sensitivity)) {
    throw new Error(`Connector emitted invalid ASSISTANCE.sensitivity: ${msg.sensitivity}`);
  }
  if (msg.timeout_seconds != null && (!Number.isFinite(msg.timeout_seconds) || msg.timeout_seconds <= 0)) {
    throw new Error(`Connector emitted invalid ASSISTANCE.timeout_seconds: ${msg.timeout_seconds}`);
  }
  if (msg.input_schema != null && (typeof msg.input_schema !== 'object' || Array.isArray(msg.input_schema))) {
    throw new Error('Connector emitted invalid ASSISTANCE.input_schema: expected object');
  }
  if (msg.attachments != null) {
    if (!Array.isArray(msg.attachments)) {
      throw new Error('Connector emitted invalid ASSISTANCE.attachments: expected array');
    }
    for (const attachment of msg.attachments) {
      if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
        throw new Error('Connector emitted invalid ASSISTANCE.attachments: expected object entries');
      }
      if (!ASSISTANCE_ATTACHMENT_KINDS.has(attachment.kind)) {
        throw new Error(`Connector emitted invalid ASSISTANCE.attachments.kind: ${attachment.kind}`);
      }
      requireOptionalNonEmptyString(attachment.role, 'ASSISTANCE.attachments.role');
      requireOptionalNonEmptyString(attachment.status, 'ASSISTANCE.attachments.status');
      requireOptionalNonEmptyString(attachment.availability, 'ASSISTANCE.attachments.availability');
    }
  }
}

function hasBrowserSurfaceLaunchEnv(env) {
  return Boolean(
    env
      && typeof env === 'object'
      && (
        optionalNonEmptyEnv(env.PDPP_BROWSER_SURFACE_STREAM_BASE_URL)
        || optionalNonEmptyEnv(env.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL)
      )
  );
}

function buildAssistanceRequestedDataFromInteraction(msg, runSource, options = {}) {
  const isSecretValue = msg.kind === 'credentials' || msg.kind === 'otp';
  const hasBrowserSurface = msg.kind === 'manual_action' || (msg.kind === 'otp' && options.browserSurfaceAvailable === true);
  return {
    source: runSource,
    assistance_request_id: msg.request_id,
    progress_posture: 'blocked',
    owner_action: hasBrowserSurface ? 'operate_attachment' : 'provide_value',
    response_contract: 'response_required',
    sensitivity: isSecretValue ? 'secret' : 'non_secret',
    message: sanitizeAssistanceTimelineString(msg.message) || 'Owner assistance requested.',
    kind: msg.kind,
    stream: msg.stream || null,
    ...(msg.timeout_seconds == null ? {} : { timeout_seconds: msg.timeout_seconds }),
    ...(isSecretValue && msg.schema != null ? { input_schema: sanitizeAssistanceInputSchema(msg.schema) } : {}),
    ...(hasBrowserSurface
      ? { attachments: [{ kind: 'browser_surface', role: 'streaming_companion' }] }
      : {}),
  };
}

function validateAssistanceStatusMessage(msg) {
  if (typeof msg.assistance_request_id !== 'string' || !msg.assistance_request_id.trim()) {
    throw new Error('Connector emitted invalid ASSISTANCE_STATUS.assistance_request_id: expected non-empty string');
  }
  if (!ASSISTANCE_TERMINAL_STATUSES.has(msg.status)) {
    throw new Error(`Connector emitted invalid ASSISTANCE_STATUS.status: ${msg.status}`);
  }
  requireOptionalNonEmptyString(msg.message, 'ASSISTANCE_STATUS.message');
}

function buildAssistanceRequestedDataFromMessage(msg, runSource) {
  return {
    source: runSource,
    assistance_request_id: msg.assistance_request_id,
    progress_posture: msg.progress_posture,
    owner_action: msg.owner_action,
    response_contract: msg.response_contract,
    sensitivity: msg.sensitivity || 'none',
    message: sanitizeAssistanceTimelineString(msg.message) || 'Owner assistance requested.',
    stream: msg.stream || null,
    ...(msg.timeout_seconds == null ? {} : { timeout_seconds: msg.timeout_seconds }),
    ...(msg.input_schema == null ? {} : { input_schema: sanitizeAssistanceInputSchema(msg.input_schema) }),
    ...(msg.attachments == null ? {} : { attachments: sanitizeAssistanceAttachments(msg.attachments) }),
  };
}

function assistanceResolutionEventType(responseStatus) {
  if (responseStatus === 'success') return 'run.assistance_resolved';
  if (responseStatus === 'resolved') return 'run.assistance_resolved';
  if (responseStatus === 'cancelled') return 'run.assistance_cancelled';
  if (responseStatus === 'timeout') return 'run.assistance_timed_out';
  if (responseStatus === 'timed_out') return 'run.assistance_timed_out';
  if (responseStatus === 'escalated') return 'run.assistance_escalated';
  return null;
}

/**
 * Run a connector to completion.
 *
 * @param {object} opts
 * @param {string} opts.connectorPath - Path to connector executable
 * @param {string} opts.connectorId - Connector ID (for ingest URL)
 * @param {string} opts.ownerToken - Owner bearer token
 * @param {object} opts.manifest - Full connector manifest
 * @param {object} [opts.scope] - Optional normalized Collection Profile START.scope
 * @param {object} opts.state - Current StreamState (null on first run)
 * @param {string} opts.collectionMode - 'full_refresh' | 'incremental'
 * @param {boolean} opts.persistState - Whether STATE checkpoints should be committed on success
 * @param {string} [opts.grantId] - Optional grant-scoped state namespace for continuous runs
 * @param {string} opts.rsUrl - Resource server base URL
 * @param {function} opts.onInteraction - async (interaction) => response
 * @param {function} opts.onProgress - (msg) => void
 * @returns {Promise<{status, records_emitted, state, checkpoint_summary}>}
 */
// process.stderr write that swallows a single closed-pipe error per
// process. Used by the default progress logger so that a vanishing log
// consumer (Docker Compose log handoff, `node --watch` restart) cannot
// take down a fire-and-forget connector run with an uncaught EPIPE.
let _stderrPipeClosed = false;
function safeStderrWrite(line) {
  if (_stderrPipeClosed) return;
  try {
    process.stderr.write(line);
  } catch (err) {
    if (isClosedPipeWriteError(err)) {
      _stderrPipeClosed = true;
      return;
    }
    throw err;
  }
}

function optionalNonEmptyEnv(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function buildBrowserSurfaceLaunchEnv({ browserSurfaceLease, browserSurfaceEnv }) {
  const source = browserSurfaceLease && typeof browserSurfaceLease === 'object'
    ? browserSurfaceLease
    : {};
  const explicit = browserSurfaceEnv && typeof browserSurfaceEnv === 'object'
    ? browserSurfaceEnv
    : {};
  const leaseId = optionalNonEmptyEnv(explicit.PDPP_BROWSER_SURFACE_LEASE_ID)
    || optionalNonEmptyEnv(source.leaseId)
    || optionalNonEmptyEnv(source.id);
  const profileKey = optionalNonEmptyEnv(explicit.PDPP_BROWSER_SURFACE_PROFILE_KEY)
    || optionalNonEmptyEnv(source.profileKey);
  const surfaceId = optionalNonEmptyEnv(explicit.PDPP_BROWSER_SURFACE_ID)
    || optionalNonEmptyEnv(source.surfaceId);
  const remoteCdpUrl = optionalNonEmptyEnv(explicit.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL)
    || optionalNonEmptyEnv(source.remoteCdpUrl)
    || optionalNonEmptyEnv(source.cdpUrl);
  const streamBaseUrl = optionalNonEmptyEnv(explicit.PDPP_BROWSER_SURFACE_STREAM_BASE_URL)
    || optionalNonEmptyEnv(source.streamBaseUrl)
    || optionalNonEmptyEnv(source.baseUrl);
  const required = optionalNonEmptyEnv(explicit.PDPP_BROWSER_SURFACE_REQUIRED)
    || optionalNonEmptyEnv(source.required)
    || optionalNonEmptyEnv(source.browserSurfaceRequired)
    || (remoteCdpUrl ? 'neko' : null);

  return {
    ...(required ? { PDPP_BROWSER_SURFACE_REQUIRED: required } : {}),
    ...(leaseId ? { PDPP_BROWSER_SURFACE_LEASE_ID: leaseId } : {}),
    ...(profileKey ? { PDPP_BROWSER_SURFACE_PROFILE_KEY: profileKey } : {}),
    ...(surfaceId ? { PDPP_BROWSER_SURFACE_ID: surfaceId } : {}),
    ...(remoteCdpUrl ? { PDPP_BROWSER_SURFACE_REMOTE_CDP_URL: remoteCdpUrl } : {}),
    ...(streamBaseUrl ? { PDPP_BROWSER_SURFACE_STREAM_BASE_URL: streamBaseUrl } : {}),
  };
}

export async function runConnector(opts) {
  const defaultOnProgress = process.env.PDPP_RUNTIME_QUIET === '1'
    ? () => {}
    : (msg) => safeStderrWrite(`[runtime] ${JSON.stringify(msg)}\n`);
  const {
    connectorPath,
    connectorId: rawConnectorId,
    connectorInstanceId = null,
    ownerToken,
    manifest,
    scope: providedScope = null,
    state = null,
    collectionMode = 'incremental',
    persistState = true,
    grantId = null,
    rsUrl = process.env.RS_URL || 'http://localhost:7663',
    onInteraction = defaultInteractionHandler,
    onProgress = defaultOnProgress,
    onStarted = null,
    // Mode-A streaming registration: per-run shared secret the parent
    // mints and stores in the run-target registry's nonce store. The
    // child sends it as a Bearer credential to register/unregister its
    // CDP page-target wsUrl. Both fields are required for the child to
    // attempt registration; either omitted means the child silently
    // skips streaming registration. The reference server's base URL is
    // forwarded as PDPP_REFERENCE_BASE_URL so the child knows where to
    // POST. See:
    //   reference-implementation/server/streaming/run-target-registry.js
    //   packages/polyfill-connectors/src/streaming-target-registration.ts
    streamingRegistrationToken = null,
    referenceBaseUrl = null,
    browserSurfaceLease = null,
    browserSurfaceEnv = null,
    // Connection-scoped static-secret injection (Gmail app password / GitHub
    // PAT). The controller resolves this fragment from the per-connection
    // encrypted credential store and threads it here; it carries ONLY this one
    // connection's secret env var(s). It is merged LAST over `process.env` at
    // spawn so a stored credential overrides any process-global secret the
    // operator may still have set — making two mailboxes two distinct runs
    // rather than a collision on one global. Null/absent means no stored
    // credential applies to this run (the legacy process-env path is used).
    // See add-static-secret-owner-connect-primitive design Decision 5.
    staticSecretEnv = null,
    triggerKind = null,
    automationMode = null,
    // Optional owner-cancel signal. The controller passes one AbortSignal per
    // run; aborting it requests cooperative cancellation of THIS run only. The
    // runtime records a non-terminal `run.cancel_requested` event and
    // terminates the connector child via the existing graceful-then-SIGKILL
    // escalation. A run that already recorded a terminal event ignores abort.
    // See openspec/changes/add-owner-run-cancellation-control.
    cancelSignal = null,
    // SLVP-ideal §4.3: when true, the connector drains pending non-source-pressure
    // detail gaps then returns before any forward walk / list-phase fetches.
    // Threaded from the scheduler's recoveryOnly decision into the START message.
    recoveryOnly = false,
  } = opts;
  const connectorId = canonicalConnectorKey(rawConnectorId) ?? rawConnectorId;

  // Check binding requirements
  const requiredBindings = manifest.runtime_requirements?.bindings || {};
  const availableBindings = buildAvailableBindings(onInteraction);

  for (const [binding, req] of Object.entries(requiredBindings)) {
    if (req.required && !(binding in availableBindings)) {
      throw new Error(`Runtime cannot satisfy required binding: ${binding}`);
    }
  }

  const explicitlyRequestedStreams = providedScope?.streams
    ? new Set(providedScope.streams.map((streamScope) => streamScope?.name).filter((name) => typeof name === 'string'))
    : null;
  const startScope = buildStartScope(manifest, providedScope);
  const startCollectionMode = validateCollectionMode(collectionMode);
  const startState = persistState ? validateStartState(state) : null;
  // §4.3: validate and normalize recoveryOnly — must be a boolean if provided
  if (recoveryOnly !== false && recoveryOnly !== true) {
    throw new Error('opts.recoveryOnly must be a boolean');
  }
  const startRecoveryOnly = recoveryOnly === true;
  const scopeByStream = new Map((startScope.streams || []).map((streamScope) => [streamScope.name, streamScope]));
  const manifestByStream = new Map((manifest?.streams || []).map((stream) => [stream.name, stream]));
  const detailGapStore = opts.detailGapStore || getDefaultConnectorDetailGapStore();

  // Compute runId before spawn so it can be threaded into the child env
  // alongside the streaming registration token. The traceContext is
  // computed below alongside the rest of the run-scoped state.
  const spawnRunId = opts.runId || `run_${Date.now()}`;

  // Streaming registration env block (Mode A). Only emitted when BOTH the
  // bearer token and the reference base URL are present — the registration
  // client requires both. We do NOT pass a partial env: the child's
  // resolveStreamingRegistrationFromEnv warns when one piece is missing,
  // and we want that warning to fire only when the operator has wired up
  // streaming and something else is wrong, not just because the spawn path
  // routinely omits these.
  const streamingRegistrationEnv =
    streamingRegistrationToken && referenceBaseUrl
      ? {
          PDPP_RUN_ID: spawnRunId,
          PDPP_REFERENCE_BASE_URL: referenceBaseUrl,
          PDPP_STREAMING_REGISTRATION_TOKEN: streamingRegistrationToken,
        }
      : {};
  const browserSurfaceLaunchEnv = buildBrowserSurfaceLaunchEnv({ browserSurfaceLease, browserSurfaceEnv });
  // Connection-scoped static-secret env fragment, merged LAST at spawn so a
  // stored credential takes precedence over any process-global provider secret.
  const staticSecretLaunchEnv =
    staticSecretEnv && typeof staticSecretEnv === 'object' ? staticSecretEnv : {};
  const normalizedConnectorInstanceId = optionalNonEmptyEnv(connectorInstanceId);
  const connectorInstanceEnv = normalizedConnectorInstanceId
    ? { PDPP_CONNECTOR_INSTANCE_ID: normalizedConnectorInstanceId }
    : {};

  // Spawn connector process. Connectors may be .ts (source-only) or .js
  // (migrated or third-party). For .ts, use `node --import tsx/esm`, which
  // loads tsx as a module hook into the normal Node runtime — no extra
  // subprocess hop, signal handling works normally, and it's within a few
  // ms of plain `node` on cached runs. Once Node's --strip-types is
  // stable for our syntax subset, drop tsx entirely.
  const isTsConnector = connectorPath.endsWith('.ts');
  const args = isTsConnector
    ? ['--import', 'tsx/esm', connectorPath]
    : [connectorPath];
  // `detached: true` puts the connector child into its OWN process group
  // (POSIX setsid), with the child's PID as the group leader. This is the
  // load-bearing half of the run-lifecycle lease invariant: any grandchild
  // the connector spawns (a Playwright/Chromium helper, a shelled-out tool)
  // inherits this process group, so terminating the GROUP (see
  // `terminateConnectorChildGroup` below) reaps the connector AND its whole
  // subtree as one unit. Without it, `proc.kill()` signals only the direct
  // child PID; grandchildren reparent to PID 1 and orphan — the failure mode
  // captured by run_1780436796334 / run_1780436796294 (started-only runs whose
  // GitHub/YNAB children outlived the run under PID 1).
  //
  // We keep `stdio: ['pipe','pipe','pipe']` and do NOT `proc.unref()`: the
  // parent stays attached to the child's stdio and awaits its close, exactly
  // as before. `detached` here only changes the process-GROUP topology, not
  // ownership of the handle. This is a Linux/Docker runtime (no Windows
  // support anywhere in the tree), so the POSIX process-group semantics hold.
  const proc = spawn(process.execPath, args, {
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PDPP_CONNECTOR_ID: connectorId,
      ...connectorInstanceEnv,
      PDPP_OWNER_TOKEN: ownerToken,
      PDPP_RS_URL: rsUrl,
      ...streamingRegistrationEnv,
      ...browserSurfaceLaunchEnv,
      // LAST: a connection's own static secret overrides any process-global one.
      ...staticSecretLaunchEnv,
    },
  });

  // Group-aware termination. Because the child leads its own process group
  // (see `detached: true` above), signalling the NEGATIVE pid delivers to
  // every process in that group — the connector and any descendants it
  // spawned. We fall back to a direct single-PID `proc.kill(signal)` if the
  // group signal fails (e.g. the leader already exited so the group is gone,
  // surfacing as ESRCH), which preserves the prior best-effort behaviour.
  // Guarded on a real, post-spawn pid (> 1) so we can never accidentally
  // signal our own group (pid 0) or init.
  const terminateConnectorChildGroup = (signal) => {
    const pid = proc.pid;
    if (typeof pid === 'number' && pid > 1) {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // Group gone or un-signalable; fall through to the direct kill.
      }
    }
    if (proc.exitCode != null || proc.signalCode != null) return;
    try {
      proc.kill(signal);
    } catch {}
  };

  // Track this child's process group for the parent-exit sweep (see the
  // `ownedConnectorChildPids` registry near the top of this module). The PID
  // is the group leader because the child was spawned `detached`. It is
  // removed again in `cleanupChildHandles` on every terminal path.
  registerOwnedConnectorChild(proc.pid);

  // Closed-pipe defenses on the connector child stdio we own. Without
  // these, an EPIPE on `proc.stdin.write(...)` (child exited early) or on
  // a stdout/stderr write the child performs surfaces as an unhandled
  // 'error' event on the parent, which becomes an uncaughtException and
  // crashes the AS/RS process — the failure mode captured in
  // openspec/changes/harden-reference-runtime-reliability/
  //     design-notes/reference-docker-epipe-crash-2026-04-26.md.
  // Closed-pipe errors are downgraded to operational state on the run;
  // any other stream error is re-thrown to surface real bugs.
  let childStdinClosed = false;
  // Reason recorded when a stdin write to the connector child is rejected
  // because the far side has closed. Surfaced as terminal_reason on the
  // run outcome so a Docker/--watch crash mode is observably distinct
  // from a connector that exited cleanly without DONE. Only set when no
  // protocol-level terminal record (DONE or violation) has already
  // claimed the run. See:
  //   openspec/changes/harden-reference-runtime-reliability/
  //     specs/reference-implementation-architecture/spec.md
  let childStdinClosedReason = null;
  let childStdinClosedAtPhase = null; // 'start' | 'interaction_response'
  proc.stdin.on('error', (err) => {
    if (isClosedPipeWriteError(err)) {
      childStdinClosed = true;
      if (!childStdinClosedReason) {
        childStdinClosedReason = 'connector_stdin_closed';
        childStdinClosedAtPhase = 'unknown';
      }
      return;
    }
    throw err;
  });
  proc.stdout.on('error', (err) => {
    if (isClosedPipeWriteError(err)) return;
    throw err;
  });
  proc.stderr.on('error', (err) => {
    if (isClosedPipeWriteError(err)) return;
    throw err;
  });

  // Wrapped stdin writer: avoids synchronous throws when the child has
  // already detached its stdin reader. Returns true if the bytes were
  // accepted, false if stdin is no longer writable. On a non-writable
  // stdin we record `connector_stdin_closed` and the write phase so the
  // close handler can surface a typed terminal_reason instead of falling
  // back to the generic `connector_exit_without_done` outcome.
  function writeChildStdin(payload, phase) {
    if (childStdinClosed || !proc.stdin.writable) {
      childStdinClosed = true;
      if (!childStdinClosedReason) {
        childStdinClosedReason = 'connector_stdin_closed';
        childStdinClosedAtPhase = phase || 'unknown';
      }
      return false;
    }
    try {
      proc.stdin.write(payload);
      return true;
    } catch (err) {
      if (isClosedPipeWriteError(err)) {
        childStdinClosed = true;
        if (!childStdinClosedReason) {
          childStdinClosedReason = 'connector_stdin_closed';
          childStdinClosedAtPhase = phase || 'unknown';
        }
        return false;
      }
      throw err;
    }
  }

  const traceContext = opts.traceContext || createTraceContext({ scenarioId: opts.scenarioId });
  const runId = spawnRunId;
  const runSource = buildRunSourceDescriptor(connectorId);

  // We do NOT use readline.createInterface here. Node 24+ readline treats
  // U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR) as line
  // terminators (per ECMA-262), but JSON.stringify emits those characters
  // unescaped (per RFC 8259), so a compliant JSON line containing either
  // character causes readline to split it mid-string and JSON.parse fails.
  //
  // Instead, we consume proc.stdout directly and split ONLY on ASCII \n
  // (0x0A). We defensively also strip a trailing \r for CRLF safety. This
  // guarantees correctness even if a connector doesn't itself escape the
  // separator characters.
  //
  // See openspec/changes/add-polyfill-connector-system/design-notes/
  //     gmail-jsonl-truncation-bug.md
  // Bounded UTF-8 stderr tail. The runtime previously accumulated every
  // chunk for the lifetime of the run (memory grew with stderr volume) and
  // then discarded the result before the terminal `run.failed` event was
  // persisted. The tail buffer keeps only the last N bytes the connector
  // wrote and tracks `bytes_observed` so the owner can tell whether
  // evidence was truncated. See
  // openspec/changes/persist-connector-failure-diagnostics.
  const stderrTail = createStderrTailBuffer();
  proc.stderr.on('data', (d) => stderrTail.append(d));

  // Byte-level buffer; split only on LF. Each chunk from proc.stdout is a
  // Buffer (no encoding set) so multi-byte UTF-8 characters are preserved
  // across chunk boundaries — we decode only at line boundaries.
  proc.stdout.setEncoding('utf8');
  let _lineBuffer = '';
  // Fake readline-compatible shim so the rest of this file can still call
  // `rl.on('line', ...)` — which we do below, without touching readline APIs.
  const lineListeners = [];
  const rl = {
    on(event, handler) {
      if (event === 'line') lineListeners.push(handler);
    },
    close() { /* noop — stdout closes when the child exits */ },
  };
  const emitLine = (line) => {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    for (const h of lineListeners) h(line);
  };
  proc.stdout.on('data', (chunk) => {
    _lineBuffer += chunk;
    let nlIdx;
    while ((nlIdx = _lineBuffer.indexOf('\n')) !== -1) {
      const line = _lineBuffer.slice(0, nlIdx);
      _lineBuffer = _lineBuffer.slice(nlIdx + 1);
      emitLine(line);
    }
  });
  proc.stdout.on('end', () => {
    if (_lineBuffer.length > 0) {
      emitLine(_lineBuffer);
      _lineBuffer = '';
    }
  });

  // Debug trace: if PDPP_TRACE_DIR is set, record every line received from the
  // connector before parsing. On a crash, the file is inspectable with jq/less
  // and shows exactly what the connector emitted. See
  // openspec/changes/add-polyfill-connector-system/design-notes/debugging-leverage-open-question.md
  let _traceAppendFile = null;
  const traceDir = process.env.PDPP_TRACE_DIR;
  if (traceDir) {
    try {
      mkdirSync(traceDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const safeId = String(connectorId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
      _traceAppendFile = `${traceDir}/${ts}_${safeId}_${runId}.jsonl`;
      appendFileSync(_traceAppendFile, `# pdpp-runtime-trace connector=${connectorId} run=${runId} started=${new Date().toISOString()}\n`);
    } catch (err) {
      safeStderrWrite(`[runtime] trace open failed: ${err.message}\n`);
    }
  }
  const writeTrace = (line) => {
    if (!_traceAppendFile) return;
    try { appendFileSync(_traceAppendFile, line + '\n'); } catch {}
  };

  // Tracks all gap IDs served to the connector this run (across START + paged requests).
  // Used in cleanup to reset still-in_progress gaps back to pending if the connector
  // exits without recovering or re-deferring them.
  const allServedGapIds = new Set();

  const readDetailGapPage = createDetailGapPageReader({
    connectorId,
    connectorInstanceId: normalizedConnectorInstanceId,
    detailGapStore,
    grantId,
    runId,
    allServedGapIds,
  });

  let startDetailGaps = [];
  try {
    // Reclaim in_progress gaps left by prior crashed/killed runs before loading
    // new pending gaps. Uses last_run_id != currentRunId so only prior-run
    // leftovers are touched; never resets recovered gaps.
    if (typeof detailGapStore.reclaimStrandedInProgressGaps === 'function') {
      await detailGapStore.reclaimStrandedInProgressGaps({
        connectorId,
        connectorInstanceId: normalizedConnectorInstanceId,
        grantId,
        currentRunId: spawnRunId,
      });
    }
    const page = await readDetailGapPage({
      streams: startScope.streams.map((stream) => stream.name),
    });
    startDetailGaps = page.detailGaps;
  } catch (err) {
    // Pre-START failure (before the run promise / cleanupChildHandles exists):
    // reap the just-spawned connector group rather than leaking it, and drop
    // it from the parent-exit registry so a later exit can't re-signal a group
    // we already terminated.
    terminateConnectorChildGroup('SIGTERM');
    unregisterOwnedConnectorChild(proc.pid);
    throw err;
  }

  // Send START
  const startMsg = {
    type: 'START',
    run_id: runId,
    collection_mode: startCollectionMode,
    scope: startScope,
    state: startState,
    bindings: availableBindings,
    detail_gaps: startDetailGaps,
    // §4.3 (SLVP-ideal): forward recovery-only mode so the connector suppresses
    // the forward walk / list-phase fetches while the source-pressure cooldown
    // is active. Only included when true to keep the wire format backward-compat.
    ...(startRecoveryOnly ? { recovery_only: true } : {}),
  };
  if (!writeChildStdin(JSON.stringify(startMsg) + '\n', 'start')) {
    onProgress({
      type: 'connector_stdin_closed',
      phase: 'start',
      reason: childStdinClosedReason,
    });
  }

  // Last spine event the runtime successfully persisted for this run.
  // Used by ProtocolViolation.toPublicShape() to give the dashboard an
  // anchor: "the violation happened immediately after this event."
  // Declared before the first emitSpineEventTracked call to avoid TDZ.
  let lastValidSpineEvent = null;
  async function emitSpineEventTracked(input) {
    const record = await emitSpineEvent(input);
    if (record?.event_id) {
      lastValidSpineEvent = { event_id: record.event_id, event_type: record.event_type };
    }
    return record;
  }

  let assistanceCounter = 0;
  const openStructuredAssistance = new Map();
  const nextAssistanceRequestId = () => `asst_${Date.now()}_${++assistanceCounter}`;

  // Durable structured-attention writer. Closes the production-writer
  // gap from openspec/changes/complete-ri-operator-console-reliability
  // task 5.3 — every owner-action prompt now upserts a row in
  // `connector_attention_records` so the connection-health projection
  // sees `next_action.source === "structured"` instead of having to fall
  // back to the schedule's coarse `human_attention_needed` flag. Store
  // outage is non-fatal (the writer logs and continues), which preserves
  // the design rule that the operator-console sidecar never blocks data
  // collection.
  const attentionStore = opts.connectorAttentionStore || getDefaultConnectorAttentionStore();
  const attentionWriter = createAttentionWriter({
    connectorId,
    connectorInstanceId: normalizedConnectorInstanceId,
    runId,
    store: attentionStore,
    log: console,
  });

  async function closeStructuredAssistance(assistanceRequestId, status, extra = {}) {
    const activeAssistance = openStructuredAssistance.get(assistanceRequestId);
    if (!activeAssistance) {
      return false;
    }
    openStructuredAssistance.delete(assistanceRequestId);
    // Mirror the in-memory close into the durable attention store so the
    // dashboard projection stops driving `needs_attention` for this
    // prompt. Failure is logged inside the writer; the run terminal path
    // must keep moving even if the sidecar store is unhappy.
    await attentionWriter.resolveByRequestId(assistanceRequestId, status);
    const eventType = assistanceResolutionEventType(status);
    if (!eventType) {
      throw new Error(`Invalid assistance terminal status: ${status}`);
    }
    await emitSpineEventTracked({
      event_type: eventType,
      trace_id: traceContext.trace_id,
      scenario_id: traceContext.scenario_id,
      actor_type: 'runtime',
      actor_id: connectorId,
      object_type: 'run',
      object_id: runId,
      status,
      run_id: runId,
      stream_id: activeAssistance.stream || null,
      data: {
        source: runSource,
        assistance_request_id: assistanceRequestId,
        status,
        progress_posture: activeAssistance.progress_posture,
        owner_action: activeAssistance.owner_action,
        response_contract: activeAssistance.response_contract,
        stream: activeAssistance.stream || null,
        ...(activeAssistance.kind ? { kind: activeAssistance.kind } : {}),
        ...(extra.message ? { message: sanitizeAssistanceTimelineString(extra.message) || '[REDACTED]' } : {}),
        ...(extra.reason ? { reason: sanitizeAssistanceTimelineString(extra.reason) || '[REDACTED]' } : {}),
      },
    });
    return true;
  }

  async function closeOpenStructuredAssistance(status, extra = {}) {
    for (const assistanceRequestId of [...openStructuredAssistance.keys()]) {
      await closeStructuredAssistance(assistanceRequestId, status, extra);
    }
    // Drain any durable attention rows the writer still has tracked.
    // `closeStructuredAssistance` above handles the structured-ASSISTANCE
    // request_ids; this catches any interaction-side rows still open
    // when the run unwinds (timeout, crash, force-cancel, stdin closed).
    await attentionWriter.resolveAllOpen(status);
  }

  // Stamp `run.started` with the current process's boot epoch so the
  // boot-time orphan reconciler can identify abandoned runs from prior
  // incarnations. The spine-layer enforcement
  // (`assertRunStartedIsStamped` in lib/spine.ts) rejects emissions
  // lacking these fields with a loud error. Normally `startServer`
  // initializes the singleton via Stage 5; if `runConnector` is invoked
  // standalone (in a test fixture, a CLI tool, etc.) we lazily emit
  // `controller.booted` here so the runtime is always self-sufficient.
  // See docs/run-reconciliation-design-brief.md §3.3 / §3.4.
  let _bootEpoch = getCurrentBootEpoch();
  if (!_bootEpoch) {
    _bootEpoch = await emitControllerBootedAndStashEpoch();
  }
  await emitSpineEventTracked({
    event_type: 'run.started',
    trace_id: traceContext.trace_id,
    scenario_id: traceContext.scenario_id,
    actor_type: 'runtime',
    actor_id: connectorId,
    object_type: 'run',
    object_id: runId,
    status: 'started',
    run_id: runId,
    data: {
      source: runSource,
      collection_mode: startCollectionMode,
      grant_id: grantId,
      persist_state: persistState,
      state_commit_intent: persistState ? 'commit_on_success' : 'do_not_persist',
      ...(triggerKind ? { trigger_kind: triggerKind } : {}),
      ...(automationMode ? { automation_mode: automationMode } : {}),
      bindings: availableBindings,
      scope: startScope,
      scope_streams: startScope.streams.map((stream) => stream.name),
      boot_epoch: _bootEpoch.boot_epoch,
      seq: _bootEpoch.seq,
      controller_id: _bootEpoch.controller_id,
    },
  });
  if (typeof onStarted === 'function') {
    onStarted({ run_id: runId, trace_id: traceContext.trace_id });
  }

  // Collect new STATE checkpoints
  const newState = {};
  const committedStateStreams = new Set();
  let totalEmitted = 0;
  // Per-stream emitted counter. `totalEmitted` is the aggregate the DONE
  // records_emitted guard checks; this Map carries the same accounting keyed by
  // data `stream` so the terminal collection-fact block can state per-stream
  // `collected` without re-deriving it. Every in-scope stream is seeded to 0 so
  // a stream that emitted nothing still appears as an honest `collected: 0`
  // (absence of records is a fact, not a missing entry).
  const emittedByStream = new Map(
    (startScope.streams || []).map((streamScope) => [streamScope.name, 0]),
  );
  let totalFlushed = 0;
  let finalStatus = 'failed';
  let pendingInteraction = null;
  let terminalEventRecorded = false;
  let doneMessage = null;
  // Owner-cancel intent for this run. Set when `cancelSignal` aborts before a
  // terminal event is recorded. `ownerCancelForced` flips to true if the
  // connector child ignored graceful termination and had to be SIGKILL'd, so
  // the terminal `run.cancelled` event can distinguish a clean owner cancel
  // from a forced one. See add-owner-run-cancellation-control design.
  let ownerCancelRequested = false;
  let ownerCancelForced = false;
  const knownGaps = [];
  const durableDetailGaps = [];
  // First-sighting idempotency for run.detail_gap_recorded: gap_ids already
  // emitted as `recorded` THIS run. Closes the resumed-run-stdout-replay edge
  // where a brand-new gap's DETAIL_GAP message could be re-processed and emit a
  // duplicate first-sighting event. In-memory per-run guard (same pattern as the
  // attention-writer's open/byRequestId Maps) — no schema change on the hot spine
  // append path. The cross-run re-defer suppression is the discovered_run_id gate.
  const detailGapRecordedThisRun = new Set();
  const detailCoverageByStateStream = new Map();
  // Latest `collection_rate` progress payload seen this run. Updated on each
  // rate-change PROGRESS event so the terminal event can carry the final
  // learned state for post-run diagnostics (reference → snapshot derivation).
  let lastSeenCollectionRate = null;

  // Batch records for ingest
  const recordBatch = {};
  const BATCH_SIZE = Number(process.env.PDPP_RUNTIME_BATCH_SIZE) || 500;

  function countBufferedRecords() {
    return Object.values(recordBatch).reduce((sum, batch) => sum + (batch?.length || 0), 0);
  }

  function countStagedStateStreams() {
    return Object.keys(newState).length;
  }

  function checkpointCommitStatus() {
    if (!persistState) return 'disabled';
    const stateStreamsStaged = countStagedStateStreams();
    const stateStreamsCommitted = committedStateStreams.size;
    if (stateStreamsStaged === 0) {
      return finalStatus === 'succeeded' ? 'committed' : 'not_committed';
    }
    if (stateStreamsCommitted === 0) return 'not_committed';
    if (stateStreamsCommitted < stateStreamsStaged) return 'partially_committed';
    return 'committed';
  }

  function appendKnownGap(gap) {
    knownGaps.push(gap);
  }

  function buildKnownGapsForTerminal(reason = null, connectorError = null) {
    const terminalGaps = [...knownGaps];
    if (finalStatus === 'failed') {
      terminalGaps.push(buildKnownGap({
        kind: 'run_failed',
        reason: reason || 'run_failed',
        message: connectorError?.message || null,
        recoveryHint: connectorError?.retryable === true ? 'retry_by_runtime' : null,
      }));
    }
    const commitStatus = checkpointCommitStatus();
    if (commitStatus === 'not_committed' || commitStatus === 'partially_committed') {
      terminalGaps.push(buildKnownGap({
        kind: 'checkpoint_commit',
        reason: commitStatus,
        message: commitStatus === 'partially_committed'
          ? 'Some staged stream state was not committed'
          : 'Staged stream state was not committed',
        recoveryHint: 'retry_by_runtime',
      }));
    }
    return terminalGaps;
  }

  function buildRunTerminalData({
    recordsEmitted = totalEmitted,
    reason = null,
    exitCode = null,
    reportedRecordsEmitted = null,
    connectorError = null,
    ingestFailure = null,
    violation = null,
    stdinClosedAtPhase = null,
    failureOrigin = null,
    failureMessage = null,
    connectorDiagnostics = null,
  } = {}) {
    const stateStreamsStaged = countStagedStateStreams();
    const stateStreamsCommitted = committedStateStreams.size;
    const publicIngestFailure = toPublicIngestFailure(ingestFailure);
    const terminalKnownGaps = buildKnownGapsForTerminal(reason, connectorError);
    const visibleKnownGaps = terminalKnownGaps.slice(0, KNOWN_GAPS_MAX);
    // Runtime collection-fact block (task 2.2a): objective per-stream facts only.
    // No coverage condition / forward disposition — those are derived by the
    // control-plane projection on read (Tranche C).
    const collectionFacts = buildCollectionFacts({
      scopeByStream,
      emittedByStream,
      knownGaps,
      durableDetailGaps,
      detailCoverageByStateStream,
      newState,
      committedStateStreams,
      persistState,
    });
    return {
      source: runSource,
      grant_id: grantId,
      ...(triggerKind ? { trigger_kind: triggerKind } : {}),
      ...(automationMode ? { automation_mode: automationMode } : {}),
      records_emitted: recordsEmitted,
      records_flushed: totalFlushed,
      buffered_records_dropped: countBufferedRecords(),
      persist_state: persistState,
      checkpoint_mode: 'checkpointed_streaming',
      checkpoint_commit_status: checkpointCommitStatus(),
      state_streams_staged: stateStreamsStaged,
      state_streams_committed: stateStreamsCommitted,
      ...(reason ? { reason } : {}),
      ...(reason === 'connector_stdin_closed'
        ? { stdin_closed_at_phase: stdinClosedAtPhase || 'unknown' }
        : {}),
      ...(exitCode === null || exitCode === undefined ? {} : { exit_code: exitCode }),
      ...(reportedRecordsEmitted === null || reportedRecordsEmitted === undefined
        ? {}
        : { reported_records_emitted: reportedRecordsEmitted }),
      ...(connectorError?.message ? { connector_error_message: boundConnectorErrorMessage(connectorError.message) } : {}),
      ...(connectorError?.retryable === null || connectorError?.retryable === undefined
        ? {}
        : { connector_error_retryable: connectorError.retryable }),
      ...(publicIngestFailure ? { ingest_failure: publicIngestFailure } : {}),
      ...(terminalKnownGaps.length
        ? {
            known_gaps: visibleKnownGaps,
            known_gaps_summary: summarizeKnownGaps(terminalKnownGaps),
          }
        : {}),
      ...(durableDetailGaps.length
        ? {
            detail_gaps: {
              reference_only: true,
              pending_recorded: durableDetailGaps.length,
              gap_ids: durableDetailGaps.slice(0, KNOWN_GAPS_MAX).map((gap) => gap.gap_id),
            },
          }
        : {}),
      ...(collectionFacts ? { collection_facts: collectionFacts } : {}),
      // Final adaptive rate controller state: the last `collection_rate` progress
      // payload emitted this run. Persisted on the terminal event so the reference
      // can surface it as `connection_health.collection_rate` after the run ends,
      // without a separate spine scan. Absent when no controller was active.
      ...(lastSeenCollectionRate != null ? { collection_rate: lastSeenCollectionRate } : {}),
      ...(violation instanceof ProtocolViolation
        ? { violation: violation.toPublicShape({ lastValidSpineEvent }) }
        : {}),
      // Additive runtime-authored failure classification + connector
      // diagnostic evidence. See
      // openspec/changes/persist-connector-failure-diagnostics.
      // `failure_origin` distinguishes runtime-authored classification
      // (connector|runtime|transport|storage); `failure_message` is a
      // concise runtime-authored explanation; `connector_diagnostics`
      // carries connector-authored, untrusted excerpts (currently just
      // a bounded redacted stderr tail).
      ...(failureOrigin ? { failure_origin: failureOrigin } : {}),
      ...(failureMessage ? { failure_message: failureMessage } : {}),
      ...(connectorDiagnostics
        && typeof connectorDiagnostics === 'object'
        && Object.keys(connectorDiagnostics).length > 0
        ? { connector_diagnostics: connectorDiagnostics }
        : {}),
    };
  }

  function buildCheckpointSummary() {
    const stateStreamsStaged = countStagedStateStreams();
    const stateStreamsCommitted = committedStateStreams.size;
    return {
      mode: 'checkpointed_streaming',
      commit_status: checkpointCommitStatus(),
      records_flushed: totalFlushed,
      buffered_records_dropped: countBufferedRecords(),
      state_streams_staged: stateStreamsStaged,
      state_streams_committed: stateStreamsCommitted,
    };
  }

  function trackDetailCoverage(msg) {
    const entries = detailCoverageByStateStream.get(msg.state_stream) || [];
    entries.push({
      stream: msg.stream,
      requiredKeys: msg.required_keys.map(normalizeCoverageKey),
      hydratedKeys: new Set(msg.hydrated_keys.map(normalizeCoverageKey)),
      optionalSkipKeys: new Set((msg.optional_skip_keys || []).map(normalizeCoverageKey)),
      // Optional connector-declared considered denominator (task 2.1). Retained
      // here — normalized to a trusted safe non-negative integer or null — so
      // the terminal collection-fact block can prefer it over the
      // required_keys.length fallback. null stays `unknown`; never inferred.
      considered: boundConsideredCount(msg.considered),
      // Optional connector-declared covered count (task 4.4): in-boundary items the
      // run accounted for (emitted + suppressed-unchanged). Same drop-don't-reject
      // normalization. null stays `unknown`; the projection compares `considered`
      // against `covered` when present so a steady-state full-sync run reads
      // `complete`, never inferred from collected.
      covered: boundConsideredCount(msg.covered),
    });
    detailCoverageByStateStream.set(msg.state_stream, entries);
  }

  function assertDetailCoverageSatisfiedBeforeCommit() {
    for (const stateStream of Object.keys(newState)) {
      const coverageEntries = detailCoverageByStateStream.get(stateStream) || [];
      for (const coverage of coverageEntries) {
        const accountedGapKeys = new Set(
          durableDetailGaps
            .filter((gap) => (
              gap.stream === coverage.stream
              && (gap.status === 'pending' || gap.status === 'recovered')
              && gap.record_key != null
            ))
            .map((gap) => normalizeCoverageKey(gap.record_key)),
        );
        const missingKeys = coverage.requiredKeys.filter((key) => (
          !coverage.hydratedKeys.has(key)
          && !coverage.optionalSkipKeys.has(key)
          && !accountedGapKeys.has(key)
        ));
        if (!missingKeys.length) continue;

        throw new Error(
          `Connector detail coverage incomplete: state_stream=${stateStream} stream=${coverage.stream} missing_required_keys=${missingKeys.length}`,
        );
      }
    }
  }

  async function flushBatch(stream) {
    const batch = recordBatch[stream];
    if (!batch || !batch.length) return;
    const ndjson = batch.map(r => JSON.stringify(r)).join('\n');
    const url = `${rsUrl}/v1/ingest/${encodeURIComponent(stream)}?connector_id=${encodeURIComponent(connectorId)}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ownerToken}`,
        'Content-Type': 'application/x-ndjson',
      },
      body: ndjson,
    });
    const result = await readIngestResponse(resp, stream, batch.length);
    totalFlushed += batch.length;
    await emitSpineEventTracked({
      event_type: 'run.batch_ingested',
      trace_id: traceContext.trace_id,
      scenario_id: traceContext.scenario_id,
      actor_type: 'runtime',
      actor_id: connectorId,
      object_type: 'run',
      object_id: runId,
      status: 'succeeded',
      run_id: runId,
      stream_id: stream,
      data: {
        source: runSource,
        grant_id: grantId,
        batch_size: batch.length,
        records_accepted: result.records_accepted,
        records_rejected: result.records_rejected,
        total_records_flushed: totalFlushed,
      },
    });
    onProgress({ type: 'ingest', stream, accepted: result.records_accepted, rejected: result.records_rejected });
    recordBatch[stream] = [];
  }

  async function flushAll() {
    for (const stream of Object.keys(recordBatch)) {
      await flushBatch(stream);
    }
  }

  // Process a STATE message: persist to RS
  async function commitState(stream, cursor) {
    newState[stream] = cursor;
    const stateUrl = new URL(`/v1/state/${encodeURIComponent(connectorId)}`, rsUrl);
    if (connectorInstanceEnv.PDPP_CONNECTOR_INSTANCE_ID) {
      stateUrl.searchParams.set('connector_instance_id', connectorInstanceEnv.PDPP_CONNECTOR_INSTANCE_ID);
    }
    if (grantId) stateUrl.searchParams.set('grant_id', grantId);
    const url = stateUrl.toString();
    try {
      const resp = await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${ownerToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ state: { [stream]: cursor } }),
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw buildHttpFailure(`State persistence failed for ${stream}`, resp.status, body);
      }
      committedStateStreams.add(stream);

      await emitSpineEventTracked({
        event_type: 'run.state_advanced',
        trace_id: traceContext.trace_id,
        scenario_id: traceContext.scenario_id,
        actor_type: 'runtime',
        actor_id: connectorId,
        object_type: 'run',
        object_id: runId,
        status: 'succeeded',
        run_id: runId,
        stream_id: stream,
        data: {
          source: runSource,
          grant_id: grantId,
          cursor,
          checkpoint_mode: 'checkpointed_streaming',
          state_streams_committed: committedStateStreams.size,
        },
      });
    } catch (err) {
      await emitSpineEvent({
        event_type: 'run.state_commit_failed',
        trace_id: traceContext.trace_id,
        scenario_id: traceContext.scenario_id,
        actor_type: 'runtime',
        actor_id: connectorId,
        object_type: 'run',
        object_id: runId,
        status: 'failed',
        run_id: runId,
        stream_id: stream,
        data: {
          source: runSource,
          grant_id: grantId,
          cursor,
          checkpoint_mode: 'checkpointed_streaming',
          state_streams_staged: countStagedStateStreams(),
          state_streams_committed: committedStateStreams.size,
          error_message: err.message,
        },
      });
      throw err;
    }
  }

  return new Promise((resolve, reject) => {
    const msgQueue = [];
    let processing = false;
    let cleanedUp = false;
    let queueDrainedResolve = null;
    let pendingInteractionViolationReject = null;
    let terminateTimer = null;

    function clearTerminateTimer() {
      if (!terminateTimer) return;
      clearTimeout(terminateTimer);
      terminateTimer = null;
    }

    function terminateChild() {
      if (proc.exitCode != null || proc.signalCode != null) return;
      // SIGTERM the WHOLE process group, not just the direct child PID, so a
      // connector's grandchildren (browser helpers, shelled-out tools) are
      // terminated with it rather than reparenting to PID 1.
      terminateConnectorChildGroup('SIGTERM');

      if (terminateTimer || proc.exitCode != null || proc.signalCode != null) return;
      terminateTimer = setTimeout(() => {
        terminateTimer = null;
        if (proc.exitCode != null || proc.signalCode != null) return;
        // The child ignored graceful termination within the window. Record the
        // escalation so an owner-cancelled run terminals as `owner_cancel_forced`
        // rather than `owner_cancelled`.
        if (ownerCancelRequested) {
          ownerCancelForced = true;
        }
        // Escalate to a group-wide SIGKILL: an unkillable grandchild can no
        // longer keep the subtree alive after the connector leader is gone.
        terminateConnectorChildGroup('SIGKILL');
      }, 250);
      terminateTimer.unref?.();
    }

    // Owner-cancel signal wiring. Aborting `cancelSignal` requests cancellation
    // of THIS run only: record intent, emit a non-terminal `run.cancel_requested`
    // event, and trigger the graceful-then-SIGKILL escalation above. Abort after
    // a terminal event is recorded is a no-op (the run already ended). The
    // listener is removed in cleanupChildHandles so a settled run does not leak
    // it on the controller's shared AbortController.
    function handleOwnerCancel() {
      if (terminalEventRecorded || ownerCancelRequested) return;
      ownerCancelRequested = true;
      // Emit the audit marker without blocking the terminate path; the terminal
      // `run.cancelled` event is emitted later by the close handler.
      emitSpineEvent({
        event_type: 'run.cancel_requested',
        trace_id: traceContext.trace_id,
        scenario_id: traceContext.scenario_id,
        actor_type: 'owner',
        actor_id: connectorId,
        object_type: 'run',
        object_id: runId,
        status: 'cancel_requested',
        run_id: runId,
        data: { source: runSource, ...(triggerKind ? { trigger_kind: triggerKind } : {}) },
      }).catch((err) => {
        onProgress({ type: 'spine_error', error: err?.message || String(err) });
      });
      onProgress({ type: 'cancel_requested', run_id: runId });
      terminateChild();
    }
    if (cancelSignal) {
      if (cancelSignal.aborted) {
        handleOwnerCancel();
      } else {
        cancelSignal.addEventListener('abort', handleOwnerCancel, { once: true });
      }
    }

    function cleanupChildHandles() {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTerminateTimer();
      if (cancelSignal) {
        cancelSignal.removeEventListener('abort', handleOwnerCancel);
      }
      // The run reached a terminal path; this child's group no longer needs
      // the parent-exit sweep. Removing it here keeps the registry bounded to
      // genuinely in-flight runs across a long-lived process.
      unregisterOwnedConnectorChild(proc.pid);
      rl.close();
      proc.stdin.destroy();
      proc.stdout.destroy();
      proc.stderr.destroy();
      // Reset any gaps this run marked in_progress but the connector never
      // recovered or re-deferred — so they remain retryable on the next run.
      // Best-effort: fire-and-forget; cleanup must not throw.
      if (allServedGapIds.size > 0 && typeof detailGapStore.resetServedInProgressGaps === 'function') {
        Promise.resolve(detailGapStore.resetServedInProgressGaps([...allServedGapIds])).catch(() => {});
      }
    }

    function notifyQueueDrained() {
      if (!msgQueue.length && !processing && queueDrainedResolve) {
        const resolveDrain = queueDrainedResolve;
        queueDrainedResolve = null;
        resolveDrain();
      }
    }

    function waitForQueueDrain() {
      if (!msgQueue.length && !processing) return Promise.resolve();
      return new Promise((resolveDrain) => {
        queueDrainedResolve = resolveDrain;
      });
    }

    function failPendingInteraction(err) {
      if (!pendingInteraction || !pendingInteractionViolationReject) return false;
      const rejectPendingInteraction = pendingInteractionViolationReject;
      pendingInteractionViolationReject = null;
      rejectPendingInteraction(err);
      terminateChild();
      return true;
    }

    async function processNext() {
      if (processing || !msgQueue.length) return;
      processing = true;

      const msg = msgQueue.shift();

      try {
        await handleMsg(msg);
      } catch (err) {
        finalStatus = 'failed';
        const failureReason = classifyRuntimeFailure(err);
        const checkpointSummary = buildCheckpointSummary();
        err.run_id = runId;
        err.trace_id = traceContext.trace_id;
        err.failure_reason = failureReason;
        err.checkpoint_summary = checkpointSummary;
        err.terminal_reason = failureReason;
        err.connector_error = null;
        err.known_gaps = buildKnownGapsForTerminal(failureReason, null);

        if (!terminalEventRecorded) {
          try {
            await closeOpenStructuredAssistance('cancelled', { reason: failureReason });
            await emitSpineEvent({
              event_type: 'run.failed',
              trace_id: traceContext.trace_id,
              scenario_id: traceContext.scenario_id,
              actor_type: 'runtime',
              actor_id: connectorId,
              object_type: 'run',
              object_id: runId,
              status: 'failed',
              run_id: runId,
              data: buildRunTerminalData({
                recordsEmitted: totalEmitted,
                reason: failureReason,
                connectorError: null,
                ingestFailure: err.ingest_failure || null,
                violation: err instanceof ProtocolViolation ? err : null,
              }),
            });
            terminalEventRecorded = true;
          } catch (emitErr) {
            onProgress({ type: 'spine_error', error: emitErr.message });
          }
        }

        onProgress({ type: 'done', status: 'failed', records_emitted: totalEmitted, reason: failureReason });
        if (queueDrainedResolve) {
          const resolveDrain = queueDrainedResolve;
          queueDrainedResolve = null;
          resolveDrain();
        }
        cleanupChildHandles();
        reject(err);
        terminateChild();
        return;
      } finally {
        processing = false;
        notifyQueueDrained();
      }

      processNext();
    }

    async function handleMsg(msg) {
      if (doneMessage) {
        if (msg.type === '__PARSE_ERROR__') {
          throw new Error(`Connector emitted invalid JSONL after DONE: ${msg.error}`);
        }
        throw new Error(`Connector emitted ${msg.type} after DONE`);
      }

      switch (msg.type) {
        case 'RECORD': {
          const { stream, key, data, emitted_at, op } = msg;
          const streamScope = scopeByStream.get(stream);
          if (!streamScope) {
            throw new Error(`Connector emitted RECORD for undeclared stream: ${stream}`);
          }

          const manifestStream = manifestByStream.get(stream) || null;
          const resourceKey = encodeScopeResourceKey(key);
          if (Array.isArray(streamScope.resources) && streamScope.resources.length && !streamScope.resources.includes(resourceKey)) {
            throw new Error(`Connector emitted RECORD outside declared resources for stream: ${stream}`);
          }

          if (Array.isArray(streamScope.fields) && data && typeof data === 'object') {
            const requiredFields = new Set(manifestStream?.schema?.required || []);
            const allowedFields = new Set([...streamScope.fields, ...requiredFields]);
            const extraFields = Object.keys(data).filter((field) => !allowedFields.has(field));
            if (extraFields.length) {
              throw new Error(`Connector emitted RECORD with fields outside START.scope for stream '${stream}': ${extraFields.join(', ')}`);
            }
          }

          if (streamScope.time_range && data && typeof data === 'object') {
            const consentTimeField = manifestStream?.consent_time_field || null;
            if (consentTimeField && !passesTimeRange(data, streamScope.time_range, consentTimeField)) {
              throw new Error(`Connector emitted RECORD outside declared time_range for stream: ${stream}`);
            }
          }

          if (!recordBatch[stream]) recordBatch[stream] = [];
          recordBatch[stream].push({ key, data, emitted_at, op });
          totalEmitted++;
          emittedByStream.set(stream, (emittedByStream.get(stream) || 0) + 1);

          if (recordBatch[stream].length >= BATCH_SIZE) {
            await flushBatch(stream);
          }
          break;
        }

        case 'STATE': {
          validateStateMessage(msg, scopeByStream);

          // Flush records for this stream before persisting state
          await flushBatch(msg.stream);
          newState[msg.stream] = msg.cursor;
          await emitSpineEventTracked({
            event_type: 'run.state_staged',
            trace_id: traceContext.trace_id,
            scenario_id: traceContext.scenario_id,
            actor_type: 'runtime',
            actor_id: connectorId,
            object_type: 'run',
            object_id: runId,
            status: 'succeeded',
            run_id: runId,
            stream_id: msg.stream,
            data: {
              source: runSource,
              grant_id: grantId,
              cursor: msg.cursor,
              checkpoint_mode: 'checkpointed_streaming',
              state_streams_staged: countStagedStateStreams(),
              state_commit_intent: persistState ? 'commit_on_success' : 'do_not_persist',
            },
          });
          break;
        }

        case 'INTERACTION': {
          validateInteractionMessage(msg, scopeByStream);
          if (typeof onInteraction !== 'function') {
            throw new Error('Connector emitted INTERACTION but START.bindings omitted interactive');
          }
          if (pendingInteraction) {
            // Protocol violation
            terminateChild();
            throw new Error('Connector emitted INTERACTION while already waiting');
          }
          pendingInteraction = msg;
          const pendingInteractionViolation = new Promise((_, rejectWaiting) => {
            pendingInteractionViolationReject = rejectWaiting;
          });
          pendingInteractionViolation.catch(() => {});

          await emitSpineEventTracked({
            event_type: 'run.interaction_required',
            trace_id: traceContext.trace_id,
            scenario_id: traceContext.scenario_id,
            actor_type: 'runtime',
            actor_id: connectorId,
            object_type: 'run',
            object_id: runId,
            status: 'started',
            run_id: runId,
            interaction_id: msg.request_id,
            data: {
              source: runSource,
              kind: msg.kind,
              stream: msg.stream || null,
              message: msg.message,
              ...(msg.schema == null ? {} : { schema: msg.schema }),
              ...(msg.timeout_seconds == null ? {} : { timeout_seconds: msg.timeout_seconds }),
            },
          });

          await emitSpineEventTracked({
            event_type: 'run.assistance_requested',
            trace_id: traceContext.trace_id,
            scenario_id: traceContext.scenario_id,
            actor_type: 'runtime',
            actor_id: connectorId,
            object_type: 'run',
            object_id: runId,
            status: 'started',
            run_id: runId,
            interaction_id: msg.request_id,
            data: buildAssistanceRequestedDataFromInteraction(msg, runSource, {
              browserSurfaceAvailable: hasBrowserSurfaceLaunchEnv(browserSurfaceLaunchEnv),
            }),
          });

          // Durable structured attention upsert. The interaction is now
          // a real owner-action prompt; the dashboard projection should
          // surface it via `next_action.source === "structured"`.
          await attentionWriter.recordInteractionRequest(msg);

          let timeoutHandle = null;
          let response;
          try {
            const responsePromise = Promise.resolve(onInteraction(msg)).catch(() => ({
              type: 'INTERACTION_RESPONSE',
              request_id: msg.request_id,
              status: 'cancelled',
            }));
            const waitForResponse = [responsePromise];

            if (Number.isFinite(msg.timeout_seconds) && msg.timeout_seconds > 0) {
              waitForResponse.push(new Promise((resolve) => {
                timeoutHandle = setTimeout(() => resolve({
                  type: 'INTERACTION_RESPONSE',
                  request_id: msg.request_id,
                  status: 'timeout',
                }), msg.timeout_seconds * 1000);
              }));
            }

            waitForResponse.push(pendingInteractionViolation);

            response = await Promise.race(waitForResponse);
          } finally {
            if (timeoutHandle) clearTimeout(timeoutHandle);
          }

          const responseStatus = response?.status || 'success';
          if (response?.type !== 'INTERACTION_RESPONSE' || response?.request_id !== msg.request_id) {
            throw new Error('Interaction handler returned an invalid INTERACTION_RESPONSE envelope');
          }
          if (!['success', 'cancelled', 'timeout'].includes(responseStatus)) {
            throw new Error(`Invalid INTERACTION_RESPONSE status: ${responseStatus}`);
          }

          await emitSpineEventTracked({
            event_type: 'run.interaction_completed',
            trace_id: traceContext.trace_id,
            scenario_id: traceContext.scenario_id,
            actor_type: 'runtime',
            actor_id: connectorId,
            object_type: 'run',
            object_id: runId,
            status: responseStatus,
            run_id: runId,
            interaction_id: msg.request_id,
            data: {
              source: runSource,
              status: responseStatus,
              kind: msg.kind,
              stream: msg.stream || null,
            },
          });

          // Transition the durable attention row for this interaction
          // to its terminal lifecycle before emitting the resolution
          // spine event. The writer maps `success`/`cancelled`/`timeout`
          // onto `resolved`/`cancelled`/`expired`; secret-sensitive rows
          // are persisted with `sensitivity: "secret"` so the projection
          // continues to suppress action_target on the row even after
          // resolution.
          await attentionWriter.resolveByRequestId(msg.request_id, responseStatus);

          const assistanceEventType = assistanceResolutionEventType(responseStatus);
          if (assistanceEventType) {
            await emitSpineEventTracked({
              event_type: assistanceEventType,
              trace_id: traceContext.trace_id,
              scenario_id: traceContext.scenario_id,
              actor_type: 'runtime',
              actor_id: connectorId,
              object_type: 'run',
              object_id: runId,
              status: responseStatus,
              run_id: runId,
              interaction_id: msg.request_id,
              data: {
                source: runSource,
                assistance_request_id: msg.request_id,
                status: responseStatus,
                kind: msg.kind,
                stream: msg.stream || null,
              },
            });
          }

          if (responseStatus !== 'success') {
            const interactionRecoveryHint = msg.kind === 'manual_action' || msg.kind === 'otp'
              ? 'manual_action_required'
              : 'refresh_credentials';
            appendKnownGap(buildKnownGap({
              kind: 'interaction_required',
              stream: msg.stream || null,
              reason: `interaction_${responseStatus}`,
              message: msg.message,
              recoveryHint: interactionRecoveryHint,
              interactionKind: msg.kind,
            }));
          }

          pendingInteraction = null;
          if (!writeChildStdin(JSON.stringify({ ...response, status: responseStatus }) + '\n', 'interaction_response')) {
            onProgress({
              type: 'connector_stdin_closed',
              phase: 'interaction_response',
              reason: childStdinClosedReason,
            });
          }
          pendingInteractionViolationReject = null;
          break;
        }

        case 'ASSISTANCE': {
          const assistanceRequestId = msg.assistance_request_id || nextAssistanceRequestId();
          const assistanceMsg = { ...msg, assistance_request_id: assistanceRequestId };
          validateAssistanceMessage(assistanceMsg, scopeByStream);
          if (openStructuredAssistance.has(assistanceRequestId)) {
            throw new Error(`Connector emitted duplicate ASSISTANCE.assistance_request_id: ${assistanceRequestId}`);
          }
          openStructuredAssistance.set(assistanceRequestId, {
            kind: assistanceMsg.kind || 'assistance',
            owner_action: assistanceMsg.owner_action,
            progress_posture: assistanceMsg.progress_posture,
            response_contract: assistanceMsg.response_contract,
            stream: assistanceMsg.stream || null,
          });
          await emitSpineEventTracked({
            event_type: 'run.assistance_requested',
            trace_id: traceContext.trace_id,
            scenario_id: traceContext.scenario_id,
            actor_type: 'runtime',
            actor_id: connectorId,
            object_type: 'run',
            object_id: runId,
            status: 'started',
            run_id: runId,
            stream_id: assistanceMsg.stream || null,
            data: buildAssistanceRequestedDataFromMessage(assistanceMsg, runSource),
          });
          // Durable structured attention upsert. Same secret-redaction
          // and non-secret-action-target rules as the INTERACTION path.
          await attentionWriter.recordAssistanceRequest(assistanceMsg);
          onProgress(assistanceMsg);
          break;
        }

        case 'ASSISTANCE_STATUS': {
          validateAssistanceStatusMessage(msg);
          const closed = await closeStructuredAssistance(msg.assistance_request_id, msg.status, {
            ...(msg.message == null ? {} : { message: msg.message }),
          });
          if (!closed) {
            throw new Error(`Connector emitted ASSISTANCE_STATUS for unknown assistance_request_id: ${msg.assistance_request_id}`);
          }
          onProgress(msg);
          break;
        }

        case 'SKIP_RESULT': {
          validateSkipResultMessage(msg, scopeByStream);
          const skippedManifestStream = msg.stream ? manifestByStream.get(msg.stream) : null;
          const gap = buildKnownGap({
            kind: 'skip_result',
            stream: msg.stream || null,
            reason: msg.reason || null,
            message: msg.message || null,
            recoveryHint: msg.recovery_hint || null,
            scope: normalizeGapScope(msg),
            explicitSelection: Boolean(msg.stream && explicitlyRequestedStreams?.has(msg.stream)),
            unsupportedInDefaultScope: streamUnsupportedInDefaultScope(skippedManifestStream),
            diagnostics: msg.diagnostics ?? null,
          });
          appendKnownGap(gap);
          await emitSpineEventTracked({
            event_type: 'run.stream_skipped',
            trace_id: traceContext.trace_id,
            scenario_id: traceContext.scenario_id,
            actor_type: 'runtime',
            actor_id: connectorId,
            object_type: 'run',
            object_id: runId,
            status: 'skipped',
            run_id: runId,
            stream_id: msg.stream || null,
            data: {
              source: runSource,
              stream: msg.stream || null,
              reason: msg.reason || null,
              message: boundGapString(msg.message) || null,
              known_gap: gap,
              ...(gap.diagnostics ? { diagnostics: gap.diagnostics } : {}),
            },
          });
          onProgress(msg);
          break;
        }

        case 'DETAIL_GAPS_PAGE_REQUEST': {
          const request = validateDetailGapsPageRequest(msg, scopeByStream);
          const page = await readDetailGapPage({
            maxBytes: request.maxBytes,
            streams: request.streams ?? startScope.streams.map((stream) => stream.name),
          });
          const accepted = writeChildStdin(
            JSON.stringify({
              type: 'DETAIL_GAPS_PAGE_RESPONSE',
              reference_only: true,
              request_id: request.requestId,
              detail_gaps: page.detailGaps,
            }) + '\n',
            'detail_gaps_page_response',
          );
          onProgress({
            type: 'DETAIL_GAPS_PAGE_RESPONSE',
            reference_only: true,
            count: page.detailGaps.length,
            max_bytes: page.maxBytes,
            serialized_bytes: page.serializedBytes,
            candidate_limit: page.candidateLimit,
            accepted,
          });
          break;
        }

        case 'DETAIL_GAP': {
          validateDetailGapMessage(msg, scopeByStream);
          const storedGap = await detailGapStore.upsertPendingGap({
            connectorId,
            connectorInstanceId: normalizedConnectorInstanceId,
            grantId,
            source: runSource,
            stream: msg.stream,
            parentStream: msg.parent_stream || null,
            recordKey: msg.record_key ?? null,
            detailLocator: msg.detail_locator ?? null,
            listCursor: msg.list_cursor ?? null,
            scope: startScope,
            reason: msg.reason || null,
            retryable: msg.retryable ?? null,
            lastError: msg.last_error ?? null,
            discoveredRunId: runId,
            lastRunId: runId,
          });
          // Gap was explicitly re-deferred by the connector — it's already pending
          // again via upsert; remove from lease set so cleanup won't double-reset it.
          allServedGapIds.delete(storedGap.gap_id);

          // §10-A: a gap that re-defers with a NON-TRANSIENT error (404/410/
          // permanent-403/401) and has exhausted its per-provider recovery
          // budget transitions to `terminal` — removed from the fillable-pending
          // set (so it neither re-arms the cooldown nor blocks convergence to
          // 100%) but counted + surfaced, never silently retried forever. The
          // profile registry has no cross-provider default: a connector with no
          // declared profile is never terminalized (the gap stays pending).
          const terminalProfile = terminalGapProfileForConnector(connectorId);
          if (terminalProfile) {
            const lastError = msg.last_error ?? storedGap.last_error ?? null;
            const errorInfo = lastError
              ? { status: lastError.http_status, errorClass: lastError.class }
              : null;
            const outcome = await maybeTerminateGap(detailGapStore, storedGap.gap_id, errorInfo, terminalProfile);
            if (outcome.terminated && outcome.gap) {
              // Reflect the terminal transition in the durable gap we surface so
              // downstream coverage/known-gap projection reads `terminal`, not
              // `pending`.
              durableDetailGaps.push(outcome.gap);
              appendKnownGap(buildKnownGap({
                kind: 'detail_gap',
                stream: msg.stream,
                reason: msg.reason || null,
                message: 'Required detail is permanently unavailable at the source (terminal); recovered everything still retrievable.',
                recoveryHint: 'not_retriable',
                scope: {
                  parent_stream: msg.parent_stream || null,
                  record_key: msg.record_key == null ? null : String(msg.record_key),
                },
              }));
              await emitSpineEventTracked({
                event_type: 'run.detail_gap_terminal',
                trace_id: traceContext.trace_id,
                scenario_id: traceContext.scenario_id,
                actor_type: 'runtime',
                actor_id: connectorId,
                object_type: 'run',
                object_id: runId,
                status: 'succeeded',
                run_id: runId,
                stream_id: msg.stream,
                data: {
                  source: runSource,
                  grant_id: grantId,
                  gap_id: outcome.gap.gap_id,
                  stream: outcome.gap.stream,
                  reason: outcome.gap.reason,
                  terminal_reason: errorInfo ? classifyRecoveryError(errorInfo).reason : null,
                },
              });
              break;
            }
          }

          durableDetailGaps.push(storedGap);
          const gap = buildKnownGap({
            kind: 'detail_gap',
            stream: msg.stream,
            reason: msg.reason || null,
            message: 'Required detail is recorded as a pending reference-only recovery gap.',
            recoveryHint: msg.retryable === false ? 'not_retriable' : 'retry_by_runtime',
            scope: {
              parent_stream: msg.parent_stream || null,
              record_key: msg.record_key == null ? null : String(msg.record_key),
            },
          });
          appendKnownGap(gap);
          // Spine = append-only audit log of lifecycle TRANSITIONS, not a per-run
          // re-observation breadcrumb (SLVP-ideal audit-logging design, >=95%
          // red-teamed: see docs/research/slvp-ideal-audit-logging). Emit
          // `run.detail_gap_recorded` exactly ONCE per gap identity — at first
          // sighting — never when a later run merely re-defers an unchanged,
          // already-pending gap. `discovered_run_id` is set only by the store's
          // INSERT path and NEVER touched by either ON CONFLICT clause, so it
          // equals THIS run iff this run first recorded the gap. Re-emitting an
          // unchanged gap is dishonest-by-volume: the rows are indistinguishable
          // (no attempt_count/discovered_run_id to tell "newly found" from
          // "re-seen unchanged for the 7th time") and manufacture fake activity.
          // The "worked across N runs" story lives in the durable row's monotonic
          // attempt_count/last_run_id (Temporal/Kafka transition-vs-state split).
          // durableDetailGaps.push + appendKnownGap + onProgress above stay
          // OUTSIDE this gate — they feed the commit-coverage gate every run.
          if (storedGap.discovered_run_id === runId && !detailGapRecordedThisRun.has(storedGap.gap_id)) {
            detailGapRecordedThisRun.add(storedGap.gap_id);
            await emitSpineEventTracked({
              event_type: 'run.detail_gap_recorded',
              trace_id: traceContext.trace_id,
              scenario_id: traceContext.scenario_id,
              actor_type: 'runtime',
              actor_id: connectorId,
              object_type: 'run',
              object_id: runId,
              status: 'succeeded',
              run_id: runId,
              stream_id: msg.stream,
              data: {
                reference_only: true,
                source: runSource,
                grant_id: grantId,
                gap_id: storedGap.gap_id,
                stream: storedGap.stream,
                parent_stream: storedGap.parent_stream,
                record_key: storedGap.record_key,
                reason: storedGap.reason,
                status: storedGap.status,
                // Self-describing first-sighting event: the discriminating fields
                // an auditor needs so the single row is unambiguous.
                attempt_count: storedGap.attempt_count,
                discovered_run_id: storedGap.discovered_run_id,
                detail_locator: storedGap.detail_locator,
                list_cursor: storedGap.list_cursor,
                last_error: storedGap.last_error,
                known_gap: gap,
              },
            });
          }
          onProgress({ ...msg, gap_id: storedGap.gap_id });
          break;
        }

        case 'DETAIL_COVERAGE': {
          validateDetailCoverageMessage(msg, scopeByStream);
          trackDetailCoverage(msg);
          const coverageConsidered = boundConsideredCount(msg.considered);
          const coverageCovered = boundConsideredCount(msg.covered);
          await emitSpineEventTracked({
            event_type: 'run.detail_coverage_declared',
            trace_id: traceContext.trace_id,
            scenario_id: traceContext.scenario_id,
            actor_type: 'runtime',
            actor_id: connectorId,
            object_type: 'run',
            object_id: runId,
            status: 'succeeded',
            run_id: runId,
            stream_id: msg.stream,
            data: {
              reference_only: true,
              source: runSource,
              grant_id: grantId,
              state_stream: msg.state_stream,
              stream: msg.stream,
              required_keys: msg.required_keys.length,
              hydrated_keys: msg.hydrated_keys.length,
              gap_keys: msg.gap_keys?.length || 0,
              optional_skip_keys: msg.optional_skip_keys?.length || 0,
              // Optional connector-declared denominator; omitted (= `unknown`)
              // unless it is a trusted safe non-negative integer.
              ...(coverageConsidered == null ? {} : { considered: coverageConsidered }),
              // Optional covered count (task 4.4); same omit-unless-trusted posture.
              ...(coverageCovered == null ? {} : { covered: coverageCovered }),
            },
          });
          onProgress({
            type: 'DETAIL_COVERAGE',
            reference_only: true,
            state_stream: msg.state_stream,
            stream: msg.stream,
          });
          break;
        }

        case 'DETAIL_GAP_RECOVERED': {
          validateDetailGapRecoveredMessage(msg, scopeByStream);
          await flushAll();
          const recoveredGap = await detailGapStore.markGapStatus(msg.gap_id, 'recovered', { runId });
          // Gap is now recovered — remove from the lease set so cleanup won't reset it.
          allServedGapIds.delete(msg.gap_id);
          durableDetailGaps.push(recoveredGap);
          await emitSpineEventTracked({
            event_type: 'run.detail_gap_recovered',
            trace_id: traceContext.trace_id,
            scenario_id: traceContext.scenario_id,
            actor_type: 'runtime',
            actor_id: connectorId,
            object_type: 'run',
            object_id: runId,
            status: 'succeeded',
            run_id: runId,
            stream_id: msg.stream,
            data: {
              reference_only: true,
              source: runSource,
              grant_id: grantId,
              gap_id: recoveredGap.gap_id,
              stream: recoveredGap.stream,
              record_key: recoveredGap.record_key,
              status: recoveredGap.status,
            },
          });
          onProgress({ ...msg, status: 'recovered' });
          break;
        }

        case 'PROGRESS':
          validateProgressMessage(msg, scopeByStream);
          await emitSpineEventTracked({
            event_type: 'run.progress_reported',
            trace_id: traceContext.trace_id,
            scenario_id: traceContext.scenario_id,
            actor_type: 'runtime',
            actor_id: connectorId,
            object_type: 'run',
            object_id: runId,
            status: 'in_progress',
            run_id: runId,
            stream_id: msg.stream || null,
            data: {
              source: runSource,
              stream: msg.stream || null,
              message: msg.message || null,
              ...(msg.count == null ? {} : { count: msg.count }),
              ...(msg.total == null ? {} : { total: msg.total }),
              ...(msg.provider_budget == null ? {} : { provider_budget: msg.provider_budget }),
              ...(msg.collection_rate == null ? {} : { collection_rate: msg.collection_rate }),
            },
          });
          if (msg.collection_rate != null) {
            lastSeenCollectionRate = msg.collection_rate;
          }
          onProgress(msg);
          break;

        case 'DONE': {
          const invalidDoneStatus = validateDoneStatus(msg.status);
          if (invalidDoneStatus) throw invalidDoneStatus;
          const normalizedDoneError = validateDoneError(msg.status, msg.error);
          if (normalizedDoneError instanceof Error) throw normalizedDoneError;
          finalStatus = msg.status;
          doneMessage = {
            status: msg.status,
            records_emitted: msg.records_emitted,
            error: normalizedDoneError,
          };

          if (msg.status === 'succeeded') {
            // Flush any remaining records
            await flushAll();
          }
          // Close child stdin to signal that the runtime has finished
          // consuming DONE (and flushed all records for succeeded runs).
          // The connector's flushAndExit waits for this EOF before calling
          // process.exit(), closing the race where the connector exits while
          // buffered stdout bytes are still in transit through the kernel pipe.
          try { proc.stdin.end(); } catch {}
          break;
        }

        case '__PARSE_ERROR__':
          throw new Error(`Connector emitted invalid JSONL: ${msg.error}`);

        default:
          throw new Error(`Connector emitted unknown message type: ${msg.type}`);
      }
    }

    rl.on('line', (line) => {
      writeTrace(line);
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        if (failPendingInteraction(new Error(`Connector emitted ${msg.type} while waiting for INTERACTION_RESPONSE`))) {
          return;
        }
        msgQueue.push(msg);
        processNext().catch(reject);
      } catch (err) {
        if (failPendingInteraction(new Error(`Connector emitted invalid JSONL while waiting for INTERACTION_RESPONSE: ${err.message}`))) {
          return;
        }
        // Context for debugging: include byte length and a preview of the
        // offending line in the error message.
        const preview = line.length > 400
          ? `${line.slice(0, 200)} … [truncated ${line.length - 400} chars] … ${line.slice(-200)}`
          : line;
        const enriched = `${err.message} (line_length=${line.length} preview=${JSON.stringify(preview).slice(0, 600)})`;
        msgQueue.push({
          type: '__PARSE_ERROR__',
          error: enriched,
        });
        processNext().catch(reject);
      }
    });

    proc.on('close', async (code) => {
      clearTerminateTimer();
      const stderrTailRaw = stderrTail.finalize();
      if (stderrTailRaw.text) {
        onProgress({ type: 'stderr', text: stderrTailRaw.text });
      }
      // Build the persisted diagnostic excerpt. Connector stderr is
      // connector-authored and untrusted, so we redact recognized secret
      // markers before persistence and label the result as such. The
      // diagnostic is owner/control-plane evidence only — it MUST NOT be
      // exposed through grant-scoped /v1 surfaces.
      const stderrTailDiagnostic = buildStderrTailDiagnostic(stderrTailRaw);

      try {
        await waitForQueueDrain();
        if (!terminalEventRecorded) {
          if (doneMessage) {
            const exitCodeMismatch = validateDoneExitCode(doneMessage, code);
            if (exitCodeMismatch) {
              finalStatus = 'failed';
              const failureReason = classifyRuntimeFailure(exitCodeMismatch);
              exitCodeMismatch.run_id = runId;
              exitCodeMismatch.trace_id = traceContext.trace_id;
              exitCodeMismatch.failure_reason = failureReason;
              exitCodeMismatch.checkpoint_summary = buildCheckpointSummary();
              exitCodeMismatch.terminal_reason = failureReason;
              exitCodeMismatch.connector_error = doneMessage.error || null;
              exitCodeMismatch.known_gaps = buildKnownGapsForTerminal(failureReason, doneMessage.error || null);
              exitCodeMismatch.records_emitted = doneMessage.records_emitted;
              exitCodeMismatch.reported_records_emitted = doneMessage.records_emitted;

              await closeOpenStructuredAssistance('cancelled', { reason: failureReason });
              await emitSpineEvent({
                event_type: 'run.failed',
                trace_id: traceContext.trace_id,
                scenario_id: traceContext.scenario_id,
                actor_type: 'runtime',
                actor_id: connectorId,
                object_type: 'run',
                object_id: runId,
                status: 'failed',
                run_id: runId,
                data: buildRunTerminalData({
                  recordsEmitted: doneMessage.records_emitted,
                  reason: failureReason,
                  exitCode: code,
                  connectorError: doneMessage.error,
                }),
              });
              terminalEventRecorded = true;
              onProgress({
                type: 'done',
                status: 'failed',
                records_emitted: doneMessage.records_emitted,
                exit_code: code,
                reason: failureReason,
              });
              cleanupChildHandles();
              reject(exitCodeMismatch);
              return;
            }

            const recordsEmittedMismatch = validateDoneRecordsEmitted(doneMessage, totalEmitted);
            if (recordsEmittedMismatch) {
              finalStatus = 'failed';
              const failureReason = classifyRuntimeFailure(recordsEmittedMismatch);
              recordsEmittedMismatch.run_id = runId;
              recordsEmittedMismatch.trace_id = traceContext.trace_id;
              recordsEmittedMismatch.failure_reason = failureReason;
              recordsEmittedMismatch.checkpoint_summary = buildCheckpointSummary();
              recordsEmittedMismatch.terminal_reason = failureReason;
              recordsEmittedMismatch.connector_error = doneMessage.error || null;
              recordsEmittedMismatch.known_gaps = buildKnownGapsForTerminal(failureReason, doneMessage.error || null);
              recordsEmittedMismatch.records_emitted = totalEmitted;
              recordsEmittedMismatch.reported_records_emitted = doneMessage.records_emitted;

              await closeOpenStructuredAssistance('cancelled', { reason: failureReason });
              await emitSpineEvent({
                event_type: 'run.failed',
                trace_id: traceContext.trace_id,
                scenario_id: traceContext.scenario_id,
                actor_type: 'runtime',
                actor_id: connectorId,
                object_type: 'run',
                object_id: runId,
                status: 'failed',
                run_id: runId,
                data: buildRunTerminalData({
                  recordsEmitted: totalEmitted,
                  reason: failureReason,
                  exitCode: code,
                  reportedRecordsEmitted: doneMessage.records_emitted,
                  connectorError: doneMessage.error,
                }),
              });
              terminalEventRecorded = true;
              onProgress({
                type: 'done',
                status: 'failed',
                records_emitted: totalEmitted,
                reported_records_emitted: doneMessage.records_emitted,
                exit_code: code,
                reason: failureReason,
              });
              cleanupChildHandles();
              reject(recordsEmittedMismatch);
              return;
            }

            if (doneMessage.status === 'succeeded' && persistState) {
              assertDetailCoverageSatisfiedBeforeCommit();
              for (const [stream, cursor] of Object.entries(newState)) {
                await commitState(stream, cursor);
              }
            }
            await closeOpenStructuredAssistance(doneMessage.status === 'succeeded' ? 'resolved' : 'cancelled', {
              reason: doneMessage.status === 'succeeded' ? 'run_completed' : 'connector_reported_failed',
            });
            await emitSpineEvent({
              event_type: doneMessage.status === 'succeeded' ? 'run.completed' : 'run.failed',
              trace_id: traceContext.trace_id,
              scenario_id: traceContext.scenario_id,
              actor_type: 'runtime',
              actor_id: connectorId,
              object_type: 'run',
              object_id: runId,
              status: doneMessage.status,
              run_id: runId,
              data: buildRunTerminalData({
                recordsEmitted: doneMessage.records_emitted,
                reason: doneMessage.status === 'failed'
                  ? 'connector_reported_failed'
                  : (doneMessage.status === 'cancelled' ? 'connector_reported_cancelled' : null),
                connectorError: doneMessage.error,
              }),
            });
            onProgress({ type: 'done', status: doneMessage.status, records_emitted: doneMessage.records_emitted });
          } else if (ownerCancelRequested) {
            // The owner cancelled this run and the connector child exited
            // without DONE. Terminal as `run.cancelled` (intentional owner
            // stop), NOT `run.failed`/`connector_exit_without_done`. The
            // reason distinguishes a child that stopped within the graceful
            // window from one that had to be force-terminated. Staged cursor
            // state is NOT committed on this path (no DONE succeeded), and
            // already-flushed records are preserved.
            finalStatus = 'cancelled';
            const cancelReason = ownerCancelForced ? 'owner_cancel_forced' : 'owner_cancelled';
            await closeOpenStructuredAssistance('cancelled', { reason: cancelReason });
            await emitSpineEvent({
              event_type: 'run.cancelled',
              trace_id: traceContext.trace_id,
              scenario_id: traceContext.scenario_id,
              actor_type: 'owner',
              actor_id: connectorId,
              object_type: 'run',
              object_id: runId,
              status: 'cancelled',
              run_id: runId,
              data: buildRunTerminalData({
                recordsEmitted: totalEmitted,
                exitCode: code,
                reason: cancelReason,
                connectorError: null,
              }),
            });
            onProgress({
              type: 'done',
              status: 'cancelled',
              records_emitted: totalEmitted,
              exit_code: code,
              reason: cancelReason,
            });
          } else {
            // No DONE was received. If the runtime observed a
            // closed-stdin write, surface that as the typed terminal
            // reason; otherwise fall through to the generic "exited
            // without DONE" reason. Both paths resolve the run as
            // failed via the existing close handler.
            const { reason: closeFailureReason, phase: closeFailurePhase } = deriveTerminalReason({
              doneMessage: null,
              finalStatus: 'failed',
              childStdinClosedReason,
              childStdinClosedAtPhase,
            });
            const closeFailureMessage = buildConnectorExitFailureMessage({
              code,
              reason: closeFailureReason,
              phase: closeFailurePhase,
            });
            const connectorDiagnostics = stderrTailDiagnostic
              ? { stderr_tail: stderrTailDiagnostic }
              : null;
            await closeOpenStructuredAssistance('cancelled', { reason: closeFailureReason });
            await emitSpineEvent({
              event_type: 'run.failed',
              trace_id: traceContext.trace_id,
              scenario_id: traceContext.scenario_id,
              actor_type: 'runtime',
              actor_id: connectorId,
              object_type: 'run',
              object_id: runId,
              status: 'failed',
              run_id: runId,
              data: buildRunTerminalData({
                recordsEmitted: totalEmitted,
                exitCode: code,
                reason: closeFailureReason,
                stdinClosedAtPhase: closeFailurePhase,
                connectorError: null,
                failureOrigin: 'connector',
                failureMessage: closeFailureMessage,
                connectorDiagnostics,
              }),
            });
            onProgress({
              type: 'done',
              status: 'failed',
              records_emitted: totalEmitted,
              exit_code: code,
              reason: closeFailureReason,
              ...(closeFailureReason === 'connector_stdin_closed'
                ? { stdin_closed_at_phase: closeFailurePhase }
                : {}),
            });
          }
          terminalEventRecorded = true;
        }
        cleanupChildHandles();
        const derivedTerminal = deriveTerminalReason({
          doneMessage,
          finalStatus,
          childStdinClosedReason,
          childStdinClosedAtPhase,
        });
        // An owner-cancelled run resolves with the owner-cancel reason on the
        // result so callers (and run-history persistence) see the intentional
        // stop rather than a null/failure reason. The spine terminal event
        // already carries the same reason.
        const closeTerminalReason =
          finalStatus === 'cancelled' && ownerCancelRequested && !doneMessage
            ? (ownerCancelForced ? 'owner_cancel_forced' : 'owner_cancelled')
            : derivedTerminal.reason;
        const closeTerminalPhase = derivedTerminal.phase;
        // Surface the additive diagnostic fields on the resolved result
        // for failed connector exits before DONE so callers don't have
        // to parse the spine event back out.
        const exposeConnectorExitDiagnostic =
          finalStatus === 'failed' && !doneMessage;
        const resolvedFailureMessage = exposeConnectorExitDiagnostic
          ? buildConnectorExitFailureMessage({
              code,
              reason: closeTerminalReason,
              phase: closeTerminalPhase,
            })
          : null;
        resolve({
          status: finalStatus,
          records_emitted: totalEmitted,
          state: newState,
          checkpoint_summary: buildCheckpointSummary(),
          known_gaps: buildKnownGapsForTerminal(
            closeTerminalReason,
            doneMessage?.error || null,
          ),
          detail_gaps: durableDetailGaps.map((gap) => ({
            gap_id: gap.gap_id,
            stream: gap.stream,
            status: gap.status,
            reason: gap.reason,
          })),
          exit_code: code,
          run_id: runId,
          trace_id: traceContext.trace_id,
          terminal_reason: closeTerminalReason,
          ...(triggerKind ? { trigger_kind: triggerKind } : {}),
          ...(automationMode ? { automation_mode: automationMode } : {}),
          ...(closeTerminalReason === 'connector_stdin_closed'
            ? { stdin_closed_at_phase: closeTerminalPhase }
            : {}),
          connector_error: doneMessage?.error || null,
          ...(exposeConnectorExitDiagnostic
            ? {
                failure_origin: 'connector',
                failure_message: resolvedFailureMessage,
                ...(stderrTailDiagnostic
                  ? { connector_diagnostics: { stderr_tail: stderrTailDiagnostic } }
                  : {}),
              }
            : {}),
        });
      } catch (err) {
        finalStatus = 'failed';
        const failureReason = classifyRuntimeFailure(err);
        err.run_id = runId;
        err.trace_id = traceContext.trace_id;
        err.failure_reason = failureReason;
        err.checkpoint_summary = buildCheckpointSummary();
        err.terminal_reason = failureReason;
        err.connector_error = doneMessage?.error || null;
        err.known_gaps = buildKnownGapsForTerminal(failureReason, doneMessage?.error || null);
        err.records_emitted = totalEmitted;
        if (doneMessage?.records_emitted !== null && doneMessage?.records_emitted !== undefined) {
          err.reported_records_emitted = doneMessage.records_emitted;
        }

        if (!terminalEventRecorded) {
          try {
            await closeOpenStructuredAssistance('cancelled', { reason: failureReason });
            await emitSpineEvent({
              event_type: 'run.failed',
              trace_id: traceContext.trace_id,
              scenario_id: traceContext.scenario_id,
              actor_type: 'runtime',
              actor_id: connectorId,
              object_type: 'run',
              object_id: runId,
              status: 'failed',
              run_id: runId,
              data: buildRunTerminalData({
                recordsEmitted: doneMessage?.records_emitted ?? totalEmitted,
                reason: failureReason,
                exitCode: code,
                connectorError: doneMessage?.error || null,
                ingestFailure: err.ingest_failure || null,
              }),
            });
            terminalEventRecorded = true;
          } catch (emitErr) {
            onProgress({ type: 'spine_error', error: emitErr.message });
          }
        }

        onProgress({
          type: 'done',
          status: 'failed',
          records_emitted: doneMessage?.records_emitted ?? totalEmitted,
          exit_code: code,
          reason: failureReason,
        });
        cleanupChildHandles();
        reject(err);
      }
    });

    proc.on('error', (err) => {
      cleanupChildHandles();
      reject(err);
    });
  });
}

/**
 * Default interaction handler — prompts via stdin/stdout of the runtime process itself
 */
async function defaultInteractionHandler(interaction) {
  const { createInterface } = await import('readline');
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });

  process.stderr.write(`\n[INTERACTION] ${interaction.message}\n`);
  process.stderr.write(`Kind: ${interaction.kind}\n`);

  const data = {};
  const schema = interaction.schema?.properties || {};

  for (const [field, def] of Object.entries(schema)) {
    const answer = await new Promise(resolve => {
      const prompt = def.format === 'password' ? `${field} (hidden): ` : `${field}: `;
      rl.question(prompt, resolve);
    });
    data[field] = answer;
  }

  rl.close();

  return {
    type: 'INTERACTION_RESPONSE',
    request_id: interaction.request_id,
    status: 'success',
    data,
  };
}

/**
 * Load sync state from the RS for a connector
 */
/**
 * Load prior sync state for a connector from the RS.
 *
 * Accepts either:
 *   (connectorId, ownerToken, { rsUrl?, grantId?, connectorInstanceId? })
 *                                                       — legacy positional
 *   ({ connectorId, ownerToken, rsUrl?, grantId?, connectorInstanceId? })
 *                                                       — object form (what
 *                                                       all current callers
 *                                                       actually use)
 *
 * Both are accepted because the positional signature was the original shape
 * but the object form is what the orchestrate CLI and src/orchestrator.js
 * have been passing for months. When the signatures drifted, state loading
 * silently returned null for every connector — incremental sync looked like
 * it worked (RS dedup hides the damage) but was actually full-refresh every
 * run. Normalize on the object form going forward; keep positional for any
 * external callers that may exist.
 */
export async function loadSyncState(connectorIdOrOpts, ownerToken, opts = {}) {
  let connectorId, token, o;
  if (typeof connectorIdOrOpts === 'object' && connectorIdOrOpts !== null) {
    connectorId = connectorIdOrOpts.connectorId;
    token = connectorIdOrOpts.ownerToken;
    o = connectorIdOrOpts;
  } else {
    connectorId = connectorIdOrOpts;
    token = ownerToken;
    o = opts;
  }
  const rsUrl = o.rsUrl || process.env.RS_URL || 'http://localhost:7663';
  const connectorInstanceId = optionalNonEmptyEnv(o.connectorInstanceId);
  connectorId = canonicalConnectorKey(connectorId) ?? connectorId;
  const stateUrl = new URL(`/v1/state/${encodeURIComponent(connectorId)}`, rsUrl);
  if (connectorInstanceId) stateUrl.searchParams.set('connector_instance_id', connectorInstanceId);
  if (o.grantId) stateUrl.searchParams.set('grant_id', o.grantId);
  const url = stateUrl.toString();
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!resp.ok) return null;
  const body = await resp.json();
  return body.state || null;
}
