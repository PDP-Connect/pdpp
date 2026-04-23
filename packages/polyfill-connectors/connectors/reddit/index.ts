#!/usr/bin/env node
/**
 * PDPP Reddit Connector (v0.1.0)
 *
 * Auth: OAuth script-app credentials via REDDIT_CLIENT_ID +
 * REDDIT_CLIENT_SECRET + REDDIT_USERNAME + REDDIT_PASSWORD (install an app at
 * https://www.reddit.com/prefs/apps — type "script"). Or provide
 * REDDIT_ACCESS_TOKEN directly (shorter TTL).
 *
 * Endpoints:
 *   /user/{u}/submitted
 *   /user/{u}/comments
 *   /user/{u}/saved (requires read+history scopes)
 *
 * Rate limit: 100 OAuth req/min.
 */

import { nowIso, runConnector } from "../../src/connector-runtime.ts";

const USER_AGENT = "pdpp-reddit-connector/0.1";
const MAX_PAGES = 100;

interface RedditAccessTokenResponse {
  access_token: string;
}

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

const isoFromUnix = (u: number | string | undefined | null): string | null =>
  u ? new Date(Number(u) * 1000).toISOString() : null;

async function getAccessToken(): Promise<string> {
  if (process.env.REDDIT_ACCESS_TOKEN) {
    return process.env.REDDIT_ACCESS_TOKEN;
  }
  const clientId = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  const user = process.env.REDDIT_USERNAME;
  const pass = process.env.REDDIT_PASSWORD;
  if (!(clientId && secret && user && pass)) {
    throw new Error(
      "reddit_creds_missing: set REDDIT_ACCESS_TOKEN, or all of REDDIT_CLIENT_ID/SECRET/USERNAME/PASSWORD"
    );
  }
  const basic = Buffer.from(`${clientId}:${secret}`).toString("base64");
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams({
      grant_type: "password",
      username: user,
      password: pass,
    }).toString(),
  });
  if (!res.ok) {
    throw new Error(`reddit_token_${String(res.status)}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as RedditAccessTokenResponse;
  return body.access_token;
}

async function redditFetch(path: string, token: string): Promise<RedditListing> {
  const res = await fetch(`https://oauth.reddit.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT },
  });
  if (res.status === 401) {
    throw new Error("reddit_auth_failed");
  }
  if (res.status === 429) {
    throw new Error("reddit_rate_limited");
  }
  if (!res.ok) {
    throw new Error(`reddit_http_${String(res.status)}: ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as RedditListing;
}

/**
 * Paginate a Reddit listing. Reddit listings are newest-first and use an
 * opaque `after` cursor. We support incremental sync by stopping pagination
 * once we cross the earliest `created_utc` from the prior run.
 */
async function paginate(endpointTemplate: string, token: string, sinceEpochUtc: number | null): Promise<RedditChild[]> {
  const all: RedditChild[] = [];
  let after: string | null = null;
  let guard = MAX_PAGES;
  while (guard-- > 0) {
    const path = `${endpointTemplate}?limit=100${after ? `&after=${after}` : ""}`;
    const json = await redditFetch(path, token);
    const children = json?.data?.children || [];
    if (!children.length) {
      break;
    }

    // Incremental stop: if we've gone past the cursor (created_utc < sinceEpoch),
    // everything remaining is older — stop paginating.
    let hitCursor = false;
    for (const c of children) {
      const created = Number(c?.data?.created_utc || 0);
      if (sinceEpochUtc && created <= sinceEpochUtc) {
        hitCursor = true;
        break;
      }
      all.push(c);
    }
    if (hitCursor) {
      break;
    }

    after = json?.data?.after ?? null;
    if (!after) {
      break;
    }
  }
  return all;
}

function submittedRecord(d: RedditChildData): Record<string, unknown> {
  return {
    id: d.name,
    subreddit: d.subreddit ?? null,
    title: d.title ?? null,
    permalink: d.permalink ? `https://reddit.com${d.permalink}` : null,
    url: d.url ?? null,
    selftext: d.selftext ?? null,
    is_self: d.is_self ?? null,
    score: d.score ?? null,
    num_comments: d.num_comments ?? null,
    upvote_ratio: d.upvote_ratio ?? null,
    created_utc: isoFromUnix(d.created_utc) || nowIso(),
  };
}

function commentRecord(d: RedditChildData): Record<string, unknown> {
  return {
    id: d.name,
    subreddit: d.subreddit ?? null,
    body: d.body ?? null,
    link_id: d.link_id ?? null,
    parent_id: d.parent_id ?? null,
    permalink: d.permalink ? `https://reddit.com${d.permalink}` : null,
    score: d.score ?? null,
    created_utc: isoFromUnix(d.created_utc) || nowIso(),
  };
}

function savedRecord(c: RedditChild): Record<string, unknown> {
  const d = c.data;
  return {
    id: d.name,
    kind: c.kind,
    subreddit: d.subreddit ?? null,
    title: d.title ?? d.link_title ?? null,
    body: d.body ?? d.selftext ?? null,
    permalink: d.permalink ? `https://reddit.com${d.permalink}` : null,
    url: d.url ?? null,
    created_utc: isoFromUnix(d.created_utc) || nowIso(),
  };
}

interface StreamCursor {
  last_created_utc?: number;
}

interface CollectStreamArgs {
  emit: (msg: { type: "STATE"; stream: string; cursor: unknown }) => Promise<void>;
  emitRecord: (stream: string, data: Record<string, unknown>) => Promise<void>;
  endpoint: string;
  progress: (message: string, extra?: { stream?: string }) => Promise<void>;
  progressMessage: string;
  state: Record<string, unknown>;
  streamName: string;
  token: string;
  toRecord: (c: RedditChild) => Record<string, unknown>;
}

async function collectStream(args: CollectStreamArgs): Promise<void> {
  const { streamName, endpoint, token, state, toRecord, emit, emitRecord, progress, progressMessage } = args;
  await progress(progressMessage, { stream: streamName });
  const cursor = state[streamName] as StreamCursor | undefined;
  const sinceEpoch = cursor?.last_created_utc || null;
  const items = await paginate(endpoint, token, sinceEpoch);
  let latestEpoch = sinceEpoch || 0;
  for (const c of items) {
    latestEpoch = Math.max(latestEpoch, Number(c.data.created_utc || 0));
    await emitRecord(streamName, toRecord(c));
  }
  await emit({
    type: "STATE",
    stream: streamName,
    cursor: { last_created_utc: latestEpoch },
  });
}

runConnector({
  name: "reddit",
  retryablePattern: /ECONN|fetch failed|rate_limited/i,
  auth: { kind: "env", required: ["REDDIT_USERNAME"] },
  async collect({ state, requested, credentials, emit, emitRecord, progress }) {
    const user = credentials.REDDIT_USERNAME;
    if (!user) {
      throw new Error("reddit_auth_failed");
    }

    const token = await getAccessToken();

    if (requested.has("submitted")) {
      await collectStream({
        streamName: "submitted",
        endpoint: `/user/${encodeURIComponent(user)}/submitted`,
        token,
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
        endpoint: `/user/${encodeURIComponent(user)}/comments`,
        token,
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
        endpoint: `/user/${encodeURIComponent(user)}/saved`,
        token,
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
