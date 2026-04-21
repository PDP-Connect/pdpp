/**
 * Drive a test download with Activity="All transactions" + File type=QFX.
 * Save to /tmp/chase-all.qfx and report size + transaction count.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const page = browser.contexts()[0].pages().find((p) => p.url().includes('chase.com'));

// Fresh nav
const url = 'https://secure.chase.com/web/auth/dashboard#/dashboard/accountDetails/downloadAccountTransactions/index;params=CARD,BAC,1212486749';
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.locator('#downloadFileTypeOption').waitFor({ state: 'attached', timeout: 15000 });

// Set QFX
await page.evaluate(() => {
  function walk(root, out = []) { root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); }); return out; }
  const sel = walk(document).find((e) => e.id === 'downloadFileTypeOption');
  if (sel) {
    sel.setAttribute('value', 'QFX');
    sel.setAttribute('selected-index', '1');
    sel.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }
});
await page.locator('#downloadFileTypeOption[value="QFX"]').waitFor({ state: 'attached', timeout: 3000 }).catch(() => {});

// Open Activity dropdown + click "All transactions"
await page.locator('#select-downloadActivityOptionId').click({ timeout: 10000 });
// role=option is the visible, clickable target. getByText resolves to a hidden a11y span.
await page.getByRole('option', { name: /^All transactions$/i }).click({ timeout: 10000 });
console.log('selected: All transactions');

// Wait for any async form update
await page.locator('mds-button#download').waitFor({ state: 'visible', timeout: 5000 });

const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
await page.locator('mds-button#download').click({ timeout: 10000 });
const dl = await downloadPromise;
const out = '/tmp/chase-all.qfx';
await dl.saveAs(out);
const fs = await import('node:fs/promises');
const stat = await fs.stat(out);
console.log('file:', out, 'size:', stat.size);
const content = await fs.readFile(out, 'utf8');
const txnCount = (content.match(/<STMTTRN>/g) || []).length;
console.log('STMTTRN count:', txnCount);
const firstDate = content.match(/<DTPOSTED>(\d{8})/);
const dates = [...content.matchAll(/<DTPOSTED>(\d{8})/g)].map((m) => m[1]);
if (dates.length) console.log('date range:', dates[dates.length-1].slice(0,4)+'-'+dates[dates.length-1].slice(4,6)+'-'+dates[dates.length-1].slice(6,8), '..', dates[0].slice(0,4)+'-'+dates[0].slice(4,6)+'-'+dates[0].slice(6,8));
await browser.close();
