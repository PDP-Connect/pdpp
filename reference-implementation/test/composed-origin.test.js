import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, readFile } from 'node:fs/promises';

import { startServer } from '../server/index.js';
import { ingestRecord } from '../server/records.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');
const REPO_ROOT = join(REFERENCE_IMPL_DIR, '..');
const WEB_DIR = join(REPO_ROOT, 'apps/web');
const WEB_BUILD_ID_PATH = join(WEB_DIR, '.next/BUILD_ID');
const OWNER_PASSWORD = 'pdpp-owner-dev-password';
const SPOTIFY_CONNECTOR_ID = 'https://registry.pdpp.org/connectors/spotify';

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
        await access(WEB_BUILD_ID_PATH);
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

async function waitForExistingWebBuild(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(WEB_BUILD_ID_PATH);
      return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for another next build process to finish');
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

async function waitForHttpOk(url, { headers, timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url, {
        redirect: 'manual',
        headers,
      });
      if (resp.status < 500) return resp;
      lastError = new Error(`HTTP ${resp.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError?.message || 'unknown error'}`);
}

async function startWebServer({ webOrigin, asUrl, rsUrl }) {
  const webUrl = new URL(webOrigin);
  const port = Number.parseInt(webUrl.port, 10);
  const host = webUrl.hostname;
  const child = spawn(
    'pnpm',
    ['exec', 'next', 'start', '--port', String(port), '--hostname', host],
    {
      cwd: WEB_DIR,
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: '1',
        PDPP_REFERENCE_MODE: 'composed',
        PDPP_REFERENCE_ORIGIN: webOrigin,
        PDPP_AS_URL: asUrl,
        PDPP_RS_URL: rsUrl,
        PDPP_OWNER_PASSWORD: OWNER_PASSWORD,
      },
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

  try {
    await waitForHttpOk(`${webOrigin}/owner/login`);
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

function extractCookie(resp) {
  if (typeof resp.headers.getSetCookie === 'function') {
    const cookies = resp.headers.getSetCookie();
    return cookies[0]?.split(';', 1)[0] ?? null;
  }
  const raw = resp.headers.get('set-cookie');
  return raw ? raw.split(';', 1)[0] : null;
}

async function fetchJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  const body = await resp.json();
  return { resp, body };
}

test('composed browser origin carries metadata, owner session, dashboard, device flow, and consent end to end', async () => {
  await ensureWebBuild();
  const webPort = await allocatePort();
  const webOrigin = `http://127.0.0.1:${webPort}`;
  const spotifyManifest = JSON.parse(
    await readFile(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'),
  );

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
  const webServer = await startWebServer({ webOrigin, asUrl, rsUrl });

  try {
    const metadata = await fetchJson(`${webOrigin}/.well-known/oauth-authorization-server`);
    assert.equal(metadata.resp.status, 200);
    assert.equal(metadata.body.issuer, webOrigin);
    assert.equal(metadata.body.device_authorization_endpoint, `${webOrigin}/oauth/device_authorization`);
    assert.equal(metadata.body.pushed_authorization_request_endpoint, `${webOrigin}/oauth/par`);

    const dashboardGate = await fetch(`${webOrigin}/dashboard`, { redirect: 'manual' });
    assert.equal(dashboardGate.status, 307);
    assert.equal(
      dashboardGate.headers.get('location'),
      '/owner/login?return_to=%2Fdashboard',
    );

    const loginResp = await fetch(`${webOrigin}/owner/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        password: OWNER_PASSWORD,
        return_to: '/dashboard',
      }).toString(),
    });
    assert.ok(
      loginResp.status === 302 || loginResp.status === 303,
      `expected redirect after owner login, got ${loginResp.status}`,
    );
    assert.equal(loginResp.headers.get('location'), '/dashboard');
    const ownerCookie = extractCookie(loginResp);
    assert.ok(ownerCookie?.startsWith('pdpp_owner_session='), 'owner login should issue a session cookie');

    const dashboardResp = await fetch(`${webOrigin}/dashboard`, {
      headers: {
        Cookie: ownerCookie,
      },
    });
    assert.equal(dashboardResp.status, 200);
    const dashboardHtml = await dashboardResp.text();
    assert.match(dashboardHtml, /dashboard/i);
    assert.ok(!dashboardHtml.includes(asUrl), 'dashboard should not leak the internal AS origin');
    assert.ok(!dashboardHtml.includes(rsUrl), 'dashboard should not leak the internal RS origin');

    const registerConnector = await fetch(`${webOrigin}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spotifyManifest),
    });
    assert.equal(registerConnector.status, 201);

    await ingestRecord(SPOTIFY_CONNECTOR_ID, {
      stream: 'top_artists',
      id: 'artist_owner_top_1',
      data: {
        id: 'artist_owner_top_1',
        name: 'Nils Frahm',
        popularity: 96,
      },
      emitted_at: '2026-04-23T10:00:00Z',
    });

    const deviceStart = await fetchJson(`${webOrigin}/oauth/device_authorization`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: 'pdpp-web-dashboard' }).toString(),
    });
    assert.equal(deviceStart.resp.status, 200);
    assert.equal(deviceStart.body.verification_uri, `${webOrigin}/device`);
    assert.match(deviceStart.body.verification_uri_complete, new RegExp(`^${webOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/device\\?user_code=`));

    const approveDevice = await fetch(`${webOrigin}/device/approve`, {
      method: 'POST',
      headers: {
        Cookie: ownerCookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ user_code: deviceStart.body.user_code }).toString(),
    });
    assert.equal(approveDevice.status, 200);

    const ownerToken = await fetchJson(`${webOrigin}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceStart.body.device_code,
        client_id: 'pdpp-web-dashboard',
      }).toString(),
    });
    assert.equal(ownerToken.resp.status, 200);
    assert.equal(typeof ownerToken.body.access_token, 'string');

    const streamList = await fetchJson(
      `${webOrigin}/v1/streams?connector_id=${encodeURIComponent(SPOTIFY_CONNECTOR_ID)}`,
      {
        headers: {
          Authorization: `Bearer ${ownerToken.body.access_token}`,
        },
      },
    );
    assert.equal(streamList.resp.status, 200);
    assert.ok(
      Array.isArray(streamList.body.data) &&
        streamList.body.data.some((stream) => stream.name === 'top_artists'),
      'owner token over the composed origin should reach RS stream metadata',
    );

    const stagedRequest = await fetchJson(`${webOrigin}/oauth/par`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: 'cli_longview',
        client_display: { name: 'Longview' },
        authorization_details: [
          {
            type: 'https://pdpp.org/data-access',
            connector_id: SPOTIFY_CONNECTOR_ID,
            purpose_code: 'https://pdpp.org/purpose/recommendation',
            purpose_description: 'Review top artists',
            access_mode: 'single_use',
            retention: 'P30D',
            streams: [{ name: 'top_artists' }],
          },
        ],
      }),
    });
    assert.equal(stagedRequest.resp.status, 201);
    assert.match(
      stagedRequest.body.authorization_url,
      new RegExp(`^${webOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/consent\\?request_uri=`),
    );

    const consentPage = await fetch(stagedRequest.body.authorization_url, {
      headers: {
        Cookie: ownerCookie,
        Accept: 'text/html',
      },
    });
    assert.equal(consentPage.status, 200);
    const consentHtml = await consentPage.text();
    assert.match(consentHtml, /Longview/);
    assert.match(consentHtml, /top artists/i);
    assert.ok(!consentHtml.includes(asUrl), 'consent page should not leak the internal AS origin');

    const approvedGrant = await fetchJson(`${webOrigin}/consent/approve`, {
      method: 'POST',
      headers: {
        Cookie: ownerCookie,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ request_uri: stagedRequest.body.request_uri }),
    });
    assert.equal(approvedGrant.resp.status, 200);
    assert.equal(typeof approvedGrant.body.token, 'string');
    assert.equal(approvedGrant.body.grant.source.connector_id, SPOTIFY_CONNECTOR_ID);
  } finally {
    await stopChildProcess(webServer.child);
    await closeServer(server);
  }
});
