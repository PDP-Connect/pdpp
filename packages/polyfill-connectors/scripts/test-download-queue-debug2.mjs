/**
 * Does page.on('download') handle multiple downloads in sequence?
 */
import { createServer } from 'node:http';
import { acquireBrowser } from '/home/user/code/pdpp/packages/polyfill-connectors/src/browser-profile.js';

function makeServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const m = req.url.match(/\/file\/(\d+)/);
      if (m) {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="f${m[1]}.txt"`,
        });
        res.end(`content-${m[1]}`);
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <a id="a0" href="/file/0" download>D0</a>
          <a id="a1" href="/file/1" download>D1</a>
          <a id="a2" href="/file/2" download>D2</a>
        `);
      }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

const { server, url } = await makeServer();
const { context, release } = await acquireBrowser({ headless: true });

const downloads = [];
const page = await context.newPage();
page.on('download', (d) => downloads.push({ url: d.url(), filename: d.suggestedFilename() }));

await page.goto(url);

for (let i = 0; i < 3; i++) {
  const waitP = page.waitForEvent('download', { timeout: 8000 });
  await page.locator(`a#a${i}`).click();
  const dl = await waitP;
  console.log(`[dl ${i}]`, dl.suggestedFilename());
}

await new Promise((r) => setTimeout(r, 500));
console.log('[page.on aggregated]', downloads.map((d) => d.filename).join(', '));

await page.close();
await release();
server.close();
