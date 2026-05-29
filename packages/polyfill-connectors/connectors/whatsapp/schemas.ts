/**
 * Zod schemas for WhatsApp stream records. Shape-check-before-emit per
 * docs/connector-authoring-guide.md §3.
 *
 * Ground truth: the `emitRecord` calls in index.ts. The connector parses
 * chat-export .txt files line-by-line; there is no separate parsers.ts, so
 * the emitted-record literals in index.ts are the source of truth:
 *
 *   chats:    { id, title, participants[], message_count, first_message_date,
 *               last_message_date }
 *   messages: { id, chat_id, author, content, has_attachment, sent_at }
 *
 * Shape notes:
 *   - `id` (chat) is a 16-hex sha256 slice of the filename; message `id` is
 *     `${chatId}:${index}`.
 *   - `title`, `author`, `content` are free-form human text → pdppSafeText.
 *     `author` is a trimmed regex capture and can be empty string; `content`
 *     can be empty (e.g. an attachment-only line) — pdppSafeText permits "".
 *   - `sent_at` is always an ISO string: parseDateTime() or nowIso() fallback.
 *   - date-range fields on `chats` are the first/last message sent_at, so
 *     they are ISO strings or null (empty chat).
 */

import { z } from "zod";
import { pdppSafeText } from "../../src/pdpp-safe-text.ts";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const CHAT_ID_RE = /^[0-9a-f]{16}$/; // 16-hex sha256 slice of filename
const MESSAGE_ID_RE = /^[0-9a-f]{16}:\d+$/; // "<chatId>:<index>"
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

const chatIdSchema = z.string().regex(CHAT_ID_RE, "chat id must be a 16-hex sha256 slice");
const isoDatetimeSchema = z.string().regex(ISO_DT_RE, "must be an ISO-8601 datetime");
const nullableIsoDatetimeSchema = isoDatetimeSchema.nullable();

/**
 * chats stream: one record per imported .txt export.
 * Semantics: mutable_state (re-import replaces).
 */
export const chatsSchema = z.object({
  id: chatIdSchema,
  title: pdppSafeText.max(500),
  participants: z.array(pdppSafeText.max(200)),
  message_count: z.number().int().min(0),
  first_message_date: nullableIsoDatetimeSchema,
  last_message_date: nullableIsoDatetimeSchema,
});

/**
 * messages stream: one record per parsed message line.
 * Cursor: sent_at.
 */
export const messagesSchema = z.object({
  id: z.string().regex(MESSAGE_ID_RE, "message id must be <chatId>:<index>"),
  chat_id: chatIdSchema,
  author: pdppSafeText.max(200),
  content: pdppSafeText.max(10_000_000),
  has_attachment: z.boolean(),
  sent_at: isoDatetimeSchema,
});

/**
 * Stream → schema registry. Single source of truth for emitted streams.
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  chats: chatsSchema,
  messages: messagesSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
