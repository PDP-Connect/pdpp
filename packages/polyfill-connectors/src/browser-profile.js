import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PROFILE_DIR = join(homedir(), '.pdpp', 'browser-profile');

export const BROWSER_CHANNEL = 'chrome';

export const VIEWPORT = { width: 1280, height: 800 };

export const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function ensureProfileDir() {
  if (!existsSync(PROFILE_DIR)) {
    mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
  }
}

export async function launchPersistentContext({ headless }) {
  ensureProfileDir();
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    channel: BROWSER_CHANNEL,
    viewport: VIEWPORT,
    userAgent: USER_AGENT,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-default-browser-check',
      '--no-first-run',
    ],
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  return context;
}

/**
 * Preferred entry point for headless connector runs. Returns `{ context,
 * release }`; `release()` disconnects the caller's CDP client but leaves the
 * shared daemon browser running so session-scoped cookies (e.g. USAA's
 * LtpaToken2) persist in memory across runs.
 *
 * See src/browser-daemon.js for the rationale. Set `PDPP_BROWSER_DAEMON=0`
 * to fall back to the legacy per-run launchPersistentContext path.
 */
export { acquireBrowser } from './browser-daemon.js';
