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

import {
  createReadStream,
  type Dirent,
  existsSync,
  type Stats,
  statSync,
} from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createInterface as createFileReader,
  createInterface,
} from "node:readline";
// biome-ignore lint/correctness/noUnresolvedImports: node:sqlite is a Node 22.5+ built-in module; Biome's resolver doesn't see built-ins
import { DatabaseSync } from "node:sqlite";
import type {
  EmittedMessage,
  RecordData,
  StreamScope,
} from "../../src/connector-runtime.ts";
import { stringifyForJsonl } from "../../src/safe-emit.ts";
import { resourceSet } from "../../src/scope-filters.ts";

interface StartMessage {
  scope?: { streams?: readonly StreamScope[] };
  state?: {
    messages?: { file_mtimes?: Record<string, number> };
    function_calls?: { file_mtimes?: Record<string, number> };
    sessions?: { file_mtimes?: Record<string, number> };
    file_mtimes?: Record<string, number>;
  };
  type: string;
}

interface RolloutObject {
  payload?: RolloutPayload;
  timestamp?: string;
  type?: string;
}

interface RolloutPayload {
  arguments?: string | null;
  call_id?: string;
  cli_version?: string;
  content?: Array<{ text?: string }>;
  cwd?: string;
  git?: {
    commit_hash?: string;
    branch?: string;
    repository_url?: string;
  };
  id?: string;
  model_provider?: string;
  name?: string;
  originator?: string;
  output?: string | object;
  role?: string;
  timestamp?: string;
  type?: string;
}

interface ThreadRow {
  agent_nickname: string | null;
  agent_role: string | null;
  approval_mode: string | null;
  archived: number | boolean | null;
  archived_at: number | null;
  cli_version: string | null;
  created_at: number | null;
  cwd: string | null;
  first_user_message: string | null;
  git_branch: string | null;
  git_origin_url: string | null;
  git_sha: string | null;
  has_user_event: number | null;
  id: string;
  memory_mode: string | null;
  model: string | null;
  model_provider: string | null;
  reasoning_effort: string | null;
  rollout_path: string | null;
  sandbox_policy: string | null;
  source: string | null;
  title: string | null;
  tokens_used: number | null;
  updated_at: number | null;
}

interface RolloutAggregate {
  firstTs: string | null;
  functionCallCount: number;
  lastTs: string | null;
  messageCount: number;
  meta: RolloutPayload;
  rolloutPath: string;
}

interface PendingCall {
  arguments: string | null;
  call_id: string;
  id: string;
  name: string | null;
  output_preview: string | null;
  session_id: string;
  timestamp: string | null;
}

const rl = createInterface({ input: process.stdin, terminal: false });
const emit = (m: EmittedMessage): boolean =>
  process.stdout.write(stringifyForJsonl(m));
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

