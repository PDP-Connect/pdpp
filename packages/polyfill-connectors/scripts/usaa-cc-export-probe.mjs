/**
 * Click the credit-card Export button and dump whatever dialog opens.
 */

import { acquireBrowser } from '/home/user/code/pdpp/packages/polyfill-connectors/src/browser-profile.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { context, release } = await acquireBrowser({ headless: true });
  try {
    const page = await context.newPage();
    const accountId = '0002-PnwSxCt5HLlzn7raPcAK';
    const url = `https://www.usaa.com/my/credit-card/?accountId=${accountId}`;

    console.log(`[nav] ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(8000);

    const btn = page.locator('button.as_credit__utility-bar-item.as_credit__export');
    const count = await btn.count();
    console.log(`[export btn] found ${count}`);
    if (!count) return;

    await btn.first().click({ timeout: 5000 });
    console.log('[clicked] waiting for dialog');
    await sleep(4000);

    const dialogInfo = await page.evaluate(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"], dialog, .usaa-dialog, [class*="dialog" i], [class*="modal" i]')];
      return {
        dialog_count: dialogs.length,
        dialogs: dialogs.slice(0, 3).map((d) => ({
          cls: (d.className || '').toString().slice(0, 120),
          text: (d.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 500),
          selects: [...d.querySelectorAll('select')].map((s) => ({
            name: s.name || null,
            id: s.id || null,
            options: [...s.options].map((o) => ({ value: o.value, text: o.text })).slice(0, 15),
          })),
          inputs: [...d.querySelectorAll('input')].map((i) => ({
            name: i.name || null,
            type: i.type,
            placeholder: i.placeholder || null,
            value: i.value ? i.value.slice(0, 40) : '',
          })),
          buttons: [...d.querySelectorAll('button, [role="button"]')].map((b) => ({
            text: (b.innerText || '').trim().slice(0, 40),
            type: b.type || null,
            cls: (b.className || '').toString().slice(0, 80),
          })),
        })),
      };
    });
    console.log(JSON.stringify(dialogInfo, null, 2));

    await page.screenshot({ path: '/tmp/usaa-cc-export-dialog.png', fullPage: true }).catch(() => {});
    console.log('[screenshot] /tmp/usaa-cc-export-dialog.png');

    await page.close();
  } finally {
    await release();
  }
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
