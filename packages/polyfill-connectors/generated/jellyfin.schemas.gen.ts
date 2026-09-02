// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// ─────────────────────────────────────────────────────────────────────────
// GENERATED FILE — DO NOT EDIT.
//
// Source manifest: manifests/jellyfin.json
// Manifest digest (sha256, first 16 hex chars): 13da7e7a1d22120f
// Generator: validator-gen/1 (bin/generate-validators.ts)
//
// Regenerate with:
//   pnpm exec tsx bin/generate-validators.ts jellyfin
//
// If this file is stale relative to the manifest, the digest above will not
// match a fresh hash of manifests/jellyfin.json — regenerate rather than
// hand-editing.
// ─────────────────────────────────────────────────────────────────────────

import { z } from "zod";

export const librariesSchema = z.object({
  id: z.string(),
  name: z.string(),
  collection_type: z.string().nullable().optional(),
  fetched_at: z.string().describe("format:date-time"),
});

export const itemsSchema = z.object({
  id: z.string(),
  name: z.string(),
  library_id: z.string(),
  type: z.string().nullable().optional(),
  played: z.boolean().nullable(),
  play_count: z.number().int().nullable(),
  last_played_date: z.string().describe("format:date-time").nullable().optional(),
  genres: z.array(z.string()).optional(),
  release_date: z.string().describe("format:date").nullable().optional(),
  image_url: z.string().nullable().optional(),
  provider_ids: z.record(z.string(), z.unknown()).nullable().optional(),
  production_year: z.number().int().nullable().optional(),
});

export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  libraries: librariesSchema,
  items: itemsSchema,
};
