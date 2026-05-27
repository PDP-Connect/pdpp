// Pins the proxy-layer dashboard auth gate added to apps/web/src/proxy.ts.
//
// Before this gate existed, hitting `/dashboard` without an owner session
// could surface a raw 401 from the dashboard data layer (the layout/page
// render race documented in the proxy file's header comment). The proxy
// now performs an optimistic cookie-presence check and 307-redirects
// unauthenticated browsers to `/owner/login?return_to=...` before any
// server component renders.
//
// What this test pins for the production standalone server:
//   1. GET /dashboard          (no cookie) -> 307 to /owner/login?return_to=%2Fdashboard
//   2. GET /dashboard/records/spotify (no cookie) -> 307 to ...?return_to=%2Fdashboard%2Frecords%2Fspotify
//   3. The redirect carries X-Robots-Tag: noindex, nofollow
// The production standalone server defaults the operator console to redirecting
// unauthenticated dashboard navigations even when the password is only held
// by the AS. Local-dev opt-out policy is covered by apps/web's pure proxy
// policy tests; this integration test pins the production BFF behavior.
//
// The test uses the same composed-origin spawn pattern as
// `composed-origin.test.js` because the proxy is owned by the web process
// while the authoritative dashboard DAL gate is owned by the AS.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';

import { startServer } from '../server/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');
const REPO_ROOT = join(REFERENCE_IMPL_DIR, '..');
const WEB_DIR = join(REPO_ROOT, 'apps/web');
const WEB_BUILD_ID_PATH = join(WEB_DIR, '.next/BUILD_ID');
const WEB_PRERENDER_MANIFEST_PATH = join(WEB_DIR, '.next/prerender-manifest.json');
const WEB_STANDALONE_SERVER_PATH = join(WEB_DIR, '.next/standalone/apps/web/server.js');
const OWNER_PASSWORD = 'pdpp-owner-dev-password';

let webBuildPromise = null;

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();

  const closeWithTimeout = (srv) => new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve();
    }, 2000);

    srv.close(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
  });

  await Promise.allSettled([
    closeWithTimeout(server.asServer),
    closeWithTimeout(server.rsServer),
  ]);
}

function runCommand(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...opts,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';

    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve(output);
        return;
      }
      reject(
        new Error(
          `Command failed: ${command} ${args.join(' ')}\n` +
          `exit=${code ?? 'null'} signal=${signal ?? 'none'}\n${output}`,
        ),
      );
    });
  });
}

async function ensureWebBuild() {
  if (!webBuildPromise) {
    webBuildPromise = (async () => {
      try {
        await assertCompleteWebBuild();
        return;
      } catch {}

      try {
        await runCommand('pnpm', ['--dir', 'apps/web', 'build'], {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            NEXT_TELEMETRY_DISABLED: '1',
          },
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('Another next build process is already running')
        ) {
          await waitForExistingWebBuild();
          return;
        }
        throw error;
      }
    })();
  }
  await webBuildPromise;
}

async function waitForExistingWebBuild(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await assertCompleteWebBuild();
      return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for another next build process to finish');
}

async function assertCompleteWebBuild() {
  await access(WEB_BUILD_ID_PATH);
  await access(WEB_PRERENDER_MANIFEST_PATH);
  await access(WEB_STANDALONE_SERVER_PATH);
}

