#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Venmo Connector (v0.2.0) — browser-session redesign
 *
 * Ground truth: /tmp/venmo-provider-path-audit-0810.md. The prior v0.1.0
 * design (password-grant + a per-run-random `device-id` over raw HTTP)
 * hit a live 403 — Venmo's device/session-trust anti-automation gate
 * rejecting a synthetic identity, a documented multi-year failure mode of
 * the unofficial `api.venmo.com` client ecosystem (github.com/mmohades/
 * Venmo issue #86). No retry, backoff, or device-id format change fixes
 * this; only a real, owner-authenticated session does.
 *
 * This redesign follows the same architecture already proven in this repo
 * by `reddit` (session-cookie JSON reads) and `amazon` (persistent
 * Patchright profile, one-time owner login, `ensureSession` automation):
 *
 *   - `browser: { profileName: "venmo" }` acquires an isolated, persistent
 *     Patchright profile. No custom User-Agent, no device fingerprinting —
 *     Patchright's stealth patches are what make the session credible.
 *   - `ensureSession` (src/auto-login/venmo.ts) probes/establishes a live
 *     venmo.com session: reused from the persistent profile when already
 *     live, credential-assisted when `VENMO_USERNAME`/`VENMO_PASSWORD` are
 *     set, or a `manual_action` browser handoff when they are not — the
 *     owner can always sign in by hand with nothing saved.
 *   - Once the session is live, every stream reads the SAME structured
 *     JSON endpoints the v0.1.0 connector used
 *     (`api.venmo.com/v1/{account,users/{id}/friends,stories/target-or-actor/{id}}`),
 *     but through `page.evaluate(fetch)` with `credentials: "include"` —
 *     the browser's own cookie jar authenticates the request, not a
 *     synthetic bearer token or device-id header. The existing
 *     parsers/schemas/cursor logic (parsers.ts, schemas.ts) is unchanged;
 *     only the transport and auth layer moved.
 *   - If a JSON endpoint ever stops responding under the session cookie
 *     (shape drift, endpoint retirement), the honest fallback is
 *     browser-visible data (DOM scrape) with the same evidence discipline
 *     as amazon/chase — not a silent re-add of a synthetic client.
 *     Nothing in this connector spoofs a User-Agent or device id; see
 *     docs/connector-authoring-guide.md §"Standard dependencies".
 *
 * Streams (unchanged from v0.1.0 — same vocabulary, same required set):
 *   - profile: the authenticated owner's own account (GET /account).
 *   - friends: the owner's Venmo friends list (GET /users/{id}/friends).
 *   - transactions: payments sent/requested/received visible to the owner
 *     (GET /stories/target-or-actor/{id}). Refunds/bank-transfers/top-ups/
 *     card authorizations/ATM withdrawals/disbursements share the same
 *     `/stories` feed but carry no `payment` object in the documented
 *     shape and are intentionally not modeled — see parsers.ts
 *     transactionRecord.
 *
 * Tested surfaces: fixture-driven only (pilot-fixture.test.ts,
 * parsers.test.ts, schemas.test.ts, integration.test.ts,
 * src/auto-login/venmo.test.ts). No live network call has proven this
 * redesign against a real account yet — see the manifest's
 * `public_listing.status: "unproven"`. This connector stays unlisted
 * until a live run is verified.
 *
 * CHANGES
 *   v0.2.0 (2026-08-10) — browser-session redesign; removed
 *     password-grant/device-id HTTP auth entirely.
 *   v0.1.0 — initial (unproven, never listed) password-grant connector.
 */

import type { Page } from "playwright";
import { ensureVenmoSession } from "../../src/auto-login/venmo.ts";
import { type BrowserCollectContext, buildDetailCoverageMessage, runConnector } from "../../src/connector-runtime.ts";
import { openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import { redactTransportDetail } from "../../src/http-retry.ts";
import { isMainModule } from "../../src/is-main-module.ts";
import { API_BASE, profileRecord, transactionRecord, userRecord } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type {
  VenmoAccountResponse,
  VenmoFriendsResponse,
  VenmoStoriesResponse,
  VenmoStory,
  VenmoUser,
} from "./types.ts";

const FRIENDS_PAGE_SIZE = 200;
const TRANSACTIONS_PAGE_SIZE = 50;
const MAX_FRIENDS_PAGES = 200;
const MAX_TRANSACTION_PAGES = 400;

interface VenmoProgressExtra {
  cursor_present?: boolean;
  item_count?: number;
  offset_ordinal?: number;
  phase?: string;
  stream?: string;
  total_seen?: number;
}
type VenmoProgress = (message: string, extra?: VenmoProgressExtra) => Promise<void>;

interface VenmoPageFetchResult {
  body: string;
  status: number;
}

/**
 * Fetch a Venmo JSON endpoint through the live page's own session cookie
 * (`credentials: "include"`) — no Authorization header, no device-id, no
 * custom User-Agent. This is the entire auth surface: the browser IS the
 * credential.
 */
export type VenmoPageFetch = (path: string, query?: Record<string, string>) => Promise<VenmoPageFetchResult>;

function makePageFetch(page: Page): VenmoPageFetch {
  return async (path, query) => {
    const url = new URL(API_BASE + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }
    return (await page.evaluate(async (fetchUrl) => {
      try {
        const res = await fetch(fetchUrl, {
          credentials: "include",
          headers: { accept: "application/json" },
        });
        return { status: res.status, body: await res.text().catch(() => "") };
      } catch (err) {
        return { status: 0, body: String(err) };
      }
    }, url.toString())) as VenmoPageFetchResult;
  };
}

/** Templated endpoint label for terminal errors — never the resolved URL or a live resource id. */
function endpointLabel(path: string): string {
  return path;
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

function assertVenmoOk(status: number, body: string, path: string): void {
  if (status === 401 || status === 403) {
    throw new Error(`venmo_session_expired [endpoint ${endpointLabel(path)}]: ${errorDetail(body)}`);
  }
  if (status === 429) {
    throw new Error(`venmo_rate_limited [endpoint ${endpointLabel(path)}]`);
  }
  if (status < 200 || status >= 300) {
    throw new Error(`venmo_http_${String(status)} [endpoint ${endpointLabel(path)}]: ${errorDetail(body)}`);
  }
}

export async function fetchProfile(fetchPath: VenmoPageFetch): Promise<VenmoUser | null> {
  const { status, body } = await fetchPath("/account");
  assertVenmoOk(status, body, "/account");
  return (JSON.parse(body) as VenmoAccountResponse).data?.user ?? null;
}

export async function fetchAllFriends(
  fetchPath: VenmoPageFetch,
  ownerId: string,
  progress: VenmoProgress
): Promise<VenmoUser[]> {
  const all: VenmoUser[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_FRIENDS_PAGES; page += 1) {
    await progress("Fetching Venmo friends page", { stream: "friends", phase: "fetch", offset_ordinal: page });
    const { status, body } = await fetchPath(`/users/${ownerId}/friends`, {
      limit: String(FRIENDS_PAGE_SIZE),
      offset: String(offset),
    });
    assertVenmoOk(status, body, "/users/{id}/friends");
    const parsed = JSON.parse(body) as VenmoFriendsResponse;
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
  fetchPath: VenmoPageFetch,
  ownerId: string,
  beforeId: string | undefined
): Promise<VenmoStory[]> {
  const { status, body } = await fetchPath(`/stories/target-or-actor/${ownerId}`, {
    limit: String(TRANSACTIONS_PAGE_SIZE),
    ...(beforeId ? { before_id: beforeId } : {}),
  });
  assertVenmoOk(status, body, "/stories/target-or-actor/{id}");
  return (JSON.parse(body) as VenmoStoriesResponse).data ?? [];
}

async function emitTransactionsPage(
  emitRecord: BrowserCollectContext["emitRecord"],
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
  ctx: BrowserCollectContext,
  fetchPath: VenmoPageFetch,
  ownerId: string
): Promise<{ considered: number; covered: number; latestSeenAt: string | null }> {
  const { emitRecord, state } = ctx;
  const progress = ctx.progress as VenmoProgress;
  const priorState = state.transactions as { before_id?: string } | undefined;
  let beforeId = priorState?.before_id;
  let totalSeen = 0;
  let totalModeled = 0;
  let latestSeenAt: string | null = null;

  for (let page = 0; page < MAX_TRANSACTION_PAGES; page += 1) {
    await progress("Fetching Venmo transactions page", {
      stream: "transactions",
      phase: "fetch",
      offset_ordinal: page,
      cursor_present: Boolean(beforeId),
      total_seen: totalSeen,
    });
    const stories = await fetchTransactionsPage(fetchPath, ownerId, beforeId);
    if (stories.length === 0) {
      break;
    }

    const { latestSeenAt: pageLatest, modeled } = await emitTransactionsPage(emitRecord, stories, ownerId);
    if (pageLatest && (!latestSeenAt || pageLatest > latestSeenAt)) {
      latestSeenAt = pageLatest;
    }
    totalSeen += stories.length;
    totalModeled += modeled;
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
      // transactions (there is no forward/`after_id` cursor documented for
      // this route).
      beforeId = undefined;
      break;
    }
    beforeId = lastStory.id;
  }

  return { considered: totalSeen, covered: totalModeled, latestSeenAt };
}

async function collectProfile(
  ctx: BrowserCollectContext,
  fetchPath: VenmoPageFetch,
  account: VenmoUser | null
): Promise<void> {
  const { emit, emitRecord } = ctx;
  const progress = ctx.progress as VenmoProgress;
  await progress("Fetching Venmo profile", { stream: "profile", phase: "fetch" });
  const profileUser = account ?? (await fetchProfile(fetchPath));
  const cursor = openFingerprintCursor(ctx.state.profile, { excludeFromFingerprint: [] });
  let covered = 0;
  if (profileUser) {
    const record = profileRecord(profileUser);
    if (cursor.shouldEmit(record)) {
      await emitRecord("profile", record);
    }
    covered = 1;
    cursor.pruneStale();
    await emit({ type: "STATE", stream: "profile", cursor: { fingerprints: cursor.toState() } });
  }
  await emit(
    buildDetailCoverageMessage({
      stream: "profile",
      stateStream: "profile",
      requiredKeys: [],
      hydratedKeys: [],
      considered: profileUser ? 1 : 0,
      covered,
    })
  );
}

async function collectFriends(
  ctx: BrowserCollectContext,
  fetchPath: VenmoPageFetch,
  ownerId: string,
  progress: VenmoProgress
): Promise<void> {
  const { emit, emitRecord } = ctx;
  const friends = await fetchAllFriends(fetchPath, ownerId, progress);
  const cursor = openFingerprintCursor(ctx.state.friends, { excludeFromFingerprint: [] });
  let covered = 0;
  for (const friend of friends) {
    const record = userRecord(friend);
    if (cursor.shouldEmit(record)) {
      await emitRecord("friends", record);
    }
    covered += 1;
  }
  cursor.pruneStale();
  await emit({ type: "STATE", stream: "friends", cursor: { fingerprints: cursor.toState() } });
  await emit(
    buildDetailCoverageMessage({
      stream: "friends",
      stateStream: "friends",
      requiredKeys: [],
      hydratedKeys: [],
      considered: friends.length,
      covered,
    })
  );
}

/** Exported for integration tests — the full collect() body against an injected page fetch. */
export async function collectAllStreams(
  ctx: BrowserCollectContext,
  fetchPath: VenmoPageFetch,
  ownerId: string,
  account: VenmoUser | null
): Promise<void> {
  const { emit, requested } = ctx;
  const progress = ctx.progress as VenmoProgress;

  if (requested.has("profile")) {
    await collectProfile(ctx, fetchPath, account);
  }

  if (requested.has("friends")) {
    await collectFriends(ctx, fetchPath, ownerId, progress);
  }

  if (requested.has("transactions")) {
    const { considered, covered, latestSeenAt } = await collectTransactions(ctx, fetchPath, ownerId);
    await emit({
      type: "STATE",
      stream: "transactions",
      cursor: { last_seen_date_created: latestSeenAt },
    });
    await emit(
      buildDetailCoverageMessage({
        stream: "transactions",
        stateStream: "transactions",
        requiredKeys: [],
        hydratedKeys: [],
        considered,
        covered,
      })
    );
  }
}

if (isMainModule(import.meta.url)) {
  runConnector({
    name: "venmo",
    validateRecord,
    retryablePattern: /ECONN|ETIMEDOUT|fetch failed|venmo_rate_limited/i,
    // No `auth:` config — credentials are optional. src/auto-login/venmo.ts
    // reads VENMO_USERNAME/VENMO_PASSWORD directly from process.env only to
    // ASSIST login when present, and falls to a manual_action browser
    // handoff when absent, so a run with zero saved credentials still
    // completes via owner-driven sign-in. Declaring `auth: { kind: "env",
    // required: [...] }` here would block every run behind a blocking
    // `credentials` INTERACTION before ensureSession ever gets a chance to
    // hand off to the browser — see /tmp/venmo-provider-path-audit-0810.md
    // and the reddit/amazon precedent this connector now follows.
    browser: { profileName: "venmo" },
    async ensureSession({ capture, checkpoint, page, sendInteraction }): Promise<void> {
      await ensureVenmoSession({
        ...(capture ? { capture } : {}),
        checkpoint,
        page,
        sendInteraction,
      });
    },
    async collect(ctx: BrowserCollectContext): Promise<void> {
      const { page } = ctx;
      const fetchPath = makePageFetch(page);
      const account = await fetchProfile(fetchPath);
      const ownerId = account?.id;
      if (!ownerId) {
        throw new Error("venmo_session_expired: /account returned no user id after ensureSession succeeded");
      }
      await collectAllStreams(ctx, fetchPath, ownerId, account);
    },
  });
}
