// Pure parsers for the H-E-B connector. Kept free of Playwright / Node I/O
// so they can be unit-tested in isolation (mirrors connectors/amazon/parsers.ts).
//
// DOM/URL patterns are sourced from docs/research/heb-site-knowledge-2026-07-14.md,
// which documents the site facts mined from a prior (rejected-architecture)
// open-source H-E-B connector. These patterns are DOCUMENTED, not fixture-proven
// against a live H-E-B session — see design-notes/heb-connector-manifest-design-2026-07-14.md
// "Live-verification checklist" for what must be re-verified before this
// connector is claimed proven end-to-end.

import { parseHTML } from "linkedom";
import type {
  DetailItem,
  FulfillmentMethod,
  ListPageDiagnostics,
  ListPageOrder,
  MaxPageResolution,
  OrderDetail,
  OrderItemRecord,
  OrdersRecord,
} from "./types.ts";

const CURRENCY_CENTS_MULTIPLIER = 100;
const CURRENCY_THOUSANDS_RE = /[,_\s](?=\d{3}(?:\D|$))/g;
const CURRENCY_NUMBER_RE = /-?(\d+(?:\.\d+)?)/;
const WHITESPACE_RE = /\s+/g;

// ─── Order-history list page ─────────────────────────────────────────────
// docs/research/heb-site-knowledge-2026-07-14.md "Order list":
//   a[href*="/my-account/order-history/HEB"]
//   date:        /([A-Z][a-z]+ \d+, \d{4})/
//   total+count: /\$(\d+\.\d+),?\s*(\d+)\s*items?/i
//   status:      /Status:\s*([^\n]+)/i
//   fulfillment: /(?:Delivery to|Curbside at)\s+([^\n]+)/i

