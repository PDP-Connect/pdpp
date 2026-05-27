import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OVERLAY_FILE = `${REPO_ROOT}docker-compose.neko.yml`;
const ENV_EXAMPLE_FILE = `${REPO_ROOT}.env.docker.example`;
const CHATGPT_CONNECTOR_ID = 'https://registry.pdpp.org/connectors/chatgpt';
const CHASE_CONNECTOR_ID = 'https://registry.pdpp.org/connectors/chase';
const USAA_CONNECTOR_ID = 'https://registry.pdpp.org/connectors/usaa';
const AMAZON_CONNECTOR_ID = 'https://registry.pdpp.org/connectors/amazon';
const MANAGED_CONNECTOR_IDS = [CHATGPT_CONNECTOR_ID, CHASE_CONNECTOR_ID, USAA_CONNECTOR_ID, AMAZON_CONNECTOR_ID];

test('n.eko compose overlay uses service DNS instead of reference network namespace', async () => {
  const [overlay, envExample] = await Promise.all([
    readFile(OVERLAY_FILE, 'utf8'),
    readFile(ENV_EXAMPLE_FILE, 'utf8'),
  ]);

  assert.doesNotMatch(overlay, /network_mode:\s*["']?service:reference/);
  assert.match(overlay, /PDPP_NEKO_BASE_URL:\s*\$\{PDPP_NEKO_BASE_URL-http:\/\/neko:8080\/neko\}/);
  assert.match(overlay, /PDPP_NEKO_PROXY_ALLOWED_HOSTS:\s*\$\{PDPP_NEKO_PROXY_ALLOWED_HOSTS:-neko:8080\}/);
  assert.match(overlay, /PDPP_NEKO_CDP_HTTP_URL:\s*\$\{PDPP_NEKO_CDP_HTTP_URL-http:\/\/neko:9223\}/);
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
  assert.match(envExample, /PDPP_NEKO_CDP_HTTP_URL=http:\/\/neko:9223/);
  assert.match(envExample, new RegExp(`PDPP_NEKO_MANAGED_CONNECTORS=${MANAGED_CONNECTOR_IDS.join(',')}`));
  assert.match(envExample, /PDPP_NEKO_SURFACE_MODE=dynamic/);
  assert.match(envExample, /PDPP_NEKO_SURFACE_CAP=3/);
  assert.match(envExample, /PDPP_NEKO_STATIC_PROFILE_KEY=\n/);
});

test('USAA remains an owner-present managed n.eko connector, not background-safe', async () => {
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

test('Amazon remains an owner-present managed n.eko connector, not background-safe', async () => {
  const amazonManifest = JSON.parse(
    await readFile(`${REPO_ROOT}packages/polyfill-connectors/manifests/amazon.json`, 'utf8'),
  );
  const envExample = await readFile(ENV_EXAMPLE_FILE, 'utf8');

  assert.equal(amazonManifest.connector_id, AMAZON_CONNECTOR_ID);
  assert.equal(amazonManifest.runtime_requirements.bindings.browser.required, true);
  assert.deepEqual(amazonManifest.capabilities.human_interaction, ['manual_action', 'otp']);
  assert.equal(amazonManifest.capabilities.refresh_policy.recommended_mode, 'manual');
  assert.equal(amazonManifest.capabilities.refresh_policy.background_safe, false);
  assert.match(envExample, new RegExp(`PDPP_NEKO_MANAGED_CONNECTORS=.*${AMAZON_CONNECTOR_ID}`));
});
