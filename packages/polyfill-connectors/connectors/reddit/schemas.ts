/**
 * Zod schemas for Reddit stream records. Used for shape-check-before-emit
 * per docs/connector-authoring-guide.md §3: records that don't match the
 * schema become SKIP_RESULT events instead of RECORD events, so the RS
 * never receives data that looks right but isn't.
 *
 * Reddit's JSON is generally well-shaped (it's the same wire format the
 * official apps consume), so most of these assertions are about bounds
 * and format discipline rather than cruft detection — unlike Amazon,
 * where DOM scraping risks semantic leakage.
 */

import { z } from "zod";
import { pdppSafeText } from "../../src/pdpp-safe-text.ts";
import { makeValidateRecord } from "../../src/schema-registry.ts";
import { TEXT_MAX_CHARS } from "./parsers.ts";

// Text-field classification (docs/binary-content-invariant-design-brief.md §4.4):
//   - selftext/body/title/url/domain → pdppSafeText
//   - Regex-validated IDs, subreddit names, permalinks → z.string().regex(...)

// Module-scoped regexes (Biome useTopLevelRegex).
const FULLNAME_POST_RE = /^t3_[a-z0-9]+$/;
const FULLNAME_COMMENT_RE = /^t1_[a-z0-9]+$/;
const FULLNAME_POST_OR_COMMENT_RE = /^t[13]_[a-z0-9]+$/;
const SUBREDDIT_RE = /^(?:[A-Za-z0-9_]{1,21}|reddit\.com)$/;
const PERMALINK_RE = /^https:\/\/reddit\.com\/(r|user)\//;
const PARENT_ID_RE = /^t[1-6]_[a-z0-9]+$/;
const ISO_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Shared field schemas.
const isoDateTimeSchema = z.string().regex(ISO_Z_RE, "must be ISO-8601 with millis and Z suffix");
const subredditSchema = z.string().regex(SUBREDDIT_RE, "invalid subreddit name").nullable();
const permalinkSchema = z.string().regex(PERMALINK_RE, "permalink must be a reddit.com URL").nullable();
const bodyTextSchema = pdppSafeText.max(TEXT_MAX_CHARS).nullable();
const textLenSchema = z.number().int().min(0).nullable();
const scoreSchema = z.number().int().nullable();
const upvoteRatioSchema = z.number().min(0).max(1).nullable();
const nullableBoolSchema = z.boolean().nullable();

export const submittedSchema = z.object({
  id: z.string().regex(FULLNAME_POST_RE, "submitted id must be t3_*"),
  subreddit: subredditSchema,
  title: pdppSafeText.min(1).max(300).nullable(),
  permalink: permalinkSchema,
  url: pdppSafeText.max(4096).nullable(),
  domain: pdppSafeText.min(1).max(253).nullable(),
  selftext: bodyTextSchema,
  selftext_len: textLenSchema,
  is_self: nullableBoolSchema,
  over_18: nullableBoolSchema,
  score: scoreSchema,
  num_comments: z.number().int().min(0).nullable(),
  upvote_ratio: upvoteRatioSchema,
  gilded: z.number().int().min(0).nullable(),
  created_utc: isoDateTimeSchema,
  fetched_at: isoDateTimeSchema,
});

export const commentSchema = z.object({
  id: z.string().regex(FULLNAME_COMMENT_RE, "comment id must be t1_*"),
  subreddit: subredditSchema,
  body: bodyTextSchema,
  body_len: textLenSchema,
  link_id: z.string().regex(FULLNAME_POST_RE, "link_id must be t3_*").nullable(),
  parent_id: z.string().regex(PARENT_ID_RE, "parent_id must be a fullname").nullable(),
  is_top_level: nullableBoolSchema,
  permalink: permalinkSchema,
  score: scoreSchema,
  gilded: z.number().int().min(0).nullable(),
  created_utc: isoDateTimeSchema,
  fetched_at: isoDateTimeSchema,
});

export const savedSchema = z.object({
  id: z.string().regex(FULLNAME_POST_OR_COMMENT_RE, "saved id must be t1_* or t3_*"),
  kind: z.enum(["t1", "t3"]),
  is_post: z.boolean(),
  subreddit: subredditSchema,
  title: pdppSafeText.min(1).max(300).nullable(),
  body: bodyTextSchema,
  body_len: textLenSchema,
  permalink: permalinkSchema,
  url: pdppSafeText.max(4096).nullable(),
  created_utc: isoDateTimeSchema,
  fetched_at: isoDateTimeSchema,
});

// upvoted/downvoted/hidden share one shape — the same mix of t1/t3.
export const voteSchema = z.object({
  id: z.string().regex(FULLNAME_POST_OR_COMMENT_RE, "vote id must be t1_* or t3_*"),
  kind: z.enum(["t1", "t3"]),
  is_post: z.boolean(),
  subreddit: subredditSchema,
  title: pdppSafeText.min(1).max(300).nullable(),
  body: bodyTextSchema,
  body_len: textLenSchema,
  url: pdppSafeText.max(4096).nullable(),
  permalink: permalinkSchema,
  score: scoreSchema,
  num_comments: z.number().int().min(0).nullable(),
  created_utc: isoDateTimeSchema,
  fetched_at: isoDateTimeSchema,
});

/** Map stream name → schema. Single source of truth for what streams this
 *  connector produces at shape-check time. upvoted/downvoted/hidden all
 *  share `voteSchema` (same server-side shape, different semantic label). */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  submitted: submittedSchema,
  comments: commentSchema,
  saved: savedSchema,
  upvoted: voteSchema,
  downvoted: voteSchema,
  hidden: voteSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
