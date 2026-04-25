/**
 * Zod schemas for Codex stream records. Used for shape-check-before-emit
 * per docs/connector-authoring-guide.md §3: records that don't match the
 * schema become SKIP_RESULT events instead of RECORD events, so the RS
 * never receives data that looks right but isn't.
 *
 * Codex emits from local files (state_5.sqlite, rollout JSONL), so most
 * assertions are about bounds and format discipline.
 */

import { z } from "zod";
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
  cwd: z.string().nullable(),
  originator: z.string().nullable(),
  cli_version: z.string().nullable(),
  model_provider: z.string().nullable(),
  git_commit: z.string().nullable(),
  git_branch: z.string().nullable(),
  repository_url: z.string().nullable(),
  started_at: isoDateTimeSchema,
  last_event_at: isoDateTimeSchema,
  message_count: nullableIntSchema,
  function_call_count: nullableIntSchema,
  title: z.string().max(1_000_000).nullable(),
  archived: nullableBoolSchema,
  tokens_used: nullableIntSchema,
  first_user_message: z.string().max(1_000_000).nullable(),
  sandbox_policy: z.string().nullable(),
  approval_mode: z.string().nullable(),
  rollout_path: z.string().nullable(),
});

export const messagesSchema = z.object({
  id: z.string().regex(MESSAGE_ID_RE, "message id must be uuid or uuid:line or uuid:line:output"),
  session_id: z.string().regex(SESSION_ID_RE, "session_id must be uuid or ulid"),
  role: z.string().nullable(),
  type: z.string().nullable(),
  content: z.string().max(10_000_000).nullable(),
  timestamp: isoDateTimeSchema,
});

export const functionCallsSchema = z.object({
  id: z.string().regex(FUNCTION_CALL_ID_RE, "function_call id must be call_* or uuid or composite"),
  session_id: z.string().regex(SESSION_ID_RE, "session_id must be uuid or ulid"),
  call_id: z.string().nullable(),
  name: z.string().nullable(),
  arguments: z.string().max(10_000_000).nullable(),
  output_preview: z.string().max(10_000_000).nullable(),
  timestamp: isoDateTimeSchema,
});

export const rulesSchema = z.object({
  id: z.string(),
  ruleset: z.string(),
  rule_text: z.string().max(4000),
  rule_index: z.number().int().min(0),
  path: z.string().nullable(),
  mtime_epoch: z.number().int().nullable(),
});

export const promptsSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  content: z.string().max(10_000_000).nullable(),
  path: z.string().nullable(),
  mtime_epoch: z.number().int().nullable(),
});

export const skillsSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  content: z.string().max(10_000_000).nullable(),
  path: z.string().nullable(),
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
