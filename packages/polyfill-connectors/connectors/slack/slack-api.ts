// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Direct Slack Web API calls for the four streams slackdump's archive mode
 * cannot produce: `stars`, `user_groups`, `reminders`, `dm_read_states`.
 *
 * Every other Slack stream reads from the slackdump SQLite archive (see
 * index.ts); these four call `stars.list`, `usergroups.list`,
 * `reminders.list`, and `conversations.info` directly against
 * `https://slack.com/api/`, authenticated with the SAME session credential
 * the connector already captures for slackdump (`SLACK_TOKEN` xoxc token +
 * `SLACK_COOKIE` the `d` cookie) — no new credential/auth modality. See
 * openspec/changes/complete-slack-bundled-connector-coverage for the
 * evidence that these methods are reachable with that credential and are
 * not exposed by slackdump's own CLI.
 *
 * Transport: these calls MUST run through a real Chromium page
 * (`SlackApiBrowserTransport`, provided by `index.ts`'s `runOptionalStream`
 * caller), not plain Node `fetch`. Root-caused live: slackdump's own Slack
 * Web API client (`rusq/slackdump`'s `auth.simpleProvider.HTTPClient`,
 * `chttp.New(..., chttp.WithUTLS(&utls.Config{}))`) wraps every live call —
 * including `conversations.info`, exposed on the exact same `Slack`
 * interface slackdump's archive/resume path uses — in a uTLS transport that
 * emulates a real Chrome TLS ClientHello. A plain Node `fetch()` presents a
 * different TLS fingerprint at the handshake layer regardless of any HTTP
 * header (User-Agent, Cookie) it sends, and Slack's edge rejects that
 * fingerprint as `invalid_auth`/401 even for a token+cookie pair slackdump's
 * own concurrent calls prove valid — confirmed by reading slackdump's actual
 * request-construction path (`internal/client/client.go`
 * `newSlackClient`/`auth/auth.go` `simpleProvider.HTTPClient`), not
 * inferred. `SlackApiBrowserTransport` runs the request inside a real
 * Chromium page (`page.evaluate(fetch)`, the same mechanism the ChatGPT
 * connector already uses to preserve Cloudflare's TLS fingerprint check —
 * see `connectors/chatgpt/index.ts` `chatGptBackendFetchInBrowser`) so the
 * TLS handshake is genuinely Chromium's, not reimplemented/spoofed.
 */

import { type ConnectorHttpGovernor, createConnectorHttpGovernor } from "../../src/connector-http-governor.ts";
import { slackApiPacingProfile } from "../../src/provider-profile.ts";
import type {
  SlackConversationInfoResponse,
  SlackReminder,
  SlackRemindersListResponse,
  SlackStarItem,
  SlackStarsListResponse,
  SlackUserGroup,
  SlackUserGroupsListResponse,
} from "./types.ts";

const API_BASE = "https://slack.com/api/";

function slackBrowserUserAgent(): string {
  switch (process.platform) {
    case "darwin":
      return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
    case "win32":
      return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
    default:
      return "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
  }
}

const USER_AGENT = slackBrowserUserAgent();

export const SLACK_API_RETRYABLE_FAILURE_RE = /slack_rate_limited|ECONN|ETIMEDOUT|timeout/i;

/**
 * A failure whose error message identifies it as an auth/session problem
 * (`slack_auth_failed`, thrown by `parseSlackApiResponse` for a 401 or an
 * `invalid_auth`/`not_authed`/`token_revoked` API-level error). Distinct
 * from `SLACK_API_RETRYABLE_FAILURE_RE`: an auth failure will not clear by
 * retrying the same call, so it must never be reported with the same
 * `retry_by_runtime` recovery action a transient failure gets.
 */
export const SLACK_API_AUTH_FAILURE_RE = /slack_auth_failed/;

/**
 * Extract the stable, coded prefix `parseSlackApiResponse` throws
 * (`slack_auth_failed`, `slack_api_http_<status>`, `slack_api_error_<code>`,
 * `slack_api_invalid_json`) from an error message, for structured
 * `SKIP_RESULT.diagnostics` — evidence a downstream report/health rollup can
 * key on instead of substring-matching free text. Returns the coded prefix
 * verbatim (no response body) when the message matches one of
 * `parseSlackApiResponse`'s own throw shapes; `null` for anything else
 * (a network-layer error, a thrown non-Slack-API exception).
 */
const SLACK_API_ERROR_CODE_RE = /^(slack_auth_failed|slack_api_http_\d+|slack_api_error_\S+|slack_api_invalid_json)\b/;

export function parseSlackApiErrorCode(message: string): string | null {
  const match = SLACK_API_ERROR_CODE_RE.exec(message);
  return match?.[1] ?? null;
}

/**
 * Mirror slackdump's client-token cookie shape.
 *
 * Slackdump's upstream auth provider sends both the `d` cookie and a derived
 * `d-s` cookie for client tokens. The latter is generated from the current
 * Unix timestamp and acts as an expected session freshness marker.
 */
