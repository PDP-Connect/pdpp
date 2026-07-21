/**
 * Zod schemas for Spotify stream records. Shape-check-before-emit per
 * docs/reference/connector-authoring-guide.md §3.
 *
 * Ground truth: the four `emitRecord(...)` object literals in index.ts
 * (collectPlaylists, collectSavedTracks, collectTopArtists,
 * collectRecentlyPlayed). Schemas mirror the *emitted* shape:
 *
 *   - Spotify resource ids are base-62 strings (22 chars in practice, but the
 *     schema bounds them rather than fixing the length). `id`, `owner_id`,
 *     `track_id` follow SPOTIFY_ID_RE.
 *   - `name` / `track_name` / `album_name` / `description` and each element of
 *     `artist_names` are free-form human text → `pdppSafeText`.
 *   - Several id/name fields are read off optional source interface members
 *     (`p.name`, `t.id`, `a.id`, ...). When the API omits them the builder
 *     assigns `undefined`, which JSON drops. The schema marks those fields
 *     `.optional()` (in addition to `.nullable()` where the builder uses `??
 *     null`) so a legitimately-absent value validates, while a present value of
 *     the wrong shape is still rejected.
 *   - `added_at` / `played_at` are ISO-8601 datetimes (required cursor inputs).
 *   - `isrc` is the 12-char ISRC code or null.
 *   - `time_range` (top_artists) is one of Spotify's three fixed windows.
 *   - recently_played `id` is the composite `"<trackId>:<playedAtMs>"` the
 *     builder constructs — validated by RECENTLY_PLAYED_ID_RE.
 */

import { z } from "zod";
import { pdppSafeText } from "../../src/pdpp-safe-text.ts";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const SPOTIFY_ID_RE = /^[0-9A-Za-z]{1,40}$/; // base-62 resource id
const ISRC_RE = /^[A-Za-z]{2}[0-9A-Za-z]{3}\d{7}$/; // ISO 3901 ISRC
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
// recently_played id is `${track.id}:${playedAtMs}` — base-62 id, colon, epoch ms.
const RECENTLY_PLAYED_ID_RE = /^[0-9A-Za-z]{1,40}:\d{1,20}$/;

const spotifyIdSchema = z.string().regex(SPOTIFY_ID_RE, "must be a Spotify base-62 id");
// `name` etc. are read from optional interface fields; absent → undefined (JSON
// drops the key). Allow optional alongside the free-text brand.
const nameSchema = pdppSafeText.max(1000).optional();
const artistNamesSchema = z.array(pdppSafeText.max(1000));
const isoDateTimeSchema = z.string().regex(ISO_DT_RE, "must be an ISO-8601 datetime");

/**
 * playlists stream: one record per playlist the user owns/follows.
 * No incremental cursor (full list each run).
 */
export const playlistsSchema = z.object({
  id: spotifyIdSchema,
  name: nameSchema,
  owner_id: spotifyIdSchema.nullable(),
  owner_name: pdppSafeText.max(1000).nullable(),
  public: z.boolean().nullable(),
  collaborative: z.boolean().nullable(),
  track_count: z.number().int().min(0).nullable(),
  snapshot_id: z.string().min(1).max(200).nullable(),
  description: pdppSafeText.max(4000).nullable(),
});

/**
 * saved_tracks stream: one record per "liked" track.
 * Cursor: added_at.
 */
export const savedTracksSchema = z.object({
  id: spotifyIdSchema.optional(),
  name: nameSchema,
  artist_names: artistNamesSchema,
  album_name: pdppSafeText.max(1000).nullable(),
  duration_ms: z.number().int().min(0).nullable(),
  popularity: z.number().int().min(0).max(100).nullable(),
  added_at: isoDateTimeSchema,
  isrc: z.string().regex(ISRC_RE, "isrc must be a 12-char ISRC code").nullable(),
});

/**
 * top_artists stream: one record per top artist, per time window.
 */
export const topArtistsSchema = z.object({
  id: spotifyIdSchema.optional(),
  name: nameSchema,
  genres: z.array(pdppSafeText.max(200)),
  popularity: z.number().int().min(0).max(100).nullable(),
  followers: z.number().int().min(0).nullable(),
  time_range: z.enum(["short_term", "medium_term", "long_term"]),
});

/**
 * recently_played stream: one record per play-history entry.
 * Cursor: played_at (epoch ms). `id` is the composite track:ms key.
 */
export const recentlyPlayedSchema = z.object({
  id: z.string().regex(RECENTLY_PLAYED_ID_RE, "id must be <trackId>:<playedAtMs>"),
  track_id: spotifyIdSchema.optional(),
  track_name: nameSchema,
  artist_names: artistNamesSchema,
  album_name: pdppSafeText.max(1000).nullable(),
  played_at: isoDateTimeSchema,
  context_type: z.string().min(1).max(64).nullable(),
});

/**
 * Stream → schema registry. Single source of truth for emitted streams.
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  playlists: playlistsSchema,
  saved_tracks: savedTracksSchema,
  top_artists: topArtistsSchema,
  recently_played: recentlyPlayedSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
