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

import { chromium } from 'playwright';
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
  log(`launching Chromium (headless=${headless}) profile=${PROFILE_DIR}`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    channel: BROWSER_CHANNEL,
    viewport: VIEWPORT,
    userAgent: USER_AGENT,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-default-browser-check',
      '--no-first-run',
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
    ],
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
