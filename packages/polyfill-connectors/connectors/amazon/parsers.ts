// Pure parsers for the Amazon connector. Kept free of Playwright / Node
// I/O so they can be unit-tested in isolation.

import { parseHTML } from "linkedom";
import type {
  DetailItem,
  ListPageItem,
  ListPageOrder,
  MergedItem,
  OrderDetail,
  OrderItemRecord,
  OrdersRecord,
} from "./types.ts";

const CURRENCY_CENTS_MULTIPLIER = 100;
// Strip thousands-separators (commas or locale spaces) before the numeric
// match, otherwise "$1,234.56" was previously misread as "$1.00".
const CURRENCY_THOUSANDS_RE = /[,_\s](?=\d{3}(?:\D|$))/g;
const CURRENCY_NUMBER_RE = /-?(\d+(?:\.\d+)?)/;
const CURRENCY_NEGATIVE_SIGN_RE = /^\s*-|^\s*\(/;
const ITEM_ID_WHITESPACE_RE = /\s+/g;

// Shared regexes for orders-list DOM parsing (hoisted from the old in-browser
// callback — we now parse in Node via linkedom so module-scoped regexes are
// fine).
const ORDER_ID_RE = /^\d{3}-\d{7}-\d{7}$/;
const HEADER_DATE_RE = /^(ORDER PLACED|ORDER DATE|PLACED)$/i;
const HEADER_TOTAL_RE = /^TOTAL$/i;
const TOTAL_VALUE_RE = /^\$[\d,]+\.\d{2}$/;
const ASIN_HREF_RE = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/;
const WHITESPACE_RE = /\s+/g;

function textOf(el: Element | null | undefined): string {
  if (!el) {
    return "";
  }
  // linkedom exposes innerText on HTMLElement-ish nodes; fall back to
  // textContent for safety. Both collapse similarly after our /\s+/ pass.
  const maybe = (el as { innerText?: string }).innerText;
  return typeof maybe === "string" ? maybe : (el.textContent ?? "");
}

function findHeaderValue(card: Element, labelPattern: RegExp): string | null {
  const items = card.querySelectorAll<HTMLElement>(".order-header__header-list-item");
  for (const item of items) {
    const labelEl = item.querySelector<HTMLElement>(".a-color-secondary.a-text-caps");
    const label = textOf(labelEl).trim();
    if (!labelPattern.test(label)) {
      continue;
    }
    const valueEls = [...item.querySelectorAll<HTMLElement>("span")]
      .filter((s) => s !== labelEl)
      .map((s) => textOf(s).trim())
      .filter(Boolean);
    return valueEls[0] || null;
  }
  return null;
}

function findOrderId(card: HTMLElement): string | null {
  const orderIdEl = card.querySelector<HTMLElement>(".yohtmlc-order-id");
  if (!orderIdEl) {
    return null;
  }
  for (const span of orderIdEl.querySelectorAll<HTMLElement>("span")) {
    const txt = textOf(span).trim();
    if (ORDER_ID_RE.test(txt)) {
      return txt;
    }
  }
  return null;
}

function parseListPageItem(titleEl: HTMLElement): ListPageItem | null {
  const name = textOf(titleEl).replace(WHITESPACE_RE, " ").trim();
  if (!name) {
    return null;
  }
  const itemBox = titleEl.closest<HTMLElement>(".item-box, .a-fixed-left-grid") ?? titleEl.parentElement;
  const link =
    itemBox?.querySelector<HTMLAnchorElement>('a[href*="/dp/"], a[href*="/gp/product/"]') ??
    titleEl.querySelector<HTMLAnchorElement>("a");
  const href = link?.getAttribute("href") ?? "";
  const url = href.startsWith("/") ? `https://www.amazon.com${href}` : href || null;
  const asin = href.match(ASIN_HREF_RE)?.[1] ?? null;
  return { name, url, asin };
}

function collectListPageItems(card: HTMLElement): ListPageItem[] {
  const items: ListPageItem[] = [];
  const seenAsins = new Set<string>();
  for (const titleEl of card.querySelectorAll<HTMLElement>(".yohtmlc-product-title")) {
    const item = parseListPageItem(titleEl);
    if (!item) {
      continue;
    }
    if (item.asin) {
      if (seenAsins.has(item.asin)) {
        continue;
      }
      seenAsins.add(item.asin);
    }
    items.push(item);
  }
  return items;
}

function parseOrderCard(card: HTMLElement): ListPageOrder | null {
  const orderId = findOrderId(card);
  if (!orderId) {
    return null;
  }

  const orderDateRaw = findHeaderValue(card, HEADER_DATE_RE);
  const totalRaw = findHeaderValue(card, HEADER_TOTAL_RE);
  const orderTotal = totalRaw && TOTAL_VALUE_RE.test(totalRaw) ? totalRaw : null;

  const primaryStatusEl = card.querySelector<HTMLElement>(
    ".yohtmlc-shipment-status-primaryText, .delivery-box__primary-text"
  );
  const deliveryStatus = primaryStatusEl ? textOf(primaryStatusEl).replace(WHITESPACE_RE, " ").trim() || null : null;

  return {
    orderId,
    orderDateRaw,
    orderTotal,
    deliveryStatus,
    items: collectListPageItems(card),
  };
}

// ─── Order-detail DOM parsing ───────────────────────────────────────────

const CANCELLED_RE = /has been cancelled/i;
const PAY_PREFIX_RE = /^Payment method\s*/i;
const PAY_SUFFIX_RE = /\s*View related transactions.*$/i;
const CARD_PATCH_RE = /(Visa|Mastercard|Amex|Discover|Diners|Unknown Credit Card|Credit Card|Debit Card)ending in/gi;
const CARD_ONLY_RE =
  /((?:Visa|Mastercard|Amex|Discover|Diners|Unknown Credit Card|Credit Card|Debit Card) ending in \d{3,5})/i;
const UNABLE_RE = /Unable to display payment details/i;
const GRAND_TOTAL_RE = /Grand Total:?\s*\$([\d,]+\.\d{2})/i;
const ASIN_RE = /\/(?:gp\/product|dp)\/([A-Z0-9]{10})/;
const SOLD_BY_RE = /^Sold by:?\s*(.+)$/i;
const DOLLAR_RE = /\$([\d,]+\.\d{2})/;
const INT_RE = /^\d+$/;
const FOPO_BR_RE = /<br\s*\/?>/i;
const FOPO_AT_PRICE_RE = /@\s*(\$[\d,]+\.\d{2})/;
const FOPO_CARD_TAIL_PREFIX_RE = /^\*/;
const HTML_TAG_RE = /<[^>]*>/g;
const FOPO_QTY_RE = /\bQty:\s*(\d+(?:\.\d+)?)/i;

const PAY_METHOD_MAX_LEN = 200;
const ADDRESS_MAX_LEN = 240;
const RECIPIENT_MAX_LEN = 80;
const STATUS_MAX_LEN = 180;
const ITEM_NAME_MAX_LEN = 240;
const SELLER_MAX_LEN = 120;
const ROW_ANCESTOR_SEARCH_DEPTH = 5;

function normText(el: Element | null | undefined): string {
  return textOf(el).replace(WHITESPACE_RE, " ").trim();
}

function parseShippingAddress(shipEl: Element | null): { recipient_name: string | null; summary: string | null } {
  if (!shipEl) {
    return { recipient_name: null, summary: null };
  }
  // Amazon wraps each address line as <li><span class="a-list-item">…</span></li>.
  // The previous selector "ul li span.a-list-item, ul li" matched BOTH the
  // outer <li> and its inner <span>, producing duplicated entries like
  // "Name, Name, 123 Main St, 123 Main St". Prefer the inner span when
  // present (it's the clean text node); fall back to the <li> text for
  // address layouts without the spans.
  const lis = [...shipEl.querySelectorAll<HTMLElement>("ul li")];
  const lines = lis
    .map((li) => {
      const span = li.querySelector<HTMLElement>("span.a-list-item");
      return normText(span ?? li);
    })
    .filter(Boolean);
  const first = lines[0];
  const recipient_name = first && first.length < RECIPIENT_MAX_LEN ? first : null;
  const summary = lines.length ? lines.join(", ").slice(0, ADDRESS_MAX_LEN) : null;
  return { recipient_name, summary };
}

function parsePaymentMethod(payEl: Element | null): string | null {
  if (!payEl) {
    return null;
  }
  let raw = normText(payEl);
  raw = raw.replace(PAY_PREFIX_RE, "").replace(PAY_SUFFIX_RE, "").replace(CARD_PATCH_RE, "$1 ending in").trim();
  const cardOnly = raw.match(CARD_ONLY_RE);
  if (cardOnly?.[1]) {
    return cardOnly[1];
  }
  if (raw && !UNABLE_RE.test(raw)) {
    return raw.slice(0, PAY_METHOD_MAX_LEN);
  }
  return null;
}

function parseGrandTotal(chargeEl: Element | null): string | null {
  if (!chargeEl) {
    return null;
  }
  const rows = [...chargeEl.querySelectorAll<HTMLElement>("li, .od-line-item-row")];
  for (const r of rows) {
    const t = textOf(r).replace(WHITESPACE_RE, " ");
    const m = t.match(GRAND_TOTAL_RE);
    if (m?.[1]) {
      return `$${m[1]}`;
    }
  }
  const m2 = textOf(chargeEl).replace(WHITESPACE_RE, " ").match(GRAND_TOTAL_RE);
  if (m2?.[1]) {
    return `$${m2[1]}`;
  }
  return null;
}

function findRowRoot(rightGrid: Element): Element {
  let rowRoot: Element | null = rightGrid;
  for (let i = 0; i < ROW_ANCESTOR_SEARCH_DEPTH && rowRoot; i++) {
    if (rowRoot.querySelector('[data-component="purchasedItemsLeftGrid"]')) {
      return rowRoot;
    }
    rowRoot = rowRoot.parentElement;
  }
  return rightGrid;
}

function parseDetailItem(rightGrid: Element): DetailItem | null {
  const scanRoot = findRowRoot(rightGrid);

  const titleEl = rightGrid.querySelector<HTMLElement>('[data-component="itemTitle"]');
  const titleLink = titleEl?.querySelector<HTMLAnchorElement>("a") ?? null;
  const name = normText(titleLink ?? titleEl);
  const href = titleLink?.getAttribute("href") ?? "";
  const asinM = href.match(ASIN_RE);
  if (!(asinM?.[1] && name)) {
    return null;
  }
  const absoluteHref = href.startsWith("/") ? `https://www.amazon.com${href}` : href || null;

  const merchantEl = rightGrid.querySelector<HTMLElement>('[data-component="orderedMerchant"]');
  let seller: string | null = null;
  if (merchantEl) {
    const t = normText(merchantEl);
    const sm = t.match(SOLD_BY_RE);
    seller = sm?.[1] ? sm[1].trim().slice(0, SELLER_MAX_LEN) : t.slice(0, SELLER_MAX_LEN) || null;
  }

  const priceEl = rightGrid.querySelector<HTMLElement>('[data-component="unitPrice"]');
  let unit_price: string | null = null;
  if (priceEl) {
    const pt = normText(priceEl);
    const pm = pt.match(DOLLAR_RE);
    unit_price = pm?.[1] ? `$${pm[1]}` : null;
  }

  const qtyOverlayEl = scanRoot.querySelector<HTMLElement>(".od-item-view-qty span, .od-item-view-qty");
  const qtyOverlayText = textOf(qtyOverlayEl).trim();
  const quantity = INT_RE.test(qtyOverlayText) ? Number(qtyOverlayText) : 1;

  const img = scanRoot.querySelector<HTMLElement>(
    '[data-component="itemImage"] img, [data-component="purchasedItemsLeftGrid"] img'
  );
  const item_image_url = img?.getAttribute("src") ?? null;

  let refund_status: string | null = null;
  const returnEl = rightGrid.querySelector<HTMLElement>('[data-component="itemReturnEligibility"]');
  const returnText = normText(returnEl);
  if (returnText && returnText.length < STATUS_MAX_LEN) {
    refund_status = returnText;
  }

  return {
    asin: asinM[1],
    name: name.slice(0, ITEM_NAME_MAX_LEN),
    url: absoluteHref,
    unit_price,
    quantity,
    seller,
    item_image_url,
    refund_status,
  };
}

function parseFopoPaymentMethod(summaryEl: Element | null): string | null {
  const brand = normText(summaryEl?.querySelector('[id^="wfm-"][id$="-card-brand"]'));
  const tail = normText(summaryEl?.querySelector('[id^="wfm-"][id$="-card-tail"]')).replace(
    FOPO_CARD_TAIL_PREFIX_RE,
    ""
  );
  if (brand && tail) {
    return `${brand} ending in ${tail}`.slice(0, PAY_METHOD_MAX_LEN);
  }
  return null;
}

function parseFopoStoreSummary(destinationEl: Element | null): string | null {
  if (!destinationEl) {
    return null;
  }
  const source = destinationEl.querySelector("span") ?? destinationEl;
  const html = (source as { innerHTML?: string }).innerHTML ?? "";
  const lines = (html.includes("<br") ? html.split(FOPO_BR_RE) : [textOf(source)])
    .map((line) => line.replace(HTML_TAG_RE, " "))
    .map((line) => line.replace(WHITESPACE_RE, " ").trim())
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines.join(", ").slice(0, ADDRESS_MAX_LEN) : null;
}

function parseFopoDetailItem(row: Element): DetailItem | null {
  const img = row.querySelector<HTMLElement>("img.ufpo-itemListWidget-image");
  const titleLink = row.querySelector<HTMLAnchorElement>('a[href*="/dp/"], a[href*="/gp/product/"]');
  const nameBox = row.querySelector<HTMLElement>(".a-column.a-span10 .a-row.a-spacing-none .a-column.a-span10");
  const titleFallback = nameBox?.querySelector<HTMLElement>("span.a-size-small") ?? null;
  const name = normText(titleLink ?? titleFallback);
  if (!name) {
    return null;
  }

  const href = titleLink?.getAttribute("href") ?? "";
  const asinM = href.match(ASIN_RE);
  const absoluteHref = href.startsWith("/") ? `https://www.amazon.com${href}` : href || null;

  const priceText = [...row.querySelectorAll<HTMLElement>(".a-text-right span.a-size-small")]
    .map((el) => normText(el))
    .find((text) => DOLLAR_RE.test(text));
  const unitPriceMatch = normText(row).match(FOPO_AT_PRICE_RE) ?? priceText?.match(DOLLAR_RE);
  let unit_price: string | null = null;
  if (unitPriceMatch?.[1]) {
    unit_price = unitPriceMatch[1].startsWith("$") ? unitPriceMatch[1] : `$${unitPriceMatch[1]}`;
  }

  const qtyMatch = normText(row).match(FOPO_QTY_RE);
  const quantity = qtyMatch?.[1] ? Number(qtyMatch[1]) : 1;

  return {
    asin: asinM?.[1] ?? null,
    name: name.slice(0, ITEM_NAME_MAX_LEN),
    url: absoluteHref,
    unit_price,
    quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
    seller: null,
    item_image_url: img?.getAttribute("src") ?? null,
    refund_status: null,
  };
}

function parseFopoOrderDetailDom(document: Document): OrderDetail | null {
  const itemList = document.querySelector("#f3_food_ItemList");
  const summaryEl = document.querySelector("#f3_food_WfmInStoreOrderSummary");
  if (!(itemList || summaryEl)) {
    return null;
  }

  const rows = itemList ? [...itemList.querySelectorAll<HTMLElement>(".a-row.a-spacing-base")] : [];
  const items = rows.map((row) => parseFopoDetailItem(row)).filter((item): item is DetailItem => Boolean(item));
  const grandTotal = normText(summaryEl?.querySelector("#wfm-grand-total-amount"));
  const status = normText(document.querySelector("#ufpo-order-status-primary"));

  return {
    status_detail: status && status.length < STATUS_MAX_LEN ? status : null,
    recipient_name: null,
    shipping_address_summary: parseFopoStoreSummary(document.querySelector("#f3_food_DestinationInfo")),
    payment_method_summary: parseFopoPaymentMethod(summaryEl),
    grand_total: DOLLAR_RE.test(grandTotal) ? (grandTotal.match(DOLLAR_RE)?.[0] ?? null) : null,
    gift_order: false,
    digital_order: false,
    items,
  };
}

export function parseOrderDetailDom(html: string): OrderDetail | null {
  const { document } = parseHTML(html);
  const od = document.querySelector("#orderDetails");
  if (!od) {
    return parseFopoOrderDetailDom(document);
  }

  const cancelledEl = od.querySelector('[data-component="cancelled"]');
  const cancelledText = normText(cancelledEl);
  const isCancelled = CANCELLED_RE.test(cancelledText);

  const shipEl = od.querySelector('[data-component="shippingAddress"]');
  const { recipient_name, summary: shipping_address_summary } = parseShippingAddress(shipEl);

  const payEl = od.querySelector('[data-component="viewPaymentPlanSummaryWidget"]');
  const payment_method_summary = parsePaymentMethod(payEl);

  const chargeEl = od.querySelector('[data-component="chargeSummary"]');
  const grand_total = parseGrandTotal(chargeEl);

  let status_detail: string | null = null;
  if (isCancelled) {
    status_detail = "This order has been cancelled";
  } else {
    const alertsEl = od.querySelector('[data-component="alerts"]');
    const alertText = normText(alertsEl);
    if (alertText && alertText.length < STATUS_MAX_LEN) {
      status_detail = alertText;
    }
  }

  const giftEl = od.querySelector(
    '[data-component="giftMessage"], [data-component="giftcardsSender"], [data-component="giftCardDetails"]'
  );
  const gift_order = Boolean(giftEl && textOf(giftEl).trim());
  const digital_order = false;

  if (isCancelled) {
    return {
      status_detail,
      recipient_name: null,
      shipping_address_summary: null,
      payment_method_summary: null,
      grand_total: null,
      gift_order: false,
      digital_order: false,
      items: [],
    };
  }

  const itemContainers = [...od.querySelectorAll('[data-component="purchasedItemsRightGrid"]')];
  const items: DetailItem[] = [];
  for (const rightGrid of itemContainers) {
    const item = parseDetailItem(rightGrid);
    if (item) {
      items.push(item);
    }
  }

  return {
    status_detail,
    recipient_name,
    shipping_address_summary,
    payment_method_summary,
    grand_total,
    gift_order,
    digital_order,
    items,
  };
}

export function parseOrdersListDom(html: string): ListPageOrder[] {
  const { document } = parseHTML(html);
  const cards = document.querySelectorAll<HTMLElement>(".order-card, .js-order-card");
  const results: ListPageOrder[] = [];
  for (const card of cards) {
    const parsed = parseOrderCard(card);
    if (parsed) {
      results.push(parsed);
    }
  }
  return results;
}

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
  const negative = CURRENCY_NEGATIVE_SIGN_RE.test(s);
  // "$1,234.56" → "$1234.56" so the numeric match captures the full value.
  const stripped = s.replace(CURRENCY_THOUSANDS_RE, "");
  const m = stripped.match(CURRENCY_NUMBER_RE);
  if (!m?.[1]) {
    return null;
  }
  const cents = Math.round(Number(m[1]) * CURRENCY_CENTS_MULTIPLIER);
  return negative ? -cents : cents;
}

