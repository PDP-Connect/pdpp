// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure parsers for the Reddit connector. Kept free of Playwright / Node
// I/O so they can be unit-tested in isolation. The fetch loop, browser
// lifecycle, and cursoring live in index.ts.

import type {
  CommentRecord,
  RedditChild,
  RedditChildData,
  RedditListing,
  SavedRecord,
  SubmittedRecord,
  VoteRecord,
} from "./types.ts";

// ─── Constants ──────────────────────────────────────────────────────────

/** Reddit's old web JSON caps per-page at 100 for listings. */
export const PAGE_LIMIT = 100;

/** Safety cap on pagination loops. 100 pages * 100 items = 10k records,
 *  plenty for any single stream in one run; incremental sync keeps
 *  subsequent runs cheap. */
export const MAX_PAGES = 100;

/** Bound on emitted text-field length. Reddit permits up to 40k chars in
 *  selftext and 10k in comments; truncating at 10k keeps records
 *  query-friendly without losing the overwhelming majority of content. */
export const TEXT_MAX_CHARS = 10_000;

// ─── Error classification (non-I/O, pure) ───────────────────────────────

/** Narrow HTTP status to a connector-level error class. `null` means
 *  "status ok, treat response as data". Throwing is the caller's
 *  responsibility. */
export function classifyListingStatus(status: number): "auth_failed" | "rate_limited" | "http_error" | null {
  if (status === 401 || status === 403) {
    return "auth_failed";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (status !== 200) {
    return "http_error";
  }
  return null;
}

// ─── Field helpers ──────────────────────────────────────────────────────

export const isoFromUnix = (u: number | string | undefined | null): string | null => {
  if (u === undefined || u === null || u === "") {
    return null;
  }
  const n = Number(u);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  return new Date(n * 1000).toISOString();
};

export const absolutePermalink = (permalink: string | null | undefined): string | null =>
  permalink ? `https://reddit.com${permalink}` : null;

/** Extract hostname from a URL, for link-post domain enrichment.
 *  Returns null for non-URL inputs and for self-posts (which Reddit
 *  gives a `self.<sub>` pseudo-domain that isn't useful downstream). */
export function domainOf(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) {
    return null;
  }
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host.startsWith("self.") || host === "reddit.com" || host.endsWith(".reddit.com")) {
      return null;
    }
    return host || null;
  } catch {
    return null;
  }
}

/** Truncate free-form text before emit; preserves null semantics. */
export function truncateText(text: string | null | undefined): string | null {
  if (text === null || text === undefined) {
    return null;
  }
  return typeof text === "string" ? text.slice(0, TEXT_MAX_CHARS) : null;
}

/** UTF-16 code-unit length — matches what `slice()` above produces and
 *  what downstream JSON consumers see. For English-heavy Reddit text
 *  this is effectively character count; for emoji-heavy text it slightly
 *  over-counts, which is fine for a record-size signal. */
export function textLen(text: string | null | undefined): number | null {
  if (text === null || text === undefined) {
    return null;
  }
  return typeof text === "string" ? text.length : null;
}

/** A comment is top-level when its parent is the post itself — i.e.
 *  `parent_id` starts with `t3_`. Top-level vs reply is a useful
 *  semantic signal for analysis (participation depth, reply patterns). */
export function isTopLevelComment(parentId: string | null | undefined): boolean | null {
  if (!parentId) {
    return null;
  }
  return parentId.startsWith("t3_");
}

// ─── Record builders ────────────────────────────────────────────────────

export function submittedRecord(d: RedditChildData, fetchedAt: string): SubmittedRecord {
  const selftext = truncateText(d.selftext ?? null);
  return {
    id: d.name ?? "",
    subreddit: d.subreddit ?? null,
    title: d.title ?? null,
    permalink: absolutePermalink(d.permalink),
    url: d.url ?? null,
    domain: domainOf(d.url),
    selftext,
    selftext_len: textLen(d.selftext ?? null),
    is_self: d.is_self ?? null,
    over_18: d.over_18 ?? null,
    score: d.score ?? null,
    num_comments: d.num_comments ?? null,
    upvote_ratio: d.upvote_ratio ?? null,
    gilded: d.gilded ?? null,
    created_utc: isoFromUnix(d.created_utc) ?? "",
    fetched_at: fetchedAt,
  };
}

