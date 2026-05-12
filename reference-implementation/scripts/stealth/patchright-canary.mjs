// Patchright end-to-end canary against the running neko Chromium.
//
// Verifies the full Patchright attach + injection stack:
//   1. /json/version discovery works through cdp-proxy.py.
//   2. chromium.connectOverCDP completes.
//   3. Existing contexts/pages are hydrated.
//   4. addInitScript injects into main world via the Route mechanism.
//   5. Driver-side stealth properties hold (navigator.webdriver = false).
//
// Run from inside the reference container:
//   node scripts/stealth/patchright-canary.mjs
//
// Note: page.evaluate() runs in Patchright's utility world, which has its
// own globalThis. To verify a main-world write, inject a second script via
// document.createElement('script') so the read also lands in main world.

import { chromium } from "patchright";

const CDP = process.env.PATCHRIGHT_CDP || "http://neko:9223";

console.log(`[canary] connecting via Patchright to ${CDP} ...`);
const browser = await chromium.connectOverCDP(CDP);
const [ctx] = browser.contexts();
console.log(`[canary] ✓ attached; ${browser.contexts().length} context(s), ${ctx.pages().length} pre-existing page(s)`);

await ctx.addInitScript(() => {
  // Main-world injection via Patchright's Fetch-based Route mechanism.
  window.__pdppCanary = "ok";
});

const page = await ctx.newPage();
await page.goto("https://example.com/", { waitUntil: "load", timeout: 15000 });

// Read main-world value via a DOM script hop (utility-world page.evaluate
// can't see main-world globals directly).
await page.evaluate(() => {
  const s = document.createElement("script");
  s.textContent = `(() => { const m = document.createElement('meta'); m.id = 'pdpp-canary-readback'; m.setAttribute('content', String(window.__pdppCanary || 'missing')); document.head.appendChild(m); })();`;
  document.head.appendChild(s);
});
await new Promise((r) => setTimeout(r, 200));

const result = await page.evaluate(() => ({
  url: location.href,
  title: document.title,
  canaryFromMain: document.getElementById("pdpp-canary-readback")?.getAttribute("content"),
  webdriver: navigator.webdriver,
  webglRenderer: (() => {
    try {
      const g = document.createElement("canvas").getContext("webgl");
      const e = g.getExtension("WEBGL_debug_renderer_info");
      return g.getParameter(e.UNMASKED_RENDERER_WEBGL);
    } catch { return null; }
  })(),
  chromeRuntimeExists: typeof window.chrome?.runtime,
}));
console.log("[canary] result:", result);

if (result.canaryFromMain !== "ok") {
  console.error("[canary] ✗ init-script injection failed — Route mechanism not firing");
  process.exit(2);
}
if (result.webdriver !== false) {
  console.error(`[canary] ✗ navigator.webdriver = ${result.webdriver} (expected false)`);
  process.exit(3);
}
console.log("[canary] ✓ all checks passed");
await browser.close();
