/**
 * Direct Slack Web API calls for the four streams slackdump's archive mode
 * cannot produce: `stars`, `user_groups`, `reminders`, `dm_read_states`.
 *
 * Every other Slack stream reads from the slackdump SQLite archive (see
 * index.ts); these four call `stars.list`, `usergroups.list`,
 * `reminders.list`, and `conversations.info` directly against
 * `https://slack.com/api/`, authenticated with the SAME session credential
 * the connector already captures for slackdump (`SLACK_TOKEN` xoxc token +
 * `SLACK_COOKIE` the `d` cookie) — no new auth modality. See
 * openspec/changes/complete-slack-bundled-connector-coverage for the
 * evidence that these methods are reachable with that credential and are
 * not exposed by slackdump's own CLI.
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
const USER_AGENT = "pdpp-connector-slack/0.5";

export const SLACK_API_RETRYABLE_FAILURE_RE = /slack_rate_limited|ECONN|ETIMEDOUT|timeout/i;

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
 * plus the `d` session cookie every session-token call requires.
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
            Cookie: `d=${cookie}`,
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
 * plus the `d` session cookie.
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
            Cookie: `d=${cookie}`,
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
