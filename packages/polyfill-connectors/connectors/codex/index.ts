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
import type { PendingCall, RolloutAggregate, RolloutObject, RolloutPayload, StartMessage, ThreadRow } from "./types.ts";

const emit = (m: EmittedMessage): boolean => process.stdout.write(stringifyForJsonl(m));
const flushAndExit = (code: number): void => {
  if (process.stdout.writableLength > 0) {
    process.stdout.once("drain", () => process.exit(code));
    setTimeout(() => process.exit(code), 3000).unref();
  } else {
    process.exit(code);
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
    stream: "memories",
    classification: "inventory_only",
    reason: "metadata-only until memory file shapes are approved",
  },
  {
    store: "context_mode",
    relativePath: "context-mode",
    stream: "context_mode",
    classification: "inventory_only",
    reason: "file shapes are not stable enough for content collection",
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
  }
  flushPendingCalls(state, deps);
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
  baseDir: string;
  emitRecord: (stream: string, data: RecordData) => void;
  fileMtimes: Record<string, number>;
  newMtimes: Record<string, number>;
  requested: Map<string, StreamScope>;
  rolloutAggregates: Map<string, RolloutAggregate>;
}

async function processRolloutEntry(
  entry: { path: string; year: string; month: string; day: string; file: string },
  args: ScanRolloutsArgs
): Promise<boolean> {
  let st: Stats;
  try {
    st = statSync(entry.path);
  } catch {
    return false;
  }
  const mtime = st.mtimeMs;
  if (args.fileMtimes[entry.path] === mtime) {
    args.newMtimes[entry.path] = mtime;
    // Skip unchanged files; the previously-emitted rollout record stays valid.
    return true;
  }
  emit({
    type: "PROGRESS",
    message: `Parsing ${entry.year}/${entry.month}/${entry.day}/${entry.file} (${(st.size / 1024 / 1024).toFixed(1)}MB)`,
  });
  await parseRolloutFile({
    path: entry.path,
    file: entry.file,
    requested: args.requested,
    emitRecord: args.emitRecord,
    rolloutAggregates: args.rolloutAggregates,
  });
  args.newMtimes[entry.path] = mtime;
  return true;
}

async function scanRollouts(args: ScanRolloutsArgs): Promise<void> {
  const baseExists = (await listIfExists(args.baseDir)) !== null;
  if (!baseExists) {
    emit({
      type: "PROGRESS",
      message: `${args.baseDir} not readable`,
    });
    return;
  }
  let fileCount = 0;
  for await (const entry of walkRollouts(args.baseDir)) {
    fileCount++;
    await processRolloutEntry(entry, args);
  }
  emit({
    type: "PROGRESS",
    message: `Scanned ${fileCount} rollout files`,
  });
}

// ─── Session emission ───────────────────────────────────────────────────

interface EmitSessionsArgs {
  emitRecord: (stream: string, data: RecordData) => void;
  rolloutAggregates: Map<string, RolloutAggregate>;
  stateDbPath: string;
}

function emitSessions({ stateDbPath, rolloutAggregates, emitRecord }: EmitSessionsArgs): void {
  // Sessions: prefer state_5.sqlite#threads; fall back to rollout-derived
  // fields only when state_5 doesn't have the session. Session PK stays the
  // thread/session id — the same UUID is used by both sources. The I/O-free
  // merge + dedup (`emitSessionsFromMaps`) is exported from this file so
  // integration tests can pin it without touching sqlite.
  const { map: threadsById } = loadThreadsMap(stateDbPath);
  emitSessionsFromMaps({ threadsMap: threadsById, rolloutAggregates, emitRecord });
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
}

function emitStateCursors({ requested, newMtimes, nowIso }: EmitStateCursorsArgs): void {
  if (requested.has("sessions")) {
    emit({ type: "STATE", stream: "sessions", cursor: { fetched_at: nowIso() } });
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
    "memories",
    "context_mode",
    "config_inventory",
    "cache_inventory",
    "coverage_diagnostics",
  ]) {
    if (requested.has(s)) {
      emit({ type: "STATE", stream: s, cursor: { fetched_at: nowIso() } });
    }
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
    }
  }
  for (const directoryStream of [
    {
      relativeRoot: "shell-snapshots",
      store: "shell_snapshots",
      stream: "shell_snapshots",
      reason: "shell content requires redaction review before payload collection",
    },
    {
      relativeRoot: "memories",
      store: "memories",
      stream: "memories",
      reason: "metadata-only until memory file shapes are approved",
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
    }
  }
  if (input.requested.has("coverage_diagnostics")) {
    for (const record of inventory.coverage) {
      input.emitRecord("coverage_diagnostics", record);
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

  await emitLocalInventoryStreams({ codexHome: dirs.codexHome, requested, emitRecord });

  if (needRollouts) {
    await scanRollouts({
      baseDir: dirs.baseDir,
      fileMtimes,
      newMtimes,
      requested,
      emitRecord,
      rolloutAggregates,
    });
  }

  if (requested.has("sessions")) {
    emitSessions({ stateDbPath: dirs.stateDbPath, rolloutAggregates, emitRecord });
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

  emitStateCursors({ requested, newMtimes, nowIso });

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
