#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "patchright";

const PROFILE_DIR = join(homedir(), ".pdpp", "profiles", "usaa");
const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: true,
  channel: "chrome",
  viewport: { width: 1280, height: 800 },
  args: ["--disable-features=DownloadBubble,DownloadBubbleV2,DownloadBubbleV3"],
});
const page = await context.newPage();

async function test(url: string, label: string): Promise<void> {
  console.error(`\n[${label}] ${url}`);
  try {
    const resp = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    console.error("  status:", resp?.status(), "final url:", page.url());
    const title = await page.title();
    console.error("  title:", title);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    console.error("  failed:", m.split("\n")[0]);
  }
}

// Sanity: can we reach ANY site?
await test("https://example.com/", "example");
// Cloudflare-protected but not USAA
await test("https://www.cloudflare.com/", "cloudflare-home");
// Now USAA home (no auth needed)
await test("https://www.usaa.com/", "usaa-home");
// USAA inner (needs auth)
await test("https://www.usaa.com/my/usaa", "usaa-auth");

await context.close();
