// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

function receipt(overrides = {}) {
  return {
    connection_id: 'chatgpt:connection-a',
    surface_subject_id: 'chatgpt:connection-a',
    replacement_id: 'replacement-a',
    phase: 'started',
    ...overrides,
  };
}

test('current started receipt is scoped and defaults the health view to replacement_pending', async () => {
  const { readCurrentReplacementReceipt } = await import('../runtime/browser-surface/replacement-receipt-reader.ts');
  const { projectEphemeralBrowserSurfaceHealth } = await import('../runtime/browser-surface/ephemeral-health-projection.ts');
  const observed = [];
  const current = await readCurrentReplacementReceipt({
    connection_id: 'chatgpt:connection-a',
    surface_subject_id: 'chatgpt:connection-a',
    reader: { selectCurrent: async (input) => { observed.push(input); return receipt(); } },
  });
  assert.equal(current.state, 'available');
  assert.equal(current.receipt?.phase, 'started');
  assert.deepEqual(observed, [{
    connection_id: 'chatgpt:connection-a',
    surface_subject_id: 'chatgpt:connection-a',
  }]);
  const runtime = projectEphemeralBrowserSurfaceHealth({
    connection_id: 'chatgpt:connection-a',
    connection_kind: 'browser-runtime',
    surface_mode: 'static-managed',
    static_surface: { readable: true, status: 'ready' },
    current_replacement_receipt: current.receipt,
  });
  assert.equal(runtime.credential_continuity, 'replacement_pending');
});

test('completed receipt is delegated to Luna with the independently observed current generation', async () => {
  const { readCurrentReplacementReceipt } = await import('../runtime/browser-surface/replacement-receipt-reader.ts');
  const observed = [];
  const current = await readCurrentReplacementReceipt({
    connection_id: 'chatgpt:connection-a',
    surface_subject_id: 'chatgpt:connection-a',
    current_generation_hash: 'generation-current',
    reader: {
      selectCurrent: async (input) => {
        observed.push(input);
        return input.current_generation_hash === 'generation-current'
          ? receipt({ phase: 'completed' })
          : null;
      },
    },
  });
  assert.equal(current.state, 'available');
  assert.equal(current.receipt?.phase, 'completed');
  assert.deepEqual(observed, [{
    connection_id: 'chatgpt:connection-a',
    current_generation_hash: 'generation-current',
    surface_subject_id: 'chatgpt:connection-a',
  }]);
});

test('Luna reader failure fails closed while an ordinary no-replacement selection remains available', async () => {
  const { readCurrentReplacementReceipt } = await import('../runtime/browser-surface/replacement-receipt-reader.ts');
  const { projectEphemeralBrowserSurfaceHealth } = await import('../runtime/browser-surface/ephemeral-health-projection.ts');
  const unavailable = await readCurrentReplacementReceipt({
    connection_id: 'chatgpt:connection-a',
    reader: { selectCurrent: async () => { throw new Error('store unavailable'); } },
  });
  assert.deepEqual(unavailable, { state: 'unavailable', receipt: null });

  const noReplacement = await readCurrentReplacementReceipt({
    connection_id: 'heb',
    reader: { selectCurrent: async () => null },
  });
  assert.deepEqual(noReplacement, { state: 'available', receipt: null });
  const runtime = projectEphemeralBrowserSurfaceHealth({
    connection_id: 'heb',
    connection_kind: 'browser-runtime',
    surface_mode: 'dynamic-managed',
    allocator_observation: { status: 'available' },
    current_replacement_receipt: noReplacement.receipt,
  });
  assert.equal(runtime.credential_continuity, 'not_applicable');
});

test('single-instance Luna receipts omit the optional subject but remain connection-scoped', async () => {
  const { readCurrentReplacementReceipt } = await import('../runtime/browser-surface/replacement-receipt-reader.ts');
  const current = await readCurrentReplacementReceipt({
    connection_id: 'chatgpt',
    reader: { selectCurrent: async () => receipt({ connection_id: 'chatgpt', surface_subject_id: undefined }) },
  });
  assert.equal(current.state, 'available');
  assert.equal(current.receipt?.connection_id, 'chatgpt');
  assert.equal(current.receipt?.surface_subject_id, undefined);
});
