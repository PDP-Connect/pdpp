#!/usr/bin/env node
/**
 * PDPP ChatGPT Connector (v0.1.0)
 *
 * Uses an authenticated Playwright persistent profile (bootstrapped via
 * `pdpp-connectors browser bootstrap`). All fetches happen via
 * page.evaluate(fetch) inside the browser context to preserve Cloudflare
 * TLS fingerprint.
 *
 * Extracts bearer token from #client-bootstrap, device ID from oai-did
 * cookie. Walks conversation tree from root → current_node for each
 * conversation. Incremental via update_time cursor.
 */

import { createInterface } from 'node:readline';
import { launchPersistentContext } from '../../src/browser-profile.js';
import { resourceSet } from '../../src/scope-filters.js';
import { ensureChatGptSession } from '../../src/auto-login/chatgpt.js';

const rl = createInterface({ input: process.stdin, terminal: false });
function emit(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
function flushAndExit(code) {
  if (process.stdout.writableLength > 0) {
    process.stdout.once('drain', () => process.exit(code));
    setTimeout(() => process.exit(code), 3000).unref();
  } else {
    process.exit(code);
  }
}
function fail(m, retryable = false) {
  emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: m, retryable } });
  flushAndExit(1);
}
const nowIso = () => new Date().toISOString();

// Module-level counter so catch block can report accurate records_emitted.
let _totalEmitted = 0;

// ChatGPT times are unix seconds (number). Some responses use ISO strings.
// Normalize both to ISO-8601, swallow errors.
function tsToIso(v) {
  if (v == null) return null;
  try {
    if (typeof v === 'number' && isFinite(v)) {
      const d = new Date(v * 1000);
      if (isNaN(d.getTime())) return null;
      return d.toISOString();
    }
    if (typeof v === 'string') {
      const d = new Date(v);
      if (isNaN(d.getTime())) return null;
      return d.toISOString();
    }
  } catch { /* swallow */ }
  return null;
}

async function getAuthFromPage(page) {
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Wait for client bootstrap to appear
  await page.waitForFunction(() => {
    const el = document.getElementById('client-bootstrap');
    return el && el.textContent && el.textContent.length > 10;
  }, null, { timeout: 20000 }).catch(() => {});

  const auth = await page.evaluate(() => {
    let accessToken = null, deviceId = null;
    const el = document.getElementById('client-bootstrap');
    if (el) {
      try {
        const data = JSON.parse(el.textContent || '{}');
        accessToken = data?.session?.accessToken || null;
      } catch {}
    }
    if (!accessToken && window.__NEXT_DATA__) {
      accessToken = window.__NEXT_DATA__?.props?.pageProps?.session?.accessToken || null;
    }
    const m = (document.cookie || '').match(/oai-did=([^;]+)/);
    if (m) deviceId = decodeURIComponent(m[1]);
    return { accessToken, deviceId };
  });

  return auth;
}

