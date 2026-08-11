#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Reddit Connector (v0.2.0)
 *
 * Reddit's OAuth script-app password grant was retired in 2024, so this
 * connector collects via a logged-in browser session. All fetches happen
 * through `page.evaluate(fetch)` against `old.reddit.com/*.json` — the same
 * JSON the modern apps consume, served to the current session cookie.
 * old.reddit.com has been stable since 2018 and is the polyfill-friendliest
 * surface for personal data collection.
 *
 * Streams:
 *   submitted     /user/{u}/submitted.json   — link + self posts
 *   comments      /user/{u}/comments.json    — comments
 *   saved         /user/{u}/saved.json       — saved posts + comments (owner-only)
 *   upvoted       /user/{u}/upvoted.json     — posts/comments the owner upvoted (owner-only)
 *   downvoted     /user/{u}/downvoted.json   — posts/comments the owner downvoted (owner-only)
 *   hidden        /user/{u}/hidden.json      — posts the owner hid (owner-only)
 *
 * The owner-only streams are the biggest reason to use a logged-in
 * connector over the public API — they capture preference signal
 * (upvoted/downvoted history) no third party can see.
 *
 * Pagination: opaque `after` cursor, newest-first. Incremental sync stops
 * once we cross the earliest `created_utc` from the prior run — same
 * pattern the original API-based connector used.
 *
 * Rate limit: Reddit's logged-in web JSON allows ~100 req/min before 429.
 * We page at limit=100 and use a conservative 500ms politeDelay between
 * pages.
 *
 * CHANGES
 *   v0.2.0 (2026-04-24) — extracted parsers.ts / schemas.ts / types.ts;
 *     added zod shape-check; added upvoted/downvoted/hidden streams;
 *     enriched records with domain, *_len, is_top_level, is_post,
 *     over_18, gilded, fetched_at.
 *   v0.1.0 — initial browser-session implementation.
 *
 * FIXTURES
 *   A committed records-stream pilot lives at
 *   fixtures/reddit/scrubbed/pilot-real-shape/records/<stream>.jsonl
 *   (synthetic-but-shape-real, PII-free). pilot-fixture.test.ts replays it
 *   through validateRecord to lock the emitted-record shape against drift.
 *   See docs/reference/connector-authoring-guide.md §9.1.
 */

