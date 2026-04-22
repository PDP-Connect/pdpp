import { createServer } from 'node:http';
import { acquireBrowser } from '../src/browser-profile.js';
import { attachDownloadQueue } from '../src/download-queue.js';

const N = 5;
function makeServer() {
  return new Promise((res) => {
    const s = createServer((req, rs) => {
      const m = req.url.match(/\/files\/(\d+)\.txt/);
      if (m) {
        rs.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="f${m[1]}.txt"` });
        rs.end(`c-${m[1]}`);
      } else {
        rs.writeHead(200, { 'Content-Type': 'text/html' });
        rs.end(Array.from({length:N}, (_,i)=>`<a id="a${i}" href="/files/${i}.txt" download>D${i}</a>`).join('\n'));
      }
    });
    s.listen(0, '127.0.0.1', () => res({ s, url: `http://127.0.0.1:${s.address().port}` }));
  });
}

const { s, url } = await makeServer();
const { context, release } = await acquireBrowser({ headless: true });
const page = await context.newPage();
const q = attachDownloadQueue(page);
await page.goto(url);
for (let i = 0; i < N; i++) {
  const w = q.waitForNextDownload({ timeoutMs: 10000 });
  await page.locator(`a#a${i}`).click();
  const dl = await w;
  console.log(`dl ${i}: ${dl.suggestedFilename()}`);
}
q.detach();
await page.close();
await release();
s.close();
