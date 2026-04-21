/**
 * Long-lived browser daemon for connectors.
 *
 * WHY: Chromium drops session-scoped cookies (no Expires/Max-Age) when the
 * process exits. Banking sites like USAA use session cookies for their actual
 * auth tokens (LtpaToken2, AST, MemberGlobalSession). Keeping one Chromium
 * process alive across connector runs preserves those cookies in memory.
 *
 * Model: one shared daemon, one persistent profile. Connectors attach via
 * CDP (`chromium.connectOverCDP`) and get an isolated BrowserContext each.
 * A lockfile serializes access to avoid profile-lock surprises.
 *
 * Lifecycle: lazy auto-start on first `acquireBrowser()` call. Explicit
 * `start|stop|status` commands for humans. No idle timeout in v1.
 *
 * Opt out: set `PDPP_BROWSER_DAEMON=0` to fall back to per-run
 * launchPersistentContext (the legacy path).
 */

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  openSync,
  closeSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Duplicated (rather than imported from ./browser-profile.js) to avoid a
// circular import — browser-profile.js re-exports acquireBrowser from here.
const PROFILE_DIR = join(homedir(), '.pdpp', 'browser-profile');

const PDPP_DIR = join(homedir(), '.pdpp');
const DISCOVERY_PATH = join(PDPP_DIR, 'browser-daemon.json');
const LOCK_PATH = join(PDPP_DIR, 'browser-daemon.lock');
const LOG_PATH = join(PDPP_DIR, 'browser-daemon.log');
const WORKER_PATH = fileURLToPath(
  new URL('../bin/browser-daemon-worker.js', import.meta.url)
);

function ensurePdppDir() {
  if (!existsSync(PDPP_DIR)) mkdirSync(PDPP_DIR, { recursive: true, mode: 0o700 });
}

export function readDiscovery() {
  try {
    return JSON.parse(readFileSync(DISCOVERY_PATH, 'utf8'));
  } catch {
    return null;
  }
}

export function writeDiscovery(info) {
  ensurePdppDir();
  writeFileSync(DISCOVERY_PATH, JSON.stringify(info, null, 2));
}

function removeDiscovery() {
  try { rmSync(DISCOVERY_PATH, { force: true }); } catch {}
}

