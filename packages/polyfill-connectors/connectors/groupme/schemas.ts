// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { makeValidateRecord } from "../../src/schema-registry.ts";

/**
 * Attachment types GroupMe actually sends, widened from real captured runs.
 *
 * The original four (image/file/location/emoji) were transcribed from GroupMe's
 * published docs, and the docs undercount what the API emits: a measured corpus
 * carried ten distinct values, and the six undocumented ones — led by `mentions`
 * and `event` — accounted for far more attachments than the documented ones. The
 * mismatch runs both ways: `file` and `location` are documented but appeared
 * zero times, so this list is ordered by observed frequency with the two
 * never-observed-but-documented members kept at the end.
 *
 * Widening here is the precise fix; the runtime's tolerance for unmodeled enum
 * values (see makeValidateRecord in src/schema-registry.ts) is the general one,
 * and covers the eleventh type GroupMe ships after this comment is written.
 */
const AttachmentSchema = z.object({
  type: z.enum([
    "mentions",
    "event",
    "reply",
    "image",
    "linked_image",
    "video",
    "emoji",
    "poll",
    "autokicked_member",
    "postprocessing",
    "file",
    "location",
  ]),
  url: z.string().nullable(),
  blob_id: z.string().nullable().optional(),
  name: z.string().nullable(),
  lat: z.number().nullable().optional(),
  lng: z.number().nullable().optional(),
});

export const GroupSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  avatar_url: z.string().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  member_count: z.number().nullable(),
  messages_count: z.number().nullable(),
});

export const GroupMessageSchema = z.object({
  id: z.string(),
  group_id: z.string(),
  user_id: z.string().nullable(),
  name: z.string().nullable(),
  text: z.string().nullable(),
  avatar_url: z.string().nullable(),
  created_at: z.string().datetime(),
  attachments: z.array(AttachmentSchema),
  like_count: z.number().nullable(),
  system: z.boolean().nullable(),
});

export const DirectChatSchema = z.object({
  id: z.string(),
  other_user_id: z.string().nullable(),
  other_user_name: z.string().nullable(),
  avatar_url: z.string().nullable(),
  last_message: z.string().nullable(),
  last_message_at: z.string().datetime(),
});

export const DirectChatMessageSchema = z.object({
  id: z.string(),
  chat_id: z.string(),
  user_id: z.string().nullable(),
  name: z.string().nullable(),
  text: z.string().nullable(),
  avatar_url: z.string().nullable(),
  created_at: z.string().datetime(),
  attachments: z.array(AttachmentSchema),
});

export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  groups: GroupSchema,
  group_messages: GroupMessageSchema,
  direct_messages: DirectChatSchema,
  direct_chat_messages: DirectChatMessageSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
