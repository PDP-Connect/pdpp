/**
 * Collect-layer helpers for the Codex connector.
 *
 * Lives in its own file (not index.ts) because index.ts runs `main()` at
 * module load — it opens stdin, talks the runtime protocol, and reads the
 * local Codex home directory. Importing it from test code would keep the
 * Node event loop alive forever. This file contains only I/O-free helpers
 * (no fs, no sqlite, no process.stdout writes); side effects are injected
 * via the `LineEmitDeps` contract so integration tests can wire them to
 * recording fakes.
 *
 * The extracted seams are the observable emit-path invariants:
 *   processResponseItem   — per response_item payload: message vs
 *                           function_call vs function_call_output, each
 *                           gated by the matching stream in `requested`.
 *   processRolloutLine    — per JSONL line: session_meta installs the
 *                           session id; response_items dispatch to
 *                           processResponseItem; everything else is a
 *                           silent no-op. Emits a progress signal every
 *                           2000 lines so large files don't look frozen.
 *   flushPendingCalls     — end-of-file flush: paired function_call +
 *                           function_call_output writes one combined
 *                           record per call_id.
 *   emitSessionsFromMaps  — sessions pass: prefer state_5.sqlite#threads
 *                           rows, fall back to rollout-only records for
 *                           sessions on disk but not in state_5. Dedup on
 *                           session id so one session ≤ one emit.
 *
 * File/sqlite I/O (walking the yyyy/mm/dd directory tree, reading JSONL,
 * opening state_5.sqlite read-only) stays in index.ts — those paths open
 * real fds and aren't meaningfully testable without a file-system harness;
 * the per-line / per-session seams above are where the emit-order, scope-
 * gating, and dedup invariants live.
 */

import type { RecordData, StreamScope } from "../../src/connector-runtime.ts";
import {
  buildRolloutOnlySessionRecord,
  buildThreadSessionRecord,
  extendTimestampRange,
  extractMessageText,
  payloadOutputPreview,
  type TimestampRange,
  textPreview,
} from "./parsers.ts";
import type { PendingCall, RolloutAggregate, RolloutObject, RolloutPayload, ThreadRow } from "./types.ts";

// ─── Per-run dependency bag ─────────────────────────────────────────────

/** Injected deps threaded through every per-line emit helper. Mirrors the
 *  amazon/chase/slack pattern: one stable bag so parseRolloutFile becomes
 *  pure orchestration and each helper is individually testable. */
export interface LineEmitDeps {
  emitRecord: (stream: string, data: RecordData) => void;
  /** Coarse progress hook fired every 2000 lines. Tests wire this to a
   *  recorder; production wires it to the runtime `emit(PROGRESS)`. */
  progress: (message: string) => void;
  requested: Map<string, StreamScope>;
}

// ─── Per-file parse state ───────────────────────────────────────────────

export interface RolloutParseState {
  firstTimestamp: string | null;
  functionCallCount: number;
  lastTimestamp: string | null;
  lineCount: number;
  messageCount: number;
  pendingCalls: Map<string, PendingCall>;
  sessionId: string | null;
  sessionMeta: RolloutPayload | null;
}

export function makeRolloutParseState(): RolloutParseState {
  return {
    sessionId: null,
    sessionMeta: null,
    firstTimestamp: null,
    lastTimestamp: null,
    messageCount: 0,
    functionCallCount: 0,
    pendingCalls: new Map(),
    lineCount: 0,
  };
}

// ─── Per-payload record builders (stateful over RolloutParseState) ──────

function emitMessageRecord(
  state: RolloutParseState,
  payload: RolloutPayload,
  ts: string | null,
  emitRecord: (stream: string, data: RecordData) => void
): void {
  const sessionId = state.sessionId;
  if (!sessionId) {
    return;
  }
  const id = `${sessionId}:${state.lineCount}`;
  emitRecord("messages", {
    id,
    session_id: sessionId,
    role: payload.role || null,
    type: "message",
    content: textPreview(extractMessageText(payload), 5000),
    timestamp: ts,
  });
}

function registerFunctionCall(state: RolloutParseState, payload: RolloutPayload, ts: string | null): void {
  const sessionId = state.sessionId;
  if (!sessionId) {
    return;
  }
  const callId = payload.call_id || `${sessionId}:${state.lineCount}`;
  state.pendingCalls.set(callId, {
    id: callId,
    session_id: sessionId,
    call_id: callId,
    name: payload.name || null,
    arguments: textPreview(payload.arguments || null, 2000),
    output_preview: null,
    timestamp: ts,
  });
}

function applyFunctionCallOutput(
  state: RolloutParseState,
  payload: RolloutPayload,
  ts: string | null,
  emitRecord: (stream: string, data: RecordData) => void
): void {
  const sessionId = state.sessionId;
  if (!sessionId) {
    return;
  }
  const callId = payload.call_id;
  const existing = callId ? state.pendingCalls.get(callId) : null;
  if (existing) {
    existing.output_preview = payloadOutputPreview(payload.output);
    return;
  }
  emitRecord("function_calls", {
    id: `${sessionId}:${state.lineCount}:output`,
    session_id: sessionId,
    call_id: callId || null,
    name: null,
    arguments: null,
    output_preview: payloadOutputPreview(payload.output),
    timestamp: ts,
  });
}

