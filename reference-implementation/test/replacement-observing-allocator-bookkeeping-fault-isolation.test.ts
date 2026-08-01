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
import { deriveOpaqueGenerationHash } from "../runtime/browser-surface/replacement-receipt-ledger-state.ts";
import { closeDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage } from "../server/postgres-storage.ts";
import {
  createPostgresBrowserSurfaceReplacementReceiptStore,
  createSqliteBrowserSurfaceReplacementReceiptStore,
} from "../server/stores/browser-surface-replacement-ledger-store.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

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

// 2026-08-01 fifth gate revision: `options.findPending` is a broader,
// pre-existing durable "any pending receipt for this surface" fallback
// (production-wired to `findPendingForSurface`, unchanged since before
// this revision) consulted only when nothing matches in memory — e.g.
// after a process restart, when the in-memory ledger is empty but a
// durable started receipt for a prior, still-unresolved transition
// exists. It must still dedup against a durable match for the EXACT same
// transition, but must NOT treat a durable match for a DIFFERENT
// transition as blocking — same exact-transition scoping the in-memory
// path enforces.
test("findPending's durable fallback dedups an exact-transition match but ignores a durable receipt for a different transition", async () => {
  const container1Id = "container-restart-1";
  const container2Id = "container-restart-2";
  const container3Id = "container-restart-3";
  const container1: BrowserSurface = { ...surface, container_id: container1Id };
  const container2: BrowserSurface = { ...surface, container_id: container2Id };
  const container3: BrowserSurface = { ...surface, container_id: container3Id };
  let ensureCalls = 0;

  // Simulates a fresh in-memory ledger (as after a process restart) with a
  // durable receipt already on record for the container1->container2
  // transition, discovered only via `findPending` since nothing is in memory.
  const previousHash = deriveOpaqueGenerationHash(container1Id);
  const nextHash = `:${deriveOpaqueGenerationHash(container2Id)}`;
  const durableReceiptForFirstTransition: ReplacementReceipt = {
    cause: "allocator_internal_ensure_surface",
    connection_id: "restart-connection",
    event_seq: 1,
    idempotency_key: `ensure:${surface.surface_id}:${previousHash}${nextHash}:some-prior-attempt`,
    observed_at: "2026-08-01T00:00:00.000Z",
    phase: "started",
    profile_key: surface.profile_key,
    replacement_id: "replacement_prior-restart-receipt",
    scope: JSON.stringify(["restart-connection"]),
    surface_id: surface.surface_id,
  };

  const persistedForSameTransition: ReplacementReceipt[] = [];
  const observedSameTransition = createReplacementObservingAllocator(
    {
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      ensureSurface: async () => {
        ensureCalls += 1;
        return container2;
      },
      getSurfaceStatus: async () => container1,
      listSurfaces: async () => [container2],
      stopSurface: async () => null,
    },
    {
      findPending: () => Promise.resolve(durableReceiptForFirstTransition),
      ledger: createBrowserSurfaceReplacementLedger(),
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      persist: async (receipt) => {
        persistedForSameTransition.push(receipt);
        return receipt;
      },
    }
  );

  await observedSameTransition.ensureSurface({
    connectorId: surface.connector_id,
    profileKey: surface.profile_key,
    surfaceId: surface.surface_id,
  });

  assert.equal(
    ensureCalls,
    1,
    "sanity: the real allocator is still called regardless of dedup — dedup only affects receipt bookkeeping"
  );
  assert.equal(
    persistedForSameTransition.length,
    0,
    "a durable fallback match for the EXACT SAME transition must dedup — no new receipt is persisted"
  );

  // A DIFFERENT transition (container2 -> container3): the durable fallback
  // still returns the SAME stale receipt (as if `findPendingForSurface`'s
  // "any pending for this surface" query surfaced it again), but it must
  // NOT block recording this genuinely new transition's own receipt.
  const persistedForDifferentTransition: ReplacementReceipt[] = [];
  const observedDifferentTransition = createReplacementObservingAllocator(
    {
      ensureSurface: async () => container3,
      getSurfaceStatus: async () => container2,
      listSurfaces: async () => [container3],
      stopSurface: async () => null,
    },
    {
      findPending: () => Promise.resolve(durableReceiptForFirstTransition),
      ledger: createBrowserSurfaceReplacementLedger(),
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      persist: async (receipt) => {
        persistedForDifferentTransition.push(receipt);
        return receipt;
      },
    }
  );

  await observedDifferentTransition.ensureSurface({
    connectorId: surface.connector_id,
    profileKey: surface.profile_key,
    surfaceId: surface.surface_id,
  });

  assert.equal(
    persistedForDifferentTransition.length,
    1,
    "a durable fallback match for a DIFFERENT transition must not suppress this new transition's own receipt"
  );
  assert.equal(persistedForDifferentTransition[0]?.phase, "started");
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

test("real SQLite commit-then-reject: a post-append failure is reconciled and adopted", async () => {
  initDb();
  try {
    const ledger = createBrowserSurfaceReplacementLedger();
    const realStore = createSqliteBrowserSurfaceReplacementReceiptStore();
    const before: BrowserSurface = { ...surface, allocator_metadata: { ensure_disposition: "replace" } };
    const after: BrowserSurface = { ...surface, container_id: "container-sqlite-real-committed" };
    const observed = createReplacementObservingAllocator(
      baseAllocator({ ensureSurface: async () => after, getSurfaceStatus: async () => before }),
      {
        ledger,
        persist: async (receipt) => {
          await realStore.append(receipt);
          throw new Error("simulated post-append failure against real SQLite");
        },
        reconcileStartedAdmission: (replacementId) => realStore.findByReplacementId(replacementId),
      }
    );

    assert.deepEqual(
      await observed.ensureSurface({
        connectorId: surface.connector_id,
        profileKey: surface.profile_key,
        surfaceId: surface.surface_id,
      }),
      after,
      "the real allocator success must survive a post-commit SQLite failure"
    );
    const [admitted] = ledger.list();
    assert.ok(admitted);
    assert.equal(ledger.isAdmissionUnknown(admitted.replacement_id), false);
    assert.equal((await realStore.findByReplacementId(admitted.replacement_id))?.phase, "started");
  } finally {
    closeDb();
  }
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
  // 2026-08-01 fifth gate revision: the started admission is NOT rolled
  // back (never proven absent), but it is also NOT resolved — a receipt
  // marked ledger-owned UNKNOWN admission state must not be terminated
  // until a later bounded reconciliation adopts or discards it (the
  // stop-failure path's recordTerminal call is attempted, but the ledger
  // itself refuses to resolve an unknown receipt and that refusal is
  // caught and reported by recordStopFailureObserved, not left to mask
  // the real allocator error asserted above).
  assert.deepEqual(
    ledger.list().map((receipt) => receipt.phase),
    ["started"],
    "an unresolvable started outcome must NOT roll back AND must NOT be resolved until reconciled"
  );
  assert.equal(
    ledger.isAdmissionUnknown(surfaceStartedReplacementId(ledger)),
    true,
    "the receipt must remain marked as unknown admission, not silently indistinguishable from durable pending state"
  );
});

function surfaceStartedReplacementId(ledger: BrowserSurfaceReplacementLedger): string {
  const [started] = ledger.list();
  assert.ok(started, "expected exactly one started receipt in the ledger");
  return started.replacement_id;
}

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

test("real Postgres commit-then-reject: a genuine post-INSERT-commit driver failure is reconciled and adopted, not orphaned", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  assert.ok(POSTGRES_URL, "Postgres URL is configured when this test runs");
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  try {
    const ledger = createBrowserSurfaceReplacementLedger();
    const realStore = createPostgresBrowserSurfaceReplacementReceiptStore();
    const before: BrowserSurface = { ...surface, allocator_metadata: { ensure_disposition: "replace" } };
    const after: BrowserSurface = { ...surface, container_id: "container-pg-real-committed" };
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
        // Wraps the REAL Postgres driver call: the real INSERT commits
        // against the dedicated container, then this throws afterward —
        // reproducing the actual post-`RETURNING`-result failure window
        // (`PostgresBrowserSurfaceReplacementReceiptStore`'s own
        // post-insert handling), not a simulated fake.
        persist: async (receipt) => {
          await realStore.append(receipt);
          throw new Error("simulated post-INSERT-commit driver failure against real Postgres");
        },
        reconcileStartedAdmission: (replacementId) => realStore.findByReplacementId(replacementId),
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
      "the real allocator success must survive a genuine post-commit driver failure against real Postgres"
    );
    assert.equal(ensureCalls, 1);
    assert.deepEqual(
      ledger.list().map((receipt) => receipt.phase),
      ["started"],
      "the in-memory ledger must hold exactly the adopted admitted receipt — not rolled back, not duplicated"
    );
    const [admitted] = ledger.list();
    assert.ok(admitted);
    assert.equal(ledger.isAdmissionUnknown(admitted.replacement_id), false, "reconciliation adopted the durable row");
    const durableRow = await realStore.findByReplacementId(admitted.replacement_id);
    assert.equal(durableRow?.phase, "started", "the row genuinely committed against real Postgres and must survive");
  } finally {
    await closePostgresStorage();
  }
});

