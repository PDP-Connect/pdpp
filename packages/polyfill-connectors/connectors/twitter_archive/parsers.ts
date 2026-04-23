// Pure parsers for the Twitter archive connector. Kept free of Node I/O
// so they can be unit-tested in isolation (see parsers.test.ts). The
// archive-file reader and record-emission loop live in index.ts.

import type { DMConversation, DMEntry, DMMessage, DMOut, DMShape, TweetEntry, TweetOut, TweetShape } from "./types.ts";

// ─── Module-scoped regexes (Biome useTopLevelRegex) ────────────────────

export const WINDOW_ASSIGN_PREFIX_RE = /^[^=]*=\s*/;
export const TRAILING_SEMICOLON_RE = /;?\s*$/;

// ─── Low-level helpers ─────────────────────────────────────────────────

/**
 * Twitter archive `.js` files assign an array literal to a `window.YTD.*`
 * global. Stripping the assignment prefix + trailing semicolon yields
 * plain JSON. Returns null when the file isn't the expected array shape.
 */
export function stripJsArchive(text: string): unknown[] | null {
  const stripped = text.replace(WINDOW_ASSIGN_PREFIX_RE, "").trim().replace(TRAILING_SEMICOLON_RE, "");
  try {
    const parsed = JSON.parse(stripped) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function toIsoOrNull(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  return d.toISOString();
}

export function toIntOrNull(raw: string | number | undefined): number | null {
  if (raw == null || raw === "") {
    return null;
  }
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : null;
}

// ─── Tweet unwrapping + record building ────────────────────────────────

/**
 * Archive tweet entries come in two shapes: either `{ tweet: {...} }`
 * (the modern layout) or the flat tweet itself (older exports). Unwrap
 * to a single TweetShape so downstream code stays one-branch.
 */
export function unwrapTweetEntry(raw: unknown): TweetShape {
  const entry = raw as TweetEntry;
  if (entry.tweet) {
    return entry.tweet;
  }
  return entry as TweetShape;
}

/**
 * Build a single `tweets`-stream record from an unwrapped TweetShape.
 * Returns null when created_at is missing or unparseable; index.ts treats
 * that as "skip silently" for malformed rows.
 */
export function buildTweetRecord(t: TweetShape): TweetOut | null {
  const createdAt = toIsoOrNull(t.created_at);
  if (!createdAt) {
    return null;
  }
  return {
    id: t.id_str || t.id || null,
    text: t.full_text ?? t.text ?? null,
    created_at: createdAt,
    favorite_count: toIntOrNull(t.favorite_count),
    retweet_count: toIntOrNull(t.retweet_count),
    in_reply_to_status_id: t.in_reply_to_status_id_str ?? null,
    in_reply_to_screen_name: t.in_reply_to_screen_name ?? null,
    lang: t.lang ?? null,
    media_count: (t.entities?.media || []).length,
    url_count: (t.entities?.urls || []).length,
  };
}

// ─── DM unwrapping + record building ───────────────────────────────────

/** Unwrap a DM conversation entry from the `{ dmConversation: {...} }` wrapper. */
export function unwrapDmConversation(raw: unknown): DMConversation {
  const entry = raw as DMEntry;
  if (entry.dmConversation) {
    return entry.dmConversation;
  }
  return entry as DMConversation;
}

/** Unwrap a single DM message from the `{ messageCreate: {...} }` wrapper. */
export function unwrapDmMessage(raw: DMMessage): DMShape {
  if (raw.messageCreate) {
    return raw.messageCreate;
  }
  return raw as DMShape;
}

/**
 * Build a single `direct_messages`-stream record. Returns null when
 * createdAt is missing or unparseable.
 */
export function buildDmRecord(dm: DMShape, conversationId: string | null): DMOut | null {
  const createdAt = toIsoOrNull(dm.createdAt);
  if (!createdAt) {
    return null;
  }
  return {
    id: dm.id ?? null,
    conversation_id: conversationId,
    sender_id: dm.senderId ?? null,
    recipient_id: dm.recipientId ?? null,
    created_at: createdAt,
    text: dm.text ?? null,
  };
}

// ─── Cursor helpers ────────────────────────────────────────────────────

export function isBeforeCursor(createdAt: string, since: string | undefined): boolean {
  return Boolean(since && createdAt <= since);
}

export function advanceCursor(prev: string | undefined, next: string): string {
  if (!prev || next > prev) {
    return next;
  }
  return prev;
}
