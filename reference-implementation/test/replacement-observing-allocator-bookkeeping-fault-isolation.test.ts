// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

// biome-ignore lint/correctness/noUnresolvedImports: localized test assertion preserves its explicit contract.
import type { BrowserSurface, BrowserSurfaceAllocator } from "@opendatalabs/remote-surface/leases";
import type {
  BrowserSurfaceReplacementLedger,
  ReplacementReceipt,
} from "../runtime/browser-surface/replacement-receipt-ledger.ts";
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

// 2026-08-01 second gate revision, Blocker 1: recordTerminal's
// `options.ledger.terminate(...)` call runs SYNCHRONOUSLY and outside the
// scope `record()`'s try/catch protects, so a throwing ledger on the stop
// failure path — unlike every other path in this file — could still
// replace the real stopSurface error. This must be closed exactly like the
// reporter-masking hazard: neither a throwing ledger NOR a throwing
// reporter reacting to it may replace the real allocator error.

function ledgerWithThrowingTerminate(real: BrowserSurfaceReplacementLedger): BrowserSurfaceReplacementLedger {
  return {
    ...real,
    terminate: () => {
      throw new Error("simulated synchronous ledger.terminate failure");
    },
  };
}

test("a synchronous ledger.terminate failure on the stop-failure path does not mask the real stopSurface error", async () => {
  const ledger = ledgerWithThrowingTerminate(createBrowserSurfaceReplacementLedger());
  const realError = new Error("real allocator stopSurface failure");
  const persistenceErrors: unknown[] = [];
  const observed = createReplacementObservingAllocator(
    baseAllocator({
      getSurfaceStatus: async () => surface,
      stopSurface: () => Promise.reject(realError),
    }),
    {
      ledger,
      onPersistenceError: (error) => persistenceErrors.push(error),
    }
  );

  await assert.rejects(
    observed.stopSurface({ reason: "capacity_pressure", surfaceId: surface.surface_id }),
    (error: unknown) => error === realError,
    "a throwing ledger.terminate must not replace the real allocator stopSurface error"
  );
  assert.ok(persistenceErrors.length >= 1, "the ledger fault must be reported, not silently dropped");
});

test("a synchronous ledger.terminate failure PLUS a throwing reporter still does not mask the real stopSurface error", async () => {
  const ledger = ledgerWithThrowingTerminate(createBrowserSurfaceReplacementLedger());
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
    }
  );

  await assert.rejects(
    observed.stopSurface({ reason: "capacity_pressure", surfaceId: surface.surface_id }),
    (error: unknown) => error === realError,
    "neither the throwing ledger nor the throwing reporter may replace the real allocator stopSurface error"
  );
});

// 2026-08-01 second gate revision, Blocker 2: a `started` receipt whose
// durable persist failed must never produce an orphan durable
// terminal/completed receipt once it resolves, and its volatile tracking
// must be explicitly retired — not merely bounded by luck — so it cannot
// grow indefinitely or keep suppressing later observations after its own
// lifecycle has closed.

test("a failed start's own resolution never durably persists terminal alone, even when the store recovers before that resolution's own write", async () => {
  // Single allocator instance: matches production (one
  // createReplacementObservingAllocator per BrowserSurfaceManager, reused
  // for its lifetime).
  const ledger = createBrowserSurfaceReplacementLedger();
  const persistedPhases: string[] = [];
  // The store fails EXACTLY the first persist call (the started write for
  // the preclaimed advertised-replacement) and then recovers for every
  // subsequent call, including that SAME resolution's own terminal write
  // moments later — this is the precise shape the gate's repro found:
  // `started` fails, but the store is back up by the time `terminal` for
  // the SAME replacement_id is attempted. Without the fix, that terminal
  // write durably succeeds with no started predecessor beneath it.
  let persistCalls = 0;
  const before: BrowserSurface = { ...surface, allocator_metadata: { ensure_disposition: "replace" } };
  const realError = new Error("real allocator ensureSurface failure");

  const observed = createReplacementObservingAllocator(
    {
      ensureSurface: () => Promise.reject(realError),
      getSurfaceStatus: async () => before,
      listSurfaces: async () => [before],
      stopSurface: async () => null,
    },
    {
      ledger,
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      persist: async (receipt) => {
        persistCalls += 1;
        if (persistCalls === 1) {
          throw new Error("simulated store outage — only the started write fails");
        }
        persistedPhases.push(receipt.phase);
        return receipt;
      },
    }
  );

  // The `started` write for the preclaimed advertised-replacement fails to
  // persist; the SAME attempt's failure path immediately resolves it to
  // `terminal`, and by then the store has "recovered" (persistCalls > 1).
  // Per the fix, a `started` receipt known to be non-durable must never
  // produce a durable `terminal` for the SAME replacement_id — the whole
  // non-durable lifecycle is suppressed and retired instead of leaving an
  // orphan terminal in the durable store.
  await assert.rejects(
    observed.ensureSurface({
      connectorId: surface.connector_id,
      profileKey: surface.profile_key,
      surfaceId: surface.surface_id,
    }),
    (error: unknown) => error === realError
  );
  assert.deepEqual(
    persistedPhases,
    [],
    "terminal must never durably persist alone once its started predecessor is known non-durable"
  );

  // A later, independent replacement for the SAME surface (its own
  // replacement_id) must still durably persist started before terminal, in
  // order — proving the suppressed lifecycle above did not leave any
  // lingering state that corrupts a later, unrelated resolution's topology.
  await assert.rejects(
    observed.ensureSurface({
      connectorId: surface.connector_id,
      profileKey: surface.profile_key,
      surfaceId: surface.surface_id,
    }),
    (error: unknown) => error === realError
  );
  assert.deepEqual(
    persistedPhases,
    ["started", "terminal"],
    "a later, independent resolution must durably persist started before terminal, in order"
  );
});

