// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Responsive Explore UAT contract checks.
 *
 * This uses the same Patchright/browser dependency as capture.ts, but asserts
 * interactions and geometry rather than screenshots:
 *   - a phone feed row uses the canonical `/sources` detail route;
 *   - opening Filters exposes a stream control that changes the Explore URL;
 *   - opening Options keeps the action sheet inside the viewport and does not
 *     create horizontal page overflow.
 *
 * Run against the seeded stack with:
 *   DASH_URL=http://localhost:3300/explore \
 *     node --import tsx docs/explorer/uat/harness/mobile-route-and-filters.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

interface PatchrightLocator {
  click: () => Promise<void>;
  count: () => Promise<number>;
  first: () => PatchrightLocator;
  getAttribute: (name: string) => Promise<string | null>;
}

interface PatchrightPage {
  close: () => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<T>;
  goto: (url: string, options: { waitUntil: string; timeout: number }) => Promise<unknown>;
  locator: (selector: string) => PatchrightLocator;
  setViewportSize: (viewport: { width: number; height: number }) => Promise<void>;
  url: () => string;
  waitForFunction: (fn: (arg: string) => boolean, arg: string, options: { timeout: number }) => Promise<unknown>;
  waitForTimeout: (ms: number) => Promise<void>;
}

interface PatchrightBrowser {
  close: () => Promise<void>;
  newPage: (options: { viewport: { width: number; height: number } }) => Promise<PatchrightPage>;
}

interface PatchrightModule {
  chromium: {
    launch: (options: { headless: boolean; executablePath?: string; args?: string[] }) => Promise<PatchrightBrowser>;
  };
}

const { chromium }: PatchrightModule = await import(
  new URL("../../../../packages/polyfill-connectors/node_modules/patchright/index.mjs", import.meta.url).href
);

const DASH_URL = process.env.DASH_URL || "http://localhost:3300/explore";
const browser = await chromium.launch({
  args: ["--no-sandbox"],
  executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
  headless: true,
});
const page = await browser.newPage({ viewport: { height: 844, width: 390 } });

test.after(async () => {
  await page.close();
  await browser.close();
});

async function openExplore(url = DASH_URL) {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(url, { timeout: 60_000, waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(document.querySelector(".rr-x")), "", { timeout: 45_000 });
  await page.waitForTimeout(250);
}

test("mobile Explore record links navigate to the canonical detail route", async () => {
  await openExplore();
  const hrefs = await page.evaluate(() =>
    [...document.querySelectorAll("a.rr-x-row--mobile")]
      .map((link) => link.getAttribute("href"))
      .filter((href): href is string => Boolean(href))
  );

  assert.ok(hrefs.length > 0, "the seeded Explore view must render at least one mobile record link");
  assert.ok(
    hrefs.every((href) => href.startsWith("/sources/")),
    `record links must use /sources: ${hrefs.join(", ")}`
  );
  assert.ok(
    hrefs.every((href) => !href.startsWith("/records/")),
    "no Explore record link may use the removed /records route"
  );

  await page.locator("a.rr-x-row--mobile").first().click();
  await page.waitForFunction(() => location.pathname.startsWith("/sources/"), "", { timeout: 45_000 });
  await page.waitForFunction(() => Boolean(document.querySelector(".rr-inspector")), "", { timeout: 45_000 });
  assert.ok(page.url().includes("/sources/"), `record tap must stay on the canonical route: ${page.url()}`);
  assert.equal(
    await page.locator(".rr-inspector").count(),
    1,
    "the canonical route must render record detail, not a 404"
  );
});

test("mobile Filters exposes a usable stream control and preserves Explore URL state", async () => {
  const scopedUrl = new URL(DASH_URL);
  scopedUrl.searchParams.set("since", "2026-04-01");
  scopedUrl.searchParams.set("until", "2026-05-01");
  await openExplore(scopedUrl.toString());
  await page.locator('[data-testid="explore-filter-rail"] > summary').click();

  const streamControl = page.locator('[data-testid="explore-stream-filters"] .rr-x-facet').first();
  assert.equal(await streamControl.count(), 1, "opening Filters must expose a stream facet control on a phone");
  await streamControl.click();
  await page.waitForFunction(() => new URL(location.href).searchParams.has("stream"), "", { timeout: 45_000 });

  const url = new URL(page.url());
  assert.ok(url.searchParams.get("stream"), "using a stream facet must add the selected stream to Explore state");
  assert.equal(url.searchParams.get("since"), "2026-04-01");
  assert.equal(url.searchParams.get("until"), "2026-05-01");
});

test("mobile Options actions stay inside the viewport without horizontal overflow", async () => {
  await openExplore();
  await page.locator('[data-testid="explore-options"] > summary').click();

  const geometry = await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>("[data-testid=explore-options] .rr-x-options__body");
    const rect = body?.getBoundingClientRect();
    return {
      clientWidth: document.documentElement.clientWidth,
      options: rect ? { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top } : null,
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });

  assert.ok(geometry.options, "opening Options must render its action sheet");
  assert.ok(geometry.options.left >= 0, `Options left edge must be visible: ${JSON.stringify(geometry)}`);
  assert.ok(
    geometry.options.right <= geometry.viewportWidth,
    `Options right edge must be visible: ${JSON.stringify(geometry)}`
  );
  assert.ok(
    geometry.scrollWidth <= geometry.clientWidth,
    `opening Options must not create horizontal page overflow: ${JSON.stringify(geometry)}`
  );
});
