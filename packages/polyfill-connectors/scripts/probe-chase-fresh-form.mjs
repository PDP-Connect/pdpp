/**
 * Find the current Chase login form selectors on a fresh profile.
 */
import { chromium } from 'rebrowser-playwright';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const profileDir = mkdtempSync(join(tmpdir(), 'chase-form-'));

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  channel: 'chrome',
  viewport: { width: 1280, height: 800 },
  args: [
    '--disable-blink-features=AutomationControlled',
    '--no-default-browser-check',
    '--no-first-run',
  ],
});

const page = await context.newPage();
await page.goto('https://www.chase.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise((r) => setTimeout(r, 3000));
await page.goto('https://secure.chase.com/web/auth/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise((r) => setTimeout(r, 5000));

const info = await page.evaluate(() => {
  function walk(root, out = []) { root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); }); return out; }
  const isVis = (el) => {
    const cs = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && b.width > 0 && b.height > 0;
  };
  const inputs = [...document.querySelectorAll('input')].filter(isVis).map((i) => ({
    id: i.id || null,
    name: i.name || null,
    type: i.type,
    placeholder: i.placeholder || null,
    ariaLabel: i.getAttribute('aria-label') || null,
  }));
  const tags = [...new Set(walk(document).map((e) => e.tagName.toLowerCase()))];
  const customTags = tags.filter((t) => t.includes('-'));
  return {
    url: location.href,
    inputs,
    customTags: customTags.slice(0, 20),
    iframe_count: document.querySelectorAll('iframe').length,
  };
});
console.log(JSON.stringify(info, null, 2));

await context.close();
await rm(profileDir, { recursive: true, force: true });
