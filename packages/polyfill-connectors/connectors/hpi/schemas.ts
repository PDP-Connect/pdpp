/**
 * Zod schemas for HPI stream records (shape-check before emit).
 *
 * HPI object shapes are upstream-determined and vary by module/version, so these
 * schemas are intentionally lenient: they pin the keyable `id` and the cursor
 * field's type, allow nullable text fields, and `.passthrough()` everything else
 * HPI returns (we forward the full upstream object rather than narrowing it).
 * A record that lacks `id` becomes a SKIP_RESULT, never a malformed RECORD.
 *
 * See docs/connector-authoring-guide.md §3 and the polyfill-runtime requirement
 * "Connectors declaring manifest streams SHALL validate emitted records...".
 */

import { z } from "zod";
import { makeValidateRecord } from "../../src/schema-registry.ts";

const idField = z.union([z.string(), z.number()]).transform((v) => String(v));
const nullableText = z.string().nullable().optional();
const nullableDate = z.string().nullable().optional();

// z.looseObject = zod 4's replacement for the deprecated `.passthrough()`:
// validate the declared fields, forward any extra keys HPI returns untouched.
export const redditSavedSchema = z.looseObject({
  id: idField,
  subreddit: nullableText,
  title: nullableText,
  body: nullableText,
  url: nullableText,
  created: nullableDate,
  fetched_at: z.string().optional(),
});

export const redditCommentSchema = z.looseObject({
  id: idField,
  subreddit: nullableText,
  body: nullableText,
  created: nullableDate,
  fetched_at: z.string().optional(),
});

export const commitSchema = z.looseObject({
  id: idField,
  sha: nullableText,
  repo: nullableText,
  message: nullableText,
  committed_dt: nullableDate,
  authored_dt: nullableDate,
  fetched_at: z.string().optional(),
});

export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  reddit_saved: redditSavedSchema,
  reddit_comments: redditCommentSchema,
  commits: commitSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
