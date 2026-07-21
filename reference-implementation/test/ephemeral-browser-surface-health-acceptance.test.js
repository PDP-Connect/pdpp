import assert from 'node:assert/strict';
import test from 'node:test';

const NOW = '2026-07-16T12:00:00.000Z';

function historicalRuntimeReceipt(connectionId) {
  return {
    connection_id: connectionId,
    connector_id: connectionId,
    profile_key: `${connectionId}:profile`,
    run_id: `${connectionId}:run_current`,
    surface_subject_id: `${connectionId}:subject`,
    surface_id: `${connectionId}:surface`,
    lease_id: `${connectionId}:lease`,
    generation: 7,
    lifecycle: ['ready', 'succeeded', 'released'],
    completed_at: NOW,
  };
}

function dynamicInput(connectionId, overrides = {}) {
  return {
    connection_id: connectionId,
    connection_kind: 'browser-runtime',
    surface_mode: 'dynamic-managed',
    demand: 'none',
    active_lease: null,
    current_compatible_idle_surfaces: 0,
    allocator_observation: {
      status: 'available',
      observed_at: NOW,
      expires_at: '2026-07-16T12:05:00.000Z',
    },
    last_successful_runtime_receipt: historicalRuntimeReceipt(connectionId),
    ...overrides,
  };
}

test('explicit runtime projection keeps H-E-B and Reddit eligible with zero current idle surfaces', async () => {
  const { projectEphemeralBrowserSurfaceHealth } = await import('../runtime/browser-surface/ephemeral-health-projection.ts');

  for (const connectionId of ['heb', 'reddit']) {
    const result = projectEphemeralBrowserSurfaceHealth(dynamicInput(connectionId));
    assert.deepEqual(Object.keys(result).sort(), [
      'active_lease',
      'allocator_observation',
      'connection_kind',
      'credential_continuity',
      'current_compatible_idle_surfaces',
      'current_replacement_receipt',
      'demand',
      'health_eligible',
      'last_successful_runtime_receipt',
      'surface_mode',
    ], connectionId);
    assert.equal(result.health_eligible, true, connectionId);
    assert.equal(result.current_compatible_idle_surfaces, 0, connectionId);
    assert.equal(result.last_successful_runtime_receipt?.connection_id, connectionId, connectionId);
    assert.deepEqual(result.last_successful_runtime_receipt?.lifecycle, ['ready', 'succeeded', 'released'], connectionId);
    assert.equal(result.active_lease, null, connectionId);
  }
});

