import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveNekoBrowserSurfaceControllerOptions } from '../server/index.js';

test('n.eko static runtime config builds controller options without allocator', async () => {
  let allocatorCalled = false;
  const store = createEmptyLeaseStore();
  const options = await resolveNekoBrowserSurfaceControllerOptions({
    env: {
      PDPP_NEKO_MANAGED_CONNECTORS: 'connector-a',
      PDPP_NEKO_SURFACE_CAP: '1',
      PDPP_NEKO_CDP_HTTP_URL: 'http://127.0.0.1:9222',
      PDPP_NEKO_BASE_URL: 'http://127.0.0.1:8080',
    },
    getBrowserSurfaceLeaseStore: () => store,
    createBrowserSurfaceAllocator: () => {
      allocatorCalled = true;
      return {};
    },
  });

  assert.equal(options.browserSurfaceLeaseStore, store);
  assert.ok(options.browserSurfaceLeaseManager);
  assert.equal(options.browserSurfaceAllocator, undefined);
  assert.equal(options.browserSurfaceReadinessTimeoutMs, undefined);
  assert.equal(allocatorCalled, false);
});

test('n.eko dynamic runtime config builds allocator and readiness controller options', async () => {
  const store = createEmptyLeaseStore();
  const allocator = { ensureSurface: async () => undefined };
  const allocatorOptions = [];
  const options = await resolveNekoBrowserSurfaceControllerOptions({
    env: {
      PDPP_NEKO_MANAGED_CONNECTORS: 'connector-a',
      PDPP_NEKO_SURFACE_MODE: 'dynamic',
      PDPP_NEKO_SURFACE_CAP: '2',
      PDPP_NEKO_ALLOCATOR_URL: 'http://allocator.test/api',
      PDPP_NEKO_PROFILE_STORAGE_POLICY: 'persistent',
      PDPP_NEKO_PROFILE_STORAGE_ROOT: '/var/lib/pdpp/neko-profiles',
      PDPP_NEKO_READINESS_TIMEOUT_MS: '34567',
    },
    getBrowserSurfaceLeaseStore: () => store,
    createBrowserSurfaceAllocator: (options) => {
      allocatorOptions.push(options);
      return allocator;
    },
  });

  assert.equal(options.browserSurfaceLeaseStore, store);
  assert.ok(options.browserSurfaceLeaseManager);
  assert.equal(options.browserSurfaceAllocator, allocator);
  assert.equal(options.browserSurfaceReadinessTimeoutMs, 34567);
  assert.deepEqual(allocatorOptions, [{ baseUrl: 'http://allocator.test/api' }]);
});

test('n.eko runtime config treats canonical connector URLs as matching short connector ids', async () => {
  const store = createEmptyLeaseStore();
  const options = await resolveNekoBrowserSurfaceControllerOptions({
    env: {
      PDPP_NEKO_MANAGED_CONNECTORS: 'https://registry.pdpp.org/connectors/chatgpt',
      PDPP_NEKO_SURFACE_MODE: 'dynamic',
      PDPP_NEKO_SURFACE_CAP: '2',
      PDPP_NEKO_ALLOCATOR_URL: 'http://allocator.test/api',
      PDPP_NEKO_PROFILE_STORAGE_POLICY: 'persistent',
      PDPP_NEKO_PROFILE_STORAGE_ROOT: '/var/lib/pdpp/neko-profiles',
    },
    getBrowserSurfaceLeaseStore: () => store,
    createBrowserSurfaceAllocator: () => ({ ensureSurface: async () => undefined }),
  });

  assert.ok(options.browserSurfaceLeaseManager);
  assert.equal(options.browserSurfaceLeaseManager.isManagedConnector('chatgpt'), true);
  assert.equal(options.browserSurfaceLeaseManager.isManagedConnector('https://registry.pdpp.org/connectors/chatgpt'), true);
});

test('n.eko explicit dynamic runtime config fails fast without allocator settings', async () => {
  await assert.rejects(
    resolveNekoBrowserSurfaceControllerOptions({
      env: {
        PDPP_NEKO_MANAGED_CONNECTORS: 'connector-a',
        PDPP_NEKO_SURFACE_MODE: 'dynamic',
        PDPP_NEKO_SURFACE_CAP: '1',
        PDPP_NEKO_PROFILE_STORAGE_POLICY: 'persistent',
        PDPP_NEKO_PROFILE_STORAGE_ROOT: '/var/lib/pdpp/neko-profiles',
      },
      getBrowserSurfaceLeaseStore: () => createEmptyLeaseStore(),
      createBrowserSurfaceAllocator: () => {
        throw new Error('allocator should not be reached after invalid config');
      },
    }),
    /PDPP_NEKO_ALLOCATOR_URL is required in dynamic n\.eko surface mode/,
  );
});

