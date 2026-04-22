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

import pRetry, { AbortError } from "p-retry";
import type { Page } from "playwright";
import { ensureChatGptSession } from "../../src/auto-login/chatgpt.ts";
import {
  type BrowserCollectContext,
  type CollectContext,
  nowIso,
  type RecordData,
  runConnector,
  type ValidateRecord,
} from "../../src/connector-runtime.ts";
import type { CaptureSession } from "../../src/fixture-capture.ts";
import { validateRecord as validateRecordRaw } from "./schemas.ts";

// schemas.js is a plain-JS Zod validator; cast at the boundary to the
// runtime's ValidateRecord contract. The JS module's safeParse already
// returns { ok, data, issues } in the shape the runtime expects.
const validateRecord = validateRecordRaw as ValidateRecord;

// ─── ChatGPT API shapes (from /backend-api responses) ───────────────────

interface ChatGptAuth {
  accessToken: string | null;
  deviceId: string | null;
}

interface ChatGptFetchResult {
  json: ChatGptJson | null;
  status: number;
}

// The JSON bodies vary by endpoint; we deliberately keep these loose but typed.
interface ChatGptJson {
  about_model_message?: string | null;
  about_user?: string | null;
  about_user_message?: string | null;
  create_time?: number | string | null;
  current_node?: string | null;
  cursor?: string | null;
  enabled?: boolean | null;
  gizmo_id?: string | null;
  gizmos?: unknown[];
  is_archived?: boolean | null;
  is_starred?: boolean | null;
  items?: unknown[];
  mapping?: Record<string, ChatGptNode>;
  memories?: unknown[];
  response_style?: string | null;
  title?: string | null;
  update_time?: number | string | null;
  update_time_detail?: number | string | null;
  updated_at?: number | string | null;
  workspace_id?: string | null;
  [field: string]: unknown;
}

interface ChatGptContent {
  assets?: unknown;
  content?: string;
  content_type?: string;
  domain?: string;
  language?: string;
  model_set_context?: string;
  name?: string;
  parts?: unknown[];
  repo_summary?: string;
  repository?: string;
  result?: string;
  summary?: string;
  tether_id?: string;
  text?: string;
  thoughts?: unknown[];
  title?: string;
  url?: string;
  user_instructions?: string;
  user_profile?: string;
  [field: string]: unknown;
}

interface ChatGptMessage {
  author?: { role?: string | null };
  content?: ChatGptContent;
  create_time?: number | string | null;
  end_turn?: boolean;
  id?: string;
  metadata?: {
    model_slug?: string | null;
    finish_details?: { type?: string | null };
    citations?: unknown[];
    tool_calls?: unknown[];
    attachments?: Array<{ id?: string }>;
    invoked_plugin?: unknown;
    [field: string]: unknown;
  };
  recipient?: string;
  [field: string]: unknown;
}

interface ChatGptNode {
  children?: string[];
  message?: ChatGptMessage;
  parent?: string | null;
  [field: string]: unknown;
}

interface ConversationListItem {
  create_time?: number | string | null;
  current_node?: string | null;
  gizmo_id?: string | null;
  id: string;
  is_archived?: boolean | null;
  is_starred?: boolean | null;
  title?: string | null;
  update_time?: number | string | null;
  workspace_id?: string | null;
  [field: string]: unknown;
}

interface ToolCallSynthetic {
  content_type?: string;
  invoked_plugin?: unknown;
  language?: string;
  recipient?: string;
  text?: string;
}

interface ChatGptApi {
  auth: () => Promise<ChatGptAuth>;
  fetch: (
    path: string,
    opts?: { method?: string; body?: unknown }
  ) => Promise<ChatGptFetchResult>;
}

// ─── Helpers ────────────────────────────────────────────────────────────

// ChatGPT times are unix seconds (number). Some responses use ISO strings.
// Normalize both to ISO-8601, swallow errors.
function tsToIso(v: unknown): string | null {
  if (v == null) {
    return null;
  }
  try {
    if (typeof v === "number" && Number.isFinite(v)) {
      const d = new Date(v * 1000);
      if (Number.isNaN(d.getTime())) {
        return null;
      }
      return d.toISOString();
    }
    if (typeof v === "string") {
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) {
        return null;
      }
      return d.toISOString();
    }
  } catch {
    /* swallow */
  }
  return null;
}

