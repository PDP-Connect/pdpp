import { launchPersistentContext, PROFILE_DIR } from './browser-profile.js';
import { PLATFORMS } from './platform-probes.js';

function fmtLine(label, status) {
  const icon = status === 'ok' ? '✓' : status === 'pending' ? '·' : '?';
  return `  ${icon} ${label.padEnd(12)} ${status}`;
}

export async function bootstrapBrowser({ platforms = Object.keys(PLATFORMS) } = {}) {
  console.log(`Opening browser with persistent profile at ${PROFILE_DIR}`);
  console.log('Log into each tab, then close the browser when done.\n');

  const context = await launchPersistentContext({ headless: false });

  const targets = [];
  for (const key of platforms) {
    const p = PLATFORMS[key];
    if (!p) continue;
    const page = await context.newPage();
    await page.goto(p.bootstrapUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    targets.push({ key, platform: p });
  }

  const status = Object.fromEntries(platforms.map((k) => [k, 'pending']));
  const poll = setInterval(async () => {
    for (const { key, platform } of targets) {
      if (status[key] === 'ok') continue;
      try {
        const probe = await context.newPage();
        await probe.goto(platform.probeUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const ok = await platform.isLoggedIn(probe, context);
        await probe.close().catch(() => {});
        status[key] = ok ? 'ok' : 'pending';
      } catch {
        /* keep pending */
      }
    }
    console.log('\nStatus:');
    for (const k of platforms) console.log(fmtLine(PLATFORMS[k].label, status[k]));
    if (platforms.every((k) => status[k] === 'ok')) {
      console.log('\nAll platforms logged in. You can close the browser.');
    }
  }, 20000);

  await new Promise((resolve) => context.once('close', resolve));
  clearInterval(poll);

  console.log('\nBrowser closed. Final status:');
  for (const k of platforms) console.log(fmtLine(PLATFORMS[k].label, status[k]));
  console.log(`\nProfile saved at ${PROFILE_DIR}`);
  return status;
}

export async function probeBrowser({ platforms = Object.keys(PLATFORMS) } = {}) {
  console.log(`Probing logged-in state headlessly against profile at ${PROFILE_DIR}\n`);
  const context = await launchPersistentContext({ headless: true });
  const status = {};
  for (const key of platforms) {
    const platform = PLATFORMS[key];
    if (!platform) continue;
    const page = await context.newPage();
    try {
      await page.goto(platform.probeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      status[key] = (await platform.isLoggedIn(page, context)) ? 'ok' : 'logged_out';
    } catch (err) {
      status[key] = `error: ${err.message.split('\n')[0]}`;
    } finally {
      await page.close().catch(() => {});
    }
    console.log(fmtLine(platform.label, status[key]));
  }
  await context.close();
  return status;
}
