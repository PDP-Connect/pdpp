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
 * Incremental: rollout parsing uses an append-safe per-file cursor
 * (`file_cursors`: identity + committed byte offset + prefix integrity guard),
 * so a long-lived append-only rollout file is tailed from its last committed
 * boundary instead of fully reparsed on every append. Unchanged files are
 * skipped; new files parse in full; truncated/replaced files fall back to a
 * full reparse. The legacy whole-file `file_mtimes` cursor is still read for
 * backward compatibility (one-time reparse on upgrade). `state_5.sqlite` is
 * opened READ-ONLY so we never risk corrupting live Codex state.
 *
 * Env overrides:
 *   CODEX_HOME             default ~/.codex (parent of all paths below)
 *   CODEX_SESSIONS_DIR     default $CODEX_HOME/sessions
 *   CODEX_STATE_DB         default $CODEX_HOME/state_5.sqlite
 *   CODEX_RULES_DIR        default $CODEX_HOME/rules
 *   CODEX_PROMPTS_DIR      default $CODEX_HOME/prompts
 *   CODEX_SKILLS_DIR       default $CODEX_HOME/skills
 */

import { createHash } from "node:crypto";
import { createReadStream, type Dirent, type Stats, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { readBoundedFilePreview } from "../../src/bounded-file-preview.ts";
import { flushAndExitAfterRuntimeAck } from "../../src/connector-exit.ts";
import type { EmittedMessage, RecordData, StreamScope } from "../../src/connector-runtime-protocol.ts";
import { type CarryForwardCursor, openCarryForwardCursor } from "../../src/fingerprint-cursor.ts";
import { isMainModule } from "../../src/is-main-module.ts";
import {
  buildCoverageDiagnosticsStateSnapshot,
  buildLocalSourceInventory,
  type KnownLocalStore,
  listDirectoryInventory,
  openInventoryFingerprintCursor,
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
  RolloutFileCursor,
  RolloutObject,
  RolloutPayload,
  StartMessage,
  ThreadFingerprint,
  ThreadRow,
} from "./types.ts";

const DEFAULT_ACTIVE_ROLLOUT_QUIET_MS = 120_000;
const ACTIVE_ROLLOUT_QUIET_MS_ENV = "PDPP_CODEX_ACTIVE_ROLLOUT_QUIET_MS";

// Bytes of file prefix covered by the rollout cursor integrity guard. Rollout
// files are append-only, so a changed first 64 KiB means the file was
// truncated/rotated/replaced and the stored byte offset is no longer valid.
// Bounded so the guard is O(1) regardless of how large the rollout file grows.
const GUARD_PREFIX_BYTES = 64 * 1024;
// Enrollment / connector-version upgrades can arrive with only legacy file_mtimes
// state, and rotated/truncated/replaced rollout files fail the prefix-integrity
// guard. Both paths force a parse from byte offset 0, so keep unmatched
// function-call state bounded across full replay.
const MAX_PENDING_FUNCTION_CALLS = 1024;

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
  flushAndExitAfterRuntimeAck(code);
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

// ─── JSONL line iteration (byte-offset aware) ───────────────────────────

export interface RolloutLineYield {
  /** Byte offset just past this line's terminating `\n`. This is the safe
   *  append boundary: a parse that stops here has consumed only fully
   *  newline-terminated lines, so a later run can resume from here without
   *  re-reading or splitting a partial line. */
  committedOffset: number;
  obj: RolloutObject;
}

/**
 * Stream a rollout JSONL file from `startOffset` (bytes), yielding each
 * newline-terminated JSON object together with the byte offset just past its
 * terminator. A trailing chunk with no final `\n` (an in-flight append) is
 * NOT yielded and its bytes are NOT counted toward the committed offset — it
 * is re-read on a later run once the writer finishes the line. Memory stays
 * bounded: at most one line plus the current read chunk is held.
 *
 * Byte offsets are tracked over the raw bytes (Buffer length), not decoded
 * characters, so a multi-byte UTF-8 sequence advances the offset by its true
 * byte length and the resume offset always lands on a real byte boundary.
 */
export async function* iterJsonlLinesFromOffset(path: string, startOffset: number): AsyncGenerator<RolloutLineYield> {
  const stream = createReadStream(path, { start: startOffset });
  let pending: Buffer = Buffer.alloc(0);
  // Byte offset (from file start) just past the last `\n` we have emitted.
  let committed = startOffset;
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    pending = pending.length === 0 ? buf : Buffer.concat([pending, buf]);
    let nl = pending.indexOf(0x0a);
    while (nl !== -1) {
      const lineBuf = pending.subarray(0, nl);
      committed += nl + 1; // bytes consumed up to and including the `\n`
      const line = lineBuf.toString("utf8");
      const trimmed = line.trim();
      if (trimmed) {
        let parsed: RolloutObject | null = null;
        try {
          parsed = JSON.parse(line) as RolloutObject;
        } catch {
          parsed = null; // skip malformed, but still advance the offset
        }
        if (parsed) {
          yield { obj: parsed, committedOffset: committed };
        }
      }
      pending = pending.subarray(nl + 1);
      nl = pending.indexOf(0x0a);
    }
  }
  // Any leftover `pending` is a partial (unterminated) line — intentionally
  // dropped without advancing `committed`, so it is re-read next run.
}

