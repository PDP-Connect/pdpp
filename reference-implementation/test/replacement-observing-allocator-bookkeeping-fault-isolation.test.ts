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
      // The store is genuinely down (never received the write at all, not
      // a commit-then-reject), so reconciliation authoritatively confirms
      // absence — rollback is the correct outcome here, unlike the
      // commit-then-reject tests below.
      reconcileStartedAdmission: () => Promise.resolve(null),
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
  // on the SAME allocator instance (same in-memory ledger) — the rejected
  // rotation-1 receipt was rolled back out of the ledger entirely, so it
  // must not suppress rotation 2's own receipt via the pending lookup.
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

// 2026-08-01 third gate revision, P1: the second revision's `durableFailures`
// side-tracker required EVERY resolution path to remember to delete its
// entry — but the successful-replacement and successful-stop paths never
// call `recordTerminal` at all (a successful advertised replacement is
// resolved via `recordPreclaimedEnsureResult`'s "abandoned" branch only
// when the container did NOT change; a genuinely successful replacement's
// preclaimed receipt is simply left `started` forever, and a successful
// `stopSurface` never resolves its `started` retirement receipt either).
// A same-instance probe reproduced three leaked successful lifecycles: the
// tracker entries for their non-durable `started` writes were never
// retired. These tests prove the replacement design — transactional
// admission via `ledger.discardUnresolvedStart` — has no such leak: a
// `started` receipt whose persist fails is rolled back out of the ledger
// entirely (via `record` returning `null`), so there is no side-tracker
// state to ever leak on ANY path, successful or not.

test("a failed start is rolled back so a genuinely successful advertised replacement leaves nothing to leak", async () => {
  // Single allocator instance: matches production (one
  // createReplacementObservingAllocator per BrowserSurfaceManager, reused
  // for its lifetime). This is exactly the leak the third gate found: a
  // successful advertised replacement (container DID change) never calls
  // recordTerminal for its preclaimed receipt at all.
  const ledger = createBrowserSurfaceReplacementLedger();
  const persistedPhases: string[] = [];
  const storeState = { down: true };
  const before: BrowserSurface = {
    ...surface,
    allocator_metadata: { ensure_disposition: "replace" },
    container_id: "container-before",
  };
  const after: BrowserSurface = { ...surface, container_id: "container-after" };

  const observed = createReplacementObservingAllocator(
    {
      ensureSurface: async () => after,
      getSurfaceStatus: async () => before,
      listSurfaces: async () => [after],
      stopSurface: async () => null,
    },
    {
      ledger,
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      persist: async (receipt) => {
        // biome-ignore lint/suspicious/noUnnecessaryConditions: storeState.down is mutated later via a shared object reference, which biome's narrowing cannot see across the closure.
        if (storeState.down) {
          throw new Error("simulated store outage on the preclaimed started write");
        }
        persistedPhases.push(receipt.phase);
        return receipt;
      },
      // The store is genuinely down (rejected before ever writing, not a
      // commit-then-reject) — reconciliation authoritatively confirms
      // absence, so rollback is the correct outcome.
      reconcileStartedAdmission: () => Promise.resolve(null),
    }
  );

  // The store is down: the advertised replacement's `started` write fails,
  // is rolled back (never admitted to the ledger), and the real
  // ensureSurface call still succeeds with a genuinely new container.
  // recordPreclaimedEnsureResult's "abandoned" branch is never reached
  // (the container DID change) — under the old tracker design, this exact
  // path left its entry forever, since nothing else ever resolved it.
  const result = await observed.ensureSurface({
    connectorId: surface.connector_id,
    profileKey: surface.profile_key,
    surfaceId: surface.surface_id,
  });
  assert.deepEqual(result, after, "the real allocator's successful replacement must still resolve");
  assert.equal(persistedPhases.length, 0, "nothing durable yet — the store was down for the preclaimed start");
  assert.deepEqual(
    ledger.list(),
    [],
    "the rolled-back started receipt must leave nothing in the ledger's own observable state"
  );

  // Store recovers. A LATER, independent replacement for the SAME surface
  // must still durably persist its own started receipt — proving the
  // rolled-back receipt above left no suppression behind.
  storeState.down = false;
  const laterBefore: BrowserSurface = {
    ...after,
    allocator_metadata: { ensure_disposition: "replace" },
  };
  const laterAfter: BrowserSurface = { ...surface, container_id: "container-later" };
  const laterObserved = createReplacementObservingAllocator(
    {
      ensureSurface: async () => laterAfter,
      getSurfaceStatus: async () => laterBefore,
      listSurfaces: async () => [laterAfter],
      stopSurface: async () => null,
    },
    {
      ledger,
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      persist: async (receipt) => {
        persistedPhases.push(receipt.phase);
        return receipt;
      },
    }
  );
  const laterResult = await laterObserved.ensureSurface({
    connectorId: surface.connector_id,
    profileKey: surface.profile_key,
    surfaceId: surface.surface_id,
  });
  assert.deepEqual(laterResult, laterAfter);
  assert.deepEqual(persistedPhases, ["started"], "a later replacement's own started receipt must reach the store");
});