async function allocatePort() {
  const server = http.createServer((_req, res) => {
    res.statusCode = 204;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error('Failed to allocate an ephemeral port');
  return port;
}

async function waitForHttpStatus(url, { expectedStatus = 200, timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  let lastStatus = null;
  let lastBody = '';

  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url, { redirect: 'manual' });
      lastStatus = resp.status;
      if (resp.status === expectedStatus) return resp;
      lastBody = await resp.text().catch(() => '');
      lastError = new Error(`HTTP ${resp.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `Timed out waiting for ${url} to return HTTP ${expectedStatus}: ${lastError?.message || 'unknown error'}` +
    `\nlastStatus=${lastStatus ?? 'none'}` +
    `\nlastBody=${lastBody.slice(0, 500)}`,
  );
}

// Mirrors composed-origin.test.js's startWebServer while keeping the web
// process env explicit. The production standalone server redirects logged-out
// dashboard navigations by default; the password is still passed here so the
// AS and web process match the self-hosted operator-console shape.
async function startWebServer({ webOrigin, asUrl, rsUrl, ownerPassword }) {
  const webUrl = new URL(webOrigin);
  const port = Number.parseInt(webUrl.port, 10);
  const host = webUrl.hostname;

  // Build a clean env: copy the parent env, then explicitly delete
  // PDPP_OWNER_PASSWORD before optionally re-setting it. This keeps the
  // test honest even if the runner inherits secrets from a developer shell.
  const childEnv = {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: '1',
    PDPP_REFERENCE_MODE: 'composed',
    PDPP_REFERENCE_ORIGIN: webOrigin,
    PDPP_AS_URL: asUrl,
    PDPP_RS_URL: rsUrl,
    PORT: String(port),
    HOSTNAME: host,
  };
  delete childEnv.PDPP_OWNER_PASSWORD;
  if (typeof ownerPassword === 'string' && ownerPassword.length > 0) {
    childEnv.PDPP_OWNER_PASSWORD = ownerPassword;
  }

  const child = spawn(
    process.execPath,
    [WEB_STANDALONE_SERVER_PATH],
    {
      cwd: dirname(WEB_STANDALONE_SERVER_PATH),
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  child.on('error', (error) => {
    output += `\n[spawn error] ${error.message}`;
  });

  // `/owner/login` is always reachable through the proxy regardless of
  // the owner-auth flag — same readiness probe used by composed-origin.test.js.
  try {
    await waitForHttpStatus(`${webOrigin}/owner/login`, { expectedStatus: 200 });
    return { child, getOutput: () => output };
  } catch (error) {
    child.kill('SIGTERM');
    throw new Error(`${error.message}\n\nWeb server output:\n${output}`);
  }
}

async function stopChildProcess(child) {
  if (child.exitCode !== null || child.signalCode) return;

  await new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve();
    }, 3000);

    child.once('exit', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });

    child.kill('SIGTERM');
  });
}

test('proxy redirects unauthenticated /dashboard hits to /owner/login when owner-auth is enabled', async (t) => {
  await ensureWebBuild();
  const webPort = await allocatePort();
  const webOrigin = `http://127.0.0.1:${webPort}`;

  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    referenceMode: 'composed',
    referenceOrigin: webOrigin,
    ownerAuthPassword: OWNER_PASSWORD,
  });
  const asUrl = `http://127.0.0.1:${server.asPort}`;
  const rsUrl = `http://127.0.0.1:${server.rsPort}`;
  const webServer = await startWebServer({
    webOrigin,
    asUrl,
    rsUrl,
    ownerPassword: OWNER_PASSWORD,
  });

  try {
    await t.test('GET /dashboard with no cookie -> 307 to /owner/login?return_to=%2Fdashboard', async () => {
      const resp = await fetch(`${webOrigin}/dashboard`, { redirect: 'manual' });
      assert.equal(resp.status, 307, 'expected proxy-issued 307 redirect, not a 200/401/500');
      assert.equal(
        resp.headers.get('location'),
        '/owner/login?return_to=%2Fdashboard',
      );
    });

    await t.test('GET /dashboard/records/spotify with no cookie -> 307 with deep return_to', async () => {
      const resp = await fetch(`${webOrigin}/dashboard/records/spotify`, { redirect: 'manual' });
      assert.equal(resp.status, 307);
      assert.equal(
        resp.headers.get('location'),
        '/owner/login?return_to=%2Fdashboard%2Frecords%2Fspotify',
      );
    });

    await t.test('redirect carries X-Robots-Tag: noindex, nofollow', async () => {
      const resp = await fetch(`${webOrigin}/dashboard`, { redirect: 'manual' });
      assert.equal(resp.status, 307);
      assert.equal(resp.headers.get('x-robots-tag'), 'noindex, nofollow');
    });
  } finally {
    await stopChildProcess(webServer.child);
    await closeServer(server);
  }
});