test('explicit runtime projection is fail-closed across allocator, active-lease, static, and unmanaged matrices', async () => {
  const { projectEphemeralBrowserSurfaceHealth } = await import('../runtime/browser-surface/ephemeral-health-projection.ts');
  const cases = [
    {
      name: 'dynamic allocator available, no demand, zero idle',
      input: dynamicInput('heb'),
      expected: { health_eligible: true, allocator_observation: 'available' },
    },
    {
      name: 'dynamic allocator unavailable HTTP',
      input: dynamicInput('heb', { allocator_observation: { status: 'unavailable', reason: 'http' } }),
      expected: { health_eligible: false, allocator_observation: 'unavailable' },
    },
    {
      name: 'dynamic allocator unavailable fetch',
      input: dynamicInput('heb', { allocator_observation: { status: 'unavailable', reason: 'fetch' } }),
      expected: { health_eligible: false, allocator_observation: 'unavailable' },
    },
    {
      name: 'dynamic allocator unavailable timeout',
      input: dynamicInput('heb', { allocator_observation: { status: 'unavailable', reason: 'timeout' } }),
      expected: { health_eligible: false, allocator_observation: 'unavailable' },
    },
    {
      name: 'dynamic allocator unavailable malformed',
      input: dynamicInput('heb', { allocator_observation: { status: 'unavailable', reason: 'malformed' } }),
      expected: { health_eligible: false, allocator_observation: 'unavailable' },
    },
    {
      name: 'dynamic allocator unknown not observed',
      input: dynamicInput('heb', { allocator_observation: { status: 'unknown', reason: 'not_observed' } }),
      expected: { health_eligible: false, allocator_observation: 'unknown' },
    },
    {
      name: 'dynamic allocator unknown expired',
      input: dynamicInput('heb', { allocator_observation: { status: 'unknown', reason: 'expired' } }),
      expected: { health_eligible: false, allocator_observation: 'unknown' },
    },
    {
      name: 'active healthy lease still fail closed without allocator certainty',
      input: dynamicInput('heb', {
        active_lease: { lease_id: 'lease_1', surface_id: 'surface_1', health: 'ready' },
        allocator_observation: { status: 'unknown', reason: 'not_observed' },
      }),
      expected: { health_eligible: false, allocator_observation: 'unknown' },
    },
    {
      name: 'active unhealthy lease worst-wins',
      input: dynamicInput('heb', {
        active_lease: { lease_id: 'lease_1', surface_id: 'surface_1', health: 'unhealthy' },
      }),
      expected: { health_eligible: false },
    },
    {
      name: 'active lease with missing surface is not green',
      input: dynamicInput('heb', {
        active_lease: { lease_id: 'lease_1', surface_id: 'surface_missing', health: 'missing' },
      }),
      expected: { health_eligible: false },
    },
    {
      name: 'static ready',
      input: {
        connection_id: 'static-a',
        connection_kind: 'browser-runtime',
        surface_mode: 'static-managed',
        static_surface: { status: 'ready', readable: true },
        demand: 'none',
      },
      expected: { health_eligible: true },
    },
    {
      name: 'static absent',
      input: {
        connection_id: 'static-a',
        connection_kind: 'browser-runtime',
        surface_mode: 'static-managed',
        static_surface: { status: 'absent', readable: true },
        demand: 'none',
      },
      expected: { health_eligible: false },
    },
    {
      name: 'static unhealthy',
      input: {
        connection_id: 'static-a',
        connection_kind: 'browser-runtime',
        surface_mode: 'static-managed',
        static_surface: { status: 'unhealthy', readable: true },
        demand: 'none',
      },
      expected: { health_eligible: false },
    },
    {
      name: 'static unreadable',
      input: {
        connection_id: 'static-a',
        connection_kind: 'browser-runtime',
        surface_mode: 'static-managed',
        static_surface: { status: 'unknown', readable: false },
        demand: 'none',
      },
      expected: { health_eligible: false },
    },
    {
      name: 'unmanaged browser',
      input: { connection_id: 'host-browser', connection_kind: 'unmanaged-browser', surface_mode: 'none', demand: 'none' },
      expected: { health_eligible: true, surface_mode: 'none' },
    },
    {
      name: 'non-browser',
      input: { connection_id: 'api', connection_kind: 'non-browser', surface_mode: 'none', demand: 'none' },
      expected: { health_eligible: true, surface_mode: 'none' },
    },
    {
      name: 'local device',
      input: { connection_id: 'device', connection_kind: 'local-device', surface_mode: 'none', demand: 'none' },
      expected: { health_eligible: true, surface_mode: 'none' },
    },
  ];

  for (const scenario of cases) {
    const result = projectEphemeralBrowserSurfaceHealth(scenario.input);
    for (const [field, expected] of Object.entries(scenario.expected)) {
      const actual = field === 'allocator_observation' ? result.allocator_observation?.status : result[field];
      assert.equal(actual, expected, scenario.name);
    }
  }
});

test('H-E-B and Reddit require a ready current lease for active dynamic demand', async () => {
  const { projectEphemeralBrowserSurfaceHealth } = await import('../runtime/browser-surface/ephemeral-health-projection.ts');

  for (const connectionId of ['heb', 'reddit']) {
    const missingLease = projectEphemeralBrowserSurfaceHealth(
      dynamicInput(connectionId, {
        demand: 'active',
        active_lease: null,
      })
    );
    assert.equal(missingLease.health_eligible, false, `${connectionId}: active demand cannot be green without a lease`);

    const readyLease = projectEphemeralBrowserSurfaceHealth(
      dynamicInput(connectionId, {
        demand: 'active',
        active_lease: { lease_id: `${connectionId}:lease`, surface_id: `${connectionId}:surface`, health: 'ready' },
      })
    );
    assert.equal(readyLease.health_eligible, true, `${connectionId}: current available allocator plus matching ready lease is green`);

    const unavailableAllocator = projectEphemeralBrowserSurfaceHealth(
      dynamicInput(connectionId, {
        demand: 'active',
        active_lease: { lease_id: `${connectionId}:lease`, surface_id: `${connectionId}:surface`, health: 'ready' },
        allocator_observation: { status: 'unknown', reason: 'not_observed' },
      })
    );
    assert.equal(unavailableAllocator.health_eligible, false, `${connectionId}: lease cannot override allocator currentness`);

    for (const health of ['unhealthy', 'missing']) {
      const negative = projectEphemeralBrowserSurfaceHealth(
        dynamicInput(connectionId, {
          demand: 'active',
          active_lease: { lease_id: `${connectionId}:lease`, surface_id: `${connectionId}:surface`, health },
        })
      );
      assert.equal(negative.health_eligible, false, `${connectionId}: active ${health} surface is not green`);
    }
  }
});

test('expired available allocator observations fail closed as unknown', async () => {
  const { projectEphemeralBrowserSurfaceHealth } = await import('../runtime/browser-surface/ephemeral-health-projection.ts');
  const result = projectEphemeralBrowserSurfaceHealth({
    ...dynamicInput('reddit'),
    now: '2026-07-16T12:06:00.000Z',
  });
  assert.equal(result.allocator_observation?.status, 'unknown');
  assert.equal(result.allocator_observation?.reason, 'expired');
  assert.equal(result.health_eligible, false);
});
