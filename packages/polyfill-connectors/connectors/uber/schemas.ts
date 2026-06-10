/**
 * Zod schemas for Uber stream records. Shape-check-before-emit per
 * docs/connector-authoring-guide.md §3.
 *
 * GROUND-TRUTH CAVEAT (same posture as connectors/loom/schemas.ts):
 * uber/index.ts does NOT yet emit any RECORD — it is a browser scaffold that
 * verifies riders.uber.com session reachability and emits
 * `SKIP_RESULT reason=uber_graphql_wiring_pending`. The GraphQL
 * (getActivities / getTrip) extraction is deferred to a live session so the
 * frequently-rotating operation names and persistedQueryHash values can be
 * captured. There is no observed emitted shape; this schema is derived from the
 * connector's MANIFEST stream declaration (manifests/uber.json) — the contract
 * the connector commits to emit once extraction lands.
 *
 * Wiring `validateRecord` now is the honest move: the first real emit is
 * shape-checked against the declared contract instead of silently trusted.
 * Whoever wires the GraphQL extraction MUST re-verify these field shapes
 * against the real payload and tighten them — especially the id and fare
 * formats. This file is a contract scaffold, not a fixture-proven schema.
 */

import { z } from "zod";
import { pdppSafeText } from "../../src/pdpp-safe-text.ts";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const CURRENCY_CODE_RE = /^[A-Z]{3}$/; // ISO 4217

const isoDateTimeNullable = z.string().regex(ISO_DT_RE, "must be an ISO-8601 datetime").nullable();
const coordSchema = z.number().nullable(); // lat/lng; manifest type "number"
const centsSchema = z.number().int().min(0).nullable();

/**
 * trips stream (manifest required: id). One record per Uber trip.
 *
 * Mirrors the amazon-style dual money representation: `fare_total` is the
 * display string ("$12.34") and `fare_total_cents` is the integer amount.
 * Addresses, driver name, and vehicle description are free-form human text →
 * pdppSafeText. `status` / `product_type` / `currency` are short structural
 * strings. `receipt_url` is a URL.
 */
export const tripsSchema = z.object({
  id: z.string().min(1).max(200),
  status: z.string().min(1).max(64).nullable(),
  product_type: z.string().min(1).max(128).nullable(),
  requested_at: isoDateTimeNullable,
  started_at: isoDateTimeNullable,
  completed_at: isoDateTimeNullable,
  pickup_address: pdppSafeText.max(1000).nullable(),
  pickup_lat: coordSchema,
  pickup_lng: coordSchema,
  dropoff_address: pdppSafeText.max(1000).nullable(),
  dropoff_lat: coordSchema,
  dropoff_lng: coordSchema,
  distance_meters: z.number().min(0).nullable(),
  duration_seconds: z.number().int().min(0).nullable(),
  fare_total: pdppSafeText.max(64).nullable(),
  fare_total_cents: centsSchema,
  currency: z.string().regex(CURRENCY_CODE_RE, "currency must be a 3-letter ISO 4217 code").nullable(),
  tip_cents: centsSchema,
  surge_multiplier: z.number().min(0).nullable(),
  driver_name: pdppSafeText.max(300).nullable(),
  vehicle_description: pdppSafeText.max(500).nullable(),
  receipt_url: z.url().max(4096).nullable(),
});

/**
 * Stream → schema registry. Single source of truth for the stream this
 * connector declares (and will emit once GraphQL extraction is wired).
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  trips: tripsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
