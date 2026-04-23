#!/usr/bin/env node
// One-off: open order-detail page(s) and save the HTML into the latest
// amazon fixture capture directory. Complements the auto-capture that
// only fires when the connector's extractor reports orders.

import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "patchright";

const AMAZON_PROFILE_DIR = `${process.env.HOME}/.pdpp/profiles/amazon`;
const FIXTURE_ROOT = "/home/user/code/pdpp/packages/polyfill-connectors/fixtures/amazon/raw";

const orderIds = process.argv.slice(2);
if (orderIds.length === 0) {
  console.error("usage: amazon-capture-detail.ts <orderId> [<orderId>...]");
  process.exit(2);
}

const runs = readdirSync(FIXTURE_ROOT).sort();
const latest = runs.at(-1);
if (!latest) {
  console.error("no capture runs exist; run orchestrate with PDPP_CAPTURE_FIXTURES=1 first");
  process.exit(1);
}
const domDir = join(FIXTURE_ROOT, latest, "dom");
console.error(`[capture-detail] writing into ${domDir}`);

const context = await chromium.launchPersistentContext(AMAZON_PROFILE_DIR, {
  headless: true,
  channel: "chrome",
  viewport: { width: 1280, height: 800 },
  args: ["--disable-features=DownloadBubble,DownloadBubbleV2,DownloadBubbleV3"],
});

const page = await context.newPage();
for (const id of orderIds) {
  const url = `https://www.amazon.com/gp/your-account/order-details?orderID=${id}`;
  console.error(`[capture-detail] ${id}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page
    .locator(
      '[data-component="shippingAddress"], [data-component="chargeSummary"], [data-component="purchasedItemsRightGrid"]'
    )
    .first()
    .waitFor({ state: "attached", timeout: 15_000 })
    .catch(() => {
      console.error(`  warn: no known data-component selector visible on ${id}`);
    });
  const html = await page.content();
  const path = join(domDir, `order-detail-${id}.html`);
  writeFileSync(path, html);
  console.error(`  wrote ${path} (${html.length} bytes)`);
}

await page.close();
await context.close();
