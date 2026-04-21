import { acquireBrowser } from '/home/user/code/pdpp/packages/polyfill-connectors/src/browser-profile.js';

const { context, release } = await acquireBrowser({ headless: true });
try {
  const page = await context.newPage();
  await page.goto('https://www.usaa.com/my/logon', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 5000));
  console.log('url:', page.url());
  console.log('title:', await page.title());
  const body = (await page.locator('body').innerText().catch(() => '')).slice(0, 600);
  console.log('--- body preview ---');
  console.log(body);
  console.log('---');
  const inputs = await page.evaluate(() => [...document.querySelectorAll('input')].map((i) => ({ name: i.name, type: i.type, id: i.id, placeholder: i.placeholder })));
  console.log('inputs:', JSON.stringify(inputs, null, 2));
  await page.screenshot({ path: '/tmp/usaa-login-state.png', fullPage: true });
  console.log('screenshot: /tmp/usaa-login-state.png');
  await page.close();
} finally {
  await release();
}
