// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Slack stream records (13 manifest-declared streams,
 * 349k observed records).
 * Validation is permissive: Slack's API is well-structured, but we
 * prioritize coverage over strictness to avoid false positives.
 *
 * CRITICAL: messages.ts is a STRING-FORMATTED FLOAT (e.g. "1714032849.123456"),
 * NOT a number or ISO. Use regex: ^\d{10}\.\d{1,6}$.
 *
 * Slack ID prefixes vary widely (channels: C/D/G, users: U/W/B, files: F, etc.).
 * Use permissive regex ^[A-Z][A-Z0-9]+$ rather than strict prefix validation.
 */

import { z } from "zod";
import { pdppSafeText } from "../../src/pdpp-safe-text.ts";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Text-field classification (docs/reference/binary-content-invariant-design-brief.md §4.4):
//   - Free-form text (message text, names, titles, body content) → pdppSafeText
//   - Regex-validated structural strings (Slack IDs, timestamps) → z.string().regex(...)

// Module-scoped regexes (Biome useTopLevelRegex).
const SLACK_ID_RE = /^[A-Z][A-Z0-9]+$/;
const SLACK_TS_RE = /^\d{10}\.\d{1,6}$/; // "seconds.micros" format, not ISO
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Shared field schemas (permissive).
const slackIdSchema = z.string().regex(SLACK_ID_RE).nullable();
const slackTsSchema = z.string().regex(SLACK_TS_RE).nullable();
const isoDatetimeSchema = z.string().regex(ISO_DATETIME_RE);
const nullableIsoDatetimeSchema = isoDatetimeSchema.nullable();
const nullableBoolSchema = z.boolean().nullable();
const nonNegativeIntSchema = z.number().int().min(0);
const nullableNonNegativeIntSchema = z.number().int().min(0).nullable();

// channels stream: structural and identity fields only.
// num_members (sampled metric) moved to channel_stats stream.
export const channelsSchema = z.object({
  id: z.string().regex(SLACK_ID_RE),
  name: pdppSafeText.nullable(),
  name_normalized: z.string().nullable(),
  is_channel: nullableBoolSchema,
  is_group: nullableBoolSchema,
  is_im: nullableBoolSchema,
  is_mpim: nullableBoolSchema,
  is_private: nullableBoolSchema,
  is_shared: nullableBoolSchema,
  is_ext_shared: nullableBoolSchema,
  is_org_shared: nullableBoolSchema,
  is_archived: nullableBoolSchema,
  is_general: nullableBoolSchema,
  is_member: nullableBoolSchema,
  is_read_only: nullableBoolSchema,
  creator: z.string().nullable(),
  created: z.number().int().nullable(), // Unix epoch seconds
  created_at: isoDatetimeSchema,
  topic: z.string().nullable(),
  topic_creator: z.string().nullable(),
  topic_last_set: z.number().int().min(0).nullable(),
  purpose: z.string().nullable(),
  purpose_creator: z.string().nullable(),
  purpose_last_set: z.number().int().min(0).nullable(),
  user: z.string().nullable(),
  shared_team_ids: z.array(z.string()).nullable(),
  context_team_id: z.string().nullable(),
  previous_names: z.array(z.string()).nullable(),
  has_canvas: nullableBoolSchema,
  canvas_file_id: slackIdSchema,
  posting_restricted: nullableBoolSchema,
  threads_restricted: nullableBoolSchema,
});

// channel_stats stream: sampled metrics keyed by {channel_id}:{YYYY-MM-DD}.
// One record per channel per calendar day (UTC). Cursor: observed_on.
export const channelStatsSchema = z.object({
  id: z.string().min(3).max(300), // "{channel_id}:{YYYY-MM-DD}"
  channel_id: z.string().regex(SLACK_ID_RE),
  observed_on: z.string().regex(ISO_DATE_ONLY_RE),
  num_members: nullableNonNegativeIntSchema,
});

