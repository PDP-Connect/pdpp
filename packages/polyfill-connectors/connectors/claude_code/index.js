#!/usr/bin/env node
/**
 * PDPP Claude Code Connector (v0.1.0)
 *
 * Parses ~/.claude/projects/<encoded-project-path>/*.jsonl — Claude Code's
 * on-disk session transcripts. No auth required; runs against local files.
 *
 * Streams:
 *   sessions     — one record per session (derived from grouping jsonl lines by sessionId)
 *   messages     — user prompts + assistant responses
 *   attachments  — hook outputs, tool uses, file snapshots, permission-mode changes
 *
 * Incremental via file-modified time: if a jsonl file's mtime hasn't changed
 * since last run, we skip re-parsing it entirely.
 *
 * Honors CLAUDE_CODE_PROJECTS_DIR override; defaults to ~/.claude/projects.
 */

import { createInterface } from 'node:readline';
import { createReadStream, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createInterface as createFileReader } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resourceSet } from '../../src/scope-filters.js';

const rl = createInterface({ input: process.stdin, terminal: false });
const emit = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const flushAndExit = (code) => {
  if (process.stdout.writableLength > 0) {
    process.stdout.once('drain', () => process.exit(code));
    setTimeout(() => process.exit(code), 3000).unref();
  } else process.exit(code);
};
const fail = (m, r = false) => { emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: m, retryable: r } }); flushAndExit(1); };

function textPreview(s, max = 300) {
  if (typeof s !== 'string') return null;
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function extractContent(obj) {
  // User/assistant message content may be a string or an array of parts.
  // Attachments have nested `attachment.content` or `attachment.toolUseResult`.
  if (!obj) return null;
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) {
    const parts = obj.map((p) => {
      if (typeof p === 'string') return p;
      if (p?.type === 'text' && p.text) return p.text;
      if (p?.type === 'tool_use') return `[tool_use: ${p.name || 'unknown'}]`;
      if (p?.type === 'tool_result') return `[tool_result]`;
      return '';
    }).filter(Boolean);
    return parts.join('\n') || null;
  }
  if (obj.content) return extractContent(obj.content);
  if (obj.text) return obj.text;
  return null;
}

async function* iterJsonlLines(path) {
  const r = createFileReader({ input: createReadStream(path, { encoding: 'utf8' }), terminal: false });
  for await (const line of r) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* skip malformed */ }
  }
}

