/**
 * End-to-end test of Chase connector's date_range path.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const connectorPath = new URL('../connectors/chase/index.js', import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(new URL('../manifests/chase.json', import.meta.url), 'utf8'));

const scope = {
  streams: manifest.streams.map((s) => ({
    name: s.name,
    time_range: s.name === 'transactions' ? { since: '2025-01-01', until: '2025-06-01' } : undefined,
  })),
};

const startMsg = { type: 'START', scope, state: null, persist_state: false };

const child = spawn(process.execPath, [connectorPath], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
let recordCount = 0;
let minDate = null, maxDate = null;
child.stdout.on('data', (d) => {
  buf += d.toString();
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === 'PROGRESS') console.log('>>', msg.message || '');
      else if (msg.type === 'DONE') console.log('DONE', JSON.stringify(msg));
      else if (msg.type === 'SKIP_RESULT') console.log('SKIP', JSON.stringify(msg));
      else if (msg.type === 'RECORD' && msg.stream === 'transactions') {
        recordCount++;
        const date = msg.data?.date;
        if (date) {
          if (!minDate || date < minDate) minDate = date;
          if (!maxDate || date > maxDate) maxDate = date;
        }
      }
    } catch {}
  }
});
child.stderr.on('data', (d) => process.stderr.write(d));

child.stdin.write(JSON.stringify(startMsg) + '\n');

await new Promise((resolve) => child.on('exit', resolve));
console.log(`\nTRANSACTIONS: ${recordCount}, range: ${minDate} .. ${maxDate}`);