export function buildSlackSessionCookieHeader(cookie: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  return `d=${cookie}; d-s=${String(nowSeconds - 10)}`;
}

let httpGovernor: ConnectorHttpGovernor = createConnectorHttpGovernor({
  name: "slack",
  maxAttempts: 4,
  profile: slackApiPacingProfile(),
});

/** Reset the module governor to a cold start. Test-only seam. */
export function resetSlackApiGovernor(): void {
  httpGovernor = createConnectorHttpGovernor({
    name: "slack",
    maxAttempts: 4,
    profile: slackApiPacingProfile(),
  });
}

interface SlackApiRawResponse {
  body: string;
  retryAfter?: string;
  status: number;
}

export interface SlackApiRequestInit {
  body?: string;
  headers: Record<string, string>;
  method: "GET" | "POST";
  url: string;
}

/**
 * Issues one HTTP request and returns its status/body/retry-after. The
 * default (`nodeFetchSlackApiTransport`) uses Node `fetch` — this is the
 * ORIGINAL, still-available transport, kept as the fallback for tests and
 * for any caller that hasn't wired a browser page. Every live call from
 * `index.ts`'s `runOptionalStream` MUST use `createBrowserSlackApiTransport`
 * instead (see module header for why: TLS fingerprinting).
 */
export type SlackApiTransport = (req: SlackApiRequestInit) => Promise<SlackApiRawResponse>;

export async function nodeFetchSlackApiTransport(req: SlackApiRequestInit): Promise<SlackApiRawResponse> {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    ...(req.body === undefined ? {} : { body: req.body }),
  });
  const retryAfter = res.headers.get("retry-after");
  return {
    body: await res.text().catch((): string => ""),
    status: res.status,
    ...(retryAfter === null ? {} : { retryAfter }),
  };
}

/**
 * The function actually serialized into the Chromium page by
 * `createBrowserSlackApiTransport` (via `page.evaluate`). MUST be a pure,
 * self-contained function — Playwright stringifies it and runs it in the
 * page's own JS context, so it cannot close over any module-scope value
 * (mirrors `chatGptBackendFetchInBrowser` in `connectors/chatgpt/index.ts`,
 * the established pattern for this exact TLS-fingerprint problem). Runs as
 * `window.fetch` inside the page, riding Chromium's real network stack —
 * the whole reason this function exists instead of calling Node `fetch`
 * directly. The page's cookie jar (seeded by the caller via
 * `context.addCookies` before this ever runs) supplies `d`/`d-s`; only the
 * bearer/form token and non-cookie headers are passed in explicitly.
 */
export async function slackApiFetchInBrowser(req: SlackApiRequestInit): Promise<SlackApiRawResponse> {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    credentials: "include",
    ...(req.body === undefined ? {} : { body: req.body }),
  });
  const retryAfter = res.headers.get("retry-after");
  return {
    body: await res.text().catch((): string => ""),
    status: res.status,
    ...(retryAfter === null ? {} : { retryAfter }),
  };
}

/** The minimal Playwright `Page` surface this module depends on. */
export interface SlackApiBrowserPage {
  evaluate: <R, Arg>(pageFunction: (arg: Arg) => R | Promise<R>, arg: Arg) => Promise<R>;
}

/**
 * Build a `SlackApiTransport` that runs every request through `page`
 * (`page.evaluate(slackApiFetchInBrowser, req)`), so the request's TLS
 * handshake is Chromium's real ClientHello, not Node's. The caller
 * (`index.ts`) is responsible for seeding the page's browser context with
 * the `d`/`d-s` session cookies via `context.addCookies` before any call
 * through this transport — this function does not manage cookies, only
 * dispatch.
 */
export function createBrowserSlackApiTransport(page: SlackApiBrowserPage): SlackApiTransport {
  return (req) => page.evaluate(slackApiFetchInBrowser, req);
}

/**
 * POST a Slack Web API method with `application/x-www-form-urlencoded`
 * params, authenticated as `token` (matches `rusq/slack`'s `postForm` —
 * the same call shape slackdump's own dependency uses for these methods)
 * plus the derived session cookie pair (`d` + `d-s`) and browser UA that
 * Slackdump's auth substrate sends for client tokens.
 */
async function slackApiPost<T extends { error?: string; ok: boolean }>(
  transport: SlackApiTransport,
  method: string,
  token: string,
  cookie: string,
  params: Record<string, string>
): Promise<T> {
  const body = new URLSearchParams({ token, ...params });
  let raw: SlackApiRawResponse;
  try {
    const r = await httpGovernor.request<SlackApiRawResponse, SlackApiRawResponse>(
      () =>
        transport({
          url: `${API_BASE}${method}`,
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: buildSlackSessionCookieHeader(cookie),
            "User-Agent": USER_AGENT,
          },
          body: body.toString(),
        }),
      (resp) => ({
        status: resp.status,
        ...(resp.retryAfter === undefined ? {} : { headers: { "retry-after": resp.retryAfter } }),
        value: resp,
      })
    );
    raw = r.value;
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
  return parseSlackApiResponse<T>(raw);
}

