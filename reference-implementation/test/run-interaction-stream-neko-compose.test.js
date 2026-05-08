import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OVERLAY_FILE = `${REPO_ROOT}docker-compose.neko.yml`;
const ENV_EXAMPLE_FILE = `${REPO_ROOT}.env.docker.example`;

test('n.eko compose overlay uses service DNS instead of reference network namespace', async () => {
  const [overlay, envExample] = await Promise.all([
    readFile(OVERLAY_FILE, 'utf8'),
    readFile(ENV_EXAMPLE_FILE, 'utf8'),
  ]);

  assert.doesNotMatch(overlay, /network_mode:\s*["']?service:reference/);
  assert.match(overlay, /PDPP_NEKO_BASE_URL:\s*\$\{PDPP_NEKO_BASE_URL:-http:\/\/neko:8080\/neko\}/);
  assert.match(overlay, /PDPP_NEKO_PROXY_ALLOWED_HOSTS:\s*\$\{PDPP_NEKO_PROXY_ALLOWED_HOSTS:-neko:8080\}/);
  assert.match(overlay, /PDPP_NEKO_CDP_HTTP_URL:\s*\$\{PDPP_NEKO_CDP_HTTP_URL:-http:\/\/neko:9223\}/);
  assert.match(overlay, /web:[\s\S]*depends_on:[\s\S]*neko:[\s\S]*condition:\s*service_healthy/);
  assert.match(overlay, /neko:[\s\S]*ports:[\s\S]*"\$\{NEKO_WEBRTC_PORT:-59000\}:59000\/tcp"/);
  assert.match(overlay, /neko:[\s\S]*ports:[\s\S]*"\$\{NEKO_WEBRTC_PORT:-59000\}:59000\/udp"/);

  assert.match(envExample, /PDPP_NEKO_BASE_URL=http:\/\/neko:8080\/neko/);
  assert.match(envExample, /PDPP_NEKO_PROXY_ALLOWED_HOSTS=neko:8080/);
  assert.match(envExample, /PDPP_NEKO_CDP_HTTP_URL=http:\/\/neko:9223/);
});
