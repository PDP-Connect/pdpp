import test from 'node:test';
import assert from 'node:assert/strict';

import { createPlayground } from '../server/streaming/playground.js';
import { createRunTargetRegistry } from '../server/streaming/run-target-registry.js';

test('stream playground can register a cached n.eko backend session', async () => {
  const runTargetRegistry = createRunTargetRegistry({
    sweepIntervalMs: 0,
    now: () => 1_000,
  });
  const controller = {
    getPendingInteraction() {
      return null;
    },
  };
  const baseUrl = 'http://neko:8080/neko';
  const playground = createPlayground({
    runTargetRegistry,
    controller,
    env: {
      PDPP_NEKO_BASE_URL: baseUrl,
    },
  });

  const session = await playground.getOrCreatePlaygroundSession({ backend: 'neko' });
  runTargetRegistry.forceUnregister({
    runId: session.runId,
    interactionId: session.interactionId,
  });
  assert.equal(
    runTargetRegistry.get({
      runId: session.runId,
      interactionId: session.interactionId,
    }),
    null,
  );
  const cached = await playground.getOrCreatePlaygroundSession({ backend: 'neko' });

  assert.equal(session, cached);
  assert.equal(session.backend, 'neko');
  assert.match(session.runId, /^playground_neko_/);
  const target = runTargetRegistry.get({
    runId: session.runId,
    interactionId: session.interactionId,
  });
  assert.equal(target.backend, 'neko');
  assert.equal(target.base_url, baseUrl);
  assert.match(target.start_url, /^data:text\/html;charset=utf-8,/);
  assert.deepEqual(controller.getPendingInteraction(session.runId), {
    run_id: session.runId,
    connector_id: 'playground:dev',
    interaction_id: session.interactionId,
    kind: 'manual_action',
    stream: null,
  });

  await assert.rejects(
    () => playground.getOrCreatePlaygroundSession({ backend: 'unknown' }),
    /playground backend must be "cdp" or "neko"/,
  );
});
