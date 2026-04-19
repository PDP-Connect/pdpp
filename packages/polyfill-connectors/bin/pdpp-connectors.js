#!/usr/bin/env node
import { bootstrapBrowser, probeBrowser } from '../src/bootstrap.js';

const [, , area, action, ...rest] = process.argv;

async function main() {
  if (area === 'browser' && action === 'bootstrap') {
    const platforms = rest.length ? rest : undefined;
    const status = await bootstrapBrowser({ platforms });
    process.exit(Object.values(status).every((s) => s === 'ok') ? 0 : 1);
  }
  if (area === 'browser' && action === 'probe') {
    const platforms = rest.length ? rest : undefined;
    const status = await probeBrowser({ platforms });
    process.exit(Object.values(status).every((s) => s === 'ok') ? 0 : 1);
  }
  console.error('Usage: pdpp-connectors browser bootstrap [platform...]');
  console.error('       pdpp-connectors browser probe     [platform...]');
  process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