/**
 * Canonical form for name-based item identity. Collapses runs of whitespace
 * (so "Item  Name" and "Item\tName" dedupe), trims, and lowercases. Used as
 * the map key in mergeDetailByKey and by itemId's name fallback, so both
 * sides agree on what "same item" means.
 */
function normalizeItemName(name: string): string {
  return name.replace(ITEM_ID_WHITESPACE_RE, " ").trim().toLowerCase();
}

export function itemId(orderId: string, it: { asin?: string | null; name?: string }): string {
  const key = it.asin || (it.name ? normalizeItemName(it.name) : "") || "unknown";
  return `${orderId}|${key}`;
}

export function mergeDetailByKey(detailItems: DetailItem[]): {
  byAsin: Map<string, DetailItem>;
  byName: Map<string, DetailItem>;
} {
  const byAsin = new Map<string, DetailItem>();
  const byName = new Map<string, DetailItem>();
  for (const di of detailItems) {
    if (di.asin) {
      byAsin.set(di.asin, di);
    } else if (di.name) {
      byName.set(normalizeItemName(di.name), di);
    }
  }
  return { byAsin, byName };
}

// ─── Order record + item merge ───────────────────────────────────────────

const RETURNED_RE = /return/i;

/**
 * Merge list-page items with detail-page items into the final emit-ordered
 * sequence. Preserves original collect() semantics exactly:
 *   1. For each list-page item, find its detail-page counterpart (ASIN first,
 *      then normalized name), spread list→detail, emit.
 *   2. After that, append any detail-page items not seen in the list
 *      (dedup by ASIN or normalized name against list items).
 *   3. Dedup emitted items by their final itemId() so repeats within a
 *      single order aren't duplicated.
 */
