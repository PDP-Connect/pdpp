/**
 * Minimal debug: does context.on('download') fire at all via CDP?
 */
import { createServer } from 'node:http';
import { acquireBrowser } from '/home/user/code/pdpp/packages/polyfill-connectors/src/browser-profile.js';

function makeServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === '/file') {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="hi.txt"',
        });
        res.end('hello');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<a id="a" href="/file" download>Download</a>');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

const { server, url } = await makeServer();
const { context, release } = await acquireBrowser({ headless: true });

console.log('context type:', context.constructor?.name);
context.on('download', (d) => {
  console.log('[context.on download] fired:', d.url());
});

const page = await context.newPage();
page.on('download', (d) => {
  console.log('[page.on download] fired:', d.url());
});

console.log('[nav]', url);
await page.goto(url);

// Try page.waitForEvent to see if it even fires
const waitP = page.waitForEvent('download', { timeout: 8000 })
  .then((d) => ({ kind: 'download', filename: d.suggestedFilename() }))
  .catch((e) => ({ kind: 'error', msg: e.message }));

console.log('[click]');
await page.locator('a#a').click();

const outcome = await waitP;
console.log('[outcome]', JSON.stringify(outcome));

// Wait a sec to catch late events
await new Promise((r) => setTimeout(r, 2000));

await page.close();
await release();
server.close();