// 2026-08-01 fifth (final) gate revision, P1: the fourth revision's
// `reconcileAfterUncertainPersistRejection` returned the volatile
// in-memory receipt UNCHANGED whenever reconciliation was unavailable or
// itself failed — indistinguishable, to an ordinary pending lookup, from a
// genuinely durable pending claim.
// The gate's own probe: a rejected first started persist PLUS a transient
// reconciliation-read failure left exactly this ambiguous state, and
// three SUBSEQUENT real, successful container rotations for the same
// surface then produced only ONE persist attempt total — the second and
// third rotations' audit receipts were silently dropped because the pending
// lookup still saw rotation 1's stuck receipt as authoritative and never
// even tried admitting a new one.
//
// The fix makes "unknown admission" ledger-owned state
// (`markStartedAdmissionUnknown`/`isAdmissionUnknown`) that the preparation
// boundary excludes from ordinary pending and reconciles once before every
// later same-scope observation.
test("reject-before-commit plus a transient reconciliation-read failure does not suppress three later successful rotations' audit receipts", async () => {
  // Single allocator instance across all 4 rotations, matching production.
  const ledger = createBrowserSurfaceReplacementLedger();
  const persistedPhases: string[] = [];
  const allocatorResults: string[] = [];
  let persistCalls = 0;
  let reconcileCalls = 0;
  let liveSurface: BrowserSurface = { ...surface, container_id: "container-0" };
  let nextContainerId = "container-1";

  const observed = createReplacementObservingAllocator(
    {
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      ensureSurface: async () => {
        liveSurface = { ...liveSurface, container_id: nextContainerId };
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
        persistCalls += 1;
        if (persistCalls === 1) {
          // Rotation 1's started write is rejected before it ever commits
          // (genuine absence, not commit-then-reject) — the gate's exact
          // scenario combines this with a reconciliation READ that also
          // fails transiently, below.
          throw new Error("simulated reject-before-commit on rotation 1's started write");
        }
        persistedPhases.push(receipt.phase);
        return receipt;
      },
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      reconcileStartedAdmission: async () => {
        reconcileCalls += 1;
        // Transient: the reconciliation READ ITSELF fails (distinct from
        // "reconciliation confirms absence") — this is the exact
        // combination the gate's probe used to leave rotation 1's receipt
        // stuck as unresolved.
        throw new Error("simulated transient reconciliation-read failure");
      },
    }
  );

  // Rotation 1: fails to persist, and its one reconciliation attempt (made
  // eagerly inside `record`) is itself transient-unresolvable — the
  // receipt is marked unknown admission, not rolled back, not resolved.
  const first = await observed.ensureSurface({
    connectorId: surface.connector_id,
    profileKey: surface.profile_key,
    surfaceId: surface.surface_id,
  });
  allocatorResults.push(first.container_id ?? "");

  // Three LATER, real, successful rotations for the SAME surface. Each
  // must still get its own persist attempt — none may be silently
  // suppressed by rotation 1's stuck, unresolved receipt.
  for (const containerId of ["container-2", "container-3", "container-4"]) {
    nextContainerId = containerId;
    // biome-ignore lint/performance/noAwaitInLoops: sequential, resolved-before-the-next rotations are the point of this test.
    const result = await observed.ensureSurface({
      connectorId: surface.connector_id,
      profileKey: surface.profile_key,
      surfaceId: surface.surface_id,
    });
    allocatorResults.push(result.container_id ?? "");
  }

  assert.deepEqual(
    allocatorResults,
    ["container-1", "container-2", "container-3", "container-4"],
    "every rotation's real allocator result must survive regardless of the bookkeeping fault"
  );
  // The exact defect: persistCalls stuck at 1 (only rotation 1 ever
  // attempted, its own rejected write) meant rotations 2-4 never even
  // tried to persist their own receipts.
  assert.equal(
    persistCalls,
    4,
    "each of the 4 rotations must attempt its own persist — none may be silently skipped because an earlier receipt is stuck unresolved"
  );
  assert.deepEqual(
    persistedPhases,
    ["started", "started", "started"],
    "rotations 2, 3, and 4 must each durably persist their own started receipt"
  );
  assert.equal(
    ledger.list().filter((receipt) => ledger.isAdmissionUnknown(receipt.replacement_id)).length,
    1,
    "repeated reconciliation reads retain only the original unknown admission, not a per-read tracker entry"
  );
  assert.equal(
    reconcileCalls,
    4,
    "each observation makes one bounded reconciliation read for the stuck admission; repeated read faults cannot create an unbounded retry loop"
  );
});

