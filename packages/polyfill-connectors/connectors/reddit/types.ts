// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Parsed shapes for the Reddit connector. Extracted from index.ts so
// parsers.ts and tests can import them without pulling in the Playwright-
// flavored runtime entry.

export interface RedditChildData {
  body?: string | null;
  created_utc?: number | string;
  domain?: string | null;
  gilded?: number | null;
  is_self?: boolean | null;
  link_id?: string | null;
  link_title?: string | null;
  name?: string;
  num_comments?: number | null;
  over_18?: boolean | null;
  parent_id?: string | null;
  permalink?: string | null;
  score?: number | null;
  selftext?: string | null;
  subreddit?: string | null;
  subreddit_name_prefixed?: string | null;
  title?: string | null;
  upvote_ratio?: number | null;
  url?: string | null;
}

export interface RedditChild {
  data: RedditChildData;
  kind: string;
}

export interface RedditListing {
  data?: {
    after?: string | null;
    children?: RedditChild[];
  };
}

export interface RedditFetchResult {
  json: RedditListing | null;
  status: number;
}

// ─── Emitted record shapes ──────────────────────────────────────────────

/** `submitted` stream record. Link + self posts authored by the owner. */
export interface SubmittedRecord {
  created_utc: string;
  domain: string | null;
  fetched_at: string;
  gilded: number | null;
  id: string;
  is_self: boolean | null;
  num_comments: number | null;
  over_18: boolean | null;
  permalink: string | null;
  score: number | null;
  selftext: string | null;
  selftext_len: number | null;
  subreddit: string | null;
  title: string | null;
  upvote_ratio: number | null;
  url: string | null;
  [field: string]: unknown;
}

/** `comments` stream record. Comments authored by the owner. */
export interface CommentRecord {
  body: string | null;
  body_len: number | null;
  created_utc: string;
  fetched_at: string;
  gilded: number | null;
  id: string;
  is_top_level: boolean | null;
  link_id: string | null;
  parent_id: string | null;
  permalink: string | null;
  score: number | null;
  subreddit: string | null;
  [field: string]: unknown;
}

/** `saved` stream record. Mix of saved posts (t3) and saved comments (t1). */
export interface SavedRecord {
  body: string | null;
  body_len: number | null;
  created_utc: string;
  fetched_at: string;
  id: string;
  is_post: boolean;
  kind: string;
  permalink: string | null;
  subreddit: string | null;
  title: string | null;
  url: string | null;
  [field: string]: unknown;
}

/** Shared shape for `upvoted` / `downvoted` / `hidden` streams.
 *  Reddit returns the same listing shape as /submitted + /saved — a mix of
 *  posts (t3) and comments (t1) the user has acted on. */
export interface VoteRecord {
  body: string | null;
  body_len: number | null;
  created_utc: string;
  fetched_at: string;
  id: string;
  is_post: boolean;
  kind: string;
  num_comments: number | null;
  permalink: string | null;
  score: number | null;
  subreddit: string | null;
  title: string | null;
  url: string | null;
  [field: string]: unknown;
}

export interface StreamCursor {
  last_created_utc?: number;
}
