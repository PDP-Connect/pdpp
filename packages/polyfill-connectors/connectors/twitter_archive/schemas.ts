/**
 * Zod schemas for Twitter/X archive stream records. Shape-check-before-emit
 * per docs/connector-authoring-guide.md §3.
 *
 * Ground truth: the `TweetOut` / `DMOut` interfaces in types.ts and the
 * `buildTweetRecord` / `buildDmRecord` builders in parsers.ts (exercised by
 * parsers.test.ts). Schemas mirror the *emitted* shapes:
 *
 *   - `id` is nullable on both streams (`t.id_str || t.id || null`,
 *     `dm.id ?? null`) — the archive can omit it. The manifest marks `id`
 *     required, but the builder can emit null, so the schema permits it and
 *     the runtime's id-skip handles a missing key.
 *   - `created_at` is always a normalized ISO-Z string (toIsoOrNull); a row
 *     without a parseable date is dropped before emit, never sent.
 *   - counts: favorite_count / retweet_count are nullable ints (toIntOrNull);
 *     media_count / url_count are always non-negative ints (array lengths).
 *
 * Free-form text (tweet/DM body) uses `pdppSafeText`; numeric-string ids and
 * screen names use bounded regex / pdppSafeText as appropriate.
 */

import { z } from "zod";
import { pdppSafeText } from "../../src/pdpp-safe-text.ts";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const ISO_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/; // toISOString() output
const SNOWFLAKE_ID_RE = /^\d{1,30}$/; // Twitter ids are numeric strings
const SCREEN_NAME_RE = /^[A-Za-z0-9_]{1,40}$/;

// Twitter snowflake ids are numeric strings; nullable because the archive
// can omit id_str/id on malformed rows.
const tweetIdSchema = z.string().regex(SNOWFLAKE_ID_RE, "id must be a numeric string").nullable();
const isoZSchema = z.string().regex(ISO_Z_RE, "created_at must be an ISO-8601 Z timestamp");
const nullableIntSchema = z.number().int().nullable();
const nonNegativeIntSchema = z.number().int().min(0);

/**
 * tweets stream: one record per authored tweet.
 * Cursor: created_at.
 */
export const tweetsSchema = z.object({
  id: tweetIdSchema,
  text: pdppSafeText.max(10_000).nullable(),
  created_at: isoZSchema,
  favorite_count: nullableIntSchema,
  retweet_count: nullableIntSchema,
  in_reply_to_status_id: z.string().regex(SNOWFLAKE_ID_RE).nullable(),
  in_reply_to_screen_name: z.string().regex(SCREEN_NAME_RE).nullable(),
  lang: pdppSafeText.max(40).nullable(),
  media_count: nonNegativeIntSchema,
  url_count: nonNegativeIntSchema,
});

/**
 * direct_messages stream: one record per DM message.
 *
 * DM ids and participant ids are a DIFFERENT id space from tweet snowflakes
 * and are NOT validated with SNOWFLAKE_ID_RE. Real Twitter archives carry
 * numeric DM/user ids, but the only fixtures available (synthetic
 * `__fixtures__/archive-samples.ts`) use short opaque ids ("m1", "111"), so
 * these stay permissive bounded strings to avoid rejecting real records we
 * cannot yet fixture-prove. Tighten to numeric once a real archive is captured.
 * Cursor: created_at.
 */
export const directMessagesSchema = z.object({
  id: z.string().min(1).max(40).nullable(),
  conversation_id: z.string().max(120).nullable(),
  sender_id: z.string().min(1).max(40).nullable(),
  recipient_id: z.string().min(1).max(40).nullable(),
  created_at: isoZSchema,
  text: pdppSafeText.max(10_000).nullable(),
});

/**
 * Stream → schema registry. Single source of truth for emitted streams.
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  tweets: tweetsSchema,
  direct_messages: directMessagesSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