async function main() {
  const startMsg = await new Promise((r, j) => rl.once('line', (l) => { try { r(JSON.parse(l)); } catch (e) { j(e); } }));
  if (startMsg.type !== 'START') return fail('Expected START');

  const requested = new Map((startMsg.scope?.streams || []).map((s) => [s.name, s]));
  if (!requested.size) return fail('START.scope.streams is required');

  const resFilters = new Map();
  for (const [n, r] of requested) resFilters.set(n, resourceSet(r));

  const baseDir = process.env.CLAUDE_CODE_PROJECTS_DIR || join(homedir(), '.claude/projects');
  const state = startMsg.state || {};
  const fileMtimes = state.file_mtimes || {};

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

  let projectDirs;
  try {
    projectDirs = (await readdir(baseDir)).filter((name) => !name.startsWith('.'));
  } catch (err) {
    emit({ type: 'SKIP_RESULT', reason: 'claude_dir_not_found', message: `${baseDir} not readable: ${err.message}` });
    emit({ type: 'DONE', status: 'succeeded', records_emitted: 0 });
    return flushAndExit(0);
  }

  // Optional scoping — comma-separated substrings; a dir is included if any match.
  const include = (process.env.CLAUDE_CODE_PROJECT_INCLUDE || '').split(',').map((s) => s.trim()).filter(Boolean);
  const exclude = (process.env.CLAUDE_CODE_PROJECT_EXCLUDE || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (include.length) projectDirs = projectDirs.filter((d) => include.some((s) => d.includes(s)));
  if (exclude.length) projectDirs = projectDirs.filter((d) => !exclude.some((s) => d.includes(s)));
  emit({ type: 'PROGRESS', message: `${projectDirs.length} project dirs in scope` });

  const newMtimes = { ...fileMtimes };
  const sessionAccumulators = new Map(); // sessionId → partial session record

  for (const projectDir of projectDirs) {
    const projectPath = join(baseDir, projectDir);
    let entries;
    try { entries = await readdir(projectPath); } catch { continue; }
    const jsonlFiles = entries.filter((f) => f.endsWith('.jsonl'));
    for (const f of jsonlFiles) {
      const p = join(projectPath, f);
      let st;
      try { st = statSync(p); } catch { continue; }
      const mtime = st.mtimeMs;
      if (fileMtimes[p] === mtime) {
        // Unchanged since last run — skip entirely.
        newMtimes[p] = mtime;
        continue;
      }

      emit({ type: 'PROGRESS', message: `Parsing ${projectDir}/${f} (${(st.size / 1024 / 1024).toFixed(1)}MB)` });
      let sessionId = null;
      let firstTimestamp = null;
      let lastTimestamp = null;
      let messageCount = 0;
      let lineCount = 0;
      let cwd = null, gitBranch = null, userType = null, entrypoint = null, version = null;

      for await (const obj of iterJsonlLines(p)) {
        lineCount++;
        if (lineCount % 2000 === 0) {
          emit({ type: 'PROGRESS', message: `  ${projectDir}/${f}: ${lineCount} lines parsed` });
        }
        // Capture session-level metadata.
        if (obj.sessionId) sessionId = obj.sessionId;
        if (obj.cwd && !cwd) cwd = obj.cwd;
        if (obj.gitBranch && !gitBranch) gitBranch = obj.gitBranch;
        if (obj.userType && !userType) userType = obj.userType;
        if (obj.entrypoint && !entrypoint) entrypoint = obj.entrypoint;
        if (obj.version && !version) version = obj.version;
        if (obj.timestamp) {
          if (!firstTimestamp || obj.timestamp < firstTimestamp) firstTimestamp = obj.timestamp;
          if (!lastTimestamp || obj.timestamp > lastTimestamp) lastTimestamp = obj.timestamp;
        }

        const type = obj.type;
        const uuid = obj.uuid;
        const parentUuid = obj.parentUuid ?? null;
        if (!sessionId) continue;

        if (type === 'user' || type === 'assistant') {
          messageCount++;
          if (requested.has('messages') && uuid) {
            emitRecord('messages', {
              id: uuid,
              session_id: sessionId,
              parent_uuid: parentUuid,
              role: type,
              type,
              content: textPreview(extractContent(obj.message || obj), 5000),
              timestamp: obj.timestamp || null,
              is_sidechain: obj.isSidechain ?? null,
              user_type: obj.userType ?? null,
            });
          }
        } else if (type === 'attachment' || type === 'file-history-snapshot' || type === 'permission-mode' || type === 'last-prompt') {
          if (requested.has('attachments') && uuid) {
            const att = obj.attachment || {};
            emitRecord('attachments', {
              id: uuid,
              session_id: sessionId,
              parent_uuid: parentUuid,
              event_type: type,
              hook_name: att.hookName || null,
              tool_use_id: att.toolUseID || null,
              content_preview: textPreview(extractContent(att) || extractContent(obj), 500),
              timestamp: obj.timestamp || null,
            });
          }
        }
      }

      if (sessionId) {
        // Merge into sessionAccumulators (session may span multiple files if
        // Claude Code reopens; but typically one jsonl per sessionId).
        const acc = sessionAccumulators.get(sessionId) || {
          id: sessionId,
          project_path: projectDir,
          cwd: null, git_branch: null, version: null,
          started_at: null, last_event_at: null,
          message_count: 0, user_type: null, entrypoint: null,
        };
        if (cwd) acc.cwd = cwd;
        if (gitBranch) acc.git_branch = gitBranch;
        if (version) acc.version = version;
        if (userType) acc.user_type = userType;
        if (entrypoint) acc.entrypoint = entrypoint;
        if (firstTimestamp && (!acc.started_at || firstTimestamp < acc.started_at)) acc.started_at = firstTimestamp;
        if (lastTimestamp && (!acc.last_event_at || lastTimestamp > acc.last_event_at)) acc.last_event_at = lastTimestamp;
        acc.message_count += messageCount;
        sessionAccumulators.set(sessionId, acc);
      }
      newMtimes[p] = mtime;
    }
  }

  if (requested.has('sessions')) {
    for (const session of sessionAccumulators.values()) {
      emitRecord('sessions', session);
    }
    emit({ type: 'STATE', stream: 'sessions', cursor: { fetched_at: nowIso() } });
  }

  if (requested.has('messages') || requested.has('attachments')) {
    emit({ type: 'STATE', stream: 'messages', cursor: { file_mtimes: newMtimes, fetched_at: nowIso() } });
  }

  emit({ type: 'DONE', status: 'succeeded', records_emitted: total });
  flushAndExit(0);
}

main().catch((e) => {
  const msg = e?.message || String(e);
  emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: msg, retryable: false } });
  flushAndExit(1);
});
