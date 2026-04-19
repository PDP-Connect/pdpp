#!/usr/bin/env node
/**
 * PDPP Twitter/X Archive Connector (v0.1.0)
 *
 * Auth: none. User requests their Twitter archive at
 *   https://twitter.com/settings/download_your_data
 * extracts the .zip into TWITTER_ARCHIVE_DIR (defaults
 * ~/.pdpp/imports/twitter_archive/), and runs this connector.
 *
 * The archive contains JS files that assign to a global — we strip the
 * prefix to get JSON. Expected files:
 *   data/tweets.js  (or data/tweet.js in older archives)
 *   data/direct-messages.js
 */

import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resourceSet } from '../../src/scope-filters.js';

const rl = createInterface({ input: process.stdin, terminal: false });
const emit = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const flushAndExit = (code) => {
  if (process.stdout.writableLength > 0) {
    process.stdout.once("drain", () => process.exit(code));
    setTimeout(() => process.exit(code), 3000).unref();
  } else process.exit(code);
};
const fail = (m, r = false) => { emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: m, retryable: r } }); flushAndExit(1); };
const nowIso = () => new Date().toISOString();

async function readJsArchive(path) {
  if (!existsSync(path)) return null;
  const text = await readFile(path, 'utf8');
  // Archive files start like:  window.YTD.tweets.part0 = [ ... ]
  const stripped = text.replace(/^[^=]*=\s*/, '').trim().replace(/;?\s*$/, '');
  try { return JSON.parse(stripped); } catch { return null; }
}

async function main() {
  const startMsg = await new Promise((r, j) => rl.once('line', (l) => { try { r(JSON.parse(l)); } catch (e) { j(e); } }));
  if (startMsg.type !== 'START') return fail('Expected START');

  const importDir = process.env.TWITTER_ARCHIVE_DIR || join(homedir(), '.pdpp/imports/twitter_archive');
  const requested = new Map((startMsg.scope?.streams || []).map((s) => [s.name, s]));
  if (!requested.size) return fail('START.scope.streams is required');

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

  if (requested.has('tweets')) {
    let arr = await readJsArchive(join(importDir, 'data', 'tweets.js'));
    if (!arr) arr = await readJsArchive(join(importDir, 'data', 'tweet.js'));
    if (!arr) {
      emit({ type: 'SKIP_RESULT', stream: 'tweets', reason: 'archive_not_found', message: `tweets.js not found in ${importDir}/data/` });
    } else {
      const since = state.tweets?.last_created_at;
      let latest = since;
      emit({ type: 'PROGRESS', stream: 'tweets', message: `Importing ${arr.length} tweets` });
      for (const entry of arr) {
        const t = entry.tweet || entry;
        const createdAt = t.created_at ? new Date(t.created_at).toISOString() : null;
        if (!createdAt) continue;
        if (since && createdAt <= since) continue;
        emitRecord('tweets', {
          id: t.id_str || t.id,
          text: t.full_text ?? t.text ?? null,
          created_at: createdAt,
          favorite_count: t.favorite_count ? parseInt(t.favorite_count, 10) : null,
          retweet_count: t.retweet_count ? parseInt(t.retweet_count, 10) : null,
          in_reply_to_status_id: t.in_reply_to_status_id_str ?? null,
          in_reply_to_screen_name: t.in_reply_to_screen_name ?? null,
          lang: t.lang ?? null,
          media_count: (t.entities?.media || []).length,
          url_count: (t.entities?.urls || []).length,
        });
        if (!latest || createdAt > latest) latest = createdAt;
      }
      emit({ type: 'STATE', stream: 'tweets', cursor: { last_created_at: latest } });
    }
  }

  if (requested.has('direct_messages')) {
    const arr = await readJsArchive(join(importDir, 'data', 'direct-messages.js'));
    if (!arr) {
      emit({ type: 'SKIP_RESULT', stream: 'direct_messages', reason: 'archive_not_found', message: `direct-messages.js not found in ${importDir}/data/` });
    } else {
      const since = state.direct_messages?.last_created_at;
      let latest = since;
      for (const convo of arr) {
        const conversation = convo.dmConversation || convo;
        const convId = conversation.conversationId || null;
        for (const m of (conversation.messages || [])) {
          const mm = m.messageCreate || m;
          const createdAt = mm.createdAt ? new Date(mm.createdAt).toISOString() : null;
          if (!createdAt) continue;
          if (since && createdAt <= since) continue;
          emitRecord('direct_messages', {
            id: mm.id,
            conversation_id: convId,
            sender_id: mm.senderId ?? null,
            recipient_id: mm.recipientId ?? null,
            created_at: createdAt,
            text: mm.text ?? null,
          });
          if (!latest || createdAt > latest) latest = createdAt;
        }
      }
      emit({ type: 'STATE', stream: 'direct_messages', cursor: { last_created_at: latest } });
    }
  }

  emit({ type: 'DONE', status: 'succeeded', records_emitted: total });
  flushAndExit(0);
}

main().catch((e) => {
  const msg = e?.message || String(e);
  emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: msg, retryable: false } });
  flushAndExit(1);
});
