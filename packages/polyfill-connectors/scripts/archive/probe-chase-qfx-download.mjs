/**
 * Drive the full Chase QFX download flow: select QFX file type, submit,
 * capture the resulting download.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const page = browser.contexts()[0].pages().find((p) => p.url().includes('chase.com'));

console.log('url:', page.url());

// 1. Set file type to QFX by writing to the mds-select's `value` attribute and firing change
const setFileType = await page.evaluate(() => {
  function walk(root, out = []) {
    root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); });
    return out;
  }
  const sel = walk(document).find((e) => e.id === 'downloadFileTypeOption');
  if (!sel) return { error: 'no select' };
  // Simulate user selection: update attributes the component reacts to
  sel.setAttribute('value', 'QFX');
  sel.setAttribute('selected-index', '1');
  // Dispatch input/change events the component might listen for
  sel.dispatchEvent(new CustomEvent('mds-select-change', { detail: { value: 'QFX', index: 1 }, bubbles: true, composed: true }));
  sel.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  sel.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  return { value: sel.getAttribute('value') };
});
console.log('set file type:', JSON.stringify(setFileType));
await new Promise((r) => setTimeout(r, 1500));

// 2. Check what's now visible — maybe a Date Range appears after picking QFX
const state = await page.evaluate(() => {
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
  const ft = els.find((e) => e.id === 'downloadFileTypeOption');
  const actOpts = els.find((e) => e.id === 'downloadActivityOptionId');
  const actRaw = actOpts?.getAttribute('options') || '[]';
  return {
    ft_value: ft?.getAttribute('value'),
    act_options: (() => { try { return JSON.parse(actRaw); } catch { return actRaw; } })(),
    dateInputs: els.filter((el) => isVis(el) && /mds-date|mds-input/i.test(el.tagName)).map((el) => ({
      tag: el.tagName.toLowerCase(), id: el.id, label: el.getAttribute('label'),
    })),
    visibleSubmitButtons: els.filter((el) => isVis(el) && (el.tagName === 'MDS-BUTTON' || el.tagName === 'BUTTON'))
      .filter((b) => /download|submit|continue/i.test((b.innerText || b.getAttribute?.('text') || b.getAttribute?.('aria-label') || '')))
      .map((b) => ({ tag: b.tagName.toLowerCase(), id: b.id, text: (b.innerText || '').slice(0, 40), ariaOrText: b.getAttribute?.('text') || b.getAttribute?.('aria-label') || '' })),
  };
});
console.log('state:', JSON.stringify(state, null, 2));
await browser.close();