async function apiFetch(page, path, { method = 'GET', body } = {}) {
  const auth = await _auth(page);
  return page.evaluate(async ({ path, method, body, auth }) => {
    const headers = {
      accept: '*/*',
      authorization: `Bearer ${auth.accessToken}`,
      'oai-language': 'en-US',
      'content-type': 'application/json',
    };
    if (auth.deviceId) headers['oai-device-id'] = auth.deviceId;
    const res = await fetch(`https://chatgpt.com/backend-api${path}`, {
      method,
      credentials: 'include',
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const status = res.status;
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status, json };
  }, { path, method, body, auth });
}

// Cache auth for the run
let _authCache = null;
async function _auth(page) {
  if (_authCache) return _authCache;
  const a = await getAuthFromPage(page);
  if (!a.accessToken) throw new Error('chatgpt_auth_missing: could not extract bearer token from #client-bootstrap');
  _authCache = a;
  return a;
}

function flattenTreeCurrentBranch(mapping, currentNodeId) {
  const orderedRootToTip = [];
  // Walk up from current to root, then reverse.
  let id = currentNodeId;
  const visited = new Set();
  while (id && !visited.has(id) && mapping[id]) {
    visited.add(id);
    orderedRootToTip.push(id);
    id = mapping[id].parent ?? null;
  }
  orderedRootToTip.reverse();
  return orderedRootToTip.map((nodeId) => ({ nodeId, node: mapping[nodeId] }));
}

// Extract a string from a ChatGPT message content object. ChatGPT has many
// content_type shapes; the previous implementation only handled `text` and
// silently returned null for everything else (67% of records).
// Each branch returns a string; return null only if the payload is truly empty.
function extractContent(content) {
  if (!content || typeof content !== 'object') return null;
  const type = content.content_type;

  // Canonical user/assistant text: { parts: ["...", {asset_pointer}...] }
  if (type === 'text') {
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const s = parts
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object') {
          if (typeof p.text === 'string') return p.text;
          if (typeof p.asset_pointer === 'string') return `[asset:${p.asset_pointer}]`;
        }
        return '';
      })
      .join('\n')
      .trim();
    return s || null;
  }

  // Assistant-authored tool call bodies (python/browser/bio/etc).
  // { content_type: "code", language, text }
  if (type === 'code') {
    const body = typeof content.text === 'string' ? content.text : '';
    const lang = content.language ? String(content.language) : '';
    if (!body && !lang) return null;
    return lang ? `\`\`\`${lang}\n${body}\n\`\`\`` : body;
  }

  // Reasoning summaries (GPT-5 thinking traces).
  // { content_type: "thoughts", thoughts: [{summary, content}], source_analysis_msg_id? }
  if (type === 'thoughts') {
    const thoughts = Array.isArray(content.thoughts) ? content.thoughts : [];
    const s = thoughts
      .map((t) => {
        if (!t || typeof t !== 'object') return '';
        const summary = typeof t.summary === 'string' ? t.summary : '';
        const body = typeof t.content === 'string' ? t.content : '';
        if (summary && body) return `${summary}\n${body}`;
        return summary || body || '';
      })
      .filter(Boolean)
      .join('\n\n')
      .trim();
    return s || null;
  }

  // { content_type: "reasoning_recap", content: "..." }
  if (type === 'reasoning_recap') {
    if (typeof content.content === 'string') return content.content || null;
    // some variants use `text`
    if (typeof content.text === 'string') return content.text || null;
    return null;
  }

  // Multimodal user input / assistant output.
  // { content_type: "multimodal_text", parts: [string | {text} | {asset_pointer,...} | {content_type:"image_asset_pointer",...}] }
  if (type === 'multimodal_text') {
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const s = parts
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object') {
          if (typeof p.text === 'string') return p.text;
          if (typeof p.asset_pointer === 'string') return `[asset:${p.asset_pointer}]`;
          if (typeof p.content_type === 'string') return `[${p.content_type}]`;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
    return s || null;
  }

  // Browsing tool output.
  // { content_type: "tether_browsing_display", result, summary, assets?, tether_id? }
  if (type === 'tether_browsing_display') {
    const pieces = [];
    if (typeof content.summary === 'string' && content.summary) pieces.push(content.summary);
    if (typeof content.result === 'string' && content.result) pieces.push(content.result);
    const s = pieces.join('\n\n').trim();
    return s || null;
  }

  // Browsing quote (inline citation).
  // { content_type: "tether_quote", url, domain?, text, title }
  if (type === 'tether_quote') {
    const pieces = [];
    if (content.title) pieces.push(String(content.title));
    if (content.url) pieces.push(String(content.url));
    if (typeof content.text === 'string' && content.text) pieces.push(content.text);
    const s = pieces.join('\n').trim();
    return s || null;
  }

  // Python / code-interpreter stdout.
  // { content_type: "execution_output", text }
  if (type === 'execution_output') {
    if (typeof content.text === 'string') return content.text || null;
    return null;
  }

  // "Bio"/memory + custom instructions + connected-repo context.
  // { content_type: "model_editable_context", model_set_context, repository?, repo_summary? }
  if (type === 'model_editable_context') {
    const pieces = [];
    if (typeof content.model_set_context === 'string' && content.model_set_context) {
      pieces.push(content.model_set_context);
    }
    if (typeof content.repository === 'string' && content.repository) {
      pieces.push(`repository: ${content.repository}`);
    }
    if (typeof content.repo_summary === 'string' && content.repo_summary) {
      pieces.push(content.repo_summary);
    }
    const s = pieces.join('\n\n').trim();
    return s || null;
  }

  // Observed but undocumented shapes worth catching.
  if (type === 'system_error') {
    const pieces = [];
    if (content.name) pieces.push(String(content.name));
    if (typeof content.text === 'string' && content.text) pieces.push(content.text);
    return pieces.join(': ').trim() || null;
  }
  if (type === 'user_editable_context') {
    const pieces = [];
    if (typeof content.user_profile === 'string' && content.user_profile) pieces.push(content.user_profile);
    if (typeof content.user_instructions === 'string' && content.user_instructions) pieces.push(content.user_instructions);
    return pieces.join('\n\n').trim() || null;
  }

  // Fallback for unrecognized shape — prefer an explicit handler.
  // Stringify so *something* lands rather than null; truncate to keep rows sane.
  try {
    const s = JSON.stringify(content);
    if (!s || s === '{}' || s === 'null') return null;
    return s.length > 5000 ? s.slice(0, 5000) + '…' : s;
  } catch {
    return null;
  }
}

