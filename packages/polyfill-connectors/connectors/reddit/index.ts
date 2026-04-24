#!/usr/bin/env node
/**
 * PDPP Reddit Connector (v0.1.0)
 *
 * Reddit's OAuth script-app password grant was retired in 2024, so this
 * connector collects via a logged-in browser session. All fetches happen
 * through `page.evaluate(fetch)` against `old.reddit.com/*.json` — the same
 * JSON the modern apps consume, served to the current session cookie.
 * old.reddit.com has been stable since 2018 and is the polyfill-friendliest
 * surface for personal data collection.
 *
 * Endpoints:
 *   /user/{u}/submitted.json   — link + self posts
 *   /user/{u}/comments.json    — comments
 *   /user/{u}/saved.json       — mixed saved posts (t3) and comments (t1)
 *
 * Pagination: opaque `after` cursor, newest-first. Incremental sync stops
 * once we cross the earliest `created_utc` from the prior run — same
 * pattern the original API-based connector used.
 *
 * Rate limit: Reddit's logged-in web JSON allows ~100 req/min before 429.
 * We page at limit=100 and use a conservative 500ms politeDelay between
 * pages.
 */

import type { Page } from "playwright";
import { ensureRedditSession } from "../../src/auto-login/reddit.ts";
import {
  type BrowserCollectContext,
  type EmittedMessage,
  nowIso,
  politeDelay,
  type RecordData,
  runConnector,
} from "../../src/connector-runtime.ts";
import { isMainModule } from "../../src/is-main-module.ts";

const USER_AGENT = "pdpp-reddit-connector/0.1 (polyfill; +https://pdpp.org)";
const MAX_PAGES = 100;
const PAGE_DELAY_MS = 500;

// ─── Reddit API shapes ──────────────────────────────────────────────────

interface RedditChildData {
  body?: string | null;
  created_utc?: number | string;
  is_self?: boolean | null;
  link_id?: string | null;
  link_title?: string | null;
  name?: string;
  num_comments?: number | null;
  parent_id?: string | null;
  permalink?: string | null;
  score?: number | null;
  selftext?: string | null;
  subreddit?: string | null;
  title?: string | null;
  upvote_ratio?: number | null;
  url?: string | null;
}

interface RedditChild {
  data: RedditChildData;
  kind: string;
}

interface RedditListing {
  data?: {
    after?: string | null;
    children?: RedditChild[];
  };
}

interface RedditFetchResult {
  json: RedditListing | null;
  status: number;
}

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
  if (status === 401 || status === 403) {
    throw new Error(`reddit_auth_failed: ${status} on ${endpoint}`);
  }
  if (status === 429) {
    throw new Error(`reddit_rate_limited: 429 on ${endpoint}`);
  }
  if (status !== 200 || !json) {
    throw new Error(`reddit_http_${status}: ${endpoint}`);
  }
}

/** Append children older-than-cursor into `all`; returns whether we crossed the cursor. */
function appendNewChildren(
  children: readonly RedditChild[],
  sinceEpochUtc: number | null,
  all: RedditChild[]
): boolean {
  for (const c of children) {
    const created = Number(c?.data?.created_utc ?? 0);
    if (sinceEpochUtc && created <= sinceEpochUtc) {
      return true;
    }
    all.push(c);
  }
  return false;
}

/**
 * Paginate a Reddit listing. Newest-first, opaque `after` cursor. Stops
 * once we cross the prior run's high-water created_utc (incremental), hit
 * an empty page, or run out of `after`.
 */
async function paginate(page: Page, endpoint: string, sinceEpochUtc: number | null): Promise<RedditChild[]> {
  const all: RedditChild[] = [];
  let after: string | null = null;

  for (let guard = 0; guard < MAX_PAGES; guard++) {
    const path = `${endpoint}?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`;
    const { status, json } = await redditFetch(page, path);
    assertListingOk(status, json, endpoint);

    const children = json.data?.children ?? [];
    if (children.length === 0) {
      break;
    }
    if (appendNewChildren(children, sinceEpochUtc, all)) {
      break;
    }

    after = json.data?.after ?? null;
    if (!after) {
      break;
    }
    await politeDelay(PAGE_DELAY_MS);
  }

  return all;
}

// ─── Record builders ────────────────────────────────────────────────────

const isoFromUnix = (u: number | string | undefined | null): string | null =>
  u ? new Date(Number(u) * 1000).toISOString() : null;

const absolutePermalink = (permalink: string | null | undefined): string | null =>
  permalink ? `https://reddit.com${permalink}` : null;

