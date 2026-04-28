#!/usr/bin/env node
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
 */

import type { Page } from "playwright";
import { ensureRedditSession } from "../../src/auto-login/reddit.ts";
import {
  type BrowserCollectContext,
  type EmittedMessage,
  politeDelay,
  type RecordData,
  runConnector,
} from "../../src/connector-runtime.ts";
import type { CaptureSession } from "../../src/fixture-capture.ts";
import { isMainModule } from "../../src/is-main-module.ts";
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

// ─── Fetch through the page (preserves session cookie + anti-bot) ───────

async function redditFetch(page: Page, path: string): Promise<RedditFetchResult> {
  return (await page.evaluate(
    async ({ path, userAgent }) => {
      try {
        const res = await fetch(`https://old.reddit.com${path}`, {
          credentials: "include",
          headers: {
            accept: "application/json",
            "user-agent": userAgent,
          },
        });
        const status = res.status;
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

export async function paginate(
  fetchPath: RedditListingFetch,
  endpoint: string,
  sinceEpochUtc: number | null,
  capture: CaptureSession | null,
  delay: (ms: number) => Promise<void> = politeDelay
): Promise<RedditChild[]> {
  const all: RedditChild[] = [];
  let after: string | null = null;

  for (let guard = 0; guard < MAX_PAGES; guard++) {
    const path = pagePath(endpoint, after);
    const { status, json } = await fetchPath(path);
    assertListingOk(status, json, endpoint);

    capture?.captureHttp(`page-${String(guard).padStart(3, "0")}-${endpoint.replaceAll("/", "_")}`, json, {
      status,
      path,
      endpoint,
    });

    const children = json.data?.children ?? [];
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
  progress: (message: string, extra?: { stream?: string }) => Promise<void>;
  state: Record<string, unknown>;
  stream: RedditStreamConfig;
}

export async function collectStream(args: CollectStreamArgs): Promise<void> {
  const { capture, delay, emit, emitRecord, fetchPath, progress, state, stream } = args;
  await progress(stream.progressMessage, { stream: stream.name });

  const sinceEpoch = sinceFromState(state, stream.name);
  const items = await paginate(fetchPath, stream.endpoint, sinceEpoch, capture, delay);

  const latestEpoch = maxCreatedEpoch(items, sinceEpoch ?? 0);
  for (const c of items) {
    await emitRecord(stream.name, stream.toRecord(c));
  }

  await emit({
    type: "STATE",
    stream: stream.name,
    cursor: { last_created_utc: latestEpoch },
  });
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

// ─── Entry ──────────────────────────────────────────────────────────────

if (isMainModule(import.meta.url)) {
  runConnector({
    name: "reddit",
    validateRecord,
    retryablePattern: /ECONN|ETIMEDOUT|fetch failed|reddit_rate_limited/i,
    auth: { kind: "env", required: ["REDDIT_USERNAME", "REDDIT_PASSWORD"] },
    browser: { profileName: "reddit" },
    timeRangeField: "created_utc",
    async ensureSession({ context, page, sendInteraction }) {
      await ensureRedditSession({ context, page, sendInteraction });
    },
    async collect(ctx: BrowserCollectContext): Promise<void> {
      const { capture, credentials, emit, emitRecord, emittedAt, page, progress, requested, state } = ctx;

      const user = credentials.REDDIT_USERNAME;
      if (!user) {
        throw new Error("reddit_auth_failed: REDDIT_USERNAME missing");
      }
      const userPath = `/user/${encodeURIComponent(user)}`;
      const fetchPath = makePageFetch(page);

      for (const stream of buildStreamTable(userPath, emittedAt)) {
        if (!requested.has(stream.name)) {
          continue;
        }
        await collectStream({
          stream,
          fetchPath,
          state,
          emit,
          emitRecord,
          progress,
          capture,
        });
      }
    },
  });
}
