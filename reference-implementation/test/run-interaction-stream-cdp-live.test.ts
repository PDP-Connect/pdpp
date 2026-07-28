const TOP_LEVEL_REGEX_1 = /^wss?:\/\//;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
/**
 * Opt-in live CDP smoke proof for the run-interaction streaming companion.
 *
 * Skipped unless `PDPP_TEST_LIVE_CDP=1` is set. The deterministic fake-socket
 * tests pin the wire contract; this test proves the same adapter can drive a
 * real Chrome/Chromium page: receive a screencast frame, acknowledge it,
 * dispatch a click, and resize the browser viewport.
 */
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createCdpCompanion } from "../server/streaming/cdp-adapter.ts";

const LIVE_ENABLED = process.env.PDPP_TEST_LIVE_CDP === "1";

interface CdpFrame {
  sessionId: unknown;
}

interface RuntimeEvaluateResult {
  result?: { value?: unknown };
}

interface CdpCompanion {
  _internal?: { send: (method: string, params: unknown) => Promise<RuntimeEvaluateResult> };
  ackFrame: (sessionId: unknown) => Promise<void>;
  dispatch: (event: unknown) => Promise<void>;
  onFrame: (handler: (frame: CdpFrame) => void) => () => void;
  start: (viewport: unknown) => Promise<void>;
  stop: () => Promise<void>;
}

interface CdpCompanionOptions {
  browser_session_id: string;
  commandTimeoutMs?: number;
  openTimeoutMs?: number;
  wsUrl: string;
}

const createCdpCompanionTyped = createCdpCompanion as (options: CdpCompanionOptions) => CdpCompanion;

test("live CDP smoke proves frame, click, and viewport resize against Chromium", { skip: !LIVE_ENABLED }, async (t) => {
  // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
  let cleanup = async () => {};
  let wsUrl = process.env.PDPP_TEST_CDP_WS_URL || null;

  if (!wsUrl) {
    const launched = await launchHeadlessChrome(t);
    // biome-ignore lint/style/useDestructuring: index access documents the asserted ordered position
    cleanup = launched.cleanup;
    // biome-ignore lint/style/useDestructuring: index access documents the asserted ordered position
    wsUrl = launched.wsUrl;
    if (!wsUrl) {
      return;
    }
  }

  try {
    await runCompanionProof(wsUrl);
  } finally {
    await cleanup();
  }
});

async function runCompanionProof(wsUrl: string): Promise<void> {
  const companion = createCdpCompanionTyped({
    browser_session_id: "bs_live_cdp",
    commandTimeoutMs: 5000,
    openTimeoutMs: 5000,
    wsUrl,
  });
  const frames: CdpFrame[] = [];
  const offFrame = companion.onFrame((frame) => frames.push(frame));

  try {
    await companion.start({ deviceScaleFactor: 1, height: 600, mobile: false, width: 800 });

    await waitUntil(() => frames.length > 0, "companion produced at least one screencast frame");
    const [firstFrame] = frames;
    if (firstFrame && Number.isFinite(firstFrame.sessionId)) {
      await companion.ackFrame(firstFrame.sessionId);
    }

    assert.equal(typeof companion._internal?.send, "function", "live proof requires adapter test send hook");
    const internal = companion._internal;
    assert.ok(internal, "expected the adapter test send hook");
    await internal.send("Runtime.evaluate", {
      expression: `
        (() => {
          document.body.style.margin = '0';
          document.body.innerHTML = '<button id="pdpp-target" style="position:absolute;left:20px;top:20px;width:120px;height:60px">Click</button>';
          window.__pdppClicked = false;
          document.getElementById('pdpp-target').addEventListener('click', () => { window.__pdppClicked = true; });
          return true;
        })()
      `,
      returnByValue: true,
    });

    await companion.dispatch({ action: "click", button: 0, type: "mouse", x: 60, y: 50 });
    await waitForRuntimeValue(companion, "window.__pdppClicked === true", true, "click input landed");

    await companion.dispatch({
      deviceScaleFactor: 2,
      height: 844,
      mobile: false,
      type: "viewport",
      width: 390,
    });
    const viewport = await waitForRuntimeValue(
      companion,
      "({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio })",
      (value: { dpr?: number; height?: number; width?: number }) =>
        // biome-ignore lint/suspicious/noUnnecessaryConditions: assertion retains its defensive runtime boundary
        value?.width === 390 && value?.height === 844 && value?.dpr === 2,
      "viewport resize landed"
    );
    assert.deepEqual(viewport, { dpr: 2, height: 844, width: 390 });
  } finally {
    offFrame();
    await companion.stop();
  }
}

