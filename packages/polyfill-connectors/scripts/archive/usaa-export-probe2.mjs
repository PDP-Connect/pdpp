/**
 * Focused diagnostic: open USAA's Checking (3602) page, click Export, dump
 * what the dialog looks like — HTML, element names, download event behavior.
 *
 * No state changes. Just observes.
 */

import { acquireBrowser } from '../src/browser-profile.js';
import { attachDownloadQueue } from '../src/download-queue.js';

const ACCOUNT_ID = '0002-qjnDfcbON1LHLxlg2AtzmEHo'; // Checking 3602

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { context, release } = await acquireBrowser({ headless: true });
  const downloadQueue = attachDownloadQueue(context);
  try {
    const page = await context.newPage();

    console.log(`[nav] opening checking account page`);
    await page.goto(`https://www.usaa.com/my/checking/?accountId=${ACCOUNT_ID}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await sleep(6000);

    console.log(`[nav] final url: ${page.url()}`);
    console.log(`[nav] title: ${await page.title()}`);

    // Dump any utility bar / export button
    const exportCandidates = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('button, a')) {
        const text = (el.innerText || '').trim();
        const cls = (el.className && typeof el.className === 'string' ? el.className : '');
        const aria = el.getAttribute('aria-label') || '';
        if (/export|download|csv/i.test([text, cls, aria].join(' '))) {
          out.push({
            tag: el.tagName.toLowerCase(),
            text: text.slice(0, 80),
            cls: cls.slice(0, 120),
            aria: aria.slice(0, 80),
          });
        }
      }
      return out.slice(0, 20);
    });
    console.log(`[export candidates]`, JSON.stringify(exportCandidates, null, 2));

    // Click the first known Export button pattern
    const exportBtn = page.locator('button.ent-as-utility-bar__item.export').first();
    const hasExport = (await exportBtn.count().catch(() => 0)) > 0;
    console.log(`[export button found: ${hasExport}]`);
    if (!hasExport) {
      await page.screenshot({ path: '/tmp/usaa-probe-no-export.png', fullPage: true }).catch(() => {});
      console.log('[screenshot] /tmp/usaa-probe-no-export.png');
      return;
    }

    console.log(`[click] export`);
    await exportBtn.click({ timeout: 5000 });
    await sleep(3000);

    // Dump dialog state
    const dialog = await page.evaluate(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"], dialog')];
      if (!dialogs.length) return { open: false, note: 'no [role=dialog]' };
      const d = dialogs[0];
      return {
        open: true,
        count: dialogs.length,
        cls: (d.className || '').toString().slice(0, 150),
        outer_200: (d.outerHTML || '').slice(0, 200),
        text: (d.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 500),
        selects: [...d.querySelectorAll('select')].map((s) => ({
          name: s.name, id: s.id, value: s.value,
          options: [...s.options].map((o) => ({ v: o.value, t: o.text })).slice(0, 10),
        })),
        inputs: [...d.querySelectorAll('input')].map((i) => ({
          name: i.name, type: i.type, placeholder: i.placeholder,
        })),
        buttons: [...d.querySelectorAll('button')].map((b) => ({
          text: (b.innerText || '').trim().slice(0, 50),
          type: b.type,
          disabled: b.disabled,
          cls: (b.className || '').toString().slice(0, 100),
        })),
      };
    });
    console.log(`[dialog]`, JSON.stringify(dialog, null, 2));

    await page.screenshot({ path: '/tmp/usaa-probe-dialog.png', fullPage: true }).catch(() => {});
    console.log('[screenshot] /tmp/usaa-probe-dialog.png');

    await page.close();
  } finally {
    downloadQueue.detach();
    await release();
  }
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
