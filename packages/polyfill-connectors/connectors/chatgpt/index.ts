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

import type { Page } from "playwright";
import { type AdaptiveLaneEvent, createAdaptiveLane, currentAdaptiveLaneRunContext } from "../../src/adaptive-lane.ts";
import { ensureChatGptSession } from "../../src/auto-login/chatgpt.ts";
import {
  type BrowserCollectContext,
  type CollectContext,
  type DetailCoverageMessage,
  type DetailGapMessage,
  nowIso,
  type RecordData,
  runConnector,
  type ValidateRecord,
} from "../../src/connector-runtime.ts";
import { openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import type { CaptureSession } from "../../src/fixture-capture.ts";
import {
  RetryExhaustedError,
  retryAfterMsFromHeaders,
  retryHttp,
  TerminalHttpStatusError,
} from "../../src/http-retry.ts";
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
 * Retry policy:
 *   - Retryable: 429, 502/503/504, browser-level network errors
 *   - Terminal: 401/403 (auth dead)
 *   - Non-retryable 4xx return to stream code for SKIP_RESULT handling
 *   - Caller decides what to do with a successful response body
 */
const CHATGPT_RATE_LIMIT_MAX_ATTEMPTS = 12;
const CHATGPT_RATE_LIMIT_BASE_DELAY_MS = 2000;
const CHATGPT_RATE_LIMIT_MAX_DELAY_MS = 15 * 60_000;
const CHATGPT_RATE_LIMIT_MAX_RETRY_AFTER_MS = 15 * 60_000;
const CHATGPT_LONG_SLEEP_PROGRESS_THRESHOLD_MS = 5000;
// Source-pressure fast-open. The live A/B probe (2026-06-02) showed ChatGPT's
// private detail endpoint returns BARE 429s — no `Retry-After` — and that the
// throttle is per-account, recovering over minutes, not per-conversation. A
// bare 429 is therefore a signal about the whole account/source bucket, not the
// one conversation in hand. Retrying the same conversation up to the full
// `CHATGPT_RATE_LIMIT_MAX_ATTEMPTS` budget would spend ~23–70 min of jittered
// exponential backoff hammering an already-hot account before the connector's
// upstream-pressure circuit opens and defers the rest as DETAIL_GAP.
//
// So a bare 429 (429 WITHOUT `Retry-After`) exhausts retryHttp after only
// `CHATGPT_BARE_429_FAST_OPEN_ATTEMPTS` attempts. That throws the same
// `RetryExhaustedError` the full budget would, opening the existing
// observed-pressure circuit fast: the rest of the tranche is deferred to
// resumable DETAIL_GAP records instead of grinding the hot bucket.
//
// A 429 that DOES carry `Retry-After`, and 502/503/504, keep the full budget:
// those are honest, server-bounded waits we should respect, not blind hammering.
const CHATGPT_BARE_429_FAST_OPEN_ATTEMPTS = 3;
export const CHATGPT_RETRYABLE_ERROR_PATTERN = /ECONN|ETIMEDOUT|fetch failed|429|retry budget exhausted/i;
const CHATGPT_BACKEND_FETCH_TIMEOUT_ENV = "PDPP_CHATGPT_BACKEND_FETCH_TIMEOUT_MS";
const CHATGPT_BACKEND_FETCH_TIMEOUT_MS = 45_000;
const CHATGPT_BACKEND_EVALUATE_TIMEOUT_BUFFER_MS = 5000;
const CHATGPT_SIDE_EFFECT_PROBE_ENV = "PDPP_CHATGPT_SIDE_EFFECT_PROBE";
const CHATGPT_CONVERSATION_DETAIL_PATH_PATTERN = /^\/conversation\/[^/?#]+(?:[?#].*)?$/;
const URL_QUERY_OR_FRAGMENT_PATTERN = /[?#].*$/;

export type ChatGptRetryExhaustedClass = "rate_limited" | "temporary_unavailable" | "upstream_pressure";

export interface ChatGptNetworkPressureDiagnostic {
  attempt?: number;
  endpoint_route: string;
  error_class: string;
  max_attempts?: number;
  method: string;
  retry_after_ms?: number;
  safe_headers?: Record<string, string | number>;
  status?: number;
}

export class ChatGptRecoverableRetryExhaustedError extends Error {
  readonly class: ChatGptRetryExhaustedClass;
  readonly httpStatus: number | null;
  readonly networkPressure: ChatGptNetworkPressureDiagnostic | undefined;

  constructor(
    message: string,
    details: {
      class: ChatGptRetryExhaustedClass;
      httpStatus?: number | null;
      networkPressure?: ChatGptNetworkPressureDiagnostic;
    }
  ) {
    super(message);
    this.name = "ChatGptRecoverableRetryExhaustedError";
    this.class = details.class;
    this.httpStatus = details.httpStatus ?? null;
    this.networkPressure = details.networkPressure;
  }
}

interface ChatGptBackendFetchArgs {
  auth: ChatGptAuth;
  body?: unknown;
  method: string;
  parseJson?: boolean;
  path: string;
  timeoutMs: number;
}

export function resolveChatGptBackendFetchTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[CHATGPT_BACKEND_FETCH_TIMEOUT_ENV]?.trim();
  if (!raw) {
    return CHATGPT_BACKEND_FETCH_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return CHATGPT_BACKEND_FETCH_TIMEOUT_MS;
  }
  return Math.ceil(parsed);
}

export async function chatGptBackendFetchInBrowser({
  auth,
  body,
  method,
  parseJson = true,
  path,
  timeoutMs,
}: ChatGptBackendFetchArgs): Promise<ChatGptFetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
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
      signal: controller.signal,
    };
    if (body) {
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`https://chatgpt.com/backend-api${path}`, init);
    const status = res.status;
    const retryAfter = res.headers.get("retry-after") ?? undefined;
    let json: unknown = null;
    if (parseJson) {
      try {
        json = await res.json();
      } catch {
        json = null;
      }
    }
    return {
      status,
      json: json as ChatGptFetchResult["json"],
      ...(retryAfter ? { headers: { "retry-after": retryAfter } } : {}),
    };
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`chatgpt_backend_fetch_timeout after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function formatSleepDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = seconds % 60;
  return remainderSeconds ? `${minutes}m ${remainderSeconds}s` : `${minutes}m`;
}

/**
 * `retryHttp` early-stop predicate implementing the bare-429 source-pressure
 * fast-open. Returns `false` (stop retrying, exhaust now) once a bare 429 —
 * status 429 with no `Retry-After` — has been seen on
 * `CHATGPT_BARE_429_FAST_OPEN_ATTEMPTS` attempts. Every other retryable
 * response (429 + `Retry-After`, 502/503/504) keeps the full budget.
 *
 * Exported for direct unit testing of the boundary; `retryHttp` owns the
 * exhaustion accounting and error shape.
 */
export function shouldKeepRetryingChatGptDetail({
  attempt,
  response,
  retryAfterMs,
}: {
  attempt: number;
  response: { status: number };
  retryAfterMs: number | null;
}): boolean {
  const isBare429 = response.status === 429 && retryAfterMs == null;
  if (isBare429 && attempt >= CHATGPT_BARE_429_FAST_OPEN_ATTEMPTS) {
    return false;
  }
  return true;
}

function classifyRetryExhaustedStatus(status: number | null): ChatGptRetryExhaustedClass {
  if (status === 429) {
    return "rate_limited";
  }
  if (status === 502 || status === 503 || status === 504) {
    return "temporary_unavailable";
  }
  return "upstream_pressure";
}

function chatGptEndpointRoute(path: string): string {
  if (CHATGPT_CONVERSATION_DETAIL_PATH_PATTERN.test(path)) {
    return "/conversation/{conversation_id}";
  }
  return path.replace(URL_QUERY_OR_FRAGMENT_PATTERN, "");
}

function makeChatGptNetworkPressureDiagnostic({
  attempts,
  cause,
  method,
  path,
}: {
  attempts?: number;
  cause: unknown;
  method: string;
  path: string;
}): ChatGptNetworkPressureDiagnostic {
  const response =
    cause && typeof cause === "object" ? (cause as { headers?: Record<string, string>; status?: number }) : {};
  const status = typeof response.status === "number" ? response.status : undefined;
  const retryAfterMs = retryAfterMsFromHeaders(response.headers);
  return {
    endpoint_route: `${method} ${chatGptEndpointRoute(path)}`,
    error_class: status === undefined ? "network_error" : `http_${status}`,
    method,
    ...(attempts === undefined ? {} : { attempt: attempts, max_attempts: attempts }),
    ...(status === undefined ? {} : { status }),
    ...(retryAfterMs == null ? {} : { retry_after_ms: retryAfterMs, safe_headers: { "retry-after-ms": retryAfterMs } }),
  };
}

function createChatGptApi({
  capture,
  emit,
  page,
}: {
  capture: CaptureSession | null;
  emit?: CollectContext["emit"];
  page: Page;
}): ChatGptApi {
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
    { method, body, parseJson = true }: { method: string; body?: unknown; parseJson?: boolean }
  ): Promise<ChatGptFetchResult> {
    const a = await auth();
    const timeoutMs = resolveChatGptBackendFetchTimeoutMs();
    return await withTimeout(
      page.evaluate(chatGptBackendFetchInBrowser, { path, method, body, parseJson, auth: a, timeoutMs }),
      timeoutMs + CHATGPT_BACKEND_EVALUATE_TIMEOUT_BUFFER_MS,
      `chatgpt_backend_fetch_evaluate_timeout after ${timeoutMs + CHATGPT_BACKEND_EVALUATE_TIMEOUT_BUFFER_MS}ms`
    );
  }

  function fetchWithRetry(
    path: string,
    {
      body,
      captureResult,
      method,
      parseJson,
    }: { body?: unknown; captureResult: boolean; method: string; parseJson: boolean }
  ): Promise<ChatGptFetchResult> {
    return retryHttp({
      baseDelayMs: CHATGPT_RATE_LIMIT_BASE_DELAY_MS,
      maxAttempts: CHATGPT_RATE_LIMIT_MAX_ATTEMPTS,
      maxDelayMs: CHATGPT_RATE_LIMIT_MAX_DELAY_MS,
      maxRetryAfterMs: CHATGPT_RATE_LIMIT_MAX_RETRY_AFTER_MS,
      // Fast-open the source-pressure circuit on a bare 429 (no Retry-After):
      // a few short attempts, then exhaust so the lane defers the rest as
      // resumable DETAIL_GAP instead of burning the full 12-attempt budget
      // (~23–70 min of backoff) against an already-throttled account.
      shouldKeepRetrying: shouldKeepRetryingChatGptDetail,
      onRetry: async ({ attempt, delayMs, maxAttempts, response, retryAfterMs }) => {
        // retryHttp sleeps `delayMs` itself immediately after this callback,
        // inside the same (serialized) detail attempt. Report the pressure so
        // the lane reduces concurrency and surfaces a cooldown event, but mark
        // it absorbed so the lane does not *also* delay the next launch by the
        // same amount — that double-paid the backoff the request already slept.
        await currentAdaptiveLaneRunContext()?.reportPressure({
          absorbedByRequestWait: true,
          delayMs,
          kind: response?.status === 429 ? "rate_limited" : "transient_error",
          ...(retryAfterMs == null ? {} : { retryAfterMs }),
        });
        if (delayMs < CHATGPT_LONG_SLEEP_PROGRESS_THRESHOLD_MS) {
          return;
        }
        const status = response?.status ? `HTTP ${response.status}` : "network error";
        const policy =
          retryAfterMs == null
            ? `jittered exponential backoff, capped at ${formatSleepDuration(CHATGPT_RATE_LIMIT_MAX_DELAY_MS)}`
            : `server Retry-After, capped at ${formatSleepDuration(CHATGPT_RATE_LIMIT_MAX_RETRY_AFTER_MS)}`;
        await emit?.({
          type: "PROGRESS",
          message: `ChatGPT rate limit/backoff on ${method} ${chatGptEndpointRoute(path)}: ${status}; waiting ${formatSleepDuration(delayMs)} before ${attempt + 1 === maxAttempts ? "final " : ""}retry ${attempt + 1}/${maxAttempts} (${policy})`,
        });
      },
      request: async () => {
        try {
          const result = await fetchOnce(path, { method, body, parseJson });
          if (
            captureResult &&
            capture &&
            !(result.status === 429 || result.status === 502 || result.status === 503 || result.status === 504)
          ) {
            capture.captureHttp(`${method}-${path}`, result.json, {
              status: result.status,
              path,
              method,
            });
          }
          return result;
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          throw new Error(`apiFetch network error on ${method} ${path}: ${m}`);
        }
      },
      shouldAbort: (result) => result.status === 401 || result.status === 403,
    }).catch((err: unknown) => {
      if (err instanceof TerminalHttpStatusError) {
        throw new Error(`apiFetch got ${err.status} on ${method} ${path} (auth - not retryable)`);
      }
      if (err instanceof RetryExhaustedError) {
        const cause = err.originalCause;
        const status =
          cause && typeof cause === "object" && "status" in cause && typeof cause.status === "number"
            ? cause.status
            : null;
        throw new ChatGptRecoverableRetryExhaustedError(
          status
            ? `apiFetch got ${status} on ${method} ${path} after retry budget exhausted`
            : `apiFetch retry budget exhausted on ${method} ${path}: ${err.message}`,
          {
            class: classifyRetryExhaustedStatus(status),
            httpStatus: status,
            networkPressure: makeChatGptNetworkPressureDiagnostic({
              attempts: err.attempts,
              cause,
              method,
              path,
            }),
          }
        );
      }
      throw err;
    });
  }

  return {
    auth,
    fetch(
      path: string,
      { method = "GET", body }: { method?: string; body?: unknown } = {}
    ): Promise<ChatGptFetchResult> {
      return fetchWithRetry(path, { method, body, parseJson: true, captureResult: true });
    },
    async fetchStatus(
      path: string,
      { method = "GET", body }: { method?: string; body?: unknown } = {}
    ): Promise<Pick<ChatGptFetchResult, "headers" | "status">> {
      const result = await fetchWithRetry(path, { method, body, parseJson: false, captureResult: false });
      return { status: result.status, ...(result.headers ? { headers: result.headers } : {}) };
    },
  };
}

function isChatGptSideEffectProbeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[CHATGPT_SIDE_EFFECT_PROBE_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "only";
}

interface ChatGptConversationProbeItem {
  create_time: number | null;
  current_node: string | null;
  id: string | null;
  index: number;
  update_time: number | null;
}

interface ChatGptSideEffectProbeResult {
  after1?: ChatGptConversationProbeItem[];
  after2?: ChatGptConversationProbeItem[];
  before?: ChatGptConversationProbeItem[];
  detail?: {
    create_time: number | null;
    current_node: string | null;
    status: number;
    update_time: number | null;
  };
  ok: boolean;
  stage?: string;
  status?: number;
  target_id?: string | null;
}

function sameOrder(a: ChatGptConversationProbeItem[], b: ChatGptConversationProbeItem[]): boolean {
  return a.map((item) => item.id).join("\n") === b.map((item) => item.id).join("\n");
}

function findProbeItem(
  items: ChatGptConversationProbeItem[] | undefined,
  id: string | null | undefined
): ChatGptConversationProbeItem | null {
  if (!id) {
    return null;
  }
  return items?.find((item) => item.id === id) ?? null;
}

function formatProbeFailure(result: ChatGptSideEffectProbeResult): string {
  const status = result.status ? ` (HTTP ${result.status})` : "";
  return `ChatGPT side-effect probe could not complete at ${result.stage ?? "unknown"}${status}`;
}

function formatProbeValue(value: number | string | boolean | null): string {
  return value == null ? "null" : String(value);
}

function formatProbeIndex(value: number | null): string {
  return value == null ? "missing" : String(value);
}

function probeValueChanged<T>(before: T, after1: T, after2: T): boolean {
  return before !== after1 || before !== after2;
}

function getProbeTargets(result: ChatGptSideEffectProbeResult): {
  after1Target: ChatGptConversationProbeItem | null;
  after2Target: ChatGptConversationProbeItem | null;
  beforeTarget: ChatGptConversationProbeItem | null;
  targetId: string | null;
} {
  const before = result.before ?? [];
  const targetId = result.target_id ?? before[0]?.id ?? null;
  return {
    targetId,
    beforeTarget: findProbeItem(before, targetId),
    after1Target: findProbeItem(result.after1, targetId),
    after2Target: findProbeItem(result.after2, targetId),
  };
}

export function summarizeChatGptSideEffectProbe(result: ChatGptSideEffectProbeResult): string {
  if (!result.ok) {
    return formatProbeFailure(result);
  }

  const before = result.before ?? [];
  const after1 = result.after1 ?? [];
  const after2 = result.after2 ?? [];
  const { after1Target, after2Target, beforeTarget, targetId } = getProbeTargets(result);
  const beforeUpdate = beforeTarget?.update_time ?? null;
  const after1Update = after1Target?.update_time ?? null;
  const after2Update = after2Target?.update_time ?? null;
  const beforeNode = beforeTarget?.current_node ?? null;
  const after1Node = after1Target?.current_node ?? null;
  const after2Node = after2Target?.current_node ?? null;
  const detailNode = result.detail?.current_node ?? null;
  const orderChangedAfter1 = !sameOrder(before, after1);
  const orderChangedAfter2 = !sameOrder(before, after2);
  const indexBefore = beforeTarget?.index ?? null;
  const indexAfter1 = after1Target?.index ?? null;
  const indexAfter2 = after2Target?.index ?? null;
  const updateChanged = probeValueChanged(beforeUpdate, after1Update, after2Update);
  const nodeChanged = probeValueChanged(beforeNode, after1Node, after2Node);

  return [
    "ChatGPT side-effect probe result:",
    `target=${targetId ?? "none"}`,
    `detail_http=${result.detail?.status ?? "none"}`,
    `index=${formatProbeIndex(indexBefore)}>${formatProbeIndex(indexAfter1)}>${formatProbeIndex(indexAfter2)}`,
    `update_time=${formatProbeValue(beforeUpdate)}>${formatProbeValue(after1Update)}>${formatProbeValue(after2Update)}`,
    `current_node=${formatProbeValue(beforeNode)}>${formatProbeValue(after1Node)}>${formatProbeValue(after2Node)}`,
    `detail_current_node=${detailNode ?? "null"}`,
    `order_changed=${orderChangedAfter1 || orderChangedAfter2}`,
    `update_time_changed=${updateChanged}`,
    `current_node_changed=${nodeChanged}`,
  ].join(" ");
}

async function runChatGptSideEffectProbe({
  api,
  emit,
  page,
}: {
  api: ChatGptApi;
  emit: CollectContext["emit"];
  page: Page;
}): Promise<void> {
  await emit({
    type: "PROGRESS",
    stream: "conversations",
    message:
      "ChatGPT side-effect probe enabled; running one GET-only list/detail/list comparison and skipping collection",
  });
  const auth = await api.auth();
  const result = (await page.evaluate(async ({ accessToken, deviceId }) => {
    const metadata = (value: unknown, index: number): ChatGptConversationProbeItem => {
      const item = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      return {
        index,
        id: typeof item.id === "string" ? item.id : null,
        create_time: typeof item.create_time === "number" ? item.create_time : null,
        update_time: typeof item.update_time === "number" ? item.update_time : null,
        current_node: typeof item.current_node === "string" ? item.current_node : null,
      };
    };
    const pickList = (json: unknown): ChatGptConversationProbeItem[] => {
      const body = json && typeof json === "object" ? (json as { items?: unknown }) : {};
      const items = Array.isArray(body.items) ? body.items : [];
      return items.slice(0, 5).map((item, index) => metadata(item, index));
    };
    const getJson = async (path: string): Promise<{ json: unknown; status: number }> => {
      const headers: Record<string, string> = {
        accept: "*/*",
        authorization: `Bearer ${accessToken}`,
        "oai-language": "en-US",
      };
      if (deviceId) {
        headers["oai-device-id"] = deviceId;
      }
      const res = await fetch(`https://chatgpt.com/backend-api${path}`, {
        credentials: "include",
        headers,
        method: "GET",
      });
      let json: unknown = null;
      if (res.ok) {
        try {
          json = await res.json();
        } catch {
          json = null;
        }
      }
      return { status: res.status, json };
    };

    if (!accessToken) {
      return { ok: false, stage: "auth_extract" } satisfies ChatGptSideEffectProbeResult;
    }

    const beforeRes = await getJson("/conversations?offset=0&limit=5&order=updated");
    if (beforeRes.status !== 200) {
      return { ok: false, stage: "before_list", status: beforeRes.status } satisfies ChatGptSideEffectProbeResult;
    }
    const before = pickList(beforeRes.json);
    const target = before[0];
    if (!target?.id) {
      return { ok: false, stage: "select_target", before } satisfies ChatGptSideEffectProbeResult;
    }

    const detailRes = await getJson(`/conversation/${encodeURIComponent(target.id)}`);
    const detailBody =
      detailRes.json && typeof detailRes.json === "object" ? (detailRes.json as Record<string, unknown>) : {};
    const detail = {
      status: detailRes.status,
      create_time: typeof detailBody.create_time === "number" ? detailBody.create_time : null,
      update_time: typeof detailBody.update_time === "number" ? detailBody.update_time : null,
      current_node: typeof detailBody.current_node === "string" ? detailBody.current_node : null,
    };

    const after1Res = await getJson("/conversations?offset=0&limit=5&order=updated");
    if (after1Res.status !== 200) {
      return {
        ok: false,
        stage: "after1_list",
        status: after1Res.status,
        before,
        detail,
        target_id: target.id,
      } satisfies ChatGptSideEffectProbeResult;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const after2Res = await getJson("/conversations?offset=0&limit=5&order=updated");
    if (after2Res.status !== 200) {
      return {
        ok: false,
        stage: "after2_list",
        status: after2Res.status,
        before,
        after1: pickList(after1Res.json),
        detail,
        target_id: target.id,
      } satisfies ChatGptSideEffectProbeResult;
    }

    return {
      ok: true,
      before,
      after1: pickList(after1Res.json),
      after2: pickList(after2Res.json),
      detail,
      target_id: target.id,
    } satisfies ChatGptSideEffectProbeResult;
  }, auth)) as ChatGptSideEffectProbeResult;

  await emit({
    type: "PROGRESS",
    stream: "conversations",
    message: summarizeChatGptSideEffectProbe(result),
  });
}

