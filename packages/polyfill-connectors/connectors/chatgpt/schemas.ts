/**
 * Zod schemas for ChatGPT stream records. Used for shape-check-before-emit
 * per docs/connector-authoring-guide.md §3: records that fail the schema
 * become SKIP_RESULT events instead of RECORD events, so the RS never
 * receives data that looks right but isn't.
 *
 * ChatGPT's connector fetches JSON from OpenAI's internal API via an
 * authenticated browser. The shapes below defend against:
 *   - upstream API surface drift (new fields or renamed fields that
 *     our extraction misreads)
 *   - silent type coercion (timestamps becoming numbers, IDs becoming ints)
 *   - accidentally captured UI strings (should never happen since we
 *     never DOM-extract, but defense in depth)
 *
 * UUIDs in ChatGPT are lowercase hex with dashes (standard v4 shape)
 * but the API also uses opaque IDs for some things (memories, messages).
 * Keep ID schemas permissive.
 */

import { z } from "zod";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Permissive ID: non-empty, bounded, no whitespace or control chars.
const idSchema = z.string().min(1).max(128).regex(/^\S+$/, "must not contain whitespace");

// ISO-8601 timestamp — not all ChatGPT API responses use strict ISO, so
// be lenient: accept anything parseable by Date as long as it looks
// timestamp-ish (has digits and either T or -).
const looseTimestamp = z
  .string()
  .min(4)
  .max(40)
  .refine((s) => !Number.isNaN(new Date(s).getTime()), {
    message: "unparseable timestamp",
  });

// Large text fields (messages content, memories content, GPT instructions).
// Bound to 1 MB — anything larger is suspicious.
const largeText = z.string().max(1_048_576);

// ─── conversations ──────────────────────────────────────────────────────

export const conversationSchema = z.object({
  id: idSchema,
  title: z.string().max(500).nullable(),
  create_time: looseTimestamp.nullable(),
  update_time: looseTimestamp.nullable(),
  is_archived: z.boolean().nullable(),
  is_starred: z.boolean().nullable(),
  workspace_id: idSchema.nullable(),
  current_node: idSchema.nullable(),
  message_count_on_current_branch: z.number().int().min(0).max(100_000).nullable(),
  gizmo_id: idSchema.nullable(),
});

// ─── messages ───────────────────────────────────────────────────────────

export const messageSchema = z.object({
  id: idSchema,
  conversation_id: idSchema,
  parent_id: idSchema.nullable(),
  children_ids: z.array(idSchema),
  // role can be user / assistant / system / tool / etc.
  role: z.string().max(40).nullable(),
  content: largeText.nullable(),
  // content_type is like "text" / "code" / "multimodal_text" / etc.
  content_type: z.string().max(60).nullable(),
  model_slug: z.string().max(80).nullable(),
  create_time: looseTimestamp.nullable(),
  finish_reason: z.string().max(60).nullable(),
  citations: z.array(z.unknown()),
  tool_calls: z.array(z.unknown()),
  attachment_ids: z.array(idSchema),
  on_current_branch: z.boolean(),
});

// ─── memories ───────────────────────────────────────────────────────────

export const memorySchema = z.object({
  id: idSchema,
  content: largeText,
  created_at: looseTimestamp.nullable(),
  updated_at: looseTimestamp.nullable(),
});

// ─── custom_gpts ────────────────────────────────────────────────────────

export const customGptSchema = z.object({
  id: idSchema,
  short_url: z.string().max(200).nullable(),
  display_name: z.string().max(200).nullable(),
  display_description: z.string().max(2000).nullable(),
  display_welcome_message: z.string().max(2000).nullable(),
  instructions: largeText.nullable(),
  tools: z.array(z.unknown()),
  created_at: looseTimestamp.nullable(),
  updated_at: looseTimestamp.nullable(),
  author_id: idSchema.nullable(),
  author_name: z.string().max(200).nullable(),
  is_public: z.boolean().nullable(),
  category: z.string().max(80).nullable(),
  tags: z.array(z.string().max(100)),
});

// ─── custom_instructions ────────────────────────────────────────────────

export const customInstructionsSchema = z.object({
  id: idSchema,
  about_user: largeText.nullable(),
  response_style: largeText.nullable(),
  enabled: z.boolean().nullable(),
  updated_at: looseTimestamp.nullable(),
});

// ─── shared_conversations ───────────────────────────────────────────────

export const sharedConversationSchema = z.object({
  id: idSchema,
  conversation_id: idSchema.nullable(),
  share_url: z.string().max(400).nullable(),
  title: z.string().max(500).nullable(),
  created_at: looseTimestamp.nullable(),
  anonymous: z.boolean().nullable(),
  is_public: z.boolean().nullable(),
  highlighted_text: largeText.nullable(),
});

// ─── Registry ───────────────────────────────────────────────────────────

export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  conversations: conversationSchema,
  messages: messageSchema,
  memories: memorySchema,
  custom_gpts: customGptSchema,
  custom_instructions: customInstructionsSchema,
  shared_conversations: sharedConversationSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
