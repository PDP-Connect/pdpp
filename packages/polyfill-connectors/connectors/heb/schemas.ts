// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for H-E-B stream records. Used for shape-check-before-emit
 * per docs/reference/connector-authoring-guide.md §3: records that don't match the
 * schema become SKIP_RESULT events instead of RECORD events.
 *
 * Field shapes are LIVE-VERIFIED (2026-07-14) against a real captured
 * heb.com session — see heb-live-verify-report.md for the full evidence.
 * Notably:
 *   - the H-E-B order id remainder is confirmed all-digits (both a long
 *     ~21-digit form and a short ~11-digit form observed; regex still kept
 *     loose — see report for why a tighter digits-only regex was NOT applied);
 *   - `line_total`/`line_total_cents` (renamed from `price`/`price_cents`):
 *     CONFIRMED line total, not unit price (see report §"Price: unit vs line
 *     total");
 *   - `quantity` is non-integer for weighted produce/meat and can reflect a
 *     substitution ("N of M"); kept as a nullable number, never a fabricated
 *     truncated integer.
 */

import { z } from "zod";
import { pdppSafeText } from "../../src/pdpp-safe-text.ts";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
// H-E-B order ids are prefixed "HEB" followed by an all-digits remainder.
// LIVE-VERIFIED (2026-07-14): 20 real order ids observed across two order
// pages, in two distinct lengths/shapes — an ~18-digit form (e.g.
// "HEB192475930158571520") and an ~11-digit form (e.g. "HEB24835774087") —
// both all-digits, no letters/hyphens. Tightened from a loose
// alphanumeric-with-hyphens placeholder now that both real shapes are proven.
const HEB_ORDER_ID_RE = /^HEB\d{5,25}$/;
const CURRENCY_STRING_RE = /^\$\d+(,\d{3})*\.\d{2}$/;
// Cruft patterns that only appear if a selector grabbed the wrong DOM node —
// UI chrome/labels leaking into a field meant to hold clean scraped text.
const NAME_CRUFT_RE = /Quantity:|Price:|Add to (cart|list)|Write a review/i;
const LOCATION_CRUFT_RE = /Status:|\$\d/;

const centsSchema = z
  .number()
  .int()
  .min(0)
  .max(100_000_000) // $1,000,000 max — generous upper bound for a grocery order
  .nullable();

const currencyStringSchema = z.string().regex(CURRENCY_STRING_RE, "not a $N.NN formatted currency string").nullable();

/**
 * orders stream (manifest required: id, order_date). One record per H-E-B
 * curbside/delivery order.
 *
 * status_code, timeslot_start, timeslot_end, store_name, unfulfilled_count
 * are nullable additive fields populated only from the structured
 * `__NEXT_DATA__` source when it is trustworthy for a given row (design.md
 * Decision 1); a DOM-sourced row emits them as null. status_code is an
 * honest open string reflecting the values actually observed in structured
 * source evidence (design.md Stop Condition #5) — not a closed enum asserted
 * from one account's history.
 */
export const ordersSchema = z.object({
  id: z.string().regex(HEB_ORDER_ID_RE, 'id must start with "HEB"'),
  order_date: z.string().regex(ISO_DATE_RE, "order_date must be YYYY-MM-DD"),
  fulfillment_method: z.enum(["curbside", "delivery", "unknown"]),
  fulfillment_location: pdppSafeText
    .max(500)
    .refine((s) => !LOCATION_CRUFT_RE.test(s), { message: "contains cruft (status/price leaked into location)" })
    .nullable(),
  status: z.string().min(1).max(200).nullable(),
  status_code: z.string().min(1).max(200).nullable(),
  store_name: pdppSafeText.max(200).nullable(),
  timeslot_start: z.string().regex(ISO_DATETIME_RE, "timeslot_start must be an ISO-8601 datetime").nullable(),
  timeslot_end: z.string().regex(ISO_DATETIME_RE, "timeslot_end must be an ISO-8601 datetime").nullable(),
  total: currencyStringSchema,
  total_cents: centsSchema,
  item_count: z.number().int().min(0).nullable(),
  unfulfilled_count: z.number().int().min(0).nullable(),
  fetched_at: z.string(),
});

/**
 * order_items stream (manifest required: id, order_id, name, order_date).
 * One record per line item on an order-detail page.
 */
export const orderItemsSchema = z.object({
  id: z.string().min(1).max(300),
  order_id: z.string().regex(HEB_ORDER_ID_RE, 'order_id must start with "HEB"'),
  name: pdppSafeText
    .min(1)
    .max(1024)
    .refine((s) => !NAME_CRUFT_RE.test(s), { message: "contains UI cruft" }),
  department: z.string().min(1).max(100).nullable(),
  product_id: z.string().min(1).max(64).nullable(),
  product_url: z.string().nullable(),
  image_url: z.string().nullable(),
  quantity: z.number().min(0).max(999).nullable(),
  line_total: currencyStringSchema,
  line_total_cents: centsSchema,
  order_date: z.string().regex(ISO_DATE_RE, "order_date must be YYYY-MM-DD"),
  fetched_at: z.string(),
});

// Internal: shape returned by list-page extraction (pre-shape-check). Used to
// catch list-page selector drift before it reaches the emitted-record schema —
// if DOM selectors match the wrong elements, we'd rather see a SKIP_RESULT with
// diagnostics than silently emit garbage orders. Mirrors Amazon's
// `listPageOrderShape`.
export const listPageOrderShape = z.object({
  orderId: z.string().regex(HEB_ORDER_ID_RE, 'orderId must start with "HEB"'),
  orderDateRaw: z.string().min(4).max(60).nullable(),
  fulfillmentMethod: z.enum(["curbside", "delivery", "unknown"]),
  fulfillmentLocation: z.string().max(500).nullable(),
  status: z.string().max(200).nullable(),
  statusCode: z.string().max(200).nullable(),
  storeName: z.string().max(200).nullable(),
  timeslotStart: z.string().max(60).nullable(),
  timeslotEnd: z.string().max(60).nullable(),
  total: z.string().regex(CURRENCY_STRING_RE, "total must be $N.NN when present").nullable(),
  itemCount: z.number().int().min(0).nullable(),
  unfulfilledCount: z.number().int().min(0).nullable(),
});

/** Sanity-check that fetched_at is a well-formed ISO-8601 datetime, used only
 *  by tests that want to assert on the emitted shape directly. */
export const fetchedAtSchema = z.string().regex(ISO_DATETIME_RE, "fetched_at must be an ISO-8601 datetime");

// Map stream name → schema. Single source of truth for what streams this
// connector produces at shape-check time.
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  orders: ordersSchema,
  order_items: orderItemsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
