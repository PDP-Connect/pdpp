import assert from 'node:assert/strict';
import test from 'node:test';

test('retained history does not hide the one independently current surface generation', async () => {
  const { selectCurrentBrowserGenerationHash } = await import('../runtime/browser-surface/replacement-generation-currentness.ts');
  const input = {
    connection_id: 'heb:account-a',
    connector_id: 'heb',
    profile_key: 'heb:account-a',
    current_surface_ids: new Set(['surface-current']),
    surfaces: [
      { surface_id: 'surface-history-1', connector_id: 'heb', profile_key: 'heb:account-a', surface_subject_id: 'heb:account-a', browser_generation_hash: 'old-1' },
      { surface_id: 'surface-history-2', connector_id: 'heb', profile_key: 'heb:account-a', surface_subject_id: 'heb:account-a', browser_generation_hash: 'old-2' },
      { surface_id: 'surface-current', connector_id: 'heb', profile_key: 'heb:account-a', surface_subject_id: 'heb:account-a', browser_generation_hash: 'current' },
    ],
  };
  assert.equal(selectCurrentBrowserGenerationHash(input), 'current');
});

test('zero or ambiguous current process generations cannot select a completed receipt', async () => {
  const { selectCurrentBrowserGenerationHash } = await import('../runtime/browser-surface/replacement-generation-currentness.ts');
  const scope = {
    connection_id: 'reddit:account-a',
    connector_id: 'reddit',
    profile_key: 'reddit:account-a',
  };
  const surfaces = [
    { surface_id: 'surface-a', connector_id: 'reddit', profile_key: 'reddit:account-a', surface_subject_id: 'reddit:account-a', browser_generation_hash: 'current-a' },
    { surface_id: 'surface-b', connector_id: 'reddit', profile_key: 'reddit:account-a', surface_subject_id: 'reddit:account-a', browser_generation_hash: 'current-b' },
  ];
  assert.equal(selectCurrentBrowserGenerationHash({ ...scope, current_surface_ids: new Set(), surfaces }), null);
  assert.equal(selectCurrentBrowserGenerationHash({ ...scope, current_surface_ids: new Set(['surface-a', 'surface-b']), surfaces }), null);
});

test('dormant dynamic pending replacement is not current, while active replacement remains a continuity boundary', async () => {
  const { shouldJoinCurrentReplacementReceipt } = await import('../runtime/browser-surface/replacement-generation-currentness.ts');
  const { projectEphemeralBrowserSurfaceHealth } = await import('../runtime/browser-surface/ephemeral-health-projection.ts');
  const pending = {
    connection_id: 'heb:account-a',
    surface_subject_id: 'heb:account-a',
    replacement_id: 'replacement-pending',
    phase: 'started',
  };
  const dormant = shouldJoinCurrentReplacementReceipt({
    surface_mode: 'dynamic-managed',
    demand: 'none',
    current_surface_ids: new Set(),
  });
  const active = shouldJoinCurrentReplacementReceipt({
    surface_mode: 'dynamic-managed',
    demand: 'active',
    current_surface_ids: new Set(),
  });
  assert.equal(dormant, false, 'no-demand/zero-surface H-E-B scale-to-zero does not join a dormant start');
  assert.equal(active, true, 'a new active replacement still joins its pending receipt');

  const base = {
    connection_id: 'heb:account-a',
    connection_kind: 'browser-runtime',
    surface_mode: 'dynamic-managed',
    allocator_observation: { status: 'available' },
    demand: 'none',
  };
  const dormantRuntime = projectEphemeralBrowserSurfaceHealth(base);
  const activeRuntime = projectEphemeralBrowserSurfaceHealth({
    ...base,
    demand: 'active',
    active_lease: { lease_id: 'lease-a', surface_id: 'surface-a', health: 'ready' },
    current_replacement_receipt: pending,
  });
  assert.equal(dormantRuntime.credential_continuity, 'not_applicable');
  assert.equal(activeRuntime.credential_continuity, 'replacement_pending');
});

test('current replacement IDs require exact scope and live remote or inventory evidence', async () => {
  const { currentSurfaceIdsForReplacementReceipt } = await import('../runtime/browser-surface/replacement-generation-currentness.ts');
  const currentSurfaceIds = currentSurfaceIdsForReplacementReceipt({
    connection_id: 'reddit:account-a',
    connector_id: 'reddit',
    profile_key: 'reddit:account-a',
    remote_surface_id: 'remote-current',
    persisted_surfaces: [
      {
        surface_id: 'remote-current',
        connector_id: 'reddit',
        profile_key: 'reddit:account-a',
        surface_subject_id: 'reddit:account-a',
        health: 'ready',
      },
      {
        surface_id: 'remote-wrong-subject',
        connector_id: 'reddit',
        profile_key: 'reddit:account-a',
        surface_subject_id: 'reddit:account-b',
        health: 'ready',
      },
    ],
    inventory_surfaces: [
      {
        surface_id: 'inventory-current',
        connector_id: 'reddit',
        profile_key: 'reddit:account-a',
        surface_subject_id: 'reddit:account-a',
        health: 'starting',
      },
      {
        surface_id: 'inventory-unhealthy',
        connector_id: 'reddit',
        profile_key: 'reddit:account-a',
        surface_subject_id: 'reddit:account-a',
        health: 'unhealthy',
      },
      {
        surface_id: 'inventory-wrong-profile',
        connector_id: 'reddit',
        profile_key: 'reddit:account-b',
        surface_subject_id: 'reddit:account-a',
        health: 'ready',
      },
    ],
  });

  assert.deepEqual([...currentSurfaceIds], ['remote-current', 'inventory-current']);
});

test('Reddit retained stopping surface does not make an idle-TTL pending receipt current', async () => {
  const {
    currentSurfaceIdsForReplacementReceipt,
    shouldJoinCurrentReplacementReceipt,
  } = await import('../runtime/browser-surface/replacement-generation-currentness.ts');
  const { projectEphemeralBrowserSurfaceHealth } = await import('../runtime/browser-surface/ephemeral-health-projection.ts');
  const stopping = {
    surface_id: 'reddit-retained-stopping',
    connector_id: 'reddit',
    profile_key: 'reddit:account-a',
    surface_subject_id: 'reddit:account-a',
    health: 'stopping',
    browser_generation_hash: 'retired-generation',
  };
  const currentSurfaceIds = currentSurfaceIdsForReplacementReceipt({
    connection_id: 'reddit:account-a',
    connector_id: 'reddit',
    profile_key: 'reddit:account-a',
    remote_surface_id: 'reddit-retained-stopping',
    persisted_surfaces: [stopping],
    inventory_surfaces: [stopping],
  });
  assert.deepEqual([...currentSurfaceIds], [], 'stopping persisted/inventory rows are not current processes');
  assert.equal(
    shouldJoinCurrentReplacementReceipt({
      surface_mode: 'dynamic-managed',
      demand: 'none',
      current_surface_ids: currentSurfaceIds,
    }),
    false,
    'the dormant idle-TTL receipt is not read from Luna',
  );
  const runtime = projectEphemeralBrowserSurfaceHealth({
    connection_id: 'reddit:account-a',
    connection_kind: 'browser-runtime',
    surface_mode: 'dynamic-managed',
    allocator_observation: { status: 'available' },
    demand: 'none',
  });
  assert.equal(runtime.health_eligible, true);
  assert.equal(runtime.credential_continuity, 'not_applicable');
});
