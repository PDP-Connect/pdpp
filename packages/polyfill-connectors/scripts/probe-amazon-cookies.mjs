import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const d = JSON.parse(readFileSync(join(homedir(), '.pdpp', 'browser-daemon.json'), 'utf8'));
const browser = await chromium.connectOverCDP(d.wsEndpoint);
const ctx = browser.contexts()[0];
const all = await ctx.cookies();
const amazon = all.filter((c) => c.domain.includes('amazon.'));
const domains = [...new Set(amazon.map((c) => c.domain))];
console.log('amazon domains:', domains);
console.log('count per domain:');
for (const dom of domains) console.log(`  ${dom}:`, amazon.filter((c) => c.domain === dom).length);
// Which ones look like auth/session cookies?
const authish = amazon.filter((c) => /session|sess|at|ubid|x-main|login|token|sid/i.test(c.name));
console.log('auth-ish cookies:', authish.map((c) => `${c.domain}/${c.name}`));
await browser.close();