// ─── Rollout file integrity guard ───────────────────────────────────────

/**
 * SHA-256 over the first `guardBytes` bytes of `path`. Bounded read — never
 * loads more than the guard prefix into memory. Returns null if the file is
 * shorter than `guardBytes` (caller treats a short read as an integrity
 * mismatch and full-reparses) or on any read error.
 */
async function hashFilePrefix(path: string, guardBytes: number): Promise<string | null> {
  if (guardBytes <= 0) {
    return createHash("sha256").update(Buffer.alloc(0)).digest("hex");
  }
  return await new Promise<string | null>((resolve) => {
    const hash = createHash("sha256");
    let read = 0;
    const stream = createReadStream(path, { start: 0, end: guardBytes - 1 });
    stream.on("data", (chunk) => {
      const buf = chunk as Buffer;
      read += buf.length;
      hash.update(buf);
    });
    stream.on("error", () => resolve(null));
    stream.on("end", () => {
      // A guard prefix that came up short means the file shrank below the
      // boundary we committed against — treat as replaced.
      resolve(read >= guardBytes ? hash.digest("hex") : null);
    });
  });
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
  } catch {
    emit({
      type: "PROGRESS",
      message: "Codex phase=index pass=index state_db_readable=false fallback=rollouts_only",
    });
    return null;
  }
}

function isThreadRow(row: unknown): row is ThreadRow {
  return typeof row === "object" && row !== null && typeof (row as { id?: unknown }).id === "string";
}