function textPreview(s: unknown, max = 5000): string | null {
  if (typeof s !== "string") {
    return null;
  }
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function extractMessageText(payload: RolloutPayload): string | null {
  if (!(payload?.content && Array.isArray(payload.content))) {
    return null;
  }
  const parts = payload.content.map((p) => p?.text).filter(Boolean);
  return parts.join("\n") || null;
}

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

// Recursively walk the yyyy/mm/dd hierarchy and yield rollout-*.jsonl paths.
async function* walkRollouts(baseDir: string): AsyncGenerator<{
  path: string;
  year: string;
  month: string;
  day: string;
  file: string;
}> {
  let years: string[];
  try {
    years = await readdir(baseDir);
  } catch {
    return;
  }
  for (const y of years) {
    if (!YEAR_DIR_RE.test(y)) {
      continue;
    }
    const yPath = join(baseDir, y);
    let months: string[];
    try {
      months = await readdir(yPath);
    } catch {
      continue;
    }
    for (const m of months) {
      if (!TWO_DIGIT_DIR_RE.test(m)) {
        continue;
      }
      const mPath = join(yPath, m);
      let days: string[];
      try {
        days = await readdir(mPath);
      } catch {
        continue;
      }
      for (const d of days) {
        if (!TWO_DIGIT_DIR_RE.test(d)) {
          continue;
        }
        const dPath = join(mPath, d);
        let files: string[];
        try {
          files = await readdir(dPath);
        } catch {
          continue;
        }
        for (const f of files) {
          if (f.startsWith("rollout-") && f.endsWith(".jsonl")) {
            yield {
              path: join(dPath, f),
              year: y,
              month: m,
              day: d,
              file: f,
            };
          }
        }
      }
    }
  }
}

function epochToIso(sec: number | null | undefined): string | null {
  return Number.isFinite(sec) && typeof sec === "number" && sec > 0
    ? new Date(sec * 1000).toISOString()
    : null;
}

// ---- state_5.sqlite reader ----------------------------------------------

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
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit({
      type: "PROGRESS",
      message: `state_5.sqlite unreadable (${msg}); falling back to rollouts only`,
    });
    return { map: new Map(), present: false };
  }
  const map = new Map<string, ThreadRow>();
  try {
    const rawRows: unknown = db
      .prepare(`
      SELECT id, rollout_path, created_at, updated_at, source, model_provider,
             cwd, title, sandbox_policy, approval_mode, tokens_used,
             has_user_event, archived, archived_at, git_sha, git_branch,
             git_origin_url, cli_version, first_user_message, agent_nickname,
             agent_role, memory_mode, model, reasoning_effort
      FROM threads
    `)
      .all();
    const rows = rawRows as ThreadRow[];
    for (const r of rows) {
      map.set(r.id, r);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit({
      type: "PROGRESS",
      message: `threads query failed (${msg}); falling back to rollouts only`,
    });
  } finally {
    try {
      db.close();
    } catch {
      /* noop */
    }
  }
  return { map, present: true };
}

// ---- file-based stream helpers ------------------------------------------

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/;
const YEAR_DIR_RE = /^\d{4}$/;
const TWO_DIGIT_DIR_RE = /^\d{2}$/;
const LINE_SPLIT_RE = /\r?\n/;
const FRONTMATTER_KV_RE = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/;
const RULES_SUFFIX_RE = /\.rules$/;
const MD_SUFFIX_RE = /\.md$/;

function parseFrontmatter(text: string): {
  meta: Record<string, string>;
  body: string;
} {
  const m = text.match(FRONTMATTER_RE);
  if (!m) {
    return { meta: {}, body: text };
  }
  const meta: Record<string, string> = {};
  for (const line of (m[1] ?? "").split(LINE_SPLIT_RE)) {
    const kv = line.match(FRONTMATTER_KV_RE);
    if (!kv) {
      continue;
    }
    let val = (kv[2] ?? "").trim();
    // Strip surrounding quotes if present.
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    const key = kv[1];
    if (key) {
      meta[key] = val;
    }
  }
  return { meta, body: m[2] ?? "" };
}

async function emitRulesStream(
  rulesDir: string,
  emitRecord: (stream: string, data: RecordData) => void
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(rulesDir);
  } catch {
    return;
  }
  for (const f of entries) {
    if (!f.endsWith(".rules")) {
      continue;
    }
    const p = join(rulesDir, f);
    let st: Awaited<ReturnType<typeof stat>>;
    let text: string;
    try {
      st = await stat(p);
      text = await readFile(p, "utf8");
    } catch {
      continue;
    }
    const mtime = Math.floor(st.mtimeMs / 1000);
    const ruleset = f.replace(RULES_SUFFIX_RE, "");
    const lines = text.split(LINE_SPLIT_RE);
    let idx = 0;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }
      const id = `rules:${ruleset}:${idx}`;
      emitRecord("rules", {
        id,
        ruleset,
        rule_text: textPreview(line, 4000),
        rule_index: idx,
        path: p,
        mtime_epoch: mtime,
      });
      idx++;
    }
  }
}

