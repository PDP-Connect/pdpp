/**
 * Zod schemas for DoorDash stream records. Shape-check-before-emit per
 * docs/connector-authoring-guide.md §3.
 *
 * GROUND-TRUTH CAVEAT (same posture as connectors/loom and connectors/shopify):
 * doordash/index.ts does NOT yet emit any RECORD — it is a browser scaffold
 * that verifies session reachability and emits
 * `SKIP_RESULT reason=doordash_graphql_wiring_pending`. The GraphQL
 * OrderHistoryQuery extraction (persisted-query hash rotates per session) is
 * deferred to a live session. There is no observed emitted shape; these schemas
 * are derived from the connector's MANIFEST stream declarations
 * (manifests/doordash.json) — the contract the connector commits to emit once
 * extraction lands.
 *
 * Wiring `validateRecord` now is the honest, fail-fast move: the first real
 * emit is shape-checked against the declared contract instead of silently
 * trusted. Whoever wires the GraphQL extraction MUST re-verify these field
 * shapes against the real OrderHistoryQuery payload and tighten them —
 * especially the `id` / `order_id` formats and the `customizations` element
 * shape, which the manifest declares only as a bare array. This file is a
 * contract scaffold, not a fixture-proven schema.
 */

import { z } from "zod";
import { pdppSafeText } from "../../src/pdpp-safe-text.ts";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/**
 * orders stream (manifest required: id). One record per DoorDash delivery
 * order. All money fields are non-negative cent integers; `restaurant_name` is
 * free-form; `status` / `payment_method_summary` are short labels;
 * `delivery_address` is free-form human text; `order_date` is an ISO datetime.
 */
export const ordersSchema = z.object({
  id: z.string().min(1).max(200),
  order_date: z.string().regex(ISO_DT_RE, "order_date must be an ISO-8601 datetime").nullable(),
  restaurant_name: pdppSafeText.max(500).nullable(),
  status: z.string().min(1).max(64).nullable(),
  subtotal_cents: z.number().int().min(0).nullable(),
  tax_cents: z.number().int().min(0).nullable(),
  tip_cents: z.number().int().min(0).nullable(),
  delivery_fee_cents: z.number().int().min(0).nullable(),
  service_fee_cents: z.number().int().min(0).nullable(),
  total_cents: z.number().int().min(0).nullable(),
  delivery_address: pdppSafeText.max(1000).nullable(),
  payment_method_summary: z.string().min(1).max(200).nullable(),
  item_count: z.number().int().min(0).nullable(),
});

/**
 * order_items stream (manifest required: id, order_id, name, quantity,
 * customizations). One record per line item. `name` is the free-form item
 * name; `quantity` is a required non-negative integer (manifest declares plain
 * integer, not nullable); `customizations` is an array of free-form
 * modifier strings (manifest declares a bare array — element shape unverified,
 * so each element is bounded free text rather than `z.any()`).
 */
export const orderItemsSchema = z.object({
  id: z.string().min(1).max(200),
  order_id: z.string().min(1).max(200),
  name: pdppSafeText.max(1000),
  quantity: z.number().int().min(0),
  unit_price_cents: z.number().int().min(0).nullable(),
  customizations: z.array(pdppSafeText.max(1000)),
});

/**
 * Stream → schema registry. Single source of truth for the streams this
 * connector declares (and will emit once extraction is wired).
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  orders: ordersSchema,
  order_items: orderItemsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
