#!/usr/bin/env node
/**
 * PDPP iMessage Connector (v0.1.0)
 *
 * Reads ~/Library/Messages/chat.db (macOS only by default). SQLite is
 * read-only opened. User may override with IMESSAGE_DB_PATH env var (useful
 * for copying chat.db off a machine and running the connector on Linux).
 *
 * Incremental via message.date (Apple epoch: seconds/nanos since 2001-01-01).
 */

import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from '@databases/sqlite';
import { resourceSet } from '../../src/scope-filters.js';
import { stringifyForJsonl } from '../../src/safe-emit.js';

const rl = createInterface({ input: process.stdin, terminal: false });
const emit = (m) => process.stdout.write(stringifyForJsonl(m));
const flushAndExit = (code) => {
  if (process.stdout.writableLength > 0) {
    process.stdout.once("drain", () => process.exit(code));
    setTimeout(() => process.exit(code), 3000).unref();
  } else process.exit(code);
};
const fail = (m, r = false) => { emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: m, retryable: r } }); flushAndExit(1); };
const nowIso = () => new Date().toISOString();

// Apple cocoa epoch offset: seconds from 1970 to 2001-01-01 UTC.
const APPLE_EPOCH_SEC = 978307200;
function appleDateToIso(raw) {
  if (!raw) return null;
  // Newer macOS: nanoseconds; older: seconds. Heuristic: > 1e10 → nanos.
  const n = Number(raw);
  if (!isFinite(n)) return null;
  const sec = n > 1e10 ? n / 1e9 : n;
  return new Date((APPLE_EPOCH_SEC + sec) * 1000).toISOString();
}

async function main() {
  const startMsg = await new Promise((r, j) => rl.once('line', (l) => { try { r(JSON.parse(l)); } catch (e) { j(e); } }));
  if (startMsg.type !== 'START') return fail('Expected START');

  const requested = new Map((startMsg.scope?.streams || []).map((s) => [s.name, s]));
  if (!requested.size) return fail('START.scope.streams is required');

  const dbPath = process.env.IMESSAGE_DB_PATH || join(homedir(), 'Library/Messages/chat.db');
  if (!existsSync(dbPath)) {
    return fail(`imessage_db_not_found: ${dbPath}. On macOS the path is ~/Library/Messages/chat.db; on Linux copy it over and set IMESSAGE_DB_PATH.`);
  }

  const createDatabase = typeof Database === 'function' ? Database : Database.default;
  const { sql } = Database;
  const db = createDatabase(dbPath);

  const state = startMsg.state || {};
  const emittedAt = nowIso();
  let total = 0;
  const _resFilters = new Map((startMsg.scope?.streams || []).map((sr) => [sr.name, resourceSet(sr)]));
  const emitRecord = (s, d) => {
    if (d.id == null) return;
    const _rs = _resFilters.get(s);
    if (_rs && !_rs.has(String(d.id))) return;
    emit({ type: 'RECORD', stream: s, key: d.id, data: d, emitted_at: emittedAt });
    total++;
  };

  if (requested.has('messages')) {
    emit({ type: 'PROGRESS', stream: 'messages', message: 'Reading chat.db' });
    const since = state.messages?.last_apple_date || 0;
    const rows = await db.query(sql`
      SELECT m.ROWID as id, m.guid, m.handle_id, m.service, m.is_from_me,
             m.text, m.date, m.date_read, m.cache_has_attachments,
             h.id as handle,
             cmj.chat_id as chat_id
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      WHERE m.date > ${since}
      ORDER BY m.date ASC
    `).catch((err) => {
      emit({ type: 'SKIP_RESULT', stream: 'messages', reason: 'db_query_failed', message: err.message.slice(0, 200) });
      return [];
    });

    let latestApple = since;
    for (const r of rows) {
      emitRecord('messages', {
        id: r.guid || String(r.id),
        chat_id: r.chat_id ? String(r.chat_id) : null,
        handle: r.handle || null,
        service: r.service || null,
        is_from_me: !!r.is_from_me,
        text: r.text || null,
        date: appleDateToIso(r.date) || nowIso(),
        date_read: appleDateToIso(r.date_read),
        has_attachments: !!r.cache_has_attachments,
      });
      if (r.date && Number(r.date) > latestApple) latestApple = Number(r.date);
    }
    emit({ type: 'STATE', stream: 'messages', cursor: { last_apple_date: latestApple } });
  }

  emit({ type: 'DONE', status: 'succeeded', records_emitted: total });
  flushAndExit(0);
}

main().catch((e) => {
  const msg = e?.message || String(e);
  emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: msg, retryable: false } });
  flushAndExit(1);
});
