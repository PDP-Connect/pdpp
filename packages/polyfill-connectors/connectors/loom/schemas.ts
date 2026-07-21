// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Loom stream records. Shape-check-before-emit per
 * docs/reference/connector-authoring-guide.md §3.
 *
 * Ground-truth caveat: loom/index.ts does not yet emit any RECORD — the
 * Apollo-cache extraction and transcript-endpoint wiring are deferred to a
 * live session (the connector emits SKIP_RESULT reason=loom_apollo_wiring_pending).
 * There is therefore no observed emitted shape to mirror; these schemas are
 * derived from the connector's MANIFEST stream declarations
 * (manifests/loom.json) — the contract the connector commits to emit once
 * extraction lands.
 *
 * This is the honest wiring: `validateRecord` is attached now so the first
 * real emit is shape-checked against the declared contract rather than
 * silently trusted. Whoever wires the Apollo extraction MUST re-verify these
 * field shapes against the actual extracted payload (especially id format,
 * which the manifest leaves as an opaque string) and tighten them — this
 * file is a contract scaffold, not a fixture-proven schema.
 *
 *   videos:      { id, title, description, duration_seconds, view_count,
 *                  created_at, share_url, has_transcript }
 *   transcripts: { id, video_id, text }
 */

import { z } from "zod";
import { pdppSafeText } from "../../src/pdpp-safe-text.ts";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regex (Biome useTopLevelRegex).
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

const nonNegativeIntSchema = z.number().int().min(0).nullable();

/**
 * videos stream: one record per recorded Loom video.
 * Cursor: created_at. `id` is the Loom video id (opaque string in the
 * manifest); tighten to its real shape when extraction lands.
 */
export const videosSchema = z.object({
  id: z.string().min(1).max(128),
  title: pdppSafeText.max(1000).nullable(),
  description: pdppSafeText.max(65_000).nullable(),
  duration_seconds: nonNegativeIntSchema,
  view_count: nonNegativeIntSchema,
  created_at: z.string().regex(ISO_DT_RE, "created_at must be an ISO-8601 datetime").nullable(),
  share_url: z.url().max(4096).nullable(),
  has_transcript: z.boolean().nullable(),
});

/**
 * transcripts stream: one record per video transcript.
 * `text` is the full transcript body → pdppSafeText (large allowed).
 */
export const transcriptsSchema = z.object({
  id: z.string().min(1).max(160),
  video_id: z.string().min(1).max(128),
  text: pdppSafeText.max(10_000_000).nullable(),
});

/**
 * Stream → schema registry. Single source of truth for the streams this
 * connector declares (and will emit once extraction is wired).
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  videos: videosSchema,
  transcripts: transcriptsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
