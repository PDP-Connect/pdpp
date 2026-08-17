// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Google Messages (gmcli) stream records. Shape-check-before-emit
 * per docs/reference/connector-authoring-guide.md §3.
 *
 * FIELD PROVENANCE (see index.ts header for the full research trail):
 *   gmkit's actual Go source (github.com/johnlindquist/gmkit,
 *   internal/store/messages.go + conversations.go) was fetched via
 *   raw.githubusercontent.com/johnlindquist/gmkit/main/internal/store/*.go
 *   — NOT the live CLI output (no paired device/binary available in this
 *   environment). `gmcli messages list --conv <id> --json --full` (the
 *   subcommand this connector invokes per conversation, NOT `messages
 *   search`, which requires a query term and returns a different struct
 *   meant for keyword search) returns the `Message` struct:
 *
 *     type Message struct {
 *       ID             string  `json:"message_id"`
 *       ConversationID string  `json:"conversation_id"`
 *       SourcePlatform string  `json:"source_platform"`
 *       SenderID       string  `json:"sender_id"`
 *       Body           *string `json:"body,omitempty"`
 *       TimestampMS    int64   `json:"timestamp_ms"`
 *       Status         int64   `json:"status"`
 *       IsFromMe       bool    `json:"is_from_me"`
 *       MediaID        *string `json:"media_id,omitempty"`
 *       MimeType       *string `json:"mime_type,omitempty"`
 *       ReactionsJSON  *string `json:"reactions_json,omitempty"`
 *       ReplyToID      *string `json:"reply_to_id,omitempty"`
 *       // DecryptionKey, RawProto are json:"-" — never serialized
 *     }
 *
 *   And `gmcli --json --full chats list` returns `Conversation` (only
 *   `conversation_id`/`name` are used here — Conversation has no top-level
 *   `display_name`):
 *
 *     type Conversation struct {
 *       ID                string    `json:"conversation_id"`
 *       SourcePlatform    string    `json:"source_platform"`
 *       Name              string    `json:"name"`
 *       ...
 *     }
 *
 *   This schema mirrors Message's fields as emitted (index.ts converts
 *   `timestamp_ms` to ISO `sent_at`, `is_from_me` to `direction`, and folds
 *   in the enumerating chat's `name` as `chat_name`). `body`/`media_id`/
 *   `mime_type`/`reactions_json`/`reply_to_id` are Go `*string`
 *   (pointer, `omitempty`) — genuinely absent, not merely empty, on some
 *   rows. This connector emits ONLY id, chat_id, chat_name, sender_id,
 *   body, sent_at, direction — no reactions, media, reply-threading, or
 *   RCS-vs-SMS transport distinction (`source_platform` exists on the
 *   struct but is not surfaced as a typed field; no claim about its
 *   meaning/values was independently verified).
 */

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const DIRECTION_RE = /^(incoming|outgoing)$/;

const isoDateTimeSchema = z.string().regex(ISO_DT_RE, "must be an ISO-8601 datetime");

/**
 * messages stream: one record per gmcli Message row (`gmcli messages list
 * --conv <id> --json --full`, bounded by GMCLI_MESSAGES_PER_CHAT_LIMIT
 * per conversation). Cursor: a connector-side per-message-id content
 * fingerprint (index.ts's STATE section) — best-effort de-duplication, not
 * a gmcli-side incremental cursor; gmcli exposes no "since" pagination
 * token, so every run re-fetches the same bounded window per conversation
 * and the fingerprint gate is what stops that from re-emitting duplicates.
 */
export const messagesSchema = z.object({
  id: pdppSafeText.max(512),
  chat_id: pdppSafeText.max(512),
  chat_name: pdppSafeText.max(512).nullable(),
  sender_id: pdppSafeText.max(512).nullable(),
  body: pdppSafeText.max(200_000),
  sent_at: isoDateTimeSchema,
  direction: z.string().regex(DIRECTION_RE),
});

const coverageStatusSchema = z.enum(["collected", "inventory_only", "excluded", "deferred", "missing", "unsupported"]);

/**
 * coverage_diagnostics stream: one row per known local store (currently just
 * "gmcli_archive") reporting whether gmcli is installed/paired/readable.
 * Shared shape with apple_photos/claude_code/codex's coverage_diagnostics —
 * see src/local-source-inventory.ts's CoverageRecord.
 */
export const coverageDiagnosticsSchema = z.object({
  id: pdppSafeText,
  store: pdppSafeText,
  stream: pdppSafeText.nullable(),
  status: coverageStatusSchema,
  reason: pdppSafeText.max(512),
});

/**
 * Stream → schema registry. Single source of truth for emitted streams.
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  messages: messagesSchema,
  coverage_diagnostics: coverageDiagnosticsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
