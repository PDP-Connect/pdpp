/**
 * Zod schemas for iMessage stream records. Shape-check-before-emit per
 * docs/reference/connector-authoring-guide.md §3.
 *
 * Ground truth: the `emitRecord("messages", {...})` literal in index.ts,
 * built from a SQLite row of ~/Library/Messages/chat.db. There is no
 * separate parsers.ts; index.ts is the source of truth:
 *
 *   { id, chat_id, handle, service, is_from_me, text, date, date_read,
 *     has_attachments }
 *
 * Shape notes:
 *   - `id` is `r.guid || String(r.id)`: an Apple message GUID (uppercase
 *     UUID) when present, else the numeric ROWID as a string. Validated
 *     permissively as a non-empty bounded string rather than a strict UUID,
 *     because the ROWID fallback is a plain integer string.
 *   - `chat_id` is `String(cmj.chat_id)` (numeric) or null.
 *   - `handle` is the counterparty contact identifier (phone / email /
 *     Apple ID) — free-form, so pdppSafeText.
 *   - `text` is the message body → pdppSafeText (large messages allowed).
 *   - `date` is always an ISO string (appleDateToIso, falling back to the
 *     run clock when the row's date is missing). `date_read` is ISO or null.
 *   - `is_from_me` / `has_attachments` are coerced to real booleans.
 */

import { z } from "zod";
import { pdppSafeText } from "../../src/pdpp-safe-text.ts";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const NUMERIC_ID_RE = /^\d+$/; // chat_id is String(numeric ROWID)

const isoDatetimeSchema = z.string().regex(ISO_DT_RE, "must be an ISO-8601 datetime");

/**
 * messages stream: one record per message row.
 * Cursor: date (Apple epoch high-water mark tracked in STATE).
 */
export const messagesSchema = z.object({
  // GUID (uppercase UUID) or numeric ROWID string. Bounded, non-empty.
  id: z.string().min(1).max(80),
  chat_id: z.string().regex(NUMERIC_ID_RE, "chat_id must be a numeric string").nullable(),
  handle: pdppSafeText.max(320).nullable(),
  service: pdppSafeText.max(40).nullable(),
  is_from_me: z.boolean(),
  text: pdppSafeText.max(10_000_000).nullable(),
  date: isoDatetimeSchema,
  date_read: isoDatetimeSchema.nullable(),
  has_attachments: z.boolean(),
});

/**
 * Stream → schema registry. Single source of truth for emitted streams.
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  messages: messagesSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