test('fair-slot invariant: a retained connector (ChatGPT) with cap=1 fails config closed', async () => {
  await assert.rejects(
    resolveNekoBrowserSurfaceControllerOptions({
      env: {
        PDPP_NEKO_MANAGED_CONNECTORS: 'https://registry.pdpp.org/connectors/chatgpt',
        PDPP_NEKO_SURFACE_MODE: 'dynamic',
        PDPP_NEKO_SURFACE_CAP: '1',
        PDPP_NEKO_ALLOCATOR_URL: 'http://allocator.test/api',
        PDPP_NEKO_PROFILE_STORAGE_POLICY: 'persistent',
        PDPP_NEKO_PROFILE_STORAGE_ROOT: '/var/lib/pdpp/neko-profiles',
      },
      getBrowserSurfaceLeaseStore: () => createEmptyLeaseStore(),
      createBrowserSurfaceAllocator: () => ({ ensureSurface: async () => undefined }),
    }),
    /must exceed the number of retained credential-boundary managed connectors/,
  );
});

test('fair-slot invariant: cap=3 with ChatGPT + four other connectors passes (one fair transient slot)', async () => {
  const store = createEmptyLeaseStore();
  const options = await resolveNekoBrowserSurfaceControllerOptions({
    env: {
      PDPP_NEKO_MANAGED_CONNECTORS:
        'https://registry.pdpp.org/connectors/chatgpt,https://registry.pdpp.org/connectors/chase,https://registry.pdpp.org/connectors/usaa,https://registry.pdpp.org/connectors/amazon,https://registry.pdpp.org/connectors/reddit',
      PDPP_NEKO_SURFACE_MODE: 'dynamic',
      PDPP_NEKO_SURFACE_CAP: '3',
      PDPP_NEKO_ALLOCATOR_URL: 'http://allocator.test/api',
      PDPP_NEKO_PROFILE_STORAGE_POLICY: 'persistent',
      PDPP_NEKO_PROFILE_STORAGE_ROOT: '/var/lib/pdpp/neko-profiles',
    },
    getBrowserSurfaceLeaseStore: () => store,
    createBrowserSurfaceAllocator: () => ({ ensureSurface: async () => undefined }),
  });
  assert.ok(options.browserSurfaceLeaseManager);
});

test('boot re-derives retained on a rehydrated NONTERMINAL LEASE that has no surface yet, not only on surfaces', async () => {
  // Regression: a queued (waiting_for_browser_surface) ChatGPT lease that was
  // persisted before a restart has no surface row for rederiveRetainedSurfaces
  // to mark. Before this fix, only listSurfaces() was re-derived, so this
  // lease would rehydrate non-retained; once it later materializes a surface
  // (queue promotion), that surface would be created WITHOUT the retained
  // flag and become evictable by routine idle-TTL / capacity-pressure reap —
  // reproducing the exact steady-state auth-loss bug this whole change fixes.
  const persistedLease = {
    lease_id: 'lease_queued_chatgpt',
    connector_id: 'https://registry.pdpp.org/connectors/chatgpt',
    profile_key: 'chatgpt:acct-a',
    surface_subject_id: 'acct-a',
    run_id: 'run_queued',
    status: 'waiting_for_browser_surface',
    priority_class: 'background',
    requested_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    fencing_token: 1,
    wait_reason: 'capacity_full',
    // No `retained` field persisted — this is the pre-fix rehydrated shape.
  };
  const store = {
    async listSurfaces() {
      return [];
    },
    async listNonTerminalLeases() {
      return [persistedLease];
    },
    async repairStaleSurfaceActiveLeases() {},
  };

  const options = await resolveNekoBrowserSurfaceControllerOptions({
    env: {
      PDPP_NEKO_MANAGED_CONNECTORS: 'https://registry.pdpp.org/connectors/chatgpt',
      PDPP_NEKO_SURFACE_MODE: 'dynamic',
      PDPP_NEKO_SURFACE_CAP: '3',
      PDPP_NEKO_ALLOCATOR_URL: 'http://allocator.test/api',
      PDPP_NEKO_PROFILE_STORAGE_POLICY: 'persistent',
      PDPP_NEKO_PROFILE_STORAGE_ROOT: '/var/lib/pdpp/neko-profiles',
    },
    getBrowserSurfaceLeaseStore: () => store,
    createBrowserSurfaceAllocator: () => ({ ensureSurface: async () => undefined }),
  });

  const manager = options.browserSurfaceLeaseManager;
  assert.ok(manager);
  assert.equal(manager.getLease('lease_queued_chatgpt')?.retained, true, 'rehydrated queued lease must be re-derived retained');

  // Prove it stays retained through materialization: promote the queued lease
  // into a surface and confirm that surface is created retained too.
  const promoted = manager.pumpQueuedLeases();
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0]?.lease_id, 'lease_queued_chatgpt');
  assert.equal(promoted[0]?.status, 'starting_surface');
  const surfaceId = promoted[0]?.surface_id;
  assert.ok(surfaceId);
  assert.equal(manager.getSurface(surfaceId)?.retained, true, 'surface materialized from a rehydrated queued retained lease must be retained');
});

// Note: the PER-CONNECTION fair-slot invariant (two retained ChatGPT surfaces +
// cap=3 = one transient slot; a third retained connection is refused) is enforced
// at retained-surface CREATION time in the lease manager, not by counting observed
// surfaces at boot. See `browser-surface-leases.test.ts` →
// "creating a retained surface that would consume the fair-slot reserve is
// terminally deferred". Counting rehydrated surfaces here would be fail-open: a
// configured retained connection that never acquired a surface is absent from the
// store, so it must be caught when its demand materializes, not at boot.

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
