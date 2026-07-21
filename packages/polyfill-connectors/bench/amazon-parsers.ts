#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Microbenchmark for amazon's DOM parsers.
 *
 * Purpose: answer "does linkedom's per-parse cost matter on production-
 * sized DOM?". Run against real captured fixtures if present; fall
 * back to synthetic fixtures otherwise.
 *
 * Usage:
 *   npx tsx bench/amazon-parsers.ts
 *
 * Honest reading: the amazon connector pays ~17ms per list page (~712KB)
 * and ~9ms per order detail (~417KB). A realistic 50-order year scrape
 * parses 5 list pages + 50 detail pages — ~500ms total. Playwright's
 * per-page navigation is 1-2 seconds, so parsing is <1% of wall-clock
 * runtime. No optimization warranted; linkedom was the right choice.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseOrderDetailDom, parseOrdersListDom } from "../connectors/amazon/parsers.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_DIR = join(__dirname, "..", "connectors", "amazon", "__fixtures__");
const LIVE_ROOT = join(__dirname, "..", "fixtures", "amazon", "raw");

function pickLiveDir(): string | null {
  if (!existsSync(LIVE_ROOT)) {
    return null;
  }
  const runs = readdirSync(LIVE_ROOT).sort();
  const latest = runs.at(-1);
  if (!latest) {
    return null;
  }
  return join(LIVE_ROOT, latest, "dom");
}

function bench(label: string, fn: () => unknown, iters: number): number {
  // Warm up
  for (let i = 0; i < 3; i++) {
    fn();
  }
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) {
    fn();
  }
  const elapsed = performance.now() - t0;
  const perCall = elapsed / iters;
  console.log(`${label.padEnd(40)} ${iters} iters ${elapsed.toFixed(0).padStart(5)}ms → ${perCall.toFixed(2)}ms/call`);
  return perCall;
}

const liveDir = pickLiveDir();
const [listPath, detailPath] = liveDir
  ? ([
      join(liveDir, "orders-list-2024.html"),
      readdirSync(liveDir).find((n: string) => n.startsWith("order-detail-")),
    ] as const)
  : ([join(SYNTHETIC_DIR, "orders-list-minimal.html"), join(SYNTHETIC_DIR, "order-detail-minimal.html")] as const);

if (liveDir && !detailPath) {
  console.log("[bench] live captures present but no order-detail html found; using synthetic detail");
}

const listHtml = readFileSync(listPath, "utf8");
const detailHtml = readFileSync(
  liveDir && detailPath ? join(liveDir, detailPath) : join(SYNTHETIC_DIR, "order-detail-minimal.html"),
  "utf8"
);

console.log(`[bench] using ${liveDir ? "LIVE" : "SYNTHETIC"} fixtures`);
console.log(`        list: ${(listHtml.length / 1024).toFixed(0)} KB`);
console.log(`        detail: ${(detailHtml.length / 1024).toFixed(0)} KB\n`);

const listMs = bench("parseOrdersListDom", () => parseOrdersListDom(listHtml), 50);
const detailMs = bench("parseOrderDetailDom", () => parseOrderDetailDom(detailHtml), 50);

// Realistic year scrape: 5 list pages + ~50 order details.
const scrapeCost = listMs * 5 + detailMs * 50;
console.log(`\n[bench] 50-order year scrape parse cost: ${scrapeCost.toFixed(0)}ms`);
console.log("        (Playwright nav is ~1-2s/page, so parsing is <1% of wall-clock.)");
