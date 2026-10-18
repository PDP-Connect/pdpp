// Throwaway measurement script. Not part of the app; run with
// `PLAYWRIGHT_MODULE=/abs/path/to/playwright/index.mjs node scripts/hero-load-measure.mjs`.
// Manual only: no test, suite or workflow runs it. A site must already be serving on the URL
// argument (default http://127.0.0.1:4000/). Screenshots go to the second argument (default: the
// OS temp directory).
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const playwrightModule = process.env.PLAYWRIGHT_MODULE;
if (!playwrightModule) {
  console.error("PLAYWRIGHT_MODULE is unset: set it to the absolute path of a Playwright index.mjs.");
  process.exit(1);
}
const { chromium } = await import(pathToFileURL(playwrightModule).href);

const URL = process.argv[2] || "http://127.0.0.1:4000/";
const OUT_DIR = process.argv[3] || os.tmpdir();
const TAG = process.argv[4] || "run";

// Slow 3G per Chrome DevTools presets: ~400kbps down, ~400kbps up, 400ms RTT.
const SLOW_3G = {
  downloadThroughput: (400 * 1024) / 8,
  uploadThroughput: (400 * 1024) / 8,
  latency: 400,
};

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  const client = await context.newCDPSession(page);
  await client.send("Network.enable");
  await client.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: SLOW_3G.latency,
    downloadThroughput: SLOW_3G.downloadThroughput,
    uploadThroughput: SLOW_3G.uploadThroughput,
  });
  await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });

  await page.evaluateOnNewDocument?.(() => {});
  await page.addInitScript(() => {
    window.__clsValue = 0;
    window.__clsEntries = [];
    try {
      const po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) {
            window.__clsValue += entry.value;
            window.__clsEntries.push({ value: entry.value, time: entry.startTime });
          }
        }
      });
      po.observe({ type: "layout-shift", buffered: true });
    } catch {
      // layout-shift not supported
    }
  });

  const navPromise = page.goto(URL, { waitUntil: "load", timeout: 60000 });

  for (const ms of [500, 1000, 2000]) {
    await page.waitForTimeout(ms === 500 ? 500 : ms - (ms === 1000 ? 500 : 1000));
    const shotPath = path.join(OUT_DIR, `${TAG}-${ms}ms.png`);
    await page.screenshot({ path: shotPath });
    console.log(`screenshot @ ${ms}ms -> ${shotPath}`);
  }

  await navPromise.catch((e) => console.log("nav settle:", e.message));
  await page.waitForTimeout(1500);

  const cls = await page.evaluate(() => window.__clsValue);
  const clsEntries = await page.evaluate(() => window.__clsEntries);
  console.log(`FINAL CLS for ${TAG}: ${cls}`);
  console.log("CLS entries:", JSON.stringify(clsEntries));

  const finalShot = path.join(OUT_DIR, `${TAG}-final.png`);
  await page.screenshot({ path: finalShot });
  console.log(`final screenshot -> ${finalShot}`);

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
