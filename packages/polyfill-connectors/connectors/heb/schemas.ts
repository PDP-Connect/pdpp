/**
 * Zod schemas for H-E-B stream records. Shape-check-before-emit per
 * docs/reference/connector-authoring-guide.md §3.
 *
 * GROUND-TRUTH CAVEAT (same posture as connectors/loom and connectors/shopify):
 * heb/index.ts does NOT yet emit any RECORD — it is a browser scaffold that
 * verifies session reachability and emits
 * `SKIP_RESULT reason=heb_dom_wiring_pending`. The per-order detail DOM
 * extraction is deferred to a live session. There is no observed emitted shape;
 * these schemas are derived from the connector's MANIFEST stream declarations
 * (manifests/heb.json) — the contract the connector commits to emit once the
 * DOM extraction lands.
 *
 * Wiring `validateRecord` now is the honest, fail-fast move: the first real
 * emit is shape-checked against the declared contract instead of silently
 * trusted. Whoever wires the DOM extraction MUST re-verify these field shapes
 * against the real H-E-B order DOM and tighten them — especially the `id` /
 * `order_id` / `upc` formats and the `nutrition` object's interior shape, which
 * the manifest leaves opaque. This file is a contract scaffold, not a
 * fixture-proven schema.
 */

import { z } from "zod";
import { pdppSafeText } from "../../src/pdpp-safe-text.ts";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const UPC_RE = /^\d{8,14}$/; // UPC-A/EAN — 8–14 digits

/**
 * orders stream (manifest required: id). One record per H-E-B curbside/delivery
 * order. `total_cents` / `item_count` are non-negative ints; `store` / `status`
 * / `method` are short labels; `order_date` is an ISO datetime.
 */
export const ordersSchema = z.object({
  id: z.string().min(1).max(200),
  order_date: z.string().regex(ISO_DT_RE, "order_date must be an ISO-8601 datetime").nullable(),
  store: pdppSafeText.max(500).nullable(),
  status: z.string().min(1).max(64).nullable(),
  method: z.string().min(1).max(64).nullable(),
  total_cents: z.number().int().min(0).nullable(),
  item_count: z.number().int().min(0).nullable(),
});

/**
 * order_items stream (manifest required: id, order_id, name). One record per
 * line item. `name` is the free-form product name; `upc` is a barcode string;
 * `quantity` is a count/weight (float-capable — produce sells by weight);
 * `department` is a short label; `nutrition` is the opaque USDA-sourced
 * nutrition object preserved verbatim (manifest declares `object|null` with no
 * interior contract), or null when no USDA match.
 */
export const orderItemsSchema = z.object({
  id: z.string().min(1).max(200),
  order_id: z.string().min(1).max(200),
  name: pdppSafeText.max(1000),
  upc: z.string().regex(UPC_RE, "upc must be 8–14 digits").nullable(),
  quantity: z.number().min(0).nullable(),
  unit_price_cents: z.number().int().min(0).nullable(),
  department: pdppSafeText.max(200).nullable(),
  // Opaque USDA nutrition payload, preserved verbatim; manifest gives no
  // interior contract. Constrained to a JSON object (not an arbitrary value).
  nutrition: z.record(z.string(), z.unknown()).nullable(),
});

/**
 * Stream → schema registry. Single source of truth for the streams this
 * connector declares (and will emit once DOM extraction is wired).
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  orders: ordersSchema,
  order_items: orderItemsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
