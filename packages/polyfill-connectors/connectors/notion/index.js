#!/usr/bin/env node
/**
 * PDPP Notion Connector (v0.1.0)
 *
 * Auth: Notion internal integration token via NOTION_API_TOKEN env var.
 * Create at https://www.notion.so/profile/integrations. The integration must
 * be explicitly shared with each page/database (Notion security model).
 *
 * API: https://api.notion.com/v1/search (POST)
 * Rate limit: 3 req/s average.
 */

import { createInterface } from 'node:readline';
import { resourceSet, requireCredentialsOrAsk } from '../../src/scope-filters.js';
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
const nowIso = () => new Date().toISOString();

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

async function ntn(path, token, { method = 'POST', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new Error('notion_auth_failed');
  if (res.status === 429) throw new Error('notion_rate_limited');
  if (!res.ok) throw new Error(`notion_http_${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function extractTitle(obj) {
  // Pages: properties[*].title[].plain_text   Databases: title[].plain_text
  if (obj.properties) {
    for (const p of Object.values(obj.properties)) {
      if (p?.type === 'title' && Array.isArray(p.title)) {
        return p.title.map((t) => t.plain_text || '').join('') || null;
      }
    }
  }
  if (Array.isArray(obj.title)) {
    return obj.title.map((t) => t.plain_text || '').join('') || null;
  }
  return null;
}

async function main() {
  const startMsg = await new Promise((r, j) => rl.once('line', (l) => { try { r(JSON.parse(l)); } catch (e) { j(e); } }));
  if (startMsg.type !== 'START') return fail('Expected START');

  let token = process.env.NOTION_API_TOKEN;
  if (!token) {
    try {
      const creds = await requireCredentialsOrAsk({
        required: ['NOTION_API_TOKEN'],
        connectorName: 'Notion',
        sendInteractionAndWait,
        nextInteractionId,
      });
      token = creds.NOTION_API_TOKEN;
    } catch (e) { return fail(e.message, false); }
  }

  const requested = new Map((startMsg.scope?.streams || []).map((s) => [s.name, s]));
  if (!requested.size) return fail('START.scope.streams is required');

  const resFilters = new Map();
  for (const [n, r] of requested) resFilters.set(n, resourceSet(r));

  const state = startMsg.state || {};
  const emittedAt = nowIso();
  let total = 0;
  const emitRecord = (s, d) => {
    if (d.id == null) return;
    const resSet = resFilters.get(s);
    if (resSet && !resSet.has(String(d.id))) return;
    // Archived pages/databases are tombstones per PDPP spec.
    if (d.archived === true) {
      emit({ type: 'RECORD', stream: s, key: d.id, data: { id: d.id }, emitted_at: emittedAt, op: 'delete' });
    } else {
      emit({ type: 'RECORD', stream: s, key: d.id, data: d, emitted_at: emittedAt });
    }
    total++;
  };

  async function searchAll(filter) {
    const results = [];
    let cursor = undefined;
    while (true) {
      const body = { sort: { direction: 'descending', timestamp: 'last_edited_time' }, page_size: 100 };
      if (filter) body.filter = filter;
      if (cursor) body.start_cursor = cursor;
      const json = await ntn('/search', token, { body });
      results.push(...(json.results || []));
      if (!json.has_more || !json.next_cursor) break;
      cursor = json.next_cursor;
      await sleep(400);
    }
    return results;
  }

  if (requested.has('pages')) {
    emit({ type: 'PROGRESS', stream: 'pages', message: 'Searching pages' });
    const pages = await searchAll({ property: 'object', value: 'page' });
    const prior = state.pages?.last_edited_time;
    let latest = prior;
    for (const p of pages) {
      if (prior && p.last_edited_time && p.last_edited_time <= prior) continue;
      emitRecord('pages', {
        id: p.id,
        object: p.object,
        parent_type: p.parent?.type ?? null,
        parent_id: p.parent ? (p.parent.page_id || p.parent.database_id || p.parent.workspace || null) : null,
        title: extractTitle(p),
        url: p.url ?? null,
        archived: p.archived ?? null,
        created_time: p.created_time ?? null,
        last_edited_time: p.last_edited_time ?? null,
        created_by_id: p.created_by?.id ?? null,
        last_edited_by_id: p.last_edited_by?.id ?? null,
      });
      if (p.last_edited_time && (!latest || p.last_edited_time > latest)) latest = p.last_edited_time;
    }
    emit({ type: 'STATE', stream: 'pages', cursor: { last_edited_time: latest || prior || null } });
  }

  if (requested.has('databases')) {
    emit({ type: 'PROGRESS', stream: 'databases', message: 'Searching databases' });
    const dbs = await searchAll({ property: 'object', value: 'database' });
    const prior = state.databases?.last_edited_time;
    let latest = prior;
    for (const d of dbs) {
      if (prior && d.last_edited_time && d.last_edited_time <= prior) continue;
      emitRecord('databases', {
        id: d.id,
        title: extractTitle(d),
        parent_type: d.parent?.type ?? null,
        parent_id: d.parent ? (d.parent.page_id || d.parent.database_id || d.parent.workspace || null) : null,
        url: d.url ?? null,
        archived: d.archived ?? null,
        created_time: d.created_time ?? null,
        last_edited_time: d.last_edited_time ?? null,
        property_names: d.properties ? Object.keys(d.properties) : [],
      });
      if (d.last_edited_time && (!latest || d.last_edited_time > latest)) latest = d.last_edited_time;
    }
    emit({ type: 'STATE', stream: 'databases', cursor: { last_edited_time: latest || prior || null } });
  }

  emit({ type: 'DONE', status: 'succeeded', records_emitted: total });
  flushAndExit(0);
}

main().catch((e) => {
  const msg = e?.message || String(e);
  emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: msg, retryable: /ECONN|fetch failed|rate_limited/i.test(msg) } });
  flushAndExit(1);
});