function* queryThreadsRows(db: DatabaseSync): Iterable<ThreadRow> {
  try {
    for (const row of db.prepare(THREADS_QUERY).iterate()) {
      if (isThreadRow(row)) {
        yield row;
      }
    }
  } catch {
    emit({
      type: "PROGRESS",
      message: "Codex phase=index pass=index state_db_query_failed=true fallback=rollouts_only",
    });
  }
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
    const preview = await readBoundedFilePreview(path);
    if (preview === null) {
      return null;
    }
    const text = preview.buffer.toString("utf8");
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

/** Optional seed for an append-only resume. Carries forward the parser
 *  counters and identity that an appended suffix continues, so suffix record
 *  keys (`${sessionId}:${lineCount}`) never collide with already-emitted keys
 *  and the resulting aggregate counts are cumulative (prior + delta). The
 *  appended suffix has no `session_meta` line, so seeding `sessionId` is what
 *  attributes the suffix response_items to the right session. */
export interface RolloutParseSeed {
  firstTimestamp: string | null;
  functionCallCount: number;
  lastTimestamp: string | null;
  lineCount: number;
  messageCount: number;
  sessionId: string | null;
}

export function makeRolloutParseState(seed?: RolloutParseSeed): RolloutParseState {
  return {
    sessionId: seed?.sessionId ?? null,
    sessionMeta: null,
    firstTimestamp: seed?.firstTimestamp ?? null,
    lastTimestamp: seed?.lastTimestamp ?? null,
    messageCount: seed?.messageCount ?? 0,
    functionCallCount: seed?.functionCallCount ?? 0,
    pendingCalls: new Map(),
    lineCount: seed?.lineCount ?? 0,
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

function registerFunctionCall(
  state: RolloutParseState,
  payload: RolloutPayload,
  ts: string | null,
  emitRecord: (stream: string, data: RecordData) => void
): void {
  const sessionId = state.sessionId;
  if (!sessionId) {
    return;
  }
  const callId = payload.call_id || `${sessionId}:${state.lineCount}`;
  while (state.pendingCalls.size >= MAX_PENDING_FUNCTION_CALLS) {
    const oldestEntry = state.pendingCalls.entries().next();
    if (oldestEntry.done) {
      break;
    }
    const [oldestCallId, oldest] = oldestEntry.value;
    emitRecord("function_calls", oldest);
    state.pendingCalls.delete(oldestCallId);
  }
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
    // Emit the merged call+output record NOW and drop the pending entry, rather
    // than mutating it in place and waiting for the EOF flush. Holding every
    // paired call in `pendingCalls` until end-of-file made the map grow to one
    // entry per call across the whole parse — O(file) memory, multi-GB on a
    // very large active Codex session. The "pendingCalls stays bounded across a
    // large parse" test in integration.test.ts pins this. The record shape is
    // identical to what flushPendingCalls produced; only the emit moment moves
    // earlier, so the stream still lands each call exactly once.
    existing.output_preview = previewResult.preview;
    if (previewResult.binaryReason) {
      existing.output_binary_reason = previewResult.binaryReason;
    }
    if (callId) {
      state.pendingCalls.delete(callId);
    }
    emitRecord("function_calls", { ...existing });
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
      registerFunctionCall(state, payload, ts, deps.emitRecord);
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
export function processRolloutLine({ deps, obj, state }: ProcessRolloutLineArgs): void {
  state.lineCount++;
  if (state.lineCount % PROGRESS_EVERY === 0) {
    deps.progress(`Codex phase=emit pass=emit lines_parsed=${state.lineCount}`);
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
 * Emit any function_call that never saw a matching function_call_output.
 * A function_call payload registers a PendingCall in state.pendingCalls; a
 * matching function_call_output now emits the merged record and removes the
 * entry immediately (see applyFunctionCallOutput), so `pendingCalls` only ever
 * holds calls still awaiting their output. At EOF we drain whatever's left —
 * calls whose output never arrived in this parse window — with a null
 * output_preview, so the function_calls stream lands every call exactly once.
 *
 * Because paired calls drain on their output line, this map is bounded by the
 * number of concurrently-open (unanswered) calls, NOT by the file size — which
 * is what keeps a multi-GB session parse memory-bounded.
 */
export function flushPendingCalls(state: RolloutParseState, deps: LineEmitDeps): void {
  for (const call of state.pendingCalls.values()) {
    deps.emitRecord("function_calls", { ...call });
  }
  state.pendingCalls.clear();
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

interface EmitSessionsFromRowsArgs {
  cursor: CarryForwardCursor<ThreadFingerprint>;
  emitRecord: (stream: string, data: RecordData) => void;
  rolloutAggregates: Map<string, RolloutAggregate>;
  threadsRows: Iterable<ThreadRow>;
}

function emitSessionsFromRows({ threadsRows, rolloutAggregates, emitRecord, cursor }: EmitSessionsFromRowsArgs): void {
  for (const t of threadsRows) {
    const agg = rolloutAggregates.get(t.id);
    rolloutAggregates.delete(t.id);
    const prior = cursor?.prior(t.id);
    if (shouldReemitThreadSession(t, agg, prior)) {
      emitRecord("sessions", buildThreadSessionRecord(t.id, t, agg, prior));
    }
    cursor?.note(t.id, makeThreadFingerprint(t, agg, prior));
  }

  for (const [id, agg] of rolloutAggregates) {
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
  /** Parser-state seed for an append tail (`undefined` for a full parse). */
  seed: RolloutParseSeed | undefined;
  /** Byte offset to start reading from. 0 for a full parse; the prior
   *  committed offset for an append-only tail. */
  startOffset: number;
}

interface ParseRolloutFileResult {
  /** Byte offset just past the last fully-parsed line — the new commit
   *  boundary for this file's cursor. Equals `startOffset` when the suffix
   *  contained no newline-terminated line. */
  committedOffset: number;
  firstTimestamp: string | null;
  functionCallCount: number;
  lastTimestamp: string | null;
  lineCount: number;
  messageCount: number;
  sessionId: string | null;
}

async function parseRolloutFile(args: ParseRolloutFileArgs): Promise<ParseRolloutFileResult> {
  const state = makeRolloutParseState(args.seed);
  const deps: LineEmitDeps = {
    emitRecord: args.emitRecord,
    progress: (message: string): void => {
      emit({ type: "PROGRESS", message });
    },
    requested: args.requested,
  };
  let committedOffset = args.startOffset;
  for await (const { obj, committedOffset: lineEnd } of iterJsonlLinesFromOffset(args.path, args.startOffset)) {
    processRolloutLine({ obj, state, deps, file: args.file });
    committedOffset = lineEnd;
    await waitForEmitDrain();
  }
  flushPendingCalls(state, deps);
  await waitForEmitDrain();
  if (state.sessionId) {
    args.rolloutAggregates.set(state.sessionId, {
      meta: state.sessionMeta || {},
      firstTs: state.firstTimestamp,
      lastTs: state.lastTimestamp,
      // Counts are cumulative: makeRolloutParseState seeded them from the
      // prior cursor on an append, so this is prior + delta, not suffix-only.
      messageCount: state.messageCount,
      functionCallCount: state.functionCallCount,
      rolloutPath: args.path,
    });
  }
  return {
    committedOffset,
    sessionId: state.sessionId,
    lineCount: state.lineCount,
    messageCount: state.messageCount,
    functionCallCount: state.functionCallCount,
    firstTimestamp: state.firstTimestamp,
    lastTimestamp: state.lastTimestamp,
  };
}

// ─── Per-file append-safe decision ──────────────────────────────────────

export type RolloutAction =
  /** size+mtime match the cursor — nothing changed, skip the file. */
  | { kind: "skip" }
  /** No tracked cursor or legacy-mtime-only entry that changed — parse the
   *  whole file from offset 0 and write a fresh cursor. */
  | { kind: "full" }
  /** Cursor present, file grew, prefix guard verified — tail the suffix from
   *  the committed offset, seeding the parser to continue the sequence. */
  | { kind: "append"; startOffset: number; seed: RolloutParseSeed }
  /** Cursor present but file shrank / offset past EOF / prefix guard changed —
   *  truncated or replaced, full reparse from offset 0 to avoid data loss. */
  | { kind: "unsafe_full" };

/**
 * Decide how to process one rollout file given its current stat and the prior
 * per-file cursor (if any). Pure + I/O-free over its inputs: the caller
 * supplies the recomputed prefix-guard hash (or null when the file is too
 * short / unreadable) so this stays unit-testable. `guardMatches` is only
 * consulted on the grow path — a verified prefix is required before tailing.
 */
export function decideRolloutAction(input: {
  cursor: RolloutFileCursor | undefined;
  guardMatches: boolean;
  mtimeMs: number;
  sizeBytes: number;
}): RolloutAction {
  const { cursor, sizeBytes, mtimeMs } = input;
  if (!cursor) {
    return { kind: "full" };
  }
  if (sizeBytes === cursor.size_bytes && mtimeMs === cursor.mtime_ms) {
    return { kind: "skip" };
  }
  // Anything that is not a clean forward-append over a verified prefix is
  // treated as truncation/replacement and reparsed in full — never tailed
  // from a stale offset, never silently skipped.
  if (sizeBytes < cursor.size_bytes || cursor.offset_bytes > sizeBytes || !input.guardMatches) {
    return { kind: "unsafe_full" };
  }
  if (sizeBytes > cursor.size_bytes) {
    return {
      kind: "append",
      startOffset: cursor.offset_bytes,
      seed: {
        sessionId: cursor.session_id,
        lineCount: cursor.line_count,
        messageCount: cursor.message_count,
        functionCallCount: cursor.function_call_count,
        firstTimestamp: cursor.first_ts,
        lastTimestamp: cursor.last_ts,
      },
    };
  }
  // Same size, different mtime, prefix intact: content is byte-identical up to
  // the boundary and the file did not grow. A touch with no new data — skip.
  return { kind: "skip" };
}

interface ScanRolloutsArgs {
  activeQuietMs: number;
  baseDir: string;
  emitRecord: (stream: string, data: RecordData) => void;
  fileCursors: Record<string, RolloutFileCursor>;
  fileMtimes: Record<string, number>;
  newFileCursors: Record<string, RolloutFileCursor>;
  newMtimes: Record<string, number>;
  requested: Map<string, StreamScope>;
  rolloutAggregates: Map<string, RolloutAggregate>;
  scanStartedAtMs: number;
}

interface ScanRolloutsResult {
  parsedFiles: number;
}

/** Carry a file's prior cursor forward verbatim into the next STATE, and keep
 *  the legacy mtime map populated so a downgrade still has a usable cursor. */
function carryFileCursorForward(args: ScanRolloutsArgs, path: string, mtime: number): void {
  const prior = args.fileCursors[path];
  if (prior) {
    args.newFileCursors[path] = prior;
  }
  args.newMtimes[path] = mtime;
}

/**
 * Build (or rebuild) a rich cursor after a parse, hashing the committed prefix.
 *
 * Active-append safety: the file may grow while we parse it (Codex is actively
 * appending to the same long-lived rollout). The cursor MUST record a
 * `size_bytes` consistent with the bytes it actually vouches for, so we set
 * `size_bytes = offset_bytes = committedOffset` — the byte boundary the parse
 * actually reached — NOT the (possibly larger) on-disk size. Recording the live
 * size would let the next run see `size === cursor.size_bytes` for a file that
 * still has an uncommitted tail and SKIP it, losing the tail. With
 * `size_bytes == committedOffset`, any real growth makes the next run observe
 * `sizeBytes > cursor.size_bytes` and tail exactly the uncommitted+new suffix.
 *
 * `mtime_ms` is taken from a POST-parse re-stat (the pre-parse mtime is stale if
 * the file was appended to during the parse). A stale mtime would only cost a
 * spurious guard recomputation next run (which resolves to skip), never data
 * loss — but re-stat keeps the cursor honest. The guard hashes the committed
 * prefix, which is immutable on an append-only file, so it is stable across the
 * mid-parse growth.
 */
async function buildFileCursorAfterParse(path: string, result: ParseRolloutFileResult): Promise<RolloutFileCursor> {
  const guardBytes = Math.min(result.committedOffset, GUARD_PREFIX_BYTES);
  const head = (await hashFilePrefix(path, guardBytes)) ?? "";
  // Re-stat AFTER the parse so mtime reflects any mid-parse append. Fall back to
  // the committed offset for size if the re-stat fails (file vanished): never
  // record a size that disagrees with what we committed.
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  return {
    mtime_ms: mtimeMs,
    // Invariant: size_bytes == offset_bytes. The cursor vouches for exactly the
    // committed prefix; everything past it is re-read on a later run.
    size_bytes: result.committedOffset,
    offset_bytes: result.committedOffset,
    line_count: result.lineCount,
    head_sha256: head,
    guard_bytes: guardBytes,
    session_id: result.sessionId,
    message_count: result.messageCount,
    function_call_count: result.functionCallCount,
    first_ts: result.firstTimestamp,
    last_ts: result.lastTimestamp,
  };
}

/** Resolve the append-safe action for one file: recompute the prefix guard
 *  only when there is a cursor and the file grew (the only path that tails). */
async function resolveRolloutAction(
  path: string,
  st: Stats,
  cursor: RolloutFileCursor | undefined
): Promise<RolloutAction> {
  const sizeBytes = Number(st.size);
  let guardMatches = false;
  if (cursor && sizeBytes > cursor.size_bytes && cursor.offset_bytes <= sizeBytes) {
    const head = await hashFilePrefix(path, cursor.guard_bytes);
    guardMatches = head !== null && head === cursor.head_sha256;
  }
  return decideRolloutAction({ cursor, sizeBytes, mtimeMs: st.mtimeMs, guardMatches });
}

async function processRolloutEntry(
  entry: { path: string; year: string; month: string; day: string; file: string },
  args: ScanRolloutsArgs,
  rolloutOrdinal: number
): Promise<"missing" | "parsed" | "skipped"> {
  let st: Stats;
  try {
    st = statSync(entry.path);
  } catch {
    return "missing";
  }
  const mtime = st.mtimeMs;
  const cursor = args.fileCursors[entry.path];

  // Legacy fast path: no rich cursor yet, but the legacy mtime matches — the
  // previously-emitted records stay valid. Carry the (absent) cursor forward.
  if (!cursor && args.fileMtimes[entry.path] === mtime) {
    args.newMtimes[entry.path] = mtime;
    return "skipped";
  }

  const action = await resolveRolloutAction(entry.path, st, cursor);
  if (action.kind === "skip") {
    carryFileCursorForward(args, entry.path, mtime);
    return "skipped";
  }

  if (shouldDeferActiveRolloutFile({ mtimeMs: mtime, nowMs: args.scanStartedAtMs, quietMs: args.activeQuietMs })) {
    emit({
      type: "PROGRESS",
      message: `Codex phase=index pass=index item=${rolloutOrdinal} backpressure=active_rollout_deferred`,
    });
    await waitForEmitDrain();
    // Defer: the file is being actively written, so it must be reconsidered
    // next run once it goes quiet. Carry a prior RICH cursor forward (preserves
    // its committed offset) but do NOT write a fresh `newMtimes` entry: the
    // legacy fast path skips a file when `!cursor && fileMtimes[path] === mtime`,
    // so stamping the mtime of a deferred-but-unparsed new file would skip it
    // forever (silent data loss). For a file with a prior rich cursor the
    // newMtimes stamp is harmless (the fast path is gated on `!cursor`), but we
    // still avoid stamping it so the deferral is a pure no-op on this run's
    // record emission.
    if (cursor) {
      args.newFileCursors[entry.path] = cursor;
    }
    return "skipped";
  }

  const isAppend = action.kind === "append";
  emit({
    type: "PROGRESS",
    message: `Codex phase=emit pass=emit item=${rolloutOrdinal} mode=${isAppend ? "append" : "full"} file_size_mb=${(st.size / 1024 / 1024).toFixed(1)}`,
  });
  await waitForEmitDrain();

  const result = await parseRolloutFile({
    path: entry.path,
    file: entry.file,
    requested: args.requested,
    emitRecord: args.emitRecord,
    rolloutAggregates: args.rolloutAggregates,
    startOffset: isAppend ? action.startOffset : 0,
    seed: isAppend ? action.seed : undefined,
  });

  args.newFileCursors[entry.path] = await buildFileCursorAfterParse(entry.path, result);
  args.newMtimes[entry.path] = mtime;
  return "parsed";
}

async function scanRollouts(args: ScanRolloutsArgs): Promise<ScanRolloutsResult> {
  const baseExists = (await listIfExists(args.baseDir)) !== null;
  if (!baseExists) {
    emit({
      type: "PROGRESS",
      message: "Codex phase=index pass=index sessions_dir_readable=false",
    });
    await waitForEmitDrain();
    return { parsedFiles: 0 };
  }
  let totalRollouts = 0;
  let parsedRollouts = 0;
  for await (const entry of walkRollouts(args.baseDir)) {
    totalRollouts++;
    if ((await processRolloutEntry(entry, args, totalRollouts)) === "parsed") {
      parsedRollouts++;
    }
  }
  emit({
    type: "PROGRESS",
    message: `Codex phase=index pass=index total_items=${totalRollouts} parsed_items=${parsedRollouts}`,
  });
  await waitForEmitDrain();
  return { parsedFiles: parsedRollouts };
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
  // thread/session id — the same UUID is used by both sources.
  const db = openThreadsDb(stateDbPath);
  if (!db) {
    for (const [id, agg] of rolloutAggregates) {
      emitRecord("sessions", buildRolloutOnlySessionRecord(id, agg));
    }
    return;
  }

  try {
    emitSessionsFromRows({
      threadsRows: queryThreadsRows(db),
      rolloutAggregates,
      emitRecord,
      cursor,
    });
  } finally {
    db.close();
  }
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

function coerceRolloutFileCursor(value: unknown): RolloutFileCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const v = value as Record<string, unknown>;
  const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const offset = num(v.offset_bytes);
  const size = num(v.size_bytes);
  const mtime = num(v.mtime_ms);
  const line = num(v.line_count);
  const guardBytes = num(v.guard_bytes);
  const head = typeof v.head_sha256 === "string" ? v.head_sha256 : null;
  // These six are load-bearing for the tail/skip/unsafe decision. A cursor
  // missing any of them is unusable — drop it so the file full-reparses once
  // (the same one-time cost as the legacy-mtime upgrade) rather than risk a
  // bad offset.
  if (offset === null || size === null || mtime === null || line === null || guardBytes === null || head === null) {
    return null;
  }
  return {
    mtime_ms: mtime,
    size_bytes: size,
    offset_bytes: offset,
    line_count: line,
    head_sha256: head,
    guard_bytes: guardBytes,
    session_id: typeof v.session_id === "string" ? v.session_id : null,
    message_count: num(v.message_count) ?? 0,
    function_call_count: num(v.function_call_count) ?? 0,
    first_ts: typeof v.first_ts === "string" ? v.first_ts : null,
    last_ts: typeof v.last_ts === "string" ? v.last_ts : null,
  };
}

/**
 * Decode the prior per-file rollout cursors from STATE. Tolerant of legacy
 * cursors (no `file_cursors` field), wrong types, and partially-corrupt
 * entries — a malformed entry is dropped (its file then full-reparses once)
 * rather than failing the run. Checks the rollout streams plus the sessions
 * stream so the lookup survives whichever stream carried the cursor.
 */
export function readPriorFileCursors(startMsg: StartMessage): Record<string, RolloutFileCursor> {
  const state = startMsg.state || {};
  const raw =
    state.messages?.file_cursors || state.function_calls?.file_cursors || state.sessions?.file_cursors || null;
  const out: Record<string, RolloutFileCursor> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return out;
  }
  for (const [path, value] of Object.entries(raw)) {
    const cursor = coerceRolloutFileCursor(value);
    if (cursor) {
      out[path] = cursor;
    }
  }
  return out;
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
  newFileCursors: Record<string, RolloutFileCursor>;
  newMtimes: Record<string, number>;
  nowIso: () => string;
  requested: Map<string, StreamScope>;
  sessionsSourceMtimeMs: number;
  threadFingerprints: CarryForwardCursor<ThreadFingerprint>;
}

function emitStateCursors({
  requested,
  newFileCursors,
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
      // file_cursors is the append-safe per-file cursor; file_mtimes is kept
      // alongside it for backward compatibility with a downgraded collector
      // (and the legacy fast-path skip on files this connector hasn't yet
      // upgraded to a rich cursor).
      cursor: { file_mtimes: newMtimes, file_cursors: newFileCursors, fetched_at: nowIso() },
    });
  }
  for (const s of ["rules", "prompts", "skills"]) {
    if (requested.has(s)) {
      emit({ type: "STATE", stream: s, cursor: { fetched_at: nowIso() } });
    }
  }
  // Inventory streams (history, session_index, logs, shell_snapshots,
  // config_inventory, cache_inventory) own their STATE inside the fingerprint
  // gate (emitLocalInventoryStreams) and must NOT get a bare clobbering STATE
  // here. coverage_diagnostics is emitted after all collection output drains,
  // immediately before terminal success, so it cannot certify a partial scan.
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

/**
 * Emit the per-store `coverage_diagnostics` rows from a pre-built
 * inventory. Kept separate from inventory-record emission so the durable
 * coverage signal can be flushed BEFORE {@link assertRequestedCodexSources}
 * runs: a missing requested content source must still surface honest
 * `missing` coverage rows rather than abort the run with zero coverage
 * evidence. The connection-health rollup derives a local collector's
 * coverage axis from these records, and an omitted coverage stream
 * collapses to `coverage_unknown` forever (the local run path writes no
 * spine run). The inventory walk reads only path metadata, never payload,
 * so it is safe on a partial/empty home. No-op when `coverage_diagnostics`
 * was not requested.
 */
async function emitCoverageDiagnostics(input: {
  emitRecord: (stream: string, data: RecordData) => void;
  inventory: Awaited<ReturnType<typeof buildLocalSourceInventory>>;
  requested: Map<string, StreamScope>;
}): Promise<void> {
  if (!input.requested.has("coverage_diagnostics")) {
    return;
  }
  for (const record of input.inventory.coverage) {
    input.emitRecord("coverage_diagnostics", record);
    await waitForEmitDrain();
  }
}

/** Emit one inventory stream's records under a fingerprint gate that excludes
 *  incidental `mtime_epoch`/`size_bytes`, then write a per-stream STATE cursor
 *  carrying the fingerprints forward. Inventory enumeration is a full scan, so
 *  stale ids are pruned: a store that disappears drops out and re-appears as a
 *  fresh emit. */
async function emitGatedInventoryStream(input: {
  emitRecord: (stream: string, data: RecordData) => void;
  nowIso: () => string;
  priorState: unknown;
  records: readonly RecordData[];
  stream: string;
}): Promise<void> {
  const cursor = openInventoryFingerprintCursor(input.priorState);
  for (const record of input.records) {
    if (cursor.shouldEmit(record)) {
      input.emitRecord(input.stream, record);
      await waitForEmitDrain();
    }
  }
  cursor.pruneStale();
  const inventoryCursor: Record<string, unknown> = { fetched_at: input.nowIso() };
  if (cursor.size() > 0) {
    inventoryCursor.fingerprints = cursor.toState();
  }
  emit({ type: "STATE", stream: input.stream, cursor: inventoryCursor });
  await waitForEmitDrain();
}

/** Inventory streams whose STATE cursor is owned by the fingerprint gate.
 *  These are the Codex `inventory_only`/`defer` stores plus the directory-
 *  listed `shell_snapshots`. `emitStateCursors` must NOT also write a bare
 *  `{ fetched_at }` STATE for these — that trailing write would clobber the
 *  fingerprint map and re-open the per-run churn the gate exists to close. */
export const CODEX_GATED_INVENTORY_STREAMS = [
  "history",
  "session_index",
  "shell_snapshots",
  "config_inventory",
  "cache_inventory",
  "logs",
] as const;

async function emitLocalInventoryStreams(input: {
  codexHome: string;
  emitRecord: (stream: string, data: RecordData) => void;
  inventory: Awaited<ReturnType<typeof buildLocalSourceInventory>>;
  nowIso: () => string;
  requested: Map<string, StreamScope>;
  state: Record<string, unknown>;
}): Promise<void> {
  // `shell_snapshots` is enumerated via a directory listing rather than the
  // pre-built store inventory; everything else comes from `recordsByStream`
  // (empty for an absent store, which still produces a carry-forward STATE).
  for (const stream of CODEX_GATED_INVENTORY_STREAMS) {
    if (!input.requested.has(stream)) {
      continue;
    }
    const records =
      stream === "shell_snapshots"
        ? await listDirectoryInventory({
            tool: "codex",
            sourceHome: input.codexHome,
            relativeRoot: "shell-snapshots",
            store: "shell_snapshots",
            stream: "shell_snapshots",
            reason: "shell content requires redaction review before payload collection",
          })
        : (input.inventory.recordsByStream.get(stream) ?? []);
    await emitGatedInventoryStream({
      emitRecord: input.emitRecord,
      nowIso: input.nowIso,
      priorState: input.state[stream],
      records,
      stream,
    });
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
  const fileMtimes = readFileMtimes(startMsg);
  const fileCursors = readPriorFileCursors(startMsg);

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
  // Seed the next rich-cursor map from the prior one; processRolloutEntry
  // overwrites a file's entry when it parses/tails it and otherwise carries
  // the prior cursor forward unchanged (so unscanned/deferred files keep
  // their offset). Deleted files naturally drop out — they are never walked.
  const newFileCursors: Record<string, RolloutFileCursor> = {};
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

  // Build the source inventory and flush durable coverage diagnostics BEFORE
  // asserting requested content sources exist. A missing content store should
  // surface an honest `missing` coverage row, not abort the run with zero
  // coverage evidence — see emitCoverageDiagnostics. The inventory walk reads
  // only path metadata, never payload, so it is safe on a partial/empty home.
  const inventory = await buildLocalSourceInventory("codex", dirs.codexHome, CODEX_KNOWN_LOCAL_STORES);
  await emitCoverageDiagnostics({ emitRecord, inventory, requested });
  await assertRequestedCodexSources(dirs, requested);

  await emitLocalInventoryStreams({
    codexHome: dirs.codexHome,
    emitRecord,
    inventory,
    nowIso,
    requested,
    state: startMsg.state || {},
  });

  if (needRollouts) {
    const rolloutScan = await scanRollouts({
      activeQuietMs: resolveActiveRolloutQuietMs(),
      baseDir: dirs.baseDir,
      fileCursors,
      fileMtimes,
      newFileCursors,
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

  emitStateCursors({ requested, newFileCursors, newMtimes, nowIso, sessionsSourceMtimeMs, threadFingerprints });
  await waitForEmitDrain();

  if (requested.has("coverage_diagnostics")) {
    emit({
      type: "STATE",
      stream: "coverage_diagnostics",
      cursor: { fetched_at: nowIso(), stores: buildCoverageDiagnosticsStateSnapshot(inventory.coverage) },
    });
    await waitForEmitDrain();
  }

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
