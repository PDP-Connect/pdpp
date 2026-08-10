#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Venmo Connector (v0.1.0)
 *
 * Ground truth: docs/connector-authoring-guide.md §1 ranks sources
 * official API > archive export > structured web endpoints > HTML scrape.
 * Venmo's own Developer/Payouts API was retired to new integrators
 * (venmo.com/docs/overview/, confirmed 2026-08-09; legacy access survives
 * only for businesses onboarded before ~2016). Venmo's GDPR-style "Request
 * Your Data" export (venmo.com -> Settings -> Privacy -> Request Your Data)
 * is the highest-ranked reachable path but is async and email-delivered
 * with no polling API, so it cannot drive an automated connector.
 *
 * This connector instead talks directly to the internal JSON API the
 * Venmo apps themselves use, `https://api.venmo.com/v1`, documented (MIT,
 * unofficial, "not PayPal/Venmo sponsored or maintained") by
 * github.com/mmohades/VenmoApiDocumentation and its companion Python
 * client github.com/mmohades/Venmo, both fetched/read 2026-08-09. This is
 * the guide's tier-3 "structured web endpoints... reverse-engineerable"
 * category — the same tier as this repo's `reddit` connector, and
 * strictly above HTML scraping. Every endpoint path, header, and JSON
 * field name below is read from that client's source, not guessed.
 *
 * Auth: username/password login against `POST /oauth/access_token`. Venmo
 * gates most first-time logins behind SMS 2FA; the handshake is:
 *   1. POST /oauth/access_token with credentials + a generated `device-id`.
 *   2. A 2FA-required account gets HTTP 401 with a `venmo-otp-secret`
 *      response header (no access_token in the body).
 *   3. POST /account/two-factor/token with that secret to trigger an SMS.
 *   4. The owner supplies the 6-digit code via `sendInteraction`.
 *   5. POST /oauth/access_token again with `venmo-otp`/`venmo-otp-secret`
 *      headers to complete login and receive `access_token`.
 * Per the client docs the resulting bearer token does not expire (revoked
 * only via `DELETE /oauth/access_token`), so this connector accepts a
 * pre-obtained `VENMO_ACCESS_TOKEN` as a bootstrap-once fast path — the
 * same PAT-style pattern as YNAB — and only drives the login+OTP handshake
 * when no token is supplied. This is a pure-HTTP connector — no browser
 * config on runConnector's options: `sendInteraction` is available to any
 * `collect()`, browser-backed or not (src/connector-runtime.ts
 * BaseCollectContext), so the OTP challenge needs no Playwright session.
 *
 * Streams:
 *   - profile: the authenticated owner's own account (GET /account).
 *   - friends: the owner's Venmo friends list (GET /users/{id}/friends).
 *   - transactions: payments sent/requested/received visible to the owner
 *     (GET /stories/target-or-actor/{id}), Venmo's own payment_type
 *     vocabulary { pay, charge }. Refunds/bank-transfers/top-ups/card
 *     authorizations/ATM withdrawals/disbursements share the same
 *     `/stories` feed but carry no `payment` object in the documented
 *     shape (venmo_api/models/transaction.py TransactionType enum) and
 *     are intentionally not modeled — see parsers.ts transactionRecord.
 *
 * Tested surfaces: NONE. This connector has not been run against a real
 * Venmo account. Every code path below is built from the documented
 * unofficial-client shapes, not from a live capture. Do not treat this as
 * live-ready; see the manifest's `public_listing.status: "unproven"` and
 * the connector's own test suite (fixture-driven, no live network).
 */

