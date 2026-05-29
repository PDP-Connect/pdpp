/**
 * Zod schemas for Pocket stream records. Shape-check-before-emit per
 * docs/connector-authoring-guide.md §3.
 *
 * DEPRECATED connector: Pocket shut down 2025-07-08 and the v3 API is gone
 * (see index.ts header). It is excluded from register-all and cannot run live.
 * The schema is still authored — and `validateRecord` still wired — for two
 * honest reasons: (1) the build-time gate measures every stream-declaring
 * connector regardless of run state, and (2) a file-based re-import variant
 * (parsing an old HTML export) is a documented future path that would emit the
 * same `itemRecord` shape, so wiring the gate now guards that path too.
 *
 * Ground truth: the `itemRecord` builder in index.ts. Schema mirrors the
 * emitted shape:
 *
 *   - `id` is `String(it.item_id)` — Pocket item ids are numeric strings.
 *   - `status` is Pocket's status code passed through verbatim: "0" (unread),
 *     "1" (archived), "2" (deleted/tombstone). Read directly off an optional
 *     field, so `.optional()`.
 *   - `url` is `resolved_url || given_url`; both source fields are optional, so
 *     the builder can assign `undefined` (JSON drops it) → `.url().optional()`.
 *   - `title` / `author` are free-form human text → `pdppSafeText` (author is a
 *     comma-joined name list).
 *   - `time_*` are ISO-8601 datetimes derived from unix seconds, or null.
 *   - `tags` is `Object.keys(it.tags)` — an array of tag-name strings.
 *   - `archived` / `favorite` are derived booleans; `word_count` /
 *     `reading_time_minutes` are nullable non-negative ints.
 */

import { z } from "zod";
import { pdppSafeText } from "../../src/pdpp-safe-text.ts";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const NUMERIC_ID_RE = /^\d{1,30}$/; // String(numeric Pocket item_id)
const POCKET_STATUS_RE = /^[012]$/; // 0 unread, 1 archived, 2 deleted
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

const isoDateTimeNullable = z.string().regex(ISO_DT_RE, "must be an ISO-8601 datetime").nullable();
const countSchema = z.number().int().min(0).nullable();

/**
 * items stream: one record per saved Pocket item.
 * Cursor: last_time_updated_unix (derived from time_updated/time_added).
 * Tombstone: status === "2".
 */
export const itemsSchema = z.object({
  id: z.string().regex(NUMERIC_ID_RE, "id must be a numeric Pocket item id"),
  status: z.string().regex(POCKET_STATUS_RE, "status must be 0, 1, or 2").optional(),
  url: z.url().max(4096).optional(),
  title: pdppSafeText.max(2000).nullable(),
  author: pdppSafeText.max(2000).nullable(),
  time_added: isoDateTimeNullable,
  time_updated: isoDateTimeNullable,
  time_read: isoDateTimeNullable,
  time_favorited: isoDateTimeNullable,
  tags: z.array(pdppSafeText.max(200)),
  archived: z.boolean(),
  favorite: z.boolean(),
  word_count: countSchema,
  reading_time_minutes: countSchema,
});

/**
 * Stream → schema registry. Single source of truth for emitted streams.
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  items: itemsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
