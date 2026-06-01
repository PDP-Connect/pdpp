import assert from 'node:assert/strict';
import test from 'node:test';

import { createPlayground } from './playground.js';

function makePlayground(env = {}) {
  const registrations = [];
  const playground = createPlayground({
    controller: {
      getPendingInteraction() {
        return null;
      },
    },
    env,
    runTargetRegistry: {
      register(target) {
        registrations.push(target);
      },
    },
  });
  return { playground, registrations };
}

test('n.eko stream playground uses its own Docker base URL instead of dynamic runtime base URL', async () => {
  const { playground, registrations } = makePlayground({
    PDPP_NEKO_BASE_URL: '',
    PDPP_STREAM_PLAYGROUND_DOCKER: '1',
  });

  await playground.getOrCreatePlaygroundSession({ backend: 'neko' });

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].base_url, 'http://neko:8080/neko');
  assert.equal(registrations[0].cdp_http_url, 'http://neko:9223/');
});

test('n.eko stream playground base URL override is separate from managed runtime base URL', async () => {
  const { playground, registrations } = makePlayground({
    PDPP_NEKO_BASE_URL: '',
    PDPP_STREAM_PLAYGROUND_NEKO_BASE_URL: 'http://neko-playground:8080/neko',
  });

  await playground.getOrCreatePlaygroundSession({ backend: 'neko' });

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].base_url, 'http://neko-playground:8080/neko');
  assert.equal(registrations[0].cdp_http_url, undefined);
});

test('n.eko stream playground CDP URL override is separate from managed runtime CDP URL', async () => {
  const { playground, registrations } = makePlayground({
    PDPP_NEKO_BASE_URL: '',
    PDPP_NEKO_CDP_HTTP_URL: '',
    PDPP_STREAM_PLAYGROUND_NEKO_BASE_URL: 'http://neko-playground:8080/neko',
    PDPP_STREAM_PLAYGROUND_NEKO_CDP_HTTP_URL: 'http://neko-playground:9223',
  });

  await playground.getOrCreatePlaygroundSession({ backend: 'neko' });

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].base_url, 'http://neko-playground:8080/neko');
  assert.equal(registrations[0].cdp_http_url, 'http://neko-playground:9223');
});
