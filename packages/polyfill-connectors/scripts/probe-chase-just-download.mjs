/**
 * Attempt the simplest download: current-display activity + QFX format.
 * If this works, we have a baseline. Date-range can come later.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const page = browser.contexts()[0].pages().find((p) => p.url().includes('chase.com'));

// Ensure QFX is set
await page.evaluate(() => {
  function walk(root, out = []) {
    root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); });
    return out;
  }
  const sel = walk(document).find((e) => e.id === 'downloadFileTypeOption');
  if (sel) {
    sel.setAttribute('value', 'QFX');
    sel.setAttribute('selected-index', '1');
    sel.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }
});
await new Promise((r) => setTimeout(r, 1500));

// Wire up download listener
const downloadPromise = page.waitForEvent('download', { timeout: 30000 });

// Click Download button — mds-button#download
await page.locator('mds-button#download').click({ timeout: 10000 });

try {
  const dl = await downloadPromise;
  const path = '/tmp/chase-test.qfx';
  await dl.saveAs(path);
  console.log('DOWNLOAD SAVED:', path);
  const fs = await import('node:fs/promises');
  const stat = await fs.stat(path);
  console.log('size:', stat.size);
  const head = await fs.readFile(path, 'utf8');
  console.log('first 300 chars:', head.slice(0, 300));
} catch (err) {
  console.log('download failed:', err.message);
  const text = (await page.locator('body').innerText().catch(() => '')).slice(0, 600);
  console.log('page state:', text.replace(/\s+/g, ' '));
}
await browser.close();
