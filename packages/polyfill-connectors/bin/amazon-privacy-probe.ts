#!/usr/bin/env node
// Find the Amazon Privacy Central data-request URL by navigating from
// Account & Lists → Privacy.

import { readFileSync } from "node:fs";
import { chromium } from "playwright";

interface BrowserDaemonDiscovery {
  wsEndpoint: string;
}

const disc = JSON.parse(
  readFileSync(`${process.env.HOME}/.pdpp/browser-daemon.json`, "utf8")
) as BrowserDaemonDiscovery;

const browser = await chromium.connectOverCDP(disc.wsEndpoint);
const context = browser.contexts()[0];
if (!context) {
  throw new Error("No browser context available");
}
const page = await context.newPage();

// Try a handful of candidate URLs. These are patterns reported on Amazon
// support pages and in community threads.
const candidates = [
  "https://www.amazon.com/gp/help/customer/display.html?nodeId=GDK92DNLSGWTV6MP",
  "https://www.amazon.com/hz/privacy-central/data-requests",
  "https://www.amazon.com/privacycentral",
  "https://www.amazon.com/hz/privacycentral",
  "https://www.amazon.com/gp/privacycentral/dsar/preview.html",
  "https://www.amazon.com/privacy",
  "https://www.amazon.com/gp/help/customer/display.html?nodeId=202056900",
];

interface SnapResult {
  bodyPreview?: string;
  error?: string;
  hasRequestForm?: boolean;
  headingsFirst?: string[];
  relevantLinks?: Array<{ href: string; text: string }>;
  signIn?: boolean;
  title?: string;
  url?: string;
}

for (const url of candidates) {
  console.error(`\n--- trying ${url} ---`);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
    await page.waitForTimeout(2000);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`goto failed: ${msg}`);
    continue;
  }
  const snap: SnapResult = await page
    .evaluate((): SnapResult => {
      return {
        url: location.href,
        title: document.title,
        headingsFirst: [...document.querySelectorAll<HTMLElement>("h1, h2, h3")]
          .map((h) => (h.innerText || "").trim())
          .filter(Boolean)
          .slice(0, 10),
        hasRequestForm: !!document.querySelector(
          'select[name*="request" i], select[name*="category" i], button[id*="request" i]'
        ),
        // biome-ignore lint/performance/useTopLevelRegex: runs inside page.evaluate, serialized to browser context
        signIn: /\/ap\/(signin|challenge|mfa)/.test(location.href),
        // Look for anchors containing "Request My Data" / "Data Request" / "Privacy Central"
        relevantLinks: [...document.querySelectorAll("a")]
          .filter((a) =>
            // biome-ignore lint/performance/useTopLevelRegex: runs inside page.evaluate, serialized to browser context
            /request.{0,20}data|data.{0,10}request|privacy.{0,10}(center|central)|gdpr|ccpa/i.test(
              (a.innerText || a.textContent || "").trim()
            )
          )
          .map((a) => ({
            text: (a.innerText || a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100),
            href: a.href,
          }))
          .slice(0, 12),
        bodyPreview: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 500),
      };
    })
    .catch(
      (e: unknown): SnapResult => ({
        error: e instanceof Error ? e.message : String(e),
      })
    );
  console.log(JSON.stringify(snap, null, 2));
  if (snap.hasRequestForm) {
    console.error("  *** found request form here ***");
    break;
  }
}

await page.close();
await browser.close();
