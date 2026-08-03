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
 * Transport: the production path uses `nodeFetchSlackApiTransport`, matching
 * Slackdump's current `auth.simpleProvider.HTTPClient`/`chttp.New` HTTP
 * client and cookie-jar contract. The request carries the same form token,
 * `d`/`d-s` cookies, and user agent that Slackdump uses. The browser helpers
 * below remain as an isolated test/compatibility seam; they are not required
 * to collect these streams.
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

export const SLACK_API_RETRYABLE_FAILURE_RE =
  /slack_rate_limited|slack_api_browser_origin_mismatch|ECONN|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EPIPE|ETIMEDOUT|fetch failed|failed to fetch|network (?:error|failure)|socket hang up|timeout|HTTP request got retryable status \d+/i;

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
 * A failure whose error message identifies a caller's optional browser
 * transport as structurally unavailable
 * (`slack_api_browser_unavailable`/`slack_api_browser_setup_failed`, thrown by
 * `acquireSlackApiBrowserTransport` in `index.ts`). Distinct from both
 * `SLACK_API_AUTH_FAILURE_RE` (the session/token was rejected — an
 * operator should re-authenticate) and `SLACK_API_RETRYABLE_FAILURE_RE` (a
 * transient upstream condition that clears on its own): a missing browser
 * capability will not clear by retrying on the SAME runtime, and it is not
 * a Slack-side rejection at all. If a caller uses the compatibility helper,
 * it must resolve to its own `reason`/`recovery_hint` in
 * `runOptionalStream`, never collapsed into the generic
 * `optional_stream_failed` an API-layer failure gets — see
 * `OPTIONAL_STREAM_CAPABILITY_MISSING_REASON`.
 */
export const SLACK_API_BROWSER_CAPABILITY_FAILURE_RE = /slack_api_browser_(unavailable|setup_failed)/;

/** A browser reached a different origin after the Slack API bootstrap navigation. */
export const SLACK_API_BROWSER_ORIGIN_MISMATCH_RE = /slack_api_browser_origin_mismatch/;

/**
 * Extract the stable, coded prefix an error message carries, for structured
 * `SKIP_RESULT.diagnostics` — evidence a downstream report/health rollup can
 * key on instead of substring-matching free text. Returns the coded prefix
 * verbatim (no response body) when the message matches one of
 * `parseSlackApiResponse`'s own throw shapes (`slack_auth_failed`,
 * `slack_api_http_<status>`, `slack_api_error_<code>`,
 * `slack_api_invalid_json`) or `acquireSlackApiBrowserTransport`'s own throw
 * shapes (`slack_api_browser_unavailable`, `slack_api_browser_setup_failed`
 * — see `SLACK_API_BROWSER_CAPABILITY_FAILURE_RE` — and
 * `slack_api_browser_origin_mismatch`); `null` for anything else (a
 * network-layer error, a thrown non-Slack-API exception).
 */
const SLACK_API_ERROR_CODE_RE =
  /^(slack_auth_failed|slack_api_http_\d+|slack_api_error_\S+|slack_api_invalid_json|slack_api_browser_unavailable|slack_api_browser_setup_failed|slack_api_browser_origin_mismatch)\b/;

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
 * production Slack gap streams use `nodeFetchSlackApiTransport` directly;
 * callers can still inject another transport for tests or compatibility.
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
 * (mirrors `chatGptBackendFetchInBrowser` in `connectors/chatgpt/index.ts`).
 * Runs as
 * `window.fetch` inside the page, riding Chromium's real network stack —
 * the reason this compatibility function exists. The page's cookie jar
 * (seeded by the caller via
 * `context.addCookies` before this ever runs) supplies `d`/`d-s`; only the
 * bearer/form token and browser-permitted headers are passed in explicitly.
 * `Cookie` and `User-Agent` are deliberately removed here because browser
 * JavaScript cannot authoritatively set either header.
 */
export async function slackApiFetchInBrowser(req: SlackApiRequestInit): Promise<SlackApiRawResponse> {
  const browserHeaders = Object.fromEntries(
    Object.entries(req.headers).filter(([name]) => !["cookie", "user-agent"].includes(name.toLowerCase()))
  );
  const res = await fetch(req.url, {
    method: req.method,
    headers: browserHeaders,
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
  goto: (
    url: string,
    options?: {
      timeout?: number;
      waitUntil?: "commit" | "domcontentloaded" | "load" | "networkidle";
    }
  ) => Promise<unknown>;
  url: () => string;
}

/**
 * Build a `SlackApiTransport` that runs every request through `page`
 * (`page.evaluate(slackApiFetchInBrowser, req)`). The caller (`index.ts`) is
 * responsible for seeding the page's browser context with the `d`/`d-s`
 * session cookies via `context.addCookies` before any call through this
 * transport — this function does not manage cookies, only dispatch.
 */
export function createBrowserSlackApiTransport(page: SlackApiBrowserPage): SlackApiTransport {
  return (req) => page.evaluate(slackApiFetchInBrowser, req);
}

/**
 * POST a Slack Web API method with `application/x-www-form-urlencoded`
 * params, authenticated as `token` (matches `rusq/slack`'s `postForm` —
 * the same call shape slackdump's own dependency uses for these methods)
 * plus the derived session cookie pair (`d` + `d-s`) and user agent that
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
    const resp = await slackApiPost<SlackConversationInfoResponse>(transport, "conversations.info", token, cookie, {
      channel: channelId,
      include_locale: "false",
      include_num_members: "false",
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