import { createConnectorHttpGovernor } from "../../src/connector-http-governor.ts";
import type { CollectContext } from "../../src/connector-runtime.ts";
import { runConnector } from "../../src/connector-runtime.ts";
import { openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import { redactTransportDetail } from "../../src/http-retry.ts";
import { isMainModule } from "../../src/is-main-module.ts";
import { venmoPacingProfile } from "../../src/provider-profile.ts";
import { API_BASE, profileRecord, transactionRecord, userRecord } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type {
  VenmoAccessTokenResponse,
  VenmoAccountResponse,
  VenmoFriendsResponse,
  VenmoStoriesResponse,
  VenmoStory,
  VenmoTwoFactorRequiredResponse,
} from "./types.ts";

// Single per-provider send governor + retry layer. `maxAttempts: 1` mirrors
// every other governor-using connector in this repo (strava, ynab, github):
// the 429 throw stays byte-identical for `retryablePattern`-driven cross-run
// cooldown, rather than retrying in-run against an undocumented limit.
const httpGovernor = createConnectorHttpGovernor({
  name: "venmo",
  maxAttempts: 1,
  profile: venmoPacingProfile(),
});

const TWO_FACTOR_ERROR_CODE = 81_109;
const FRIENDS_PAGE_SIZE = 200;
const TRANSACTIONS_PAGE_SIZE = 50;
const MAX_TRANSACTION_PAGES = 400;

// Locally widened progress-extra shape (matches strava/ynab's own local
// widenings): the shared `ProgressExtra` type only declares the fields the
// runtime itself interprets; connectors are free to attach additional
// diagnostic fields the runtime passes through verbatim.
interface VenmoProgressExtra {
  cursor_present?: boolean;
  item_count?: number;
  offset_ordinal?: number;
  phase?: string;
  stream?: string;
  total_seen?: number;
}
type VenmoProgress = (message: string, extra?: VenmoProgressExtra) => Promise<void>;

function randomDeviceId(): string {
  // Matches the unofficial client's own device-id shape closely enough to
  // avoid standing out (venmo_api/utils uses a UUID-like token); the exact
  // format is undocumented, so this only needs to be a stable-looking,
  // unique-per-run identifier, not a byte-exact replica.
  return `88884260-020f-424e-${Math.random().toString(16).slice(2, 6)}-${Date.now().toString(16)}`;
}

interface VenmoHttpResponse {
  body: string;
  headers: Record<string, string | undefined>;
  status: number;
}

/**
 * Templated endpoint label for terminal errors — never the resolved URL
 * (which could start carrying a token in a query string if Venmo's API
 * ever changes shape) and never a live resource id (user id, story id).
 * `path` here is always a literal or already-templated string from the
 * call site — see the `{id}` placeholders used below.
 */
function endpointLabel(path: string): string {
  return path;
}

/**
 * `path` is used only for the terminal-error label, so call sites pass a
 * TEMPLATED path (e.g. `/users/{id}/friends`), never the live one with a
 * real id interpolated in — the live id lives only in `requestPath`.
 */
async function venmoRequest(
  requestPath: string,
  path: string,
  init: { body?: unknown; headers?: Record<string, string>; method: string; query?: Record<string, string> }
): Promise<VenmoHttpResponse> {
  const url = new URL(API_BASE + requestPath);
  for (const [key, value] of Object.entries(init.query ?? {})) {
    url.searchParams.set(key, value);
  }
  try {
    const result = await httpGovernor.request<VenmoHttpResponse, VenmoHttpResponse>(
      async () => {
        const res = await fetch(url, {
          method: init.method,
          headers: {
            "User-Agent": "Venmo/7.44.0 (iPhone; iOS 13.0; Scale/2.0)",
            ...(init.body ? { "Content-Type": "application/json" } : {}),
            ...init.headers,
          },
          ...(init.body ? { body: JSON.stringify(init.body) } : {}),
        });
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of res.headers.entries()) {
          headers[k] = v;
        }
        return { body: await res.text().catch((): string => ""), headers, status: res.status };
      },
      (resp) => ({ status: resp.status, value: resp })
    );
    return result.value;
  } catch (error) {
    // Terminal rate-limit: the message IS the cross-run contract the
    // runtime's retryablePattern keys on — rethrow untouched, no suffix.
    if (error instanceof Error && error.message === "venmo_rate_limited") {
      throw error;
    }
    // Every other governor throw (transport fault, an exhausted RETRYABLE
    // status like 502/503/504 — these never reach the status-check below
    // because retryHttp throws before returning) reaches the owner here.
    // Only this frame knows which endpoint failed, so the label is
    // attached here, not left to the (never-reached, for this class of
    // failure) status check after `venmoRequest` returns.
    if (error instanceof Error) {
      throw new Error(`${error.message} [endpoint ${endpointLabel(path)}]`, { cause: error });
    }
    throw error;
  }
}

