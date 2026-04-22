/**
 * Smoke test for attachDownloadQueue against real Playwright download events.
 *
 * - Starts an in-memory HTTP server that serves N files
 * - Attaches the download queue to a context
 * - Triggers N downloads in a row
 * - Verifies all N were captured with correct content
 */

import { createServer } from 'node:http';
import { attachDownloadQueue } from '../src/download-queue.js';
import { acquireBrowser } from '../src/browser-profile.js';

const N = 5;

function makeServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      // Path like /files/3.txt -> respond with "file-3 content"
      const m = req.url.match(/\/files\/(\d+)\.txt/);
      if (m) {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="file-${m[1]}.txt"`,
        });
        res.end(`file-${m[1]} content`);
      } else {
        // Main page with N download links
        res.writeHead(200, { 'Content-Type': 'text/html' });
        const links = Array.from({ length: N }, (_, i) =>
          `<a id="a${i}" href="/files/${i}.txt" download>Download ${i}</a>`,
        ).join('\n');
        res.end(`<!DOCTYPE html><html><body>${links}</body></html>`);
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

async function main() {
  console.log('[setup] server...');
  const { server, url } = await makeServer();

  console.log('[setup] browser...');
  const { context, release } = await acquireBrowser({ headless: true });
  const q = attachDownloadQueue(context);

  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    console.log(`[test] triggering ${N} downloads in rapid succession...`);
    const received = [];
    for (let i = 0; i < N; i++) {
      const waitForDl = q.waitForNextDownload({ timeoutMs: 10000 });
      await page.locator(`a#a${i}`).click();
      const dl = await waitForDl;
      const path = await dl.path();
      const { readFile } = await import('node:fs/promises');
      const content = (await readFile(path)).toString();
      received.push({ i, filename: dl.suggestedFilename(), content });
      console.log(`  download ${i}: filename=${dl.suggestedFilename()} content=${JSON.stringify(content)}`);
    }

    const allOk = received.every((r) => r.content === `file-${r.i} content`);
    console.log(allOk ? '✅ PASS — all N downloads captured with correct content' : '❌ FAIL');

    // Second test: trigger all clicks first, THEN collect — tests ordering
    console.log(`[test 2] clicking all ${N} links before awaiting any...`);
    // Reset by navigating
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const promises = [];
    for (let i = 0; i < N; i++) {
      promises.push(q.waitForNextDownload({ timeoutMs: 10000 }));
    }
    // Click sequentially (Playwright serializes clicks on same page anyway)
    for (let i = 0; i < N; i++) {
      await page.locator(`a#a${i}`).click();
    }
    const dls = await Promise.all(promises);
    const filenames = dls.map((d) => d.suggestedFilename());
    console.log(`  got filenames: ${JSON.stringify(filenames)}`);
    // Files should be in click order
    const expectedOrder = Array.from({ length: N }, (_, i) => `file-${i}.txt`);
    const orderedMatch = JSON.stringify(filenames) === JSON.stringify(expectedOrder);
    console.log(orderedMatch ? '✅ PASS — order preserved' : '⚠️ order differs (may be OK for Playwright)');

    await page.close();
  } finally {
    q.detach();
    await release();
    server.close();
  }
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