function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function probeCdp(wsEndpoint, timeoutMs = 2000) {
  try {
    const browser = await chromium.connectOverCDP(wsEndpoint, { timeout: timeoutMs });
    await browser.close().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

export async function daemonStatus() {
  const info = readDiscovery();
  if (!info) return { running: false };
  const alive = isPidAlive(info.pid);
  if (!alive) return { running: false, stale: true, info };
  const reachable = await probeCdp(info.wsEndpoint);
  return { running: alive && reachable, info, reachable, alive };
}

async function waitForDiscoveryReady(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = readDiscovery();
    if (info && info.wsEndpoint && isPidAlive(info.pid)) {
      if (await probeCdp(info.wsEndpoint, 1500)) return info;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('browser daemon did not become ready within timeout');
}

function clearStaleProfileLock() {
  // Chromium writes PROFILE_DIR/SingletonLock when in use. If a previous
  // launch crashed, the lock remains and blocks new launches.
  const singleton = join(PROFILE_DIR, 'SingletonLock');
  if (!existsSync(singleton)) return;
  try { unlinkSync(singleton); } catch {}
}

/**
 * Start the browser daemon.
 *
 * @param {object} opts
 * @param {boolean} [opts.headless=true] - Run Chromium headless. Default true
 *   so most connectors (YNAB, Gmail, USAA) run unattended. Set false for
 *   connectors that trip anti-bot on the headless build (Chase/Amazon).
 * @param {boolean} [opts.xvfb=false] - Wrap the launch under `xvfb-run` so
 *   Chromium can render into a virtual display. Use with headless=false to
 *   get a real rendered browser that bypasses anti-bot detection without
 *   requiring a human-visible desktop session. This is the standard
 *   unattended-operation answer for Akamai-protected sites (Chase).
 */
export async function startDaemon({ headless = true, xvfb = false } = {}) {
  ensurePdppDir();
  const existing = await daemonStatus();
  if (existing.running) return existing.info;
  if (existing.info && isPidAlive(existing.info.pid)) {
    try { process.kill(existing.info.pid, 'SIGTERM'); } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  removeDiscovery();
  clearStaleProfileLock();

  const logFd = openSync(LOG_PATH, 'a');

  // `xvfb-run` wraps the command in a virtual X display so a "headful"
  // Chromium can paint without requiring an attached monitor. Must use
  // `--auto-servernum` so concurrent daemons get different display numbers.
  const cmd = xvfb ? 'xvfb-run' : process.execPath;
  const args = xvfb
    ? ['--auto-servernum', '--server-args=-screen 0 1920x1080x24', process.execPath, WORKER_PATH]
    : [WORKER_PATH];

  const child = spawn(cmd, args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      PDPP_BROWSER_DAEMON_HEADLESS: headless ? '1' : '0',
      PDPP_BROWSER_DAEMON_XVFB: xvfb ? '1' : '0',
    },
  });
  child.unref();
  closeSync(logFd);

  return await waitForDiscoveryReady();
}

export async function stopDaemon() {
  const info = readDiscovery();
  if (!info) return { stopped: false, reason: 'no_discovery' };
  if (!isPidAlive(info.pid)) {
    removeDiscovery();
    return { stopped: false, reason: 'not_running' };
  }
  try { process.kill(info.pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 40; i++) {
    if (!isPidAlive(info.pid)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (isPidAlive(info.pid)) {
    try { process.kill(info.pid, 'SIGKILL'); } catch {}
  }
  removeDiscovery();
  return { stopped: true, pid: info.pid };
}

async function acquireLock(timeoutMs = 120000) {
  ensurePdppDir();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const fd = openSync(LOCK_PATH, 'wx');
      writeFileSync(LOCK_PATH, String(process.pid));
      closeSync(fd);
      return true;
    } catch (err) {
      // Check whether holder is alive; steal if not.
      try {
        const pid = Number(readFileSync(LOCK_PATH, 'utf8')) || 0;
        if (pid && !isPidAlive(pid)) {
          try { unlinkSync(LOCK_PATH); } catch {}
          continue;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error('could not acquire browser daemon lock within timeout');
}

function releaseLock() {
  try { unlinkSync(LOCK_PATH); } catch {}
}

/**
 * Acquire a BrowserContext from the daemon. Auto-starts the daemon if
 * necessary. Returns `{ context, release }`. `release` closes the context
 * (NOT the browser) and frees the lock.
 *
 * If `PDPP_BROWSER_DAEMON=0`, falls back to launchPersistentContext for
 * backwards compatibility.
 */
export async function acquireBrowser({ headless = true } = {}) {
  if (process.env.PDPP_BROWSER_DAEMON === '0') {
    const { launchPersistentContext } = await import('./browser-profile.js');
    const context = await launchPersistentContext({ headless });
    return { context, release: async () => { await context.close().catch(() => {}); } };
  }

  let status = await daemonStatus();
  if (!status.running) {
    await startDaemon({ headless });
    status = await daemonStatus();
    if (!status.running) throw new Error('browser daemon failed to start');
  }

  await acquireLock();
  let browser;
  let defaultCtx;
  let context;
  try {
    browser = await chromium.connectOverCDP(status.info.wsEndpoint);

    // WHY an isolated context (not browser.contexts()[0]):
    // Playwright's CDP download-interception attaches Browser.setDownloadBehavior
    // to a single "default" target when we reuse the persistent context. In
    // headed Chromium that races with Chrome's download-bubble — first
    // download fires, subsequent downloads never dispatch the `download`
    // event. See microsoft/playwright#40158.
    //
    // The recommended workaround is `browser.newContext({ acceptDownloads:
    // true })`. That gives reliable per-download event dispatch. The cost:
    // the new context starts with no cookies. We carry cookies over from the
    // persistent default context so auth (USAA LtpaToken2 etc.) is available
    // inside the isolated context for this caller, and we sync new cookies
    // back to the default context on release so session progress persists.
    const contexts = browser.contexts();
    if (!contexts.length) {
      throw new Error('daemon browser has no contexts');
    }
    defaultCtx = contexts[0];

    // Copy cookies from the persistent context to the isolated one.
    const cookies = await defaultCtx.cookies();
    context = await browser.newContext({ acceptDownloads: true });
    if (cookies.length > 0) {
      // Playwright's addCookies is strict about the shape it accepts.
      // Filter fields that can come out of cookies() and fail roundtrip.
      const sanitized = cookies
        .filter((c) => c.domain && c.path)
        .map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite === 'None' || c.sameSite === 'Lax' || c.sameSite === 'Strict'
            ? c.sameSite
            : undefined,
        }));
      await context.addCookies(sanitized).catch(() => {});
    }

    return {
      context,
      release: async () => {
        // Persist cookies back to the default context so the daemon's
        // persistent profile has the latest auth state for the next caller.
        try {
          const freshCookies = await context.cookies();
          if (freshCookies.length > 0) {
            const sanitized = freshCookies
              .filter((c) => c.domain && c.path)
              .map((c) => ({
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path,
                expires: c.expires,
                httpOnly: c.httpOnly,
                secure: c.secure,
                sameSite: c.sameSite === 'None' || c.sameSite === 'Lax' || c.sameSite === 'Strict'
                  ? c.sameSite
                  : undefined,
              }));
            await defaultCtx.addCookies(sanitized).catch(() => {});
          }
        } catch {
          // If cookie copy-back fails, the session still works for this run;
          // worst case the next run starts with slightly older cookies.
        }
        try {
          // Close our isolated context entirely.
          await context.close().catch(() => {});
        } finally {
          await browser.close().catch(() => {}); // disconnect CDP, not kill browser
          releaseLock();
        }
      },
    };
  } catch (err) {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    releaseLock();
    throw err;
  }
}

export const paths = { DISCOVERY_PATH, LOCK_PATH, LOG_PATH, PROFILE_DIR };

/**
 * Launch an isolated per-connector browser context with its own profile dir.
 * Use this when a site (e.g. Chase) device-fingerprints a shared profile
 * and can't be unburned via cookie/storage wipes.
 *
 * This does NOT go through the daemon — spawns its own rebrowser-playwright
 * Chromium. Use when the shared daemon won't work.
 *
 * @param {object} opts
 * @param {string} opts.profileName - subdir under ~/.pdpp/profiles/
 * @param {boolean} [opts.headless=false] - default headful since this path
 *   is usually for anti-bot cases
 * @returns {Promise<{context, browser, release}>}
 */
export async function acquireIsolatedBrowser({ profileName, headless = false }) {
  if (!profileName || !/^[A-Za-z0-9_-]+$/.test(profileName)) {
    throw new Error('profileName required, must be [A-Za-z0-9_-]+');
  }
  const { mkdirSync: mkd, existsSync: exst } = await import('node:fs');
  const isolatedDir = join(homedir(), '.pdpp', 'profiles', profileName);
  if (!exst(isolatedDir)) mkd(isolatedDir, { recursive: true, mode: 0o700 });

  // Use rebrowser-playwright to patch the Runtime.Enable CDP leak, matching
  // the daemon's primary browser setup.
  const rebrowserPlaywright = await import('rebrowser-playwright');
  const localChromium = rebrowserPlaywright.chromium;

  const context = await localChromium.launchPersistentContext(isolatedDir, {
    headless,
    channel: 'chrome',
    viewport: { width: 1280, height: 800 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-default-browser-check',
      '--no-first-run',
      '--disable-features=DownloadBubble,DownloadBubbleV2,DownloadBubbleV3',
    ],
  });

  return {
    context,
    browser: context.browser(),
    release: async () => {
      try { await context.close(); } catch {}
    },
  };
}