test("a failed stop's started receipt is rolled back so a genuinely successful stop leaves nothing to leak", async () => {
  // The third gate's other leaked path: a successful stopSurface never
  // resolves its started retirement receipt to terminal/completed at all
  // (only a FAILED stopSurface calls recordTerminal, in the catch block).
  const ledger = createBrowserSurfaceReplacementLedger();
  const persistedPhases: string[] = [];
  const storeState = { down: true };

  const observed = createReplacementObservingAllocator(
    baseAllocator({
      getSurfaceStatus: async () => surface,
      stopSurface: async () => null,
    }),
    {
      ledger,
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      persist: async (receipt) => {
        // biome-ignore lint/suspicious/noUnnecessaryConditions: storeState.down is mutated later via a shared object reference, which biome's narrowing cannot see across the closure.
        if (storeState.down) {
          throw new Error("simulated store outage on the stop-retirement started write");
        }
        persistedPhases.push(receipt.phase);
        return receipt;
      },
      // The store is genuinely down (rejected before ever writing) —
      // reconciliation authoritatively confirms absence.
      reconcileStartedAdmission: () => Promise.resolve(null),
    }
  );

  const result = await observed.stopSurface({ reason: "capacity_pressure", surfaceId: surface.surface_id });
  assert.equal(result, null, "the real allocator's successful stop must still resolve");
  assert.equal(persistedPhases.length, 0, "nothing durable yet — the store was down for the retirement start");
  assert.deepEqual(
    ledger.list(),
    [],
    "the rolled-back started receipt must leave nothing in the ledger's own observable state"
  );

  // Store recovers. A LATER, independent stop for the SAME surface must
  // still durably persist its own started receipt.
  storeState.down = false;
  const laterResult = await observed.stopSurface({ reason: "capacity_pressure", surfaceId: surface.surface_id });
  assert.equal(laterResult, null);
  assert.deepEqual(persistedPhases, ["started"], "a later stop's own started receipt must reach the store");
});

