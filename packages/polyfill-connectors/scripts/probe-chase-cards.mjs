import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('chase.com'));
await page.goto('https://secure.chase.com/web/auth/dashboard#/dashboard/overview', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise((r) => setTimeout(r, 5000));

// Find the literal "$4,084.48" string and walk up to its card container
const info = await page.evaluate(() => {
  function walk(root, out = []) {
    root.querySelectorAll('*').forEach((el) => { out.push(el); if (el.shadowRoot) walk(el.shadowRoot, out); });
    return out;
  }
  const els = walk(document);

  // Leaf text nodes with balance-like pattern
  const balanceNodes = els.filter((el) => {
    if (el.children && el.children.length > 0) return false;
    const t = (el.textContent || '').trim();
    return /^\$[\d,]+\.\d{2}$/.test(t);
  });

  const cards = [];
  for (const bn of balanceNodes.slice(0, 5)) {
    // Walk up until we find an element whose text contains both the balance AND an account descriptor
    let cur = bn;
    for (let i = 0; i < 15 && cur; i++) {
      const text = (cur.innerText || cur.textContent || '').replace(/\s+/g, ' ').trim();
      if (/(Credit card|Checking|Savings|Money Market|External|Signature|Sapphire|Freedom|Amazon|Hyatt|United|Southwest|Ink|Platinum|Marriott|IHG|Disney|Prime)/i.test(text) && /\$[\d,]+\.\d{2}/.test(text)) {
        cards.push({
          tag: cur.tagName.toLowerCase(),
          cls: (typeof cur.className === 'string' ? cur.className : '').slice(0, 100),
          id: cur.id || null,
          testid: cur.getAttribute?.('data-testid') || null,
          text: text.slice(0, 300),
        });
        break;
      }
      cur = cur.parentElement || cur.getRootNode?.()?.host || null;
    }
  }

  // Also check for any data-testid that looks relevant
  const testIds = [...new Set(els.filter((e) => e.getAttribute?.('data-testid')).map((e) => e.getAttribute('data-testid')))].slice(0, 30);

  return { balance_nodes_count: balanceNodes.length, cards, testIds };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
