/**
 * Walk from the USAA dashboard to a credit-card account the way a user
 * would. Capture the URL the SPA actually routes to and dump the DOM around
 * any export/download affordance.
 */

import { acquireBrowser } from '../src/browser-profile.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { context, release } = await acquireBrowser({ headless: true });
  try {
    const page = await context.newPage();

    console.log('[nav] dashboard');
    await page.goto('https://www.usaa.com/my/usaa', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(8000);

    // Find credit-card links from the dashboard.
    const ccLinks = await page.evaluate(() => {
      const out = [];
      for (const a of document.querySelectorAll('a[href*="/my/credit-card"]')) {
        const text = (a.innerText || '').trim().slice(0, 100);
        const href = a.getAttribute('href') || '';
        out.push({ text, href });
      }
      return out;
    });
    console.log(`[dashboard] found ${ccLinks.length} credit-card links:`);
    for (const l of ccLinks.slice(0, 10)) console.log('  •', JSON.stringify(l));

    if (!ccLinks.length) {
      console.log('[!] no credit-card links on dashboard');
      return;
    }

    // Click the first link whose text looks like a card name we expect.
    const target = ccLinks.find((l) => /visa|american express|amex/i.test(l.text)) || ccLinks[0];
    console.log(`\n[click] ${JSON.stringify(target)}`);

    // Use link.click via evaluate so we handle SPA routing cleanly.
    await page.evaluate((href) => {
      const a = [...document.querySelectorAll('a[href*="/my/credit-card"]')].find((el) => el.getAttribute('href') === href);
      if (a) a.click();
    }, target.href);

    await sleep(8000);
    const url = page.url();
    console.log(`[landed] ${url}`);
    console.log(`[title] ${await page.title()}`);

    const candidates = await page.evaluate(() => {
      const results = [];
      const all = document.querySelectorAll('button, a, [role="button"], [role="menuitem"]');
      for (const el of all) {
        const text = (el.innerText || el.textContent || '').trim();
        const cls = (el.className && typeof el.className === 'string') ? el.className : '';
        const test = el.getAttribute('data-testid') || '';
        const aria = el.getAttribute('aria-label') || '';
        const href = el.getAttribute('href') || '';
        if (/export|download|csv|statement|more|options|activity/i.test([text, cls, test, aria].join(' '))) {
          results.push({
            tag: el.tagName.toLowerCase(),
            text: text.slice(0, 80),
            cls: cls.slice(0, 120),
            test,
            aria: aria.slice(0, 80),
            href: href.slice(0, 80),
          });
        }
      }
      return results.slice(0, 40);
    });
    console.log(`[candidates ${candidates.length}]`);
    for (const c of candidates) console.log('  •', JSON.stringify(c));

    // Capture activity tab links from this page
    const subtabs = await page.evaluate(() => {
      const out = [];
      for (const a of document.querySelectorAll('a[href*="/my/credit-card"], a[href*="activity"], a[href*="transaction"]')) {
        const href = a.getAttribute('href') || '';
        const text = (a.innerText || '').trim().slice(0, 80);
        if (href !== window.location.pathname + window.location.search) out.push({ href, text });
      }
      return out.slice(0, 20);
    });
    console.log(`[subtabs ${subtabs.length}]`);
    for (const s of subtabs) console.log('  •', JSON.stringify(s));

    await page.screenshot({ path: '/tmp/usaa-cc-landing.png', fullPage: true }).catch(() => {});
    console.log('[screenshot] /tmp/usaa-cc-landing.png');

    await page.close();
  } finally {
    await release();
  }
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
