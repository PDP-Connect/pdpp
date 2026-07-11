/**
 * Zod schemas for Instagram (Meta) stream records. Shape-check-before-emit per
 * docs/reference/connector-authoring-guide.md §3.
 *
 * GROUND-TRUTH CAVEAT (same posture as connectors/loom and connectors/shopify):
 * meta/index.ts does NOT yet emit any RECORD — it is a browser scaffold that
 * verifies session reachability and emits
 * `SKIP_RESULT reason=instagram_graphql_wiring_pending`. The Polaris GraphQL
 * extraction (operation names rotate) is deferred to a live session. There is
 * no observed emitted shape; these schemas are derived from the connector's
 * MANIFEST stream declarations (manifests/meta.json) — the contract the
 * connector commits to emit once extraction lands.
 *
 * Wiring `validateRecord` now is the honest, fail-fast move: the first real
 * emit is shape-checked against the declared contract instead of silently
 * trusted. Whoever wires the GraphQL extraction MUST re-verify these field
 * shapes against the real Polaris payload and tighten them — especially the
 * `id` format (Instagram media/user ids are numeric strings in practice) and
 * `media_type` (likely a fixed enum: IMAGE / VIDEO / CAROUSEL_ALBUM). This file
 * is a contract scaffold, not a fixture-proven schema.
 */

import { z } from "zod";
import { pdppSafeText } from "../../src/pdpp-safe-text.ts";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/**
 * profile stream (manifest required: id, username). One record — the user's own
 * profile. `username` is the handle (a short structural token, not prose);
 * `full_name` / `bio` are free-form human text; counts are non-negative ints;
 * `is_verified` is a tri-state boolean (nullable).
 */
export const profileSchema = z.object({
  id: z.string().min(1).max(200),
  username: z.string().min(1).max(200),
  full_name: pdppSafeText.max(500).nullable(),
  bio: pdppSafeText.max(4000).nullable(),
  follower_count: z.number().int().min(0).nullable(),
  following_count: z.number().int().min(0).nullable(),
  post_count: z.number().int().min(0).nullable(),
  is_verified: z.boolean().nullable(),
});

/**
 * posts stream (manifest required: id). One record per post on the user's
 * timeline. `caption` is free-form human text; `media_type` is a short
 * structural label (the manifest does not fix the enum, so it is a bounded
 * string — whoever wires extraction should pin it to IMAGE/VIDEO/CAROUSEL_ALBUM
 * once the real values are confirmed); counts are non-negative ints;
 * `location_name` is free-form; `taken_at` is an ISO datetime.
 */
export const postsSchema = z.object({
  id: z.string().min(1).max(200),
  caption: pdppSafeText.max(100_000).nullable(),
  media_type: z.string().min(1).max(64).nullable(),
  like_count: z.number().int().min(0).nullable(),
  comment_count: z.number().int().min(0).nullable(),
  location_name: pdppSafeText.max(500).nullable(),
  taken_at: z.string().regex(ISO_DT_RE, "taken_at must be an ISO-8601 datetime").nullable(),
});

/**
 * Stream → schema registry. Single source of truth for the streams this
 * connector declares (and will emit once extraction is wired).
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  profile: profileSchema,
  posts: postsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
