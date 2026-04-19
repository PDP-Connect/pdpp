#!/usr/bin/env node
/**
 * PDPP Pocket Connector (v0.1.0) — DEPRECATED.
 *
 * Mozilla shut Pocket down on 2025-07-08; all user data was deleted by
 * 2025-10-08. The developer portal is gone; new consumer keys can no longer
 * be issued; the v3 API returns 404. This connector is kept on disk purely
 * for historical reference and is excluded from register-all. Do not run.
 *
 * If you have an old Pocket export (HTML from the user's "Export" page), a
 * file-based variant could still parse it. That path is deferred — nobody
 * who comes to PDPP after 2025-07-08 has fresh Pocket data.
 *
 * Auth: POCKET_CONSUMER_KEY + POCKET_ACCESS_TOKEN env vars (retained only
 * to keep the 0.1.0 manifest shape stable for archival purposes).
 */

import { createInterface } from 'node:readline';
import { resourceSet, requireCredentialsOrAsk } from '../../src/scope-filters.js';

const rl = createInterface({ input: process.stdin, terminal: false });
const emit = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const flushAndExit = (code) => {
  if (process.stdout.writableLength > 0) {
    process.stdout.once('drain', () => process.exit(code));
    setTimeout(() => process.exit(code), 3000).unref();
  } else process.exit(code);
};
const fail = (m, r = false) => { emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: m, retryable: r } }); flushAndExit(1); };
const nowIso = () => new Date().toISOString();
const isoFromUnix = (u) => u ? new Date(Number(u) * 1000).toISOString() : null;

let _ic = 0;
const nextInteractionId = () => `int_${Date.now()}_${++_ic}`;
async function sendInteractionAndWait(msg) {
  emit(msg);
  const reqId = msg.request_id;
  return new Promise((resolve, reject) => {
    const onLine = (line) => {
      try {
        const p = JSON.parse(line);
        if (p.type === 'INTERACTION_RESPONSE' && p.request_id === reqId) { rl.off('line', onLine); resolve(p); }
      } catch (err) { reject(err); }
    };
    rl.on('line', onLine);
  });
}

async function main() {
  const startMsg = await new Promise((r, j) => rl.once('line', (l) => { try { r(JSON.parse(l)); } catch (e) { j(e); } }));
  if (startMsg.type !== 'START') return fail('Expected START');

  let consumerKey = process.env.POCKET_CONSUMER_KEY;
  let accessToken = process.env.POCKET_ACCESS_TOKEN;
  if (!consumerKey || !accessToken) {
    try {
      const creds = await requireCredentialsOrAsk({
        required: ['POCKET_CONSUMER_KEY', 'POCKET_ACCESS_TOKEN'],
        connectorName: 'Pocket',
        sendInteractionAndWait,
        nextInteractionId,
      });
      consumerKey = creds.POCKET_CONSUMER_KEY;
      accessToken = creds.POCKET_ACCESS_TOKEN;
    } catch (e) { return fail(e.message, false); }
  }

  const requested = new Map((startMsg.scope?.streams || []).map((s) => [s.name, s]));
  if (!requested.size) return fail('START.scope.streams is required');

  const resFilters = new Map();
  const priorIdsByStream = new Map();
  const currentIdsByStream = new Map();
  for (const [n, r] of requested) {
    resFilters.set(n, resourceSet(r));
    priorIdsByStream.set(n, new Set(startMsg.state?.[n]?.seen_ids || []));
    currentIdsByStream.set(n, new Set());
  }

  const state = startMsg.state || {};
  const emittedAt = nowIso();
  let total = 0;
  const emitRecord = (s, d) => {
    if (d.id == null) return;
    const canonical = String(d.id);
    const resSet = resFilters.get(s);
    if (resSet && !resSet.has(canonical)) return;
    emit({ type: 'RECORD', stream: s, key: d.id, data: d, emitted_at: emittedAt });
    currentIdsByStream.get(s)?.add(canonical);
    total++;
  };

  if (requested.has('items')) {
    emit({ type: 'PROGRESS', stream: 'items', message: 'Fetching Pocket items' });
    const since = state.items?.last_time_updated_unix;
    const body = {
      consumer_key: consumerKey,
      access_token: accessToken,
      detailType: 'complete',
      state: 'all',
      sort: 'oldest',
      count: 500,
      ...(since ? { since } : {}),
    };
    let offset = 0;
    let latest = since || 0;
    while (true) {
      const res = await fetch('https://getpocket.com/v3/get', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Accept': 'application/json' },
        body: JSON.stringify({ ...body, offset }),
      });
      if (res.status === 401) return fail('pocket_auth_failed', false);
      if (!res.ok) return fail(`pocket_http_${res.status}: ${(await res.text()).slice(0, 200)}`, /5\d\d/.test(String(res.status)));
      const data = await res.json();
      const items = data.list && typeof data.list === 'object' ? Object.values(data.list) : [];
      if (!items.length) break;
      for (const it of items) {
        const updated = parseInt(it.time_updated || it.time_added || '0', 10);
        const itemId = String(it.item_id);
        // Pocket status: '0' = unread, '1' = archived, '2' = deleted (tombstone).
        if (it.status === '2') {
          emit({ type: 'RECORD', stream: 'items', key: itemId, data: { id: itemId }, emitted_at: emittedAt, op: 'delete' });
          total++;
        } else {
          emitRecord('items', {
            id: itemId,
            url: it.resolved_url || it.given_url,
            title: it.resolved_title || it.given_title || null,
            author: it.authors ? Object.values(it.authors).map((a) => a.name).filter(Boolean).join(', ') : null,
            time_added: isoFromUnix(it.time_added),
            time_updated: isoFromUnix(it.time_updated),
            time_read: isoFromUnix(it.time_read),
            time_favorited: isoFromUnix(it.time_favorited),
            tags: it.tags ? Object.keys(it.tags) : [],
            archived: it.status === '1',
            favorite: it.favorite === '1',
            word_count: it.word_count ? parseInt(it.word_count, 10) : null,
            reading_time_minutes: it.time_to_read ? parseInt(it.time_to_read, 10) : null,
          });
        }
        if (updated > latest) latest = updated;
      }
      offset += items.length;
      if (items.length < 500) break;
    }
    emit({ type: 'STATE', stream: 'items', cursor: { last_time_updated_unix: latest || null } });
  }

  emit({ type: 'DONE', status: 'succeeded', records_emitted: total });
  process.exit(0);
}

main().catch((e) => {
  const msg = e?.message || String(e);
  emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: msg, retryable: /ECONN|fetch failed/i.test(msg) } });
  process.exit(1);
});