async function emitPromptsStream(
  promptsDir: string,
  emitRecord: (stream: string, data: RecordData) => void
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(promptsDir);
  } catch {
    return;
  }
  for (const f of entries) {
    if (!f.endsWith(".md")) {
      continue;
    }
    const p = join(promptsDir, f);
    let st: Awaited<ReturnType<typeof stat>>;
    let text: string;
    try {
      st = await stat(p);
      text = await readFile(p, "utf8");
    } catch {
      continue;
    }
    const { meta, body } = parseFrontmatter(text);
    const name = meta.name || f.replace(MD_SUFFIX_RE, "");
    emitRecord("prompts", {
      id: `prompts:${f}`,
      name,
      description: meta.description || null,
      content: textPreview(body, 20_000),
      path: p,
      mtime_epoch: Math.floor(st.mtimeMs / 1000),
    });
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
    if (ent.name.startsWith(".")) {
      continue;
    }
    if (ent.name === "skills.backup") {
      continue;
    }
    // Resolve symlinks — if it's a dir (or symlink to one), look for SKILL.md.
    const dirPath = join(skillsDir, ent.name);
    let dirStat: Awaited<ReturnType<typeof stat>>;
    try {
      dirStat = await stat(dirPath);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) {
      continue;
    }
    const skillMdPath = join(dirPath, "SKILL.md");
    let fileStat: Awaited<ReturnType<typeof stat>>;
    let text: string;
    try {
      fileStat = await stat(skillMdPath);
      text = await readFile(skillMdPath, "utf8");
    } catch {
      continue;
    }
    const { meta, body } = parseFrontmatter(text);
    const name = meta.name || ent.name;
    emitRecord("skills", {
      id: `skills:${ent.name}`,
      name,
      description: meta.description || null,
      content: textPreview(body, 20_000),
      path: skillMdPath,
      mtime_epoch: Math.floor(fileStat.mtimeMs / 1000),
    });
  }
}

// ---- main ---------------------------------------------------------------

