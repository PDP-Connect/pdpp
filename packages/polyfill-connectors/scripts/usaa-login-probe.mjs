import { acquireBrowser } from '/home/user/code/pdpp/packages/polyfill-connectors/src/browser-profile.js';
import { readFileSync } from 'node:fs';

// Load env
for (const line of readFileSync('/home/user/code/pdpp/.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)='?(.*?)'?$/);
  if (m) process.env[m[1]] = m[2];
}

const { context, release } = await acquireBrowser({ headless: true });
try {
  const page = await context.newPage();
  await page.goto('https://www.usaa.com/my/logon', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 5000));

  console.log('step 1 - fill username');
  await page.fill('input[name="memberId"]', process.env.USAA_USERNAME);

  // What button is on the page?
  const btns = await page.evaluate(() => [...document.querySelectorAll('button, input[type="submit"]')].map((b) => ({
    text: (b.innerText || b.value || '').trim(),
    id: b.id, type: b.type, cls: (b.className || '').toString().slice(0, 100)
  })));
  console.log('buttons:', JSON.stringify(btns, null, 2));

  // Try clicking "Next" by text
  const nextLocator = page.locator('button, input[type="submit"]').filter({ hasText: /^\s*Next\s*$/i }).first();
  const nextCount = await nextLocator.count();
  console.log('Next button count:', nextCount);
  if (nextCount > 0) {
    await nextLocator.click();
    console.log('clicked Next');
    await new Promise((r) => setTimeout(r, 4000));
    console.log('url after Next:', page.url());
    const passInputs = await page.evaluate(() => [...document.querySelectorAll('input')].map((i) => ({ name: i.name, type: i.type, id: i.id })));
    console.log('inputs after Next:', JSON.stringify(passInputs, null, 2));
  }
  await page.close();
} finally {
  await release();
}
