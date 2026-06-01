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
