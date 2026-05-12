/**
 * Zod schemas for Claude Code stream records. Used for shape-check-before-emit
 * per docs/connector-authoring-guide.md §3: records that don't match the
 * schema become SKIP_RESULT events instead of RECORD events.
 *
 * Claude Code's JSON is generally well-shaped (it's from the official CLI),
 * so most assertions are bounds and format discipline rather than cruft
 * detection.
 *
 * Text-field classification (docs/binary-content-invariant-design-brief.md §4.4):
 *   - Free-form text → pdppSafeText (via stringMaxSchema, pathSchema, and direct uses)
 *   - Regex-validated structural strings (UUIDs, timestamps) → z.string().regex(...)
 *   - content_preview uses a bespoke safeTextPreview() refine for the
 *     +1-for-ellipsis bound (equivalent invariant to pdppSafeText).
 */

import { z } from "zod";
import { pdppSafeText } from "../../src/pdpp-safe-text.ts";
import { PDPP_PREVIEW_MAX_CHARS, safeTextPreview } from "../../src/safe-text-preview.ts";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Shared field schemas.
const uuidSchema = z.string().regex(UUID_RE, "must be valid UUID");
const isoDateTimeSchema = z.string().regex(ISO_Z_RE, "must be ISO-8601 with millis and Z suffix").nullable();
const stringMaxSchema = (max: number) => pdppSafeText.max(max).nullable();
const pathSchema = pdppSafeText.max(2048).nullable();

export const sessionsSchema = z.object({
  id: uuidSchema,
  project_path: pdppSafeText,
  cwd: pathSchema,
  git_branch: stringMaxSchema(256),
  version: stringMaxSchema(64),
  started_at: isoDateTimeSchema,
  last_event_at: isoDateTimeSchema,
  message_count: z.number().int().min(0).nullable(),
  user_type: stringMaxSchema(40),
  entrypoint: stringMaxSchema(256),
});

export const messagesSchema = z.object({
  id: uuidSchema,
  session_id: uuidSchema,
  parent_uuid: uuidSchema.nullable(),
  role: stringMaxSchema(64),
  type: stringMaxSchema(64),
  content: pdppSafeText.max(10_000_000).nullable(),
  timestamp: isoDateTimeSchema,
  is_sidechain: z.boolean(),
  user_type: stringMaxSchema(40),
  agent_id: stringMaxSchema(256).nullable(),
});

// attachments.id is one of two shapes:
//   - a session-event UUID (from buildAttachmentRecord), or
//   - "tool_result_file:<projectDir>/<sessionId>/<rel>" composite
//     (from the tool-results blob path).
// Single string assertion with generous bounds; structural variants
// validate via session_id (always UUID) and event_type fields.
export const attachmentsSchema = z.object({
  id: pdppSafeText.min(1).max(2048),
  session_id: uuidSchema,
  parent_uuid: uuidSchema.nullable(),
  event_type: stringMaxSchema(64),
  hook_name: stringMaxSchema(256),
  tool_use_id: stringMaxSchema(256),
  // content_preview keeps its bespoke refine for the +1-for-ellipsis bound;
  // semantically equivalent to pdppSafeText (same safeTextPreview check).
  content_preview: z
    .string()
    .max(PDPP_PREVIEW_MAX_CHARS + 1) // +1 for ellipsis if truncated
    .refine((val) => {
      const result = safeTextPreview(val, PDPP_PREVIEW_MAX_CHARS);
      return result.kind === "text" || result.kind === "empty";
    }, "content_preview contains forbidden control characters")
    .nullable(),
  // .optional() so legacy fixtures and records emitted before the parser
  // started writing this companion field still validate.
  content_binary_reason: pdppSafeText.max(200).nullable().optional(),
  content_bytes: z.number().int().min(0).nullable(),
  timestamp: isoDateTimeSchema,
});

export const skillsSchema = z.object({
  id: pdppSafeText,
  name: stringMaxSchema(256),
  description: stringMaxSchema(2048),
  source: stringMaxSchema(64),
  path: pathSchema,
  content: pdppSafeText.max(10_000_000).nullable(),
  frontmatter: z.record(z.string(), z.unknown()).nullable(),
  mtime_epoch: z.number().nullable(),
});

export const memoryNotesSchema = z.object({
  id: pdppSafeText,
  project_path: pdppSafeText,
  note_path: pdppSafeText,
  name: stringMaxSchema(256),
  description: stringMaxSchema(2048),
  path: pathSchema,
  content: pdppSafeText.max(10_000_000).nullable(),
  frontmatter: z.record(z.string(), z.unknown()).nullable(),
  mtime_epoch: z.number().nullable(),
});

export const slashCommandsSchema = z.object({
  id: pdppSafeText,
  name: stringMaxSchema(256),
  description: stringMaxSchema(2048),
  path: pathSchema,
  content: pdppSafeText.max(10_000_000).nullable(),
  frontmatter: z.record(z.string(), z.unknown()).nullable(),
  mtime_epoch: z.number().nullable(),
});

/** Map stream name → schema. Single source of truth for what streams this
 *  connector produces at shape-check time. */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  sessions: sessionsSchema,
  messages: messagesSchema,
  attachments: attachmentsSchema,
  skills: skillsSchema,
  memory_notes: memoryNotesSchema,
  slash_commands: slashCommandsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
