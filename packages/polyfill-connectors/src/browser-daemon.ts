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

import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync, // still used in removeDiscovery
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, chromium } from "playwright";

// Duplicated (rather than imported from ./browser-profile.js) to avoid a
// circular import — browser-profile.js re-exports acquireBrowser from here.
const PROFILE_DIR = join(homedir(), ".pdpp", "browser-profile");

const PDPP_DIR = join(homedir(), ".pdpp");
const DISCOVERY_PATH = join(PDPP_DIR, "browser-daemon.json");
const LOG_PATH = join(PDPP_DIR, "browser-daemon.log");
const WORKER_PATH = fileURLToPath(new URL("../bin/browser-daemon-worker.js", import.meta.url));

const PROFILE_NAME_RE = /^[A-Za-z0-9_-]+$/;

export interface DiscoveryInfo {
  pid: number;
  wsEndpoint: string;
  [extra: string]: unknown;
}

function ensurePdppDir(): void {
  if (!existsSync(PDPP_DIR)) {
    mkdirSync(PDPP_DIR, { recursive: true, mode: 0o700 });
  }
}

export function readDiscovery(): DiscoveryInfo | null {
  try {
    return JSON.parse(readFileSync(DISCOVERY_PATH, "utf8")) as DiscoveryInfo;
  } catch {
    return null;
  }
}

export function writeDiscovery(info: DiscoveryInfo): void {
  ensurePdppDir();
  writeFileSync(DISCOVERY_PATH, JSON.stringify(info, null, 2));
}

function removeDiscovery(): void {
  try {
    rmSync(DISCOVERY_PATH, { force: true });
  } catch {
    /* ignore */
  }
}

function isPidAlive(pid: number | undefined | null): boolean {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function probeCdp(wsEndpoint: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const browser = await chromium.connectOverCDP(wsEndpoint, {
      timeout: timeoutMs,
    });
    await browser.close().catch((): undefined => undefined);
    return true;
  } catch {
    return false;
  }
}

export interface DaemonStatus {
  alive?: boolean;
  info?: DiscoveryInfo;
  reachable?: boolean;
  running: boolean;
  stale?: boolean;
}

export async function daemonStatus(): Promise<DaemonStatus> {
  const info = readDiscovery();
  if (!info) {
    return { running: false };
  }
  const alive = isPidAlive(info.pid);
  if (!alive) {
    return { running: false, stale: true, info };
  }
  const reachable = await probeCdp(info.wsEndpoint);
  return { running: alive && reachable, info, reachable, alive };
}

async function waitForDiscoveryReady(timeoutMs = 20_000): Promise<DiscoveryInfo> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = readDiscovery();
    if (info?.wsEndpoint && isPidAlive(info.pid) && (await probeCdp(info.wsEndpoint, 1500))) {
      return info;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("browser daemon did not become ready within timeout");
}

function clearStaleProfileLock(): void {
  // Chromium writes PROFILE_DIR/SingletonLock when in use. If a previous
  // launch crashed, the lock remains and blocks new launches.
  const singleton = join(PROFILE_DIR, "SingletonLock");
  if (!existsSync(singleton)) {
    return;
  }
  try {
    unlinkSync(singleton);
  } catch {
    /* ignore */
  }
}

export interface StartDaemonOptions {
  headless?: boolean;
  xvfb?: boolean;
}

/**
 * Start the browser daemon.
 *
 * - headless=true: Run Chromium headless. Default true so most connectors
 *   (YNAB, Gmail, USAA) run unattended. Set false for connectors that trip
 *   anti-bot on the headless build (Chase/Amazon).
 * - xvfb=true: Wrap the launch under `xvfb-run` so Chromium can render into a
 *   virtual display. Use with headless=false to get a real rendered browser
 *   that bypasses anti-bot detection without requiring a human-visible
 *   desktop session. This is the standard unattended-operation answer for
 *   Akamai-protected sites (Chase).
 */
export async function startDaemon({ headless = true, xvfb = false }: StartDaemonOptions = {}): Promise<DiscoveryInfo> {
  ensurePdppDir();
  const existing = await daemonStatus();
  if (existing.running && existing.info) {
    return existing.info;
  }
  if (existing.info && isPidAlive(existing.info.pid)) {
    try {
      process.kill(existing.info.pid, "SIGTERM");
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  removeDiscovery();
  clearStaleProfileLock();

  const logFd = openSync(LOG_PATH, "a");

  // `xvfb-run` wraps the command in a virtual X display so a "headful"
  // Chromium can paint without requiring an attached monitor. Must use
  // `--auto-servernum` so concurrent daemons get different display numbers.
  const cmd = xvfb ? "xvfb-run" : process.execPath;
  const args = xvfb
    ? ["--auto-servernum", "--server-args=-screen 0 1920x1080x24", process.execPath, WORKER_PATH]
    : [WORKER_PATH];

  const child = spawn(cmd, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      PDPP_BROWSER_DAEMON_HEADLESS: headless ? "1" : "0",
      PDPP_BROWSER_DAEMON_XVFB: xvfb ? "1" : "0",
    },
  });
  child.unref();
  closeSync(logFd);

  return await waitForDiscoveryReady();
}