async function waitForRuntimeValue(
  companion: CdpCompanion,
  expression: string,
  expected: unknown | ((value: unknown) => boolean),
  label: string
): Promise<unknown> {
  let latest: unknown;
  await waitUntil(async () => {
    const internal = companion._internal;
    assert.ok(internal, "expected the adapter test send hook");
    const result = await internal.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    latest = result.result?.value;
    return typeof expected === "function" ? expected(latest) : latest === expected;
  }, label);
  return latest;
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: ordered test setup is intentionally sequential
    if (await predicate()) {
      return;
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function launchHeadlessChrome(t: TestContext): Promise<{ cleanup: () => Promise<void>; wsUrl: string | null }> {
  const bin = await findChromeBinary();
  if (!bin) {
    t.skip(
      "No Chrome/Chromium binary discovered. Set PDPP_TEST_CDP_BIN or PDPP_TEST_CDP_WS_URL to run live CDP smoke."
    );
    // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
    return { cleanup: async () => {}, wsUrl: null };
  }

  const port = await pickEphemeralPort();
  const userDataDir = mkdtempSync(join(tmpdir(), "pdpp-cdp-smoke-"));
  const args = [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--no-sandbox",
    "about:blank",
  ];
  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  const httpUrl = `http://127.0.0.1:${port}`;

  try {
    await waitUntil(
      async () => {
        try {
          const response = await fetch(`${httpUrl}/json/version`);
          return response.ok;
        } catch {
          return false;
        }
      },
      `Chrome DevTools endpoint ${httpUrl}`,
      10_000
    );
    const wsUrl = await createPageTarget(httpUrl);
    return {
      cleanup: async () => {
        await stopChrome(child, userDataDir);
      },
      wsUrl,
    };
  } catch (err) {
    await stopChrome(child, userDataDir);
    throw err;
  }
}

async function createPageTarget(httpUrl: string): Promise<string> {
  const response = await fetch(`${httpUrl}/json/new?about:blank`, { method: "PUT" });
  if (!response.ok) {
    throw new Error(`Failed to create Chrome target: ${response.status} ${await response.text()}`);
  }
  const target = (await response.json()) as { webSocketDebuggerUrl: string };
  assert.match(target.webSocketDebuggerUrl, TOP_LEVEL_REGEX_1);
  return target.webSocketDebuggerUrl;
}

async function findChromeBinary() {
  const explicit = process.env.PDPP_TEST_CDP_BIN;
  const candidates = explicit
    ? [explicit]
    : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
    try {
      // biome-ignore lint/performance/noAwaitInLoops: ordered test setup is intentionally sequential
      const ok = await new Promise((resolve) => {
        const child = spawn(candidate, ["--version"], { stdio: "ignore" });
        child.on("error", () => resolve(false));
        child.on("exit", (code) => resolve(code === 0));
      });
      if (ok) {
        return candidate;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

async function stopChrome(child: ChildProcess, userDataDir: string): Promise<void> {
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.on("exit", () => resolve());
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve();
    }, 2000);
  });
  rmSync(userDataDir, { force: true, recursive: true });
}

async function pickEphemeralPort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object", "expected an AddressInfo from an ephemeral listen(0)");
      server.close(() => resolve(address.port));
    });
  });
}
