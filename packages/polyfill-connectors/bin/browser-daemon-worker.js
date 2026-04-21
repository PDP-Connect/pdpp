#!/usr/bin/env node
/**
 * Browser daemon worker. Launches a persistent Chromium context with
 * `--remote-debugging-port=0`, reads the assigned port from Chromium's
 * `DevToolsActivePort` file, writes the CDP ws endpoint to the discovery
 * file, and waits for SIGTERM to shut down cleanly.
 *
 * Not intended to be invoked by humans directly. `browser-daemon.js` spawns
 * this as a detached process.
 */

// Use rebrowser-playwright which patches the Runtime.Enable CDP leak that
// Akamai Bot Manager uses to classify headless/automated Chromium. Drop-in
// compatible with Playwright's API. See:
//   https://github.com/rebrowser/rebrowser-patches
//   https://rebrowser.net/blog/how-to-fix-runtime-enable-cdp-detection-of-puppeteer-playwright-and-other-automation-libraries
import { chromium } from 'rebrowser-playwright';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROFILE_DIR = join(homedir(), '.pdpp', 'browser-profile');
const PDPP_DIR = join(homedir(), '.pdpp');
const DISCOVERY_PATH = join(PDPP_DIR, 'browser-daemon.json');
const DEVTOOLS_PORT_FILE = join(PROFILE_DIR, 'DevToolsActivePort');

const BROWSER_CHANNEL = 'chrome';
const VIEWPORT = { width: 1280, height: 800 };
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
}

function log(msg) {
  process.stderr.write(`[browser-daemon ${new Date().toISOString()}] ${msg}\n`);
}

async function waitForDevToolsPort(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(DEVTOOLS_PORT_FILE)) {
      try {
        const content = readFileSync(DEVTOOLS_PORT_FILE, 'utf8').trim();
        const [portStr, browserPath] = content.split('\n');
        const port = Number(portStr);
        if (port && browserPath) {
          return { port, browserPath };
        }
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('DevToolsActivePort did not appear within timeout');
}

async function main() {
  ensureDir(PDPP_DIR);
  ensureDir(PROFILE_DIR);

  const stalePort = existsSync(DEVTOOLS_PORT_FILE);
  if (stalePort) {
    try { unlinkSync(DEVTOOLS_PORT_FILE); } catch {}
  }

  const headless = process.env.PDPP_BROWSER_DAEMON_HEADLESS !== '0';
  const xvfb = process.env.PDPP_BROWSER_DAEMON_XVFB === '1';
  log(`launching Chromium (headless=${headless}, xvfb=${xvfb}, DISPLAY=${process.env.DISPLAY || '<unset>'}) profile=${PROFILE_DIR}`);

  // Flags split by headed vs headless. Some flags (`--hide-scrollbars`,
  // `--mute-audio`, SwiftShader-only GPU) are documented tells that Akamai's
  // bot-score uses to classify headless Chromium. Keep them OFF in headful
  // mode so the runtime fingerprint matches a real browser.
  const baseArgs = [
    '--disable-blink-features=AutomationControlled',
    '--no-default-browser-check',
    '--no-first-run',
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    // Disable the headed Chrome download-bubble UI. In headed mode, the
    // bubble takes ownership of the download stream and races with
    // Playwright's CDP-based `Playwright.download` interception — so the
    // first download in a run fires, but subsequent ones never dispatch
    // the download event. See microsoft/playwright#40158 (open 2026-04).
    '--disable-features=DownloadBubble,DownloadBubbleV2,DownloadBubbleV3',
  ];

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    channel: BROWSER_CHANNEL,
    viewport: VIEWPORT,
    userAgent: USER_AGENT,
    args: baseArgs,
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const { port, browserPath } = await waitForDevToolsPort();
  const wsEndpoint = `ws://127.0.0.1:${port}${browserPath}`;

  const info = {
    pid: process.pid,
    wsEndpoint,
    port,
    startedAt: new Date().toISOString(),
    profileDir: PROFILE_DIR,
    headless,
  };
  writeFileSync(DISCOVERY_PATH, JSON.stringify(info, null, 2));
  log(`ready pid=${process.pid} ws=${wsEndpoint}`);

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}, closing context`);
    try { await context.close(); } catch (err) { log(`context.close error: ${err.message}`); }
    try { rmSync(DISCOVERY_PATH, { force: true }); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  // If the browser itself dies, tear down.
  context.on('close', () => {
    log('context closed externally');
    try { rmSync(DISCOVERY_PATH, { force: true }); } catch {}
    process.exit(0);
  });

  // Keep event loop alive.
  setInterval(() => {}, 1 << 30);
}

main().catch((err) => {
  log(`fatal: ${err.stack || err.message}`);
  try { rmSync(DISCOVERY_PATH, { force: true }); } catch {}
  process.exit(1);
});