export function mergeOrderItems(listOrder: ListPageOrder, detail: OrderDetail | null): MergedItem[] {
  const detailItems = detail?.items ?? [];
  const { byAsin: detailByAsin, byName: detailByName } = mergeDetailByKey(detailItems);
  const emittedIds = new Set<string>();
  const out: MergedItem[] = [];

  const push = (merged: MergedItem): void => {
    const id = itemId(listOrder.orderId, merged);
    if (emittedIds.has(id)) {
      return;
    }
    emittedIds.add(id);
    out.push(merged);
  };

  for (const it of listOrder.items) {
    const d: Partial<DetailItem> =
      (it.asin ? detailByAsin.get(it.asin) : undefined) ??
      (it.name ? detailByName.get(normalizeItemName(it.name)) : undefined) ??
      {};
    push({ ...it, ...d });
  }
  // Detail-page items that weren't in the list.
  for (const di of detailItems) {
    const dupByAsin = di.asin && listOrder.items.some((x) => x.asin === di.asin);
    const diNorm = di.name ? normalizeItemName(di.name) : "";
    const dupByName = diNorm && listOrder.items.some((x) => x.name && normalizeItemName(x.name) === diNorm);
    if (!(dupByAsin || dupByName)) {
      push(di);
    }
  }
  return out;
}

