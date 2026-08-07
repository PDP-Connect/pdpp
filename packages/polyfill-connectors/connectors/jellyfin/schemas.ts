// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Jellyfin stream records. Used for shape-check-before-emit
 * per docs/reference/connector-authoring-guide.md §3: records that don't match the
 * schema become SKIP_RESULT events instead of RECORD events.
 *
 * Jellyfin v10.11.11+ REST API shapes: User can query libraries (Views) and items
 * within libraries, with playback metadata (LastPlayedDate, PlayCount, Played boolean).
 * No session-level history in core API; PlaybackReporting plugin optional for history.
 */

import { z } from "zod";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// ISO datetime (YYYY-MM-DDTHH:MM:SS or with fractional seconds)
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})?$/;

/**
 * Jellyfin libraries (Views) — root containers (Movies, TV Shows, Music, etc.).
 * Note: fetched_at is a collection-time field added by the connector, not from Jellyfin API.
 */
export const librariesSchema = z.object({
  id: z.string(),
  name: z.string(),
  collection_type: z.string().nullable(),
  fetched_at: z.string().regex(ISO_DATETIME_RE, "fetched_at must be ISO-8601 datetime"),
});

/**
 * Jellyfin items — media files (movies, TV episodes, songs, etc.) with playback metadata.
 *
 * last_played_date can be null (never played).
 * play_count is an integer aggregate (0 if never played).
 * played is a boolean reflecting playback state.
 * image_url is optional for cover art; constructed from Jellyfin image endpoints.
 * provider_ids are external identifiers (IMDb, TVDB, TMDB) from Jellyfin's ProviderIds.
 */
export const itemsSchema = z.object({
  id: z.string(),
  library_id: z.string(),
  name: z.string(),
  type: z.string().nullable(),
  played: z.boolean(),
  play_count: z.number().int().nonnegative("play_count must be non-negative integer"),
  last_played_date: z.string().regex(ISO_DATETIME_RE, "last_played_date must be ISO-8601 datetime").nullable(),
  image_url: z.string().nullable(),
  genres: z.array(z.string()),
  release_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "release_date must be ISO-8601 date")
    .nullable(),
  provider_ids: z.record(z.string(), z.string()).nullable(),
  production_year: z.number().int().nullable(),
});

// PDPP record validators (main export)
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  libraries: librariesSchema,
  items: itemsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

// ─── Internal API Schema Validators (for unparsed API responses) ────────

export const JellyfinSystemInfoSchema = z.object({
  Id: z.string(),
  ServerName: z.string(),
  Version: z.string(),
});

export type JellyfinSystemInfo = z.infer<typeof JellyfinSystemInfoSchema>;

export const JellyfinViewSchema = z.object({
  Id: z.string(),
  Name: z.string(),
  CollectionType: z.string().nullable().optional(),
  PrimaryImageTag: z.string().nullable().optional(),
});

export const JellyfinItemSchema = z.object({
  Id: z.string(),
  Name: z.string(),
  Type: z.string().nullable().optional(),
  UserData: z
    .object({
      PlayCount: z.number().int().optional(),
      Played: z.boolean().optional(),
      LastPlayedDate: z.string().datetime().nullable().optional(),
    })
    .nullable()
    .optional(),
  Genres: z.array(z.string()).optional(),
  PremiereDate: z.string().optional(),
  PrimaryImageTag: z.string().nullable().optional(),
  ProviderIds: z.record(z.string(), z.any()).optional(),
  ProductionYear: z.number().int().nullable().optional(),
});

export const JellyfinViewsResponseSchema = z.object({
  Items: z.array(JellyfinViewSchema).optional(),
});

export const JellyfinItemsResponseSchema = z.object({
  Items: z.array(JellyfinItemSchema).optional(),
  TotalRecordCount: z.number().int().optional(),
});

// Validators for API responses (used internally)
export function validateSystemInfo(data: unknown): JellyfinSystemInfo {
  return JellyfinSystemInfoSchema.parse(data);
}

export function validateViewsResponse(data: unknown) {
  return JellyfinViewsResponseSchema.parse(data);
}

export function validateItemsResponse(data: unknown) {
  return JellyfinItemsResponseSchema.parse(data);
}
