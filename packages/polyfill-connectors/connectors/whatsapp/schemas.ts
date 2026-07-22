// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for WhatsApp stream records. Shape-check-before-emit per
 * docs/reference/connector-authoring-guide.md §3.
 *
 * Ground truth: the `emitRecord` calls in index.ts, backed by parser output
 * from parsers.ts. The emitted-record literals in index.ts are the source of
 * truth for stream shape:
 *
 *   chats:    { id, title, participants[], message_count, first_message_date,
 *               last_message_date }
 *   messages:    { id, chat_id, author, content, has_attachment, sent_at }
 *   attachments: { id, chat_id, message_id, filename, content_type,
 *                  size_bytes, content_sha256, hydration_status,
 *                  hydration_error, blob_ref }
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
const ATTACHMENT_ID_RE = /^[0-9a-f]{16}:attachment:[0-9a-f]{16}$/;
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

const chatIdSchema = z.string().regex(CHAT_ID_RE, "chat id must be a 16-hex sha256 slice");
const isoDatetimeSchema = z.string().regex(ISO_DT_RE, "must be an ISO-8601 datetime");
const nullableIsoDatetimeSchema = isoDatetimeSchema.nullable();
const blobRefSchema = z
  .object({
    blob_id: pdppSafeText.min(1),
    mime_type: pdppSafeText.min(1),
    sha256: pdppSafeText.min(1),
    size_bytes: z.number().int().min(0),
  })
  .nullable();

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

export const attachmentsSchema = z.object({
  id: z.string().regex(ATTACHMENT_ID_RE, "attachment id must be <chatId>:attachment:<hash>"),
  blob_ref: blobRefSchema,
  chat_id: chatIdSchema,
  content_sha256: pdppSafeText.min(1),
  content_type: pdppSafeText.min(1),
  filename: pdppSafeText.min(1),
  hydration_error: pdppSafeText.nullable(),
  hydration_status: z.enum(["deferred", "failed", "hydrated"]),
  message_id: z.string().regex(MESSAGE_ID_RE).nullable(),
  size_bytes: z.number().int().min(0),
});

/**
 * Stream → schema registry. Single source of truth for emitted streams.
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  chats: chatsSchema,
  attachments: attachmentsSchema,
  messages: messagesSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
