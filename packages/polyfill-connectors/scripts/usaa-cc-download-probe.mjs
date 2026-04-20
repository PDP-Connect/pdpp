/**
 * End-to-end CC export probe: click Export, select date-range, fill dates,
 * click submit, wait for download.
 */

import { acquireBrowser } from '/home/user/code/pdpp/packages/polyfill-connectors/src/browser-profile.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mmddyyyy(iso) {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

async function main() {
  const { context, release } = await acquireBrowser({ headless: true });
  try {
    const page = await context.newPage();
    const accountId = '0002-PnwSxCt5HLlzn7raPcAK';
    await page.goto(`https://www.usaa.com/my/credit-card/?accountId=${accountId}`, {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await sleep(8000);

    await page.locator('button.as_credit__utility-bar-item.as_credit__export').click();
    console.log('[clicked Export]');
    await sleep(3000);

    await page.selectOption('select[name="selectionType"]', 'date-range');
    console.log('[selected date-range]');
    await sleep(2000);

    const fromIn = page.locator('input[name="fromDate"], input[name="startDate"]').first();
    const endIn = page.locator('input[name="endDate"]').first();

    await fromIn.click();
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Delete').catch(() => {});
    await fromIn.pressSequentially(mmddyyyy('2025-04-20'), { delay: 30 });
    await endIn.click();
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Delete').catch(() => {});
    await endIn.pressSequentially(mmddyyyy('2026-04-20'), { delay: 30 });
    console.log('[filled dates]');
    await sleep(2000);

    // Dump submit button state
    const state = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]');
      if (!d) return null;
      const submits = [...d.querySelectorAll('button[type="submit"]')].map((b) => ({
        text: (b.innerText || '').trim().slice(0, 80),
        disabled: b.disabled,
        ariaDisabled: b.getAttribute('aria-disabled'),
      }));
      return { submits };
    });
    console.log('[submit state]', JSON.stringify(state));

    const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
    await page.locator('[role="dialog"] button[type="submit"]').first().click();
    console.log('[clicked submit]');

    try {
      const download = await downloadPromise;
      const path = '/tmp/usaa-cc-export.csv';
      await download.saveAs(path);
      console.log(`[download saved] ${path}`);
      const stats = (await (await import('node:fs/promises')).stat(path));
      console.log(`[size] ${stats.size} bytes`);
    } catch (err) {
      console.log(`[download failed] ${err.message}`);
      const dialogHtml = await page.locator('[role="dialog"]').first().innerHTML().catch(() => '');
      console.log('[dialog after submit]', dialogHtml.replace(/\s+/g, ' ').slice(0, 800));
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
