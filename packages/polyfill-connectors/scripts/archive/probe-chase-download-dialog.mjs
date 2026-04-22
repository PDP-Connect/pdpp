import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const page = browser.contexts()[0].pages().find((p) => p.url().includes('chase.com'));

await page.locator('#quick-action-download-activity-tooltip').click({ timeout: 10000 });
await new Promise((r) => setTimeout(r, 3000));

const dlg = await page.evaluate(() => {
  function walk(root, out = []) {
    root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); });
    return out;
  }
  const els = walk(document);
  const isVis = (el) => {
    const cs = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && b.width > 0 && b.height > 0;
  };
  // dialog
  const dialogs = els.filter((el) => isVis(el) && (/dialog/i.test(el.tagName) || el.getAttribute?.('role') === 'dialog'));
  // selects
  const selects = [...document.querySelectorAll('select')].filter(isVis).map((s) => ({
    name: s.name, id: s.id,
    options: [...s.options].map((o) => ({ value: o.value, text: o.text })).slice(0, 10),
  }));
  // radios / format chooser
  const radios = els.filter((el) => isVis(el) && el.tagName === 'INPUT' && el.type === 'radio').map((r) => ({
    name: r.name, value: r.value, id: r.id, label: document.querySelector(`label[for="${r.id}"]`)?.innerText?.trim() || null,
  }));
  // date inputs
  const dateInputs = els.filter((el) => isVis(el) && el.tagName === 'INPUT' && (el.type === 'date' || /date/i.test(el.name || '') || /date/i.test(el.id || '') || /date/i.test(el.placeholder || ''))).map((i) => ({
    name: i.name, id: i.id, type: i.type, placeholder: i.placeholder, value: i.value,
  }));
  // buttons in dialog
  const buttons = els.filter((el) => isVis(el) && (el.tagName === 'BUTTON' || el.tagName === 'MDS-BUTTON')).map((b) => ({
    tag: b.tagName.toLowerCase(),
    id: b.id,
    text: (b.innerText || b.getAttribute?.('text') || '').slice(0, 40),
    aria: (b.getAttribute?.('aria-label') || '').slice(0, 60),
  })).slice(0, 20);
  const bodyPreview = (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 600);
  return { dialog_count: dialogs.length, selects, radios, dateInputs, buttons, bodyPreview };
});
console.log(JSON.stringify(dlg, null, 2));
await page.screenshot({ path: '/tmp/chase-download-dialog.png', fullPage: true }).catch(() => {});
console.log('screenshot: /tmp/chase-download-dialog.png');
await browser.close();
