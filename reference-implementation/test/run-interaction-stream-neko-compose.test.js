import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { resolveNekoBrowserSurfaceControllerOptions } from '../server/index.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const COMPOSE_FILE = `${REPO_ROOT}docker-compose.yml`;
const OVERLAY_FILE = `${REPO_ROOT}docker-compose.neko.yml`;
const ENV_EXAMPLE_FILE = `${REPO_ROOT}.env.docker.example`;
const CHATGPT_CONNECTOR_ID = 'https://registry.pdpp.org/connectors/chatgpt';
const CHASE_CONNECTOR_ID = 'https://registry.pdpp.org/connectors/chase';
const USAA_CONNECTOR_ID = 'https://registry.pdpp.org/connectors/usaa';
const AMAZON_CONNECTOR_ID = 'https://registry.pdpp.org/connectors/amazon';
const REDDIT_CONNECTOR_ID = 'https://registry.pdpp.org/connectors/reddit';
const MANAGED_CONNECTOR_IDS = [
  CHATGPT_CONNECTOR_ID,
  CHASE_CONNECTOR_ID,
  USAA_CONNECTOR_ID,
  AMAZON_CONNECTOR_ID,
  REDDIT_CONNECTOR_ID,
];

test('n.eko compose overlay uses service DNS instead of reference network namespace', async () => {
  const [overlay, envExample] = await Promise.all([
    readFile(OVERLAY_FILE, 'utf8'),
    readFile(ENV_EXAMPLE_FILE, 'utf8'),
  ]);

  assert.doesNotMatch(overlay, /network_mode:\s*["']?service:reference/);
  assert.match(overlay, /PDPP_NEKO_BASE_URL:\s*\$\{PDPP_NEKO_BASE_URL-http:\/\/neko:8080\/neko\}/);
  assert.match(overlay, /PDPP_NEKO_PROXY_ALLOWED_HOSTS:\s*\$\{PDPP_NEKO_PROXY_ALLOWED_HOSTS:-neko:8080\}/);
  assert.match(overlay, /PDPP_STREAM_PLAYGROUND_NEKO_CDP_HTTP_URL:\s*\$\{PDPP_STREAM_PLAYGROUND_NEKO_CDP_HTTP_URL:-http:\/\/neko:9223\}/);
  assert.match(overlay, /PDPP_NEKO_CDP_HTTP_URL:\s*\$\{PDPP_NEKO_CDP_HTTP_URL-http:\/\/neko:9223\}/);
  assert.match(overlay, /NEKO_CONTROL_USERNAME:\s*\$\{NEKO_CONTROL_USERNAME:-admin\}/);
  assert.match(overlay, /NEKO_CONTROL_PASSWORD:\s*\$\{NEKO_CONTROL_PASSWORD:-\}/);
  assert.match(overlay, /NEKO_MEMBER_PROVIDER:\s*\$\{NEKO_MEMBER_PROVIDER:-multiuser\}/);
  assert.match(overlay, /NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD:\s*\$\{NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD:-\}/);
  assert.match(overlay, /NEKO_MEMBER_MULTIUSER_USER_PASSWORD:\s*\$\{NEKO_MEMBER_MULTIUSER_USER_PASSWORD:-\}/);
  assert.match(overlay, /NEKO_USERNAME:\s*\$\{NEKO_USERNAME:-user\}/);
  assert.match(overlay, /NEKO_PASSWORD:\s*\$\{NEKO_PASSWORD:-neko\}/);
  assert.match(
    overlay,
    new RegExp(`PDPP_NEKO_MANAGED_CONNECTORS:\\s*\\$\\{PDPP_NEKO_MANAGED_CONNECTORS:-${CHATGPT_CONNECTOR_ID}\\}`),
  );
  assert.match(overlay, /PDPP_NEKO_SURFACE_CAP:\s*\$\{PDPP_NEKO_SURFACE_CAP:-1\}/);
  assert.match(
    overlay,
    new RegExp(`PDPP_NEKO_STATIC_PROFILE_KEY:\\s*\\$\\{PDPP_NEKO_STATIC_PROFILE_KEY-${CHATGPT_CONNECTOR_ID}\\}`),
  );
  assert.doesNotMatch(overlay, /PDPP_CHATGPT_REMOTE_CDP_URL:/);
  assert.match(overlay, /web:[\s\S]*depends_on:[\s\S]*neko:[\s\S]*condition:\s*service_healthy/);
  assert.match(overlay, /neko:[\s\S]*ports:[\s\S]*"\$\{NEKO_WEBRTC_PORT:-59000\}:59000\/tcp"/);
  assert.match(overlay, /neko:[\s\S]*ports:[\s\S]*"\$\{NEKO_WEBRTC_PORT:-59000\}:59000\/udp"/);

  assert.match(envExample, /PDPP_NEKO_BASE_URL=http:\/\/neko:8080\/neko/);
  assert.match(envExample, /PDPP_NEKO_PROXY_ALLOWED_HOSTS=neko:8080/);
  assert.match(envExample, /PDPP_STREAM_PLAYGROUND_NEKO_CDP_HTTP_URL=http:\/\/neko:9223/);
  assert.match(envExample, /PDPP_NEKO_CDP_HTTP_URL=http:\/\/neko:9223/);
  assert.match(envExample, /NEKO_CONTROL_USERNAME=admin/);
  assert.match(envExample, /NEKO_CONTROL_PASSWORD=\n/);
  assert.match(envExample, /NEKO_USERNAME=user/);
  assert.match(envExample, /NEKO_PASSWORD=neko/);
  assert.match(envExample, /NEKO_MEMBER_PROVIDER=multiuser/);
  assert.match(envExample, /NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=\n/);
  assert.match(envExample, /NEKO_MEMBER_MULTIUSER_USER_PASSWORD=\n/);
  assert.match(envExample, new RegExp(`PDPP_NEKO_MANAGED_CONNECTORS=${MANAGED_CONNECTOR_IDS.join(',')}`));
  assert.match(envExample, /PDPP_NEKO_SURFACE_MODE=dynamic/);
  assert.match(envExample, /PDPP_NEKO_SURFACE_CAP=3/);
  assert.match(envExample, /PDPP_NEKO_STATIC_PROFILE_KEY=\n/);
});

test('ChatGPT large-history guardrails are wired into Docker runtime config', async () => {
  const [compose, envExample] = await Promise.all([
    readFile(COMPOSE_FILE, 'utf8'),
    readFile(ENV_EXAMPLE_FILE, 'utf8'),
  ]);

  for (const key of [
    'PDPP_CHATGPT_MAX_DETAIL_FETCHES_PER_RUN',
    'PDPP_CHATGPT_MAX_RUN_WALL_CLOCK_MS',
    'PDPP_CHATGPT_DETAIL_RATE_LIMIT_STOP_AFTER',
  ]) {
    assert.ok(compose.includes(`${key}: ${'${'}${key}:-}`));
    assert.match(envExample, new RegExp(`^${key}=`, 'm'));
  }
});

test('USAA remains an owner-present managed n.eko connector in the committed runtime config, not background-safe', async () => {
  const usaaManifest = JSON.parse(
    await readFile(`${REPO_ROOT}packages/polyfill-connectors/manifests/usaa.json`, 'utf8'),
  );
  const envExample = await readFile(ENV_EXAMPLE_FILE, 'utf8');

  assert.equal(usaaManifest.connector_id, USAA_CONNECTOR_ID);
  assert.equal(usaaManifest.runtime_requirements.bindings.browser.required, true);
  assert.deepEqual(usaaManifest.capabilities.human_interaction, ['manual_action']);
  assert.equal(usaaManifest.capabilities.refresh_policy.recommended_mode, 'manual');
  assert.equal(usaaManifest.capabilities.refresh_policy.background_safe, false);
  assert.match(envExample, new RegExp(`PDPP_NEKO_MANAGED_CONNECTORS=.*${USAA_CONNECTOR_ID}`));
});

test('Amazon remains manual-default and owner-present managed on n.eko, with owner opt-in background scheduling declared', async () => {
  const amazonManifest = JSON.parse(
    await readFile(`${REPO_ROOT}packages/polyfill-connectors/manifests/amazon.json`, 'utf8'),
  );
  const envExample = await readFile(ENV_EXAMPLE_FILE, 'utf8');

  assert.equal(amazonManifest.connector_id, AMAZON_CONNECTOR_ID);
  assert.equal(amazonManifest.runtime_requirements.bindings.browser.required, true);
  assert.deepEqual(amazonManifest.capabilities.human_interaction, ['manual_action', 'otp']);
  assert.equal(amazonManifest.capabilities.refresh_policy.recommended_mode, 'manual');
  // background_safe:true only permits an explicit owner-created schedule; it
  // does not auto-enroll (recommended_mode stays "manual"), so Amazon stays
  // an owner-present managed n.eko connector by default.
  assert.equal(amazonManifest.capabilities.refresh_policy.background_safe, true);
  assert.equal(amazonManifest.capabilities.refresh_policy.assisted_after_owner_auth, true);
  assert.match(envExample, new RegExp(`PDPP_NEKO_MANAGED_CONNECTORS=.*${AMAZON_CONNECTOR_ID}`));
});

test('Reddit remains manual-default and owner-present managed on n.eko, with owner opt-in background scheduling declared', async () => {
  const redditManifest = JSON.parse(
    await readFile(`${REPO_ROOT}packages/polyfill-connectors/manifests/reddit.json`, 'utf8'),
  );
  const envExample = await readFile(ENV_EXAMPLE_FILE, 'utf8');

  assert.equal(redditManifest.connector_id, REDDIT_CONNECTOR_ID);
  assert.equal(redditManifest.runtime_requirements.bindings.browser.required, true);
  // Reddit's own auto-login code documents the same class of friction as
  // Amazon (2FA/OTP on first login, Cloudflare challenge fallback to
  // manual_action) — human_interaction now declares that honestly instead
  // of under-stating it as bare "credentials".
  assert.deepEqual(redditManifest.capabilities.human_interaction, ['manual_action', 'otp']);
  assert.equal(redditManifest.capabilities.refresh_policy.recommended_mode, 'manual');
  assert.equal(redditManifest.capabilities.refresh_policy.background_safe, true);
  assert.equal(redditManifest.capabilities.refresh_policy.assisted_after_owner_auth, true);
  assert.match(envExample, new RegExp(`PDPP_NEKO_MANAGED_CONNECTORS=.*${REDDIT_CONNECTOR_ID}`));
});

// The tests above assert that USAA is present in the env-template string. That
// proves config but not routing: the controller does not grep the env file, it
// gates managed-surface acquisition on
// `browserSurfaceLeaseManager.isManagedConnector(connectorId)`
// (reference-implementation/runtime/controller.ts). A refactor of the
// connector-id alias/canonical-key resolution could leave USAA in the env
// template yet stop the parser from recognising it, silently dropping USAA back
// to the plain Docker path and `headed_browser_unavailable`. This test runs the
// real runtime config off the committed managed-connector list and asserts the
// parser still routes USAA — by both its canonical registry URL and its short
// connector key.
test('runtime config routes USAA to a managed n.eko surface from the committed connector list', async () => {
  const envExample = await readFile(ENV_EXAMPLE_FILE, 'utf8');
  const managedLine = envExample
    .split('\n')
    .find((line) => line.startsWith('PDPP_NEKO_MANAGED_CONNECTORS='));
  assert.ok(managedLine, 'PDPP_NEKO_MANAGED_CONNECTORS must be defined in .env.docker.example');
  const managedConnectors = managedLine.slice('PDPP_NEKO_MANAGED_CONNECTORS='.length);
  assert.ok(
    managedConnectors.split(',').includes(USAA_CONNECTOR_ID),
    'committed managed-connector list must include the USAA connector id',
  );

  const options = await resolveNekoBrowserSurfaceControllerOptions({
    env: {
      PDPP_NEKO_MANAGED_CONNECTORS: managedConnectors,
      PDPP_NEKO_SURFACE_MODE: 'dynamic',
      PDPP_NEKO_SURFACE_CAP: '3',
      PDPP_NEKO_ALLOCATOR_URL: 'http://allocator.test/api',
      PDPP_NEKO_PROFILE_STORAGE_POLICY: 'persistent',
      PDPP_NEKO_PROFILE_STORAGE_ROOT: '/var/lib/pdpp/neko-profiles',
    },
    getBrowserSurfaceLeaseStore: () => createEmptyLeaseStore(),
    createBrowserSurfaceAllocator: () => ({ ensureSurface: async () => undefined }),
  });

  assert.ok(options.browserSurfaceLeaseManager);
  // The controller calls isManagedConnector with whatever connector id the run
  // carries. Both the canonical registry URL and the short key must resolve so
  // USAA acquires a managed surface instead of failing headed_browser_unavailable.
  assert.equal(options.browserSurfaceLeaseManager.isManagedConnector(USAA_CONNECTOR_ID), true);
  assert.equal(options.browserSurfaceLeaseManager.isManagedConnector('usaa'), true);
});

function createEmptyLeaseStore() {
  return {
    async listSurfaces() {
      return [];
    },
    async listNonTerminalLeases() {
      return [];
    },
    async repairStaleSurfaceActiveLeases() {},
  };
}
