import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { startServer } from '../server/index.js';
import { ingestRecord } from '../server/records.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');
const REPO_ROOT = join(REFERENCE_IMPL_DIR, '..');
const WEB_DIR = join(REPO_ROOT, 'apps/web');
const WEB_BUILD_ID_PATH = join(WEB_DIR, '.next/BUILD_ID');
const WEB_PRERENDER_MANIFEST_PATH = join(WEB_DIR, '.next/prerender-manifest.json');
const WEB_STANDALONE_SERVER_PATH = join(WEB_DIR, '.next/standalone/apps/web/server.js');
const OWNER_PASSWORD = 'pdpp-owner-dev-password';
const SPOTIFY_CONNECTOR_ID = 'https://registry.pdpp.org/connectors/spotify';
const CLAUDE_CODE_CONNECTOR_ID = 'https://registry.pdpp.org/connectors/claude-code';

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

async function waitForExistingWebBuild(timeoutMs = 30000) {
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

async function startPublicOriginTrap() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url || '/' });
    if ((req.url || '').startsWith('/v1/ingest/')) {
      res.statusCode = 500;
      res.end('public origin must not receive server-side runtime ingest');
      return;
    }
    res.statusCode = 204;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  if (!port) throw new Error('Failed to start public origin trap');
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function waitForHttpStatus(url, { expectedStatus = 200, headers, timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  let lastStatus = null;
  let lastBody = '';

  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url, {
        redirect: 'manual',
        headers,
      });
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

async function startWebServer({ webOrigin, asUrl, rsUrl }) {
  const webUrl = new URL(webOrigin);
  const port = Number.parseInt(webUrl.port, 10);
  const host = webUrl.hostname;
  const child = spawn(
    process.execPath,
    [WEB_STANDALONE_SERVER_PATH],
    {
      cwd: dirname(WEB_STANDALONE_SERVER_PATH),
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: '1',
        PDPP_REFERENCE_MODE: 'composed',
        PDPP_REFERENCE_ORIGIN: webOrigin,
        PDPP_AS_URL: asUrl,
        PDPP_RS_URL: rsUrl,
        PDPP_OWNER_PASSWORD: OWNER_PASSWORD,
        PORT: String(port),
        HOSTNAME: host,
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

function extractCookie(resp) {
  if (typeof resp.headers.getSetCookie === 'function') {
    const cookies = resp.headers.getSetCookie();
    return cookies[0]?.split(';', 1)[0] ?? null;
  }
  const raw = resp.headers.get('set-cookie');
  return raw ? raw.split(';', 1)[0] : null;
}

function getRawSetCookieList(resp) {
  if (typeof resp.headers.getSetCookie === 'function') {
    return resp.headers.getSetCookie();
  }
  const single = resp.headers.get('set-cookie');
  return single ? [single] : [];
}

function findSetCookiePair(setCookies, name) {
  for (const header of setCookies) {
    const pair = header.split(';', 1)[0];
    if (pair.startsWith(`${name}=`)) {
      return pair;
    }
  }
  return null;
}

function extractCsrfFieldValue(html) {
  const match = html.match(/<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/);
  return match ? match[1] : null;
}

async function fetchJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  const body = await resp.json();
  return { resp, body };
}

async function waitForRunTerminal(asUrl, runId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { resp, body } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(runId)}/timeline`);
    if (resp.status === 200 && Array.isArray(body.data)) {
      const terminal = body.data.find((event) =>
        event.event_type === 'run.completed' || event.event_type === 'run.failed'
      );
      if (terminal) {
        return body;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for run ${runId} to finish`);
}

async function makeClaudeCodeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'pdpp-claude-code-ingest-'));
  const claudeHome = join(root, '.claude');
  const projectsDir = join(claudeHome, 'projects');
  const projectDir = join(projectsDir, '-home-test-safe-project');
  await mkdir(projectDir, { recursive: true });
  // The Claude Code connector reads .claude/skills and .claude/commands
  // even when empty; create them so the run doesn't fail before exercising
  // the origin-routing behavior this test targets.
  await mkdir(join(claudeHome, 'skills'), { recursive: true });
  await mkdir(join(claudeHome, 'commands'), { recursive: true });
  const sessionId = '00000000-0000-4000-8000-000000000001';
  const lines = [
    {
      type: 'user',
      uuid: 'msg-safe-1',
      sessionId,
      timestamp: '2026-04-24T15:00:00.000Z',
      cwd: '/home/user/safe-project',
      gitBranch: 'main',
      version: '1.0.0',
      userType: 'external',
      entrypoint: 'cli',
      message: { content: [{ type: 'text', text: 'synthetic safe prompt' }] },
    },
    {
      type: 'assistant',
      uuid: 'msg-safe-2',
      sessionId,
      timestamp: '2026-04-24T15:00:01.000Z',
      message: { content: [{ type: 'text', text: 'synthetic safe response' }] },
    },
  ];
  await writeFile(
    join(projectDir, `${sessionId}.jsonl`),
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    'utf8',
  );
  return {
    claudeHome,
    projectsDir,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('composed controller runs ingest against the internal RS, not the public browser origin', async () => {
  const publicOrigin = await startPublicOriginTrap();
  const fixture = await makeClaudeCodeFixture();
  const manifest = JSON.parse(
    await readFile(join(REPO_ROOT, 'packages/polyfill-connectors/manifests/claude_code.json'), 'utf8'),
  );
  const previousEnv = {
    CLAUDE_CODE_HOME: process.env.CLAUDE_CODE_HOME,
    CLAUDE_CODE_PROJECTS_DIR: process.env.CLAUDE_CODE_PROJECTS_DIR,
  };
  process.env.CLAUDE_CODE_HOME = fixture.claudeHome;
  process.env.CLAUDE_CODE_PROJECTS_DIR = fixture.projectsDir;

  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    referenceMode: 'composed',
    referenceOrigin: publicOrigin.origin,
  });
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const registerConnector = await fetch(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    assert.equal(registerConnector.status, 201);

    const runResp = await fetch(`${asUrl}/_ref/connectors/${encodeURIComponent(CLAUDE_CODE_CONNECTOR_ID)}/run`, {
      method: 'POST',
    });
    assert.equal(runResp.status, 202);
    const started = await runResp.json();

    const timeline = await waitForRunTerminal(asUrl, started.run_id);
    const completed = timeline.data.find((event) => event.event_type === 'run.completed');
    assert.ok(completed, 'Claude Code run should complete using the internal RS URL');
    assert.deepEqual(
      publicOrigin.requests.filter((req) => req.url.startsWith('/v1/ingest/')),
      [],
      'server-side runtime ingest must not traverse the public composed origin',
    );
  } finally {
    if (previousEnv.CLAUDE_CODE_HOME === undefined) delete process.env.CLAUDE_CODE_HOME;
    else process.env.CLAUDE_CODE_HOME = previousEnv.CLAUDE_CODE_HOME;
    if (previousEnv.CLAUDE_CODE_PROJECTS_DIR === undefined) delete process.env.CLAUDE_CODE_PROJECTS_DIR;
    else process.env.CLAUDE_CODE_PROJECTS_DIR = previousEnv.CLAUDE_CODE_PROJECTS_DIR;
    await closeServer(server);
    await fixture.cleanup();
    await publicOrigin.close();
  }
});

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

    const loginPage = await fetch(`${webOrigin}/owner/login?return_to=%2Fdashboard`, {
      headers: { Accept: 'text/html' },
      redirect: 'manual',
    });
    assert.equal(loginPage.status, 200);
    const csrfCookie = findSetCookiePair(getRawSetCookieList(loginPage), 'pdpp_owner_csrf');
    const csrfField = extractCsrfFieldValue(await loginPage.text());
    assert.ok(csrfCookie, 'owner login GET should issue a CSRF cookie');
    assert.ok(csrfField, 'owner login GET should render a CSRF field');

    const loginResp = await fetch(`${webOrigin}/owner/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: csrfCookie,
      },
      body: new URLSearchParams({
        password: OWNER_PASSWORD,
        return_to: '/dashboard',
        _csrf: csrfField,
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

    const devicePage = await fetch(`${webOrigin}/device?user_code=${encodeURIComponent(deviceStart.body.user_code)}`, {
      headers: {
        Accept: 'text/html',
        Cookie: ownerCookie,
      },
      redirect: 'manual',
    });
    assert.equal(devicePage.status, 200);
    const deviceCsrfCookie = findSetCookiePair(getRawSetCookieList(devicePage), 'pdpp_owner_csrf');
    const deviceCsrfField = extractCsrfFieldValue(await devicePage.text());
    assert.ok(deviceCsrfCookie, 'device approval page should issue a CSRF cookie');
    assert.ok(deviceCsrfField, 'device approval page should render a CSRF field');

    const approveDevice = await fetch(`${webOrigin}/device/approve`, {
      method: 'POST',
      headers: {
        Cookie: `${ownerCookie}; ${deviceCsrfCookie}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        user_code: deviceStart.body.user_code,
        _csrf: deviceCsrfField,
      }).toString(),
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
            source: { kind: 'connector', id: SPOTIFY_CONNECTOR_ID },
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
    assert.deepEqual(approvedGrant.body.grant.source, { kind: 'connector', id: SPOTIFY_CONNECTOR_ID });
  } finally {
    await stopChildProcess(webServer.child);
    await closeServer(server);
  }
});