test("repeated failed-then-successful lifecycles (ensure and stop) leave nothing retained across many iterations", async () => {
  // Stress-test on a SINGLE allocator instance: many rolled-back started
  // receipts in a row, interleaving ensure and stop, followed by a final
  // fully-durable lifecycle of each kind — proving there is no accumulating
  // state of any kind (not bounded by luck, bounded by construction: a
  // rolled-back receipt is removed from the ledger, not merely marked).
  const ledger = createBrowserSurfaceReplacementLedger();
  const persistedPhases: string[] = [];
  const storeState = { down: true };
  const before: BrowserSurface = {
    ...surface,
    allocator_metadata: { ensure_disposition: "replace" },
    container_id: "container-before",
  };

  const observed = createReplacementObservingAllocator(
    {
      ensureSurface: async () => ({ ...surface, container_id: "container-after" }),
      getSurfaceStatus: async () => before,
      listSurfaces: async () => [before],
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
        persistedPhases.push(receipt.phase);
        return receipt;
      },
      // The store is genuinely down (rejected before ever writing) —
      // reconciliation authoritatively confirms absence.
      reconcileStartedAdmission: () => Promise.resolve(null),
    }
  );

  for (let i = 0; i < 3; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential, resolved-before-the-next lifecycles are the point of this test.
    await observed.ensureSurface({
      connectorId: surface.connector_id,
      profileKey: surface.profile_key,
      surfaceId: surface.surface_id,
    });
    await observed.stopSurface({ reason: "capacity_pressure", surfaceId: surface.surface_id });
  }

  assert.equal(persistedPhases.length, 0, "nothing durable across 3 interleaved failed ensure+stop lifecycles");
  assert.deepEqual(
    ledger.list(),
    [],
    "no rolled-back receipt from any of the 3 interleaved lifecycles may remain in the ledger"
  );

  // Store recovers. Both a final ensure and a final stop must still
  // durably persist their own started receipts.
  storeState.down = false;
  await observed.ensureSurface({
    connectorId: surface.connector_id,
    profileKey: surface.profile_key,
    surfaceId: surface.surface_id,
  });
  await observed.stopSurface({ reason: "capacity_pressure", surfaceId: surface.surface_id });

  assert.deepEqual(
    persistedPhases,
    ["started", "started"],
    "the final ensure and stop must each durably persist their own started receipt, after 3 prior rolled-back lifecycles"
  );
});

// 2026-08-01 fourth gate revision, P1: `append` in BOTH supported stores can
// commit its INSERT and then throw during post-insert processing — SQLite's
// post-insert re-read (browser-surface-replacement-ledger-store.ts's
// `dbRow` call right after the INSERT) and Postgres's post-insert
// RETURNING-result handling can both fail after the row already exists
// durably. Blindly discarding the in-memory admission on ANY rejection (the
// third-round fix) can therefore strand a durable `started` row with
// nothing left in memory to ever resolve it — an orphan pending row that
// also permanently suppresses later observations, since nothing ever
// proves whether it needs reconciling. These tests simulate that exact
// commit-then-reject window for both stores and prove: (a) the real
// allocator result/error always survives untouched; (b) the durable
// admission is ADOPTED, not discarded, once reconciliation confirms it
// committed; (c) no orphan resolution is ever produced; (d) repeated
// commit-then-reject lifecycles on one instance still resolve correctly and
// do not accumulate unbounded state.

/**
 * A minimal fake durable store that mimics the SQLite/Postgres
 * commit-then-reject shape: `append` writes the row into `rows` (the
 * durable commit) and THEN throws (the post-insert processing failure),
 * exactly like SQLite's post-insert `dbRow` re-read or Postgres's
 * post-insert RETURNING-result handling failing after the INSERT already
 * committed. `findByReplacementId` reads directly from `rows`, exactly
 * like the real stores' reconciliation query would.
 */
function commitThenRejectStore(): {
  readonly rows: ReplacementReceipt[];
  readonly persist: (receipt: ReplacementReceipt) => Promise<ReplacementReceipt>;
  readonly reconcileStartedAdmission: (replacementId: string) => Promise<ReplacementReceipt | null>;
} {
  const rows: ReplacementReceipt[] = [];
  return {
    // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
    persist: async (receipt) => {
      rows.push(receipt); // the durable commit — happens BEFORE the throw.
      throw new Error("simulated post-insert processing failure (commit-then-reject)");
    },
    reconcileStartedAdmission: (replacementId) =>
      Promise.resolve(rows.find((row) => row.replacement_id === replacementId) ?? null),
    rows,
  };
}