// ─── Per-stream helpers ────────────────────────────────────────────────

/** Per-run dependency bag threaded through every emit-path helper. Mirrors
 *  the amazon/chase pattern: one stable bag so collect() becomes pure
 *  orchestration and the helpers are individually testable. */
export interface StreamDeps {
  api: ChatGptApi;
  detailGaps?: CollectContext["detailGaps"];
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
      diagnostics: { http_status: res.status },
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
export async function runCustomInstructionsStream(
  deps: StreamDeps,
  state: CollectContext["state"] = {}
): Promise<void> {
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
      diagnostics: { http_status: res.status },
    });
    return;
  }
  // `/user_system_messages` returns the full custom-instructions body every run.
  // The record carries a stable synthetic id and no run-clock field, so a
  // per-record fingerprint over the whole body is the exact "did the source
  // move?" gate. Without it, this single record re-versions on every run even
  // when the user never edits their instructions (the dashboard's
  // custom_instructions churn was 100% byte-identical no-op re-emit).
  const fingerprintCursor = openFingerprintCursor(state.custom_instructions);
  const record = buildCustomInstructionsRecord(res.json as RawCustomInstructionsBody);
  if (fingerprintCursor.shouldEmit(record)) {
    await deps.emitRecord("custom_instructions", record);
  }
  deps.emit({
    type: "STATE",
    stream: "custom_instructions",
    cursor: { fetched_at: nowIso(), fingerprints: fingerprintCursor.toState() },
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
      reason: detail.status === 200 ? "missing_mapping" : "http_error",
      message: `conversation ${c.id} http ${detail.status}`,
      diagnostics: { http_status: detail.status, conversation_id: c.id },
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
  let emittedMessageCount = 0;
  for (const [nodeId, node] of Object.entries(mapping)) {
    const msg = extractMessage(nodeId, node, c.id, currentBranchIds.has(nodeId));
    if (!msg?.role) {
      // synthetic root — skip
      continue;
    }
    emittedMessageCount += 1;
    await deps.emitRecord("messages", msg);
  }
  if (emittedMessageCount === 0) {
    // Completeness guard. A 200-with-mapping detail whose graph contains NO
    // message-bearing node leaves a bare conversation row with zero messages
    // and, without this, no signal at all — indistinguishable downstream from
    // data loss. This is the silent-empty class the dataconnect completeness
    // audit (2026-06-02) flagged as recommendation #5: "a 200-response whose
    // mapping yields zero kept nodes for a conversation with a non-empty title
    // should be flagged, not emitted as an empty conversation."
    //
    // It is NOT a fetch failure (the conversation record still emitted and the
    // conversation still counts as hydrated/covered — we successfully reached
    // it), so this is a SKIP_RESULT diagnostic, not a DETAIL_GAP. It exists so
    // an empty conversation is observable rather than silent, which matters
    // more as detail concurrency rises and partial/interleaved states become
    // more likely. The `node_count` lets a reviewer distinguish a genuinely
    // empty graph (0) from one whose every node was synthetic/role-less (>0).
    deps.emit({
      type: "SKIP_RESULT",
      stream: "messages",
      reason: "empty_detail",
      message: `conversation ${c.id} returned http 200 with a mapping but no message-bearing nodes`,
      diagnostics: {
        http_status: 200,
        conversation_id: c.id,
        node_count: Object.keys(mapping).length,
      },
    });
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
        diagnostics: { http_status: res.status },
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

export async function runSharedConversationsStream(
  deps: StreamDeps,
  state: CollectContext["state"] = {}
): Promise<void> {
  deps.emit({
    type: "PROGRESS",
    stream: "shared_conversations",
    message: "Fetching shared conversations",
  });
  // `/shared_conversations` is re-listed in full every run; each share record
  // carries a stable id and no run-clock field, so a per-record fingerprint
  // over the whole body is the exact "did this share move?" gate. Without it
  // every still-present share re-versions on every run even when nothing
  // changed (the dashboard's shared_conversations churn was 100%
  // byte-identical no-op re-emit). This is a full scan, so stale ids (shares
  // the user deleted on the source) are pruned from the carry-forward map
  // after a clean pass.
  const fingerprintCursor = openFingerprintCursor(state.shared_conversations);
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
        diagnostics: { http_status: res.status },
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
      if (rec && fingerprintCursor.shouldEmit(rec)) {
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
    // Only prune after a clean full pass — an aborted/errored scan never saw
    // every id and must not drop carry-forward entries it failed to observe.
    fingerprintCursor.pruneStale();
    deps.emit({
      type: "STATE",
      stream: "shared_conversations",
      cursor: { fetched_at: nowIso(), fingerprints: fingerprintCursor.toState() },
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
    message: priorCursor ? `Listing conversations updated after ${priorCursor}` : "Listing conversations (full pass)",
  });
  while (!stopPaging) {
    const res = await deps.api.fetch(`/conversations?offset=${offset}&limit=${limit}&order=updated`);
    if (res.status !== 200) {
      deps.emit({
        type: "SKIP_RESULT",
        stream: "conversations",
        reason: "http_error",
        message: `conversations list http ${res.status}`,
        diagnostics: { http_status: res.status },
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

const CONVO_DETAIL_PAUSE_MIN_MS = 1500;
const CONVO_DETAIL_PAUSE_MAX_MS = 3000;
const CONVO_DETAIL_INITIAL_CONCURRENCY = 1;
const CONVO_DETAIL_MAX_CONCURRENCY = 1;

// ─── Cold-state A/B probe overrides (DEFAULTS FROZEN) ────────────────────
//
// The detail-lane concurrency MUST stay at `1` in production until a
// genuinely cold-state live run produces clean evidence — see
// openspec/changes/add-connector-adaptive-lanes (design.md "Live Evidence":
// "ChatGPT `maxConcurrency` MUST stay at `1`...") and its Tasks §6 owner-only
// gate. The 2026-06-02 A/B probe showed even the minimal serial lane hits
// ~38% bare-429 on a hot account, so raising request rate is unsafe while
// hot and only justified from a cold start.
//
// These resolvers exist solely to let the OWNER run that cold-state A/B
// against the REAL connector lane (with real DETAIL_GAP/cursor semantics)
// without hand-editing — and committing — the frozen constants. They are
// PROBE-ONLY knobs: when the env vars are unset/invalid the production
// defaults (1 / 1 / 1500ms / 3000ms) hold exactly, so normal runs are
// byte-for-byte unchanged. Do NOT set these in a production environment;
// setting concurrency > 1 against a hot account increases 429 pressure.
const CHATGPT_DETAIL_INITIAL_CONCURRENCY_ENV = "PDPP_CHATGPT_DETAIL_INITIAL_CONCURRENCY_PROBE";
const CHATGPT_DETAIL_MAX_CONCURRENCY_ENV = "PDPP_CHATGPT_DETAIL_MAX_CONCURRENCY_PROBE";
const CHATGPT_DETAIL_PAUSE_MIN_MS_ENV = "PDPP_CHATGPT_DETAIL_PAUSE_MIN_MS_PROBE";
const CHATGPT_DETAIL_PAUSE_MAX_MS_ENV = "PDPP_CHATGPT_DETAIL_PAUSE_MAX_MS_PROBE";
// Hard ceiling on the probe override. Even a cold-state A/B should not fan out
// beyond dataconnect's own batch size (5); anything higher is not an A/B, it is
// a different, untested posture.
const CHATGPT_DETAIL_PROBE_MAX_CONCURRENCY_CEILING = 5;

function resolvePositiveIntOverride(raw: string | undefined, fallback: number, ceiling: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return fallback;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(parsed, ceiling);
}

function resolvePositiveMsOverride(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return fallback;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

export interface ChatGptDetailLaneTuning {
  initialConcurrency: number;
  maxConcurrency: number;
  pauseMaxMs: number;
  pauseMinMs: number;
}

/**
 * Resolve the conversation-detail lane tuning. With no probe env vars set this
 * returns the frozen production defaults; the OpenSpec concurrency constraint is
 * therefore preserved by default. Invalid values fall back to the default for
 * that knob. `maxConcurrency` is capped at `CHATGPT_DETAIL_PROBE_MAX_CONCURRENCY_CEILING`
 * and clamped to be >= `initialConcurrency`; `pauseMaxMs` is clamped to be >=
 * `pauseMinMs` so the lane's jitter window is always valid.
 */
export function resolveChatGptDetailLaneTuning(env: NodeJS.ProcessEnv = process.env): ChatGptDetailLaneTuning {
  const initialConcurrency = resolvePositiveIntOverride(
    env[CHATGPT_DETAIL_INITIAL_CONCURRENCY_ENV],
    CONVO_DETAIL_INITIAL_CONCURRENCY,
    CHATGPT_DETAIL_PROBE_MAX_CONCURRENCY_CEILING
  );
  const maxConcurrency = Math.max(
    initialConcurrency,
    resolvePositiveIntOverride(
      env[CHATGPT_DETAIL_MAX_CONCURRENCY_ENV],
      CONVO_DETAIL_MAX_CONCURRENCY,
      CHATGPT_DETAIL_PROBE_MAX_CONCURRENCY_CEILING
    )
  );
  const pauseMinMs = resolvePositiveMsOverride(env[CHATGPT_DETAIL_PAUSE_MIN_MS_ENV], CONVO_DETAIL_PAUSE_MIN_MS);
  const pauseMaxMs = Math.max(
    pauseMinMs,
    resolvePositiveMsOverride(env[CHATGPT_DETAIL_PAUSE_MAX_MS_ENV], CONVO_DETAIL_PAUSE_MAX_MS)
  );
  return { initialConcurrency, maxConcurrency, pauseMinMs, pauseMaxMs };
}

// ─── Cold-state preflight source-pressure classifier ────────────────────
//
// The cold-state A/B (PDPP_CHATGPT_DETAIL_MAX_CONCURRENCY_PROBE > 1) is the
// owner-only test that decides whether ChatGPT detail concurrency may ever rise
// above the frozen serial default. The 2026-06-02 evidence showed the throttle
// is per-ACCOUNT and time-varying: the same serial lane saw ~38% bare-429 while
// hot, then 0% hours later once cold. Raising concurrency is only safe from a
// genuinely cold start; firing a faster posture into a hot account is exactly
// the escalation the prior probe declined.
//
// This preflight closes that gap WITHOUT touching production. When the owner
// opts into the A/B by raising probe concurrency, the connector first fires a
// few SERIAL, content-free GET detail probes to classify the account. The
// request necessarily targets a conversation id, but the probe never parses or
// captures bodies and never emits bodies, titles, ids, or tokens. If any probe
// 429s, the run is forced back to the frozen serial posture (1/1) for safety
// and the faster posture is abandoned for this run. Only a clean preflight lets
// the requested faster tuning through.
//
// Invariants:
//   - Skipped entirely when maxConcurrency === 1 (production). No extra requests
//     on a normal run; the OpenSpec serial constraint holds byte-for-byte.
//   - Fails SAFE: any probe error or 429 → serial. It can only ever make a run
//     MORE conservative, never less.
//   - Reads only HTTP status. Emits no records and no sensitive strings.
const CHATGPT_PREFLIGHT_PROBE_COUNT = 3;

export interface ChatGptSourcePressureClassification {
  attempted: number;
  classification: "cold" | "pressured";
  rateLimited: number;
}

function isChatGptPressureStatus(status: number | undefined): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function rateLimitedCountForPreflightError(error: unknown): number {
  return error instanceof ChatGptRecoverableRetryExhaustedError ? 1 : 0;
}

function fetchChatGptPressureProbeStatus(
  deps: Pick<StreamDeps, "api">,
  id: string
): Promise<Pick<ChatGptFetchResult, "headers" | "status">> {
  if (!deps.api.fetchStatus) {
    throw new Error("ChatGPT status-only preflight is unavailable");
  }
  return deps.api.fetchStatus(`/conversation/${encodeURIComponent(id)}`);
}

async function classifyChatGptSerialPressure(
  deps: Pick<StreamDeps, "api">,
  ids: readonly string[]
): Promise<ChatGptSourcePressureClassification> {
  let attempted = 0;
  let rateLimited = 0;
  for (const id of ids) {
    attempted += 1;
    let status: number;
    try {
      const res = await fetchChatGptPressureProbeStatus(deps, id);
      status = res.status;
    } catch (err) {
      rateLimited += rateLimitedCountForPreflightError(err);
      return { attempted, classification: "pressured", rateLimited };
    }
    if (isChatGptPressureStatus(status)) {
      rateLimited += 1;
      return { attempted, classification: "pressured", rateLimited };
    }
  }
  return { attempted, classification: "cold", rateLimited };
}

async function classifyChatGptBurstPressure(
  deps: Pick<StreamDeps, "api">,
  probeIds: readonly string[],
  burstConcurrency: number
): Promise<ChatGptSourcePressureClassification> {
  const burstSize = Math.max(0, Math.floor(burstConcurrency));
  const ids = probeIds.slice(0, Math.min(probeIds.length, burstSize));
  if (ids.length <= 1) {
    return { attempted: 0, classification: "cold", rateLimited: 0 };
  }
  const results = await Promise.allSettled(ids.map((id) => fetchChatGptPressureProbeStatus(deps, id)));
  let rateLimited = 0;
  for (const result of results) {
    if (result.status === "rejected") {
      rateLimited += rateLimitedCountForPreflightError(result.reason);
      return { attempted: results.length, classification: "pressured", rateLimited };
    }
    if (isChatGptPressureStatus(result.value.status)) {
      rateLimited += 1;
      return { attempted: results.length, classification: "pressured", rateLimited };
    }
  }
  return { attempted: results.length, classification: "cold", rateLimited };
}

/**
 * Fire up to `probeCount` SERIAL, content-free detail probes and classify the
 * account, then optionally replay the same ids as one bounded burst canary that
 * matches the requested raised concurrency. Any 429 (or required-detail HTTP
 * failure) marks the account `pressured`; an all-200 sweep marks it `cold`.
 * Stops at the first serial 429 — one rate-limit signal is enough to force the
 * conservative posture, and continuing would add load to an already-pressured
 * bucket.
 *
 * Probes reuse the connector's own `api.fetchStatus` (so they ride the same
 * browser transport, auth, and `retryHttp`/fast-open path the real lane uses).
 * The browser fetch does not parse response JSON; only `status` is inspected.
 */
export async function classifyChatGptSourcePressure(
  deps: Pick<StreamDeps, "api">,
  probeIds: readonly string[],
  probeCount = CHATGPT_PREFLIGHT_PROBE_COUNT,
  burstConcurrency = 1
): Promise<ChatGptSourcePressureClassification> {
  if (!deps.api.fetchStatus) {
    return { attempted: 0, classification: "pressured", rateLimited: 0 };
  }
  const ids = probeIds.slice(0, Math.max(0, probeCount));
  const serial = await classifyChatGptSerialPressure(deps, ids);
  if (serial.classification === "pressured") {
    return serial;
  }
  const burst = await classifyChatGptBurstPressure(deps, probeIds, burstConcurrency);
  if (burst.classification === "pressured") {
    return {
      attempted: serial.attempted + burst.attempted,
      classification: "pressured",
      rateLimited: serial.rateLimited + burst.rateLimited,
    };
  }
  return { attempted: serial.attempted + burst.attempted, classification: "cold", rateLimited: 0 };
}

/** The frozen serial posture a pressured preflight forces a run back to. */
const CHATGPT_SERIAL_TUNING: ChatGptDetailLaneTuning = {
  initialConcurrency: CONVO_DETAIL_INITIAL_CONCURRENCY,
  maxConcurrency: CONVO_DETAIL_MAX_CONCURRENCY,
  pauseMinMs: CONVO_DETAIL_PAUSE_MIN_MS,
  pauseMaxMs: CONVO_DETAIL_PAUSE_MAX_MS,
};

/**
 * Decide the effective detail-lane tuning for this run. When the requested
 * tuning is the serial production default (maxConcurrency === 1) this is a
 * no-op: it returns the requested tuning without firing any probe, so a normal
 * run is byte-for-byte unchanged. When the owner has opted into a faster A/B
 * posture (maxConcurrency > 1), it runs a content-free serial preflight and
 * forces the run back to serial if the account is pressured.
 */
export async function applyChatGptColdStatePreflight(
  deps: StreamDeps,
  convosToSync: readonly ConversationListItem[],
  requestedTuning: ChatGptDetailLaneTuning
): Promise<ChatGptDetailLaneTuning> {
  if (requestedTuning.maxConcurrency <= 1) {
    return requestedTuning;
  }
  const probeIds = convosToSync.slice(0, CHATGPT_PREFLIGHT_PROBE_COUNT).map((c) => c.id);
  if (!probeIds.length) {
    return requestedTuning;
  }
  deps.emit({
    type: "PROGRESS",
    stream: "messages",
    message: `ChatGPT cold-state preflight: probing source pressure with ${probeIds.length} serial detail request(s) before raising detail concurrency to ${requestedTuning.maxConcurrency}`,
  });
  const result = await classifyChatGptSourcePressure(
    deps,
    probeIds,
    CHATGPT_PREFLIGHT_PROBE_COUNT,
    requestedTuning.maxConcurrency
  );
  if (result.classification === "pressured") {
    deps.emit({
      type: "PROGRESS",
      stream: "messages",
      message: `ChatGPT cold-state preflight: source is pressured (rate_limited=${result.rateLimited}/${result.attempted}); holding detail lane at serial concurrency=1 for this run`,
    });
    return CHATGPT_SERIAL_TUNING;
  }
  deps.emit({
    type: "PROGRESS",
    stream: "messages",
    message: `ChatGPT cold-state preflight: source is cold (${result.attempted}/${result.attempted} ok); allowing requested detail concurrency=${requestedTuning.maxConcurrency}`,
  });
  return requestedTuning;
}

interface ConversationDetailPacingOptions {
  random?: () => number;
  sleep?: (ms: number) => Promise<void> | void;
  tuning?: ChatGptDetailLaneTuning;
}

interface ConversationDetailCoverage {
  gapKeys: Array<string | number>;
  hydratedKeys: Array<string | number>;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldEmitConversationDetailLaneProgress(event: AdaptiveLaneEvent): boolean {
  if (event.type === "queued" || event.outcome === "ok") {
    return false;
  }
  if (event.type === "completed" && event.outcome === "terminal" && event.reason === "upstream_pressure_deferred") {
    return false;
  }
  return true;
}

function formatConversationDetailLaneProgress(event: AdaptiveLaneEvent): string {
  const parts = [
    `ChatGPT conversation-detail lane ${event.type}`,
    `active=${event.activeCount}`,
    `queued=${event.queueSize}`,
    `concurrency=${event.concurrency}/${event.maxConcurrency}`,
  ];
  if (event.attempt != null) {
    parts.push(`attempt=${event.attempt}`);
  }
  if (event.outcome != null) {
    parts.push(`outcome=${event.outcome}`);
  }
  if (event.delayMs != null) {
    parts.push(`delay_ms=${event.delayMs}`);
  }
  if (event.retryAfterMs != null) {
    parts.push(`retry_after_ms=${event.retryAfterMs}`);
  }
  if (event.errorName != null) {
    parts.push(`error=${event.errorName}`);
  }
  return parts.join(" ");
}

function safeConversationListItemHint(c: ConversationListItem): Record<string, string | number | boolean | null> {
  return {
    id: c.id,
    title: typeof c.title === "string" ? c.title : null,
    create_time: typeof c.create_time === "string" || typeof c.create_time === "number" ? c.create_time : null,
    update_time: typeof c.update_time === "string" || typeof c.update_time === "number" ? c.update_time : null,
    current_node: typeof c.current_node === "string" ? c.current_node : null,
    gizmo_id: typeof c.gizmo_id === "string" ? c.gizmo_id : null,
    is_archived: typeof c.is_archived === "boolean" ? c.is_archived : null,
    is_starred: typeof c.is_starred === "boolean" ? c.is_starred : null,
    workspace_id: typeof c.workspace_id === "string" ? c.workspace_id : null,
  };
}

function conversationListItemFromGap(gap: CollectContext["detailGaps"][number]): ConversationListItem | null {
  const locator = gap.detail_locator;
  if (!locator || locator.kind !== "chatgpt.conversation") {
    return null;
  }
  const hint = locator.list_item;
  if (!hint || typeof hint !== "object" || Array.isArray(hint)) {
    return null;
  }
  const id = typeof locator.conversation_id === "string" ? locator.conversation_id : null;
  if (!id) {
    return null;
  }
  return { ...(hint as Record<string, unknown>), id } as ConversationListItem;
}

function makeConversationDetailGap(
  c: ConversationListItem,
  error: ChatGptRecoverableRetryExhaustedError
): DetailGapMessage {
  return {
    type: "DETAIL_GAP",
    stream: "messages",
    record_key: c.id,
    status: "pending",
    reason: error.class,
    detail_locator: {
      kind: "chatgpt.conversation",
      conversation_id: c.id,
      list_item: safeConversationListItemHint(c),
    },
    retryable: true,
    reference_only: true,
    detail: {
      class: error.class,
      ...(error.httpStatus == null ? {} : { http_status: error.httpStatus }),
      ...(error.networkPressure == null ? {} : { network_pressure: error.networkPressure }),
    },
    last_error: {
      class: error.class,
      ...(error.httpStatus == null ? {} : { http_status: error.httpStatus }),
      ...(error.networkPressure == null ? {} : { network_pressure: error.networkPressure }),
    },
  };
}

function omitAttemptBudget(
  diagnostic: ChatGptNetworkPressureDiagnostic | undefined
): ChatGptNetworkPressureDiagnostic | undefined {
  if (!diagnostic) {
    return;
  }
  const { attempt: _attempt, max_attempts: _maxAttempts, ...safeDiagnostic } = diagnostic;
  return safeDiagnostic;
}

function makeDeferredConversationDetailGap(
  c: ConversationListItem,
  observedPressure: ChatGptRecoverableRetryExhaustedError
): DetailGapMessage {
  const networkPressure = omitAttemptBudget(observedPressure.networkPressure);
  return {
    type: "DETAIL_GAP",
    stream: "messages",
    record_key: c.id,
    status: "pending",
    reason: "upstream_pressure",
    detail_locator: {
      kind: "chatgpt.conversation",
      conversation_id: c.id,
      list_item: safeConversationListItemHint(c),
    },
    retryable: true,
    reference_only: true,
    detail: {
      class: "upstream_pressure_deferred",
      ...(observedPressure.httpStatus == null ? {} : { http_status: observedPressure.httpStatus }),
      ...(networkPressure == null ? {} : { network_pressure: networkPressure }),
    },
    last_error: {
      class: "upstream_pressure_deferred",
      ...(observedPressure.httpStatus == null ? {} : { http_status: observedPressure.httpStatus }),
      ...(networkPressure == null ? {} : { network_pressure: networkPressure }),
    },
  };
}

function makeConversationDetailCoverage(
  convosToSync: ConversationListItem[],
  coverage: ConversationDetailCoverage
): DetailCoverageMessage {
  const gapKeys = coverage.gapKeys;
  return {
    type: "DETAIL_COVERAGE",
    reference_only: true,
    state_stream: "conversations",
    stream: "messages",
    required_keys: convosToSync.map((c) => c.id),
    hydrated_keys: coverage.hydratedKeys,
    ...(gapKeys.length ? { gap_keys: gapKeys } : {}),
  };
}

/**
 * Fetch details one-at-a-time. ChatGPT's private detail endpoint appears to
 * throttle per authenticated account/session, and parallel retry loops keep
 * pressure on the same hot bucket. Prefer predictable low pressure over a
 * faster first-run that fails near the end and cannot commit its cursor.
 */
export async function runMessagesAndConversationsWithDetail(
  deps: StreamDeps,
  convosToSync: ConversationListItem[],
  emitConversation: (c: ConversationListItem, detail: ConversationDetail | null) => Promise<void>,
  pacing: ConversationDetailPacingOptions = {}
): Promise<ConversationDetailCoverage> {
  const random = pacing.random ?? Math.random;
  const sleep = pacing.sleep ?? sleepMs;
  // Defaults are the frozen production values (1 / 1 / 1500ms / 3000ms). A
  // cold-state A/B probe may override them via PDPP_CHATGPT_DETAIL_*_PROBE env
  // vars; see resolveChatGptDetailLaneTuning. Tests may also inject `tuning`.
  const requestedTuning = pacing.tuning ?? resolveChatGptDetailLaneTuning();
  // Cold-state preflight: only when the owner has opted into the faster A/B
  // posture (maxConcurrency > 1). Production (maxConcurrency === 1) skips this
  // entirely — no extra requests, frozen serial behavior preserved byte-for-byte.
  // A pressured account forces the run back to serial so the faster posture is
  // never fired into a hot bucket.
  const tuning = await applyChatGptColdStatePreflight(deps, convosToSync, requestedTuning);
  const coverage: ConversationDetailCoverage = { gapKeys: [], hydratedKeys: [] };
  let emittedConversationDetailLaneStart = false;
  const lane = createAdaptiveLane<ChatGptFetchResult>({
    name: "chatgpt.conversationDetail",
    initialConcurrency: tuning.initialConcurrency,
    maxConcurrency: tuning.maxConcurrency,
    maxDelayMs: tuning.pauseMaxMs,
    maxQueueSize: Math.max(1, convosToSync.length),
    minConcurrency: 1,
    minDelayMs: tuning.pauseMinMs,
    pressureMaxDelayMs: CHATGPT_RATE_LIMIT_MAX_DELAY_MS,
    pressureMinDelayMs: CHATGPT_RATE_LIMIT_BASE_DELAY_MS,
    classifyOutcome: ({ result }) => {
      if (!result) {
        return { kind: "retryable" };
      }
      if (result.deferredDueToPressure) {
        return { kind: "terminal", reason: "upstream_pressure_deferred" };
      }
      if (result.status === 429 || result.status === 502 || result.status === 503 || result.status === 504) {
        return { kind: "rate_limited" };
      }
      return { kind: "ok" };
    },
    random,
    sleep,
    emitProgress: (event) => {
      if (event.type === "started") {
        if (emittedConversationDetailLaneStart) {
          return;
        }
        emittedConversationDetailLaneStart = true;
      }
      if (!shouldEmitConversationDetailLaneProgress(event)) {
        return;
      }
      return deps.emit({
        type: "PROGRESS",
        stream: "messages",
        message: formatConversationDetailLaneProgress(event),
      });
    },
  });
  let observedRecoverablePressure: ChatGptRecoverableRetryExhaustedError | null = null;
  await lane.runAll(convosToSync, async (c) => {
    if (!c) {
      return { status: 404, json: null };
    }
    if (observedRecoverablePressure) {
      await deps.emit(makeDeferredConversationDetailGap(c, observedRecoverablePressure));
      coverage.gapKeys.push(c.id);
      return { deferredDueToPressure: true, status: 0, json: null };
    }
    let detail: ChatGptFetchResult;
    try {
      detail = await deps.api.fetch(`/conversation/${encodeURIComponent(c.id)}`);
    } catch (err) {
      if (err instanceof ChatGptRecoverableRetryExhaustedError) {
        observedRecoverablePressure = err;
        await deps.emit({
          type: "PROGRESS",
          stream: "messages",
          message:
            "ChatGPT conversation-detail lane opened upstream-pressure circuit; deferring remaining conversation details as DETAIL_GAP records",
        });
        await deps.emit(makeConversationDetailGap(c, err));
        coverage.gapKeys.push(c.id);
        return { deferredDueToPressure: true, status: 0, json: null };
      }
      throw err;
    }
    if (detail.status !== 200) {
      throw new Error(`required conversation detail ${c.id} failed with http ${detail.status}`);
    }
    await processConversationDetail(deps, c, detail, emitConversation);
    coverage.hydratedKeys.push(c.id);
    const synced = convosToSync.indexOf(c) + 1;
    const progressMsg = {
      type: "PROGRESS",
      stream: "messages",
      message: `Synced ${synced} / ${convosToSync.length} conversations`,
      count: synced,
      total: convosToSync.length,
    } as const;
    deps.emit(progressMsg);
    return detail;
  });
  return coverage;
}

async function recoverPendingConversationDetailGaps(
  deps: StreamDeps,
  emitConversation: (c: ConversationListItem, detail: ConversationDetail | null) => Promise<void>,
  pacing: ConversationDetailPacingOptions = {}
): Promise<void> {
  const recoveryItems = (deps.detailGaps ?? [])
    .filter((gap) => gap.stream === "messages")
    .map((gap) => ({ gap, conversation: conversationListItemFromGap(gap) }))
    .filter(
      (item): item is { gap: CollectContext["detailGaps"][number]; conversation: ConversationListItem } =>
        item.conversation !== null
    );
  if (!recoveryItems.length) {
    return;
  }

  const coverage = await runMessagesAndConversationsWithDetail(
    deps,
    recoveryItems.map((item) => item.conversation),
    emitConversation,
    pacing
  );
  const hydrated = new Set(coverage.hydratedKeys.map(String));
  for (const { gap, conversation } of recoveryItems) {
    if (!hydrated.has(conversation.id)) {
      continue;
    }
    await deps.emit({
      type: "DETAIL_GAP_RECOVERED",
      reference_only: true,
      gap_id: gap.gap_id,
      stream: "messages",
      record_key: conversation.id,
    });
  }
}

export async function runConversationsAndMessagesStreams(
  deps: StreamDeps,
  state: CollectContext["state"],
  options: { detailPacing?: ConversationDetailPacingOptions } = {}
): Promise<void> {
  const conversationsCursor = state.conversations as { last_update_time?: string | null } | undefined;
  const messagesCursor = state.messages as { last_update_time?: string | null } | undefined;
  const priorConversationsCursor = conversationsCursor?.last_update_time || null;
  const priorMessagesCursor = messagesCursor?.last_update_time || null;
  const wantsConversations = deps.requested.has("conversations");
  const wantsMessages = deps.requested.has("messages");
  const listedByCursor = new Map<string, Promise<ConversationListItem[]>>();
  const listForCursor = (cursor: string | null): Promise<ConversationListItem[]> => {
    const key = cursor ?? "";
    const existing = listedByCursor.get(key);
    if (existing) {
      return existing;
    }
    const listed = listConversationsSinceCursor(deps, cursor);
    listedByCursor.set(key, listed);
    return listed;
  };
  const emitConversation = async (c: ConversationListItem, detail: ConversationDetail | null): Promise<void> => {
    if (!wantsConversations) {
      return;
    }
    await deps.emitRecord("conversations", buildConversationRecord(c, detail));
  };

  if (wantsMessages) {
    await recoverPendingConversationDetailGaps(deps, emitConversation, options.detailPacing);
  }

  const conversationsToSync = wantsConversations ? await listForCursor(priorConversationsCursor) : [];
  if (wantsConversations) {
    const foundProgressMsg = {
      type: "PROGRESS",
      stream: "conversations",
      message: `Found ${conversationsToSync.length} conversations to sync`,
      count: conversationsToSync.length,
      total: conversationsToSync.length,
    } as const;
    deps.emit(foundProgressMsg);
  }

  const messageDetailConversations = wantsMessages ? await listForCursor(priorMessagesCursor) : [];
  if (wantsMessages) {
    const foundMessageDetailProgressMsg = {
      type: "PROGRESS",
      stream: "messages",
      message: `Found ${messageDetailConversations.length} conversations requiring message detail`,
      count: messageDetailConversations.length,
      total: messageDetailConversations.length,
    } as const;
    deps.emit(foundMessageDetailProgressMsg);
    const coverage = await runMessagesAndConversationsWithDetail(
      deps,
      messageDetailConversations,
      emitConversation,
      options.detailPacing
    );
    if (messageDetailConversations.length) {
      await deps.emit(makeConversationDetailCoverage(messageDetailConversations, coverage));
      const maxMessagesUpdate = maxUpdateTimeIso(messageDetailConversations);
      deps.emit({
        type: "STATE",
        stream: "messages",
        cursor: { last_update_time: maxMessagesUpdate || priorMessagesCursor || null },
      });
    }
  }

  if (wantsConversations) {
    const detailedIds = new Set(messageDetailConversations.map((c) => c.id));
    // Emit list-only parents for conversation rows not already repaired by
    // message-detail fetches in this run.
    for (const c of conversationsToSync) {
      if (detailedIds.has(c.id)) {
        continue;
      }
      await emitConversation(c, null);
    }
  }

  if (wantsConversations && conversationsToSync.length) {
    const maxUpdate = maxUpdateTimeIso(conversationsToSync);
    deps.emit({
      type: "STATE",
      stream: "conversations",
      cursor: { last_update_time: maxUpdate || priorConversationsCursor || null },
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
    async ensureSession({ assist, capture, completeAssistance, context, page, progress, sendInteraction }) {
      await ensureChatGptSession({
        assist,
        capture,
        completeAssistance,
        context,
        page,
        progress,
        sendInteraction,
      });
    },
    async collect(ctx: CollectContext | BrowserCollectContext): Promise<void> {
      const { state, requested, emit, emitRecord: baseEmitRecord, progress, capture } = ctx;
      const { page } = ctx as BrowserCollectContext;

      // API client closes over page + capture — no module-level mutable state,
      // auth cached inside the closure for the run's lifetime.
      const api = createChatGptApi({ page, capture, emit });
      const emitRecord = makeEmitRecord(baseEmitRecord);

      // Verify session (extract bearer token for /backend-api calls)
      const auth = await api.auth();
      progress(`Authenticated to ChatGPT (device_id=${auth.deviceId ? `${auth.deviceId.slice(0, 8)}…` : "unknown"})`);

      const deps: StreamDeps = { api, detailGaps: ctx.detailGaps, emit, emitRecord, progress, requested };

      if (isChatGptSideEffectProbeEnabled()) {
        await runChatGptSideEffectProbe({ api, emit, page });
        return;
      }

      if (requested.has("memories")) {
        await runMemoriesStream(deps);
      }
      if (requested.has("custom_gpts")) {
        await runCustomGptsStream(deps);
      }
      if (requested.has("custom_instructions")) {
        await runCustomInstructionsStream(deps, state);
      }
      if (requested.has("shared_conversations")) {
        await runSharedConversationsStream(deps, state);
      }
      if (requested.has("conversations") || requested.has("messages")) {
        await runConversationsAndMessagesStreams(deps, state);
      }
    },
    retryablePattern: CHATGPT_RETRYABLE_ERROR_PATTERN,
  });
}
