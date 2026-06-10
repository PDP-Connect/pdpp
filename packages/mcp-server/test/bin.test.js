import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const binPath = fileURLToPath(new URL('../bin/pdpp-mcp-server.js', import.meta.url));

test('bin help writes to stderr, leaving stdout clean for the MCP protocol stream', () => {
  const result = spawnSync(process.execPath, [binPath, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '', 'stdout must remain empty so MCP framing is not corrupted');
  assert.match(result.stderr, /pdpp-mcp-server/);
});

test('bin exits with usage code when provider URL is missing', () => {
  const result = spawnSync(process.execPath, [binPath], {
    encoding: 'utf8',
    env: { ...process.env, PDPP_PROVIDER_URL: '', PDPP_OWNER_TOKEN: '', PDPP_OWNER_SESSION_COOKIE: '' },
  });
  assert.equal(result.status, 64);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Missing --provider-url/);
});

test('bin refuses to start when PDPP_OWNER_TOKEN is set in env', () => {
  const result = spawnSync(process.execPath, [binPath, '--provider-url', 'https://example.com'], {
    encoding: 'utf8',
    env: { ...process.env, PDPP_OWNER_TOKEN: 'sekrit', PDPP_OWNER_SESSION_COOKIE: '' },
  });
  assert.equal(result.status, 77);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Refusing to start/);
});
