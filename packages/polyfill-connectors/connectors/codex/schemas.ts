/**
 * Zod schemas for Codex stream records. Used for shape-check-before-emit
 * per docs/connector-authoring-guide.md §3: records that don't match the
 * schema become SKIP_RESULT events instead of RECORD events, so the RS
 * never receives data that looks right but isn't.
 *
 * Codex emits from local files (state_5.sqlite, rollout JSONL), so most
 * assertions are about bounds and format discipline.
 *
 * Text-field classification (docs/binary-content-invariant-design-brief.md §4.4):
 *   - Free-form human-readable text → pdppSafeText (with .max as needed)
 *   - Regex-validated structural strings (IDs, timestamps) → z.string().regex(...)
 *   - The output_preview slot uses an explicit safeTextPreview() refine
 *     for the +1-for-ellipsis bound; equivalent invariant to pdppSafeText.
 */

import { z } from "zod";
import { pdppSafeText } from "../../src/pdpp-safe-text.ts";
import { PDPP_PREVIEW_MAX_CHARS, safeTextPreview } from "../../src/safe-text-preview.ts";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
// Sessions: UUIDs or ulid format
const SESSION_ID_RE = /^[0-9a-f-]{36}$|^[0-9a-z]{26}$/;
// Messages and function_calls: either UUIDs, composites (uuid:number), or simple call IDs
const MESSAGE_ID_RE = /^([0-9a-f-]{36}|[0-9a-z]{26})(:\d+)?(:output)?$|^call_[A-Za-z0-9]{24}$/;
// Function calls have either OpenAI-style IDs, UUIDs, or composite IDs
const FUNCTION_CALL_ID_RE = /^call_[A-Za-z0-9]{24}$|^[0-9a-f-]{36}(:\d+)?(:output)?$|^[0-9a-z]{26}(:\d+)?(:output)?$/;
// ISO datetime with milliseconds and Z suffix
const ISO_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Shared field schemas
const isoDateTimeSchema = z.string().regex(ISO_Z_RE, "must be ISO-8601 with millis and Z suffix").nullable();
const nullableBoolSchema = z.boolean().nullable();
const nullableIntSchema = z.number().int().nullable();

export const sessionsSchema = z.object({
  id: z.string().regex(SESSION_ID_RE, "session id must be uuid or ulid"),
  cwd: pdppSafeText.nullable(),
  originator: pdppSafeText.nullable(),
  cli_version: pdppSafeText.nullable(),
  model_provider: pdppSafeText.nullable(),
  git_commit: pdppSafeText.nullable(),
  git_branch: pdppSafeText.nullable(),
  repository_url: pdppSafeText.nullable(),
  started_at: isoDateTimeSchema,
  last_event_at: isoDateTimeSchema,
  message_count: nullableIntSchema,
  function_call_count: nullableIntSchema,
  title: pdppSafeText.max(1_000_000).nullable(),
  archived: nullableBoolSchema,
  tokens_used: nullableIntSchema,
  first_user_message: pdppSafeText.max(1_000_000).nullable(),
  sandbox_policy: pdppSafeText.nullable(),
  approval_mode: pdppSafeText.nullable(),
  rollout_path: pdppSafeText.nullable(),
});

export const messagesSchema = z.object({
  id: z.string().regex(MESSAGE_ID_RE, "message id must be uuid or uuid:line or uuid:line:output"),
  session_id: z.string().regex(SESSION_ID_RE, "session_id must be uuid or ulid"),
  role: pdppSafeText.nullable(),
  type: pdppSafeText.nullable(),
  content: pdppSafeText.max(10_000_000).nullable(),
  timestamp: isoDateTimeSchema,
});

export const functionCallsSchema = z.object({
  id: z.string().regex(FUNCTION_CALL_ID_RE, "function_call id must be call_* or uuid or composite"),
  session_id: z.string().regex(SESSION_ID_RE, "session_id must be uuid or ulid"),
  call_id: pdppSafeText.nullable(),
  name: pdppSafeText.nullable(),
  arguments: pdppSafeText.max(10_000_000).nullable(),
  // output_preview keeps its bespoke refine for the +1-for-ellipsis bound;
  // semantically equivalent to pdppSafeText (same safeTextPreview check).
  output_preview: z
    .string()
    .max(PDPP_PREVIEW_MAX_CHARS + 1) // +1 for ellipsis if truncated
    .refine((val) => {
      const result = safeTextPreview(val, PDPP_PREVIEW_MAX_CHARS);
      return result.kind === "text" || result.kind === "empty";
    }, "output_preview contains forbidden control characters")
    .nullable(),
  // .optional() so legacy fixtures and records emitted before the parser
  // started writing this companion field still validate. New records set
  // the field to the safeTextPreview() reason string (or null when the
  // value was clean text).
  output_binary_reason: pdppSafeText.max(200).nullable().optional(),
  timestamp: isoDateTimeSchema,
});

export const rulesSchema = z.object({
  id: pdppSafeText,
  ruleset: pdppSafeText,
  rule_text: pdppSafeText.max(4000),
  rule_index: z.number().int().min(0),
  path: pdppSafeText.nullable(),
  mtime_epoch: z.number().int().nullable(),
});

export const promptsSchema = z.object({
  id: pdppSafeText,
  name: pdppSafeText,
  description: pdppSafeText.nullable(),
  content: pdppSafeText.max(10_000_000).nullable(),
  path: pdppSafeText.nullable(),
  mtime_epoch: z.number().int().nullable(),
});

export const skillsSchema = z.object({
  id: pdppSafeText,
  name: pdppSafeText,
  description: pdppSafeText.nullable(),
  content: pdppSafeText.max(10_000_000).nullable(),
  path: pdppSafeText.nullable(),
  mtime_epoch: z.number().int().nullable(),
});

/** Map stream name → schema. Single source of truth for what streams this
 *  connector produces at shape-check time. */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  sessions: sessionsSchema,
  messages: messagesSchema,
  function_calls: functionCallsSchema,
  rules: rulesSchema,
  prompts: promptsSchema,
  skills: skillsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
