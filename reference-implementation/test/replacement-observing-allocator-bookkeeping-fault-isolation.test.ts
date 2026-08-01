// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

// biome-ignore lint/correctness/noUnresolvedImports: localized test assertion preserves its explicit contract.
import type { BrowserSurface, BrowserSurfaceAllocator } from "@opendatalabs/remote-surface/leases";
import type { ReplacementReceipt } from "../runtime/browser-surface/replacement-receipt-ledger.ts";
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

// 2026-08-01 gate revision (Blocker 1): every catch in this file reports a
// persistence fault via `options.onPersistenceError`, which is
// production-wired to `log.warn` (replacement-lifecycle-hooks.ts) — a
// function that is not guaranteed not to throw. The reporter itself must
// never be able to replace or block the real result/error being returned.
// These three tests exercise each of the three places a masking-via-logger
// could occur: a real success, a real ensureSurface failure, and a real
// stopSurface failure.

test("a throwing onPersistenceError reporter cannot mask a real ensureSurface success", async () => {
  const ledger = createBrowserSurfaceReplacementLedger();
  const before: BrowserSurface = { ...surface, allocator_metadata: { ensure_disposition: "replace" } };
  const after: BrowserSurface = { ...surface, container_id: "container-real-3" };
  let ensureSurfaceCalls = 0;
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
      onPersistenceError: () => {
        throw new Error("simulated throwing logger (log.warn)");
      },
      persist: () => Promise.reject(new Error("simulated persist failure")),
    }
  );

  const result = await observed.ensureSurface({
    connectorId: surface.connector_id,
    profileKey: surface.profile_key,
    surfaceId: surface.surface_id,
  });

  assert.deepEqual(result, after, "a throwing reporter must not replace a real allocator success");
  assert.equal(ensureSurfaceCalls, 1);
});

test("a throwing onPersistenceError reporter cannot mask a real ensureSurface failure", async () => {
  const ledger = createBrowserSurfaceReplacementLedger();
  const realError = new Error("real allocator ensureSurface failure");
  const observed = createReplacementObservingAllocator(
    baseAllocator({
      ensureSurface: () => Promise.reject(realError),
      getSurfaceStatus: async () => ({ ...surface, allocator_metadata: { ensure_disposition: "replace" } }),
    }),
    {
      ledger,
      onPersistenceError: () => {
        throw new Error("simulated throwing logger (log.warn)");
      },
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
    "a throwing reporter must not replace the real allocator error"
  );
});

test("a throwing onPersistenceError reporter cannot mask a real stopSurface failure", async () => {
  const ledger = createBrowserSurfaceReplacementLedger();
  const realError = new Error("real allocator stopSurface failure");
  const observed = createReplacementObservingAllocator(
    baseAllocator({
      getSurfaceStatus: async () => surface,
      stopSurface: () => Promise.reject(realError),
    }),
    {
      ledger,
      onPersistenceError: () => {
        throw new Error("simulated throwing logger (log.warn)");
      },
      persist: () => Promise.reject(new Error("simulated persist failure on stop receipt")),
    }
  );

  await assert.rejects(
    observed.stopSurface({ reason: "capacity_pressure", surfaceId: surface.surface_id }),
    (error: unknown) => error === realError,
    "a throwing reporter must not replace the real allocator stopSurface error"
  );
});

// 2026-08-01 gate revision (Blocker 2): ledger.start() mutates the ledger's
// in-memory receipt list unconditionally, before persist is even attempted.
// A rejected first persist for a container-rotation receipt must not leave
// that unresolved in-memory receipt permanently blocking every LATER real
// rotation's own receipt from ever reaching the durable store, once the
// store has recovered.

test("a failed first persist does not suppress a later durable transition receipt after the store recovers", async () => {
  // Single allocator instance for both rotations — matches production,
  // where createReplacementLifecycleHooks (and the createReplacementObservingAllocator
  // it wraps) is constructed exactly once per BrowserSurfaceManager and
  // reused for the lifetime of the process, not re-created per attempt.
  const ledger = createBrowserSurfaceReplacementLedger();
  const persisted: ReplacementReceipt[] = [];
  const storeState = { down: true };
  const container1: BrowserSurface = { ...surface, container_id: "container-1" };
  const container2: BrowserSurface = { ...surface, container_id: "container-2" };
  const container3: BrowserSurface = { ...surface, container_id: "container-3" };
  // The allocator's current, real state — what getSurfaceStatus reports as
  // "before" a rotation. ensureSurface advances it to `nextSurface` and
  // returns the advanced value, exactly like a real allocator whose
  // ensureSurface call performs the rotation and returns the result.
  let liveSurface = container1;
  let nextSurface = container2;

  const observed = createReplacementObservingAllocator(
    {
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      ensureSurface: async () => {
        liveSurface = nextSurface;
        return liveSurface;
      },
      getSurfaceStatus: async () => liveSurface,
      listSurfaces: async () => [liveSurface],
      stopSurface: async () => null,
    },
    {
      ledger,
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      persist: async (receipt) => {
        // biome-ignore lint/suspicious/noUnnecessaryConditions: storeState.down is mutated later via a shared object reference, which biome's narrowing cannot see across the closure.
        if (storeState.down) {
          throw new Error("simulated store outage");
        }
        persisted.push(receipt);
        return receipt;
      },
    }
  );

  // Rotation 1: container-1 -> container-2, persist rejected (store down).
  const firstResult = await observed.ensureSurface({
    connectorId: surface.connector_id,
    profileKey: surface.profile_key,
    surfaceId: surface.surface_id,
  });
  assert.deepEqual(firstResult, container2, "the first rotation's real allocator result must still resolve");
  assert.equal(persisted.length, 0, "nothing durable yet — the store was down for rotation 1");

  // Store recovers before rotation 2. Rotation 2: container-2 -> container-3
  // on the SAME allocator instance (same in-memory ledger, same
  // durableFailures tracker) — the rejected rotation-1 receipt must not
  // suppress rotation 2's own receipt via the in-memory pending lookup.
  storeState.down = false;
  nextSurface = container3;
  const secondResult = await observed.ensureSurface({
    connectorId: surface.connector_id,
    profileKey: surface.profile_key,
    surfaceId: surface.surface_id,
  });

  assert.deepEqual(secondResult, container3, "the second rotation's real allocator result must resolve");
  assert.equal(
    persisted.length,
    1,
    "rotation 2's transition receipt must reach the durable store even though rotation 1's did not"
  );
  const [durableReceipt] = persisted;
  assert.ok(durableReceipt, "expected exactly one durable receipt");
  assert.equal(durableReceipt.phase, "started");
});

// 2026-08-01 gate revision (Blocker 3): createEnsureAttemptId is not wired
// in production (replacement-lifecycle-hooks.ts always defaults to
// randomUUID()) and exists purely to make bookkeeping idempotency keys
// deterministic in tests. It has no legitimate claim to being trusted more
// than the receipt-store lookups it feeds, so it now runs inside the same
// protected observation boundary as those lookups.

test("a throwing createEnsureAttemptId does not prevent the real ensureSurface call", async () => {
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
      createEnsureAttemptId: () => {
        throw new Error("simulated throwing attempt-id provider");
      },
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
  assert.ok(persistenceErrors.length >= 1, "the bookkeeping fault must be reported, not silently dropped");
});
