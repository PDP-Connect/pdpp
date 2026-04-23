// Pure parsers for the Amazon connector. Kept free of Playwright / Node
// I/O so they can be unit-tested in isolation.

// biome-ignore lint/correctness/noUnresolvedImports: linkedom is declared in package.json; Biome's resolver can't follow its conditional exports
import { parseHTML } from "linkedom";
import type { DetailItem, ListPageItem, ListPageOrder } from "./types.ts";

const CURRENCY_CENTS_MULTIPLIER = 100;
const CURRENCY_NUMBER_RE = /(\d+(?:\.\d+)?)/;
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

function parseOrderCard(card: HTMLElement): ListPageOrder | null {
  const orderIdEl = card.querySelector<HTMLElement>(".yohtmlc-order-id");
  let orderId: string | null = null;
  if (orderIdEl) {
    for (const span of orderIdEl.querySelectorAll<HTMLElement>("span")) {
      const txt = textOf(span).trim();
      if (ORDER_ID_RE.test(txt)) {
        orderId = txt;
        break;
      }
    }
  }
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

  const items: ListPageItem[] = [];
  const seenAsins = new Set<string>();
  for (const titleEl of card.querySelectorAll<HTMLElement>(".yohtmlc-product-title")) {
    const name = textOf(titleEl).replace(WHITESPACE_RE, " ").trim();
    if (!name) {
      continue;
    }
    const itemBox = titleEl.closest<HTMLElement>(".item-box, .a-fixed-left-grid") ?? titleEl.parentElement;
    const link =
      itemBox?.querySelector<HTMLAnchorElement>('a[href*="/dp/"], a[href*="/gp/product/"]') ??
      titleEl.querySelector<HTMLAnchorElement>("a");
    const href = link?.getAttribute("href") ?? "";
    const url = href.startsWith("/") ? `https://www.amazon.com${href}` : href || null;
    const asinMatch = href.match(ASIN_HREF_RE);
    const asin = asinMatch?.[1] ?? null;

    if (asin && seenAsins.has(asin)) {
      continue;
    }
    if (asin) {
      seenAsins.add(asin);
    }
    items.push({ name, url, asin });
  }

  return {
    orderId,
    orderDateRaw,
    orderTotal,
    deliveryStatus,
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
  const m = String(raw).match(CURRENCY_NUMBER_RE);
  if (!m?.[1]) {
    return null;
  }
  return Math.round(Number(m[1]) * CURRENCY_CENTS_MULTIPLIER);
}

export function itemId(orderId: string, it: { asin?: string | null; name?: string }): string {
  const key = it.asin || it.name?.toLowerCase().replace(ITEM_ID_WHITESPACE_RE, " ").trim() || "unknown";
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
      byName.set(di.name.trim().toLowerCase(), di);
    }
  }
  return { byAsin, byName };
}