test("repeated failed-start-then-resolved lifecycles leave no retained tracker state or stale suppression", async () => {
  // Single allocator instance across every attempt, matching production.
  // Each iteration is its OWN preclaimed ensure failure: started fails to
  // persist, the store "recovers" by the time that SAME attempt's terminal
  // write runs (persistCalls counts every call, not just started), and the
  // whole non-durable lifecycle must retire — never an orphan terminal, and
  // never a lingering tracker entry that could suppress a later,
  // independent attempt for the same surface. Three such lifecycles in a
  // row, each resolved before the next begins, stress-test that retirement
  // is tied to the receipt's own resolution (not merely to a later
  // rotation happening to reuse its id, which a single-iteration test
  // cannot distinguish from a correctly bounded policy).
  const ledger = createBrowserSurfaceReplacementLedger();
  const persistedPhases: string[] = [];
  const nonDurableLifecycles = { remaining: 3 };
  const before: BrowserSurface = { ...surface, allocator_metadata: { ensure_disposition: "replace" } };
  const realError = new Error("real allocator ensureSurface failure");

  // Same allocator instance (same in-memory ledger, same durableFailures
  // tracker) for all 3 non-durable lifecycles AND the final fully-durable
  // one — reusing a fresh instance for the final check would trivially
  // have an empty tracker and prove nothing about accumulation.
  const observed = createReplacementObservingAllocator(
    {
      ensureSurface: () => Promise.reject(realError),
      getSurfaceStatus: async () => before,
      listSurfaces: async () => [before],
      stopSurface: async () => null,
    },
    {
      ledger,
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      persist: async (receipt) => {
        // The first `remaining` non-durable lifecycles each fail exactly
        // their OWN started write, then "recover" for their own terminal
        // write moments later (mirrors the single-lifecycle test above,
        // repeated) — the shape that could accumulate stale tracker
        // entries without an explicit per-lifecycle retirement policy.
        if (receipt.phase === "started" && nonDurableLifecycles.remaining > 0) {
          nonDurableLifecycles.remaining -= 1;
          throw new Error("simulated store outage on this lifecycle's started write");
        }
        persistedPhases.push(receipt.phase);
        return receipt;
      },
    }
  );

  for (let i = 0; i < 3; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential, resolved-before-the-next lifecycles are the point of this test.
    await assert.rejects(
      observed.ensureSurface({
        connectorId: surface.connector_id,
        profileKey: surface.profile_key,
        surfaceId: surface.surface_id,
      }),
      (error: unknown) => error === realError,
      `lifecycle ${i} must still reject with the real allocator error`
    );
  }

  assert.deepEqual(
    persistedPhases,
    [],
    "none of the three lifecycles may durably persist a terminal without its started predecessor"
  );

  // A final lifecycle on the SAME instance — persist now succeeds for both
  // of its calls (nonDurableLifecycles.remaining is exhausted) — must
  // still durably persist started before terminal, in order, proving none
  // of the three prior non-durable lifecycles left any lingering
  // suppression behind on this instance's tracker.
  await assert.rejects(
    observed.ensureSurface({
      connectorId: surface.connector_id,
      profileKey: surface.profile_key,
      surfaceId: surface.surface_id,
    }),
    (error: unknown) => error === realError
  );
  assert.deepEqual(
    persistedPhases,
    ["started", "terminal"],
    "a later, fully-durable lifecycle on the SAME instance must persist started before terminal, in order, after 3 prior non-durable ones"
  );
});
