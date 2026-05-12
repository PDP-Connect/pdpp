// Live check: load chatgpt.com/auth/login through Patchright+neko and
// report whether Cloudflare Turnstile presents a challenge.
//
// The actual checkbox click must be performed by a human through the
// WebRTC stream — we cannot synthesize it without re-triggering bot
// detection. This script verifies that we get the login page back, not
// a "challenge required" screen.
//
// Run from inside the reference container:
//   node scripts/stealth/turnstile-check.mjs

import { chromium } from "patchright";

const browser = await chromium.connectOverCDP(process.env.PATCHRIGHT_CDP || "http://neko:9223");
const [ctx] = browser.contexts();
const page = await ctx.newPage();

console.log("[turnstile] navigating to chatgpt.com/auth/login ...");
try {
  await page.goto("https://chatgpt.com/auth/login", {
    waitUntil: "networkidle",
    timeout: 25000,
  });
} catch (e) {
  console.log("[turnstile] goto error:", e.message);
}
await new Promise((r) => setTimeout(r, 4000));

console.log("[turnstile] page url:", page.url());
console.log("[turnstile] page title:", await page.title());

const summary = await page.evaluate(() => {
  const html = document.documentElement.outerHTML;
  return {
    bodyText: document.body?.innerText?.slice(0, 600) ?? "",
    iframeCount: document.querySelectorAll("iframe").length,
    hasTurnstileMarker: /turnstile|cf-chl|cloudflare-challenge/i.test(html),
    hasChallengeText: /are you human|prove.*not.*bot|verify.*you/i.test(document.body?.innerText ?? ""),
    hasLoginCTA: /\b(log\s*in|sign\s*up)\b/i.test(document.body?.innerText ?? ""),
  };
});

console.log("[turnstile] iframes:", summary.iframeCount);
console.log("[turnstile] hasTurnstileMarker:", summary.hasTurnstileMarker);
console.log("[turnstile] hasChallengeText:", summary.hasChallengeText);
console.log("[turnstile] hasLoginCTA:", summary.hasLoginCTA);
console.log("[turnstile] body text:", summary.bodyText.replace(/\n+/g, " | "));

const passed = summary.hasLoginCTA && !summary.hasTurnstileMarker && !summary.hasChallengeText;
console.log(`[turnstile] ${passed ? "✓ PASSED — login page reached without challenge" : "✗ FAILED — challenge detected"}`);
await browser.close();
process.exit(passed ? 0 : 1);
