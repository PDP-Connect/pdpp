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
 *     live, credential-assisted when setup supplies credentials, or a
 *     `manual_action` browser handoff when they are not — the
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
 * redesign against a real account yet. The manifest lists it at Preview
 * (see public_listing.rationale) so the owner can opt in to perform that
 * first live run, matching the signal connector's precedent.
 *
 * CHANGES
 *   v0.2.0 (2026-08-10) — browser-session redesign; removed
 *     password-grant/device-id HTTP auth entirely.
 *   v0.1.0 — initial (unproven, never listed) password-grant connector.
 */

import { isMainModule } from "@pdpp/connector-protocol";
import { redactTransportDetail } from "@pdpp/connector-protocol/http-retry";
import type { Page } from "playwright";
import { ensureVenmoOrigin, ensureVenmoSession } from "../../src/auto-login/venmo.ts";
import {
  type BrowserCollectContext,
  buildDetailCoverageMessage,
  politeDelay,
  runConnector,
} from "../../src/connector-runtime.ts";
import { openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
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
export const MAX_FRIENDS_PAGES = 200;
export const MAX_TRANSACTION_PAGES = 400;

/**
 * `venmo_transport_error` (collect()'s page-fetch, see `makePageFetch` below)
 * and `venmo_probe_transport_error` (ensureSession's PRE-submit session
 * probe, see `src/auto-login/venmo.ts`) are the browser fetch's own "could
 * not run at all" fault (opaque origin, DNS, TLS, reset socket) —
 * deliberately retryable, distinct from `venmo_session_expired`. Every
 * transport-fault throw in this connector is always wrapped in one of these
 * named errors before it can reach the runtime's retryablePattern check —
 * nothing unwrapped escapes either module's own try/catch — so this pattern
 * names the two retryable errors EXACTLY rather than also matching bare
 * transport vocabulary (`fetch failed`/`ECONN`/etc.) as a redundant, and
 * here actively dangerous, catch-all.
 *
 * B4: that redundant bare-vocabulary form is what this pattern used to be
 * (`venmo_.*transport_error` plus `fetch failed|failed to fetch`), and it
 * silently made a THIRD, deliberately similarly-named error retryable too:
 * `probeVenmoAccount` throws `venmo_post_submit_probe_transport_error` for a
 * transport fault discovered immediately after a saved password was
 * submitted to Venmo's own sign-in form, and that message still CONTAINS
 * "Failed to fetch" (the redacted detail) even though its NAME must not
 * retry. A wildcard/bare-vocabulary pattern classified it retryable anyway
 * via the message text, and a runtime-level retry re-enters
 * `ensureVenmoSession` from scratch — resubmitting the SAME saved password
 * against Venmo's anti-automation gate on every retry, with no run-scoped
 * budget to stop it (see `src/auto-login/venmo.test.ts`'s "B4" oracle).
 * Naming exactly the two errors that must retry — and nothing else — is the
 * only form immune to a future transport-detail string reintroducing this
 * exact collision. Exported so both this connector's own tests and
 * `src/auto-login/venmo.test.ts` assert against the REAL pattern, not a
 * hand-copied stand-in that could silently drift from it.
 */
export const VENMO_RETRYABLE_PATTERN = /venmo_rate_limited|venmo_transport_error|venmo_probe_transport_error/i;

// The redesign dropped `venmoPacingProfile`/the HTTP governor (page-context
// fetch has no direct outbound Node HTTP to pace — F10 in
// /tmp/review-venmo-browser-redesign-0810.md), but the page loops below
// still hit `api.venmo.com` back-to-back up to 200-400 times with zero
// pacing. Self-pace like reddit (PAGE_DELAY_MS=500) rather than lean on a
// governor that structurally cannot see this transport.
const PAGE_DELAY_MS = 500;

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

/**
 * Distinguishes "the fetch could not run at all" (opaque origin, DNS, TLS,
 * reset socket — a transport/precondition fault) from "the fetch ran and
 * Venmo said no" (an HTTP status). Collapsing both into the same shape, as
 * the pre-revision `catch { return { status: 0, ... } }` did, reports every
 * transport fault as a session-expired auth fault
 * (/tmp/review-venmo-browser-redesign-0810.md F4) — the owner is told to
 * re-authenticate when the real problem is that `collect()` never
 * established the `venmo.com` origin (F1/F3).
 */
type VenmoFetchOutcome =
  | { kind: "response"; body: string; status: number }
  | { kind: "transport_error"; message: string };

function makePageFetch(page: Page): VenmoPageFetch {
  return async (path, query) => {
    const url = new URL(API_BASE + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }
    let outcome: VenmoFetchOutcome;
    try {
      outcome = (await page.evaluate(async (fetchUrl) => {
        try {
          const res = await fetch(fetchUrl, {
            credentials: "include",
            headers: { accept: "application/json" },
          });
          return { kind: "response" as const, status: res.status, body: await res.text().catch(() => "") };
        } catch (err) {
          return { kind: "transport_error" as const, message: err instanceof Error ? err.message : String(err) };
        }
      }, url.toString())) as VenmoFetchOutcome;
    } catch (err) {
      // `page.evaluate` itself rejected (execution context destroyed by a
      // navigation, or the page/browser crashed) — same "could not run at
      // all" classification as a fetch throwing inside the callback.
      outcome = { kind: "transport_error", message: err instanceof Error ? err.message : String(err) };
    }
    if (outcome.kind === "transport_error") {
      throw new Error(`venmo_transport_error [endpoint ${path}]: ${redactTransportDetail(outcome.message)}`);
    }
    return { status: outcome.status, body: outcome.body };
  };
}

/**
 * `collect()`'s own call to `ensureVenmoOrigin`, extracted so it is
 * unit-testable without a real Playwright `page` (mirrors `errorDetail`/
 * `assertVenmoOk` below, both pulled out of the fetch loop for the same
 * reason). `ensureVenmoOrigin` now throws `venmo_origin_navigation_failed`
 * when the one-time navigation doesn't land on venmo.com (see its doc —
 * production run_1787101857760, the owner's first-ever Venmo run). Folded
 * into this connector's own `venmo_transport_error` naming so it matches
 * `VENMO_RETRYABLE_PATTERN` the same way any other transport fault in this
 * file's fetch loop already does, rather than escaping `collect()` as an
 * unrecognized, non-retryable name.
 */
export async function establishVenmoCollectOrigin(page: Page): Promise<void> {
  try {
    await ensureVenmoOrigin(page);
  } catch (err) {
    throw new Error(
      `venmo_transport_error [origin navigation]: ${redactTransportDetail(err instanceof Error ? err.message : String(err))}`,
      { cause: err }
    );
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

function assertVenmoOk(status: number, body: string, path: string): void {
  if (status === 401 || status === 403) {
    throw new Error(`venmo_session_expired [endpoint ${path}]: ${errorDetail(body)}`);
  }
  if (status === 429) {
    throw new Error(`venmo_rate_limited [endpoint ${path}]`);
  }
  if (status < 200 || status >= 300) {
    throw new Error(`venmo_http_${String(status)} [endpoint ${path}]: ${errorDetail(body)}`);
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
  progress: VenmoProgress,
  delay: (ms: number) => Promise<void> = politeDelay
): Promise<{ friends: VenmoUser[]; truncated: boolean }> {
  const all: VenmoUser[] = [];
  let offset = 0;
  let page = 0;
  let truncated = false;
  while (true) {
    if (page >= MAX_FRIENDS_PAGES) {
      // EXIT B — the deliberate page ceiling. A full or short non-empty page
      // can still have a continuation, so only an empty page is completion.
      truncated = true;
      break;
    }
    await progress("Fetching Venmo friends page", { stream: "friends", phase: "fetch", offset_ordinal: page });
    const { status, body } = await fetchPath(`/users/${ownerId}/friends`, {
      limit: String(FRIENDS_PAGE_SIZE),
      offset: String(offset),
    });
    assertVenmoOk(status, body, "/users/{id}/friends");
    const parsed = JSON.parse(body) as VenmoFriendsResponse;
    const batch = parsed.data ?? [];
    page += 1;
    all.push(...batch);
    await progress("Fetched Venmo friends page", {
      stream: "friends",
      phase: "page",
      item_count: batch.length,
      total_seen: all.length,
    });
    // EXIT A — an empty page proves the offset walk is exhausted. A short
    // non-empty page is not terminal: Venmo can return fewer than `limit`
    // rows while more rows remain.
    if (batch.length === 0) {
      break;
    }
    offset += batch.length;
    await delay(PAGE_DELAY_MS);
  }
  return { friends: all, truncated };
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
  ownerId: string,
  delay: (ms: number) => Promise<void> = politeDelay
): Promise<{ considered: number; covered: number; latestSeenAt: string | null; truncated: boolean }> {
  const { emitRecord } = ctx;
  const progress = ctx.progress as VenmoProgress;
  // `before_id` pages backward (toward older history) with no documented
  // forward/`after_id` counterpart. A cursor persisted across runs would
  // resume deeper into old history and permanently skip new transactions
  // added at the head since the last run. So every run re-walks from the
  // head — this variable is a same-run pagination cursor only, never read
  // from or written to STATE.
  let beforeId: string | undefined;
  let totalSeen = 0;
  let totalModeled = 0;
  let latestSeenAt: string | null = null;

  let page = 0;
  let truncated = false;
  while (true) {
    if (page >= MAX_TRANSACTION_PAGES) {
      // EXIT B — the deliberate page ceiling. `beforeId` remains set after
      // the last full page, so the source has not been exhausted.
      truncated = true;
      break;
    }
    await progress("Fetching Venmo transactions page", {
      stream: "transactions",
      phase: "fetch",
      offset_ordinal: page,
      cursor_present: Boolean(beforeId),
      total_seen: totalSeen,
    });
    const stories = await fetchTransactionsPage(fetchPath, ownerId, beforeId);
    page += 1;
    if (stories.length === 0) {
      // EXIT A — an empty page is the provider's terminal boundary.
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
    // A short non-empty page is not terminal. Continue whenever Venmo gives us
    // a cursor; a page without a usable id is the other honest terminal exit.
    if (!lastStory?.id) {
      break;
    }
    beforeId = lastStory.id;
    await delay(PAGE_DELAY_MS);
  }

  return { considered: totalSeen + (truncated ? 1 : 0), covered: totalModeled, latestSeenAt, truncated };
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
  progress: VenmoProgress,
  delay: (ms: number) => Promise<void>
): Promise<void> {
  const { emit, emitRecord } = ctx;
  const { friends, truncated } = await fetchAllFriends(fetchPath, ownerId, progress, delay);
  const cursor = openFingerprintCursor(ctx.state.friends, { excludeFromFingerprint: [] });
  let covered = 0;
  for (const friend of friends) {
    const record = userRecord(friend);
    if (cursor.shouldEmit(record)) {
      await emitRecord("friends", record);
    }
    covered += 1;
  }
  if (!truncated) {
    cursor.pruneStale();
  }
  const priorCursor = ctx.state.friends;
  const priorFingerprints =
    priorCursor && typeof priorCursor === "object" && !Array.isArray(priorCursor)
      ? (priorCursor as { fingerprints?: unknown }).fingerprints
      : undefined;
  const fingerprints =
    truncated && priorFingerprints && typeof priorFingerprints === "object" && !Array.isArray(priorFingerprints)
      ? (priorFingerprints as Record<string, string>)
      : cursor.toState();
  if (truncated) {
    await emit({
      type: "SKIP_RESULT",
      stream: "friends",
      reason: "friends_deferred_page_budget",
      message: `Venmo friends stopped at the ${MAX_FRIENDS_PAGES}-page limit with more rows still listed`,
      diagnostics: { page_limit: MAX_FRIENDS_PAGES, total_seen: friends.length, unread_pages: 1 },
    });
  }
  await emit({ type: "STATE", stream: "friends", cursor: { fingerprints } });
  await emit(
    buildDetailCoverageMessage({
      stream: "friends",
      stateStream: "friends",
      requiredKeys: [],
      hydratedKeys: [],
      considered: friends.length + (truncated ? 1 : 0),
      covered,
    })
  );
}

/** Exported for integration tests — the full collect() body against an injected page fetch. */
export async function collectAllStreams(
  ctx: BrowserCollectContext,
  fetchPath: VenmoPageFetch,
  ownerId: string,
  account: VenmoUser | null,
  delay: (ms: number) => Promise<void> = politeDelay
): Promise<void> {
  const { emit, requested } = ctx;
  const progress = ctx.progress as VenmoProgress;

  if (requested.has("profile")) {
    await collectProfile(ctx, fetchPath, account);
  }

  if (requested.has("friends")) {
    await collectFriends(ctx, fetchPath, ownerId, progress, delay);
  }

  if (requested.has("transactions")) {
    const { considered, covered, latestSeenAt, truncated } = await collectTransactions(ctx, fetchPath, ownerId, delay);
    const priorCursor = ctx.state.transactions;
    const priorLatestSeenAt =
      priorCursor && typeof priorCursor === "object" && !Array.isArray(priorCursor)
        ? (priorCursor as { last_seen_date_created?: unknown }).last_seen_date_created
        : undefined;
    if (truncated) {
      await emit({
        type: "SKIP_RESULT",
        stream: "transactions",
        reason: "transactions_deferred_page_budget",
        message: `Venmo transactions stopped at the ${MAX_TRANSACTION_PAGES}-page limit with more rows still listed`,
        diagnostics: { page_limit: MAX_TRANSACTION_PAGES, total_seen: considered - 1, unread_pages: 1 },
      });
    }
    let nextLatestSeenAt = latestSeenAt;
    if (truncated) {
      nextLatestSeenAt = typeof priorLatestSeenAt === "string" || priorLatestSeenAt === null ? priorLatestSeenAt : null;
    }
    await emit({
      type: "STATE",
      stream: "transactions",
      cursor: { last_seen_date_created: nextLatestSeenAt },
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
    // See VENMO_RETRYABLE_PATTERN's doc above for why this is an exact-name
    // pattern rather than the wildcard/bare-vocabulary form it replaced (B4).
    retryablePattern: VENMO_RETRYABLE_PATTERN,
    auth: { kind: "env", required: ["VENMO_USERNAME", "VENMO_PASSWORD"] },
    browser: { profileName: "venmo" },
    async ensureSession({
      capture,
      checkpoint,
      credentials,
      onCredentialSubmit,
      page,
      progress,
      sendInteraction,
    }): Promise<void> {
      await ensureVenmoSession({
        ...(capture ? { capture } : {}),
        checkpoint,
        credentials,
        onCredentialSubmit,
        page,
        progress,
        sendInteraction,
      });
    },
    async collect(ctx: BrowserCollectContext): Promise<void> {
      const { page } = ctx;
      // `ensureSession` may leave the page wherever sign-in redirected it
      // (e.g. `id.venmo.com`); `api.venmo.com`'s CORS allowlist only grants
      // a credentialed fetch from `https://venmo.com`, so collect must
      // establish that origin itself rather than assume ensureSession left
      // it there (F3 in /tmp/review-venmo-browser-redesign-0810.md). See
      // `establishVenmoCollectOrigin`'s doc for why this is wrapped.
      await establishVenmoCollectOrigin(page);
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