export interface StopDaemonResult {
  pid?: number;
  reason?: string;
  stopped: boolean;
}

export async function stopDaemon(): Promise<StopDaemonResult> {
  const info = readDiscovery();
  if (!info) {
    return { stopped: false, reason: "no_discovery" };
  }
  if (!isPidAlive(info.pid)) {
    removeDiscovery();
    return { stopped: false, reason: "not_running" };
  }
  try {
    process.kill(info.pid, "SIGTERM");
  } catch {
    /* ignore */
  }
  for (let i = 0; i < 40; i++) {
    if (!isPidAlive(info.pid)) {
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (isPidAlive(info.pid)) {
    try {
      process.kill(info.pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  removeDiscovery();
  return { stopped: true, pid: info.pid };
}

export const paths = { DISCOVERY_PATH, LOG_PATH, PROFILE_DIR };

export interface IsolatedBrowser {
  browser: Browser | null;
  context: BrowserContext;
  release: () => Promise<void>;
}

export interface AcquireIsolatedBrowserOptions {
  headless?: boolean;
  profileName: string;
}

/**
 * Launch an isolated per-connector browser context with its own profile dir.
 * Use this when a site (e.g. Chase) device-fingerprints a shared profile
 * and can't be unburned via cookie/storage wipes.
 *
 * This does NOT go through the daemon — launches a fresh patchright-patched
 * Chromium per connector. Because patchright's client-side stealth requires
 * the client to also import patchright (not just the launch process), this
 * path gets the FULL stealth stack (launch-side + client-side) whereas the
 * CDP-attach daemon path only gets launch-side.
 *
 * Each connector with a unique `profileName` gets its own profile directory
 * on disk, so cookies, localStorage, and "trusted device" state persist
 * across runs of that connector, without sharing fingerprint or auth state
 * with other connectors. Safe for concurrent runs across connectors.
 */
export async function acquireIsolatedBrowser({
  profileName,
  headless = false,
}: AcquireIsolatedBrowserOptions): Promise<IsolatedBrowser> {
  if (!(profileName && PROFILE_NAME_RE.test(profileName))) {
    throw new Error("profileName required, must be [A-Za-z0-9_-]+");
  }
  const { mkdirSync: mkd, existsSync: exst } = await import("node:fs");
  const isolatedDir = join(homedir(), ".pdpp", "profiles", profileName);
  if (!exst(isolatedDir)) {
    mkd(isolatedDir, { recursive: true, mode: 0o700 });
  }

  // Use patchright (replaces rebrowser-playwright 2026-04-21). Per the
  // patchright README, do NOT set custom userAgent, extra headers, or the
  // args it intentionally omits (`--disable-component-update`,
  // `--disable-default-apps`, `--disable-extensions`, `--disable-popup-blocking`,
  // `--disable-blink-features=AutomationControlled`, `--no-default-browser-check`,
  // `--no-first-run`) — patchright already handles these as part of its
  // stealth fingerprint.
  //
  // patchright exports `chromium` whose runtime shape matches playwright's
  // (patchright is built as a drop-in replacement) but whose declared types
  // live in patchright-core's own module namespace, making them nominally
  // distinct from playwright's. We suppress the type mismatch rather than
  // double-cast — @ts-expect-error is self-healing if patchright ever
  // re-exports playwright-core's types directly.
  // @ts-expect-error — patchright.chromium is runtime-identical to playwright.chromium
  const { chromium: localChromium }: { chromium: typeof chromium } = await import("patchright");

  const context = await localChromium.launchPersistentContext(isolatedDir, {
    headless,
    channel: "chrome",
    viewport: { width: 1280, height: 800 },
    args: [
      // Workaround for microsoft/playwright#40158: headed Chrome's download
      // bubble races Playwright's CDP-based download interception. Keep this
      // flag even though patchright's README advises against overriding args —
      // absence here actively breaks multi-file downloads (USAA).
      "--disable-features=DownloadBubble,DownloadBubbleV2,DownloadBubbleV3",
    ],
  });

  return {
    context,
    browser: context.browser(),
    release: async (): Promise<void> => {
      try {
        await context.close();
      } catch {
        /* ignore */
      }
    },
  };
}