// Derive tool_calls for a message. ChatGPT does not emit an OpenAI-API-style
// `tool_calls` array on assistant messages; instead, the model "addresses" a
// tool via `message.recipient` (e.g. "python", "browser.search", "bio") and the
// content body carries the call. Synthesize a normalized array.
function extractToolCalls(m) {
  // Some API shapes do include an explicit list.
  if (Array.isArray(m?.metadata?.tool_calls) && m.metadata.tool_calls.length) {
    return m.metadata.tool_calls;
  }
  const recipient = typeof m?.recipient === 'string' ? m.recipient : null;
  const role = m?.author?.role;
  // Assistant messages addressed to a specific tool = a tool call.
  if (role === 'assistant' && recipient && recipient !== 'all') {
    const call = { recipient };
    if (m.content?.content_type) call.content_type = m.content.content_type;
    if (typeof m.content?.language === 'string') call.language = m.content.language;
    if (typeof m.content?.text === 'string') call.text = m.content.text;
    if (m.metadata?.invoked_plugin) call.invoked_plugin = m.metadata.invoked_plugin;
    return [call];
  }
  // Plugin invocation metadata without an explicit tool_calls array.
  if (m?.metadata?.invoked_plugin) {
    return [{ invoked_plugin: m.metadata.invoked_plugin }];
  }
  return [];
}

function extractMessage(nodeId, node, conversationId, onCurrentBranch) {
  const m = node.message;
  if (!m) return null;
  const content = extractContent(m.content);
  return {
    id: nodeId,
    conversation_id: conversationId,
    parent_id: node.parent ?? null,
    children_ids: node.children ?? [],
    role: m.author?.role ?? null,
    content: content || null,
    content_type: m.content?.content_type ?? null,
    model_slug: m.metadata?.model_slug ?? null,
    create_time: tsToIso(m.create_time),
    finish_reason: m.end_turn === false ? 'tool_calls' : (m.metadata?.finish_details?.type ?? null),
    citations: m.metadata?.citations ?? [],
    tool_calls: extractToolCalls(m),
    attachment_ids: (m.metadata?.attachments ?? []).map((a) => a.id).filter(Boolean),
    on_current_branch: onCurrentBranch,
  };
}

