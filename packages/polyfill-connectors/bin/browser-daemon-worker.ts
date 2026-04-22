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

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// Use patchright which patches the Runtime.Enable CDP leak (the headline
// fingerprint Akamai/Cloudflare/DataDome classify automated Chromium with)
// plus Console.Enable, RuntimeInInitial, and other detection vectors. Drop-in
// for Playwright's API. Replaced rebrowser-playwright 2026-04-21 because that
// project has been stale since 2025-05. See:
//   https://github.com/Kaliiiiiiiiii-Vinyzu/patchright
// NOTE: patchright's client-side stealth requires the connector to ALSO
// import from 'patchright' and call evaluate/locator APIs through it — a
// CDP-attach via stock playwright forfeits that layer. We get launch-side
// stealth here regardless; client-side requires the migration in progress
// (see docs/connector-authoring-guide.md §2).
import { chromium } from "patchright";

const PROFILE_DIR = join(homedir(), ".pdpp", "browser-profile");
const PDPP_DIR = join(homedir(), ".pdpp");
const DISCOVERY_PATH = join(PDPP_DIR, "browser-daemon.json");
const DEVTOOLS_PORT_FILE = join(PROFILE_DIR, "DevToolsActivePort");

const BROWSER_CHANNEL = "chrome";
const VIEWPORT = { width: 1280, height: 800 };
// No USER_AGENT override — patchright handles UA spoofing matching the
// real Chrome channel; overriding undoes it.

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
}

function log(msg: string): void {
  process.stderr.write(`[browser-daemon ${new Date().toISOString()}] ${msg}\n`);
}

async function waitForDevToolsPort(
  timeoutMs = 15_000
): Promise<{ browserPath: string; port: number }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(DEVTOOLS_PORT_FILE)) {
      try {
        const content = readFileSync(DEVTOOLS_PORT_FILE, "utf8").trim();
        const [portStr, browserPath] = content.split("\n");
        const port = Number(portStr);
        if (port && browserPath) {
          return { port, browserPath };
        }
      } catch {
        /* ignore */
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("DevToolsActivePort did not appear within timeout");
}

async function main() {
  ensureDir(PDPP_DIR);
  ensureDir(PROFILE_DIR);

  const stalePort = existsSync(DEVTOOLS_PORT_FILE);
  if (stalePort) {
    try {
      unlinkSync(DEVTOOLS_PORT_FILE);
    } catch {
      /* ignore */
    }
  }

  const headless = process.env.PDPP_BROWSER_DAEMON_HEADLESS !== "0";
  const xvfb = process.env.PDPP_BROWSER_DAEMON_XVFB === "1";
  log(
    `launching Chromium (headless=${headless}, xvfb=${xvfb}, DISPLAY=${process.env.DISPLAY || "<unset>"}) profile=${PROFILE_DIR}`
  );

  // Minimal args that patchright's README says are safe to set. Do NOT add:
  // `--disable-component-update`, `--disable-default-apps`, `--disable-extensions`,
  // `--disable-popup-blocking`, custom `userAgent`, extra headers — patchright
  // already sets or intentionally omits these as part of its fingerprint
  // stealth. Overriding undoes the stealth.
  //
  // We keep:
  //   --remote-debugging-port/-address: needed for CDP-attach by connectors
  //   --disable-features=DownloadBubble*: workaround for microsoft/playwright#40158
  //     (the headed Chrome download-bubble UI takes ownership of the download
  //     stream and races Playwright's CDP-based interception, breaking USAA
  //     downloads after the first one per run).
  const baseArgs = [
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    "--disable-features=DownloadBubble,DownloadBubbleV2,DownloadBubbleV3",
  ];

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    channel: BROWSER_CHANNEL,
    viewport: VIEWPORT,
    args: baseArgs,
  });

  // No `navigator.webdriver` override — patchright handles this already as
  // part of its bundled stealth. Adding our own init-script can race with
  // patchright's injected scripts.

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
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log(`received ${signal}, closing context`);
    try {
      await context.close();
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      log(`context.close error: ${m}`);
    }
    try {
      rmSync(DISCOVERY_PATH, { force: true });
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));

  // If the browser itself dies, tear down.
  context.on("close", () => {
    log("context closed externally");
    try {
      rmSync(DISCOVERY_PATH, { force: true });
    } catch {
      /* ignore */
    }
    process.exit(0);
  });

  // Keep event loop alive.
  setInterval(() => {
    /* heartbeat no-op */
    // biome-ignore lint/suspicious/noBitwiseOperators: large integer via shift is idiomatic for "max interval"
  }, 1 << 30);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack || err.message : String(err);
  log(`fatal: ${msg}`);
  try {
    rmSync(DISCOVERY_PATH, { force: true });
  } catch {
    /* ignore */
  }
  process.exit(1);
});