function submittedRecord(d: RedditChildData): RecordData {
  return {
    id: d.name ?? null,
    subreddit: d.subreddit ?? null,
    title: d.title ?? null,
    permalink: absolutePermalink(d.permalink),
    url: d.url ?? null,
    selftext: d.selftext ?? null,
    is_self: d.is_self ?? null,
    score: d.score ?? null,
    num_comments: d.num_comments ?? null,
    upvote_ratio: d.upvote_ratio ?? null,
    created_utc: isoFromUnix(d.created_utc) ?? nowIso(),
  };
}

function commentRecord(d: RedditChildData): RecordData {
  return {
    id: d.name ?? null,
    subreddit: d.subreddit ?? null,
    body: d.body ?? null,
    link_id: d.link_id ?? null,
    parent_id: d.parent_id ?? null,
    permalink: absolutePermalink(d.permalink),
    score: d.score ?? null,
    created_utc: isoFromUnix(d.created_utc) ?? nowIso(),
  };
}

function savedRecord(c: RedditChild): RecordData {
  const d = c.data;
  return {
    id: d.name ?? null,
    kind: c.kind,
    subreddit: d.subreddit ?? null,
    title: d.title ?? d.link_title ?? null,
    body: d.body ?? d.selftext ?? null,
    permalink: absolutePermalink(d.permalink),
    url: d.url ?? null,
    created_utc: isoFromUnix(d.created_utc) ?? nowIso(),
  };
}

// ─── Stream runner ──────────────────────────────────────────────────────

interface StreamCursor {
  last_created_utc?: number;
}

interface CollectStreamArgs {
  emit: (msg: EmittedMessage) => Promise<void>;
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  endpoint: string;
  page: Page;
  progress: (message: string, extra?: { stream?: string }) => Promise<void>;
  progressMessage: string;
  state: Record<string, unknown>;
  streamName: string;
  toRecord: (c: RedditChild) => RecordData;
}

async function collectStream(args: CollectStreamArgs): Promise<void> {
  const { emit, emitRecord, endpoint, page, progress, progressMessage, state, streamName, toRecord } = args;
  await progress(progressMessage, { stream: streamName });

  const cursor = state[streamName] as StreamCursor | undefined;
  const sinceEpoch = cursor?.last_created_utc ?? null;

  const items = await paginate(page, endpoint, sinceEpoch);

  let latestEpoch = sinceEpoch ?? 0;
  for (const c of items) {
    latestEpoch = Math.max(latestEpoch, Number(c.data.created_utc ?? 0));
    await emitRecord(streamName, toRecord(c));
  }

  await emit({
    type: "STATE",
    stream: streamName,
    cursor: { last_created_utc: latestEpoch },
  });
}

// ─── Entry ──────────────────────────────────────────────────────────────

if (isMainModule(import.meta.url)) {
  runConnector({
    name: "reddit",
    retryablePattern: /ECONN|ETIMEDOUT|fetch failed|reddit_rate_limited/i,
    auth: { kind: "env", required: ["REDDIT_USERNAME", "REDDIT_PASSWORD"] },
    browser: { profileName: "reddit" },
    async ensureSession({ context, page, sendInteraction }) {
      await ensureRedditSession({ context, page, sendInteraction });
    },
    async collect(ctx: BrowserCollectContext): Promise<void> {
      const { credentials, emit, emitRecord, page, progress, requested, state } = ctx;

      const user = credentials.REDDIT_USERNAME;
      if (!user) {
        throw new Error("reddit_auth_failed: REDDIT_USERNAME missing");
      }

      const userPath = `/user/${encodeURIComponent(user)}`;

      if (requested.has("submitted")) {
        await collectStream({
          streamName: "submitted",
          endpoint: `${userPath}/submitted.json`,
          page,
          state,
          toRecord: (c) => submittedRecord(c.data),
          emit,
          emitRecord,
          progress,
          progressMessage: "Fetching submissions",
        });
      }

      if (requested.has("comments")) {
        await collectStream({
          streamName: "comments",
          endpoint: `${userPath}/comments.json`,
          page,
          state,
          toRecord: (c) => commentRecord(c.data),
          emit,
          emitRecord,
          progress,
          progressMessage: "Fetching comments",
        });
      }

      if (requested.has("saved")) {
        await collectStream({
          streamName: "saved",
          endpoint: `${userPath}/saved.json`,
          page,
          state,
          toRecord: savedRecord,
          emit,
          emitRecord,
          progress,
          progressMessage: "Fetching saved items",
        });
      }
    },
  });
}
