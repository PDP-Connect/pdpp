/**
 * Zod schemas for Notion stream records. Shape-check-before-emit per
 * docs/connector-authoring-guide.md §3.
 *
 * Ground truth: the `toPageRecord` / `toDatabaseRecord` builders in index.ts
 * (the only place RECORDs are constructed). Schemas mirror the *emitted*
 * shape, not the manifest's aspirational JSON Schema:
 *
 *   - `id`, `parent_id`, `created_by_id`, `last_edited_by_id` are Notion
 *     object ids — UUIDs that the API returns either dashed (36 chars) or
 *     dash-stripped (32 hex). The builder passes them through verbatim, so
 *     the schema accepts both forms via NOTION_ID_RE.
 *   - `title` is free-form human text joined from `plain_text` parts →
 *     `pdppSafeText`. It can be null (the builder emits null when no title
 *     property exists).
 *   - `url` is a notion.so URL or null.
 *   - `created_time` / `last_edited_time` are Notion ISO-8601 timestamps
 *     (`2022-06-28T12:00:00.000Z`) or null.
 *   - `archived` is the builder's `?? null` passthrough — boolean | null.
 *   - `object` (pages only) is the API's object discriminator string
 *     ("page"); `parent_type` is a short enum-ish string ("workspace",
 *     "page_id", "database_id", "block_id") or null.
 *   - `property_names` (databases only) is `Object.keys(properties)` — an
 *     array of property-name strings; each is free-form so uses pdppSafeText.
 */

import { z } from "zod";
import { pdppSafeText } from "../../src/pdpp-safe-text.ts";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
// Notion ids are UUIDs, returned dashed (8-4-4-4-12) or dash-stripped (32 hex).
const NOTION_ID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

const notionIdSchema = z.string().regex(NOTION_ID_RE, "must be a Notion UUID (dashed or 32-hex)");
const isoDateTimeNullable = z.string().regex(ISO_DT_RE, "must be an ISO-8601 datetime").nullable();
// parent_type / object are short structural discriminator strings, not free
// text — bounded plain strings are the right shape (regex would be brittle as
// Notion adds parent kinds).
const shortTagSchema = z.string().min(1).max(64).nullable();

/**
 * pages stream: one record per Notion page object.
 * Cursor: last_edited_time (descending search).
 */
export const pagesSchema = z.object({
  id: notionIdSchema,
  object: z.string().min(1).max(64).nullable(),
  parent_type: shortTagSchema,
  parent_id: notionIdSchema.nullable(),
  title: pdppSafeText.max(4000).nullable(),
  url: z.url().max(4096).nullable(),
  archived: z.boolean().nullable(),
  created_time: isoDateTimeNullable,
  last_edited_time: isoDateTimeNullable,
  created_by_id: notionIdSchema.nullable(),
  last_edited_by_id: notionIdSchema.nullable(),
});

/**
 * databases stream: one record per Notion database object.
 * `property_names` is the list of column names (Object.keys(properties));
 * each column name is free-form human text.
 */
export const databasesSchema = z.object({
  id: notionIdSchema,
  title: pdppSafeText.max(4000).nullable(),
  parent_type: shortTagSchema,
  parent_id: notionIdSchema.nullable(),
  url: z.url().max(4096).nullable(),
  archived: z.boolean().nullable(),
  created_time: isoDateTimeNullable,
  last_edited_time: isoDateTimeNullable,
  property_names: z.array(pdppSafeText.max(2000)),
});

/**
 * Stream → schema registry. Single source of truth for emitted streams.
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  pages: pagesSchema,
  databases: databasesSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