export function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed.error?.message) {
      return redactTransportDetail(parsed.error.message).slice(0, 200);
    }
  } catch {
    // fall through to raw redaction below
  }
  return redactTransportDetail(body).slice(0, 200);
}

export interface LoginResult {
  accessToken: string;
  ownerId: string;
}

/**
 * Full login handshake: password grant, then (if the account requires it)
 * SMS 2FA via `sendInteraction`. Throws `venmo_auth_failed` on bad
 * credentials and `venmo_otp_failed` if the OTP step is rejected.
 */
export async function loginWithCredentials(
  username: string,
  password: string,
  sendInteraction: CollectContext["sendInteraction"]
): Promise<LoginResult> {
  const deviceId = randomDeviceId();
  const initial = await venmoRequest("/oauth/access_token", "/oauth/access_token", {
    method: "POST",
    headers: { "device-id": deviceId, Host: "api.venmo.com" },
    body: { phone_email_or_username: username, client_id: "1", password },
  });

  if (initial.status >= 200 && initial.status < 300) {
    const parsed = JSON.parse(initial.body) as VenmoAccessTokenResponse;
    if (!(parsed.access_token && parsed.user?.id)) {
      throw new Error("venmo_auth_failed: login succeeded but response carried no access_token/user.id");
    }
    return { accessToken: parsed.access_token, ownerId: parsed.user.id };
  }

  const errBody = JSON.parse(initial.body || "{}") as VenmoTwoFactorRequiredResponse;
  if (initial.status !== 401 || errBody.error?.code !== TWO_FACTOR_ERROR_CODE) {
    throw new Error(`venmo_auth_failed: ${String(initial.status)} ${errorDetail(initial.body)}`);
  }

  const otpSecret = initial.headers["venmo-otp-secret"];
  if (!otpSecret) {
    throw new Error("venmo_auth_failed: 2FA required but no venmo-otp-secret header returned");
  }

  const smsResult = await venmoRequest("/account/two-factor/token", "/account/two-factor/token", {
    method: "POST",
    headers: { "device-id": deviceId, "venmo-otp-secret": otpSecret },
    body: { via: "sms" },
  });
  if (smsResult.status < 200 || smsResult.status >= 300) {
    throw new Error(`venmo_otp_failed: could not send SMS code: ${errorDetail(smsResult.body)}`);
  }

  const otpResponse = await sendInteraction({
    kind: "otp",
    message: "Venmo requires a 2FA verification code. Enter the 6-digit code sent to your phone via SMS:",
    schema: {
      type: "object",
      properties: { code: { type: "string", pattern: "^\\d{6}$" } },
      required: ["code"],
    },
    timeout_seconds: 300,
  });
  const otpCode = otpResponse.data?.code ?? otpResponse.value ?? null;
  if (!otpCode) {
    throw new Error("venmo_otp_failed: no OTP code provided");
  }

  const completed = await venmoRequest("/oauth/access_token", "/oauth/access_token", {
    method: "POST",
    query: { client_id: "1" },
    headers: { "device-id": deviceId, "venmo-otp": otpCode, "venmo-otp-secret": otpSecret },
  });
  if (completed.status < 200 || completed.status >= 300) {
    throw new Error(`venmo_otp_failed: ${String(completed.status)} ${errorDetail(completed.body)}`);
  }
  const completedParsed = JSON.parse(completed.body) as VenmoAccessTokenResponse;
  if (!(completedParsed.access_token && completedParsed.user?.id)) {
    throw new Error("venmo_otp_failed: OTP accepted but response carried no access_token/user.id");
  }
  return { accessToken: completedParsed.access_token, ownerId: completedParsed.user.id };
}

export async function fetchProfile(accessToken: string): Promise<VenmoAccountResponse["data"]> {
  const res = await venmoRequest("/account", "/account", {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401) {
    throw new Error("venmo_auth_failed: access token rejected");
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`venmo_http_${String(res.status)} [endpoint /account]: ${errorDetail(res.body)}`);
  }
  return (JSON.parse(res.body) as VenmoAccountResponse).data;
}

