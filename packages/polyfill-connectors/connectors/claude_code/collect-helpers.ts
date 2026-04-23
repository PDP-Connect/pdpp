/**
 * Collect-layer helpers for the Claude Code connector.
 *
 * Lives in its own file (not index.ts) because index.ts calls
 * `runConnector({...})` at module load — importing it in a test keeps the
 * Node event loop alive waiting for the stdin protocol. This file
 * contains only I/O-free helpers (no fs, no readdir, no process.stdout
 * writes); side effects are injected via the `LineEmitDeps` /
 * `SessionEmitDeps` contracts so integration tests can wire them to
 * recording fakes.
 *
 * The extracted seams are the observable emit-path invariants:
 *   observeJsonlFields             — pin session_id + metadata + time
 *                                    range from the first/latest line
 *                                    that mentions each field.
 *   processJsonlLine               — per-JSONL-line dispatch: message vs
 *                                    attachment vs metadata-only, each
 *                                    gated by the matching stream in
 *                                    `requested`. Requires a session id
 *                                    pinned by a prior observe call.
 *   buildMessageRecord /
 *   buildAttachmentRecord          — per-line record builders (pure).
 *   emitSessionsFromAccumulators   — sessions pass: one record per
 *                                    accumulator, in iteration order.
 *
 * File I/O (walking ~/.claude/projects, reading jsonl / SKILL.md files,
 * statSync for mtimes) stays in index.ts — those paths open real fds and
 * aren't meaningfully testable without a file-system harness; the
 * per-line / per-session seams above are where the emit-order,
 * scope-gating, and dedup invariants live.
 */

import type { RecordData, StreamScope } from "../../src/connector-runtime.ts";
import { ATTACHMENT_PREVIEW_CHARS, extractContent, MESSAGE_CONTENT_PREVIEW_CHARS, textPreview } from "./parsers.ts";
import type { JsonlObject, SessionAccumulator } from "./types.ts";

// ─── Per-file parse observations ────────────────────────────────────────

/** Running observations pinned from a single JSONL file's lines. Only the
 *  first non-null value wins for metadata; timestamps widen to cover the
 *  min/max seen so the session aggregate covers the full file span. */
export interface JsonlObservations {
  cwd: string | null;
  entrypoint: string | null;
  firstTimestamp: string | null;
  gitBranch: string | null;
  lastTimestamp: string | null;
  messageCount: number;
  sessionId: string | null;
  userType: string | null;
  version: string | null;
}

export function makeJsonlObservations(forcedSessionId: string | null): JsonlObservations {
  return {
    sessionId: forcedSessionId || null,
    firstTimestamp: null,
    lastTimestamp: null,
    messageCount: 0,
    cwd: null,
    gitBranch: null,
    userType: null,
    entrypoint: null,
    version: null,
  };
}

/**
 * Fold one JSONL object into running observations. Pure, no emit. The
 * session id sticks on first sighting unless a `forcedSessionId` is set
 * (subagent files reuse the parent session id from the directory name).
 * Other metadata fields follow the same first-wins rule; timestamps
 * widen the observed [first, last] range.
 */
export function observeJsonlFields(obj: JsonlObject, obs: JsonlObservations, forcedSessionId: string | null): void {
  if (obj.sessionId && !forcedSessionId) {
    obs.sessionId = obj.sessionId;
  }
  if (obj.cwd && !obs.cwd) {
    obs.cwd = obj.cwd;
  }
  if (obj.gitBranch && !obs.gitBranch) {
    obs.gitBranch = obj.gitBranch;
  }
  if (obj.userType && !obs.userType) {
    obs.userType = obj.userType;
  }
  if (obj.entrypoint && !obs.entrypoint) {
    obs.entrypoint = obj.entrypoint;
  }
  if (obj.version && !obs.version) {
    obs.version = obj.version;
  }
  if (obj.timestamp) {
    if (!obs.firstTimestamp || obj.timestamp < obs.firstTimestamp) {
      obs.firstTimestamp = obj.timestamp;
    }
    if (!obs.lastTimestamp || obj.timestamp > obs.lastTimestamp) {
      obs.lastTimestamp = obj.timestamp;
    }
  }
}

// ─── Type predicates ────────────────────────────────────────────────────

export function isMessageType(type: string | undefined): boolean {
  return type === "user" || type === "assistant";
}