// ─── Per-payload dispatcher ─────────────────────────────────────────────

export interface ProcessResponseItemArgs {
  deps: LineEmitDeps;
  payload: RolloutPayload;
  state: RolloutParseState;
  ts: string | null;
}

/**
 * Dispatch one response_item payload. Each branch is gated by the matching
 * stream in `requested.has(...)`: a message payload only emits when
 * `messages` is requested; a function_call / function_call_output payload
 * only emits when `function_calls` is requested. `reasoning` payloads are
 * silently dropped — encrypted_content is opaque.
 *
 * Side effect on state: the messageCount / functionCallCount counters
 * advance unconditionally (so the session aggregate stays accurate even
 * when the corresponding record stream is gated off).
 */
export function processResponseItem({ deps, payload, state, ts }: ProcessResponseItemArgs): void {
  if (payload.type === "message") {
    state.messageCount++;
    if (deps.requested.has("messages")) {
      emitMessageRecord(state, payload, ts, deps.emitRecord);
    }
    return;
  }
  if (payload.type === "function_call") {
    state.functionCallCount++;
    if (deps.requested.has("function_calls")) {
      registerFunctionCall(state, payload, ts);
    }
    return;
  }
  if (payload.type === "function_call_output" && deps.requested.has("function_calls")) {
    applyFunctionCallOutput(state, payload, ts, deps.emitRecord);
  }
  // reasoning is skipped — encrypted_content is opaque.
}

// ─── Per-line dispatcher ────────────────────────────────────────────────

export interface ProcessRolloutLineArgs {
  deps: LineEmitDeps;
  file: string;
  obj: RolloutObject;
  state: RolloutParseState;
}

const PROGRESS_EVERY = 2000;

/**
 * Dispatch one JSONL line:
 *   - session_meta → install session id + metadata on state.
 *   - response_item → delegate to processResponseItem (iff sessionId seen).
 *   - anything else → silent no-op, line counter still advances.
 *
 * Fires a progress signal every PROGRESS_EVERY lines for large rollout
 * files. Timestamps extend the first/last range on every line regardless
 * of dispatch, so the session aggregate covers the full file span.
 */
export function processRolloutLine({ deps, file, obj, state }: ProcessRolloutLineArgs): void {
  state.lineCount++;
  if (state.lineCount % PROGRESS_EVERY === 0) {
    deps.progress(`  ${file}: ${state.lineCount} lines parsed`);
  }
  const ts = obj.timestamp || null;
  const range: TimestampRange = { firstTs: state.firstTimestamp, lastTs: state.lastTimestamp };
  extendTimestampRange(range, ts);
  state.firstTimestamp = range.firstTs;
  state.lastTimestamp = range.lastTs;

  if (obj.type === "session_meta") {
    state.sessionMeta = obj.payload || {};
    state.sessionId = state.sessionMeta.id || null;
    return;
  }
  if (!state.sessionId) {
    return;
  }
  if (obj.type !== "response_item") {
    return;
  }
  processResponseItem({
    payload: obj.payload || {},
    ts,
    state,
    deps,
  });
}

// ─── End-of-file flush ──────────────────────────────────────────────────

/**
 * Emit every pending function_call as a combined record at end of file.
 * A function_call payload registers a PendingCall in state.pendingCalls;
 * a matching function_call_output mutates the pending entry in place. At
 * EOF we emit whatever's left (with or without an output_preview) so the
 * function_calls stream lands every call exactly once.
 */
export function flushPendingCalls(state: RolloutParseState, deps: LineEmitDeps): void {
  for (const call of state.pendingCalls.values()) {
    deps.emitRecord("function_calls", { ...call });
  }
}

// ─── Sessions pass (I/O-free) ───────────────────────────────────────────

export interface EmitSessionsFromMapsArgs {
  emitRecord: (stream: string, data: RecordData) => void;
  rolloutAggregates: Map<string, RolloutAggregate>;
  threadsMap: Map<string, ThreadRow>;
}

/**
 * I/O-free sessions emitter: given a pre-loaded threads map (from
 * state_5.sqlite) and a map of rollout aggregates (from parseRolloutFile),
 * emit one `sessions` record per unique session id.
 *
 * Invariants:
 *   - Thread rows emit first, in threadsMap iteration order. Each thread
 *     is merged with its aggregate (so message_count / function_call_count
 *     reflect the on-disk rollout even when state_5 is canonical for the
 *     rest of the fields).
 *   - Rollout-only sessions (on disk but not in state_5) emit with nulls
 *     for state_5-only fields so the schema stays consistent.
 *   - Dedup is on session id: a session present in both maps emits ONCE
 *     (thread-preferred). Tests pin this — a regression would double-emit.
 */
export function emitSessionsFromMaps({ threadsMap, rolloutAggregates, emitRecord }: EmitSessionsFromMapsArgs): void {
  const emittedSessionIds = new Set<string>();
  for (const [id, t] of threadsMap) {
    emitRecord("sessions", buildThreadSessionRecord(id, t, rolloutAggregates.get(id)));
    emittedSessionIds.add(id);
  }
  for (const [id, agg] of rolloutAggregates) {
    if (emittedSessionIds.has(id)) {
      continue;
    }
    emitRecord("sessions", buildRolloutOnlySessionRecord(id, agg));
  }
}
