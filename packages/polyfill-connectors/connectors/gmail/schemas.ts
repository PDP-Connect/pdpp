// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Gmail stream records. Used for shape-check-before-emit
 * per docs/reference/connector-authoring-guide.md §3: records that don't match the
 * schema become SKIP_RESULT events instead of RECORD events, so the RS
 * never receives data that looks right but isn't.
 *
 * Gmail's JSON is well-shaped (direct IMAP structure), so most assertions
 * are about bounds and format discipline.
 */

import { z } from "zod";
import { pdppSafeText } from "../../src/pdpp-safe-text.ts";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Text-field classification (docs/reference/binary-content-invariant-design-brief.md §4.4):
//   - Free-form human-readable text (subjects, body, snippet, names) → pdppSafeText
//   - Regex-validated structural strings (message IDs, ISO dates) → z.string().regex(...)

// Module-scoped regexes (Biome useTopLevelRegex).
const GMAIL_MESSAGE_ID_RE = /^[0-9a-f]{1,32}$/;
const ISO_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const PART_INDEX_RE = /^\d+(\.\d+)*$/;

// Shared field schemas.
const isoDateTimeSchema = z.string().regex(ISO_Z_RE, "must be ISO-8601");
const messageIdSchema = z.string().regex(GMAIL_MESSAGE_ID_RE, "must be 1-32 hex chars");
const emailAddressSchema = pdppSafeText.nullable();
const nameStringSchema = pdppSafeText.nullable();
const bodyTextSchema = pdppSafeText.max(10_000_000).nullable();
const bodyBytesSchema = z.number().int().min(0).nullable();
const partIndexSchema = z.string().regex(PART_INDEX_RE);

// Messages stream schema: one record per message.
export const messagesSchema = z.object({
  id: messageIdSchema,
  thread_id: messageIdSchema,
  subject: pdppSafeText.nullable(),
  from_name: nameStringSchema,
  from_email: emailAddressSchema,
  to: z.array(
    z.object({
      name: nameStringSchema,
      email: emailAddressSchema,
    })
  ),
  cc: z.array(
    z.object({
      name: nameStringSchema,
      email: emailAddressSchema,
    })
  ),
  bcc: z.array(
    z.object({
      name: nameStringSchema,
      email: emailAddressSchema,
    })
  ),
  reply_to: z.array(
    z.object({
      name: nameStringSchema,
      email: emailAddressSchema,
    })
  ),
  date: pdppSafeText.nullable(), // Raw RFC 2822 header date
  received_at: isoDateTimeSchema,
  message_id: pdppSafeText.nullable(), // RFC message-id header
  in_reply_to: pdppSafeText.nullable(),
  references: z.array(pdppSafeText),
  size_bytes: z.number().int().min(0).nullable(),
  labels: z.array(pdppSafeText),
  is_draft: z.boolean(),
  is_flagged: z.boolean(),
  is_seen: z.boolean(),
  is_answered: z.boolean(),
  has_attachments: z.boolean(),
  snippet: pdppSafeText.nullable(),
});

// Threads stream schema: one record per thread.
export const threadsSchema = z.object({
  id: messageIdSchema,
  subject: pdppSafeText.nullable(),
  participant_emails: z.array(pdppSafeText),
  message_count: z.number().int().min(1),
  first_message_date: isoDateTimeSchema,
  last_message_date: isoDateTimeSchema,
  labels: z.array(pdppSafeText),
  unread_count: z.number().int().min(0),
  flagged_count: z.number().int().min(0),
  has_attachments: z.boolean(),
});

// Labels stream schema: one record per label (no id field, name is the key).
export const labelsSchema = z.object({
  name: pdppSafeText.min(1).max(200),
  canonical_name: pdppSafeText,
  is_system: z.boolean(),
  parent_name: pdppSafeText.nullable(),
  message_count: z.number().int().min(0).nullable(),
});

// Message bodies stream schema: one record per message with body content.
export const messageBodiesSchema = z.object({
  id: messageIdSchema,
  message_id: messageIdSchema,
  body_text: bodyTextSchema,
  body_html: bodyTextSchema,
  body_text_bytes: bodyBytesSchema,
  body_html_bytes: bodyBytesSchema,
  body_source: z.enum(["text_plain", "html_stripped", "text_html", "empty"]),
  content_languages: z.null(), // Always null in v1
  charset: pdppSafeText.nullable(),
});

// Attachments stream schema: one record per attachment/inline part.
export const attachmentsSchema = z.object({
  id: pdppSafeText.min(1),
  message_id: messageIdSchema,
  filename: pdppSafeText.nullable(),
  content_type: pdppSafeText.nullable(),
  size_bytes: z.number().int().min(0).nullable(),
  content_id: pdppSafeText.nullable(),
  is_inline: z.boolean(),
  encoding: pdppSafeText.nullable(),
  part_index: partIndexSchema,
  message_received_at: isoDateTimeSchema,
  blob_ref: z.any().nullable().optional(),
  content_sha256: pdppSafeText.nullable().optional(),
  hydration_status: z.enum(["deferred", "hydrated", "failed", "too_large"]).optional(),
  hydration_error: pdppSafeText.nullable().optional(),
});

/**
 * Map stream name → schema. Single source of truth for what streams this
 * connector produces at shape-check time.
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  messages: messagesSchema,
  threads: threadsSchema,
  labels: labelsSchema,
  message_bodies: messageBodiesSchema,
  attachments: attachmentsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
