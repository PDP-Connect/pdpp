#!/usr/bin/env node

/**
 * PDPP Codex CLI Connector (v0.2.0)
 *
 * Reads OpenAI Codex CLI's on-disk state. No auth required; runs against
 * local files under ~/.codex (overridable).
 *
 * Streams:
 *   sessions        — one record per thread. Source of truth is
 *                     `state_5.sqlite#threads` (title, archived, tokens_used,
 *                     first_user_message, sandbox_policy, approval_mode, …),
 *                     enriched with rollout-derived message/tool-call counts.
 *                     Falls back to rollout-only records for sessions that
 *                     are on disk but not in state_5.sqlite.
 *   messages        — user/assistant text messages (from rollout-*.jsonl).
 *   function_calls  — shell/tool invocations + outputs (from rollout-*.jsonl).
 *   rules           — personal trust-registry entries (~/.codex/rules/*.rules),
 *                     one record per rule line. The stream is intentionally
 *                     named after the real local directory rather than the
 *                     backlog shorthand "approval_rules".
 *   prompts         — user-authored prompts (~/.codex/prompts/*.md).
 *   skills          — user-authored skills (~/.codex/skills/<name>/SKILL.md).
 *
 * Incremental: rollout parsing skips files whose mtime matches the prior run.
 * `state_5.sqlite` is opened READ-ONLY so we never risk corrupting live Codex
 * state.
 *
 * Env overrides:
 *   CODEX_HOME             default ~/.codex (parent of all paths below)
 *   CODEX_SESSIONS_DIR     default $CODEX_HOME/sessions
 *   CODEX_STATE_DB         default $CODEX_HOME/state_5.sqlite
 *   CODEX_RULES_DIR        default $CODEX_HOME/rules
 *   CODEX_PROMPTS_DIR      default $CODEX_HOME/prompts
 *   CODEX_SKILLS_DIR       default $CODEX_HOME/skills
 */

