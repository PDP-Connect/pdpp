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

// patchright is Playwright's API-compatible fork (a polyfill-connectors dep,
// not a root dependency); its types are not resolvable from this file's
// module graph, so the browser surface below is narrowed to the handful of
// methods this harness actually calls rather than imported cross-package.
interface PatchrightPage {
  close: () => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<T>;
  goto: (url: string, options: { waitUntil: string; timeout: number }) => Promise<unknown>;
  screenshot: (options: { path: string; fullPage: boolean }) => Promise<unknown>;
  waitForFunction: (fn: (arg: string) => boolean, arg: string, options: { timeout: number }) => Promise<unknown>;
  waitForTimeout: (ms: number) => Promise<void>;
}
interface PatchrightBrowser {
  close: () => Promise<void>;
  newPage: (options: { viewport: { width: number; height: number } }) => Promise<PatchrightPage>;
}
interface PatchrightModule {
  chromium: { launch: (options: { headless: boolean }) => Promise<PatchrightBrowser> };
}

// Resolved at runtime relative to repo root (harness lives at
// docs/explorer/uat/harness/ → repo root is four levels up), since patchright
// is not a root dependency.
const { chromium }: PatchrightModule = await import(
  new URL("../../../../packages/polyfill-connectors/node_modules/patchright/index.mjs", import.meta.url).href
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

interface ProbeResult {
  generic: number;
  message: number;
  messageAuthors: string[];
  money: number;
  moneyAmounts: string[];
  totalCards: number;
}

// DOM probe run in the page: count rendered typed cards by their kind hairline,
// and confirm a money amount + a message author actually rendered.
function PROBE(): ProbeResult {
  const cards = Array.from(document.querySelectorAll("div.relative.overflow-hidden.rounded-lg.border"));
  let money = 0;
  let message = 0;
  let generic = 0;
  const moneyAmounts: string[] = [];
  const messageAuthors: string[] = [];
  for (const card of cards) {
    const cls = card.className || "";
    if (cls.includes("before:bg-primary")) {
      money += 1;
      const amt = card.querySelector("span.font-mono.tabular-nums");
      if (amt?.textContent) {
        moneyAmounts.push(amt.textContent.trim());
      }
    } else if (cls.includes("var(--human)")) {
      message += 1;
      const author = card.querySelector("span.font-medium");
      if (author?.textContent) {
        messageAuthors.push(author.textContent.trim());
      }
    } else if (cls.includes("before:bg-border")) {
      generic += 1;
    }
  }
  return {
    totalCards: cards.length,
    money,
    message,
    generic,
    moneyAmounts: moneyAmounts.slice(0, 8),
    messageAuthors: messageAuthors.slice(0, 8),
  };
}

async function waitForText(page: PatchrightPage, text: string, timeout = 45_000) {
  await page.waitForFunction(
    (t) => Boolean(document.body) && document.body.innerText.toLowerCase().includes(t.toLowerCase()),
    text,
    { timeout }
  );
}

interface CaptureOptions {
  extraWaitText?: string;
  name: string;
  probe?: () => ProbeResult;
  url: string;
  waitText: string | null;
}
interface CaptureResult {
  error?: string;
  name: string;
  ok: boolean;
  probe?: ProbeResult;
  screenshot?: string;
  url: string;
}

async function capture(browser: PatchrightBrowser, { name, url, waitText, extraWaitText, probe }: CaptureOptions) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
  const result: CaptureResult = { name, url, ok: false };
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
    if (waitText) {
      await waitForText(page, waitText);
    }
    if (extraWaitText) {
      await waitForText(page, extraWaitText);
    }
    // settle layout
    await page.waitForTimeout(800);
    const shot = join(OUT_DIR, `${name}.png`);
    await page.screenshot({ path: shot, fullPage: true });
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
    result.error = err instanceof Error ? err.message : String(err);
    // Best-effort screenshot of whatever state we reached for diagnosis.
    try {
      const shot = join(OUT_DIR, `${name}.error.png`);
      await page.screenshot({ path: shot, fullPage: true });
      result.screenshot = shot;
    } catch {
      // best-effort only; the primary error is already recorded above.
    }
    console.error(`[capture] ${name}: FAILED — ${result.error}`);
  } finally {
    await page.close();
  }
  return result;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const results: CaptureResult[] = [];
  try {
    results.push(
      await capture(browser, {
        name: "dashboard-explore",
        url: DASH_URL,
        waitText: DASH_MONEY_TEXT,
        extraWaitText: DASH_MESSAGE_TEXT,
        probe: PROBE,
      })
    );
    results.push(
      await capture(browser, {
        name: "sandbox-explore",
        url: SANDBOX_URL,
        waitText: null,
        probe: PROBE,
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
  console.error("[capture] FATAL:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
