/**
 * Live probe of USAA credit-card transaction UI. Walks both Signature Visa
 * and Amex accounts, inspects the DOM around likely export affordances, and
 * prints what's there so we can wire selectors without guessing.
 *
 * Run with the daemon already holding a logged-in session.
 */

import { acquireBrowser } from '/home/user/code/pdpp/packages/polyfill-connectors/src/browser-profile.js';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '/home/user/code/pdpp/.env.local' });

const ACCOUNTS = [
  { label: 'Signature Visa (4503)', id: '0002-PnwSxCt5HLlzn7raPcAK' },
  { label: 'American Express (1437)', id: '0002-8s5bGlijgBHMFGpcnDO' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probeAccount(page, label, accountId) {
  console.log(`\n=========== ${label} ===========`);
  const paths = [
    `/my/credit-card/transactions?accountId=${accountId}`,
    `/my/credit-card/summary?accountId=${accountId}`,
    `/my/credit-card/activity?accountId=${accountId}`,
    `/my/credit-card?accountId=${accountId}`,
  ];

  for (const path of paths) {
    const url = `https://www.usaa.com${path}`;
    console.log(`\n-- navigating ${url}`);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err) {
      console.log(`  navigate error: ${err.message.slice(0, 200)}`);
      continue;
    }
    await sleep(6000);

    const finalUrl = page.url();
    console.log(`  final url: ${finalUrl}`);
    if (/logon|login/i.test(finalUrl)) {
      console.log('  ! bounced to logon — session died');
      return;
    }

    // Collect all buttons + anchors matching export-like affordances
    const dump = await page.evaluate(() => {
      const results = [];
      const candidates = document.querySelectorAll(
        'button, a, [role="button"], [role="menuitem"], [data-testid], [class*="export" i], [class*="download" i], [class*="utility" i]'
      );
      for (const el of candidates) {
        const text = (el.innerText || el.textContent || '').trim().slice(0, 80);
        const ariaLabel = el.getAttribute('aria-label') || '';
        const dataTestId = el.getAttribute('data-testid') || '';
        const cls = el.className && typeof el.className === 'string' ? el.className.slice(0, 120) : '';
        const href = el.getAttribute('href') || '';
        if (!text && !ariaLabel && !dataTestId && !/export|download/i.test(cls)) continue;
        if (/export|download|csv|transactions|activity|more.?actions|options|menu/i.test(
          [text, ariaLabel, dataTestId, cls].join(' ')
        )) {
          results.push({
            tag: el.tagName.toLowerCase(),
            text,
            ariaLabel,
            dataTestId,
            cls: cls.length > 120 ? cls.slice(0, 120) + '…' : cls,
            href: href.length > 80 ? href.slice(0, 80) + '…' : href,
          });
        }
      }
      return {
        title: document.title,
        url: location.href,
        bodyStart: document.body ? document.body.innerText.slice(0, 400) : '',
        candidates: results.slice(0, 30),
      };
    });
    console.log('  title:', dump.title);
    console.log('  body preview:', JSON.stringify(dump.bodyStart.replace(/\s+/g, ' ').slice(0, 300)));
    console.log(`  ${dump.candidates.length} export-like candidates:`);
    for (const c of dump.candidates) {
      console.log('   •', JSON.stringify(c));
    }

    // If we see anything containing "Export" or "Download", try to screenshot for later reference
    const hasExport = dump.candidates.some((c) => /export|download/i.test(
      [c.text, c.ariaLabel, c.dataTestId, c.cls].join(' ')
    ));
    if (hasExport) {
      const shotPath = `/tmp/usaa-cc-${accountId.slice(-8)}.png`;
      await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
      console.log(`  screenshot → ${shotPath}`);
      return; // first good match per account is enough
    }
  }
}

async function main() {
  const { context, release } = await acquireBrowser({ headless: true });
  try {
    const page = await context.newPage();
    for (const acct of ACCOUNTS) {
      await probeAccount(page, acct.label, acct.id);
    }
    await page.close();
  } finally {
    await release();
  }
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
