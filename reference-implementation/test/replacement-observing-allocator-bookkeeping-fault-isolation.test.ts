// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

// biome-ignore lint/correctness/noUnresolvedImports: localized test assertion preserves its explicit contract.
import type { BrowserSurface, BrowserSurfaceAllocator } from "@opendatalabs/remote-surface/leases";
import {
  createBrowserSurfaceReplacementLedger,
  createReplacementObservingAllocator,
} from "../runtime/browser-surface/replacement-receipt-ledger.ts";

// 2026-08-01 Amazon incident (run_227a4fbba7af49bea5a33cc55bb4f12c): the
// replacement-ledger bookkeeping wrapped around ensureSurface/stopSurface
// threw a plain, unwrapped Error from a receipt-store lookup/persist call —
// entirely separate from the real allocator's own success/failure — and
// that plain Error was indistinguishable, from the caller's perspective,
// from the allocator itself failing. wrapAllocatorWithTransientPollRetry
// exhausted its bounded retry budget on this masked error and terminalized
// an otherwise-healthy lease to surface_failed. These tests prove the
// bookkeeping can no longer produce that failure mode: a real allocator
// result (success or failure) must survive bookkeeping faults on both
// sides of the call.

const surface: BrowserSurface = {
  backend: "neko",
  cdp_url: "http://neko:9222",
  connector_id: "amazon",
  container_id: "container-real-1",
  created_at: "2026-08-01T08:16:24.000Z",
  health: "ready",
  last_used_at: "2026-08-01T08:16:24.000Z",
  profile_key: "amazon:cin_test",
  stream_base_url: "http://neko:8080",
  surface_id: "bs_test",
  surface_subject_id: "cin_test",
};

function baseAllocator(overrides: Partial<BrowserSurfaceAllocator> = {}): BrowserSurfaceAllocator {
  return {
    ensureSurface: async () => surface,
    getSurfaceStatus: async () => null,
    listSurfaces: async () => [surface],
    stopSurface: async () => null,
    ...overrides,
  };
}

test("a findPendingForScope lookup failure before ensureSurface does not prevent the real allocator call, and a successful allocator result still resolves", async () => {
  const ledger = createBrowserSurfaceReplacementLedger();
  let ensureSurfaceCalls = 0;
  const persistenceErrors: unknown[] = [];
  const observed = createReplacementObservingAllocator(
    baseAllocator({
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      ensureSurface: async () => {
        ensureSurfaceCalls += 1;
        return surface;
      },
    }),
    {
      findPendingForScope: () => Promise.reject(new Error("simulated receipt-store lookup failure")),
      ledger,
      onPersistenceError: (error) => persistenceErrors.push(error),
    }
  );

  const result = await observed.ensureSurface({
    connectorId: surface.connector_id,
    profileKey: surface.profile_key,
    surfaceId: surface.surface_id,
  });

  assert.deepEqual(result, surface, "the real allocator's successful result must be returned, not masked");
  assert.equal(ensureSurfaceCalls, 1, "the real allocator must actually be called despite the bookkeeping fault");
  assert.equal(persistenceErrors.length, 1, "the bookkeeping fault must be reported, not silently dropped");
});

test("a persist failure after a successful ensureSurface does not turn the success into a thrown error", async () => {
  const ledger = createBrowserSurfaceReplacementLedger();
  const before: BrowserSurface = { ...surface, allocator_metadata: { ensure_disposition: "replace" } };
  const after: BrowserSurface = { ...surface, container_id: "container-real-2" };
  let ensureSurfaceCalls = 0;
  const persistenceErrors: unknown[] = [];
  const observed = createReplacementObservingAllocator(
    baseAllocator({
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      ensureSurface: async () => {
        ensureSurfaceCalls += 1;
        return after;
      },
      getSurfaceStatus: async () => before,
    }),
    {
      ledger,
      onPersistenceError: (error) => persistenceErrors.push(error),
      persist: () => Promise.reject(new Error("simulated persist failure")),
    }
  );

  const result = await observed.ensureSurface({
    connectorId: surface.connector_id,
    profileKey: surface.profile_key,
    surfaceId: surface.surface_id,
  });

  assert.deepEqual(result, after, "a real allocator success must resolve even when persisting its receipt fails");
  assert.equal(ensureSurfaceCalls, 1);
  assert.ok(persistenceErrors.length >= 1, "the persist fault must be reported, not silently dropped");
});

test("a real ensureSurface failure still propagates as itself, even when the failure-boundary bookkeeping also throws", async () => {
  const ledger = createBrowserSurfaceReplacementLedger();
  const realError = new Error("real allocator ensureSurface failure");
  const persistenceErrors: unknown[] = [];
  const observed = createReplacementObservingAllocator(
    baseAllocator({
      ensureSurface: () => Promise.reject(realError),
      getSurfaceStatus: async () => ({ ...surface, allocator_metadata: { ensure_disposition: "replace" } }),
    }),
    {
      ledger,
      onPersistenceError: (error) => persistenceErrors.push(error),
      persist: () => Promise.reject(new Error("simulated persist failure recording the failure itself")),
    }
  );

  await assert.rejects(
    observed.ensureSurface({
      connectorId: surface.connector_id,
      profileKey: surface.profile_key,
      surfaceId: surface.surface_id,
    }),
    (error: unknown) => error === realError,
    "the real allocator error must survive unchanged, not be replaced by a bookkeeping error"
  );
  assert.ok(persistenceErrors.length >= 1);
});

test("a startStopReceipt bookkeeping failure before stopSurface does not prevent the real stopSurface call", async () => {
  const ledger = createBrowserSurfaceReplacementLedger();
  let stopSurfaceCalls = 0;
  const persistenceErrors: unknown[] = [];
  const observed = createReplacementObservingAllocator(
    baseAllocator({
      getSurfaceStatus: async () => surface,
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      stopSurface: async () => {
        stopSurfaceCalls += 1;
        return null;
      },
    }),
    {
      ledger,
      onPersistenceError: (error) => persistenceErrors.push(error),
      persist: () => Promise.reject(new Error("simulated persist failure on stop receipt")),
    }
  );

  const result = await observed.stopSurface({ reason: "capacity_pressure", surfaceId: surface.surface_id });

  assert.equal(result, null);
  assert.equal(
    stopSurfaceCalls,
    1,
    "the real allocator stopSurface must still be called despite the bookkeeping fault"
  );
  assert.ok(persistenceErrors.length >= 1);
});