test("SQLite-equivalent commit-then-reject: a real stopSurface failure survives, and the durable started row is adopted (not orphaned)", async () => {
  const ledger = createBrowserSurfaceReplacementLedger();
  const store = commitThenRejectStore();
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
      persist: store.persist,
      reconcileStartedAdmission: store.reconcileStartedAdmission,
    }
  );

  await assert.rejects(
    observed.stopSurface({ reason: "capacity_pressure", surfaceId: surface.surface_id }),
    (error: unknown) => error === realError,
    "the real allocator stopSurface error must survive a commit-then-reject started write untouched"
  );
  assert.ok(persistenceErrors.length >= 1, "the commit-then-reject fault must still be reported");
  // Both the started write AND its subsequent terminal resolution (the
  // stop-failure path's recordTerminal call, since the receipt WAS adopted
  // as durably admitted, not rolled back) hit the commit-then-reject fake
  // and each durably commit before their own post-write throw — matching
  // the real stores' actual behavior for a resolution write, not just a
  // started write.
  assert.deepEqual(
    store.rows.map((row) => row.phase),
    ["started", "terminal"],
    "both the adopted started row and its terminal resolution must durably commit, in order"
  );
  assert.deepEqual(
    ledger.list().map((receipt) => receipt.phase),
    ["started", "terminal"],
    "the in-memory ledger must reflect the same adopted, resolved receipt — not rolled back, not duplicated"
  );
});

test("Postgres-equivalent commit-then-reject: a real ensureSurface success survives, and the durable started row is adopted (not orphaned)", async () => {
  const ledger = createBrowserSurfaceReplacementLedger();
  const store = commitThenRejectStore();
  const before: BrowserSurface = { ...surface, allocator_metadata: { ensure_disposition: "replace" } };
  const after: BrowserSurface = { ...surface, container_id: "container-committed" };
  let ensureCalls = 0;

  const observed = createReplacementObservingAllocator(
    {
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      ensureSurface: async () => {
        ensureCalls += 1;
        return after;
      },
      getSurfaceStatus: async () => before,
      listSurfaces: async () => [after],
      stopSurface: async () => null,
    },
    {
      ledger,
      persist: store.persist,
      reconcileStartedAdmission: store.reconcileStartedAdmission,
    }
  );

  const result = await observed.ensureSurface({
    connectorId: surface.connector_id,
    profileKey: surface.profile_key,
    surfaceId: surface.surface_id,
  });

  assert.deepEqual(
    result,
    after,
    "the real allocator success must survive a commit-then-reject started write untouched"
  );
  assert.equal(ensureCalls, 1);
  assert.equal(
    store.rows.length,
    1,
    "the durable started row committed and must remain — this is the adopted admission"
  );
  assert.deepEqual(
    ledger.list().map((receipt) => receipt.phase),
    ["started"],
    "the in-memory ledger must still hold exactly the admitted started receipt — not rolled back, not duplicated"
  );
});

test("reconciliation failing (cannot determine commit-then-reject vs. genuine absence) does not roll back and does not mask the real result", async () => {
  const ledger = createBrowserSurfaceReplacementLedger();
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
      persist: () => Promise.reject(new Error("simulated persist rejection")),
      reconcileStartedAdmission: () => Promise.reject(new Error("simulated reconciliation-read failure")),
    }
  );

  await assert.rejects(
    observed.stopSurface({ reason: "capacity_pressure", surfaceId: surface.surface_id }),
    (error: unknown) => error === realError,
    "the real allocator error must survive even when reconciliation itself cannot resolve the uncertainty"
  );
  assert.ok(persistenceErrors.length >= 2, "both the persist fault and the reconciliation fault must be reported");
  // The started admission is NOT rolled back (the point of this test), so
  // the stop-failure path's recordTerminal still runs against it and
  // resolves it in-memory — that in-memory resolution always succeeds
  // (ledger.terminate is pure, synchronous state), independent of whether
  // ITS OWN durable persist attempt also fails.
  assert.deepEqual(
    ledger.list().map((receipt) => receipt.phase),
    ["started", "terminal"],
    "an unresolvable started outcome must NOT roll back — it remains admitted and its resolution proceeds normally"
  );
});

