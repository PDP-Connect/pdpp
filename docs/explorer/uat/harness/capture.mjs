// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Explorer live-fidelity UAT — browser capture.
 *
 * Drives a headless Chromium (patchright) against the running dashboard and
 * sandbox, waits for the client-rendered typed-card feed, captures full-page
 * screenshots, and probes the DOM for machine-verifiable proof that:
 *   - a chase `transactions` row rendered a MONEY card (primary hairline +
 *     right-aligned mono amount), and
 *   - a gmail `messages` row rendered a MESSAGE card (--human hairline +
 *     author line),
 * on `/explore` against the seeded real-shaped live data, alongside
 * the `/sandbox/explore` typed-card reference.
 *
 * Output: screenshots + probe JSON into OUT_DIR (a tracked docs/explorer/uat
 * path passed as argv[2]).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// patchright is Playwright's API-compatible fork (a polyfill-connectors dep);
// no @types are shipped and the path is resolved at runtime relative to repo
// root, so this is a dynamic, intentionally-untyped import. harness lives at
// docs/explorer/uat/harness/ → repo root is four levels up.
const { chromium } = await import(
  new URL("../../../../packages/polyfill-connectors/node_modules/patchright/index.mjs", import.meta.url)
);

const DASH_URL = process.env.DASH_URL || "http://localhost:3300/explore";
const SANDBOX_URL = process.env.SANDBOX_URL || "http://localhost:3301/sandbox/explore";
const OUT_DIR = process.argv[2] || "/tmp/explorer-uat-out";
mkdirSync(OUT_DIR, { recursive: true });

// Distinctive seeded content that only appears once the client-rendered
// typed-card feed has loaded — gate the screenshot on both a chase money row
// and a gmail message row being present.
const DASH_MONEY_TEXT = "PURCHASE - PORTLAND OR"; // chase transactions money-card summary (memo)
const DASH_MESSAGE_TEXT = "Your April statement is ready"; // gmail messages subject

// DOM probe run in the page: count rendered typed cards by their kind hairline,
// and confirm a money amount + a message author actually rendered.
const PROBE = () => {
  const cards = Array.from(document.querySelectorAll("div.relative.overflow-hidden.rounded-lg.border"));
  let money = 0;
  let message = 0;
  let generic = 0;
  const moneyAmounts = [];
  const messageAuthors = [];
  for (const card of cards) {
    const cls = card.className || "";
    if (cls.includes("before:bg-primary")) {
      money += 1;
      const amt = card.querySelector("span.font-mono.tabular-nums");
      if (amt) {
        moneyAmounts.push(amt.textContent.trim());
      }
    } else if (cls.includes("var(--human)")) {
      message += 1;
      const author = card.querySelector("span.font-medium");
      if (author) {
        messageAuthors.push(author.textContent.trim());
      }
    } else if (cls.includes("before:bg-border")) {
      generic += 1;
    }
  }
  return {
    generic,
    message,
    messageAuthors: messageAuthors.slice(0, 8),
    money,
    moneyAmounts: moneyAmounts.slice(0, 8),
    totalCards: cards.length,
  };
};

async function waitForText(page, text, timeout = 45_000) {
  await page.waitForFunction((t) => document.body?.innerText.toLowerCase().includes(t.toLowerCase()), text, {
    timeout,
  });
}

async function capture(browser, { name, url, waitText, extraWaitText, probe }) {
  const page = await browser.newPage({ viewport: { height: 1600, width: 1280 } });
  const result = { name, ok: false, url };
  try {
    await page.goto(url, { timeout: 60_000, waitUntil: "networkidle" });
    if (waitText) {
      await waitForText(page, waitText);
    }
    if (extraWaitText) {
      await waitForText(page, extraWaitText);
    }
    // settle layout
    await page.waitForTimeout(800);
    const shot = join(OUT_DIR, `${name}.png`);
    await page.screenshot({ fullPage: true, path: shot });
    result.screenshot = shot;
    if (probe) {
      result.probe = await page.evaluate(probe);
    }
    result.ok = true;
    console.log(`[capture] ${name}: OK -> ${shot}`);
    if (result.probe) {
      console.log(`[capture] ${name} probe:`, JSON.stringify(result.probe));
    }
  } catch (err) {
    result.error = err.message;
    // Best-effort screenshot of whatever state we reached for diagnosis.
    try {
      const shot = join(OUT_DIR, `${name}.error.png`);
      await page.screenshot({ fullPage: true, path: shot });
      result.screenshot = shot;
    } catch {}
    console.error(`[capture] ${name}: FAILED — ${err.message}`);
  } finally {
    await page.close();
  }
  return result;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    results.push(
      await capture(browser, {
        extraWaitText: DASH_MESSAGE_TEXT,
        name: "dashboard-explore",
        probe: PROBE,
        url: DASH_URL,
        waitText: DASH_MONEY_TEXT,
      })
    );
    results.push(
      await capture(browser, {
        name: "sandbox-explore",
        probe: PROBE,
        url: SANDBOX_URL,
        waitText: null,
      })
    );
  } finally {
    await browser.close();
  }
  writeFileSync(join(OUT_DIR, "probe.json"), `${JSON.stringify(results, null, 2)}\n`);
  console.log(`[capture] wrote ${join(OUT_DIR, "probe.json")}`);
  const allOk = results.every((r) => r.ok);
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error("[capture] FATAL:", err.message);
  process.exit(1);
});