test("a later observation for the same scope reconciles an unknown admission even when its surface ID changed", async () => {
  const ledger = createBrowserSurfaceReplacementLedger();
  const durableRows: ReplacementReceipt[] = [];
  const originalBefore: BrowserSurface = { ...surface, container_id: "scope-container-0" };
  const originalAfter: BrowserSurface = { ...originalBefore, container_id: "scope-container-1" };
  const successorBefore: BrowserSurface = {
    ...originalAfter,
    container_id: "scope-container-2",
    surface_id: "bs_test_successor",
  };
  const successorAfter: BrowserSurface = { ...successorBefore, container_id: "scope-container-3" };
  let currentBefore = originalBefore;
  let currentAfter = originalAfter;
  let persistCalls = 0;
  let reconciliationCalls = 0;
  let scopeLookupSawUnknown = false;

  const observed = createReplacementObservingAllocator(
    {
      ensureSurface: async () => currentAfter,
      getSurfaceStatus: async () => currentBefore,
      listSurfaces: async () => [currentAfter],
      stopSurface: async () => null,
    },
    {
      findPendingForScope: () => {
        scopeLookupSawUnknown = ledger.list().some((receipt) => ledger.isAdmissionUnknown(receipt.replacement_id));
        return Promise.resolve(null);
      },
      ledger,
      persist: (receipt) => {
        persistCalls += 1;
        durableRows.push(receipt);
        if (persistCalls === 1) {
          return Promise.reject(
            new Error("simulated post-commit write rejection before a transient reconciliation read")
          );
        }
        return Promise.resolve(receipt);
      },
      reconcileStartedAdmission: (replacementId) => {
        reconciliationCalls += 1;
        if (reconciliationCalls === 1) {
          return Promise.reject(new Error("simulated transient reconciliation-read failure"));
        }
        return Promise.resolve(durableRows.find((receipt) => receipt.replacement_id === replacementId) ?? null);
      },
    }
  );

  await observed.ensureSurface({
    connectorId: originalBefore.connector_id,
    profileKey: originalBefore.profile_key,
    surfaceId: originalBefore.surface_id,
    ...(originalBefore.surface_subject_id ? { surfaceSubjectId: originalBefore.surface_subject_id } : {}),
  });
  currentBefore = successorBefore;
  currentAfter = successorAfter;
  const result = await observed.ensureSurface({
    connectorId: successorBefore.connector_id,
    profileKey: successorBefore.profile_key,
    surfaceId: successorBefore.surface_id,
    ...(successorBefore.surface_subject_id ? { surfaceSubjectId: successorBefore.surface_subject_id } : {}),
  });

  assert.deepEqual(result, successorAfter, "the changed-surface allocator result must still survive bookkeeping");
  assert.equal(scopeLookupSawUnknown, false, "same-scope reconciliation must run before the scope lookup");
  assert.equal(reconciliationCalls, 2, "one eager and one later bounded exact-ID read must reconcile the admission");
  assert.equal(persistCalls, 2, "the successor transition must retain its own valid receipt");
  assert.equal(
    ledger.list().filter((receipt) => ledger.isAdmissionUnknown(receipt.replacement_id)).length,
    0,
    "the exact durable start must be adopted, not retained as unknown"
  );
});
