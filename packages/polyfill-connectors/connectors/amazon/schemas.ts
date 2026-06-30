/**
 * Zod schemas for Amazon stream records. Used for shape-check-before-emit
 * per docs/connector-authoring-guide.md §3: records that don't match the
 * schema become SKIP_RESULT events instead of RECORD events, so the RS
 * never receives data that looks right but isn't.
 *
 * Each schema asserts:
 *   - primitive types correct
 *   - lengths bounded
 *   - no known cruft patterns in string fields (regex literals like
 *     "Buy it again", "Sold by" that only appear if row parsing failed)
 *   - currency/id shapes correct
 *
 * Schemas intentionally accept `null` for fields that can legitimately be
 * absent. Required fields (id, order_date) must be present.
 */

import { z } from "zod";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-level regexes (Biome useTopLevelRegex) — compiled once, reused
// across every record validated by this module.
const PAYMENT_CRUFT_RE = /Unable to display|Buy it again|View your item/i;
const PAYMENT_DOLLAR_RE = /\$\d/;
const RECIPIENT_FORBIDDEN_RE = /[$\t\n]|Buy it again|View your item/i;
const CURRENCY_STRING_RE = /^\$\d+(,\d{3})*\.\d{2}$/;
const ASIN_RE = /^[A-Z0-9]{10}$/;
const ITEM_NAME_CRUFT_RE = /Buy it again|View your item|Get product support|Write a product review/i;
const ITEM_NAME_SOLD_BY_RE = /^Sold by/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AMAZON_ORDER_ID_RE = /^\d{3}-\d{7}-\d{7}$/;
const LIST_PAGE_TOTAL_RE = /^\$[\d,]+\.\d{2}$/;

// Payment summary must either be null, a card/digital-wallet style string,
// or an explicit mixed-payment line ("Amazon gift card balance Visa ending
// in 5900"). Must NOT contain "Unable to display" (non-answer text) or
// UI cruft.
const paymentMethodSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((s) => !PAYMENT_CRUFT_RE.test(s), {
    message: "contains cruft or non-answer text",
  })
  .refine((s) => !PAYMENT_DOLLAR_RE.test(s), {
    message: "contains a dollar amount (likely parse leak)",
  })
  .nullable();

const recipientNameSchema = z
  .string()
  .min(2)
  .max(80)
  .refine((s) => !RECIPIENT_FORBIDDEN_RE.test(s), {
    message: "contains forbidden chars or cruft",
  })
  .nullable();

const currencyStringSchema = z.string().regex(CURRENCY_STRING_RE, "not a $N.NN formatted currency string").nullable();

const centsSchema = z
  .number()
  .int()
  .min(0)
  .max(10_000_000) // $100,000 max — sane upper bound for consumer orders
  .nullable();

const asinSchema = z.string().regex(ASIN_RE, "ASIN must be 10 uppercase alphanumeric").nullable();

// Item name: non-empty, bounded, must not contain obvious cruft patterns.
// Amazon product names run long on multi-pack / gift-basket / variant
// listings (500-chars observed in practice). 1024 is a safe upper bound.
const itemNameSchema = z
  .string()
  .min(2)
  .max(1024)
  .refine((s) => !ITEM_NAME_CRUFT_RE.test(s), {
    message: "contains UI cruft",
  })
  .refine((s) => !ITEM_NAME_SOLD_BY_RE.test(s), {
    message: 'starts with "Sold by" — name parser captured the wrong span',
  });

export const orderSchema = z.object({
  id: z.string().min(5).max(40),
  order_date: z.string().regex(ISO_DATE_RE, "order_date must be YYYY-MM-DD"),
  order_total: currencyStringSchema,
  order_total_cents: centsSchema,
  delivery_status: z.string().nullable(),
  status_detail: z.string().max(200).nullable(),
  recipient_name: recipientNameSchema,
  shipping_address_summary: z.string().max(500).nullable(),
  payment_method_summary: paymentMethodSchema,
  gift_order: z.boolean(),
  digital_order: z.boolean(),
  item_count: z.number().int().min(0),
  fetched_at: z.string(),
});

export const orderItemSchema = z.object({
  id: z.string().min(5).max(250),
  order_id: z.string().min(5).max(40),
  order_date: z.string().regex(ISO_DATE_RE),
  asin: asinSchema,
  name: itemNameSchema,
  url: z.url().nullable(),
  unit_price: currencyStringSchema,
  unit_price_cents: centsSchema,
  quantity: z.number().positive().max(999),
  seller: z.string().min(1).max(120).nullable(),
  item_image_url: z.string().nullable(),
  returned: z.boolean(),
  refund_status: z.string().max(200).nullable(),
});

// Internal: shape returned by extractOrdersOnPage (pre-enrichment). Used
// to catch list-page selector drift — if our DOM selectors match the
// wrong elements, we'd rather see a SKIP_RESULT with diagnostics than
// silently emit garbage orders.
export const listPageOrderShape = z.object({
  orderId: z.string().regex(AMAZON_ORDER_ID_RE, "orderId must match NNN-NNNNNNN-NNNNNNN"),
  orderDateRaw: z.string().min(4).max(60).nullable(),
  orderTotal: z.string().regex(LIST_PAGE_TOTAL_RE, "orderTotal must be $N.NN when present").nullable(),
  deliveryStatus: z.string().max(200).nullable(),
  items: z.array(
    z.object({
      name: z.string().min(2).max(1024),
      url: z.url().nullable(),
      asin: asinSchema,
    })
  ),
});

// Map stream name → schema. Single source of truth for what streams this
// connector produces at shape-check time.
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  orders: orderSchema,
  order_items: orderItemSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
