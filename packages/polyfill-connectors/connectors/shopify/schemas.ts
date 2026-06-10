/**
 * Zod schemas for Shopify (Shop app) stream records. Shape-check-before-emit
 * per docs/connector-authoring-guide.md §3.
 *
 * GROUND-TRUTH CAVEAT (same posture as connectors/loom/schemas.ts):
 * shopify/index.ts does NOT yet emit any RECORD — it is a browser scaffold that
 * verifies shop.app reachability and emits
 * `SKIP_RESULT reason=shopify_apollo_wiring_pending`. The Apollo-cache /
 * React-fiber extraction is deferred to a live session. There is no observed
 * emitted shape; this schema is derived from the connector's MANIFEST stream
 * declaration (manifests/shopify.json) — the contract the connector commits to
 * emit once extraction lands.
 *
 * Wiring `validateRecord` now is the honest move: the first real emit is
 * shape-checked against the declared contract instead of silently trusted.
 * Whoever wires the Apollo extraction MUST re-verify these field shapes against
 * the real payload and tighten them — especially the id and currency formats,
 * which the manifest leaves as opaque/loose strings. This file is a contract
 * scaffold, not a fixture-proven schema.
 */

import { z } from "zod";
import { pdppSafeText } from "../../src/pdpp-safe-text.ts";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const CURRENCY_CODE_RE = /^[A-Z]{3}$/; // ISO 4217

/**
 * orders stream (manifest required: id). One record per Shop-app order.
 * `total_cents` / `item_count` are non-negative ints; `currency` is an ISO 4217
 * code; `merchant_name` and `status` are free-form/short strings;
 * `tracking_url` is a URL; `tracking_number` is an opaque carrier string.
 */
export const ordersSchema = z.object({
  id: z.string().min(1).max(200),
  order_date: z.string().regex(ISO_DT_RE, "order_date must be an ISO-8601 datetime").nullable(),
  merchant_name: pdppSafeText.max(500).nullable(),
  status: z.string().min(1).max(64).nullable(),
  total_cents: z.number().int().min(0).nullable(),
  currency: z.string().regex(CURRENCY_CODE_RE, "currency must be a 3-letter ISO 4217 code").nullable(),
  tracking_number: z.string().min(1).max(128).nullable(),
  tracking_url: z.url().max(4096).nullable(),
  item_count: z.number().int().min(0).nullable(),
});

/**
 * Stream → schema registry. Single source of truth for the stream this
 * connector declares (and will emit once Apollo extraction is wired).
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  orders: ordersSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
