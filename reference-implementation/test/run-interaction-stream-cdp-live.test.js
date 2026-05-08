/**
 * Opt-in live CDP smoke proof for the run-interaction streaming companion.
 *
 * Skipped unless `PDPP_TEST_LIVE_CDP=1` is set. The deterministic fake-socket
 * tests pin the wire contract; this test proves the same adapter can drive a
 * real Chrome/Chromium page: receive a screencast frame, acknowledge it,
 * dispatch a click, and resize the browser viewport.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { createCdpCompanion } from '../server/streaming/cdp-adapter.js';

const LIVE_ENABLED = process.env.PDPP_TEST_LIVE_CDP === '1';

test('live CDP smoke proves frame, click, and viewport resize against Chromium', { skip: !LIVE_ENABLED }, async (t) => {
  let cleanup = async () => {};
  let wsUrl = process.env.PDPP_TEST_CDP_WS_URL || null;

  if (!wsUrl) {
    const launched = await launchHeadlessChrome(t);
    cleanup = launched.cleanup;
    wsUrl = launched.wsUrl;
    if (!wsUrl) return;
  }

  try {
    await runCompanionProof(wsUrl);
  } finally {
    await cleanup();
  }
});

async function runCompanionProof(wsUrl) {
  const companion = createCdpCompanion({
    wsUrl,
    browser_session_id: 'bs_live_cdp',
    commandTimeoutMs: 5_000,
    openTimeoutMs: 5_000,
  });
  const frames = [];
  const offFrame = companion.onFrame((frame) => frames.push(frame));

  try {
    await companion.start({ width: 800, height: 600, deviceScaleFactor: 1, mobile: false });

    await waitUntil(() => frames.length > 0, 'companion produced at least one screencast frame');
    if (Number.isFinite(frames[0].sessionId)) {
      await companion.ackFrame(frames[0].sessionId);
    }

    assert.equal(typeof companion._internal?.send, 'function', 'live proof requires adapter test send hook');
    await companion._internal.send('Runtime.evaluate', {
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

    await companion.dispatch({ type: 'mouse', action: 'click', x: 60, y: 50, button: 0 });
    await waitForRuntimeValue(companion, 'window.__pdppClicked === true', true, 'click input landed');

    await companion.dispatch({
      type: 'viewport',
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: false,
    });
    const viewport = await waitForRuntimeValue(
      companion,
      '({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio })',
      (value) => value?.width === 390 && value?.height === 844 && value?.dpr === 2,
      'viewport resize landed',
    );
    assert.deepEqual(viewport, { width: 390, height: 844, dpr: 2 });
  } finally {
    offFrame();
    await companion.stop();
  }
}

async function waitForRuntimeValue(companion, expression, expected, label) {
  let latest;
  await waitUntil(async () => {
    const result = await companion._internal.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
    });
    latest = result.result?.value;
    return typeof expected === 'function' ? expected(latest) : latest === expected;
  }, label);
  return latest;
}

async function waitUntil(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function launchHeadlessChrome(t) {
  const bin = await findChromeBinary();
  if (!bin) {
    t.skip(
      'No Chrome/Chromium binary discovered. Set PDPP_TEST_CDP_BIN or PDPP_TEST_CDP_WS_URL to run live CDP smoke.',
    );
    return { wsUrl: null, cleanup: async () => {} };
  }

  const port = await pickEphemeralPort();
  const userDataDir = mkdtempSync(join(tmpdir(), 'pdpp-cdp-smoke-'));
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--no-sandbox',
    'about:blank',
  ];
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const httpUrl = `http://127.0.0.1:${port}`;

  try {
    await waitUntil(async () => {
      try {
        const response = await fetch(`${httpUrl}/json/version`);
        return response.ok;
      } catch {
        return false;
      }
    }, `Chrome DevTools endpoint ${httpUrl}`, 10_000);
    const wsUrl = await createPageTarget(httpUrl);
    return {
      wsUrl,
      cleanup: async () => {
        await stopChrome(child, userDataDir);
      },
    };
  } catch (err) {
    await stopChrome(child, userDataDir);
    throw err;
  }
}

async function createPageTarget(httpUrl) {
  const response = await fetch(`${httpUrl}/json/new?about:blank`, { method: 'PUT' });
  if (!response.ok) {
    throw new Error(`Failed to create Chrome target: ${response.status} ${await response.text()}`);
  }
  const target = await response.json();
  assert.match(target.webSocketDebuggerUrl, /^wss?:\/\//);
  return target.webSocketDebuggerUrl;
}

async function findChromeBinary() {
  const explicit = process.env.PDPP_TEST_CDP_BIN;
  const candidates = explicit
    ? [explicit]
    : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
    try {
      const ok = await new Promise((resolve) => {
        const child = spawn(candidate, ['--version'], { stdio: 'ignore' });
        child.on('error', () => resolve(false));
        child.on('exit', (code) => resolve(code === 0));
      });
      if (ok) return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function stopChrome(child, userDataDir) {
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  await new Promise((resolve) => {
    if (child.exitCode != null) {
      resolve();
      return;
    }
    child.on('exit', () => resolve());
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve();
    }, 2_000);
  });
  rmSync(userDataDir, { recursive: true, force: true });
}

async function pickEphemeralPort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
