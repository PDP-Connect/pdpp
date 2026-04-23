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
 *                     one record per rule line.
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
// biome-ignore lint/correctness/noUnresolvedImports: node:sqlite is a Node 22.5+ built-in module; Biome's resolver doesn't see built-ins
import { DatabaseSync } from "node:sqlite";
import type { EmittedMessage, RecordData, StreamScope } from "../../src/connector-runtime.ts";
import { stringifyForJsonl } from "../../src/safe-emit.ts";
import { resourceSet } from "../../src/scope-filters.ts";
import {
  emitSessionsFromMaps,
  flushPendingCalls,
  type LineEmitDeps,
  makeRolloutParseState,
  processRolloutLine,
} from "./collect-helpers.ts";
import {
  buildPromptRecord,
  buildRuleRecord,
  buildSkillRecord,
  isRolloutFile,
  isSkippableRulesLine,
  parseFrontmatter,
  RULES_SUFFIX_RE,
  splitRulesLines,
  TWO_DIGIT_DIR_RE,
  YEAR_DIR_RE,
} from "./parsers.ts";
import type { RolloutAggregate, RolloutObject, StartMessage, ThreadRow } from "./types.ts";

const rl = createInterface({ input: process.stdin, terminal: false });
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

// ─── Rollout-file line processing ───────────────────────────────────────
// Per-line / per-payload dispatchers + end-of-file flush now live in
// collect-helpers.ts so integration tests can exercise them without touching
// the filesystem. This wrapper still owns the JSONL iterator + the post-file
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
  // merge + dedup lives in collect-helpers.ts so integration tests can pin
  // it without touching sqlite.
  const { map: threadsById } = loadThreadsMap(stateDbPath);
  emitSessionsFromMaps({ threadsMap: threadsById, rolloutAggregates, emitRecord });
}

// ─── Start-message + state-cursor helpers ───────────────────────────────

async function readStartMessage(): Promise<StartMessage> {
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
  promptsDir: string;
  rulesDir: string;
  skillsDir: string;
  stateDbPath: string;
}

function resolveCodexDirs(): CodexDirs {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  return {
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