test("omitting reconcileStartedAdmission entirely fails safe: no rollback on a rejected start, no masking of the real result", async () => {
  const ledger = createBrowserSurfaceReplacementLedger();
  const before: BrowserSurface = { ...surface, allocator_metadata: { ensure_disposition: "replace" } };
  const after: BrowserSurface = { ...surface, container_id: "container-no-reconciliation" };

  const observed = createReplacementObservingAllocator(
    {
      ensureSurface: async () => after,
      getSurfaceStatus: async () => before,
      listSurfaces: async () => [after],
      stopSurface: async () => null,
    },
    {
      ledger,
      // No `reconcileStartedAdmission` provided at all.
      persist: () => Promise.reject(new Error("simulated persist rejection")),
    }
  );

  const result = await observed.ensureSurface({
    connectorId: surface.connector_id,
    profileKey: surface.profile_key,
    surfaceId: surface.surface_id,
  });

  assert.deepEqual(result, after, "the real allocator success must survive when reconciliation is unavailable");
  assert.deepEqual(
    ledger.list().map((receipt) => receipt.phase),
    ["started"],
    "without reconciliation, the safe default must be to NOT roll back an uncertain rejection"
  );
});

test("repeated commit-then-reject lifecycles on one instance each adopt their own durable admission with no orphan resolution and no unbounded state", async () => {
  // Single allocator instance across all 3 lifecycles, matching production.
  // Each lifecycle is its own preclaimed-replacement failure: the started
  // write commits durably and then throws (commit-then-reject), the real
  // ensureSurface call fails, and the failure path attempts to terminalize
  // the preclaimed receipt. The durable started row must be adopted (not
  // orphaned by a wrongful rollback), and its terminal resolution — since
  // the receipt IS durably admitted — must reach the store too, in order.
  const ledger = createBrowserSurfaceReplacementLedger();
  const store = commitThenRejectStore();
  let terminalShouldFail = false;
  const persist = (receipt: ReplacementReceipt): Promise<ReplacementReceipt> => {
    if (receipt.phase !== "started" || !terminalShouldFail) {
      store.rows.push(receipt);
      return Promise.resolve(receipt);
    }
    return store.persist(receipt);
  };
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
      persist,
      reconcileStartedAdmission: store.reconcileStartedAdmission,
    }
  );

  for (let i = 0; i < 3; i += 1) {
    terminalShouldFail = true;
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

  // Every one of the 3 lifecycles' started rows committed durably (via the
  // commit-then-reject window) and must have been ADOPTED — never
  // orphaned, never duplicated by a spurious retry.
  const startedRows = store.rows.filter((row) => row.phase === "started");
  assert.equal(startedRows.length, 3, "all 3 commit-then-reject started rows must be adopted, not orphaned");
  assert.deepEqual(
    new Set(startedRows.map((row) => row.replacement_id)).size,
    3,
    "each lifecycle's started row must be distinct — no duplicate admissions"
  );

  // No unbounded state: the in-memory ledger holds exactly one
  // started+terminal pair per lifecycle (6 total for 3 lifecycles) — state
  // strictly proportional to the receipts actually admitted, not a
  // separate growing side-tracker independent of the receipts themselves.
  assert.equal(
    ledger.list().length,
    startedRows.length * 2,
    "in-memory ledger state is bounded by the receipts admitted (started+terminal per lifecycle), not by a separate growing tracker"
  );
  assert.deepEqual(
    ledger.list().map((receipt) => receipt.phase),
    ["started", "terminal", "started", "terminal", "started", "terminal"],
    "each lifecycle's admitted receipt is fully resolved, in order, with no lingering unresolved state"
  );
});