import type { Page } from "playwright";
import { ensureRedditSession, isSessionLive } from "../../src/auto-login/reddit.ts";
import {
  type BrowserCollectContext,
  buildDetailCoverageMessage,
  type EmittedMessage,
  politeDelay,
  type RecordData,
  runConnector,
} from "../../src/connector-runtime.ts";
import type { CaptureSession } from "../../src/fixture-capture.ts";
import { isMainModule } from "../../src/is-main-module.ts";
import { createRepairBudget } from "../../src/repair-budget.ts";
import {
  appendNewChildren,
  classifyListingStatus,
  commentRecord,
  MAX_PAGES,
  maxCreatedEpoch,
  nextAfter,
  pagePath,
  savedRecord,
  sinceFromState,
  submittedRecord,
  voteRecord,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { RedditChild, RedditFetchResult, RedditListing } from "./types.ts";

const USER_AGENT = "pdpp-reddit-connector/0.2 (polyfill; +https://pdpp.org)";
const PAGE_DELAY_MS = 500;
/**
 * Exported (not just inline in `runConnector`) so a regression test can
 * assert every post-submit throw `src/auto-login/reddit.ts` can produce
 * fails to match this exact pattern — the same object the scheduler
 * classifier actually consults, not a duplicated literal that could drift.
 * Reddit currently has no post-submit/pre-submit collision (unlike USAA's
 * deliberate `source_unavailable` term), and this pattern must stay that way:
 * a future edit that adds a bare transport term here would silently reopen
 * the naming-collision defect class with no test to catch it.
 */
export const REDDIT_RETRYABLE_PATTERN = /ECONN|ETIMEDOUT|fetch failed|reddit_rate_limited/i;

interface ProgressExtra {
  cursor_present?: boolean;
  item_count?: number;
  page_index?: number;
  phase?: string;
  rate_limit_pressure?: number;
  stream?: string;
  total_seen?: number;
}

// ─── Fetch through the page (preserves session cookie + anti-bot) ───────

async function redditFetch(page: Page, path: string): Promise<RedditFetchResult> {
  return (await page.evaluate(
    async ({ path: evalPath, userAgent }) => {
      try {
        const res = await fetch(`https://old.reddit.com${evalPath}`, {
          credentials: "include",
          headers: {
            accept: "application/json",
            "user-agent": userAgent,
          },
        });
        const { status } = res;
        let json: unknown = null;
        try {
          json = await res.json();
        } catch {
          json = null;
        }
        return { status, json };
      } catch (err) {
        return { status: 0, json: { error: String(err) } };
      }
    },
    { path, userAgent: USER_AGENT }
  )) as RedditFetchResult;
}

function assertListingOk(status: number, json: RedditListing | null, endpoint: string): asserts json is RedditListing {
  const klass = classifyListingStatus(status);
  if (klass === "auth_failed") {
    throw new Error(`reddit_auth_failed: ${status} on ${endpoint}`);
  }
  if (klass === "rate_limited") {
    throw new Error(`reddit_rate_limited: 429 on ${endpoint}`);
  }
  if (klass === "http_error" || !json) {
    throw new Error(`reddit_http_${status}: ${endpoint}`);
  }
}

/**
 * Paginate a Reddit listing. Newest-first, opaque `after` cursor. Stops
 * once we cross the prior run's high-water created_utc (incremental), hit
 * an empty page, or run out of `after`. The fetch function is injected
 * so integration tests can run this against a fake listing server
 * without a browser.
 */
export type RedditListingFetch = (path: string) => Promise<RedditFetchResult>;

/**
 * Re-run the connector's existing session-establishment flow
 * (`ensureRedditSession`) and report whether the session is live afterward.
 * `ensureRedditSession` already no-ops when the current cookie is live, so
 * calling it speculatively mid-run is safe — it only does login work when
 * the cookie is actually gone or stale.
 */
export type RedditReauthFn = () => Promise<boolean>;

async function fetchListingPage(
  fetchPath: RedditListingFetch,
  path: string,
  onAuthFailed: RedditReauthFn | undefined,
  repairBudget: ReturnType<typeof createRepairBudget>
): Promise<RedditFetchResult> {
  const result = await fetchPath(path);
  const klass = classifyListingStatus(result.status);
  if (klass !== "auth_failed" || !onAuthFailed) {
    return result;
  }
  // A 401/403 after this run's session was already live at least once
  // (ensureSession succeeded, prior pages in this stream/run succeeded) is
  // far more often a rotated/expired session cookie than a genuinely dead
  // login — re-establish the session ONCE PER RUN and retry this exact
  // request. `repairBudget` is shared across every stream `collectAllStreams`
  // iterates (submitted/comments/saved/upvoted/downvoted/hidden) — without
  // that sharing, a budget scoped to a single `paginate()` call resets for
  // each stream and a session dead at run start drives one automated login
  // per stream instead of one per run. A second 401/403 (session repair
  // failed, or the fresh session still gets rejected, or the budget is
  // already spent) falls through to the real reddit_auth_failed below
  // rather than looping or re-spending.
  if (!repairBudget.tryConsume()) {
    return result;
  }
  const recovered = await onAuthFailed();
  if (!recovered) {
    return result;
  }
  return fetchPath(path);
}

export async function paginate(
  fetchPath: RedditListingFetch,
  endpoint: string,
  sinceEpochUtc: number | null,
  capture: CaptureSession | null,
  delay: (ms: number) => Promise<void> = politeDelay,
  progress?: (message: string, extra?: ProgressExtra) => Promise<void>,
  streamName?: string,
  onAuthFailed?: RedditReauthFn,
  repairBudget: ReturnType<typeof createRepairBudget> = createRepairBudget()
): Promise<RedditChild[]> {
  const all: RedditChild[] = [];
  let after: string | null = null;
  const streamExtra = streamName ? { stream: streamName } : {};

  for (let guard = 0; guard < MAX_PAGES; guard += 1) {
    await progress?.("Fetching Reddit listing page", {
      ...streamExtra,
      phase: "fetch",
      page_index: guard,
      total_seen: all.length,
      cursor_present: Boolean(after),
    });
    const path = pagePath(endpoint, after);
    const { status, json } = await fetchListingPage(fetchPath, path, onAuthFailed, repairBudget);
    if (status === 429) {
      await progress?.("Reddit listing page rate limited", {
        ...streamExtra,
        phase: "rate_limit",
        page_index: guard,
        total_seen: all.length,
        cursor_present: Boolean(after),
        rate_limit_pressure: 1,
      });
    }
    assertListingOk(status, json, endpoint);

    capture?.captureHttp(`page-${String(guard).padStart(3, "0")}-${endpoint.replaceAll("/", "_")}`, json, {
      status,
      path,
      endpoint,
    });

    const children = json.data?.children ?? [];
    await progress?.("Fetched Reddit listing page", {
      ...streamExtra,
      phase: "page",
      page_index: guard,
      item_count: children.length,
      total_seen: all.length + children.length,
      cursor_present: Boolean(nextAfter(json)),
    });
    if (children.length === 0) {
      break;
    }
    if (appendNewChildren(children, sinceEpochUtc, all)) {
      break;
    }

    after = nextAfter(json);
    if (!after) {
      break;
    }
    await delay(PAGE_DELAY_MS);
  }

  return all;
}

// ─── Stream runner ──────────────────────────────────────────────────────

/** Declarative description of one stream collectStream() knows how to
 *  fetch. Exported so integration tests can reuse the same table the
 *  runtime uses. */
export interface RedditStreamConfig {
  endpoint: string;
  name: string;
  progressMessage: string;
  toRecord: (c: RedditChild) => RecordData;
}

export interface CollectStreamArgs {
  capture: CaptureSession | null;
  /** Pacing delay between pages. Defaults to politeDelay(500ms). Tests
   *  inject a no-op so they don't sleep. */
  delay?: (ms: number) => Promise<void>;
  emit: (msg: EmittedMessage) => Promise<void>;
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  fetchPath: RedditListingFetch;
  /** Re-establish the session once on a mid-stream 401/403. Absent in tests
   *  that don't exercise the repair path — a 401/403 then fails immediately,
   *  matching pre-fix behavior. */
  onAuthFailed?: RedditReauthFn;
  progress: (message: string, extra?: ProgressExtra) => Promise<void>;
  /** RUN-scoped budget for `onAuthFailed` spends, shared by the caller across
   *  every stream in this run. Defaults to a fresh one-shot budget so direct
   *  callers (tests) that don't pass one keep today's per-call ceiling of 1. */
  repairBudget?: ReturnType<typeof createRepairBudget>;
  state: Record<string, unknown>;
  stream: RedditStreamConfig;
}

interface CollectStreamResult {
  considered: number;
  covered: number;
}

export async function collectStream(args: CollectStreamArgs): Promise<CollectStreamResult> {
  const { capture, delay, emit, emitRecord, fetchPath, onAuthFailed, progress, repairBudget, state, stream } = args;
  await progress(stream.progressMessage, { stream: stream.name });

  const sinceEpoch = sinceFromState(state, stream.name);
  const items = await paginate(
    fetchPath,
    stream.endpoint,
    sinceEpoch,
    capture,
    delay,
    progress,
    stream.name,
    onAuthFailed,
    repairBudget
  );

  const latestEpoch = maxCreatedEpoch(items, sinceEpoch ?? 0);
  let covered = 0;
  for (const c of items) {
    const record = stream.toRecord(c);
    // Validate record using the canonical schema. Connectors must count covered
    // independently at validation boundary: only schema-ok records count toward
    // coverage, schema-invalid records are weighed but not covered.
    const validation = validateRecord(stream.name, record);
    if (validation.ok) {
      covered += 1;
    }
    // Still emit to runtime so SKIP_RESULT remains authoritative for runtime layer.
    await emitRecord(stream.name, record);
  }
  await progress("Emitted Reddit stream records", {
    stream: stream.name,
    phase: "emit",
    item_count: items.length,
    total_seen: items.length,
    cursor_present: latestEpoch > 0,
  });

  await emit({
    type: "STATE",
    stream: stream.name,
    cursor: { last_created_utc: latestEpoch },
  });

  return { considered: items.length, covered };
}

/** Build the list of streams this connector can populate, bound to a
 *  particular user path and emit timestamp. Exported for tests. */
export function buildStreamTable(userPath: string, emittedAt: string): RedditStreamConfig[] {
  return [
    {
      name: "submitted",
      endpoint: `${userPath}/submitted.json`,
      progressMessage: "Fetching submissions",
      toRecord: (c) => submittedRecord(c.data, emittedAt),
    },
    {
      name: "comments",
      endpoint: `${userPath}/comments.json`,
      progressMessage: "Fetching comments",
      toRecord: (c) => commentRecord(c.data, emittedAt),
    },
    {
      name: "saved",
      endpoint: `${userPath}/saved.json`,
      progressMessage: "Fetching saved items",
      toRecord: (c) => savedRecord(c, emittedAt),
    },
    {
      name: "upvoted",
      endpoint: `${userPath}/upvoted.json`,
      progressMessage: "Fetching upvoted items",
      toRecord: (c) => voteRecord(c, emittedAt),
    },
    {
      name: "downvoted",
      endpoint: `${userPath}/downvoted.json`,
      progressMessage: "Fetching downvoted items",
      toRecord: (c) => voteRecord(c, emittedAt),
    },
    {
      name: "hidden",
      endpoint: `${userPath}/hidden.json`,
      progressMessage: "Fetching hidden items",
      toRecord: (c) => voteRecord(c, emittedAt),
    },
  ];
}

/** Build a RedditListingFetch bound to a Playwright page. Extracted
 *  so tests can substitute a non-browser fetch. */
function makePageFetch(page: Page): RedditListingFetch {
  return (path) => redditFetch(page, path);
}

// ─── Exported collect for testing ────────────────────────────────────────

/**
 * Build the mid-run reauth hook bound to a live browser context. Delegates
 * to `ensureRedditSession` — the same session-establishment flow already run
 * once at connector start — which no-ops when the cookie is still live, so
 * this is safe to invoke speculatively on a 401/403 rather than only at
 * startup.
 *
 * Gated strictly on `REDDIT_USERNAME`/`REDDIT_PASSWORD` being present in
 * `process.env`, mirroring the Amazon connector's
 * `attemptAutomatedSessionRepair`. Without both, `ensureRedditSession` falls
 * through to `ensureRedditManualSession` — an interactive owner hand-off
 * that can block up to 30 minutes and consume an OTP interaction slot. That
 * path is only safe at run start (`ensureSession`, before any owner-facing
 * timeout budget is in flight); triggering it speculatively mid-collect on a
 * background 401/403 is not. Note this checks `process.env` directly, not
 * `ctx.credentials` — a run whose credentials arrived via the interactive
 * `sendInteraction` prompt (rather than sealed-secret env injection) has a
 * populated `credentials` object but empty `process.env`, and must still be
 * refused here.
 *
 * `ensureRedditSession` never returns without either the session already
 * being probed live or throwing, so a bare "didn't throw" is already backed
 * by a probe internally — but that's an implementation detail of a function
 * this hook doesn't own. Re-probing explicitly with `isSessionLive` here is
 * cheap (one navigation, already-loaded page) and makes the truth this hook
 * reports self-contained rather than borrowed: if `ensureRedditSession`'s
 * internal contract ever changes, this still reports the real session state
 * instead of silently trusting a function that returned without error.
 *
 * Exported (in addition to being wired into `collectAllStreams`) so the
 * env-credential gate is directly unit-testable without needing a
 * Playwright-shaped `context`/`page` that would otherwise mask the gate
 * behind an unrelated thrown error from a stub object.
 */
export function makeReauth(ctx: BrowserCollectContext): RedditReauthFn {
  return async () => {
    if (!(process.env.REDDIT_USERNAME && process.env.REDDIT_PASSWORD)) {
      return false;
    }
    try {
      await ensureRedditSession({
        capture: ctx.capture,
        context: ctx.context,
        page: ctx.page,
        sendInteraction: ctx.sendInteraction,
      });
      return await isSessionLive(ctx.page);
    } catch {
      return false;
    }
  };
}

export async function collectAllStreams(ctx: BrowserCollectContext): Promise<void> {
  const { capture, credentials, emit, emitRecord, emittedAt, page, progress, requested, state } = ctx;

  const user = credentials.REDDIT_USERNAME;
  if (!user) {
    throw new Error("reddit_auth_failed: REDDIT_USERNAME missing");
  }
  const userPath = `/user/${encodeURIComponent(user)}`;
  const fetchPath = makePageFetch(page);
  const onAuthFailed = makeReauth(ctx);
  // Shared across every stream below — see the repair-budget note on
  // `fetchListingPage` for why a per-stream budget (created inside
  // `paginate`) undercounts a run's actual credentialed-login exposure.
  const repairBudget = createRepairBudget();

  for (const stream of buildStreamTable(userPath, emittedAt)) {
    if (!requested.has(stream.name)) {
      continue;
    }
    const result = await collectStream({
      stream,
      fetchPath,
      state,
      emit,
      emitRecord,
      progress,
      onAuthFailed,
      repairBudget,
      capture,
    });
    await emit(
      buildDetailCoverageMessage({
        stream: stream.name,
        stateStream: stream.name,
        requiredKeys: [],
        hydratedKeys: [],
        considered: result.considered,
        covered: result.covered,
      })
    );
  }
}

// ─── Entry ──────────────────────────────────────────────────────────────

if (isMainModule(import.meta.url)) {
  runConnector({
    name: "reddit",
    validateRecord,
    retryablePattern: REDDIT_RETRYABLE_PATTERN,
    auth: { kind: "env", required: ["REDDIT_USERNAME", "REDDIT_PASSWORD"] },
    browser: { profileName: "reddit" },
    timeRangeField: "created_utc",
    async ensureSession({ capture, context, page, sendInteraction }) {
      await ensureRedditSession({ capture, context, page, sendInteraction });
    },
    async collect(ctx: BrowserCollectContext): Promise<void> {
      await collectAllStreams(ctx);
    },
  });
}