/**
 * GET a Slack Web API method (query-string params), authenticated with
 * `Authorization: Bearer <token>` (matches `rusq/slack`'s `getResource`)
 * plus the derived session cookie pair (`d` + `d-s`) and browser UA.
 */
async function slackApiGet<T extends { error?: string; ok: boolean }>(
  transport: SlackApiTransport,
  method: string,
  token: string,
  cookie: string,
  params: Record<string, string>
): Promise<T> {
  const query = new URLSearchParams(params).toString();
  let raw: SlackApiRawResponse;
  try {
    const r = await httpGovernor.request<SlackApiRawResponse, SlackApiRawResponse>(
      () =>
        transport({
          url: `${API_BASE}${method}?${query}`,
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            Cookie: buildSlackSessionCookieHeader(cookie),
            "User-Agent": USER_AGENT,
          },
        }),
      (resp) => ({
        status: resp.status,
        ...(resp.retryAfter === undefined ? {} : { headers: { "retry-after": resp.retryAfter } }),
        value: resp,
      })
    );
    raw = r.value;
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
  return parseSlackApiResponse<T>(raw);
}

function parseSlackApiResponse<T extends { error?: string; ok: boolean }>(raw: SlackApiRawResponse): T {
  if (raw.status === 401) {
    throw new Error("slack_auth_failed");
  }
  if (raw.status < 200 || raw.status >= 300) {
    throw new Error(`slack_api_http_${String(raw.status)}: ${raw.body.slice(0, 200)}`);
  }
  let parsed: T;
  try {
    parsed = JSON.parse(raw.body) as T;
  } catch (err) {
    throw new Error(`slack_api_invalid_json: ${raw.body.slice(0, 200)}`, { cause: err });
  }
  if (!parsed.ok) {
    if (parsed.error === "invalid_auth" || parsed.error === "not_authed" || parsed.error === "token_revoked") {
      throw new Error("slack_auth_failed");
    }
    throw new Error(`slack_api_error_${parsed.error ?? "unknown"}`);
  }
  return parsed;
}

// ─── stars.list ──────────────────────────────────────────────────────────

const STARS_PAGE_COUNT = "100";

export async function fetchAllStars(
  transport: SlackApiTransport,
  token: string,
  cookie: string
): Promise<SlackStarItem[]> {
  const items: SlackStarItem[] = [];
  let cursor: string | undefined;
  do {
    const params: Record<string, string> = { count: STARS_PAGE_COUNT };
    if (cursor) {
      params.cursor = cursor;
    }
    const resp = await slackApiPost<SlackStarsListResponse>(transport, "stars.list", token, cookie, params);
    items.push(...(resp.items ?? []));
    cursor = resp.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return items;
}

// ─── usergroups.list ─────────────────────────────────────────────────────

export async function fetchAllUserGroups(
  transport: SlackApiTransport,
  token: string,
  cookie: string
): Promise<SlackUserGroup[]> {
  const resp = await slackApiPost<SlackUserGroupsListResponse>(transport, "usergroups.list", token, cookie, {
    include_users: "true",
    include_count: "true",
    include_disabled: "true",
  });
  return resp.usergroups ?? [];
}

// ─── reminders.list ──────────────────────────────────────────────────────

export async function fetchAllReminders(
  transport: SlackApiTransport,
  token: string,
  cookie: string
): Promise<SlackReminder[]> {
  const resp = await slackApiPost<SlackRemindersListResponse>(transport, "reminders.list", token, cookie, {});
  return resp.reminders ?? [];
}

// ─── conversations.info ──────────────────────────────────────────────────

export interface DmReadState {
  channelId: string;
  lastRead: string | null;
  unreadCount: number | null;
  unreadCountDisplay: number | null;
}

/**
 * One `conversations.info` call per DM/MPIM channel ID. Callers scope
 * `channelIds` to `is_im`/`is_mpim` channels only (see
 * `collectDmReadStates` in index.ts) — this function does not filter by
 * channel type itself, keeping it a pure per-ID fetch.
 */
export async function fetchDmReadStates(
  transport: SlackApiTransport,
  token: string,
  cookie: string,
  channelIds: readonly string[]
): Promise<DmReadState[]> {
  const out: DmReadState[] = [];
  for (const channelId of channelIds) {
    const resp = await slackApiGet<SlackConversationInfoResponse>(transport, "conversations.info", token, cookie, {
      channel: channelId,
    });
    const ch = resp.channel;
    out.push({
      channelId,
      lastRead: ch?.last_read ?? null,
      unreadCount: ch?.unread_count ?? null,
      unreadCountDisplay: ch?.unread_count_display ?? null,
    });
  }
  return out;
}
