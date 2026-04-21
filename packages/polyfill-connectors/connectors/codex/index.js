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

import { createInterface } from 'node:readline';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createInterface as createFileReader } from 'node:readline';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resourceSet } from '../../src/scope-filters.js';
import { stringifyForJsonl } from '../../src/safe-emit.js';

const rl = createInterface({ input: process.stdin, terminal: false });
const emit = (m) => process.stdout.write(stringifyForJsonl(m));
const flushAndExit = (code) => {
  if (process.stdout.writableLength > 0) {
    process.stdout.once('drain', () => process.exit(code));
    setTimeout(() => process.exit(code), 3000).unref();
  } else process.exit(code);
};
const fail = (m, r = false) => { emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: m, retryable: r } }); flushAndExit(1); };

function textPreview(s, max = 5000) {
  if (typeof s !== 'string') return null;
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function extractMessageText(payload) {
  if (!payload?.content || !Array.isArray(payload.content)) return null;
  const parts = payload.content.map((p) => p?.text).filter(Boolean);
  return parts.join('\n') || null;
}

async function* iterJsonlLines(path) {
  const r = createFileReader({ input: createReadStream(path, { encoding: 'utf8' }), terminal: false });
  for await (const line of r) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* skip malformed */ }
  }
}

// Recursively walk the yyyy/mm/dd hierarchy and yield rollout-*.jsonl paths.
async function* walkRollouts(baseDir) {
  let years;
  try { years = await readdir(baseDir); } catch { return; }
  for (const y of years) {
    if (!/^\d{4}$/.test(y)) continue;
    const yPath = join(baseDir, y);
    let months;
    try { months = await readdir(yPath); } catch { continue; }
    for (const m of months) {
      if (!/^\d{2}$/.test(m)) continue;
      const mPath = join(yPath, m);
      let days;
      try { days = await readdir(mPath); } catch { continue; }
      for (const d of days) {
        if (!/^\d{2}$/.test(d)) continue;
        const dPath = join(mPath, d);
        let files;
        try { files = await readdir(dPath); } catch { continue; }
        for (const f of files) {
          if (f.startsWith('rollout-') && f.endsWith('.jsonl')) {
            yield { path: join(dPath, f), year: y, month: m, day: d, file: f };
          }
        }
      }
    }
  }
}

function epochToIso(sec) {
  return Number.isFinite(sec) && sec > 0 ? new Date(sec * 1000).toISOString() : null;
}

// ---- state_5.sqlite reader ----------------------------------------------

/**
 * Load `threads` rows keyed by id. Opens the DB read-only to be safe against
 * live Codex writes. Returns a Map of id → thread record (raw, unmapped).
 */
function loadThreadsMap(dbPath) {
  if (!existsSync(dbPath)) return { map: new Map(), present: false };
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    emit({ type: 'PROGRESS', message: `state_5.sqlite unreadable (${err.message}); falling back to rollouts only` });
    return { map: new Map(), present: false };
  }
  const map = new Map();
  try {
    const rows = db.prepare(`
      SELECT id, rollout_path, created_at, updated_at, source, model_provider,
             cwd, title, sandbox_policy, approval_mode, tokens_used,
             has_user_event, archived, archived_at, git_sha, git_branch,
             git_origin_url, cli_version, first_user_message, agent_nickname,
             agent_role, memory_mode, model, reasoning_effort
      FROM threads
    `).all();
    for (const r of rows) map.set(r.id, r);
  } catch (err) {
    emit({ type: 'PROGRESS', message: `threads query failed (${err.message}); falling back to rollouts only` });
  } finally {
    try { db.close(); } catch {}
  }
  return { map, present: true };
}

// ---- file-based stream helpers ------------------------------------------

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/;

function parseFrontmatter(text) {
  const m = text.match(FRONTMATTER_RE);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    let val = kv[2].trim();
    // Strip surrounding quotes if present.
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    meta[kv[1]] = val;
  }
  return { meta, body: m[2] };
}