export async function fetchAllFriends(
  accessToken: string,
  ownerId: string,
  progress: VenmoProgress
): Promise<VenmoFriendsResponse["data"]> {
  const all: NonNullable<VenmoFriendsResponse["data"]> = [];
  let offset = 0;
  for (let page = 0; page < 200; page += 1) {
    await progress("Fetching Venmo friends page", { stream: "friends", phase: "fetch", offset_ordinal: page });
    const res = await venmoRequest(`/users/${ownerId}/friends`, "/users/{id}/friends", {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      query: { limit: String(FRIENDS_PAGE_SIZE), offset: String(offset) },
    });
    if (res.status === 401) {
      throw new Error("venmo_auth_failed: access token rejected");
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`venmo_http_${String(res.status)} [endpoint /users/{id}/friends]: ${errorDetail(res.body)}`);
    }
    const parsed = JSON.parse(res.body) as VenmoFriendsResponse;
    const batch = parsed.data ?? [];
    all.push(...batch);
    await progress("Fetched Venmo friends page", {
      stream: "friends",
      phase: "page",
      item_count: batch.length,
      total_seen: all.length,
    });
    if (batch.length < FRIENDS_PAGE_SIZE) {
      break;
    }
    offset += batch.length;
  }
  return all;
}

export async function fetchTransactionsPage(
  accessToken: string,
  ownerId: string,
  beforeId: string | undefined
): Promise<VenmoStory[]> {
  const res = await venmoRequest(`/stories/target-or-actor/${ownerId}`, "/stories/target-or-actor/{id}", {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
    query: { limit: String(TRANSACTIONS_PAGE_SIZE), ...(beforeId ? { before_id: beforeId } : {}) },
  });
  if (res.status === 401) {
    throw new Error("venmo_auth_failed: access token rejected");
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `venmo_http_${String(res.status)} [endpoint /stories/target-or-actor/{id}]: ${errorDetail(res.body)}`
    );
  }
  return (JSON.parse(res.body) as VenmoStoriesResponse).data ?? [];
}

/** Emits every modeled story on a page and returns how many were modeled plus the newest date_created seen. */
async function emitTransactionsPage(
  emitRecord: CollectContext["emitRecord"],
  stories: VenmoStory[],
  ownerId: string
): Promise<{ latestSeenAt: string | null; modeled: number }> {
  let modeled = 0;
  let latestSeenAt: string | null = null;
  for (const story of stories) {
    const record = transactionRecord(story, ownerId);
    if (!record) {
      continue;
    }
    await emitRecord("transactions", record);
    modeled += 1;
    const createdAt = typeof record.date_created === "string" ? record.date_created : null;
    if (createdAt && (!latestSeenAt || createdAt > latestSeenAt)) {
      latestSeenAt = createdAt;
    }
  }
  return { latestSeenAt, modeled };
}

export async function collectTransactions(
  ctx: CollectContext,
  accessToken: string,
  ownerId: string
): Promise<{ latestSeenAt: string | null; totalSeen: number }> {
  const { emitRecord, state } = ctx;
  const progress = ctx.progress as VenmoProgress;
  const priorState = state.transactions as { before_id?: string } | undefined;
  let beforeId = priorState?.before_id;
  let totalSeen = 0;
  let latestSeenAt: string | null = null;

  for (let page = 0; page < MAX_TRANSACTION_PAGES; page += 1) {
    await progress("Fetching Venmo transactions page", {
      stream: "transactions",
      phase: "fetch",
      offset_ordinal: page,
      cursor_present: Boolean(beforeId),
      total_seen: totalSeen,
    });
    const stories = await fetchTransactionsPage(accessToken, ownerId, beforeId);
    if (stories.length === 0) {
      break;
    }

    const { latestSeenAt: pageLatest, modeled } = await emitTransactionsPage(emitRecord, stories, ownerId);
    if (pageLatest && (!latestSeenAt || pageLatest > latestSeenAt)) {
      latestSeenAt = pageLatest;
    }
    totalSeen += stories.length;
    await progress("Fetched Venmo transactions page", {
      stream: "transactions",
      phase: "page",
      item_count: modeled,
      total_seen: totalSeen,
      cursor_present: stories.length === TRANSACTIONS_PAGE_SIZE,
    });

    const lastStory = stories.at(-1);
    if (!lastStory?.id || stories.length < TRANSACTIONS_PAGE_SIZE) {
      // Fewer than a full page (or no id to page from) means this is the
      // oldest page reachable — do not persist before_id past this run so
      // the next run starts fresh from the head and re-walks to catch new
      // transactions, matching the platform's own `before_id` contract
      // (there is no forward/`after_id` cursor documented for this route).
      beforeId = undefined;
      break;
    }
    beforeId = lastStory.id;
  }

  return { latestSeenAt, totalSeen };
}

