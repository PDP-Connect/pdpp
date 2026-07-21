// Parsed shapes for the H-E-B connector. Extracted from index.ts so
// parsers.ts and tests can import them without pulling in the Playwright-
// flavored runtime entry. Mirrors connectors/amazon/types.ts.

export type FulfillmentMethod = "curbside" | "delivery" | "unknown";

/** One order card scraped from the order-history list page (DOM fallback) or
 *  derived from a structured `__NEXT_DATA__` row. `source` records which path
 *  produced this row — never silently conflated — per design.md Decision 1's
 *  "the fallback is observable in diagnostics/capture labels so it cannot
 *  silently become the normal path." Added fields are nullable and additive;
 *  only populated when the structured source is used AND is the origin of
 *  this row (a DOM-sourced row leaves them null/absent, it does not guess). */
export interface ListPageOrder {
  fulfillmentLocation: string | null;
  fulfillmentMethod: FulfillmentMethod;
  itemCount: number | null;
  orderDateRaw: string | null;
  orderId: string;
  source: "structured" | "dom";
  status: string | null;
  statusCode: string | null;
  storeName: string | null;
  timeslotEnd: string | null;
  timeslotStart: string | null;
  total: string | null;
  unfulfilledCount: number | null;
}

/** One line item scraped from the order-detail page. */
export interface DetailItem {
  department: string | null;
  imageUrl: string | null;
  lineTotal: string | null;
  name: string;
  productId: string | null;
  productUrl: string | null;
  quantity: number | null;
}

export interface OrderDetail {
  items: DetailItem[];
}

// Shape of the emitted `orders` stream record. Field names + nullability
// match the schemas.ts zod shape and manifests/heb.json. status_code,
// timeslot_start, timeslot_end, store_name, unfulfilled_count are additive
// nullable fields populated only from a structured row (design.md Decision 1);
// a DOM-sourced row emits them as null.
export interface OrdersRecord {
  fetched_at: string;
  fulfillment_location: string | null;
  fulfillment_method: FulfillmentMethod;
  id: string;
  item_count: number | null;
  order_date: string;
  status: string | null;
  status_code: string | null;
  store_name: string | null;
  timeslot_end: string | null;
  timeslot_start: string | null;
  total: string | null;
  total_cents: number | null;
  unfulfilled_count: number | null;
  [field: string]: unknown;
}

// Shape of the emitted `order_items` stream record.
export interface OrderItemRecord {
  department: string | null;
  fetched_at: string;
  id: string;
  image_url: string | null;
  line_total: string | null;
  line_total_cents: number | null;
  name: string;
  order_date: string;
  order_id: string;
  product_id: string | null;
  product_url: string | null;
  quantity: number | null;
  [field: string]: unknown;
}

/** Diagnostics captured when an order-history list page returns zero orders,
 *  used to distinguish "no more orders" from selector drift from an Incapsula
 *  challenge. Mirrors connectors/amazon/types.ts ListPageDiagnostics. */
export interface ListPageDiagnostics {
  any_card: number;
  body_preview: string;
  incapsula_block: boolean;
  order_cards: number;
  password_form: boolean;
  title: string;
  url: string;
}

/**
 * `maxPage` resolution outcome (design.md Decision 3). A resolver returns
 * EITHER a resolved numeric bound (including a genuine single-page
 * `value: 1`, distinguished by trustworthy metadata that affirmatively
 * asserts one page) OR "absent" (no trustworthy metadata found) OR
 * "contradictory" (metadata was found but conflicts with itself) — the
 * "absent" and "contradictory" cases are structurally distinct from any
 * numeric value so the caller cannot silently coerce either into `1`.
 */
export type MaxPageResolution =
  | { kind: "resolved"; source: "dom" | "structured"; value: number }
  | { kind: "absent" }
  | { kind: "contradictory"; reason: string };
