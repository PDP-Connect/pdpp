#!/usr/bin/env node
/**
 * PDPP ChatGPT Connector (v0.1.0)
 *
 * Uses an isolated patchright profile under `~/.pdpp/profiles/chatgpt/` via
 * `acquireIsolatedBrowser`. Initial credentialing happens through the
 * connector's auto-login flow (`src/auto-login/chatgpt.ts`), which drives
 * login + 2FA via `INTERACTION kind=credentials`/`kind=otp` from a normal
 * connector run. All subsequent fetches happen via page.evaluate(fetch)
 * inside the browser context to preserve Cloudflare TLS fingerprint.
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
import { isMainModule } from "../../src/is-main-module.ts";
import {
  buildConversationRecord,
  buildCustomInstructionsRecord,
  buildGizmoRecord,
  buildMemoryRecord,
  buildSharedConversationRecord,
  type ConversationDetail,
  extractMessage,
  flattenTreeCurrentBranch,
  maxUpdateTimeIso,
  tsToIso,
} from "./parsers.ts";
import { validateRecord as validateRecordRaw } from "./schemas.ts";
import type {
  ChatGptApi,
  ChatGptAuth,
  ChatGptFetchResult,
  ConversationListItem,
  RawCustomInstructionsBody,
  RawMemoryEntry,
  RawSharedConversation,
} from "./types.ts";

// schemas.js is a plain-JS Zod validator; cast at the boundary to the
// runtime's ValidateRecord contract. The JS module's safeParse already
// returns { ok, data, issues } in the shape the runtime expects.
const validateRecord = validateRecordRaw as ValidateRecord;

// ─── Browser auth ───────────────────────────────────────────────────────

async function getAuthFromPage(page: Page): Promise<ChatGptAuth> {
  await page.goto("https://chatgpt.com/", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  // Wait for client bootstrap to appear
  await page
    .waitForFunction(
      () => {
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
    const el = document.getElementById("client-bootstrap");
    if (el) {
      try {
        const data = JSON.parse(el.textContent || "{}");
        accessToken = data?.session?.accessToken || null;
      } catch {
        /* ignore */
      }
    }
    // Next.js injects a __NEXT_DATA__ script-tag-mirrored global on chatgpt.com.
    // Not in the DOM lib; narrow via a local structural type that describes
    // just the path we read. Safer than @ts-expect-error because a typo in
    // the access path (e.g. `pageProps.sesison`) now fails typecheck.
    interface NextDataShape {
      props?: { pageProps?: { session?: { accessToken?: string } } };
    }
    const nextDataEl = document.getElementById("__NEXT_DATA__");
    const nextData: NextDataShape | null = nextDataEl?.textContent
      ? (JSON.parse(nextDataEl.textContent) as NextDataShape)
      : null;
    if (!accessToken && nextData) {
      accessToken = nextData.props?.pageProps?.session?.accessToken || null;
    }
    // biome-ignore lint/performance/useTopLevelRegex: runs in browser context (page.evaluate); module-scoped regexes in Node cannot cross the bridge.
    const m = (document.cookie || "").match(/oai-did=([^;]+)/);
    if (m?.[1]) {
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
function createChatGptApi({ page, capture }: { page: Page; capture: CaptureSession | null }): ChatGptApi {
  let authCache: ChatGptAuth | null = null;
  async function auth(): Promise<ChatGptAuth> {
    if (authCache) {
      return authCache;
    }
    const fresh = await getAuthFromPage(page);
    if (!fresh.accessToken) {
      throw new Error("chatgpt_auth_missing: could not extract bearer token from #client-bootstrap");
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
        // Build RequestInit with body only when present — under
        // exactOptionalPropertyTypes, spreading {body: undefined} doesn't
        // match BodyInit | null. This is what the old @ts-expect-error
        // was papering over.
        const init: RequestInit = {
          method,
          credentials: "include",
          headers,
        };
        if (body) {
          init.body = JSON.stringify(body);
        }
        const res = await fetch(`https://chatgpt.com/backend-api${path}`, init);
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
            throw new Error(`apiFetch network error on ${method} ${path}: ${m}`);
          }
          const { status } = result;
          if (status === 429 || status === 502 || status === 503 || status === 504) {
            throw new Error(`apiFetch got ${status} on ${method} ${path}`);
          }
          if (status === 401 || status === 403) {
            throw new AbortError(`apiFetch got ${status} on ${method} ${path} (auth — not retryable)`);
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

// ─── Per-stream helpers ────────────────────────────────────────────────

/** Per-run dependency bag threaded through every emit-path helper. Mirrors
 *  the amazon/chase pattern: one stable bag so collect() becomes pure
 *  orchestration and the helpers are individually testable. */
export interface StreamDeps {
  api: ChatGptApi;
  emit: CollectContext["emit"];
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  progress: CollectContext["progress"];
  requested: CollectContext["requested"];
}

const MEMORIES_PATH = "/memories?include_memory_entries=true";

/**
 * Fetch /memories and emit one record per entry.
 *
 * Invariants:
 *   - On http !== 200, emits a SKIP_RESULT and no records.
 *   - On success, emits records in list order, then a STATE heartbeat.
 *   - buildMemoryRecord filters entries with no id; those drop silently.
 */
export async function runMemoriesStream(deps: StreamDeps): Promise<void> {
  deps.emit({
    type: "PROGRESS",
    stream: "memories",
    message: "Fetching memories",
  });
  const res = await deps.api.fetch(MEMORIES_PATH);
  if (res.status !== 200) {
    deps.emit({
      type: "SKIP_RESULT",
      stream: "memories",
      reason: "http_error",
      message: `memories fetch http ${res.status}`,
    });
    return;
  }
  const entries =
    (res.json?.memories as RawMemoryEntry[] | undefined) || (res.json?.items as RawMemoryEntry[] | undefined) || [];
  for (const m of entries) {
    const rec = buildMemoryRecord(m);
    if (rec) {
      await deps.emitRecord("memories", rec);
    }
  }
  deps.emit({
    type: "STATE",
    stream: "memories",
    cursor: { fetched_at: nowIso() },
  });
}

/**
 * Fetch /user_system_messages and emit at most one custom_instructions
 * record (there is only one per user). 404/403 → SKIP "not_available";
 * other non-200 → SKIP "http_error". Success path emits the record and a
 * STATE heartbeat.
 */
export async function runCustomInstructionsStream(deps: StreamDeps): Promise<void> {
  deps.emit({
    type: "PROGRESS",
    stream: "custom_instructions",
    message: "Fetching custom instructions",
  });
  const res = await deps.api.fetch("/user_system_messages");
  if (res.status === 404 || res.status === 403) {
    deps.emit({
      type: "SKIP_RESULT",
      stream: "custom_instructions",
      reason: "not_available",
      message: `user_system_messages http ${res.status}`,
    });
    return;
  }
  if (res.status !== 200) {
    deps.emit({
      type: "SKIP_RESULT",
      stream: "custom_instructions",
      reason: "http_error",
      message: `user_system_messages http ${res.status}`,
    });
    return;
  }
  await deps.emitRecord("custom_instructions", buildCustomInstructionsRecord(res.json as RawCustomInstructionsBody));
  deps.emit({
    type: "STATE",
    stream: "custom_instructions",
    cursor: { fetched_at: nowIso() },
  });
}

/**
 * Process a single fetched conversation detail payload: emit the merged
 * conversation record first, then emit messages along the current branch
 * (if the messages stream was requested).
 *
 * Parent-first emit order per Tranche C decision 2026-04-23 — matches the
 * rest of the connector fleet (amazon, chase, usaa, slack, codex). Consumers
 * that upsert conversations + messages see the conversation row before any
 * of its messages.
 *
 * When `detail.status !== 200` or the mapping is missing, emits a
 * `SKIP_RESULT` on the messages stream and falls back to a list-only
 * conversation record (null detail) so the conversation itself still
 * lands downstream.
 */
export async function processConversationDetail(
  deps: StreamDeps,
  c: ConversationListItem,
  detail: ChatGptFetchResult,
  emitConversation: (c: ConversationListItem, detail: ConversationDetail | null) => Promise<void>
): Promise<void> {
  if (detail.status !== 200 || !detail.json?.mapping) {
    deps.emit({
      type: "SKIP_RESULT",
      stream: "messages",
      reason: "http_error",
      message: `conversation ${c.id} http ${detail.status}`,
    });
    // Fall back to list-only conversation record.
    await emitConversation(c, null);
    return;
  }
  // Emit conversation record first (parent-first), then messages.
  await emitConversation(c, detail.json as ConversationDetail);
  const mapping = detail.json.mapping;
  const currentNode = detail.json.current_node || c.current_node;
  const currentBranchIds = new Set(flattenTreeCurrentBranch(mapping, currentNode).map((x) => x.nodeId));
  for (const [nodeId, node] of Object.entries(mapping)) {
    const msg = extractMessage(nodeId, node, c.id, currentBranchIds.has(nodeId));
    if (!msg?.role) {
      // synthetic root — skip
      continue;
    }
    await deps.emitRecord("messages", msg);
  }
}

const PAGINATION_SAFETY_LIMIT = 5000;
const GIZMO_MAX_PAGES = 50;

export async function runCustomGptsStream(deps: StreamDeps): Promise<void> {
  deps.emit({
    type: "PROGRESS",
    stream: "custom_gpts",
    message: "Fetching custom GPTs",
  });
  let cursor: string | null = null;
  let pages = 0;
  let anyError = false;
  do {
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}&limit=100` : "?limit=100";
    const res = await deps.api.fetch(`/gizmos/mine${qs}`);
    if (res.status === 404 || res.status === 403) {
      deps.emit({
        type: "SKIP_RESULT",
        stream: "custom_gpts",
        reason: "not_available",
        message: `gizmos/mine http ${res.status} (feature may be disabled for this account)`,
      });
      anyError = true;
      break;
    }
    if (res.status !== 200) {
      deps.emit({
        type: "SKIP_RESULT",
        stream: "custom_gpts",
        reason: "http_error",
        message: `gizmos/mine http ${res.status}`,
      });
      anyError = true;
      break;
    }
    const items = (res.json?.items as unknown[] | undefined) || (res.json?.gizmos as unknown[] | undefined) || [];
    for (const raw of items) {
      const rec = buildGizmoRecord(raw);
      if (rec) {
        await deps.emitRecord("custom_gpts", rec);
      }
    }
    cursor = (res.json?.cursor as string | null | undefined) ?? null;
    pages++;
    if (pages > GIZMO_MAX_PAGES) {
      break;
    }
    if (!items.length) {
      break;
    }
  } while (cursor);
  if (!anyError) {
    deps.emit({
      type: "STATE",
      stream: "custom_gpts",
      cursor: { fetched_at: nowIso() },
    });
  }
}

export async function runSharedConversationsStream(deps: StreamDeps): Promise<void> {
  deps.emit({
    type: "PROGRESS",
    stream: "shared_conversations",
    message: "Fetching shared conversations",
  });
  let offset = 0;
  const limit = 100;
  let sawError = false;
  while (true) {
    const res = await deps.api.fetch(`/shared_conversations?offset=${offset}&limit=${limit}&order=created`);
    if (res.status === 404 || res.status === 403) {
      deps.emit({
        type: "SKIP_RESULT",
        stream: "shared_conversations",
        reason: "not_available",
        message: `shared_conversations http ${res.status}`,
      });
      sawError = true;
      break;
    }
    if (res.status !== 200) {
      deps.emit({
        type: "SKIP_RESULT",
        stream: "shared_conversations",
        reason: "http_error",
        message: `shared_conversations http ${res.status}`,
      });
      sawError = true;
      break;
    }
    const items = (res.json?.items as RawSharedConversation[] | undefined) || [];
    if (!items.length) {
      break;
    }
    for (const s of items) {
      const rec = buildSharedConversationRecord(s);
      if (rec) {
        await deps.emitRecord("shared_conversations", rec);
      }
    }
    if (items.length < limit) {
      break;
    }
    offset += items.length;
    if (offset > PAGINATION_SAFETY_LIMIT) {
      break;
    }
  }
  if (!sawError) {
    deps.emit({
      type: "STATE",
      stream: "shared_conversations",
      cursor: { fetched_at: nowIso() },
    });
  }
}

// ─── Conversations + messages ──────────────────────────────────────────

/**
 * Walk /conversations pages newer than priorCursor and collect the list
 * items we still need to sync. Stops early once any update_time <= priorCursor
 * (conversations are returned ordered by updated desc).
 */
async function listConversationsSinceCursor(
  deps: StreamDeps,
  priorCursor: string | null
): Promise<ConversationListItem[]> {
  const convosToSync: ConversationListItem[] = [];
  let offset = 0;
  const limit = 100;
  let stopPaging = false;
  deps.emit({
    type: "PROGRESS",
    stream: "conversations",
    message: "Listing conversations",
  });
  while (!stopPaging) {
    const res = await deps.api.fetch(`/conversations?offset=${offset}&limit=${limit}&order=updated`);
    if (res.status !== 200) {
      deps.emit({
        type: "SKIP_RESULT",
        stream: "conversations",
        reason: "http_error",
        message: `conversations list http ${res.status}`,
      });
      break;
    }
    const items = (res.json?.items as ConversationListItem[] | undefined) || [];
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
    if (offset > PAGINATION_SAFETY_LIMIT) {
      break;
    }
  }
  return convosToSync;
}

const CONVO_DETAIL_BATCH = 3; // conservative concurrency
const CONVO_BATCH_PAUSE_MS = 200;

/**
 * For each listed conversation, fetch detail in small concurrent batches
 * and emit messages + detail-augmented conversation records.
 */
export async function runMessagesAndConversationsWithDetail(
  deps: StreamDeps,
  convosToSync: ConversationListItem[],
  emitConversation: (c: ConversationListItem, detail: ConversationDetail | null) => Promise<void>
): Promise<void> {
  for (let i = 0; i < convosToSync.length; i += CONVO_DETAIL_BATCH) {
    const batch = convosToSync.slice(i, i + CONVO_DETAIL_BATCH);
    const results = await Promise.all(batch.map((c) => deps.api.fetch(`/conversation/${encodeURIComponent(c.id)}`)));
    for (let j = 0; j < batch.length; j++) {
      const c = batch[j];
      const detail = results[j];
      if (!(c && detail)) {
        continue;
      }
      await processConversationDetail(deps, c, detail, emitConversation);
    }
    const progressMsg = {
      type: "PROGRESS",
      stream: "messages",
      message: `Synced ${Math.min(i + CONVO_DETAIL_BATCH, convosToSync.length)} / ${convosToSync.length} conversations`,
      count: Math.min(i + CONVO_DETAIL_BATCH, convosToSync.length),
      total: convosToSync.length,
    } as const;
    deps.emit(progressMsg);
    await new Promise((r) => setTimeout(r, CONVO_BATCH_PAUSE_MS));
  }
}

export async function runConversationsAndMessagesStreams(
  deps: StreamDeps,
  state: CollectContext["state"]
): Promise<void> {
  const conversationsCursor = state.conversations as { last_update_time?: string | null } | undefined;
  const priorCursor = conversationsCursor?.last_update_time || null;
  const convosToSync = await listConversationsSinceCursor(deps, priorCursor);
  const foundProgressMsg = {
    type: "PROGRESS",
    stream: "conversations",
    message: `Found ${convosToSync.length} conversations to sync`,
    count: convosToSync.length,
    total: convosToSync.length,
  } as const;
  deps.emit(foundProgressMsg);

  const emitConversation = async (c: ConversationListItem, detail: ConversationDetail | null): Promise<void> => {
    if (!deps.requested.has("conversations")) {
      return;
    }
    await deps.emitRecord("conversations", buildConversationRecord(c, detail));
  };

  if (deps.requested.has("messages")) {
    await runMessagesAndConversationsWithDetail(deps, convosToSync, emitConversation);
  } else if (deps.requested.has("conversations")) {
    // Conversations-only sync: emit from list (detail fields stay null).
    for (const c of convosToSync) {
      await emitConversation(c, null);
    }
  }

  if (convosToSync.length) {
    const maxUpdate = maxUpdateTimeIso(convosToSync);
    deps.emit({
      type: "STATE",
      stream: "conversations",
      cursor: { last_update_time: maxUpdate || priorCursor || null },
    });
  }
}

/**
 * ChatGPT-specific wrapper: unstringifiable values (bad Date, circular refs)
 * historically crashed the whole run when the runtime's shape-check tried to
 * serialize them into a SKIP_RESULT diagnostic. Guard here so
 * "Invalid time value" points at the offending row instead of killing the run.
 */
function makeEmitRecord(
  baseEmitRecord: CollectContext["emitRecord"]
): (stream: string, data: RecordData) => Promise<void> {
  return (stream: string, data: RecordData): Promise<void> => {
    if (data?.id != null) {
      try {
        JSON.stringify(data);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[chatgpt-debug] emit failed for ${stream} id=${String(data.id)}: ${m}\n`);
        return Promise.resolve();
      }
    }
    return baseEmitRecord(stream, data);
  };
}

