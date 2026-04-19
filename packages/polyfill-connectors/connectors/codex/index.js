#!/usr/bin/env node
/**
 * PDPP Codex CLI Connector (v0.1.0)
 *
 * Parses ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl — OpenAI Codex CLI's
 * on-disk rollout transcripts. No auth required; runs against local files.
 *
 * Streams:
 *   sessions        — one record per rollout file (session_meta is the first line)
 *   messages        — user/assistant text messages (reasoning is encrypted, not stored)
 *   function_calls  — shell/tool invocations + outputs (by call_id)
 *
 * Incremental via file-modified time: if a rollout file's mtime hasn't changed
 * since last run, we skip re-parsing it entirely.
 *
 * Honors CODEX_SESSIONS_DIR override; defaults to ~/.codex/sessions.
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

function textPreview(s, max = 5000) {
  if (typeof s !== 'string') return null;
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function extractMessageText(payload) {
  // payload.content is an array of { type: "input_text"|"output_text", text }
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

async function main() {
  const startMsg = await new Promise((r, j) => rl.once('line', (l) => { try { r(JSON.parse(l)); } catch (e) { j(e); } }));
  if (startMsg.type !== 'START') return fail('Expected START');

  const requested = new Map((startMsg.scope?.streams || []).map((s) => [s.name, s]));
  if (!requested.size) return fail('START.scope.streams is required');

  const resFilters = new Map();
  for (const [n, r] of requested) resFilters.set(n, resourceSet(r));

  const baseDir = process.env.CODEX_SESSIONS_DIR || join(homedir(), '.codex/sessions');
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

  // Quickly probe the root — if it doesn't exist, skip gracefully.
  try {
    await readdir(baseDir);
  } catch (err) {
    emit({ type: 'SKIP_RESULT', reason: 'codex_dir_not_found', message: `${baseDir} not readable: ${err.message}` });
    emit({ type: 'DONE', status: 'succeeded', records_emitted: 0 });
    return flushAndExit(0);
  }

  const newMtimes = { ...fileMtimes };
  let fileCount = 0;

  for await (const { path: p, year, month, day, file } of walkRollouts(baseDir)) {
    fileCount++;
    let st;
    try { st = statSync(p); } catch { continue; }
    const mtime = st.mtimeMs;
    if (fileMtimes[p] === mtime) {
      newMtimes[p] = mtime;
      continue;
    }

    emit({ type: 'PROGRESS', message: `Parsing ${year}/${month}/${day}/${file} (${(st.size / 1024 / 1024).toFixed(1)}MB)` });

    let sessionId = null;
    let sessionMeta = null;
    let firstTimestamp = null;
    let lastTimestamp = null;
    let messageCount = 0;
    let functionCallCount = 0;
    // buffer function_call → pair with function_call_output by call_id
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
          // Synthesize an id: session_id + line index ensures idempotency.
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
            // Orphan output — store as its own record with synthetic id.
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

    if (sessionId && sessionMeta && requested.has('sessions')) {
      emitRecord('sessions', {
        id: sessionId,
        cwd: sessionMeta.cwd || null,
        originator: sessionMeta.originator || null,
        cli_version: sessionMeta.cli_version || null,
        model_provider: sessionMeta.model_provider || null,
        git_commit: sessionMeta.git?.commit_hash || null,
        git_branch: sessionMeta.git?.branch || null,
        repository_url: sessionMeta.git?.repository_url || null,
        started_at: sessionMeta.timestamp || firstTimestamp,
        last_event_at: lastTimestamp,
        message_count: messageCount,
        function_call_count: functionCallCount,
      });
    }
    newMtimes[p] = mtime;
  }

  emit({ type: 'PROGRESS', message: `Scanned ${fileCount} rollout files` });

  if (requested.has('sessions')) {
    emit({ type: 'STATE', stream: 'sessions', cursor: { fetched_at: nowIso() } });
  }
  if (requested.has('messages') || requested.has('function_calls')) {
    const cursorStream = requested.has('messages') ? 'messages' : 'function_calls';
    emit({ type: 'STATE', stream: cursorStream, cursor: { file_mtimes: newMtimes, fetched_at: nowIso() } });
  }

  emit({ type: 'DONE', status: 'succeeded', records_emitted: total });
  flushAndExit(0);
}

main().catch((e) => {
  const msg = e?.message || String(e);
  emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: msg, retryable: false } });
  flushAndExit(1);
});