async function main(): Promise<void> {
  const startMsg = await new Promise<StartMessage>((r, j) =>
    rl.once("line", (l) => {
      try {
        r(JSON.parse(l) as StartMessage);
      } catch (e) {
        j(e);
      }
    })
  );
  if (startMsg.type !== "START") {
    return fail("Expected START");
  }

  const requested = new Map<string, StreamScope>(
    (startMsg.scope?.streams || []).map((s) => [s.name, s])
  );
  if (!requested.size) {
    return fail("START.scope.streams is required");
  }

  const resFilters = new Map<string, ReadonlySet<string> | null>();
  for (const [n, r] of requested) {
    resFilters.set(n, resourceSet(r));
  }

  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const baseDir = process.env.CODEX_SESSIONS_DIR || join(codexHome, "sessions");
  const stateDbPath =
    process.env.CODEX_STATE_DB || join(codexHome, "state_5.sqlite");
  const rulesDir = process.env.CODEX_RULES_DIR || join(codexHome, "rules");
  const promptsDir =
    process.env.CODEX_PROMPTS_DIR || join(codexHome, "prompts");
  const skillsDir = process.env.CODEX_SKILLS_DIR || join(codexHome, "skills");

  const state = startMsg.state || {};
  // STATE is stream-keyed per Collection Profile: `state` is
  // { <stream>: <cursor>, ... }. This connector emits STATE with a
  // stream name (see cursorStream below), cursor={file_mtimes:{...}}.
  // Check all streams that might carry file_mtimes plus legacy top-level.
  const fileMtimes: Record<string, number> =
    state.messages?.file_mtimes ||
    state.function_calls?.file_mtimes ||
    state.sessions?.file_mtimes ||
    state.file_mtimes ||
    {};

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

  const needRollouts =
    requested.has("sessions") ||
    requested.has("messages") ||
    requested.has("function_calls");

  // Rollout aggregates per session (so `sessions` can carry message_count /
  // function_call_count even when state_5 provides the canonical metadata).
  const rolloutAggregates = new Map<string, RolloutAggregate>();

  const newMtimes: Record<string, number> = { ...fileMtimes };

  if (needRollouts) {
    let baseExists = true;
    try {
      await readdir(baseDir);
    } catch (err) {
      baseExists = false;
      const msg = err instanceof Error ? err.message : String(err);
      emit({
        type: "PROGRESS",
        message: `${baseDir} not readable: ${msg}`,
      });
    }

    if (baseExists) {
      let fileCount = 0;
      for await (const { path: p, year, month, day, file } of walkRollouts(
        baseDir
      )) {
        fileCount++;
        let st: Stats;
        try {
          st = statSync(p);
        } catch {
          continue;
        }
        const mtime = st.mtimeMs;
        if (fileMtimes[p] === mtime) {
          newMtimes[p] = mtime;
          // We still need session aggregates for the `sessions` stream on
          // unchanged files, but only if the session was previously emitted.
          // To keep things simple, skip the whole file when unchanged — the
          // `sessions` emission will upsert against state_5 anyway and the
          // previously-emitted rollout-derived record stays valid.
          continue;
        }

        emit({
          type: "PROGRESS",
          message: `Parsing ${year}/${month}/${day}/${file} (${(st.size / 1024 / 1024).toFixed(1)}MB)`,
        });

        let sessionId: string | null = null;
        let sessionMeta: RolloutPayload | null = null;
        let firstTimestamp: string | null = null;
        let lastTimestamp: string | null = null;
        let messageCount = 0;
        let functionCallCount = 0;
        const pendingCalls = new Map<string, PendingCall>();
        let lineCount = 0;

        for await (const obj of iterJsonlLines(p)) {
          lineCount++;
          if (lineCount % 2000 === 0) {
            emit({
              type: "PROGRESS",
              message: `  ${file}: ${lineCount} lines parsed`,
            });
          }

          const ts = obj.timestamp || null;
          if (ts) {
            if (!firstTimestamp || ts < firstTimestamp) {
              firstTimestamp = ts;
            }
            if (!lastTimestamp || ts > lastTimestamp) {
              lastTimestamp = ts;
            }
          }

          if (obj.type === "session_meta") {
            sessionMeta = obj.payload || {};
            sessionId = sessionMeta.id || null;
            continue;
          }

          if (!sessionId) {
            continue;
          }
          if (obj.type !== "response_item") {
            continue;
          }
          const payload: RolloutPayload = obj.payload || {};

          if (payload.type === "message") {
            messageCount++;
            if (requested.has("messages")) {
              const role = payload.role || null;
              const content = extractMessageText(payload);
              const id = `${sessionId}:${lineCount}`;
              emitRecord("messages", {
                id,
                session_id: sessionId,
                role,
                type: "message",
                content: textPreview(content, 5000),
                timestamp: ts,
              });
            }
          } else if (payload.type === "function_call") {
            functionCallCount++;
            if (requested.has("function_calls")) {
              const callId = payload.call_id || `${sessionId}:${lineCount}`;
              pendingCalls.set(callId, {
                id: callId,
                session_id: sessionId,
                call_id: callId,
                name: payload.name || null,
                arguments: textPreview(payload.arguments || null, 2000),
                output_preview: null,
                timestamp: ts,
              });
            }
          } else if (
            payload.type === "function_call_output" &&
            requested.has("function_calls")
          ) {
            const callId = payload.call_id;
            const existing = callId ? pendingCalls.get(callId) : null;
            if (existing) {
              existing.output_preview = textPreview(
                typeof payload.output === "string"
                  ? payload.output
                  : JSON.stringify(payload.output),
                2000
              );
            } else {
              const id = `${sessionId}:${lineCount}:output`;
              emitRecord("function_calls", {
                id,
                session_id: sessionId,
                call_id: callId || null,
                name: null,
                arguments: null,
                output_preview: textPreview(
                  typeof payload.output === "string"
                    ? payload.output
                    : JSON.stringify(payload.output),
                  2000
                ),
                timestamp: ts,
              });
            }
          }
          // reasoning is skipped — encrypted_content is opaque.
        }

        // Flush paired function_calls at end of file.
        for (const call of pendingCalls.values()) {
          emitRecord("function_calls", { ...call });
        }

        if (sessionId) {
          rolloutAggregates.set(sessionId, {
            meta: sessionMeta || {},
            firstTs: firstTimestamp,
            lastTs: lastTimestamp,
            messageCount,
            functionCallCount,
            rolloutPath: p,
          });
        }
        newMtimes[p] = mtime;
      }
      emit({
        type: "PROGRESS",
        message: `Scanned ${fileCount} rollout files`,
      });
    }
  }

  // Sessions: prefer state_5.sqlite#threads; fall back to rollout-derived
  // fields only when state_5 doesn't have the session. Session PK stays the
  // thread/session id — the same UUID is used by both sources.
  if (requested.has("sessions")) {
    const { map: threadsById } = loadThreadsMap(stateDbPath);
    const emittedSessionIds = new Set<string>();

    for (const [id, t] of threadsById) {
      const agg = rolloutAggregates.get(id);
      emitRecord("sessions", {
        id,
        cwd: t.cwd || null,
        originator: t.source || null,
        cli_version: t.cli_version || null,
        model_provider: t.model_provider || null,
        git_commit: t.git_sha || null,
        git_branch: t.git_branch || null,
        repository_url: t.git_origin_url || null,
        started_at:
          epochToIso(t.created_at) ||
          agg?.meta?.timestamp ||
          agg?.firstTs ||
          null,
        last_event_at: epochToIso(t.updated_at) || agg?.lastTs || null,
        message_count: agg?.messageCount ?? null,
        function_call_count: agg?.functionCallCount ?? null,
        // Codex can stuff large assistant output into `title` and
        // `first_user_message`; cap to keep records reasonable.
        title: textPreview(t.title || null, 500),
        archived: t.archived === 1 || t.archived === true,
        tokens_used: t.tokens_used ?? null,
        first_user_message: textPreview(t.first_user_message || null, 2000),
        sandbox_policy: t.sandbox_policy || null,
        approval_mode: t.approval_mode || null,
        rollout_path: t.rollout_path || agg?.rolloutPath || null,
      });
      emittedSessionIds.add(id);
    }

    // Rollouts present on disk but not in state_5 — emit with nulls for
    // state_5-only fields so schema stays consistent.
    for (const [id, agg] of rolloutAggregates) {
      if (emittedSessionIds.has(id)) {
        continue;
      }
      const meta = agg.meta || {};
      emitRecord("sessions", {
        id,
        cwd: meta.cwd || null,
        originator: meta.originator || null,
        cli_version: meta.cli_version || null,
        model_provider: meta.model_provider || null,
        git_commit: meta.git?.commit_hash || null,
        git_branch: meta.git?.branch || null,
        repository_url: meta.git?.repository_url || null,
        started_at: meta.timestamp || agg.firstTs,
        last_event_at: agg.lastTs,
        message_count: agg.messageCount,
        function_call_count: agg.functionCallCount,
        title: null,
        archived: null,
        tokens_used: null,
        first_user_message: null,
        sandbox_policy: null,
        approval_mode: null,
        rollout_path: agg.rolloutPath || null,
      });
    }
  }

  if (requested.has("rules")) {
    await emitRulesStream(rulesDir, emitRecord);
  }
  if (requested.has("prompts")) {
    await emitPromptsStream(promptsDir, emitRecord);
  }
  if (requested.has("skills")) {
    await emitSkillsStream(skillsDir, emitRecord);
  }

  // State cursors
  if (requested.has("sessions")) {
    emit({
      type: "STATE",
      stream: "sessions",
      cursor: { fetched_at: nowIso() },
    });
  }
  if (requested.has("messages") || requested.has("function_calls")) {
    const cursorStream = requested.has("messages")
      ? "messages"
      : "function_calls";
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
