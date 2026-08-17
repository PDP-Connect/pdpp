// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for iMessage stream records. Shape-check-before-emit per
 * docs/reference/connector-authoring-guide.md §3.
 *
 * Ground truth: the `emitRecord(...)` literals in index.ts, built from
 * SQLite rows of ~/Library/Messages/chat.db. There is no separate
 * parsers.ts; index.ts is the source of truth for all three streams:
 *
 *   messages:     { id, chat_id, handle, service, is_from_me, text, date,
 *                   date_read, has_attachments }
 *   participants: { id, chat_id, handle, is_from_me }
 *   attachments:  { id, message_id, chat_id, filename, content_type,
 *                   size_bytes, content_sha256, hydration_status,
 *                   hydration_error, blob_ref }
 *
 * Shape notes:
 *   - `id` (messages) is `r.guid || String(r.id)`: an Apple message GUID
 *     (uppercase UUID) when present, else the numeric ROWID as a string.
 *     Validated permissively as a non-empty bounded string rather than a
 *     strict UUID, because the ROWID fallback is a plain integer string.
 *   - `chat_id` is `String(chat.ROWID)` (numeric) or null.
 *   - `handle` is the counterparty contact identifier (phone / email /
 *     Apple ID) — free-form, so pdppSafeText.
 *   - `text` is the message body → pdppSafeText (large messages allowed).
 *   - `date` is always a real ISO string derived from the row's own Apple-
 *     epoch value (appleDateToIso). Rows with a missing/unusable date are
 *     never emitted (index.ts skips them with a SKIP_RESULT instead of
 *     substituting the run clock) — `date` must never be a fabricated,
 *     non-deterministic timestamp. `date_read` is ISO or null.
 *   - `is_from_me` / `has_attachments` are coerced to real booleans.
 *   - `participants` is one record per (chat, handle) pair from
 *     `chat_handle_join` — NOT one row per message, so group-chat
 *     membership doesn't duplicate the messages stream.
 *   - `attachments.id` is a sha256 of the attachment's local filename +
 *     ROWID (bounded, no local path). `filename` is the basename only
 *     (pdppSafeText) — the full local filesystem path never leaves the
 *     connector process, matching the standing PDPP PII rule: diagnostics
 *     carry hashed/structural identifiers, not raw local paths.
 */

import { pdppSafeText } from "@pdpp/collector-runtime/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const NUMERIC_ID_RE = /^\d+$/; // chat_id is String(numeric ROWID)
const ATTACHMENT_ID_RE = /^[0-9a-f]{64}$/; // sha256 hex of filename+rowid

const isoDatetimeSchema = z.string().regex(ISO_DT_RE, "must be an ISO-8601 datetime");
const chatIdSchema = z.string().regex(NUMERIC_ID_RE, "chat_id must be a numeric string").nullable();

const blobRefSchema = z
  .object({
    blob_id: pdppSafeText.min(1),
    mime_type: pdppSafeText.min(1),
    sha256: pdppSafeText.min(1),
    size_bytes: z.number().int().min(0),
  })
  .nullable();

/**
 * messages stream: one record per message row.
 * Cursor: date (Apple epoch high-water mark tracked in STATE).
 */
export const messagesSchema = z.object({
  // GUID (uppercase UUID) or numeric ROWID string. Bounded, non-empty.
  id: z.string().min(1).max(80),
  chat_id: chatIdSchema,
  handle: pdppSafeText.max(320).nullable(),
  service: pdppSafeText.max(40).nullable(),
  is_from_me: z.boolean(),
  text: pdppSafeText.max(10_000_000).nullable(),
  date: isoDatetimeSchema,
  date_read: isoDatetimeSchema.nullable(),
  has_attachments: z.boolean(),
});

/**
 * participants stream: one record per (chat, handle) membership pair from
 * `chat_handle_join`. Semantics: mutable_state — full membership resnapshot
 * each run, not an incremental stream.
 */
export const participantsSchema = z.object({
  id: z.string().min(1).max(160),
  chat_id: z.string().regex(NUMERIC_ID_RE, "chat_id must be a numeric string"),
  handle: pdppSafeText.max(320).nullable(),
  is_from_me: z.boolean(),
});

/**
 * attachments stream: one record per attachment row, joined through
 * message_attachment_join. Bytes are hydrated via a local read bounded to a
 * trusted attachments root (resolveSafeAttachmentPath in index.ts — rejects
 * `../` traversal, absolute-outside-root, and symlink escape) + BlobRef
 * upload; hydration_status/hydration_error report the outcome without
 * leaking the local filesystem path.
 */
export const attachmentsSchema = z.object({
  id: z.string().regex(ATTACHMENT_ID_RE, "attachment id must be a sha256 hex digest"),
  message_id: z.string().min(1).max(80).nullable(),
  chat_id: chatIdSchema,
  filename: pdppSafeText.min(1).max(500),
  content_type: pdppSafeText.min(1).max(200),
  size_bytes: z.number().int().min(0).nullable(),
  content_sha256: pdppSafeText.nullable(),
  hydration_status: z.enum(["deferred", "hydrated", "failed", "too_large", "missing"]),
  hydration_error: pdppSafeText.nullable(),
  blob_ref: blobRefSchema,
});

/**
 * Stream → schema registry. Single source of truth for emitted streams.
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  messages: messagesSchema,
  participants: participantsSchema,
  attachments: attachmentsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