interface VenmoSession {
  accessToken: string;
  account: VenmoAccountResponse["data"] | null;
  ownerId: string;
}

/**
 * Resolves an authenticated session, preferring a pre-obtained
 * `VENMO_ACCESS_TOKEN` (verified via `/account`) over driving the full
 * username/password + OTP login handshake. See the connector header for
 * why the fast path exists and why it lives outside `auth.required`.
 */
async function resolveVenmoSession(ctx: CollectContext): Promise<VenmoSession> {
  const { credentials, sendInteraction } = ctx;
  const preObtainedToken = process.env.VENMO_ACCESS_TOKEN;
  if (preObtainedToken) {
    const account = await fetchProfile(preObtainedToken);
    if (!account?.user?.id) {
      throw new Error("venmo_auth_failed: VENMO_ACCESS_TOKEN rejected or /account returned no user");
    }
    return { account, accessToken: preObtainedToken, ownerId: account.user.id };
  }
  const username = credentials.VENMO_USERNAME;
  const password = credentials.VENMO_PASSWORD;
  if (!(username && password)) {
    throw new Error("venmo_auth_failed: VENMO_USERNAME/VENMO_PASSWORD missing after credential resolution");
  }
  const { accessToken, ownerId } = await loginWithCredentials(username, password, sendInteraction);
  return { account: null, accessToken, ownerId };
}

async function collectFriends(
  ctx: CollectContext,
  accessToken: string,
  ownerId: string,
  progress: VenmoProgress
): Promise<void> {
  const { emit, emitRecord } = ctx;
  const friends = await fetchAllFriends(accessToken, ownerId, progress);
  const cursor = openFingerprintCursor(ctx.state.friends, { excludeFromFingerprint: [] });
  for (const friend of friends ?? []) {
    const record = userRecord(friend);
    if (cursor.shouldEmit(record)) {
      await emitRecord("friends", record);
    }
  }
  cursor.pruneStale();
  await emit({ type: "STATE", stream: "friends", cursor: { fingerprints: cursor.toState() } });
}

if (isMainModule(import.meta.url)) {
  runConnector({
    name: "venmo",
    validateRecord,
    retryablePattern: /ECONN|ETIMEDOUT|fetch failed|venmo_rate_limited/i,
    auth: { kind: "env", required: ["VENMO_USERNAME", "VENMO_PASSWORD"] },
    async collect(ctx: CollectContext) {
      const { emit, emitRecord, requested } = ctx;
      const progress = ctx.progress as VenmoProgress;

      const { account, accessToken, ownerId } = await resolveVenmoSession(ctx);

      if (requested.has("profile")) {
        await progress("Fetching Venmo profile", { stream: "profile", phase: "fetch" });
        const profileUser = account?.user ?? (await fetchProfile(accessToken))?.user;
        if (profileUser) {
          const cursor = openFingerprintCursor(ctx.state.profile, { excludeFromFingerprint: [] });
          const record = profileRecord(profileUser);
          if (cursor.shouldEmit(record)) {
            await emitRecord("profile", record);
          }
          cursor.pruneStale();
          await emit({ type: "STATE", stream: "profile", cursor: { fingerprints: cursor.toState() } });
        }
      }

      if (requested.has("friends")) {
        await collectFriends(ctx, accessToken, ownerId, progress);
      }

      if (requested.has("transactions")) {
        const { latestSeenAt } = await collectTransactions(ctx, accessToken, ownerId);
        await emit({
          type: "STATE",
          stream: "transactions",
          cursor: { last_seen_date_created: latestSeenAt },
        });
      }
    },
  });
}