const ORDER_LINK_HREF_RE = /\/my-account\/order-history\/(HEB[^/?#]+)/;
const LIST_DATE_RE = /([A-Z][a-z]+ \d+, \d{4})/;
const LIST_TOTAL_COUNT_RE = /\$(\d+(?:,\d{3})*\.\d+),?\s*(\d+)\s*items?/i;
const LIST_STATUS_RE = /Status:\s*([^\n]+)/i;
const LIST_FULFILLMENT_RE = /(Delivery to|Curbside at)\s+([^\n]+)/i;
const PAGINATION_PAGE_RE = /page=(\d+)/;
const CURBSIDE_PREFIX_RE = /curbside/i;

function textOf(el: Element | null | undefined): string {
  if (!el) {
    return "";
  }
  const maybe = (el as { innerText?: string }).innerText;
  return typeof maybe === "string" ? maybe : (el.textContent ?? "");
}

function normText(el: Element | null | undefined): string {
  return textOf(el).replace(WHITESPACE_RE, " ").trim();
}

/**
 * Raw (newline-preserving) text, only trimming each line. The site-knowledge
 * doc's free-text regexes (date/total/status/fulfillment/quantity/price) are
 * `[^\n]+` line-scoped captures against H-E-B's per-line card text — collapsing
 * newlines first (as `normText` does) would let one field's capture run on into
 * the next line's text. Used only as the input to those regexes; individual
 * capture groups are still trimmed before use.
 */
function rawLines(el: Element | null | undefined): string {
  return textOf(el)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function fulfillmentMethodFromPrefix(prefix: string | undefined): FulfillmentMethod {
  if (!prefix) {
    return "unknown";
  }
  return CURBSIDE_PREFIX_RE.test(prefix) ? "curbside" : "delivery";
}

/**
 * Parse one order card's free text into a ListPageOrder. `cardText` is the
 * card's full innerText — the site-knowledge doc documents these as free-text
 * regex matches against the card body, not structured DOM attributes (H-E-B
 * gives us no `data-testid`-style hooks on the list page, unlike Amazon).
 */
function parseOrderCardText(orderId: string, cardText: string): ListPageOrder {
  const dateMatch = LIST_DATE_RE.exec(cardText);
  const totalCountMatch = LIST_TOTAL_COUNT_RE.exec(cardText);
  const statusMatch = LIST_STATUS_RE.exec(cardText);
  const fulfillmentMatch = LIST_FULFILLMENT_RE.exec(cardText);

  return {
    orderId,
    orderDateRaw: dateMatch?.[1] ?? null,
    total: totalCountMatch?.[1] ? `$${totalCountMatch[1]}` : null,
    itemCount: totalCountMatch?.[2] ? Number(totalCountMatch[2]) : null,
    status: statusMatch?.[1] ? statusMatch[1].trim() : null,
    statusCode: null,
    fulfillmentMethod: fulfillmentMethodFromPrefix(fulfillmentMatch?.[1]),
    fulfillmentLocation: fulfillmentMatch?.[2] ? fulfillmentMatch[2].trim() : null,
    source: "dom",
    storeName: null,
    timeslotStart: null,
    timeslotEnd: null,
    unfulfilledCount: null,
  };
}

/**
 * Find the closest ancestor "card" container for an order link.
 *
 * LIVE-VERIFIED (2026-07-14, real captured heb.com session): there is no
 * `<li>` wrapper around the order card at all — the "View details" link sits
 * in its own small `OrderSummaryCard_orderDetailsLinkWrapper` div, a sibling
 * of the div holding the date/total/status/fulfillment text, not an ancestor
 * of it. `.closest("li")` either finds an unrelated `<li>` elsewhere on the
 * page or falls back to the link's own tiny parent, both of which miss the
 * metadata entirely (every field parsed as null in the live capture). The
 * real, stable card boundary is `[data-qe-id="orderDetailsCard"]`.
 */
function cardContainerFor(link: Element): Element {
  const card = link.closest('[data-qe-id="orderDetailsCard"]');
  return card ?? link.closest("li") ?? link.parentElement ?? link;
}

export function parseOrdersListDom(html: string): ListPageOrder[] {
  const { document } = parseHTML(html);
  const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/my-account/order-history/HEB"]')];
  const seen = new Set<string>();
  const results: ListPageOrder[] = [];
  for (const link of links) {
    const href = link.getAttribute("href") ?? "";
    const idMatch = ORDER_LINK_HREF_RE.exec(href);
    const orderId = idMatch?.[1];
    if (!orderId || seen.has(orderId)) {
      continue;
    }
    seen.add(orderId);
    const card = cardContainerFor(link);
    results.push(parseOrderCardText(orderId, rawLines(card)));
  }
  return results;
}

// ─── Structured order-list source (__NEXT_DATA__) ────────────────────────
// design.md Decision 1, evidenced against the retained live captures
// (heb-live-html/{02,03,05,06,07}-orders-list.html; see the HEB connector
// design notes' "Live-capture verification" section).
// `props.pageProps.orders[]` shape observed:
//   orderId, status ("PAYMENT_RECEIPTED" — machine code),
//   orderStatusMessageShort ("Delivered" — human-readable message, the
//     existing `status` field's meaning), orderChangesOverview.unfulfilledCount,
//   fulfillmentType ("CURBSIDE_DELIVERY" — the ONLY value observed across all
//     30 orders in the retained captures; it did not vary with the DOM's
//     "Curbside at"/"Delivery to" text split observed on the same pages, so
//     there is no evidenced value-to-value mapping into the existing
//     curbside/delivery enum — fulfillment_method stays DOM-authoritative),
//   store.name, orderTimeslot.{startDateTime,endDateTime} (ISO-8601 UTC),
//   productCount, totalPrice.formattedAmount.
//
// order_date and item_count are NOT populated from structured data: no
// available capture pairs a structured row against its own DOM-rendered
// order_date/item_count for the same order (the retained captures are
// list-only re-fetches of the same 10 most-recent orders, not a paired
// DOM+structured snapshot), so truncation-equivalence (order_date) and
// meaning-equivalence (item_count) required by Decision 1 are unproven.
// fulfillment_location is likewise NOT populated from `store.name`/
// `address.nickname` — no evidenced 1:1 correspondence to the DOM's
// "Curbside at <X>"/"Delivery to <X>" text was established (see above).

interface StructuredOrderRow {
  fulfillmentType?: unknown;
  orderChangesOverview?: { unfulfilledCount?: unknown } | null;
  orderId?: unknown;
  orderStatusMessageShort?: unknown;
  orderTimeslot?: { endDateTime?: unknown; startDateTime?: unknown } | null;
  status?: unknown;
  store?: { name?: unknown } | null;
}

interface StructuredPageProps {
  orders?: unknown;
  page?: unknown;
  pages?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** Extract and JSON.parse the `__NEXT_DATA__` script payload's
 *  `props.pageProps`. Returns null if the script is absent or its content
 *  does not parse as JSON — the caller falls back to DOM extraction, per
 *  Decision 1's "absent or malformed" fallback trigger. */
function readNextDataPageProps(html: string): StructuredPageProps | null {
  const { document } = parseHTML(html);
  const script = document.querySelector("script#__NEXT_DATA__");
  const raw = script?.textContent;
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const props = (parsed as { props?: unknown }).props;
  if (typeof props !== "object" || props === null) {
    return null;
  }
  const pageProps = (props as { pageProps?: unknown }).pageProps;
  if (typeof pageProps !== "object" || pageProps === null) {
    return null;
  }
  return pageProps as StructuredPageProps;
}

/**
 * Parse one structured order row into a trustworthy `ListPageOrder`, or null
 * if the row cannot meet the parser's trustworthy shape (missing/malformed
 * `orderId`) — Decision 1: "an individual structured row cannot meet the
 * parser's trustworthy shape" falls back to DOM extraction for that row.
 */
function parseStructuredOrderRow(row: unknown): ListPageOrder | null {
  if (typeof row !== "object" || row === null) {
    return null;
  }
  const r = row as StructuredOrderRow;
  const orderId = asString(r.orderId);
  if (!orderId) {
    return null;
  }
  const timeslot = r.orderTimeslot && typeof r.orderTimeslot === "object" ? r.orderTimeslot : null;
  const store = r.store && typeof r.store === "object" ? r.store : null;
  const changes = r.orderChangesOverview && typeof r.orderChangesOverview === "object" ? r.orderChangesOverview : null;
  return {
    orderId,
    orderDateRaw: asString(timeslot?.startDateTime),
    total: null,
    itemCount: null,
    status: asString(r.orderStatusMessageShort),
    statusCode: asString(r.status),
    fulfillmentMethod: "unknown",
    fulfillmentLocation: null,
    source: "structured",
    storeName: asString(store?.name),
    timeslotStart: asString(timeslot?.startDateTime),
    timeslotEnd: asString(timeslot?.endDateTime),
    unfulfilledCount: asInt(changes?.unfulfilledCount),
  };
}

/**
 * Parse every trustworthy row out of the structured `__NEXT_DATA__.props.
 * pageProps.orders[]` array. Returns null if the payload is absent, malformed,
 * or does not contain a usable order array — Decision 1's page-level fallback
 * trigger. Returns an array (possibly with fewer entries than the source
 * array, when individual rows fail the per-row trustworthy-shape check) when
 * the array itself is usable — those untrustworthy rows are the caller's
 * per-row DOM-fallback responsibility, not a page-level failure.
 */
export function parseOrdersListStructured(html: string): ListPageOrder[] | null {
  const pageProps = readNextDataPageProps(html);
  if (!(pageProps && Array.isArray(pageProps.orders))) {
    return null;
  }
  const results: ListPageOrder[] = [];
  for (const row of pageProps.orders) {
    const parsed = parseStructuredOrderRow(row);
    if (parsed) {
      results.push(parsed);
    }
  }
  return results;
}

/**
 * Merge a page's structured and DOM extractions: prefer the structured row
 * for an order id when present and trustworthy, fall back to the DOM row
 * otherwise. Preserves DOM extraction's `total`/`itemCount`/
 * `fulfillmentMethod`/`fulfillmentLocation` for a structured-preferred row
 * (those fields are not evidenced in the structured source — see the module
 * doc comment above) by carrying them over from the DOM row of the same
 * order id, when a DOM row for that id exists on this page. Order follows
 * the DOM extraction's order (list-page visual order); a structured-only row
 * with no DOM counterpart (should not normally occur — the DOM link list and
 * structured array describe the same page) is appended after.
 */
export function mergeOrdersListPage(structured: ListPageOrder[] | null, dom: ListPageOrder[]): ListPageOrder[] {
  if (!structured) {
    return dom;
  }
  const structuredById = new Map(structured.map((o) => [o.orderId, o]));
  const domById = new Map(dom.map((o) => [o.orderId, o]));
  const merged: ListPageOrder[] = [];
  const usedStructuredIds = new Set<string>();
  for (const domOrder of dom) {
    const structuredOrder = structuredById.get(domOrder.orderId);
    if (!structuredOrder) {
      merged.push(domOrder);
      continue;
    }
    usedStructuredIds.add(domOrder.orderId);
    merged.push({
      ...structuredOrder,
      // Carry over DOM-only-evidenced fields onto the preferred structured row.
      // orderDateRaw stays DOM-authoritative (see parseOrderDate doc):
      // truncation-equivalence between the structured UTC timeslot and the
      // DOM-rendered local date is unproven, so a merged row must not silently
      // adopt the structured timestamp for order_date.
      orderDateRaw: domOrder.orderDateRaw,
      total: domOrder.total,
      itemCount: domOrder.itemCount,
      fulfillmentMethod: domOrder.fulfillmentMethod,
      fulfillmentLocation: domOrder.fulfillmentLocation,
    });
  }
  for (const structuredOrder of structured) {
    if (!(usedStructuredIds.has(structuredOrder.orderId) || domById.has(structuredOrder.orderId))) {
      merged.push(structuredOrder);
    }
  }
  return merged;
}

/** Parse "July 14, 2026" or an ISO-8601 timestamp → "2026-07-14". Returns
 *  null on unparseable input. Used for both the DOM free-text date and the
 *  structured `orderTimeslot.startDateTime` fallback-fill of `orderDateRaw`
 *  (see mergeOrdersListPage doc: order_date itself stays DOM-authoritative
 *  when a DOM row exists; this only feeds a structured-only row's date). */
export function parseOrderDate(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  return d.toISOString().slice(0, 10);
}

export function parseCurrencyCents(raw: string | null | undefined): number | null {
  if (!raw) {
    return null;
  }
  const s = String(raw);
  const stripped = s.replace(CURRENCY_THOUSANDS_RE, "");
  const m = stripped.match(CURRENCY_NUMBER_RE);
  if (!m?.[1]) {
    return null;
  }
  return Math.round(Number(m[1]) * CURRENCY_CENTS_MULTIPLIER);
}

// ─── maxPage resolution (structured-primary, DOM-fallback) ───────────────
// design.md Decision 3: `props.pageProps.pages` (a list of page links, e.g.
// [{to:"?page=1"},...,{to:"?page=4"}]) is the primary source when present and
// parseable; `page` is the source's reported current page. The DOM nav scrape
// is used only when structured pagination is absent/unparseable. Both layers
// must distinguish "absent" (no trustworthy metadata) from "contradictory"
// (metadata present but internally inconsistent) from a resolved numeric
// value — never silently coerced to 1.

const PAGES_TO_PAGE_RE = /^\?page=(\d+)$/;

/** Resolve `maxPage` from structured `pages[]`/`page`. `pages[]` entries are
 *  `{to: "?page=N"}` links; the resolved value is the max parsed N. A
 *  `pages[]` entry present but not matching the expected `?page=N` shape is
 *  ignored for the max computation but marks the array as seen (so an empty
 *  usable result is still "resolved" only if at least one entry parsed). */
export function resolveStructuredMaxPage(
  pageProps: {
    page?: unknown;
    pages?: unknown;
  } | null
): MaxPageResolution {
  if (!(pageProps && Array.isArray(pageProps.pages))) {
    return { kind: "absent" };
  }
  const parsedPages: number[] = [];
  for (const entry of pageProps.pages) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const to = (entry as { to?: unknown }).to;
    if (typeof to !== "string") {
      continue;
    }
    const m = PAGES_TO_PAGE_RE.exec(to);
    if (m?.[1]) {
      parsedPages.push(Number(m[1]));
    }
  }
  if (parsedPages.length === 0) {
    return { kind: "absent" };
  }
  const maxPage = Math.max(...parsedPages);
  const currentPage = asInt(pageProps.page);
  if (currentPage !== null && currentPage > maxPage) {
    return { kind: "contradictory", reason: "structured current page exceeds structured pages[] max" };
  }
  return { kind: "resolved", source: "structured", value: maxPage };
}

/**
 * Resolve `maxPage` from the DOM pagination nav. Distinguishes "no
 * pagination nav present at all" (absent) from "a nav is present and
 * affirmatively asserts exactly one page" (resolved, value 1) from "a nav is
 * present but its links do not yield a coherent max" (contradictory) — the
 * prior `parseMaxPage` conflated the first two cases by always returning 1.
 */
export function resolveDomMaxPage(html: string): MaxPageResolution {
  const { document } = parseHTML(html);
  const nav = document.querySelector('nav[aria-label*="Pagination" i]');
  if (!nav) {
    return { kind: "absent" };
  }
  const links = [...nav.querySelectorAll<HTMLAnchorElement>('a[href*="page="]')];
  if (links.length === 0) {
    return { kind: "absent" };
  }
  const pageNumbers: number[] = [];
  for (const link of links) {
    const href = link.getAttribute("href") ?? "";
    const m = PAGINATION_PAGE_RE.exec(href);
    if (m?.[1]) {
      pageNumbers.push(Number(m[1]));
    }
  }
  if (pageNumbers.length === 0) {
    return { kind: "contradictory", reason: "pagination nav present but no page= link parsed" };
  }
  return { kind: "resolved", source: "dom", value: Math.max(...pageNumbers) };
}

/**
 * The overall maxPage resolution contract: structured `pages[]`/`page` is
 * primary; the DOM nav scrape is used only when structured pagination is
 * absent. A structured "contradictory" result is NOT masked by falling back
 * to DOM — internally-inconsistent structured metadata is itself the
 * contradictory signal (falling back would silently hide the source
 * asserting two different things about its own pagination state).
 */
export function resolveMaxPage(html: string): MaxPageResolution {
  const pageProps = readNextDataPageProps(html);
  const structuredResult = resolveStructuredMaxPage(pageProps);
  if (structuredResult.kind !== "absent") {
    return structuredResult;
  }
  return resolveDomMaxPage(html);
}

// ─── Order-detail page ────────────────────────────────────────────────────
// LIVE-VERIFIED (2026-07-14, real captured heb.com session) against
// docs/research/heb-site-knowledge-2026-07-14.md "Order detail":
//   items:     each purchased row is a real <li data-qe-id="itemRow"> — but
//              a[href*="/product-detail"] over-matches: every row emits TWO
//              anchors to the same href (an aria-hidden image-wrapper link
//              with NO text, then the real name link). The image-wrapper
//              anchor sorts first in document order, so dedup-by-href was
//              keeping the empty-name anchor and dropping the real one —
//              every item failed the name-non-empty check, so the whole page
//              parsed as zero items. Fix: select the name anchor directly,
//              a[data-qe-id="itemRowDetailsName"] (one per real item, unique
//              href, real visible text).
//   productId: href.split('/').pop() — confirmed correct.
//   quantity:  the free-text "Quantity: N unit." line (still present in a
//              visuallyHidden a11y span) reports the ORDERED amount. The
//              structured data-qe-id="orderItemQty" span ("Qty: N" or
//              "Qty: N of M unit" when substituted/weighted) reports the
//              ACTUAL fulfilled/charged amount as its first number — this is
//              what the line-total price corresponds to, so it is preferred.
//              Falls back to the free-text line if the structured span is
//              absent. Never fabricates a bare integer from a unit-bearing
//              value with no numeric prefix.
//   price:     data-qe-id="checkoutItemPrice" ($N.NN) — CONFIRMED line total,
//              not unit price: a qty=2 item priced $3.07/ea showed
//              checkoutItemPrice=$4.64 (2 × $3.07 minus a discount, matching
//              a strikethrough pre-discount $6.14), never the flat $3.07
//              unit price. Renamed price/price_cents -> line_total/
//              line_total_cents throughout (schemas.ts/manifest) per the
//              design doc's "name it truthfully once proven" instruction.
//   department: a real, low-cardinality signal — data-qe-id=
//              "orderDetailsGroupTitle" on a <section> ancestor groups items
//              into H-E-B's ~12 standard departments (e.g. "Baby & kids",
//              "Fruit & vegetables"). On the same document already fetched
//              for items, no extra crawl.
//   image URL: derived CDN convention, not scraped — see productImageUrl().
//              Confirmed against real <img src> (004824218.jpg etc.).

// Line-scoped (stops only at a newline, NOT the first "."), so a weighted
// value like "1.5 lb." captures its full text instead of truncating at the
// decimal point's period. The trailing "." is stripped before the numeric
// check below, so a plain "2." (no unit) still parses as 2.
const DETAIL_QUANTITY_RE = /Quantity:\s*([^\n]+)/i;
// Structured "Qty: N" or "Qty: N of M unit" (substitution/weighted) span.
// The first number is always the actual fulfilled/charged amount.
const STRUCTURED_QTY_RE = /Qty:\s*(\d+(?:\.\d+)?)/i;
// LIVE-VERIFIED (2026-07-14): the accessible a11y line always ends
// "...Price: $N.NN." — a sentence-terminating period immediately after the
// two decimal digits. A greedy [\d.]+ swallows that period into the
// captured number ("$4.29." instead of "$4.29"); anchoring on exactly two
// decimal digits excludes it.
const DETAIL_PRICE_RE = /Price:\s*\$?(\d+\.\d{2})/i;
const NUMERIC_RE = /^\d+(\.\d+)?$/;
const PRODUCT_ID_RE = /^\d+$/;
const TRAILING_PERIOD_RE = /\.$/;
const IMAGE_PRODUCT_ID_PAD_LENGTH = 9;

/**
 * Derive the H-E-B product image CDN URL from a product id. Reverse-engineered
 * convention (docs/research/heb-site-knowledge-2026-07-14.md "Order detail"),
 * not a documented H-E-B API — this may drift and needs live re-verification.
 * Returns null for a productId that isn't a digits-only string (the
 * documented CDN convention is a zero-padded product-id digit string; a
 * decimal-like id such as "123.45" is not a valid H-E-B product id).
 */
export function productImageUrl(productId: string | null): string | null {
  if (!(productId && PRODUCT_ID_RE.test(productId))) {
    return null;
  }
  const padded = productId.padStart(IMAGE_PRODUCT_ID_PAD_LENGTH, "0");
  return `https://images.heb.com/is/image/HEBGrocery/prd-small/${padded}.jpg`;
}

/**
 * Find the closest ancestor "row" for a product-detail link. LIVE-VERIFIED:
 * unlike the list page, real order-detail rows genuinely are
 * `<li data-qe-id="itemRow">` — `.closest("li")` is correct here as-is.
 */
function itemRowFor(link: Element): Element {
  const li = link.closest("li");
  return li ?? link.parentElement ?? link;
}

/**
 * The item's department, from the nearest ancestor category section's title
 * (LIVE-VERIFIED: `data-qe-id="orderDetailsGroupTitle"` inside a `<section>`
 * ancestor, one of H-E-B's ~12 standard departments, e.g. "Baby & kids").
 * Returns null if the row isn't inside a recognized category section.
 */
function departmentFor(row: Element): string | null {
  const section = row.closest("section");
  const title = section?.querySelector('[data-qe-id="orderDetailsGroupTitle"]');
  const text = normText(title);
  return text || null;
}

function absoluteProductUrl(href: string): string | null {
  if (!href) {
    return null;
  }
  return href.startsWith("http") ? href : `https://www.heb.com${href}`;
}

/**
 * Parse a detail row's quantity, preferring the structured "Qty: N" / "Qty: N
 * of M unit" span (the actual fulfilled/charged amount — LIVE-VERIFIED to
 * match what the line-total price corresponds to for substituted/weighted
 * items), falling back to the free-text "Quantity: ..." line (the ORDERED
 * amount) when the structured span is absent. Returns null — never a
 * fabricated/truncated integer — for anything that isn't a clean leading
 * number (e.g. a unit-only value with no numeric prefix). Exported for direct
 * unit tests of the quantity-value contract independent of DOM row
 * extraction.
 */
export function parseDetailQuantity(rowText: string): number | null {
  const structuredMatch = STRUCTURED_QTY_RE.exec(rowText);
  if (structuredMatch?.[1]) {
    return Number(structuredMatch[1]);
  }
  const quantityMatch = DETAIL_QUANTITY_RE.exec(rowText);
  const raw = quantityMatch?.[1]?.trim().replace(TRAILING_PERIOD_RE, "").trim() ?? null;
  return raw && NUMERIC_RE.test(raw) ? Number(raw) : null;
}

// LIVE-VERIFIED (2026-07-14): checkoutItemPrice (line total), a strikethrough
// pre-discount price, and the per-unit price are adjacent <span> siblings
// with NO whitespace text node between them — innerText glues them into one
// unbroken run (e.g. "$4.64$6.14$3.07 / ea"), so a regex over the row's flat
// text cannot reliably isolate the line-total span from its neighbors. Read
// it directly from the DOM instead; fall back to the free-text "Price: $N.NN"
// accessible line (which IS separated by its own sentence) if the structured
// span is absent.
function parseLineTotal(row: Element, rowText: string): string | null {
  const structured = normText(row.querySelector('[data-qe-id="checkoutItemPrice"]'));
  const priceMatch = structured ? null : DETAIL_PRICE_RE.exec(rowText);
  const raw = structured || (priceMatch?.[1] ? `$${priceMatch[1]}` : null);
  return raw || null;
}

function parseDetailItem(link: HTMLAnchorElement): DetailItem | null {
  const href = link.getAttribute("href") ?? "";
  const productId = href.split("/").filter(Boolean).pop() ?? null;
  const name = normText(link);
  if (!(name && productId)) {
    return null;
  }
  const row = itemRowFor(link);
  const rowText = rawLines(row);

  return {
    department: departmentFor(row),
    name,
    productId,
    productUrl: absoluteProductUrl(href),
    imageUrl: productImageUrl(productId),
    quantity: parseDetailQuantity(rowText),
    lineTotal: parseLineTotal(row, rowText),
  };
}

// LIVE-VERIFIED (2026-07-14): every real item row emits TWO anchors to the
// same product-detail href — an aria-hidden image-wrapper link with empty
// text (sorts first in document order) and the real name link
// (a[data-qe-id="itemRowDetailsName"]). Selecting the name anchor directly
// avoids both failure modes the old a[href*="/product-detail"] + dedup-by-
// href approach had: the image anchor's empty name would fail the name check
// silently, and the dedup would then skip the real (second, same-href) name
// anchor entirely — the exact reason the old selector parsed 0 items against
// every real order-detail page captured. No recommendation/footer product
// rail was found on the real captured page (verified: only a "Quick actions"
// banner with report/reorder buttons, no product-detail links).
export function parseOrderDetailDom(html: string): OrderDetail | null {
  const { document } = parseHTML(html);
  const links = [...document.querySelectorAll<HTMLAnchorElement>('a[data-qe-id="itemRowDetailsName"]')];
  if (links.length === 0) {
    return null;
  }
  const seenHrefs = new Set<string>();
  const items: DetailItem[] = [];
  for (const link of links) {
    const href = link.getAttribute("href") ?? "";
    if (!href || seenHrefs.has(href)) {
      continue;
    }
    seenHrefs.add(href);
    const item = parseDetailItem(link);
    if (item) {
      items.push(item);
    }
  }
  if (items.length === 0) {
    return null;
  }
  return { items };
}

// ─── Incapsula block detection ────────────────────────────────────────────
// docs/research/heb-site-knowledge-2026-07-14.md "Bot protection": a real
// block/challenge renders as an empty shell — no h3, no breadcrumb nav, no
// [data-testid], document.body.children.length <= 2, and at least one iframe.
// `_Incapsula_Resource` alone (present on every page) must NOT count as a block.

export function isIncapsulaBlocked(html: string): boolean {
  const { document } = parseHTML(html);
  const body = document.body;
  if (!body) {
    return false;
  }
  const hasH3 = Boolean(document.querySelector("h3"));
  const hasBreadcrumb = Boolean(document.querySelector('nav[aria-label*="breadcrumb" i], [class*="breadcrumb" i]'));
  const hasTestId = Boolean(document.querySelector("[data-testid]"));
  const hasIframe = Boolean(document.querySelector("iframe"));
  const shallowBody = body.children.length <= 2;
  return !(hasH3 || hasBreadcrumb || hasTestId) && shallowBody && hasIframe;
}

// ─── Session probe (deep check) ───────────────────────────────────────────
// design-notes/heb-connector-manifest-design-2026-07-14.md "Collector plan" §1:
// URL alone is not trusted; also check for a visible password form.

const LOGGED_OUT_URL_RE = /\/(sign-in|login|challenge|checkpoint)/i;

export function looksLoggedOut(landedUrl: string, html: string): boolean {
  if (LOGGED_OUT_URL_RE.test(landedUrl)) {
    return true;
  }
  const { document } = parseHTML(html);
  return Boolean(document.querySelector('input[type="password"]'));
}

// ─── Empty-list-page diagnostics ──────────────────────────────────────────

export function diagnoseEmptyListPage(html: string, url: string): ListPageDiagnostics {
  const { document } = parseHTML(html);
  return {
    url,
    title: document.title ?? "",
    order_cards: document.querySelectorAll('a[href*="/my-account/order-history/HEB"]').length,
    any_card: document.querySelectorAll('[class*="order" i]').length,
    password_form: Boolean(document.querySelector('input[type="password"]')),
    incapsula_block: isIncapsulaBlocked(html),
    body_preview: normText(document.body).slice(0, 240),
  };
}

// ─── Record builders ──────────────────────────────────────────────────────

export function buildOrderRecord(listOrder: ListPageOrder, orderDate: string, emittedAt: string): OrdersRecord {
  return {
    id: listOrder.orderId,
    order_date: orderDate,
    fulfillment_method: listOrder.fulfillmentMethod,
    fulfillment_location: listOrder.fulfillmentLocation,
    status: listOrder.status,
    status_code: listOrder.statusCode,
    store_name: listOrder.storeName,
    timeslot_start: listOrder.timeslotStart,
    timeslot_end: listOrder.timeslotEnd,
    unfulfilled_count: listOrder.unfulfilledCount,
    total: listOrder.total,
    total_cents: parseCurrencyCents(listOrder.total),
    item_count: listOrder.itemCount,
    fetched_at: emittedAt,
  };
}

/** Composite item id, Amazon's `${orderId}|${key}` pattern (design doc: "H-E-B
 *  is *better* off than Amazon here because `product_id` comes free from the
 *  detail-page href"). Falls back to a normalized name when product_id is
 *  absent so every item still gets a stable, order-scoped id. The fallback
 *  incorporates `itemIndex` (the item's position within this order's parsed
 *  item list) so two same-name, product-id-null items in one order — e.g. two
 *  malformed/variant hrefs that both fail to yield a product id — get
 *  distinct ids instead of colliding on the same normalized name. */
export function orderItemId(orderId: string, item: Pick<DetailItem, "productId" | "name">, itemIndex: number): string {
  if (item.productId) {
    return `${orderId}|${item.productId}`;
  }
  const normalizedName = item.name.replace(WHITESPACE_RE, " ").trim().toLowerCase() || "unknown";
  return `${orderId}|${normalizedName}|${itemIndex}`;
}

export function buildOrderItemRecord(
  orderId: string,
  orderDate: string,
  item: DetailItem,
  itemIndex: number,
  emittedAt: string
): OrderItemRecord {
  return {
    id: orderItemId(orderId, item, itemIndex),
    order_id: orderId,
    name: item.name,
    department: item.department,
    product_id: item.productId,
    product_url: item.productUrl,
    image_url: item.imageUrl,
    quantity: item.quantity,
    line_total: item.lineTotal,
    line_total_cents: parseCurrencyCents(item.lineTotal),
    order_date: orderDate,
    fetched_at: emittedAt,
  };
}