async function getAuthFromPage(page: Page): Promise<ChatGptAuth> {
  await page.goto("https://chatgpt.com/", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  // Wait for client bootstrap to appear
  await page
    .waitForFunction(
      () => {
        // @ts-expect-error — browser context, `document` exists at runtime
        const el = document.getElementById("client-bootstrap");
        return el?.textContent && el.textContent.length > 10;
      },
      null,
      { timeout: 20_000 }
    )
    .catch((): undefined => undefined);

  const auth = (await page.evaluate(() => {
    let accessToken: string | null = null;
    let deviceId: string | null = null;
    // @ts-expect-error — browser context globals
    const el = document.getElementById("client-bootstrap");
    if (el) {
      try {
        const data = JSON.parse(el.textContent || "{}");
        accessToken = data?.session?.accessToken || null;
      } catch {
        /* ignore */
      }
    }
    // @ts-expect-error — browser context globals
    if (!accessToken && window.__NEXT_DATA__) {
      accessToken =
        // @ts-expect-error — browser context globals
        window.__NEXT_DATA__?.props?.pageProps?.session?.accessToken || null;
    }
    // @ts-expect-error — browser context globals
    // biome-ignore lint/performance/useTopLevelRegex: runs in browser context (page.evaluate); module-scoped regexes in Node cannot cross the bridge.
    const m = (document.cookie || "").match(/oai-did=([^;]+)/);
    if (m) {
      deviceId = decodeURIComponent(m[1]);
    }
    return { accessToken, deviceId };
  })) as ChatGptAuth;

  return auth;
}

/**
 * Build a ChatGPT API client bound to this run's page + capture session.
 *
 * The client closes over page + capture so call sites read like plain HTTP:
 *     const res = await api.fetch('/conversations?offset=0');
 *
 * Auth is cached inside the closure — no module-level mutable state. Every
 * successful response is auto-captured when PDPP_CAPTURE_FIXTURES=1.
 *
 * Retry policy (via p-retry):
 *   - Retryable: 429, 502/503/504, browser-level network errors
 *   - Terminal (AbortError): 401/403 (auth dead); 4xx except 429
 *   - Caller decides what to do with a successful response body
 */
function createChatGptApi({
  page,
  capture,
}: {
  page: Page;
  capture: CaptureSession | null;
}): ChatGptApi {
  let authCache: ChatGptAuth | null = null;
  async function auth(): Promise<ChatGptAuth> {
    if (authCache) {
      return authCache;
    }
    const fresh = await getAuthFromPage(page);
    if (!fresh.accessToken) {
      throw new Error(
        "chatgpt_auth_missing: could not extract bearer token from #client-bootstrap"
      );
    }
    authCache = fresh;
    return fresh;
  }

  async function fetchOnce(
    path: string,
    { method, body }: { method: string; body?: unknown }
  ): Promise<ChatGptFetchResult> {
    const a = await auth();
    return (await page.evaluate(
      async ({ path, method, body, auth }) => {
        const headers: Record<string, string> = {
          accept: "*/*",
          authorization: `Bearer ${auth.accessToken}`,
          "oai-language": "en-US",
          "content-type": "application/json",
        };
        if (auth.deviceId) {
          headers["oai-device-id"] = auth.deviceId;
        }
        // @ts-expect-error — browser context globals (fetch)
        const res = await fetch(`https://chatgpt.com/backend-api${path}`, {
          method,
          credentials: "include",
          headers,
          body: body ? JSON.stringify(body) : undefined,
        });
        const status = res.status;
        let json: unknown = null;
        try {
          json = await res.json();
        } catch {
          json = null;
        }
        return { status, json };
      },
      { path, method, body, auth: a }
    )) as ChatGptFetchResult;
  }

  return {
    auth,
    fetch(
      path: string,
      { method = "GET", body }: { method?: string; body?: unknown } = {}
    ): Promise<ChatGptFetchResult> {
      return pRetry(
        async () => {
          let result: ChatGptFetchResult;
          try {
            result = await fetchOnce(path, { method, body });
          } catch (err) {
            const m = err instanceof Error ? err.message : String(err);
            throw new Error(
              `apiFetch network error on ${method} ${path}: ${m}`
            );
          }
          const { status } = result;
          if (
            status === 429 ||
            status === 502 ||
            status === 503 ||
            status === 504
          ) {
            throw new Error(`apiFetch got ${status} on ${method} ${path}`);
          }
          if (status === 401 || status === 403) {
            throw new AbortError(
              `apiFetch got ${status} on ${method} ${path} (auth — not retryable)`
            );
          }
          if (capture) {
            capture.captureHttp(`${method}-${path}`, result.json, {
              status,
              path,
              method,
            });
          }
          return result;
        },
        { retries: 3, minTimeout: 1500, factor: 2 }
      );
    },
  };
}

function flattenTreeCurrentBranch(
  mapping: Record<string, ChatGptNode>,
  currentNodeId: string | null | undefined
): Array<{ nodeId: string; node: ChatGptNode }> {
  const orderedRootToTip: string[] = [];
  // Walk up from current to root, then reverse.
  let id: string | null | undefined = currentNodeId;
  const visited = new Set<string>();
  while (id && !visited.has(id) && mapping[id]) {
    visited.add(id);
    orderedRootToTip.push(id);
    id = mapping[id]?.parent ?? null;
  }
  orderedRootToTip.reverse();
  return orderedRootToTip.map((nodeId) => {
    const node = mapping[nodeId];
    if (!node) {
      // visited.has + mapping[id] guard above guarantees presence.
      throw new Error(`flattenTreeCurrentBranch: missing node ${nodeId}`);
    }
    return { nodeId, node };
  });
}

// Extract a string from a ChatGPT message content object. ChatGPT has many
// content_type shapes; the previous implementation only handled `text` and
// silently returned null for everything else (67% of records).
// Each branch returns a string; return null only if the payload is truly empty.
function extractContent(content: ChatGptContent | undefined): string | null {
  if (!content || typeof content !== "object") {
    return null;
  }
  const type = content.content_type;

  // Canonical user/assistant text: { parts: ["...", {asset_pointer}...] }
  if (type === "text") {
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const s = parts
      .map((p) => {
        if (typeof p === "string") {
          return p;
        }
        if (p && typeof p === "object") {
          const po = p as { text?: unknown; asset_pointer?: unknown };
          if (typeof po.text === "string") {
            return po.text;
          }
          if (typeof po.asset_pointer === "string") {
            return `[asset:${po.asset_pointer}]`;
          }
        }
        return "";
      })
      .join("\n")
      .trim();
    return s || null;
  }

  // Assistant-authored tool call bodies (python/browser/bio/etc).
  // { content_type: "code", language, text }
  if (type === "code") {
    const body = typeof content.text === "string" ? content.text : "";
    const lang = content.language ? String(content.language) : "";
    if (!(body || lang)) {
      return null;
    }
    return lang ? `\`\`\`${lang}\n${body}\n\`\`\`` : body;
  }

  // Reasoning summaries (GPT-5 thinking traces).
  // { content_type: "thoughts", thoughts: [{summary, content}], source_analysis_msg_id? }
  if (type === "thoughts") {
    const thoughts = Array.isArray(content.thoughts) ? content.thoughts : [];
    const s = thoughts
      .map((t) => {
        if (!t || typeof t !== "object") {
          return "";
        }
        const to = t as { summary?: unknown; content?: unknown };
        const summary = typeof to.summary === "string" ? to.summary : "";
        const body = typeof to.content === "string" ? to.content : "";
        if (summary && body) {
          return `${summary}\n${body}`;
        }
        return summary || body || "";
      })
      .filter(Boolean)
      .join("\n\n")
      .trim();
    return s || null;
  }

  // { content_type: "reasoning_recap", content: "..." }
  if (type === "reasoning_recap") {
    if (typeof content.content === "string") {
      return content.content || null;
    }
    // some variants use `text`
    if (typeof content.text === "string") {
      return content.text || null;
    }
    return null;
  }

  // Multimodal user input / assistant output.
  // { content_type: "multimodal_text", parts: [string | {text} | {asset_pointer,...} | {content_type:"image_asset_pointer",...}] }
  if (type === "multimodal_text") {
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const s = parts
      .map((p) => {
        if (typeof p === "string") {
          return p;
        }
        if (p && typeof p === "object") {
          const po = p as {
            text?: unknown;
            asset_pointer?: unknown;
            content_type?: unknown;
          };
          if (typeof po.text === "string") {
            return po.text;
          }
          if (typeof po.asset_pointer === "string") {
            return `[asset:${po.asset_pointer}]`;
          }
          if (typeof po.content_type === "string") {
            return `[${po.content_type}]`;
          }
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
    return s || null;
  }

  // Browsing tool output.
  // { content_type: "tether_browsing_display", result, summary, assets?, tether_id? }
  if (type === "tether_browsing_display") {
    const pieces: string[] = [];
    if (typeof content.summary === "string" && content.summary) {
      pieces.push(content.summary);
    }
    if (typeof content.result === "string" && content.result) {
      pieces.push(content.result);
    }
    const s = pieces.join("\n\n").trim();
    return s || null;
  }

  // Browsing quote (inline citation).
  // { content_type: "tether_quote", url, domain?, text, title }
  if (type === "tether_quote") {
    const pieces: string[] = [];
    if (content.title) {
      pieces.push(String(content.title));
    }
    if (content.url) {
      pieces.push(String(content.url));
    }
    if (typeof content.text === "string" && content.text) {
      pieces.push(content.text);
    }
    const s = pieces.join("\n").trim();
    return s || null;
  }

  // Python / code-interpreter stdout.
  // { content_type: "execution_output", text }
  if (type === "execution_output") {
    if (typeof content.text === "string") {
      return content.text || null;
    }
    return null;
  }

  // "Bio"/memory + custom instructions + connected-repo context.
  // { content_type: "model_editable_context", model_set_context, repository?, repo_summary? }
  if (type === "model_editable_context") {
    const pieces: string[] = [];
    if (
      typeof content.model_set_context === "string" &&
      content.model_set_context
    ) {
      pieces.push(content.model_set_context);
    }
    if (typeof content.repository === "string" && content.repository) {
      pieces.push(`repository: ${content.repository}`);
    }
    if (typeof content.repo_summary === "string" && content.repo_summary) {
      pieces.push(content.repo_summary);
    }
    const s = pieces.join("\n\n").trim();
    return s || null;
  }

  // Observed but undocumented shapes worth catching.
  if (type === "system_error") {
    const pieces: string[] = [];
    if (content.name) {
      pieces.push(String(content.name));
    }
    if (typeof content.text === "string" && content.text) {
      pieces.push(content.text);
    }
    return pieces.join(": ").trim() || null;
  }
  if (type === "user_editable_context") {
    const pieces: string[] = [];
    if (typeof content.user_profile === "string" && content.user_profile) {
      pieces.push(content.user_profile);
    }
    if (
      typeof content.user_instructions === "string" &&
      content.user_instructions
    ) {
      pieces.push(content.user_instructions);
    }
    return pieces.join("\n\n").trim() || null;
  }

  // Fallback for unrecognized shape — prefer an explicit handler.
  // Stringify so *something* lands rather than null; truncate to keep rows sane.
  try {
    const s = JSON.stringify(content);
    if (!s || s === "{}" || s === "null") {
      return null;
    }
    return s.length > 5000 ? `${s.slice(0, 5000)}…` : s;
  } catch {
    return null;
  }
}

// Derive tool_calls for a message. ChatGPT does not emit an OpenAI-API-style
// `tool_calls` array on assistant messages; instead, the model "addresses" a
// tool via `message.recipient` (e.g. "python", "browser.search", "bio") and the
// content body carries the call. Synthesize a normalized array.
function extractToolCalls(m: ChatGptMessage | undefined): unknown[] {
  // Some API shapes do include an explicit list.
  if (Array.isArray(m?.metadata?.tool_calls) && m.metadata.tool_calls.length) {
    return m.metadata.tool_calls;
  }
  const recipient = typeof m?.recipient === "string" ? m.recipient : null;
  const role = m?.author?.role;
  // Assistant messages addressed to a specific tool = a tool call.
  if (role === "assistant" && recipient && recipient !== "all") {
    const call: ToolCallSynthetic = { recipient };
    if (m?.content?.content_type) {
      call.content_type = m.content.content_type;
    }
    if (typeof m?.content?.language === "string") {
      call.language = m.content.language;
    }
    if (typeof m?.content?.text === "string") {
      call.text = m.content.text;
    }
    if (m?.metadata?.invoked_plugin) {
      call.invoked_plugin = m.metadata.invoked_plugin;
    }
    return [call];
  }
  // Plugin invocation metadata without an explicit tool_calls array.
  if (m?.metadata?.invoked_plugin) {
    return [{ invoked_plugin: m.metadata.invoked_plugin }];
  }
  return [];
}

function extractMessage(
  nodeId: string,
  node: ChatGptNode,
  conversationId: string,
  onCurrentBranch: boolean
): RecordData | null {
  const m = node.message;
  if (!m) {
    return null;
  }
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
    finish_reason:
      m.end_turn === false
        ? "tool_calls"
        : (m.metadata?.finish_details?.type ?? null),
    citations: m.metadata?.citations ?? [],
    tool_calls: extractToolCalls(m),
    attachment_ids: (m.metadata?.attachments ?? [])
      .map((a) => a.id)
      .filter(Boolean),
    on_current_branch: onCurrentBranch,
  };
}

runConnector({
  name: "chatgpt",
  validateRecord,
  browser: { profileName: "chatgpt" },
  async ensureSession({ context, page, sendInteraction }) {
    await ensureChatGptSession({
      context,
      page,
      sendInteraction,
    });
  },
  async collect(ctx: CollectContext | BrowserCollectContext): Promise<void> {
    const {
      state,
      requested,
      emit,
      emitRecord: baseEmitRecord,
      progress,
      capture,
    } = ctx;
    const { page } = ctx as BrowserCollectContext;

    // API client closes over page + capture — no module-level mutable state,
    // auth cached inside the closure for the run's lifetime.
    const api = createChatGptApi({ page, capture });

    // ChatGPT-specific wrapper: unstringifiable values (bad Date, circular
    // refs) historically crashed the whole run when the runtime's shape-check
    // tried to serialize them into a SKIP_RESULT diagnostic. Guard here so
    // "Invalid time value" points at the offending row instead of killing
    // the run.
    const emitRecord = (stream: string, data: RecordData): Promise<void> => {
      if (data?.id != null) {
        try {
          JSON.stringify(data);
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `[chatgpt-debug] emit failed for ${stream} id=${String(data.id)}: ${m}\n`
          );
          return Promise.resolve();
        }
      }
      return baseEmitRecord(stream, data);
    };

    // Verify session (extract bearer token for /backend-api calls)
    const auth = await api.auth();
    progress(
      `Authenticated to ChatGPT (device_id=${auth.deviceId ? `${auth.deviceId.slice(0, 8)}…` : "unknown"})`
    );

    // MEMORIES
    if (requested.has("memories")) {
      emit({
        type: "PROGRESS",
        stream: "memories",
        message: "Fetching memories",
      });
      const res = await api.fetch("/memories?include_memory_entries=true");
      if (res.status === 200) {
        const entries =
          (res.json?.memories as
            | Array<{
                id?: string;
                content?: string;
                name?: string;
                created_at?: string | null;
                updated_at?: string | null;
              }>
            | undefined) ||
          (res.json?.items as
            | Array<{
                id?: string;
                content?: string;
                name?: string;
                created_at?: string | null;
                updated_at?: string | null;
              }>
            | undefined) ||
          [];
        for (const m of entries) {
          if (m.id == null) {
            continue;
          }
          emitRecord("memories", {
            id: m.id,
            content: m.content || m.name || "",
            created_at: m.created_at || null,
            updated_at: m.updated_at || null,
          });
        }
        emit({
          type: "STATE",
          stream: "memories",
          cursor: { fetched_at: nowIso() },
        });
      } else {
        emit({
          type: "SKIP_RESULT",
          stream: "memories",
          reason: "http_error",
          message: `memories fetch http ${res.status}`,
        });
      }
    }

    // CUSTOM GPTS (gizmos authored by the user)
    // Endpoint: GET /backend-api/gizmos/mine returns { items: [{ resource: { gizmo: {...} } }], cursor }
    // Some tenants return a flat { items: [{ id, short_url, display, config, ... }] } shape;
    // handle both by unwrapping a `resource.gizmo` / `resource` wrapper when present.
    if (requested.has("custom_gpts")) {
      emit({
        type: "PROGRESS",
        stream: "custom_gpts",
        message: "Fetching custom GPTs",
      });
      let cursor: string | null = null;
      let pages = 0;
      let anyError = false;
      do {
        const qs = cursor
          ? `?cursor=${encodeURIComponent(cursor)}&limit=100`
          : "?limit=100";
        const res = await api.fetch(`/gizmos/mine${qs}`);
        if (res.status === 404 || res.status === 403) {
          emit({
            type: "SKIP_RESULT",
            stream: "custom_gpts",
            reason: "not_available",
            message: `gizmos/mine http ${res.status} (feature may be disabled for this account)`,
          });
          anyError = true;
          break;
        }
        if (res.status !== 200) {
          emit({
            type: "SKIP_RESULT",
            stream: "custom_gpts",
            reason: "http_error",
            message: `gizmos/mine http ${res.status}`,
          });
          anyError = true;
          break;
        }
        const items =
          (res.json?.items as unknown[] | undefined) ||
          (res.json?.gizmos as unknown[] | undefined) ||
          [];
        for (const raw of items) {
          // Unwrap {resource: {gizmo: {...}}} or {resource: {...}} shapes.
          const rawObj = raw as {
            resource?: { gizmo?: unknown };
            gizmo?: unknown;
          };
          const g =
            (rawObj?.resource as { gizmo?: unknown })?.gizmo ||
            rawObj?.resource ||
            rawObj?.gizmo ||
            raw;
          const gObj = g as
            | {
                id?: string;
                short_url?: string;
                shortcode?: string;
                display?: {
                  name?: string;
                  description?: string;
                  welcome_message?: string;
                  tags?: unknown[];
                  category?: string;
                };
                config?: { tools?: unknown[]; instructions?: string };
                author?: {
                  user_id?: string;
                  id?: string;
                  display_name?: string;
                  name?: string;
                };
                owner?: {
                  user_id?: string;
                  id?: string;
                  display_name?: string;
                  name?: string;
                };
                name?: string;
                instructions?: string;
                created_at?: number | string | null;
                create_time?: number | string | null;
                updated_at?: number | string | null;
                update_time?: number | string | null;
                is_public?: boolean;
                sharing?: string;
                category?: string;
                tags?: unknown[];
              }
            | null
            | undefined;
          if (!gObj?.id) {
            continue;
          }
          const display = gObj.display || {};
          const config = gObj.config || {};
          const author = gObj.author || gObj.owner || {};
          const toolsRaw = Array.isArray(config.tools) ? config.tools : [];
          const tools = toolsRaw
            .map((t) => {
              if (typeof t === "string") {
                return t;
              }
              const to = t as { type?: unknown; name?: unknown };
              return (to?.type || to?.name || null) as string | null;
            })
            .filter(Boolean);
          const tagsRaw = gObj.tags || display.tags || [];
          emitRecord("custom_gpts", {
            id: gObj.id,
            short_url: gObj.short_url || gObj.shortcode || null,
            display_name: display.name || gObj.name || null,
            display_description: display.description || null,
            display_welcome_message: display.welcome_message || null,
            instructions: config.instructions || gObj.instructions || null,
            tools,
            created_at: tsToIso(gObj.created_at ?? gObj.create_time),
            updated_at: tsToIso(gObj.updated_at ?? gObj.update_time),
            author_id: author.user_id || author.id || null,
            author_name: author.display_name || author.name || null,
            is_public: ((): boolean | null => {
              if (typeof gObj.is_public === "boolean") {
                return gObj.is_public;
              }
              if (typeof gObj.sharing === "string") {
                return gObj.sharing === "public";
              }
              return null;
            })(),
            category: gObj.category || display.category || null,
            tags: Array.isArray(tagsRaw) ? tagsRaw : [],
          });
        }
        cursor = (res.json?.cursor as string | null | undefined) ?? null;
        pages++;
        if (pages > 50) {
          break;
        } // safety
        if (!items.length) {
          break;
        }
      } while (cursor);
      if (!anyError) {
        emit({
          type: "STATE",
          stream: "custom_gpts",
          cursor: { fetched_at: nowIso() },
        });
      }
    }

    // CUSTOM INSTRUCTIONS (singleton per user)
    // Endpoint: GET /backend-api/user_system_messages returns
    //   { object: "user_system_message_detail", enabled, about_user_message, about_model_message, ... }
    // If the user has never saved custom instructions the fields are empty strings;
    // we still emit a singleton record so downstream consumers see a stable ID.
    if (requested.has("custom_instructions")) {
      emit({
        type: "PROGRESS",
        stream: "custom_instructions",
        message: "Fetching custom instructions",
      });
      const res = await api.fetch("/user_system_messages");
      if (res.status === 404 || res.status === 403) {
        emit({
          type: "SKIP_RESULT",
          stream: "custom_instructions",
          reason: "not_available",
          message: `user_system_messages http ${res.status}`,
        });
      } else if (res.status === 200) {
        const j = res.json || {};
        emitRecord("custom_instructions", {
          id: "user_custom_instructions",
          about_user: j.about_user_message ?? j.about_user ?? null,
          response_style: j.about_model_message ?? j.response_style ?? null,
          enabled: typeof j.enabled === "boolean" ? j.enabled : null,
          updated_at: tsToIso(j.updated_at ?? j.update_time_detail),
        });
        emit({
          type: "STATE",
          stream: "custom_instructions",
          cursor: { fetched_at: nowIso() },
        });
      } else {
        emit({
          type: "SKIP_RESULT",
          stream: "custom_instructions",
          reason: "http_error",
          message: `user_system_messages http ${res.status}`,
        });
      }
    }

    // SHARED CONVERSATIONS (public shares the user has created)
    // Endpoint: GET /backend-api/shared_conversations?order=created&offset=&limit=
    //   returns { items: [{ id, conversation_id, title, create_time, is_anonymous, is_public, highlighted_text? }], total }
    // The URL slug is the share id; the public URL is https://chatgpt.com/share/<id>.
    if (requested.has("shared_conversations")) {
      emit({
        type: "PROGRESS",
        stream: "shared_conversations",
        message: "Fetching shared conversations",
      });
      let offset = 0;
      const limit = 100;
      const stopPaging = false;
      let sawError = false;
      while (!stopPaging) {
        const res = await api.fetch(
          `/shared_conversations?offset=${offset}&limit=${limit}&order=created`
        );
        if (res.status === 404 || res.status === 403) {
          emit({
            type: "SKIP_RESULT",
            stream: "shared_conversations",
            reason: "not_available",
            message: `shared_conversations http ${res.status}`,
          });
          sawError = true;
          break;
        }
        if (res.status !== 200) {
          emit({
            type: "SKIP_RESULT",
            stream: "shared_conversations",
            reason: "http_error",
            message: `shared_conversations http ${res.status}`,
          });
          sawError = true;
          break;
        }
        const items =
          (res.json?.items as
            | Array<{
                id?: string;
                share_id?: string;
                conversation_id?: string;
                share_url?: string;
                title?: string;
                create_time?: number | string | null;
                created_at?: number | string | null;
                is_anonymous?: boolean;
                anonymous?: boolean;
                is_public?: boolean;
                highlighted_text?: string;
              }>
            | undefined) || [];
        if (!items.length) {
          break;
        }
        for (const s of items) {
          const shareId = s.id || s.share_id;
          if (!shareId) {
            continue;
          }
          emitRecord("shared_conversations", {
            id: shareId,
            conversation_id: s.conversation_id || null,
            share_url: s.share_url || `https://chatgpt.com/share/${shareId}`,
            title: s.title || null,
            created_at: tsToIso(s.create_time ?? s.created_at),
            anonymous: ((): boolean | null => {
              if (typeof s.is_anonymous === "boolean") {
                return s.is_anonymous;
              }
              if (typeof s.anonymous === "boolean") {
                return s.anonymous;
              }
              return null;
            })(),
            is_public: typeof s.is_public === "boolean" ? s.is_public : null,
            highlighted_text: s.highlighted_text || null,
          });
        }
        if (items.length < limit) {
          break;
        }
        offset += items.length;
        if (offset > 5000) {
          break;
        } // safety
      }
      if (!sawError) {
        emit({
          type: "STATE",
          stream: "shared_conversations",
          cursor: { fetched_at: nowIso() },
        });
      }
    }

    // CONVERSATIONS — list + per-conversation detail
    if (requested.has("conversations") || requested.has("messages")) {
      const conversationsCursor = state.conversations as
        | { last_update_time?: string | null }
        | undefined;
      const priorCursor = conversationsCursor?.last_update_time || null;

      const convosToSync: ConversationListItem[] = [];
      let offset = 0;
      const limit = 100;
      let stopPaging = false;
      emit({
        type: "PROGRESS",
        stream: "conversations",
        message: "Listing conversations",
      });
      while (!stopPaging) {
        const res = await api.fetch(
          `/conversations?offset=${offset}&limit=${limit}&order=updated`
        );
        if (res.status !== 200) {
          emit({
            type: "SKIP_RESULT",
            stream: "conversations",
            reason: "http_error",
            message: `conversations list http ${res.status}`,
          });
          break;
        }
        const items =
          (res.json?.items as ConversationListItem[] | undefined) || [];
        if (!items.length) {
          break;
        }
        for (const c of items) {
          const updateIso = c.update_time ? tsToIso(c.update_time) : null;
          if (priorCursor && updateIso && updateIso <= priorCursor) {
            stopPaging = true;
            break;
          }
          convosToSync.push(c);
        }
        if (items.length < limit) {
          break;
        }
        offset += items.length;
        if (offset > 5000) {
          break;
        } // safety
      }

      emit({
        type: "PROGRESS",
        stream: "conversations",
        message: `Found ${convosToSync.length} conversations to sync`,
      });

      const emitConversation = (
        c: ConversationListItem,
        detail: ChatGptJson | null
      ): void => {
        if (!requested.has("conversations")) {
          return;
        }
        // gizmo_id, workspace_id, current_node, message_count_on_current_branch
        // are absent from the list endpoint and only show up in /conversation/{id}.
        // Fall back to list values when no detail was fetched (conversations-only sync).
        const mapping = detail?.mapping || null;
        const currentNode = detail?.current_node ?? c.current_node ?? null;
        let branchCount: number | null = null;
        if (mapping && currentNode) {
          branchCount = flattenTreeCurrentBranch(mapping, currentNode).filter(
            (x) => x.node?.message?.author?.role
          ).length;
        }
        emitRecord("conversations", {
          id: c.id,
          title: (detail?.title ?? c.title) || null,
          create_time: tsToIso(detail?.create_time ?? c.create_time),
          update_time: tsToIso(detail?.update_time ?? c.update_time),
          is_archived: detail?.is_archived ?? c.is_archived ?? null,
          is_starred: detail?.is_starred ?? c.is_starred ?? null,
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
      if (requested.has("messages")) {
        const BATCH = 3; // conservative concurrency
        for (let i = 0; i < convosToSync.length; i += BATCH) {
          const batch = convosToSync.slice(i, i + BATCH);
          const results = await Promise.all(
            batch.map((c) =>
              api.fetch(`/conversation/${encodeURIComponent(c.id)}`)
            )
          );
          for (let j = 0; j < batch.length; j++) {
            const c = batch[j];
            const detail = results[j];
            if (!(c && detail)) {
              continue;
            }
            if (detail.status !== 200 || !detail.json?.mapping) {
              emit({
                type: "SKIP_RESULT",
                stream: "messages",
                reason: "http_error",
                message: `conversation ${c.id} http ${detail.status}`,
              });
              // Fall back to list-only conversation record.
              emitConversation(c, null);
              continue;
            }
            const mapping = detail.json.mapping;
            const currentNode = detail.json.current_node || c.current_node;
            const currentBranchIds = new Set(
              flattenTreeCurrentBranch(mapping, currentNode).map(
                (x) => x.nodeId
              )
            );
            for (const [nodeId, node] of Object.entries(mapping)) {
              const msg = extractMessage(
                nodeId,
                node,
                c.id,
                currentBranchIds.has(nodeId)
              );
              if (!msg) {
                continue;
              }
              if (!msg.role) {
                continue;
              } // synthetic root
              emitRecord("messages", msg);
            }
            emitConversation(c, detail.json);
          }
          emit({
            type: "PROGRESS",
            stream: "messages",
            message: `Synced ${Math.min(i + BATCH, convosToSync.length)} / ${convosToSync.length} conversations`,
          });
          await new Promise((r) => setTimeout(r, 200));
        }
      } else if (requested.has("conversations")) {
        // Conversations-only sync: emit from list (detail fields stay null).
        for (const c of convosToSync) {
          emitConversation(c, null);
        }
      }

      if (convosToSync.length) {
        const maxUpdate = convosToSync
          .map((c) => (c.update_time ? tsToIso(c.update_time) : null))
          .filter(Boolean)
          .sort()
          .pop();
        emit({
          type: "STATE",
          stream: "conversations",
          cursor: { last_update_time: maxUpdate || priorCursor || null },
        });
      }
    }
  },
  retryablePattern: /ECONN|ETIMEDOUT|fetch failed|429/i,
});
