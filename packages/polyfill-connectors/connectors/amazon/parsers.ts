// Pure parsers for the Amazon connector. Kept free of Playwright / Node
// I/O so they can be unit-tested in isolation.

import type { DetailItem } from "./types.ts";

const CURRENCY_CENTS_MULTIPLIER = 100;
const CURRENCY_NUMBER_RE = /(\d+(?:\.\d+)?)/;
const ITEM_ID_WHITESPACE_RE = /\s+/g;

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