// users stream: 5 records in sample
export const usersSchema = z.object({
  id: z.string().regex(SLACK_ID_RE),
  team_id: slackIdSchema,
  name: pdppSafeText.nullable(),
  real_name: z.string().nullable(),
  real_name_normalized: z.string().nullable(),
  display_name: z.string().nullable(),
  display_name_normalized: z.string().nullable(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  email: z.string().nullable(), // PII field but allowed
  phone: z.string().nullable(),
  title: pdppSafeText.nullable(),
  status_text: z.string().nullable(),
  status_emoji: z.string().nullable(),
  status_expiration: z.number().int().min(0).nullable(),
  tz: z.string().nullable(),
  tz_label: z.string().nullable(),
  tz_offset: z.number().int().nullable(), // Can be negative (e.g., -25200)
  color: z.string().nullable(),
  is_bot: nullableBoolSchema,
  is_admin: nullableBoolSchema,
  is_owner: nullableBoolSchema,
  is_primary_owner: nullableBoolSchema,
  is_restricted: nullableBoolSchema,
  is_ultra_restricted: nullableBoolSchema,
  is_stranger: nullableBoolSchema,
  is_invited_user: nullableBoolSchema,
  is_app_user: nullableBoolSchema,
  deleted: nullableBoolSchema,
  has_2fa: nullableBoolSchema,
  two_factor_type: z.string().nullable(),
  image_192_url: z.string().nullable(), // URL but don't enforce format
  enterprise_id: slackIdSchema,
  updated: z.number().int().nullable(), // Unix epoch seconds
});

// messages stream: 5 records in sample, but 196k total (most populous).
// Be EXTRA permissive: ts is STRING "seconds.micros", sent_at is ISO.
export const messagesSchema = z.object({
  id: z.string().min(3), // "channel_id:ts" format
  channel_id: z.string().regex(SLACK_ID_RE),
  user_id: slackIdSchema,
  bot_id: slackIdSchema,
  team_id: slackIdSchema,
  client_msg_id: z.string().nullable(),
  ts: z.string().regex(SLACK_TS_RE), // CRITICAL: "seconds.micros", not ISO
  sent_at: isoDatetimeSchema, // Derived ISO, always present
  thread_ts: slackTsSchema,
  parent_user_id: slackIdSchema,
  is_thread_parent: z.boolean(),
  reply_count: nullableNonNegativeIntSchema,
  reply_user_ids: z.array(z.string()).nullable(),
  latest_reply: z.string().nullable(),
  subtype: z.string().nullable(), // "bot_message", "channel_join", etc. or null
  is_tombstone: z.boolean(),
  text: pdppSafeText.max(10_000_000).nullable(), // Very large messages allowed
  edited_ts: slackTsSchema,
  edited_by: slackIdSchema,
  has_files: z.boolean(),
  file_count: nullableNonNegativeIntSchema,
  has_attachments: z.boolean(),
  attachment_count: nullableNonNegativeIntSchema,
  has_blocks: z.boolean(),
  reaction_count: nonNegativeIntSchema,
  is_pinned: z.boolean(),
  pinned_to: z.array(z.string()).nullable(),
  metadata_event_type: z.string().nullable(),
});

// reactions stream: 5 records in sample
export const reactionsSchema = z.object({
  id: z.string().min(3).max(300), // Composite: "message_id:emoji:user_id"
  message_id: z.string().min(3),
  channel_id: z.string().regex(SLACK_ID_RE),
  user_id: z.string().regex(SLACK_ID_RE),
  emoji: z.string().min(1).max(200), // Can be ":custom_name:" or plain "heart"
});

// files stream: 5 records in sample
export const filesSchema = z.object({
  id: z.string().regex(SLACK_ID_RE),
  name: pdppSafeText.nullable(),
  title: pdppSafeText.nullable(),
  mimetype: z.string().nullable(),
  filetype: z.string().nullable(),
  pretty_type: z.string().nullable(),
  size: nullableNonNegativeIntSchema,
  created: z.number().int().nullable(), // Unix epoch seconds
  created_at: isoDatetimeSchema,
  uploader_id: slackIdSchema,
  is_public: nullableBoolSchema,
  is_external: nullableBoolSchema,
  is_starred: nullableBoolSchema,
  external_type: z.string().nullable(),
  mode: z.string().nullable(),
  permalink: z.string().nullable(),
  url_private: z.string().nullable(),
  original_w: nullableNonNegativeIntSchema, // Nullable for non-images
  original_h: nullableNonNegativeIntSchema,
});

// message_attachments stream: 5 records in sample
export const messageAttachmentsSchema = z.object({
  id: z.string().min(3).max(300), // Composite: "message_id:att:index"
  message_id: z.string().min(3),
  channel_id: z.string().regex(SLACK_ID_RE),
  index: nonNegativeIntSchema,
  fallback: z.string().nullable(),
  service_name: z.string().nullable(),
  service_icon: z.string().nullable(),
  title: pdppSafeText.nullable(),
  title_link: z.string().nullable(),
  text: pdppSafeText.max(10_000_000).nullable(),
  from_url: z.string().nullable(),
  image_url: z.string().nullable(),
  thumb_url: z.string().nullable(),
  author_name: z.string().nullable(),
  author_link: z.string().nullable(),
  color: z.string().nullable(),
});

// channel_memberships stream: 5 records in sample
export const channelMembershipsSchema = z.object({
  id: z.string().min(3).max(300), // Composite: "channel_id:user_id"
  channel_id: z.string().regex(SLACK_ID_RE),
  user_id: z.string().regex(SLACK_ID_RE),
  fetched_at: isoDatetimeSchema,
});

// canvases stream: 5 records in sample
export const canvasesSchema = z.object({
  id: z.string().regex(SLACK_ID_RE),
  file_id: z.string().regex(SLACK_ID_RE),
  channel_id: slackIdSchema,
  message_id: z.string().nullable(),
  title: pdppSafeText.nullable(),
  name: pdppSafeText.nullable(),
  author_id: slackIdSchema,
  is_empty: nullableBoolSchema,
  quip_thread_id: z.string().nullable(),
  content_bytes: nullableNonNegativeIntSchema,
  content_markdown: pdppSafeText.max(10_000_000).nullable(),
  mimetype: z.string().nullable(),
  filetype: z.string().nullable(),
  pretty_type: z.string().nullable(),
  created: z.number().int().nullable(),
  created_at: isoDatetimeSchema,
  updated: z.number().int().nullable(),
  updated_at: isoDatetimeSchema,
  permalink: z.string().nullable(),
  url_private: z.string().nullable(),
});

// workspace stream: 1 record in sample
export const workspaceSchema = z.object({
  id: z.string().regex(SLACK_ID_RE),
  name: pdppSafeText.nullable(),
  domain: z.string().nullable(),
  email_domain: z.string().nullable(),
  enterprise_id: slackIdSchema,
  enterprise_name: z.string().nullable(),
  url: z.string().nullable(),
  icon_url: z.string().nullable(),
  authenticated_user_id: slackIdSchema,
  authenticated_username: z.string().nullable(),
  authenticated_bot_id: slackIdSchema,
  fetched_at: isoDatetimeSchema,
});

// Layer-2 streams declared in the manifest but skipped by the current
// slackdump-backed collector until an API-layer fallback supplies data.
export const starsSchema = z.object({
  id: z.string().min(1).max(300),
  item_type: z.string().nullable(),
  target_id: z.string().nullable(),
  channel_id: z.string().nullable(),
  message_ts: z.string().nullable(),
  file_id: z.string().nullable(),
  user_id: z.string().nullable(),
  starred_at: nullableIsoDatetimeSchema,
});

export const userGroupsSchema = z.object({
  id: z.string().min(1).max(300),
  team_id: z.string().nullable(),
  handle: z.string().nullable(),
  name: pdppSafeText.nullable(),
  description: z.string().nullable(),
  is_external: nullableBoolSchema,
  is_subteam: nullableBoolSchema,
  member_ids: z.array(z.string()).nullable(),
  channel_ids: z.array(z.string()).nullable(),
  created: z.number().int().nullable(),
  created_at: nullableIsoDatetimeSchema,
  updated: z.number().int().nullable(),
  deleted: nullableBoolSchema,
});

export const remindersSchema = z.object({
  id: z.string().min(1).max(300),
  creator_id: z.string().nullable(),
  user_id: z.string().nullable(),
  text: pdppSafeText.max(10_000_000).nullable(),
  recurring: nullableBoolSchema,
  time: z.number().int().nullable(),
  scheduled_at: nullableIsoDatetimeSchema,
  complete_ts: z.number().int().nullable(),
  completed_at: nullableIsoDatetimeSchema,
});

export const dmReadStatesSchema = z.object({
  id: z.string().min(1).max(300),
  channel_id: z.string(),
  last_read: nullableIsoDatetimeSchema,
  last_read_at: nullableIsoDatetimeSchema,
  unread_count: nullableNonNegativeIntSchema,
  unread_count_display: nullableNonNegativeIntSchema,
  fetched_at: isoDatetimeSchema,
});

/**
 * Stream→schema mapping. Single source of truth for manifest-declared streams.
 * Provides type-safety and shape validation before records reach the runtime.
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  channels: channelsSchema,
  channel_stats: channelStatsSchema,
  users: usersSchema,
  messages: messagesSchema,
  reactions: reactionsSchema,
  files: filesSchema,
  message_attachments: messageAttachmentsSchema,
  channel_memberships: channelMembershipsSchema,
  canvases: canvasesSchema,
  workspace: workspaceSchema,
  stars: starsSchema,
  user_groups: userGroupsSchema,
  reminders: remindersSchema,
  dm_read_states: dmReadStatesSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
