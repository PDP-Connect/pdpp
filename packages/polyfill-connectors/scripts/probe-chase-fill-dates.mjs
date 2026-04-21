import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const page = browser.contexts()[0].pages().find((p) => p.url().includes('chase.com'));

// Assumes page is already on download form w/ Date Range activity selected
// Fill From = 01/01/2025
const fromInput = page.locator('#accountActivityFromDate input').first();
await fromInput.click({ timeout: 5000 });
await fromInput.pressSequentially('01012025', { delay: 40 });
await new Promise((r) => setTimeout(r, 1500));

const toInput = page.locator('#accountActivityToDate input').first();
await toInput.click({ timeout: 5000 });
await toInput.pressSequentially('06012025', { delay: 40 });
await new Promise((r) => setTimeout(r, 1500));

// Verify values
const values = await page.evaluate(() => {
  function walk(root, out = []) { root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); }); return out; }
  const from = walk(document).find((e) => e.id === 'accountActivityFromDate');
  const to = walk(document).find((e) => e.id === 'accountActivityToDate');
  return {
    from_value: from?.getAttribute('value') || from?.getAttribute('selected-date'),
    from_inner: from?.shadowRoot?.querySelector('input')?.value,
    to_value: to?.getAttribute('value') || to?.getAttribute('selected-date'),
    to_inner: to?.shadowRoot?.querySelector('input')?.value,
  };
});
console.log('values after typing:', JSON.stringify(values));
await page.screenshot({ path: '/tmp/chase-dates-typed.png', fullPage: true }).catch(() => {});

// Now also fix file type to QFX via click-select (selection got reset earlier)
await page.locator('#select-downloadFileTypeOption').click();
await page.getByRole('option', { name: /^Quicken Web Connect/i }).click({ timeout: 10000 });
await new Promise((r) => setTimeout(r, 1500));

const ftVal = await page.evaluate(() => {
  function walk(root, out = []) { root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); }); return out; }
  return walk(document).find((e) => e.id === 'downloadFileTypeOption')?.getAttribute('value');
});
console.log('file type now:', ftVal);

// Attempt download
const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
await page.locator('mds-button#download').click({ timeout: 10000 });
try {
  const dl = await downloadPromise;
  const out = '/tmp/chase-dr-test.qfx';
  await dl.saveAs(out);
  const fs = await import('node:fs/promises');
  const stat = await fs.stat(out);
  console.log('file:', out, 'size:', stat.size);
  const content = await fs.readFile(out, 'utf8');
  const txnCount = (content.match(/<STMTTRN>/g) || []).length;
  console.log('STMTTRN count:', txnCount);
  const dates = [...content.matchAll(/<DTPOSTED>(\d{8})/g)].map((m) => m[1]);
  if (dates.length) console.log('date range:', dates[dates.length-1].slice(0,4)+'-'+dates[dates.length-1].slice(4,6)+'-'+dates[dates.length-1].slice(6,8), '..', dates[0].slice(0,4)+'-'+dates[0].slice(4,6)+'-'+dates[0].slice(6,8));
} catch (err) {
  console.log('download failed:', err.message);
  const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 500);
  console.log('page:', body.replace(/\s+/g, ' '));
}
await browser.close();