// ─── Entry ─────────────────────────────────────────────────────────────

// Guarded so `import "./index.ts"` in tests doesn't spin up the runtime
// and block the Node event loop on stdin. Only fires when this module
// IS the process entry point (i.e. `tsx connectors/chatgpt/index.ts`).
if (isMainModule(import.meta.url)) {
  runConnector({
    name: "chatgpt",
    validateRecord,
    browser: { profileName: "chatgpt" },
    async ensureSession({ capture, context, page, sendInteraction }) {
      await ensureChatGptSession({
        capture,
        context,
        page,
        sendInteraction,
      });
    },
    async collect(ctx: CollectContext | BrowserCollectContext): Promise<void> {
      const { state, requested, emit, emitRecord: baseEmitRecord, progress, capture } = ctx;
      const { page } = ctx as BrowserCollectContext;

      // API client closes over page + capture — no module-level mutable state,
      // auth cached inside the closure for the run's lifetime.
      const api = createChatGptApi({ page, capture });
      const emitRecord = makeEmitRecord(baseEmitRecord);

      // Verify session (extract bearer token for /backend-api calls)
      const auth = await api.auth();
      progress(`Authenticated to ChatGPT (device_id=${auth.deviceId ? `${auth.deviceId.slice(0, 8)}…` : "unknown"})`);

      const deps: StreamDeps = { api, emit, emitRecord, progress, requested };

      if (requested.has("memories")) {
        await runMemoriesStream(deps);
      }
      if (requested.has("custom_gpts")) {
        await runCustomGptsStream(deps);
      }
      if (requested.has("custom_instructions")) {
        await runCustomInstructionsStream(deps);
      }
      if (requested.has("shared_conversations")) {
        await runSharedConversationsStream(deps);
      }
      if (requested.has("conversations") || requested.has("messages")) {
        await runConversationsAndMessagesStreams(deps, state);
      }
    },
    retryablePattern: /ECONN|ETIMEDOUT|fetch failed|429/i,
  });
}
