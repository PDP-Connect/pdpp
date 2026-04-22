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

import { requireCredentialsOrAsk } from '../../src/scope-filters.js';
import { runConnector, politeDelay } from '../../src/connector-runtime.js';

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

runConnector({
  name: 'notion',
  retryablePattern: /ECONN|fetch failed|rate_limited/i,
  async collect({ state, requested, emit, emitRecord, progress, sendInteraction, emittedAt }) {
    let token = process.env.NOTION_API_TOKEN;
    if (!token) {
      const creds = await requireCredentialsOrAsk({
        required: ['NOTION_API_TOKEN'],
        connectorName: 'Notion',
        sendInteraction,
        
      });
      token = creds.NOTION_API_TOKEN;
    }

    // Notion uses tombstones (archived=true) per PDPP spec. The runtime's
    // emitRecord handles shape-check + resource filter, but tombstones want
    // a stripped data body + op: 'delete'. Wrap to route archived items.
    const emitMaybeTombstone = (s, d) => {
      if (d.archived === true) {
        return emit({ type: 'RECORD', stream: s, key: d.id, data: { id: d.id }, emitted_at: emittedAt, op: 'delete' });
      }
      return emitRecord(s, d);
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
      await politeDelay(400);
    }
    return results;
  }

  if (requested.has('pages')) {
    progress('Searching pages', { stream: 'pages' });
    const pages = await searchAll({ property: 'object', value: 'page' });
    const prior = state.pages?.last_edited_time;
    let latest = prior;
    for (const p of pages) {
      if (prior && p.last_edited_time && p.last_edited_time <= prior) continue;
      emitMaybeTombstone('pages', {
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
    progress('Searching databases', { stream: 'databases' });
    const dbs = await searchAll({ property: 'object', value: 'database' });
    const prior = state.databases?.last_edited_time;
    let latest = prior;
    for (const d of dbs) {
      if (prior && d.last_edited_time && d.last_edited_time <= prior) continue;
      emitMaybeTombstone('databases', {
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
  },
});