/** Build the emitted OrderItemRecord for a single merged item. */
export function buildOrderItemRecord(orderId: string, orderDate: string, merged: MergedItem): OrderItemRecord {
  return {
    id: itemId(orderId, merged),
    order_id: orderId,
    order_date: orderDate,
    asin: merged.asin || null,
    name: merged.name,
    url: merged.url || null,
    unit_price: merged.unit_price || null,
    unit_price_cents: parseCurrencyCents(merged.unit_price ?? null),
    quantity: merged.quantity ?? 1,
    seller: merged.seller || null,
    item_image_url: merged.item_image_url || null,
    returned: RETURNED_RE.test(merged.refund_status || ""),
    refund_status: merged.refund_status || null,
  };
}

/**
 * Build the emitted OrdersRecord for a list-page order, optionally enriched
 * with the detail-page fetch. Prefers detail-page grand total (includes tax)
 * over the list-page total.
 */
export function buildOrderRecord(
  listOrder: ListPageOrder,
  detail: OrderDetail | null,
  orderDate: string,
  emittedAt: string
): OrdersRecord {
  const orderTotalRaw = detail?.grand_total || listOrder.orderTotal || null;
  return {
    id: listOrder.orderId,
    order_date: orderDate,
    order_total: orderTotalRaw,
    order_total_cents: parseCurrencyCents(orderTotalRaw),
    delivery_status: listOrder.deliveryStatus || null,
    status_detail: detail?.status_detail || null,
    recipient_name: detail?.recipient_name || null,
    shipping_address_summary: detail?.shipping_address_summary || null,
    payment_method_summary: detail?.payment_method_summary || null,
    gift_order: detail?.gift_order ?? false,
    digital_order: detail?.digital_order ?? false,
    item_count: Math.max(listOrder.items.length, detail?.items?.length ?? 0),
    fetched_at: emittedAt,
  };
}