async function emitRulesStream(rulesDir, emitRecord) {
  let entries;
  try { entries = await readdir(rulesDir); } catch { return; }
  for (const f of entries) {
    if (!f.endsWith('.rules')) continue;
    const p = join(rulesDir, f);
    let st, text;
    try { st = await stat(p); text = await readFile(p, 'utf8'); } catch { continue; }
    const mtime = Math.floor(st.mtimeMs / 1000);
    const ruleset = f.replace(/\.rules$/, '');
    const lines = text.split(/\r?\n/);
    let idx = 0;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const id = `rules:${ruleset}:${idx}`;
      emitRecord('rules', {
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

async function emitPromptsStream(promptsDir, emitRecord) {
  let entries;
  try { entries = await readdir(promptsDir); } catch { return; }
  for (const f of entries) {
    if (!f.endsWith('.md')) continue;
    const p = join(promptsDir, f);
    let st, text;
    try { st = await stat(p); text = await readFile(p, 'utf8'); } catch { continue; }
    const { meta, body } = parseFrontmatter(text);
    const name = meta.name || f.replace(/\.md$/, '');
    emitRecord('prompts', {
      id: `prompts:${f}`,
      name,
      description: meta.description || null,
      content: textPreview(body, 20000),
      path: p,
      mtime_epoch: Math.floor(st.mtimeMs / 1000),
    });
  }
}

async function emitSkillsStream(skillsDir, emitRecord) {
  // Each skill is a subdirectory with SKILL.md at its root. Follows symlinks
  // (skills are often symlinked from dotfiles). Skips hidden dirs (.system).
  let entries;
  try { entries = await readdir(skillsDir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    if (ent.name === 'skills.backup') continue;
    // Resolve symlinks — if it's a dir (or symlink to one), look for SKILL.md.
    const dirPath = join(skillsDir, ent.name);
    let dirStat;
    try { dirStat = await stat(dirPath); } catch { continue; }
    if (!dirStat.isDirectory()) continue;
    const skillMdPath = join(dirPath, 'SKILL.md');
    let fileStat, text;
    try { fileStat = await stat(skillMdPath); text = await readFile(skillMdPath, 'utf8'); } catch { continue; }
    const { meta, body } = parseFrontmatter(text);
    const name = meta.name || ent.name;
    emitRecord('skills', {
      id: `skills:${ent.name}`,
      name,
      description: meta.description || null,
      content: textPreview(body, 20000),
      path: skillMdPath,
      mtime_epoch: Math.floor(fileStat.mtimeMs / 1000),
    });
  }
}

// ---- main ---------------------------------------------------------------

async function main() {
  const startMsg = await new Promise((r, j) => rl.once('line', (l) => { try { r(JSON.parse(l)); } catch (e) { j(e); } }));
  if (startMsg.type !== 'START') return fail('Expected START');

  const requested = new Map((startMsg.scope?.streams || []).map((s) => [s.name, s]));
  if (!requested.size) return fail('START.scope.streams is required');

  const resFilters = new Map();
  for (const [n, r] of requested) resFilters.set(n, resourceSet(r));

  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  const baseDir = process.env.CODEX_SESSIONS_DIR || join(codexHome, 'sessions');
  const stateDbPath = process.env.CODEX_STATE_DB || join(codexHome, 'state_5.sqlite');
  const rulesDir = process.env.CODEX_RULES_DIR || join(codexHome, 'rules');
  const promptsDir = process.env.CODEX_PROMPTS_DIR || join(codexHome, 'prompts');
  const skillsDir = process.env.CODEX_SKILLS_DIR || join(codexHome, 'skills');

  const state = startMsg.state || {};
  // STATE is stream-keyed per Collection Profile: `state` is
  // { <stream>: <cursor>, ... }. This connector emits STATE with a
  // stream name (see cursorStream below), cursor={file_mtimes:{...}}.
  // Check all streams that might carry file_mtimes plus legacy top-level.
  const fileMtimes =
    state.messages?.file_mtimes
    || state.function_calls?.file_mtimes
    || state.sessions?.file_mtimes
    || state.file_mtimes
    || {};

  let total = 0;
  const nowIso = () => new Date().toISOString();
  const emittedAt = nowIso();
  const emitRecord = (s, d) => {
    if (d.id == null) return;
    const resSet = resFilters.get(s);
    if (resSet && !resSet.has(String(d.id))) return;
    emit({ type: 'RECORD', stream: s, key: d.id, data: d, emitted_at: emittedAt });
    total++;
  };

  const needRollouts = requested.has('sessions') || requested.has('messages') || requested.has('function_calls');

  // Rollout aggregates per session (so `sessions` can carry message_count /
  // function_call_count even when state_5 provides the canonical metadata).
  const rolloutAggregates = new Map(); // sessionId → { meta, firstTs, lastTs, messageCount, functionCallCount }

  const newMtimes = { ...fileMtimes };

  if (needRollouts) {
    let baseExists = true;
    try {
      await readdir(baseDir);
    } catch (err) {
      baseExists = false;
      emit({ type: 'PROGRESS', message: `${baseDir} not readable: ${err.message}` });
    }

    if (baseExists) {
      let fileCount = 0;
      for await (const { path: p, year, month, day, file } of walkRollouts(baseDir)) {
        fileCount++;
        let st;
        try { st = statSync(p); } catch { continue; }
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

        emit({ type: 'PROGRESS', message: `Parsing ${year}/${month}/${day}/${file} (${(st.size / 1024 / 1024).toFixed(1)}MB)` });

        let sessionId = null;
        let sessionMeta = null;
        let firstTimestamp = null;
        let lastTimestamp = null;
        let messageCount = 0;
        let functionCallCount = 0;
        const pendingCalls = new Map();
        let lineCount = 0;

        for await (const obj of iterJsonlLines(p)) {
          lineCount++;
          if (lineCount % 2000 === 0) {
            emit({ type: 'PROGRESS', message: `  ${file}: ${lineCount} lines parsed` });
          }

          const ts = obj.timestamp || null;
          if (ts) {
            if (!firstTimestamp || ts < firstTimestamp) firstTimestamp = ts;
            if (!lastTimestamp || ts > lastTimestamp) lastTimestamp = ts;
          }

          if (obj.type === 'session_meta') {
            sessionMeta = obj.payload || {};
            sessionId = sessionMeta.id || null;
            continue;
          }

          if (!sessionId) continue;
          if (obj.type !== 'response_item') continue;
          const payload = obj.payload || {};

          if (payload.type === 'message') {
            messageCount++;
            if (requested.has('messages')) {
              const role = payload.role || null;
              const content = extractMessageText(payload);
              const id = `${sessionId}:${lineCount}`;
              emitRecord('messages', {
                id,
                session_id: sessionId,
                role,
                type: 'message',
                content: textPreview(content, 5000),
                timestamp: ts,
              });
            }
          } else if (payload.type === 'function_call') {
            functionCallCount++;
            if (requested.has('function_calls')) {
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
          } else if (payload.type === 'function_call_output') {
            if (requested.has('function_calls')) {
              const callId = payload.call_id;
              const existing = callId ? pendingCalls.get(callId) : null;
              if (existing) {
                existing.output_preview = textPreview(
                  typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output),
                  2000
                );
              } else {
                const id = `${sessionId}:${lineCount}:output`;
                emitRecord('function_calls', {
                  id,
                  session_id: sessionId,
                  call_id: callId || null,
                  name: null,
                  arguments: null,
                  output_preview: textPreview(
                    typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output),
                    2000
                  ),
                  timestamp: ts,
                });
              }
            }
          }
          // reasoning is skipped — encrypted_content is opaque.
        }

        // Flush paired function_calls at end of file.
        for (const call of pendingCalls.values()) {
          emitRecord('function_calls', call);
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
      emit({ type: 'PROGRESS', message: `Scanned ${fileCount} rollout files` });
    }
  }

  // Sessions: prefer state_5.sqlite#threads; fall back to rollout-derived
  // fields only when state_5 doesn't have the session. Session PK stays the
  // thread/session id — the same UUID is used by both sources.
  if (requested.has('sessions')) {
    const { map: threadsById } = loadThreadsMap(stateDbPath);
    const emittedSessionIds = new Set();

    for (const [id, t] of threadsById) {
      const agg = rolloutAggregates.get(id);
      emitRecord('sessions', {
        id,
        cwd: t.cwd || null,
        originator: t.source || null,
        cli_version: t.cli_version || null,
        model_provider: t.model_provider || null,
        git_commit: t.git_sha || null,
        git_branch: t.git_branch || null,
        repository_url: t.git_origin_url || null,
        started_at: epochToIso(t.created_at) || (agg?.meta?.timestamp || agg?.firstTs || null),
        last_event_at: epochToIso(t.updated_at) || (agg?.lastTs || null),
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
      if (emittedSessionIds.has(id)) continue;
      const meta = agg.meta || {};
      emitRecord('sessions', {
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

  if (requested.has('rules')) {
    await emitRulesStream(rulesDir, emitRecord);
  }
  if (requested.has('prompts')) {
    await emitPromptsStream(promptsDir, emitRecord);
  }
  if (requested.has('skills')) {
    await emitSkillsStream(skillsDir, emitRecord);
  }

  // State cursors
  if (requested.has('sessions')) {
    emit({ type: 'STATE', stream: 'sessions', cursor: { fetched_at: nowIso() } });
  }
  if (requested.has('messages') || requested.has('function_calls')) {
    const cursorStream = requested.has('messages') ? 'messages' : 'function_calls';
    emit({ type: 'STATE', stream: cursorStream, cursor: { file_mtimes: newMtimes, fetched_at: nowIso() } });
  }
  for (const s of ['rules', 'prompts', 'skills']) {
    if (requested.has(s)) emit({ type: 'STATE', stream: s, cursor: { fetched_at: nowIso() } });
  }

  emit({ type: 'DONE', status: 'succeeded', records_emitted: total });
  flushAndExit(0);
}

main().catch((e) => {
  const msg = e?.message || String(e);
  emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: msg, retryable: false } });
  flushAndExit(1);
});