async function main() {
  const startMsg = await new Promise((resolve, reject) => {
    rl.once('line', (line) => { try { resolve(JSON.parse(line)); } catch (e) { reject(e); } });
  });
  if (startMsg.type !== 'START') return fail('Expected START');

  const requested = new Map((startMsg.scope?.streams || []).map((s) => [s.name, s]));
  if (!requested.size) return fail('START.scope.streams is required');

  const resFilters = new Map();
  for (const [n, r] of requested) resFilters.set(n, resourceSet(r));

  const state = startMsg.state || {};
  const emittedAt = nowIso();
  const emitRecord = (stream, data) => {
    if (data.id == null) return;
    const resSet = resFilters.get(stream);
    if (resSet && !resSet.has(String(data.id))) return;
    emit({ type: 'RECORD', stream, key: data.id, data, emitted_at: emittedAt });
    _totalEmitted++;
  };

  let context;
  try {
    context = await launchPersistentContext({ headless: true });
  } catch (err) {
    return fail(`could not open browser profile: ${err.message}`, false);
  }

  try {
    const page = await context.newPage();

    // Automated session management: probe first, drive login with stored
    // email/password if dead. Falls back to INTERACTION manual_action if
    // Cloudflare challenge or unexpected UI.
    try {
      await ensureChatGptSession({ context, page, sendInteractionAndWait, nextInteractionId });
    } catch (e) {
      return fail(`chatgpt_session_failed: ${e.message}`, false);
    }

    // Verify session (extract bearer token for /backend-api calls)
    const auth = await _auth(page);
    emit({ type: 'PROGRESS', message: `Authenticated to ChatGPT (device_id=${auth.deviceId ? auth.deviceId.slice(0, 8) + '…' : 'unknown'})` });

    // MEMORIES
    if (requested.has('memories')) {
      emit({ type: 'PROGRESS', stream: 'memories', message: 'Fetching memories' });
      const res = await apiFetch(page, '/memories?include_memory_entries=true');
      if (res.status !== 200) {
        emit({ type: 'SKIP_RESULT', stream: 'memories', reason: 'http_error', message: `memories fetch http ${res.status}` });
      } else {
        const entries = res.json?.memories || res.json?.items || [];
        for (const m of entries) {
          emitRecord('memories', {
            id: m.id,
            content: m.content || m.name || '',
            created_at: m.created_at || null,
            updated_at: m.updated_at || null,
          });
        }
        emit({ type: 'STATE', stream: 'memories', cursor: { fetched_at: nowIso() } });
      }
    }

    // CONVERSATIONS — list + per-conversation detail
    if (requested.has('conversations') || requested.has('messages')) {
      const priorCursor = state.conversations?.last_update_time || null;

      const convosToSync = [];
      let offset = 0;
      const limit = 100;
      let stopPaging = false;
      emit({ type: 'PROGRESS', stream: 'conversations', message: 'Listing conversations' });
      while (!stopPaging) {
        const res = await apiFetch(page, `/conversations?offset=${offset}&limit=${limit}&order=updated`);
        if (res.status !== 200) {
          emit({ type: 'SKIP_RESULT', stream: 'conversations', reason: 'http_error', message: `conversations list http ${res.status}` });
          break;
        }
        const items = res.json?.items || [];
        if (!items.length) break;
        for (const c of items) {
          const updateIso = c.update_time ? tsToIso(c.update_time) : null;
          if (priorCursor && updateIso && updateIso <= priorCursor) {
            stopPaging = true;
            break;
          }
          convosToSync.push(c);
        }
        if (items.length < limit) break;
        offset += items.length;
        if (offset > 5000) break; // safety
      }

      emit({ type: 'PROGRESS', stream: 'conversations', message: `Found ${convosToSync.length} conversations to sync` });

      const emitConversation = (c, detail) => {
        if (!requested.has('conversations')) return;
        // gizmo_id, workspace_id, current_node, message_count_on_current_branch
        // are absent from the list endpoint and only show up in /conversation/{id}.
        // Fall back to list values when no detail was fetched (conversations-only sync).
        const mapping = detail?.mapping || null;
        const currentNode = detail?.current_node ?? c.current_node ?? null;
        let branchCount = null;
        if (mapping && currentNode) {
          branchCount = flattenTreeCurrentBranch(mapping, currentNode)
            .filter((x) => x.node?.message?.author?.role).length;
        }
        emitRecord('conversations', {
          id: c.id,
          title: (detail?.title ?? c.title) || null,
          create_time: tsToIso(detail?.create_time ?? c.create_time),
          update_time: tsToIso(detail?.update_time ?? c.update_time),
          is_archived: (detail?.is_archived ?? c.is_archived) ?? null,
          is_starred: (detail?.is_starred ?? c.is_starred) ?? null,
          workspace_id: (detail?.workspace_id ?? c.workspace_id) || null,
          current_node: currentNode || null,
          message_count_on_current_branch: branchCount,
          gizmo_id: (detail?.gizmo_id ?? c.gizmo_id) || null,
        });
      };

      // Messages: for each conversation, fetch detail and emit messages along current branch.
      // Conversation records are emitted here too (after detail is fetched) so the
      // detail-only fields (gizmo_id, workspace_id, current_node, message_count_on_current_branch)
      // can be populated.
      if (requested.has('messages')) {
        const BATCH = 3; // conservative concurrency
        for (let i = 0; i < convosToSync.length; i += BATCH) {
          const batch = convosToSync.slice(i, i + BATCH);
          const results = await Promise.all(batch.map((c) => apiFetch(page, `/conversation/${encodeURIComponent(c.id)}`)));
          for (let j = 0; j < batch.length; j++) {
            const c = batch[j];
            const detail = results[j];
            if (detail.status !== 200 || !detail.json?.mapping) {
              emit({ type: 'SKIP_RESULT', stream: 'messages', reason: 'http_error', message: `conversation ${c.id} http ${detail.status}` });
              // Fall back to list-only conversation record.
              emitConversation(c, null);
              continue;
            }
            const mapping = detail.json.mapping;
            const currentNode = detail.json.current_node || c.current_node;
            const currentBranchIds = new Set(flattenTreeCurrentBranch(mapping, currentNode).map((x) => x.nodeId));
            for (const [nodeId, node] of Object.entries(mapping)) {
              const msg = extractMessage(nodeId, node, c.id, currentBranchIds.has(nodeId));
              if (!msg) continue;
              if (!msg.role) continue; // synthetic root
              emitRecord('messages', msg);
            }
            emitConversation(c, detail.json);
          }
          emit({ type: 'PROGRESS', stream: 'messages', message: `Synced ${Math.min(i + BATCH, convosToSync.length)} / ${convosToSync.length} conversations` });
          await new Promise((r) => setTimeout(r, 200));
        }
      } else if (requested.has('conversations')) {
        // Conversations-only sync: emit from list (detail fields stay null).
        for (const c of convosToSync) emitConversation(c, null);
      }

      if (convosToSync.length) {
        const maxUpdate = convosToSync
          .map((c) => c.update_time ? tsToIso(c.update_time) : null)
          .filter(Boolean)
          .sort()
          .pop();
        emit({
          type: 'STATE',
          stream: 'conversations',
          cursor: { last_update_time: maxUpdate || priorCursor || null },
        });
      }
    }
  } finally {
    await context.close().catch(() => {});
  }

  emit({ type: 'DONE', status: 'succeeded', records_emitted: _totalEmitted });
  flushAndExit(0);
}

main().catch((e) => {
  const msg = e && e.message ? e.message : String(e);
  const retryable = /ECONN|ETIMEDOUT|fetch failed|429/i.test(msg);
  emit({ type: 'DONE', status: 'failed', records_emitted: _totalEmitted, error: { message: msg, retryable } });
  flushAndExit(1);
});
