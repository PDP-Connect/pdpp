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
 * `SLACK_COOKIE` the `d` cookie) and the same browser-shaped request
 * posture slackdump uses (derived `d-s` cookie + browser UA) — no new auth
 * modality. See openspec/changes/complete-slack-bundled-connector-coverage
 * for the evidence that these methods are reachable with that credential
 * and are not exposed by slackdump's own CLI.
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

/**
 * POST a Slack Web API method with `application/x-www-form-urlencoded`
 * params, authenticated as `token` (matches `rusq/slack`'s `postForm` —
 * the same call shape slackdump's own dependency uses for these methods)
 * plus the derived session cookie pair (`d` + `d-s`) and browser UA that
 * Slackdump's auth substrate sends for client tokens.
 */
async function slackApiPost<T extends { error?: string; ok: boolean }>(
  method: string,
  token: string,
  cookie: string,
  params: Record<string, string>
): Promise<T> {
  const body = new URLSearchParams({ token, ...params });
  let raw: SlackApiRawResponse;
  try {
    const r = await httpGovernor.request<SlackApiRawResponse, SlackApiRawResponse>(
      async (): Promise<SlackApiRawResponse> => {
        const res = await fetch(`${API_BASE}${method}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: buildSlackSessionCookieHeader(cookie),
            "User-Agent": USER_AGENT,
          },
          body: body.toString(),
        });
        const retryAfter = res.headers.get("retry-after");
        return {
          body: await res.text().catch((): string => ""),
          status: res.status,
          ...(retryAfter == null ? {} : { retryAfter }),
        };
      },
      (resp) => ({
        status: resp.status,
        ...(resp.retryAfter == null ? {} : { headers: { "retry-after": resp.retryAfter } }),
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
  method: string,
  token: string,
  cookie: string,
  params: Record<string, string>
): Promise<T> {
  const query = new URLSearchParams(params).toString();
  let raw: SlackApiRawResponse;
  try {
    const r = await httpGovernor.request<SlackApiRawResponse, SlackApiRawResponse>(
      async (): Promise<SlackApiRawResponse> => {
        const res = await fetch(`${API_BASE}${method}?${query}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Cookie: buildSlackSessionCookieHeader(cookie),
            "User-Agent": USER_AGENT,
          },
        });
        const retryAfter = res.headers.get("retry-after");
        return {
          body: await res.text().catch((): string => ""),
          status: res.status,
          ...(retryAfter == null ? {} : { retryAfter }),
        };
      },
      (resp) => ({
        status: resp.status,
        ...(resp.retryAfter == null ? {} : { headers: { "retry-after": resp.retryAfter } }),
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
  } catch {
    throw new Error(`slack_api_invalid_json: ${raw.body.slice(0, 200)}`);
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

export async function fetchAllStars(token: string, cookie: string): Promise<SlackStarItem[]> {
  const items: SlackStarItem[] = [];
  let cursor: string | undefined;
  do {
    const params: Record<string, string> = { count: STARS_PAGE_COUNT };
    if (cursor) {
      params.cursor = cursor;
    }
    const resp = await slackApiPost<SlackStarsListResponse>("stars.list", token, cookie, params);
    items.push(...(resp.items ?? []));
    cursor = resp.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return items;
}

// ─── usergroups.list ─────────────────────────────────────────────────────

export async function fetchAllUserGroups(token: string, cookie: string): Promise<SlackUserGroup[]> {
  const resp = await slackApiPost<SlackUserGroupsListResponse>("usergroups.list", token, cookie, {
    include_users: "true",
    include_count: "true",
    include_disabled: "true",
  });
  return resp.usergroups ?? [];
}

// ─── reminders.list ──────────────────────────────────────────────────────

export async function fetchAllReminders(token: string, cookie: string): Promise<SlackReminder[]> {
  const resp = await slackApiPost<SlackRemindersListResponse>("reminders.list", token, cookie, {});
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
  token: string,
  cookie: string,
  channelIds: readonly string[]
): Promise<DmReadState[]> {
  const out: DmReadState[] = [];
  for (const channelId of channelIds) {
    const resp = await slackApiGet<SlackConversationInfoResponse>("conversations.info", token, cookie, {
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
