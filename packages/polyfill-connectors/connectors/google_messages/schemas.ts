// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Google Messages (gmcli) stream records. Shape-check-before-emit
 * per docs/reference/connector-authoring-guide.md §3.
 *
 * FIELD PROVENANCE (see index.ts header for the full research trail):
 *   gmkit's actual Go source (github.com/johnlindquist/gmkit,
 *   internal/store/search.go) was fetched via
 *   raw.githubusercontent.com/johnlindquist/gmkit/main/internal/store/search.go
 *   — NOT the live CLI output (no paired device/binary available in this
 *   environment). `gmcli messages search --json` (the subcommand this
 *   connector invokes) returns the `RichHit` struct:
 *
 *     type RichHit struct {
 *       MessageID        string `json:"message_id"`
 *       ConversationID   string `json:"conversation_id"`
 *       ConversationName string `json:"conversation_name,omitempty"`
 *       SenderName       string `json:"sender_name,omitempty"`
 *       Body             string `json:"body"`
 *       Snippet          string `json:"snippet"`
 *       TimestampMS      int64  `json:"timestamp_ms"`
 *       TimestampISO     string `json:"timestamp_iso,omitempty"`
 *       IsFromMe         bool   `json:"is_from_me"`
 *     }
 *
 *   This schema mirrors that struct's fields as emitted (index.ts converts
 *   `timestamp_ms`/`timestamp_iso` to a single ISO `sent_at`, and
 *   `is_from_me` to `direction`). `conversation_name`/`sender_name` are
 *   Go `omitempty` — genuinely absent, not merely empty, on some rows — so
 *   both are nullable here. No field beyond what RichHit actually declares
 *   is claimed: no reactions, read receipts, RCS-vs-SMS transport
 *   distinction (RichHit doesn't carry `source_platform`; only the raw
 *   `Message` struct does, and this connector does not call a subcommand
 *   that returns raw `Message` rows), attachments, or group-chat
 *   participant lists.
 */

import { z } from "zod";
import { pdppSafeText } from "../../src/pdpp-safe-text.ts";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const DIRECTION_RE = /^(incoming|outgoing)$/;

const isoDateTimeSchema = z.string().regex(ISO_DT_RE, "must be an ISO-8601 datetime");

/**
 * messages stream: one record per gmcli RichHit row (`gmcli messages
 * search --json`). Cursor: sent_at (best-effort — see index.ts's "no
 * guaranteed exactly-once/gapless resume" note; gmcli's own incremental
 * semantics were not independently verified from source).
 */
export const messagesSchema = z.object({
  id: pdppSafeText.max(512),
  chat_id: pdppSafeText.max(512),
  chat_name: pdppSafeText.max(512).nullable(),
  sender_name: pdppSafeText.max(512).nullable(),
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
