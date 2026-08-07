// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { makeValidateRecord } from "../../src/schema-registry.ts";

const AttachmentSchema = z.object({
  type: z.enum(["image", "file", "location", "emoji"]),
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
