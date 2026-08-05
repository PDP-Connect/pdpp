// Throwaway measurement script. Not part of the app; run with `node scripts/hero-load-measure.mjs`.
import path from "node:path";
import { chromium } from "/home/tnunamak/.tmp/builder-0805/node_modules/.pnpm/playwright@1.62.0/node_modules/playwright/index.mjs";

const URL = process.argv[2] || "http://127.0.0.1:4000/";
const OUT_DIR = process.argv[3] || "/home/tnunamak/.tmp/hero-load-shots";
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