export function isAttachmentType(type: string | undefined): boolean {
  return (
    type === "attachment" || type === "file-history-snapshot" || type === "permission-mode" || type === "last-prompt"
  );
}

// ─── Per-line record builders (pure) ────────────────────────────────────

export function buildMessageRecord(obj: JsonlObject, sessionId: string, uuid: string): RecordData {
  return {
    id: uuid,
    session_id: sessionId,
    parent_uuid: obj.parentUuid ?? null,
    role: obj.type ?? null,
    type: obj.type ?? null,
    content: textPreview(extractContent(obj.message || obj), MESSAGE_CONTENT_PREVIEW_CHARS),
    timestamp: obj.timestamp || null,
    is_sidechain: obj.isSidechain ?? null,
    user_type: obj.userType ?? null,
    agent_id: obj.agentId ?? null,
  };
}

export function buildAttachmentRecord(obj: JsonlObject, sessionId: string, uuid: string): RecordData {
  const att = obj.attachment || {};
  return {
    id: uuid,
    session_id: sessionId,
    parent_uuid: obj.parentUuid ?? null,
    event_type: obj.type ?? null,
    hook_name: att.hookName || null,
    tool_use_id: att.toolUseID || null,
    content_preview: textPreview(extractContent(att) || extractContent(obj), ATTACHMENT_PREVIEW_CHARS),
    content_bytes: null,
    timestamp: obj.timestamp || null,
  };
}

// ─── Per-line dispatcher ────────────────────────────────────────────────

/** Injected deps threaded through every per-line emit helper. Mirrors the
 *  codex/gmail pattern: one stable bag so parseJsonlFile becomes pure
 *  orchestration and the helper is individually testable. */
export interface LineEmitDeps {
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  requested: Map<string, StreamScope>;
}

export interface ProcessJsonlLineArgs {
  deps: LineEmitDeps;
  obj: JsonlObject;
  obs: JsonlObservations;
}

/**
 * Dispatch one JSONL line. The caller is expected to have already folded
 * the object into `obs` via `observeJsonlFields` so `obs.sessionId` is
 * pinned before this runs.
 *
 * Invariants:
 *   - No session id yet (malformed rollout order) → no emits.
 *   - message types ("user", "assistant") → bump `obs.messageCount`
 *     unconditionally, emit only if the `messages` stream is requested.
 *   - attachment types (attachment, file-history-snapshot,
 *     permission-mode, last-prompt) → emit only if the `attachments`
 *     stream is requested.
 *   - Any other type → silent no-op (metadata-only lines like the
 *     `summary` header).
 *   - No uuid → no record (uuid is the emitted record id).
 */
export async function processJsonlLine({ deps, obj, obs }: ProcessJsonlLineArgs): Promise<void> {
  const sessionId = obs.sessionId;
  if (!sessionId) {
    return;
  }
  const uuid = obj.uuid;
  const type = obj.type;

  if (isMessageType(type)) {
    obs.messageCount++;
    if (deps.requested.has("messages") && uuid) {
      await deps.emitRecord("messages", buildMessageRecord(obj, sessionId, uuid));
    }
    return;
  }

  if (isAttachmentType(type) && deps.requested.has("attachments") && uuid) {
    await deps.emitRecord("attachments", buildAttachmentRecord(obj, sessionId, uuid));
  }
}

// ─── Sessions pass (I/O-free) ───────────────────────────────────────────

export interface EmitSessionsFromAccumulatorsArgs {
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  requested: Map<string, StreamScope>;
  sessionAccumulators: Map<string, SessionAccumulator>;
}

/**
 * I/O-free sessions emitter: given a fully-built accumulator map, emit
 * one `sessions` record per accumulator.
 *
 * Invariants:
 *   - Gated by `requested.has("sessions")` — no emit when off.
 *   - One record per session id; accumulator-map order is preserved so
 *     downstream sees sessions in insertion order (per-JS-Map semantics).
 *   - The record is a shallow copy — mutating the accumulator after this
 *     returns must not mutate the emitted record.
 */
export async function emitSessionsFromAccumulators({
  emitRecord,
  requested,
  sessionAccumulators,
}: EmitSessionsFromAccumulatorsArgs): Promise<void> {
  if (!requested.has("sessions")) {
    return;
  }
  for (const session of sessionAccumulators.values()) {
    await emitRecord("sessions", { ...session });
  }
}