export function commentRecord(d: RedditChildData, fetchedAt: string): CommentRecord {
  const body = truncateText(d.body ?? null);
  return {
    id: d.name ?? "",
    subreddit: d.subreddit ?? null,
    body,
    body_len: textLen(d.body ?? null),
    link_id: d.link_id ?? null,
    parent_id: d.parent_id ?? null,
    is_top_level: isTopLevelComment(d.parent_id ?? null),
    permalink: absolutePermalink(d.permalink),
    score: d.score ?? null,
    gilded: d.gilded ?? null,
    created_utc: isoFromUnix(d.created_utc) ?? "",
    fetched_at: fetchedAt,
  };
}

export function savedRecord(c: RedditChild, fetchedAt: string): SavedRecord {
  const d = c.data;
  const body = truncateText(d.body ?? d.selftext ?? null);
  return {
    id: d.name ?? "",
    kind: c.kind,
    is_post: c.kind === "t3",
    subreddit: d.subreddit ?? null,
    title: d.title ?? d.link_title ?? null,
    body,
    body_len: textLen(d.body ?? d.selftext ?? null),
    permalink: absolutePermalink(d.permalink),
    url: d.url ?? null,
    created_utc: isoFromUnix(d.created_utc) ?? "",
    fetched_at: fetchedAt,
  };
}

/** Shared builder for vote-like streams (upvoted, downvoted, hidden).
 *  Reddit returns posts (t3) and comments (t1) interleaved, and
 *  we preserve the kind + is_post discriminator so downstream queries
 *  can filter by content type. */
export function voteRecord(c: RedditChild, fetchedAt: string): VoteRecord {
  const d = c.data;
  const body = truncateText(d.body ?? d.selftext ?? null);
  return {
    id: d.name ?? "",
    kind: c.kind,
    is_post: c.kind === "t3",
    subreddit: d.subreddit ?? null,
    title: d.title ?? d.link_title ?? null,
    body,
    body_len: textLen(d.body ?? d.selftext ?? null),
    url: d.url ?? null,
    permalink: absolutePermalink(d.permalink),
    score: d.score ?? null,
    num_comments: d.num_comments ?? null,
    created_utc: isoFromUnix(d.created_utc) ?? "",
    fetched_at: fetchedAt,
  };
}

// ─── Pagination helpers ─────────────────────────────────────────────────

/** Append children newer than the cursor into `out`. Reddit listings are
 *  newest-first, so once we hit a child at or before the cursor we're
 *  done with the stream — return true to signal "stop paging". */
export function appendNewChildren(
  children: readonly RedditChild[],
  sinceEpochUtc: number | null,
  out: RedditChild[]
): boolean {
  for (const c of children) {
    const created = Number(c?.data?.created_utc ?? 0);
    if (sinceEpochUtc && created <= sinceEpochUtc) {
      return true;
    }
    out.push(c);
  }
  return false;
}

/** Build the `?after=…&limit=100` path segment given an endpoint and
 *  the current pagination cursor. */
export function pagePath(endpoint: string, after: string | null, limit = PAGE_LIMIT): string {
  const qs = `limit=${String(limit)}${after ? `&after=${encodeURIComponent(after)}` : ""}`;
  return `${endpoint}?${qs}`;
}

/** Extract the `after` cursor from a listing response, normalizing
 *  empty string → null. */
export function nextAfter(listing: RedditListing | null | undefined): string | null {
  const after = listing?.data?.after;
  return after ? after : null;
}

/** Max created_utc epoch across a batch of children, clamped at `current`.
 *  Used to advance the per-stream STATE cursor. */
export function maxCreatedEpoch(children: readonly RedditChild[], current: number): number {
  let max = current;
  for (const c of children) {
    const epoch = Number(c?.data?.created_utc ?? 0);
    if (Number.isFinite(epoch) && epoch > max) {
      max = epoch;
    }
  }
  return max;
}

/** Resolve the since-cursor for a stream from the persisted state blob. */
export function sinceFromState(state: Record<string, unknown>, streamName: string): number | null {
  const cursor = state[streamName] as { last_created_utc?: number } | undefined;
  const raw = cursor?.last_created_utc;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return null;
  }
  return raw;
}
