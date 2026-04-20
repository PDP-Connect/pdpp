/**
 * Full dialog walk: click Export → select date-range → dump form fields
 * → fill dates → check if submit enables → click → observe what happens.
 */

import { acquireBrowser } from '/home/user/code/pdpp/packages/polyfill-connectors/src/browser-profile.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dumpDialog(page) {
  return page.evaluate(() => {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')];
    if (!dialogs.length) return { open: false };
    const d = dialogs[0];
    return {
      open: true,
      selects: [...d.querySelectorAll('select')].map((s) => ({
        name: s.name, id: s.id, value: s.value,
        options_n: s.options.length,
      })),
      inputs: [...d.querySelectorAll('input')].map((i) => ({
        name: i.name, id: i.id, type: i.type, placeholder: i.placeholder,
        value: (i.value || '').slice(0, 40), disabled: i.disabled,
      })),
      buttons: [...d.querySelectorAll('button')].map((b) => ({
        text: (b.innerText || '').trim().slice(0, 60),
        type: b.type, disabled: b.disabled,
        cls: (b.className || '').toString().slice(0, 120),
      })),
      date_pickers: [...d.querySelectorAll('[class*="DatePicker" i], [data-testid*="date" i]')].map((n) => ({
        tag: n.tagName.toLowerCase(),
        cls: (n.className || '').toString().slice(0, 120),
        id: n.id, testid: n.getAttribute('data-testid'),
      })),
    };
  });
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

    const exportBtn = page.locator('button.as_credit__utility-bar-item.as_credit__export');
    await exportBtn.click();
    console.log('[clicked Export]');
    await sleep(3000);

    console.log('\n--- after Export click ---');
    console.log(JSON.stringify(await dumpDialog(page), null, 2));

    await page.selectOption('select[name="selectionType"]', 'date-range');
    console.log('\n[selected date-range]');
    await sleep(2000);

    console.log('\n--- after selecting date-range ---');
    console.log(JSON.stringify(await dumpDialog(page), null, 2));

    // Screenshot the dialog in this expanded state
    await page.screenshot({ path: '/tmp/usaa-cc-dialog-expanded.png', fullPage: true }).catch(() => {});
    console.log('[screenshot] /tmp/usaa-cc-dialog-expanded.png');

    await page.close();
  } finally {
    await release();
  }
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
