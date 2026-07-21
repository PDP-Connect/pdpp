/**
 * Zod schemas for Anthropic/Claude stream records. Shape-check-before-emit per
 * docs/reference/connector-authoring-guide.md §3.
 *
 * GROUND-TRUTH CAVEAT (same posture as connectors/loom/schemas.ts):
 * anthropic/index.ts does NOT yet emit any RECORD — it is a browser scaffold
 * that verifies session reachability and emits
 * `SKIP_RESULT reason=claude_api_wiring_pending`. The org-UUID discovery and
 * conversation/message endpoint wiring are deferred to a live session. There is
 * therefore no observed emitted shape to mirror; these schemas are derived from
 * the connector's MANIFEST stream declarations (manifests/anthropic.json) — the
 * contract the connector commits to emit once the Claude API extraction lands.
 *
 * Wiring `validateRecord` now is the honest move: the first real emit is
 * shape-checked against the declared contract instead of silently trusted.
 * Whoever wires the chat_conversations / tree endpoints MUST re-verify these
 * field shapes against the real payload and tighten them — in particular the id
 * formats (Claude ids are expected to be UUIDs, but the manifest leaves them as
 * opaque strings, so they are bounded opaque strings here, not UUID-regex'd).
 * This file is a contract scaffold, not a fixture-proven schema.
 */

import { z } from "zod";
import { pdppSafeText } from "../../src/pdpp-safe-text.ts";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regex (Biome useTopLevelRegex). Manifest declares date-time
// format; accept an ISO-8601 datetime prefix.
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

// Opaque bounded id — tighten to UUID when the real payload is observed.
const idSchema = z.string().min(1).max(128);
const isoDateTimeNullable = z.string().regex(ISO_DT_RE, "must be an ISO-8601 datetime").nullable();

/**
 * conversations stream (manifest required: id). mutable_state, cursor
 * update_time.
 */
export const conversationsSchema = z.object({
  id: idSchema,
  title: pdppSafeText.max(4000).nullable(),
  create_time: isoDateTimeNullable,
  update_time: isoDateTimeNullable,
  project_id: idSchema.nullable(),
  model: z.string().min(1).max(128).nullable(),
  message_count: z.number().int().min(0).nullable(),
});

/**
 * messages stream (manifest required: id, conversation_id). append_only,
 * cursor create_time. `content` is the full message body → pdppSafeText.
 */
export const messagesSchema = z.object({
  id: idSchema,
  conversation_id: idSchema,
  role: z.string().min(1).max(64).nullable(),
  content: pdppSafeText.max(10_000_000).nullable(),
  model: z.string().min(1).max(128).nullable(),
  create_time: isoDateTimeNullable,
});

/**
 * projects stream (manifest required: id, name). mutable_state, cursor
 * update_time.
 */
export const projectsSchema = z.object({
  id: idSchema,
  name: pdppSafeText.max(2000),
  description: pdppSafeText.max(65_000).nullable(),
  create_time: isoDateTimeNullable,
  update_time: isoDateTimeNullable,
});

/**
 * Stream → schema registry. Single source of truth for the streams this
 * connector declares (and will emit once the Claude API extraction is wired).
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  conversations: conversationsSchema,
  messages: messagesSchema,
  projects: projectsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