import { createReadStream, type Dirent, existsSync, type Stats, statSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface as createFileReader, createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import type { EmittedMessage, RecordData, StreamScope } from "../../src/connector-runtime-protocol.ts";
import { type CarryForwardCursor, openCarryForwardCursor } from "../../src/fingerprint-cursor.ts";
import { isMainModule } from "../../src/is-main-module.ts";
import {
  buildLocalSourceInventory,
  type KnownLocalStore,
  listDirectoryInventory,
} from "../../src/local-source-inventory.ts";
import { stringifyForJsonl } from "../../src/safe-emit.ts";
import { resourceSet } from "../../src/scope-filters.ts";
import {
  buildPromptRecord,
  buildRolloutOnlySessionRecord,
  buildRuleRecord,
  buildSkillRecord,
  buildThreadSessionRecord,
  extendTimestampRange,
  extractMessageText,
  isRolloutFile,
  isSkippableRulesLine,
  parseFrontmatter,
  payloadOutputPreview,
  RULES_SUFFIX_RE,
  splitRulesLines,
  type TimestampRange,
  TWO_DIGIT_DIR_RE,
  textPreview,
  YEAR_DIR_RE,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type {
  PendingCall,
  RolloutAggregate,
  RolloutObject,
  RolloutPayload,
  StartMessage,
  ThreadFingerprint,
  ThreadRow,
} from "./types.ts";

const DEFAULT_ACTIVE_ROLLOUT_QUIET_MS = 120_000;
const ACTIVE_ROLLOUT_QUIET_MS_ENV = "PDPP_CODEX_ACTIVE_ROLLOUT_QUIET_MS";

let stdoutDrainPromise: Promise<void> | null = null;

const emit = (m: EmittedMessage): void => {
  const ok = process.stdout.write(stringifyForJsonl(m));
  if (!ok && stdoutDrainPromise === null) {
    stdoutDrainPromise = new Promise<void>((resolve) => {
      process.stdout.once("drain", () => {
        stdoutDrainPromise = null;
        resolve();
      });
    });
  }
};

async function waitForEmitDrain(): Promise<void> {
  if (stdoutDrainPromise !== null) {
    await stdoutDrainPromise;
  }
}

const flushAndExit = (code: number): void => {
  const doExit = (): void => {
    if (process.stdin.readableEnded) {
      process.exit(code);
    } else {
      process.stdin.once("end", () => process.exit(code));
      setTimeout(() => process.exit(code), 3000).unref();
    }
  };
  if (process.stdout.writableLength > 0) {
    process.stdout.once("drain", doExit);
    setTimeout(() => process.exit(code), 3000).unref();
  } else {
    doExit();
  }
};
const fail = (m: string, r = false): void => {
  emit({
    type: "DONE",
    status: "failed",
    records_emitted: 0,
    error: { message: m, retryable: r },
  });
  flushAndExit(1);
};

export const CODEX_KNOWN_LOCAL_STORES: KnownLocalStore[] = [
  {
    store: "sessions",
    relativePath: "sessions",
    stream: "sessions",
    classification: "collect",
    reason: "declared rollout source",
  },
  {
    store: "state_db",
    relativePath: "state_5.sqlite",
    stream: "sessions",
    classification: "collect",
    reason: "declared thread metadata source opened read-only",
  },
  {
    store: "rules",
    relativePath: "rules",
    stream: "rules",
    classification: "collect",
    reason: "declared user-authored rules source",
  },
  {
    store: "prompts",
    relativePath: "prompts",
    stream: "prompts",
    classification: "collect",
    reason: "declared user-authored prompts source",
  },
  {
    store: "skills",
    relativePath: "skills",
    stream: "skills",
    classification: "collect",
    reason: "declared user-authored skills source",
  },
  {
    store: "history",
    relativePath: "history.jsonl",
    stream: "history",
    classification: "inventory_only",
    reason: "metadata-only until prompt-history payload contract is approved",
  },
  {
    store: "session_index",
    relativePath: "session_index.jsonl",
    stream: "session_index",
    classification: "inventory_only",
    reason: "metadata-only until session-index payload contract is approved",
  },
  {
    store: "shell_snapshots",
    relativePath: "shell-snapshots",
    stream: "shell_snapshots",
    classification: "inventory_only",
    reason: "shell content requires redaction review before payload collection",
  },
  {
    store: "memories",
    relativePath: "memories",
    stream: null,
    classification: "inventory_only",
    reason: "deferred private local store; diagnostics only until a general Codex memory surface is approved",
  },
  {
    store: "context_mode",
    relativePath: "context-mode",
    stream: null,
    classification: "inventory_only",
    reason: "user-specific local convention; diagnostics only, not a general Codex stream",
  },
  {
    store: "logs",
    relativePath: "logs",
    stream: "logs",
    classification: "defer",
    reason: "logs require deterministic redaction before collection",
  },
  {
    store: "config",
    relativePath: "config.toml",
    stream: "config_inventory",
    classification: "inventory_only",
    reason: "configuration is inventoried without payload content",
  },
  {
    store: "cache",
    relativePath: "cache",
    stream: "cache_inventory",
    classification: "inventory_only",
    reason: "raw cache payloads may contain sensitive tool output",
  },
  {
    store: "auth",
    relativePath: "auth.json",
    stream: null,
    classification: "exclude",
    reason: "auth-adjacent credential material is never emitted",
  },
];

// ─── JSONL line iteration ───────────────────────────────────────────────

async function* iterJsonlLines(path: string): AsyncGenerator<RolloutObject> {
  const r = createFileReader({
    input: createReadStream(path, { encoding: "utf8" }),
    terminal: false,
  });
  for await (const line of r) {
    if (!line.trim()) {
      continue;
    }
    try {
      yield JSON.parse(line) as RolloutObject;
    } catch {
      /* skip malformed */
    }
  }
}

// ─── Rollout directory walking ──────────────────────────────────────────

async function listIfExists(dir: string): Promise<string[] | null> {
  try {
    return await readdir(dir);
  } catch {
    return null;
  }
}

async function* walkDayFiles(
  dayPath: string,
  year: string,
  month: string,
  day: string
): AsyncGenerator<{ path: string; year: string; month: string; day: string; file: string }> {
  const files = await listIfExists(dayPath);
  if (files === null) {
    return;
  }
  for (const f of files) {
    if (isRolloutFile(f)) {
      yield { path: join(dayPath, f), year, month, day, file: f };
    }
  }
}

async function* walkMonthDays(
  monthPath: string,
  year: string,
  month: string
): AsyncGenerator<{ path: string; year: string; month: string; day: string; file: string }> {
  const days = await listIfExists(monthPath);
  if (days === null) {
    return;
  }
  for (const d of days) {
    if (!TWO_DIGIT_DIR_RE.test(d)) {
      continue;
    }
    yield* walkDayFiles(join(monthPath, d), year, month, d);
  }
}

async function* walkYearMonths(
  yearPath: string,
  year: string
): AsyncGenerator<{ path: string; year: string; month: string; day: string; file: string }> {
  const months = await listIfExists(yearPath);
  if (months === null) {
    return;
  }
  for (const m of months) {
    if (!TWO_DIGIT_DIR_RE.test(m)) {
      continue;
    }
    yield* walkMonthDays(join(yearPath, m), year, m);
  }
}

// Recursively walk the yyyy/mm/dd hierarchy and yield rollout-*.jsonl paths.
async function* walkRollouts(
  baseDir: string
): AsyncGenerator<{ path: string; year: string; month: string; day: string; file: string }> {
  const years = await listIfExists(baseDir);
  if (years === null) {
    return;
  }
  for (const y of years) {
    if (!YEAR_DIR_RE.test(y)) {
      continue;
    }
    yield* walkYearMonths(join(baseDir, y), y);
  }
}

// ─── state_5.sqlite reader ─────────────────────────────────────────────

const THREADS_QUERY = `
  SELECT id, rollout_path, created_at, updated_at, source, model_provider,
         cwd, title, sandbox_policy, approval_mode, tokens_used,
         has_user_event, archived, archived_at, git_sha, git_branch,
         git_origin_url, cli_version, first_user_message, agent_nickname,
         agent_role, memory_mode, model, reasoning_effort
  FROM threads
`;

function openThreadsDb(dbPath: string): DatabaseSync | null {
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit({
      type: "PROGRESS",
      message: `state_5.sqlite unreadable (${msg}); falling back to rollouts only`,
    });
    return null;
  }
}

function queryThreadsRows(db: DatabaseSync): ThreadRow[] {
  try {
    const rawRows: unknown = db.prepare(THREADS_QUERY).all();
    return rawRows as ThreadRow[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit({
      type: "PROGRESS",
      message: `threads query failed (${msg}); falling back to rollouts only`,
    });
    return [];
  }
}

/**
 * Load `threads` rows keyed by id. Opens the DB read-only to be safe against
 * live Codex writes. Returns a Map of id → thread record (raw, unmapped).
 */
function loadThreadsMap(dbPath: string): {
  map: Map<string, ThreadRow>;
  present: boolean;
} {
  if (!existsSync(dbPath)) {
    return { map: new Map(), present: false };
  }
  const db = openThreadsDb(dbPath);
  if (!db) {
    return { map: new Map(), present: false };
  }
  const map = new Map<string, ThreadRow>();
  try {
    for (const r of queryThreadsRows(db)) {
      map.set(r.id, r);
    }
  } finally {
    try {
      db.close();
    } catch {
      /* noop */
    }
  }
  return { map, present: true };
}

// ─── Static-file streams ────────────────────────────────────────────────

interface LoadedFile {
  mtimeMs: number;
  size: number;
  text: string;
}

async function statAndRead(path: string): Promise<LoadedFile | null> {
  try {
    const st = await stat(path);
    const text = await readFile(path, "utf8");
    return { mtimeMs: Number(st.mtimeMs), size: Number(st.size), text };
  } catch {
    return null;
  }
}

async function emitRulesStream(
  rulesDir: string,
  emitRecord: (stream: string, data: RecordData) => void
): Promise<void> {
  const entries = await listIfExists(rulesDir);
  if (entries === null) {
    return;
  }
  for (const f of entries) {
    if (!f.endsWith(".rules")) {
      continue;
    }
    const p = join(rulesDir, f);
    const loaded = await statAndRead(p);
    if (!loaded) {
      continue;
    }
    const mtime = Math.floor(loaded.mtimeMs / 1000);
    const ruleset = f.replace(RULES_SUFFIX_RE, "");
    let idx = 0;
    for (const raw of splitRulesLines(loaded.text)) {
      const line = raw.trim();
      if (isSkippableRulesLine(line)) {
        continue;
      }
      emitRecord("rules", buildRuleRecord({ ruleset, line, index: idx, path: p, mtime }));
      await waitForEmitDrain();
      idx++;
    }
  }
}

async function emitPromptsStream(
  promptsDir: string,
  emitRecord: (stream: string, data: RecordData) => void
): Promise<void> {
  const entries = await listIfExists(promptsDir);
  if (entries === null) {
    return;
  }
  for (const f of entries) {
    if (!f.endsWith(".md")) {
      continue;
    }
    const p = join(promptsDir, f);
    const loaded = await statAndRead(p);
    if (!loaded) {
      continue;
    }
    const { meta, body } = parseFrontmatter(loaded.text);
    emitRecord("prompts", buildPromptRecord({ fileName: f, meta, body, path: p, mtimeMs: loaded.mtimeMs }));
    await waitForEmitDrain();
  }
}

function shouldSkipSkillEntry(ent: Dirent): boolean {
  return ent.name.startsWith(".") || ent.name === "skills.backup";
}

async function isDirectoryPath(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function emitSkillsStream(
  skillsDir: string,
  emitRecord: (stream: string, data: RecordData) => void
): Promise<void> {
  // Each skill is a subdirectory with SKILL.md at its root. Follows symlinks
  // (skills are often symlinked from dotfiles). Skips hidden dirs (.system).
  let entries: Dirent[];
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (shouldSkipSkillEntry(ent)) {
      continue;
    }
    const dirPath = join(skillsDir, ent.name);
    if (!(await isDirectoryPath(dirPath))) {
      continue;
    }
    const skillMdPath = join(dirPath, "SKILL.md");
    const loaded = await statAndRead(skillMdPath);
    if (!loaded) {
      continue;
    }
    const { meta, body } = parseFrontmatter(loaded.text);
    emitRecord(
      "skills",
      buildSkillRecord({ dirName: ent.name, meta, body, path: skillMdPath, mtimeMs: loaded.mtimeMs })
    );
    await waitForEmitDrain();
  }
}

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
  const previewResult = payloadOutputPreview(payload.output);
  if (existing) {
    existing.output_preview = previewResult.preview;
    if (previewResult.binaryReason) {
      existing.output_binary_reason = previewResult.binaryReason;
    }
    return;
  }
  emitRecord("function_calls", {
    id: `${sessionId}:${state.lineCount}:output`,
    session_id: sessionId,
    call_id: callId || null,
    name: null,
    arguments: null,
    output_preview: previewResult.preview,
    output_binary_reason: previewResult.binaryReason,
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

export function shouldDeferActiveRolloutFile(input: { mtimeMs: number; nowMs: number; quietMs: number }): boolean {
  return input.quietMs > 0 && input.mtimeMs > input.nowMs - input.quietMs;
}

/**
 * Dispatch one JSONL line:
 *   - session_meta → install session id + metadata on state, but only
 *     from the FIRST session_meta line in the file. Forked rollouts
 *     emit additional session_meta lines describing the fork parent
 *     chain; those must NOT overwrite the canonical (child) session id,
 *     otherwise every response_item that follows would be attributed to
 *     the parent and the child session's message/function counts would
 *     stay null.
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
    if (state.sessionId === null) {
      state.sessionMeta = obj.payload || {};
      state.sessionId = state.sessionMeta.id || null;
    }
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
  /**
   * Shared carry-forward cursor over the per-thread `ThreadFingerprint`.
   * This run's emitted sessions `note` a fresh fingerprint, and skipped
   * sessions carry their prior fingerprint forward unchanged (the cursor
   * seeds its next map from the prior). The caller serializes
   * `cursor.toState()` into the next `sessions` STATE cursor so the chain
   * stays intact across runs.
   *
   * The cursor owns two behaviors the connector relies on:
   *   1. Lossy-overwrite repair: `cursor.prior(id)` supplies the prior
   *      counts when this run did NOT parse the session's rollout file, so
   *      a state_5-only update doesn't clobber a real `message_count` with
   *      `null` (see `buildThreadSessionRecord` / `makeThreadFingerprint`).
   *   2. Churn reduction: `shouldReemitThreadSession` skips emitting a
   *      thread entirely when none of (a) rollout parsed this run,
   *      (b) thread.updated_at moved, (c) the session id is new. No emit =
   *      no new history version. The cursor still carries the fingerprint
   *      forward so the next run can gate against it.
   *
   * Omitted by callers that don't need the cursor (e.g. unit tests pinning
   * the legacy emit-everything contract); in that case every thread emits
   * and no fingerprints are tracked.
   */
  cursor?: CarryForwardCursor<ThreadFingerprint>;
  emitRecord: (stream: string, data: RecordData) => void;
  rolloutAggregates: Map<string, RolloutAggregate>;
  threadsMap: Map<string, ThreadRow>;
}

/**
 * Decide whether a thread session needs to be re-emitted this run.
 * Returns true if any of:
 *   - The session id is new (no prior fingerprint).
 *   - This run parsed the session's rollout file (counts may have moved).
 *   - The thread's `updated_at` is strictly greater than the prior
 *     fingerprint's `updated_at` (state_5 actually changed for this row).
 *
 * Returns false when the row is byte-for-byte the same shape we'd build —
 * skipping the emit avoids a new history version downstream.
 */
export function shouldReemitThreadSession(
  thread: ThreadRow,
  agg: RolloutAggregate | undefined,
  priorFingerprint: ThreadFingerprint | undefined
): boolean {
  if (!priorFingerprint) {
    return true;
  }
  if (agg) {
    return true;
  }
  const priorUpdatedAt = priorFingerprint.updated_at ?? null;
  const currentUpdatedAt = thread.updated_at ?? null;
  if (currentUpdatedAt == null) {
    return priorUpdatedAt != null;
  }
  if (priorUpdatedAt == null) {
    return true;
  }
  return currentUpdatedAt > priorUpdatedAt;
}

function makeThreadFingerprint(
  thread: ThreadRow,
  agg: RolloutAggregate | undefined,
  priorFingerprint: ThreadFingerprint | undefined
): ThreadFingerprint {
  // Counts must follow the same fallback chain as buildThreadSessionRecord
  // — otherwise the fingerprint we persist would disagree with the record
  // we just emitted, and the next run would think state_5 hasn't moved
  // while the count field oscillates.
  return {
    updated_at: thread.updated_at ?? null,
    message_count: agg?.messageCount ?? priorFingerprint?.message_count ?? null,
    function_call_count: agg?.functionCallCount ?? priorFingerprint?.function_call_count ?? null,
  };
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
 *   - When prior fingerprints are supplied, threads whose `updated_at`
 *     hasn't advanced AND whose rollout wasn't parsed this run are
 *     skipped — this stops the state_5-mtime-only churn that was
 *     creating an excess record version per scan.
 *   - When a thread is emitted without a fresh aggregate, the prior
 *     fingerprint's counts fill in for `message_count` /
 *     `function_call_count`. Without this, a state_5-only update would
 *     overwrite a real count with `null` and grow history with a
 *     lossy version.
 *   - Rollout-only sessions (on disk but not in state_5) emit with nulls
 *     for state_5-only fields so the schema stays consistent.
 *   - Dedup is on session id: a session present in both maps emits ONCE
 *     (thread-preferred). Tests pin this — a regression would double-emit.
 */
export function emitSessionsFromMaps({
  threadsMap,
  rolloutAggregates,
  emitRecord,
  cursor,
}: EmitSessionsFromMapsArgs): void {
  const emittedSessionIds = new Set<string>();
  for (const [id, t] of threadsMap) {
    emittedSessionIds.add(id);
    const agg = rolloutAggregates.get(id);
    const prior = cursor?.prior(id);
    if (shouldReemitThreadSession(t, agg, prior)) {
      emitRecord("sessions", buildThreadSessionRecord(id, t, agg, prior));
    }
    cursor?.note(id, makeThreadFingerprint(t, agg, prior));
  }
  for (const [id, agg] of rolloutAggregates) {
    if (emittedSessionIds.has(id)) {
      continue;
    }
    emitRecord("sessions", buildRolloutOnlySessionRecord(id, agg));
    // Rollout-only sessions don't have a state_5 row to fingerprint
    // against (updated_at lives in threads). They re-emit whenever
    // their rollout file mtime changes — the rollout-file mtime gate
    // in scanRollouts is the right deduper for that path.
  }
}

// ─── Rollout-file line processing ───────────────────────────────────────
// This wrapper still owns the JSONL iterator + the post-file
// rolloutAggregates write-back.

interface ParseRolloutFileArgs {
  emitRecord: (stream: string, data: RecordData) => void;
  file: string;
  path: string;
  requested: Map<string, StreamScope>;
  rolloutAggregates: Map<string, RolloutAggregate>;
}

async function parseRolloutFile(args: ParseRolloutFileArgs): Promise<void> {
  const state = makeRolloutParseState();
  const deps: LineEmitDeps = {
    emitRecord: args.emitRecord,
    progress: (message: string): void => {
      emit({ type: "PROGRESS", message });
    },
    requested: args.requested,
  };
  for await (const obj of iterJsonlLines(args.path)) {
    processRolloutLine({ obj, state, deps, file: args.file });
    await waitForEmitDrain();
  }
  flushPendingCalls(state, deps);
  await waitForEmitDrain();
  if (state.sessionId) {
    args.rolloutAggregates.set(state.sessionId, {
      meta: state.sessionMeta || {},
      firstTs: state.firstTimestamp,
      lastTs: state.lastTimestamp,
      messageCount: state.messageCount,
      functionCallCount: state.functionCallCount,
      rolloutPath: args.path,
    });
  }
}

interface ScanRolloutsArgs {
  activeQuietMs: number;
  baseDir: string;
  emitRecord: (stream: string, data: RecordData) => void;
  fileMtimes: Record<string, number>;
  newMtimes: Record<string, number>;
  requested: Map<string, StreamScope>;
  rolloutAggregates: Map<string, RolloutAggregate>;
  scanStartedAtMs: number;
}

interface ScanRolloutsResult {
  parsedFiles: number;
}

async function processRolloutEntry(
  entry: { path: string; year: string; month: string; day: string; file: string },
  args: ScanRolloutsArgs
): Promise<"missing" | "parsed" | "skipped"> {
  let st: Stats;
  try {
    st = statSync(entry.path);
  } catch {
    return "missing";
  }
  const mtime = st.mtimeMs;
  if (args.fileMtimes[entry.path] === mtime) {
    args.newMtimes[entry.path] = mtime;
    // Skip unchanged files; the previously-emitted rollout record stays valid.
    return "skipped";
  }
  if (shouldDeferActiveRolloutFile({ mtimeMs: mtime, nowMs: args.scanStartedAtMs, quietMs: args.activeQuietMs })) {
    emit({
      type: "PROGRESS",
      message: `Deferring active rollout ${entry.year}/${entry.month}/${entry.day}/${entry.file}`,
    });
    await waitForEmitDrain();
    return "skipped";
  }
  emit({
    type: "PROGRESS",
    message: `Parsing ${entry.year}/${entry.month}/${entry.day}/${entry.file} (${(st.size / 1024 / 1024).toFixed(1)}MB)`,
  });
  await waitForEmitDrain();
  await parseRolloutFile({
    path: entry.path,
    file: entry.file,
    requested: args.requested,
    emitRecord: args.emitRecord,
    rolloutAggregates: args.rolloutAggregates,
  });
  args.newMtimes[entry.path] = mtime;
  return "parsed";
}

async function scanRollouts(args: ScanRolloutsArgs): Promise<ScanRolloutsResult> {
  const baseExists = (await listIfExists(args.baseDir)) !== null;
  if (!baseExists) {
    emit({
      type: "PROGRESS",
      message: `${args.baseDir} not readable`,
    });
    await waitForEmitDrain();
    return { parsedFiles: 0 };
  }
  let fileCount = 0;
  let parsedFiles = 0;
  for await (const entry of walkRollouts(args.baseDir)) {
    fileCount++;
    if ((await processRolloutEntry(entry, args)) === "parsed") {
      parsedFiles++;
    }
  }
  emit({
    type: "PROGRESS",
    message: `Scanned ${fileCount} rollout files`,
  });
  await waitForEmitDrain();
  return { parsedFiles };
}

// ─── Session emission ───────────────────────────────────────────────────

interface EmitSessionsArgs {
  cursor: CarryForwardCursor<ThreadFingerprint>;
  emitRecord: (stream: string, data: RecordData) => void;
  rolloutAggregates: Map<string, RolloutAggregate>;
  stateDbPath: string;
}

function emitSessions({ stateDbPath, rolloutAggregates, emitRecord, cursor }: EmitSessionsArgs): void {
  // Sessions: prefer state_5.sqlite#threads; fall back to rollout-derived
  // fields only when state_5 doesn't have the session. Session PK stays the
  // thread/session id — the same UUID is used by both sources. The I/O-free
  // merge + dedup (`emitSessionsFromMaps`) is exported from this file so
  // integration tests can pin it without touching sqlite.
  const { map: threadsById } = loadThreadsMap(stateDbPath);
  emitSessionsFromMaps({
    threadsMap: threadsById,
    rolloutAggregates,
    emitRecord,
    cursor,
  });
}

// ─── Start-message + state-cursor helpers ───────────────────────────────

async function readStartMessage(): Promise<StartMessage> {
  const rl = createInterface({ input: process.stdin, terminal: false });
  return await new Promise<StartMessage>((resolve, reject) =>
    rl.once("line", (l) => {
      try {
        resolve(JSON.parse(l) as StartMessage);
      } catch (e) {
        reject(e);
      }
    })
  );
}

interface CodexDirs {
  baseDir: string;
  codexHome: string;
  promptsDir: string;
  rulesDir: string;
  skillsDir: string;
  stateDbPath: string;
}

function resolveCodexDirs(): CodexDirs {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  return {
    codexHome,
    baseDir: process.env.CODEX_SESSIONS_DIR || join(codexHome, "sessions"),
    stateDbPath: process.env.CODEX_STATE_DB || join(codexHome, "state_5.sqlite"),
    rulesDir: process.env.CODEX_RULES_DIR || join(codexHome, "rules"),
    promptsDir: process.env.CODEX_PROMPTS_DIR || join(codexHome, "prompts"),
    skillsDir: process.env.CODEX_SKILLS_DIR || join(codexHome, "skills"),
  };
}

function readFileMtimes(startMsg: StartMessage): Record<string, number> {
  const state = startMsg.state || {};
  // STATE is stream-keyed per Collection Profile: `state` is
  // { <stream>: <cursor>, ... }. This connector emits STATE with a
  // stream name (see cursorStream below), cursor={file_mtimes:{...}}.
  // Check all streams that might carry file_mtimes plus legacy top-level.
  return (
    state.messages?.file_mtimes ||
    state.function_calls?.file_mtimes ||
    state.sessions?.file_mtimes ||
    state.file_mtimes ||
    {}
  );
}

function resolveActiveRolloutQuietMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ACTIVE_ROLLOUT_QUIET_MS_ENV];
  if (!raw) {
    return DEFAULT_ACTIVE_ROLLOUT_QUIET_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_ACTIVE_ROLLOUT_QUIET_MS;
}

function buildRequestedMap(startMsg: StartMessage): Map<string, StreamScope> {
  return new Map<string, StreamScope>((startMsg.scope?.streams || []).map((s) => [s.name, s]));
}

function buildResourceFilters(requested: Map<string, StreamScope>): Map<string, ReadonlySet<string> | null> {
  const resFilters = new Map<string, ReadonlySet<string> | null>();
  for (const [n, r] of requested) {
    resFilters.set(n, resourceSet(r));
  }
  return resFilters;
}

async function isReadableDirectory(path: string): Promise<boolean> {
  try {
    const st = await stat(path);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function isReadableFile(path: string): Promise<boolean> {
  try {
    const st = await stat(path);
    return st.isFile();
  } catch {
    return false;
  }
}

async function assertRequestedCodexSources(dirs: CodexDirs, requested: Map<string, StreamScope>): Promise<void> {
  const missing: string[] = [];
  const needsRollouts = requested.has("messages") || requested.has("function_calls");

  if (needsRollouts && !(await isReadableDirectory(dirs.baseDir))) {
    missing.push(`CODEX_SESSIONS_DIR=${dirs.baseDir}`);
  }
  if (requested.has("sessions")) {
    const hasRollouts = await isReadableDirectory(dirs.baseDir);
    const hasThreadsDb = await isReadableFile(dirs.stateDbPath);
    if (!(hasRollouts || hasThreadsDb)) {
      missing.push(`CODEX_SESSIONS_DIR=${dirs.baseDir} or CODEX_STATE_DB=${dirs.stateDbPath}`);
    }
  }
  if (requested.has("rules") && !(await isReadableDirectory(dirs.rulesDir))) {
    missing.push(`CODEX_RULES_DIR=${dirs.rulesDir}`);
  }
  if (requested.has("prompts") && !(await isReadableDirectory(dirs.promptsDir))) {
    missing.push(`CODEX_PROMPTS_DIR=${dirs.promptsDir}`);
  }
  if (requested.has("skills") && !(await isReadableDirectory(dirs.skillsDir))) {
    missing.push(`CODEX_SKILLS_DIR=${dirs.skillsDir}`);
  }
  if (missing.length > 0) {
    throw new Error(`requested Codex local source path(s) are missing or unreadable: ${missing.join(", ")}`);
  }
}

interface EmitStateCursorsArgs {
  newMtimes: Record<string, number>;
  nowIso: () => string;
  requested: Map<string, StreamScope>;
  sessionsSourceMtimeMs: number;
  threadFingerprints: CarryForwardCursor<ThreadFingerprint>;
}

function emitStateCursors({
  requested,
  newMtimes,
  nowIso,
  sessionsSourceMtimeMs,
  threadFingerprints,
}: EmitStateCursorsArgs): void {
  if (requested.has("sessions")) {
    emit({
      type: "STATE",
      stream: "sessions",
      cursor: {
        fetched_at: nowIso(),
        source_mtime_ms: sessionsSourceMtimeMs,
        thread_fingerprints: threadFingerprints.toState(),
      },
    });
  }
  if (requested.has("messages") || requested.has("function_calls")) {
    const cursorStream = requested.has("messages") ? "messages" : "function_calls";
    emit({
      type: "STATE",
      stream: cursorStream,
      cursor: { file_mtimes: newMtimes, fetched_at: nowIso() },
    });
  }
  for (const s of ["rules", "prompts", "skills"]) {
    if (requested.has(s)) {
      emit({ type: "STATE", stream: s, cursor: { fetched_at: nowIso() } });
    }
  }
  for (const s of [
    "history",
    "session_index",
    "logs",
    "shell_snapshots",
    "config_inventory",
    "cache_inventory",
    "coverage_diagnostics",
  ]) {
    if (requested.has(s)) {
      emit({ type: "STATE", stream: s, cursor: { fetched_at: nowIso() } });
    }
  }
}

function readPriorSessionsSourceMtimeMs(startMsg: StartMessage): number | null {
  const state = startMsg.state || {};
  const sessions = state.sessions;
  const value =
    sessions && typeof sessions === "object" && !Array.isArray(sessions)
      ? (sessions as Record<string, unknown>).source_mtime_ms
      : null;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function coerceFingerprintEntry(value: unknown): ThreadFingerprint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const v = value as Record<string, unknown>;
  return {
    updated_at: nullableFiniteNumber(v.updated_at),
    message_count: nullableFiniteNumber(v.message_count),
    function_call_count: nullableFiniteNumber(v.function_call_count),
  };
}

function rawFingerprintMap(startMsg: unknown): Record<string, unknown> | null {
  if (!startMsg || typeof startMsg !== "object") {
    return null;
  }
  const state = (startMsg as Record<string, unknown>).state;
  if (!state || typeof state !== "object") {
    return null;
  }
  const sessions = (state as Record<string, unknown>).sessions;
  if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) {
    return null;
  }
  const raw = (sessions as Record<string, unknown>).thread_fingerprints;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  return raw as Record<string, unknown>;
}

/**
 * Parse the prior `sessions` STATE cursor's `thread_fingerprints` map.
 * Tolerant of legacy cursors (no fingerprints), missing field, wrong
 * types, or values from a partially-different schema — bad entries are
 * silently dropped rather than failing the whole run.
 */
export function readPriorThreadFingerprints(startMsg: unknown): Map<string, ThreadFingerprint> {
  const out = new Map<string, ThreadFingerprint>();
  const raw = rawFingerprintMap(startMsg);
  if (!raw) {
    return out;
  }
  for (const [id, value] of Object.entries(raw)) {
    const entry = coerceFingerprintEntry(value);
    if (entry) {
      out.set(id, entry);
    }
  }
  return out;
}

function fileMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

async function emitLocalInventoryStreams(input: {
  codexHome: string;
  emitRecord: (stream: string, data: RecordData) => void;
  requested: Map<string, StreamScope>;
}): Promise<void> {
  const inventory = await buildLocalSourceInventory("codex", input.codexHome, CODEX_KNOWN_LOCAL_STORES);
  for (const [stream, records] of inventory.recordsByStream) {
    if (!input.requested.has(stream)) {
      continue;
    }
    for (const record of records) {
      input.emitRecord(stream, record);
      await waitForEmitDrain();
    }
  }
  for (const directoryStream of [
    {
      relativeRoot: "shell-snapshots",
      store: "shell_snapshots",
      stream: "shell_snapshots",
      reason: "shell content requires redaction review before payload collection",
    },
  ]) {
    if (!input.requested.has(directoryStream.stream)) {
      continue;
    }
    const records = await listDirectoryInventory({
      tool: "codex",
      sourceHome: input.codexHome,
      ...directoryStream,
    });
    for (const record of records) {
      input.emitRecord(directoryStream.stream, record);
      await waitForEmitDrain();
    }
  }
  if (input.requested.has("coverage_diagnostics")) {
    for (const record of inventory.coverage) {
      input.emitRecord("coverage_diagnostics", record);
      await waitForEmitDrain();
    }
  }
}

// ─── main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startMsg = await readStartMessage();
  if (startMsg.type !== "START") {
    return fail("Expected START");
  }

  const requested = buildRequestedMap(startMsg);
  if (!requested.size) {
    return fail("START.scope.streams is required");
  }

  const resFilters = buildResourceFilters(requested);
  const dirs = resolveCodexDirs();
  await assertRequestedCodexSources(dirs, requested);
  const fileMtimes = readFileMtimes(startMsg);

  let total = 0;
  const nowIso = (): string => new Date().toISOString();
  const emittedAt = nowIso();
  const emitRecord = (s: string, d: RecordData): void => {
    if (d.id == null) {
      return;
    }
    const resSet = resFilters.get(s);
    if (resSet && !resSet.has(String(d.id))) {
      return;
    }
    const validation = validateRecord(s, d);
    if (!validation.ok) {
      const message = `${String(d.id)}: ${validation.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`;
      emit({
        type: "SKIP_RESULT",
        stream: s,
        reason: "shape_check_failed",
        message,
      });
      return;
    }
    emit({
      type: "RECORD",
      stream: s,
      key: d.id,
      data: d,
      emitted_at: emittedAt,
    });
    total++;
  };

  const needRollouts = requested.has("sessions") || requested.has("messages") || requested.has("function_calls");

  // Rollout aggregates per session (so `sessions` can carry message_count /
  // function_call_count even when state_5 provides the canonical metadata).
  const rolloutAggregates = new Map<string, RolloutAggregate>();
  const newMtimes: Record<string, number> = { ...fileMtimes };
  const scanStartedAtMs = Date.now();
  const sessionsSourceMtimeMs = fileMtimeMs(dirs.stateDbPath);
  let parsedRolloutFiles = 0;
  // Prior per-thread fingerprints (from last STATE cursor) gate which
  // thread sessions actually need to re-emit, and provide the count
  // fallback that prevents `message_count: null` overwrites when this
  // run didn't parse the matching rollout file. The shared carry-forward
  // cursor seeds its next map from the prior map (via openCarryForwardCursor),
  // so threads we deliberately don't re-emit carry their fingerprints
  // forward unchanged. The connector-specific decode + tolerant coercion of
  // the structured `ThreadFingerprint` shape stays in readPriorThreadFingerprints.
  const threadFingerprints = openCarryForwardCursor<ThreadFingerprint>(readPriorThreadFingerprints(startMsg));

  await emitLocalInventoryStreams({ codexHome: dirs.codexHome, requested, emitRecord });

  if (needRollouts) {
    const rolloutScan = await scanRollouts({
      activeQuietMs: resolveActiveRolloutQuietMs(),
      baseDir: dirs.baseDir,
      fileMtimes,
      newMtimes,
      requested,
      emitRecord,
      rolloutAggregates,
      scanStartedAtMs,
    });
    parsedRolloutFiles = rolloutScan.parsedFiles;
  }

  if (
    requested.has("sessions") &&
    (parsedRolloutFiles > 0 || readPriorSessionsSourceMtimeMs(startMsg) !== sessionsSourceMtimeMs)
  ) {
    emitSessions({
      stateDbPath: dirs.stateDbPath,
      rolloutAggregates,
      emitRecord,
      cursor: threadFingerprints,
    });
    await waitForEmitDrain();
  }

  if (requested.has("rules")) {
    await emitRulesStream(dirs.rulesDir, emitRecord);
  }
  if (requested.has("prompts")) {
    await emitPromptsStream(dirs.promptsDir, emitRecord);
  }
  if (requested.has("skills")) {
    await emitSkillsStream(dirs.skillsDir, emitRecord);
  }

  emitStateCursors({ requested, newMtimes, nowIso, sessionsSourceMtimeMs, threadFingerprints });
  await waitForEmitDrain();

  emit({ type: "DONE", status: "succeeded", records_emitted: total });
  flushAndExit(0);
}

// Guarded so `import "./index.ts"` in tests doesn't spin up the runtime
// and block the Node event loop on stdin. Only fires when this module
// IS the process entry point (i.e. `tsx connectors/codex/index.ts`).
if (isMainModule(import.meta.url)) {
  main().catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    emit({
      type: "DONE",
      status: "failed",
      records_emitted: 0,
      error: { message: msg, retryable: false },
    });
    flushAndExit(1);
  });
}
