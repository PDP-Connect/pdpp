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

function encodeScopeResourceKey(key) {
  return Array.isArray(key) ? JSON.stringify(key) : String(key);
}

function buildRunSourceDescriptor(connectorId) {
  return { kind: 'connector', id: connectorId };
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
const KNOWN_GAPS_MAX = 50;

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

function boundGapStringList(values) {
  if (!Array.isArray(values)) return null;
  const bounded = values.map((value) => boundGapString(value)).filter(Boolean);
  if (!bounded.length) return null;
  return bounded.slice(0, GAP_LIST_MAX);
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

function buildKnownGap({
  kind,
  stream = null,
  reason = null,
  message = null,
  recoveryHint = null,
  scope = null,
  interactionKind = null,
}) {
  const safeReason = boundGapString(reason) || 'unknown';
  const safeMessage = boundGapString(message);
  return {
    kind,
    stream: boundGapString(stream),
    reason: safeReason,
    ...(safeMessage ? { message: safeMessage } : {}),
    ...(scope ? { scope } : {}),
    recovery_hint: normalizeRecoveryHint(recoveryHint, {
      reason: safeReason,
      message: safeMessage,
      interactionKind,
    }),
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
    || message.startsWith('Connector emitted PROGRESS for undeclared stream:')
    || message.startsWith('Connector emitted SKIP_RESULT for undeclared stream:')
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

  const streams = (manifest?.streams || []).map((stream) => ({ name: stream.name }));
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
    const role = safeAttachmentString(attachment.role, 80);
    const label = safeAttachmentString(attachment.label || attachment.title, 160);
    const ref = safeOpaqueAttachmentRef(attachment.ref || attachment.id || attachment.surface_id);
    if (role) result.role = role;
    if (label) result.label = label;
    if (ref) result.ref = ref;
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
    }
  }
}

function buildAssistanceRequestedDataFromInteraction(msg, runSource) {
  const isSecretValue = msg.kind === 'credentials' || msg.kind === 'otp';
  return {
    source: runSource,
    assistance_request_id: msg.request_id,
    progress_posture: 'blocked',
    owner_action: msg.kind === 'manual_action' ? 'operate_attachment' : 'provide_value',
    response_contract: 'response_required',
    sensitivity: isSecretValue ? 'secret' : 'non_secret',
    message: msg.message,
    kind: msg.kind,
    stream: msg.stream || null,
    ...(msg.timeout_seconds == null ? {} : { timeout_seconds: msg.timeout_seconds }),
    ...(isSecretValue && msg.schema != null ? { input_schema: msg.schema } : {}),
    ...(msg.kind === 'manual_action'
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
    message: msg.message,
    stream: msg.stream || null,
    ...(msg.timeout_seconds == null ? {} : { timeout_seconds: msg.timeout_seconds }),
    ...(msg.input_schema == null ? {} : { input_schema: msg.input_schema }),
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
    connectorId,
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
  } = opts;

  // Check binding requirements
  const requiredBindings = manifest.runtime_requirements?.bindings || {};
  const availableBindings = buildAvailableBindings(onInteraction);

  for (const [binding, req] of Object.entries(requiredBindings)) {
    if (req.required && !(binding in availableBindings)) {
      throw new Error(`Runtime cannot satisfy required binding: ${binding}`);
    }
  }

  const startScope = buildStartScope(manifest, providedScope);
  const startCollectionMode = validateCollectionMode(collectionMode);
  const startState = persistState ? validateStartState(state) : null;
  const scopeByStream = new Map((startScope.streams || []).map((streamScope) => [streamScope.name, streamScope]));
  const manifestByStream = new Map((manifest?.streams || []).map((stream) => [stream.name, stream]));

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
  const proc = spawn(process.execPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PDPP_CONNECTOR_ID: connectorId,
      PDPP_OWNER_TOKEN: ownerToken,
      PDPP_RS_URL: rsUrl,
      ...streamingRegistrationEnv,
      ...browserSurfaceLaunchEnv,
    },
  });

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

  // Send START
  const startMsg = {
    type: 'START',
    run_id: runId,
    collection_mode: startCollectionMode,
    scope: startScope,
    state: startState,
    bindings: availableBindings,
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

  async function closeStructuredAssistance(assistanceRequestId, status, extra = {}) {
    const activeAssistance = openStructuredAssistance.get(assistanceRequestId);
    if (!activeAssistance) {
      return false;
    }
    openStructuredAssistance.delete(assistanceRequestId);
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
        ...(extra.message ? { message: extra.message } : {}),
        ...(extra.reason ? { reason: extra.reason } : {}),
      },
    });
    return true;
  }

  async function closeOpenStructuredAssistance(status, extra = {}) {
    for (const assistanceRequestId of [...openStructuredAssistance.keys()]) {
      await closeStructuredAssistance(assistanceRequestId, status, extra);
    }
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
  let totalFlushed = 0;
  let finalStatus = 'failed';
  let pendingInteraction = null;
  let terminalEventRecorded = false;
  let doneMessage = null;
  const knownGaps = [];

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
    return {
      source: runSource,
      grant_id: grantId,
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
      ...(connectorError?.message ? { connector_error_message: connectorError.message } : {}),
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
      try {
        proc.kill();
      } catch {}

      if (terminateTimer || proc.exitCode != null || proc.signalCode != null) return;
      terminateTimer = setTimeout(() => {
        terminateTimer = null;
        if (proc.exitCode != null || proc.signalCode != null) return;
        try {
          proc.kill('SIGKILL');
        } catch {}
      }, 250);
      terminateTimer.unref?.();
    }

    function cleanupChildHandles() {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTerminateTimer();
      rl.close();
      proc.stdin.destroy();
      proc.stdout.destroy();
      proc.stderr.destroy();
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
            data: buildAssistanceRequestedDataFromInteraction(msg, runSource),
          });

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
          const gap = buildKnownGap({
            kind: 'skip_result',
            stream: msg.stream || null,
            reason: msg.reason || null,
            message: msg.message || null,
            recoveryHint: msg.recovery_hint || null,
            scope: normalizeGapScope(msg),
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
            },
          });
          onProgress(msg);
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
            },
          });
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
        const { reason: closeTerminalReason, phase: closeTerminalPhase } = deriveTerminalReason({
          doneMessage,
          finalStatus,
          childStdinClosedReason,
          childStdinClosedAtPhase,
        });
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
          exit_code: code,
          run_id: runId,
          trace_id: traceContext.trace_id,
          terminal_reason: closeTerminalReason,
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
 *   (connectorId, ownerToken, { rsUrl?, grantId? })   — legacy positional
 *   ({ connectorId, ownerToken, rsUrl?, grantId? })    — object form (what
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
  const stateUrl = new URL(`/v1/state/${encodeURIComponent(connectorId)}`, rsUrl);
  if (o.grantId) stateUrl.searchParams.set('grant_id', o.grantId);
  const url = stateUrl.toString();
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!resp.ok) return null;
  const body = await resp.json();
  return body.state || null;
}
