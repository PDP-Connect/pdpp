// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Venmo stream records. Used for shape-check-before-emit
 * per docs/connector-authoring-guide.md §3: records that don't match the
 * schema become SKIP_RESULT events instead of RECORD events.
 *
 * Field shapes are sourced from the unofficial API client
 * github.com/mmohades/Venmo (`venmo_api/models/*.py`, MIT, fetched
 * 2026-08-09) — the ground truth for what `api.venmo.com/v1` actually
 * returns, since Venmo publishes no schema of its own. Amounts are USD in
 * integer cents (Venmo's own API returns a float major-unit `amount`; this
 * connector converts once at parse time, never carries a float through).
 */

import { z } from "zod";
import { nullablePdppSafeText } from "../../src/pdpp-safe-text.ts";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
// Venmo user/story/payment ids are decimal numeric strings of varying
// length (observed 18-19 digits for user ids; story/payment ids similar).
// Treated as opaque numeric-string ids rather than a fixed-width pattern,
// since no documented source pins the exact width and a too-tight regex
// would reject legitimate ids the first time Venmo's id space grows.
const NUMERIC_ID_RE = /^\d+$/;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export const profileSchema = z.object({
  id: z.string().regex(NUMERIC_ID_RE, "id must be a numeric string"),
  username: z.string().nullable(),
  first_name: nullablePdppSafeText,
  last_name: nullablePdppSafeText,
  display_name: nullablePdppSafeText,
  phone: z.string().nullable(),
  profile_picture_url: z.string().url().nullable(),
  about: nullablePdppSafeText,
  date_joined: z.string().regex(ISO_DATETIME_RE, "date_joined must be ISO-8601 datetime").nullable(),
  is_business: z.boolean().nullable(),
});

export const friendsSchema = z.object({
  id: z.string().regex(NUMERIC_ID_RE, "id must be a numeric string"),
  username: z.string().nullable(),
  first_name: nullablePdppSafeText,
  last_name: nullablePdppSafeText,
  display_name: nullablePdppSafeText,
  phone: z.string().nullable(),
  profile_picture_url: z.string().url().nullable(),
  about: nullablePdppSafeText,
  date_joined: z.string().regex(ISO_DATETIME_RE, "date_joined must be ISO-8601 datetime").nullable(),
  is_group: z.boolean().nullable(),
  is_active: z.boolean().nullable(),
});

const transactionCounterpartySchema = z
  .object({
    id: z.string().regex(NUMERIC_ID_RE, "id must be a numeric string"),
    username: z.string().nullable(),
    display_name: nullablePdppSafeText,
  })
  .nullable();

export const transactionsSchema = z.object({
  id: z.string().regex(NUMERIC_ID_RE, "id must be a numeric story id"),
  payment_id: z.string().regex(NUMERIC_ID_RE, "payment_id must be a numeric string").nullable(),
  date_created: z.string().regex(ISO_DATETIME_RE, "date_created must be ISO-8601 datetime"),
  date_updated: z.string().regex(ISO_DATETIME_RE, "date_updated must be ISO-8601 datetime").nullable(),
  date_completed: z.string().regex(ISO_DATETIME_RE, "date_completed must be ISO-8601 datetime").nullable(),
  // Venmo's own vocabulary: "pay" (sent) or "charge" (requested). Open
  // vocabulary — see makeValidateRecord's enum-drift retention policy.
  payment_type: z.enum(["pay", "charge"]),
  amount_cents: z.number().int(),
  audience: z.enum(["private", "friends", "public"]).nullable(),
  status: z.enum(["settled", "cancelled", "pending", "failed", "expired"]).nullable(),
  note: nullablePdppSafeText,
  device_used: z.string().nullable(),
  actor: transactionCounterpartySchema,
  target: transactionCounterpartySchema,
  // true when the authenticated owner is the actor (sender/requester) rather
  // than the target — lets an owner-view UI show "you paid X" vs "X paid you"
  // without re-deriving it from actor.id === profile.id at query time.
  is_owner_actor: z.boolean(),
});

export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  profile: profileSchema,
  friends: friendsSchema,
  transactions: transactionsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
