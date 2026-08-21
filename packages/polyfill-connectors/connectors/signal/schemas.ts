// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Signal stream records. Shape-check-before-emit per
 * docs/reference/connector-authoring-guide.md §3.
 *
 * Ground truth: `parsers.ts`'s `buildMessageRecord` / `buildConversationRecord`
 * / `buildReactionRecord`, and index.ts's attachment emit literal.
 *
 *   messages:      { id, conversation_id, sender, sent_at, body, type,
 *                     has_attachments, is_edited }
 *   conversations: { id, type, title, member_count }
 *   reactions:     { id, message_id, emoji, sender }
 *   attachments:   { id, message_id, conversation_id, filename, content_type,
 *                     size_bytes, content_sha256, hydration_status,
 *                     hydration_error, blob_ref }
 *
 * Shape notes:
 *   - `messages.id` / `conversations.id` are Signal's own row UUIDs —
 *     regex-constrained, unlike iMessage's permissive GUID-or-ROWID string
 *     (Signal's schema always carries a real UUID primary key, no numeric
 *     ROWID fallback).
 *   - `sender` (messages.sender, reactions.sender) is bounded free text, NOT
 *     assumed UUID-shaped: verified against sigtop's own source
 *     (signal/reaction.go's `recipientFromReactionID`), Signal Desktop's
 *     schema has carried a phone-number-prefixed id, a bare legacy
 *     conversation id, or a service-id UUID depending on schema version and
 *     record age — treating it as a UUID would silently skip real historical
 *     data from an older account.
 *   - `body` is free-form message text → pdppSafeText.
 *   - `sent_at` is always a real ISO string derived from the row's own
 *     epoch-ms value; a row with no usable timestamp is never emitted
 *     (index.ts skips it with a SKIP_RESULT instead of substituting the run
 *     clock — same discipline as imessage's `date`).
 *   - `type` is Signal's own message-type string (e.g. "incoming",
 *     "outgoing", "call-history") — open vocabulary, so pdppSafeText rather
 *     than a closed enum (Signal Desktop exposes it as free text, and new
 *     Signal message types have shipped over time).
 *   - `attachments.id` is a sha256 of the exported attachment's local path
 *     (never the raw path itself) — same never-leak-a-local-path invariant
 *     as imessage's attachments.id.
 */

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ATTACHMENT_ID_RE = /^[0-9a-f]{64}$/; // sha256 hex of local path

const isoDatetimeSchema = z.string().regex(ISO_DT_RE, "must be an ISO-8601 datetime");
const uuidSchema = z.string().regex(UUID_RE, "must be a UUID");

const blobRefSchema = z
  .object({
    blob_id: pdppSafeText.min(1),
    mime_type: pdppSafeText.min(1),
    sha256: pdppSafeText.min(1),
    size_bytes: z.number().int().min(0),
  })
  .nullable();

/**
 * messages stream: one record per Signal message row.
 * Cursor: sent_at (epoch-ms high-water mark tracked in STATE).
 */
export const messagesSchema = z.object({
  id: uuidSchema,
  conversation_id: uuidSchema,
  sender: pdppSafeText.max(320).nullable(),
  sent_at: isoDatetimeSchema,
  body: pdppSafeText.max(10_000_000).nullable(),
  type: pdppSafeText.max(80).nullable(),
  has_attachments: z.boolean(),
  is_edited: z.boolean(),
});

/**
 * conversations stream: one record per Signal conversation (direct or
 * group). Semantics: mutable_state — full resnapshot each run, no
 * incremental cursor (standing entity, no natural per-row date bound).
 */
export const conversationsSchema = z.object({
  id: uuidSchema,
  type: z.enum(["private", "group"]).nullable(),
  title: pdppSafeText.max(500).nullable(),
  member_count: z.number().int().min(0).nullable(),
});

/**
 * reactions stream: one record per (message, emoji, sender) reaction.
 * Semantics: append_only. Composite id, matching slack.reactions' shape.
 */
export const reactionsSchema = z.object({
  id: z.string().min(1).max(600),
  message_id: uuidSchema,
  emoji: pdppSafeText.min(1).max(40),
  sender: pdppSafeText.min(1).max(320),
});

/**
 * attachments stream: one record per attachment exported by
 * `sigtop export-attachments`. Bytes are hydrated via a local read bounded
 * to a trusted root (sigtop's own output directory — see index.ts's
 * resolveSafeAttachmentPath call, reusing imessage's O_NOFOLLOW primitive
 * verbatim) + BlobRef upload; hydration_status/hydration_error report the
 * outcome without leaking the local filesystem path.
 */
export const attachmentsSchema = z.object({
  id: z.string().regex(ATTACHMENT_ID_RE, "attachment id must be a sha256 hex digest"),
  message_id: uuidSchema.nullable(),
  conversation_id: uuidSchema.nullable(),
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
  conversations: conversationsSchema,
  reactions: reactionsSchema,
  attachments: attachmentsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
