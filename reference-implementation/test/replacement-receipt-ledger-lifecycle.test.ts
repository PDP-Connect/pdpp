// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

// biome-ignore lint/correctness/noUnresolvedImports: localized test assertion preserves its explicit contract.
import type { BrowserSurface, BrowserSurfaceAllocator, BrowserSurfaceLease } from "@opendatalabs/remote-surface/leases";
import { createReplacementLifecycleHooks } from "../runtime/browser-surface/replacement-lifecycle-hooks.ts";
import type { ReplacementReceipt } from "../runtime/browser-surface/replacement-receipt-ledger.ts";
import {
  createBrowserSurfaceReplacementLedger,
  createReplacementObservingAllocator,
  deriveOpaqueGenerationHash,
  ReplacementReplayConflictError,
} from "../runtime/browser-surface/replacement-receipt-ledger.ts";
import type { BrowserSurfaceReadinessProbeSuccess } from "../runtime/browser-surface-readiness.ts";
import { closeDb, initDb } from "../server/db.ts";
import type {
  BrowserSurfaceLeaseStore,
  BrowserSurfaceWithPersistenceMetadata,
} from "../server/stores/browser-surface-lease-store.ts";
import { createSqliteBrowserSurfaceLeaseStore } from "../server/stores/browser-surface-lease-store.ts";
import type { BrowserSurfaceReplacementReceiptStore } from "../server/stores/browser-surface-replacement-ledger-store.ts";
import { createSqliteBrowserSurfaceReplacementReceiptStore } from "../server/stores/browser-surface-replacement-ledger-store.ts";

const ALLOCATOR_UNAVAILABLE = /allocator unavailable/;

const surface: BrowserSurface = {
  backend: "neko",
  cdp_url: "http://neko:9222",
  connector_id: "chatgpt",
  container_id: "container-1",
  created_at: "2026-07-16T12:00:00.000Z",
  health: "ready",
  last_used_at: "2026-07-16T12:00:00.000Z",
  profile_key: "chatgpt",
  stream_base_url: "http://neko:8080",
  surface_id: "surface-1",
  surface_subject_id: "subject-1",
};

function allocator(stopSurface: BrowserSurfaceAllocator["stopSurface"]): BrowserSurfaceAllocator {
  return {
    ensureSurface: async () => surface,
    getSurfaceStatus: async () => surface,
    listSurfaces: async () => [surface],
    stopSurface,
  };
}

// recordBrowserGeneration only reads lease.lease_id; the remaining fields are
// filled with innocuous placeholders to satisfy BrowserSurfaceLease's shape.
function minimalLease(leaseId: string): BrowserSurfaceLease {
  return {
    connector_id: "chatgpt",
    expires_at: "2026-07-16T13:00:00.000Z",
    fencing_token: 0,
    lease_id: leaseId,
    priority_class: "interactive",
    profile_key: "chatgpt",
    requested_at: "2026-07-16T12:00:00.000Z",
    run_id: "run-1",
    status: "leased",
  };
}

test("container replacement appends started before readiness and does not invent a completion hash", async () => {
  const ledger = createBrowserSurfaceReplacementLedger();
  const persisted: ReplacementReceipt[] = [];
  const oldSurface: BrowserSurface = { ...surface, container_id: "container-old" };
  const newSurface: BrowserSurface = { ...surface, container_id: "container-new" };
  const observed = createReplacementObservingAllocator(
    {
      ensureSurface: async () => newSurface,
      getSurfaceStatus: async () => oldSurface,
      listSurfaces: async () => [newSurface],
      stopSurface: async () => null,
    },
    {
      ledger,
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      persist: async (receipt) => {
        persisted.push(receipt);
        return receipt;
      },
    }
  );

  await observed.ensureSurface({
    connectorId: surface.connector_id,
    profileKey: surface.profile_key,
    surfaceId: surface.surface_id,
  });

  assert.deepEqual(
    persisted.map((receipt) => receipt.phase),
    ["started"]
  );
  const [firstPersisted] = persisted;
  assert.ok(firstPersisted, "expected a persisted receipt");
  assert.equal(firstPersisted.next_generation_hash, undefined);
});

function advertisedReplacementSurface(containerId = "container-1"): BrowserSurface {
  return {
    ...surface,
    allocator_metadata: { ensure_disposition: "replace" },
    container_id: containerId,
  };
}

test("pre-claim ensure persists started before the replacement effect in SQLite", async () => {
  initDb();
  try {
    const receiptStore = createSqliteBrowserSurfaceReplacementReceiptStore();
    const ledger = createBrowserSurfaceReplacementLedger({ now: () => "2026-07-16T12:00:00.000Z" });
    const before: BrowserSurface = { ...advertisedReplacementSurface("container-old"), surface_id: "preclaim-order" };
    const after: BrowserSurface = { ...advertisedReplacementSurface("container-new"), surface_id: "preclaim-order" };
    const order: string[] = [];
    const observed = createReplacementObservingAllocator(
      {
        // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
        ensureSurface: async () => {
          order.push("effect");
          return after;
        },
        getSurfaceStatus: async () => before,
        listSurfaces: async () => [after],
        stopSurface: async () => null,
      },
      {
        createEnsureAttemptId: () => "ensure-attempt-1",
        ledger,
        // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
        persist: async (receipt) => {
          order.push(`persist:${receipt.phase}`);
          return receiptStore.append(receipt);
        },
      }
    );

    await observed.ensureSurface({ connectorId: "chatgpt", profileKey: "chatgpt", surfaceId: "preclaim-order" });
    assert.deepEqual(order, ["persist:started", "effect"]);
    const receipts = (await receiptStore.list()).filter((receipt) => receipt.surface_id === "preclaim-order");
    assert.deepEqual(
      receipts.map((receipt) => receipt.phase),
      ["started"]
    );
    const [firstReceipt] = receipts;
    assert.ok(firstReceipt, "expected a receipt for preclaim-order");
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(firstReceipt.idempotency_key, /ensure-attempt-1$/);
  } finally {
    closeDb();
  }
});

test("pre-claim persistence failure fails closed before the replacement effect", async () => {
  const ledger = createBrowserSurfaceReplacementLedger();
  const before: BrowserSurface = {
    ...advertisedReplacementSurface("container-old"),
    surface_id: "preclaim-persist-failure",
  };
  const persistenceError = new Error("receipt store unavailable");
  let ensureCalls = 0;
  const observed = createReplacementObservingAllocator(
    {
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      ensureSurface: async () => {
        ensureCalls += 1;
        return { ...before, container_id: "container-new" };
      },
      getSurfaceStatus: async () => before,
      listSurfaces: async () => [before],
      stopSurface: async () => null,
    },
    {
      ledger,
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      persist: async () => {
        throw persistenceError;
      },
    }
  );

  await assert.rejects(
    () => observed.ensureSurface({ connectorId: "chatgpt", profileKey: "chatgpt", surfaceId: before.surface_id }),
    persistenceError
  );
  assert.equal(ensureCalls, 0);
});

test("independent pre-claim ensure attempts have distinct receipt identities", async () => {
  initDb();
  try {
    const receiptStore = createSqliteBrowserSurfaceReplacementReceiptStore();
    const ledger = createBrowserSurfaceReplacementLedger();
    const before: BrowserSurface = { ...advertisedReplacementSurface("container-old"), surface_id: "preclaim-retry" };
    const after: BrowserSurface = { ...before, container_id: "container-new" };
    let attempt = 0;
    const observed = createReplacementObservingAllocator(
      {
        ensureSurface: async () => after,
        getSurfaceStatus: async () => before,
        listSurfaces: async () => [after],
        stopSurface: async () => null,
      },
      {
        // biome-ignore lint/style/noIncrementDecrement: localized test assertion preserves its explicit contract.
        createEnsureAttemptId: () => `ensure-attempt-${++attempt}`,
        ledger,
        persist: (receipt) => receiptStore.append(receipt),
      }
    );

    const request = { connectorId: "chatgpt", profileKey: "chatgpt", surfaceId: before.surface_id };
    await observed.ensureSurface(request);
    await observed.ensureSurface(request);
    const receipts = (await receiptStore.list()).filter((receipt) => receipt.surface_id === before.surface_id);
    assert.deepEqual(
      receipts.map((receipt) => receipt.phase),
      ["started", "started"]
    );
    const [firstAttemptReceipt, secondAttemptReceipt] = receipts;
    assert.ok(firstAttemptReceipt, "expected the first attempt receipt");
    assert.ok(secondAttemptReceipt, "expected the second attempt receipt");
    assert.notEqual(firstAttemptReceipt.replacement_id, secondAttemptReceipt.replacement_id);
    assert.notEqual(firstAttemptReceipt.idempotency_key, secondAttemptReceipt.idempotency_key);
  } finally {
    closeDb();
  }
});

test("pre-claim ensure failure terminalizes the durable started receipt", async () => {
  initDb();
  try {
    const receiptStore = createSqliteBrowserSurfaceReplacementReceiptStore();
    const ledger = createBrowserSurfaceReplacementLedger();
    const failure = new Error("ensure failed");
    const before: BrowserSurface = { ...advertisedReplacementSurface("container-old"), surface_id: "preclaim-failure" };
    const observed = createReplacementObservingAllocator(
      {
        // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
        ensureSurface: async () => {
          throw failure;
        },
        getSurfaceStatus: async () => before,
        listSurfaces: async () => [before],
        stopSurface: async () => null,
      },
      { ledger, persist: (receipt) => receiptStore.append(receipt) }
    );

    await assert.rejects(
      () => observed.ensureSurface({ connectorId: "chatgpt", profileKey: "chatgpt", surfaceId: "preclaim-failure" }),
      failure
    );
    const receipts = (await receiptStore.list()).filter((receipt) => receipt.surface_id === "preclaim-failure");
    assert.deepEqual(
      receipts.map((receipt) => [receipt.phase, receipt.terminal_outcome]),
      [
        ["started", undefined],
        ["terminal", "failed"],
      ]
    );
  } finally {
    closeDb();
  }
});

test("pre-claim ensure returning the same generation is terminally abandoned", async () => {
  initDb();
  try {
    const receiptStore = createSqliteBrowserSurfaceReplacementReceiptStore();
    const ledger = createBrowserSurfaceReplacementLedger();
    const before: BrowserSurface = { ...advertisedReplacementSurface("container-same"), surface_id: "preclaim-same" };
    const observed = createReplacementObservingAllocator(
      {
        ensureSurface: async () => before,
        getSurfaceStatus: async () => before,
        listSurfaces: async () => [before],
        stopSurface: async () => null,
      },
      { ledger, persist: (receipt) => receiptStore.append(receipt) }
    );

    await observed.ensureSurface({ connectorId: "chatgpt", profileKey: "chatgpt", surfaceId: "preclaim-same" });
    const receipts = (await receiptStore.list()).filter((receipt) => receipt.surface_id === "preclaim-same");
    assert.deepEqual(
      receipts.map((receipt) => [receipt.phase, receipt.terminal_outcome]),
      [
        ["started", undefined],
        ["terminal", "abandoned"],
      ]
    );
  } finally {
    closeDb();
  }
});

test("successful stop retains the started retirement for later readiness completion", async () => {
  const ledger = createBrowserSurfaceReplacementLedger({ now: () => "2026-07-16T12:00:00.000Z" });
  const persisted: ReplacementReceipt[] = [];
  const observed = createReplacementObservingAllocator(
    allocator(async () => null),
    {
      ledger,
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      persist: async (receipt) => {
        persisted.push(receipt);
        return receipt;
      },
    }
  );

  await observed.stopSurface({ reason: "idle_ttl", surfaceId: surface.surface_id });

  assert.deepEqual(
    persisted.map((receipt) => [receipt.phase, receipt.terminal_outcome]),
    [["started", undefined]]
  );
});

test("failed stop resolves the started retirement terminally and propagates the stop error", async () => {
  const ledger = createBrowserSurfaceReplacementLedger();
  const persisted: ReplacementReceipt[] = [];
  const stopError = new Error("allocator stop failed");
  const observed = createReplacementObservingAllocator(
    // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
    allocator(async () => {
      throw stopError;
    }),
    {
      ledger,
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      persist: async (receipt) => {
        persisted.push(receipt);
        return receipt;
      },
    }
  );

  await assert.rejects(
    () => observed.stopSurface({ reason: "surface_failed", surfaceId: surface.surface_id }),
    stopError
  );
  const lastPersisted = persisted.at(-1);
  assert.ok(lastPersisted, "expected at least one persisted receipt");
  assert.equal(lastPersisted.terminal_outcome, "failed");
  assert.equal(ledger.selectCurrent("subject-1", "subject-1"), null);
});

test("independent stop attempts survive SQLite terminality and exact rotated readiness", async () => {
  initDb();
  try {
    const receiptStore = createSqliteBrowserSurfaceReplacementReceiptStore();
    const leaseStore = createSqliteBrowserSurfaceLeaseStore();
    const firstGeneration = deriveOpaqueGenerationHash("container-1:ready-1");
    const secondGeneration = deriveOpaqueGenerationHash("container-2:ready-2");
    const rotatedSurface: BrowserSurfaceWithPersistenceMetadata = {
      ...surface,
      browser_generation_hash: firstGeneration,
      container_id: "container-2",
      surface_id: "surface-2",
    };
    await leaseStore.upsertSurface(rotatedSurface);

    let stopCalls = 0;
    let attemptCalls = 0;
    const effectOrder: string[] = [];
    const stopError = new Error("capacity stop failed once");
    const ledger = createBrowserSurfaceReplacementLedger({ now: () => "2026-07-16T12:00:00.000Z" });
    const observed = createReplacementObservingAllocator(
      {
        ensureSurface: async () => rotatedSurface,
        getSurfaceStatus: async () => surface,
        listSurfaces: async () => [surface],
        // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
        stopSurface: async () => {
          stopCalls += 1;
          effectOrder.push(`effect:${stopCalls}`);
          if (stopCalls === 1) {
            throw stopError;
          }
          return null;
        },
      },
      {
        // biome-ignore lint/style/noIncrementDecrement: localized test assertion preserves its explicit contract.
        createStopAttemptId: () => `attempt-${++attemptCalls}`,
        ledger,
        // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
        persist: async (receipt) => {
          effectOrder.push(`persist:${receipt.phase}`);
          return receiptStore.append(receipt);
        },
      }
    );

    await assert.rejects(
      () => observed.stopSurface({ reason: "capacity_pressure", surfaceId: surface.surface_id }),
      stopError
    );
    await observed.stopSurface({ reason: "capacity_pressure", surfaceId: surface.surface_id });

    const afterStops = await receiptStore.list();
    assert.deepEqual(
      afterStops.map((receipt) => receipt.phase),
      ["started", "terminal", "started"]
    );
    const [firstStop, secondStop, thirdStop] = afterStops;
    assert.ok(firstStop, "expected the first stop attempt receipt");
    assert.ok(secondStop, "expected the terminal receipt for the failed stop attempt");
    assert.ok(thirdStop, "expected the second stop attempt receipt");
    assert.equal(secondStop.terminal_outcome, "failed");
    assert.notEqual(firstStop.replacement_id, thirdStop.replacement_id);
    assert.notEqual(firstStop.idempotency_key, thirdStop.idempotency_key);
    assert.deepEqual(effectOrder, ["persist:started", "effect:1", "persist:terminal", "persist:started", "effect:2"]);

    const replay = await receiptStore.append(thirdStop);
    assert.equal(replay.event_seq, thirdStop.event_seq, "one formed receipt remains idempotent on replay");

    const hooks = createReplacementLifecycleHooks({
      allocator: null,
      leaseStore,
      log: {},
      receiptStore,
    });
    await hooks.recordBrowserGeneration(minimalLease("lease-2"), rotatedSurface, surface.connector_id, "run-2", {
      browserGenerationHash: secondGeneration,
      ok: true,
      pageTargetCount: 1,
    });

    const afterReadiness = await receiptStore.list();
    assert.deepEqual(
      afterReadiness.map((receipt) => receipt.phase),
      ["started", "terminal", "started", "completed"]
    );
    const [, readinessTerminal, readinessSecondStart, readinessCompleted] = afterReadiness;
    assert.ok(readinessTerminal, "expected the terminal receipt for attempt 1");
    assert.ok(readinessSecondStart, "expected the started receipt for attempt 2");
    assert.ok(readinessCompleted, "expected the completed receipt for attempt 2");
    assert.equal(readinessTerminal.phase, "terminal", "attempt 1 remains terminal");
    assert.equal(readinessTerminal.terminal_outcome, "failed");
    assert.equal(readinessCompleted.replacement_id, readinessSecondStart.replacement_id);
    assert.equal(readinessCompleted.next_generation_hash, secondGeneration);
    assert.ok(surface.surface_subject_id, "fixture surface must carry a surface_subject_id");
    const surfaceSubjectId = surface.surface_subject_id;
    assert.equal(
      (
        await receiptStore.selectCurrent({
          connection_id: surfaceSubjectId,
          current_generation_hash: secondGeneration,
          surface_subject_id: surfaceSubjectId,
        })
      )?.replacement_id,
      readinessSecondStart.replacement_id,
      "only attempt 2 is current after its exact readiness generation"
    );
    assert.equal(
      await receiptStore.selectCurrent({
        connection_id: surfaceSubjectId,
        current_generation_hash: firstGeneration,
        surface_subject_id: surfaceSubjectId,
      }),
      null
    );

    const isolated = ledger.start({
      cause: "capacity_pressure",
      connection_id: "subject-other",
      connector_id: surface.connector_id,
      idempotency_key: "isolated-stop-attempt",
      profile_key: surface.profile_key,
      surface_id: "surface-other",
      surface_subject_id: "subject-other",
    });
    await receiptStore.append(isolated);
    assert.equal(
      (
        await receiptStore.findPendingForScope({
          connection_id: "subject-other",
          profile_key: surface.profile_key,
          surface_subject_id: "subject-other",
        })
      )?.replacement_id,
      isolated.replacement_id
    );
    assert.equal(
      await receiptStore.findPendingForScope({
        connection_id: surfaceSubjectId,
        profile_key: surface.profile_key,
        surface_subject_id: "subject-other",
      }),
      null
    );
    assert.equal(
      await receiptStore.findPendingForScope({
        connection_id: surfaceSubjectId,
        profile_key: "other-profile",
        surface_subject_id: surfaceSubjectId,
      }),
      null
    );
    assert.equal(
      (
        await receiptStore.selectCurrent({
          connection_id: "subject-other",
          surface_subject_id: "subject-other",
        })
      )?.replacement_id,
      isolated.replacement_id
    );
    assert.equal(
      await receiptStore.selectCurrent({
        connection_id: surfaceSubjectId,
        surface_subject_id: "subject-other",
      }),
      null
    );
  } finally {
    closeDb();
  }
});

test("durable receipt persistence failures are not converted into successful lifecycle calls", async () => {
  const ledger = createBrowserSurfaceReplacementLedger();
  const persistenceError = new Error("database unavailable");
  let stopCalled = false;
  const observed = createReplacementObservingAllocator(
    // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
    allocator(async () => {
      stopCalled = true;
      return null;
    }),
    {
      ledger,
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      persist: async () => {
        throw persistenceError;
      },
    }
  );

  await assert.rejects(
    () => observed.stopSurface({ reason: "operator", surfaceId: surface.surface_id }),
    persistenceError
  );
  assert.equal(stopCalled, false);
});

test("successful ensure followed by receipt persistence failure does not invoke ensure-failure recording", async () => {
  const ledger = createBrowserSurfaceReplacementLedger();
  const persistenceError = new Error("database unavailable");
  const attempted: ReplacementReceipt[] = [];
  const oldSurface: BrowserSurface = { ...surface, container_id: "container-old" };
  const newSurface: BrowserSurface = { ...surface, container_id: "container-new" };
  let ensureCalls = 0;
  const observed = createReplacementObservingAllocator(
    {
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      ensureSurface: async () => {
        ensureCalls += 1;
        return newSurface;
      },
      getSurfaceStatus: async () => oldSurface,
      listSurfaces: async () => [newSurface],
      stopSurface: async () => null,
    },
    {
      ledger,
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      persist: async (receipt) => {
        attempted.push(receipt);
        if (attempted.length === 1) {
          throw persistenceError;
        }
        return receipt;
      },
    }
  );

  await assert.rejects(
    () =>
      observed.ensureSurface({
        connectorId: surface.connector_id,
        profileKey: surface.profile_key,
        surfaceId: surface.surface_id,
        ...(surface.surface_subject_id ? { surfaceSubjectId: surface.surface_subject_id } : {}),
      }),
    persistenceError
  );
  assert.equal(ensureCalls, 1, "the allocator succeeded exactly once");
  assert.deepEqual(
    attempted.map((receipt) => receipt.phase),
    ["started"]
  );
  const [firstAttempted] = attempted;
  assert.ok(firstAttempted, "expected the first attempted receipt");
  assert.equal(firstAttempted.cause, "allocator_internal_ensure_surface");
});

test("complete and terminate replay paths validate every supplied immutable field", () => {
  const ledger = createBrowserSurfaceReplacementLedger();
  const started = ledger.start({
    cause: "allocator_internal_ensure_surface",
    connection_id: "connection-1",
    connector_id: "chatgpt",
    idempotency_key: "replay-start",
    profile_key: "profile-1",
    surface_id: "surface-1",
    surface_subject_id: "subject-1",
  });
  const completed = ledger.complete({
    connection_id: started.connection_id,
    profile_key: started.profile_key,
    replacement_id: started.replacement_id,
    ...(started.surface_subject_id ? { surface_subject_id: started.surface_subject_id } : {}),
    ...(started.surface_id ? { surface_id: started.surface_id } : {}),
    next_generation: 2,
  });

  assert.throws(
    () =>
      ledger.complete({
        connection_id: completed.connection_id,
        next_generation: 2,
        profile_key: completed.profile_key,
        replacement_id: completed.replacement_id,
        surface_id: "other-surface",
      }),
    ReplacementReplayConflictError
  );

  const terminalStarted = ledger.start({
    cause: "idle_ttl",
    connection_id: "connection-2",
    idempotency_key: "terminal-start",
    profile_key: "profile-2",
    surface_id: "surface-2",
  });
  const terminal = ledger.terminate({
    connection_id: terminalStarted.connection_id,
    profile_key: terminalStarted.profile_key,
    replacement_id: terminalStarted.replacement_id,
    ...(terminalStarted.surface_id ? { surface_id: terminalStarted.surface_id } : {}),
    cause: terminalStarted.cause,
    outcome: "failed",
  });
  assert.throws(
    () =>
      ledger.terminate({
        cause: terminal.cause,
        connection_id: terminal.connection_id,
        outcome: "failed",
        profile_key: terminal.profile_key,
        replacement_id: terminal.replacement_id,
        surface_id: "other-surface",
      }),
    ReplacementReplayConflictError
  );
});

test("completed and terminal phases are mutually final", () => {
  const ledger = createBrowserSurfaceReplacementLedger();
  const terminalStarted = ledger.start({
    cause: "operator_requested",
    connection_id: "connection-terminal",
    idempotency_key: "terminal-before-complete",
    profile_key: "profile-terminal",
    surface_id: "surface-terminal",
  });
  ledger.terminate({
    connection_id: terminalStarted.connection_id,
    profile_key: terminalStarted.profile_key,
    replacement_id: terminalStarted.replacement_id,
    ...(terminalStarted.surface_id ? { surface_id: terminalStarted.surface_id } : {}),
    cause: terminalStarted.cause,
    outcome: "failed",
  });
  assert.throws(
    () =>
      ledger.complete({
        connection_id: terminalStarted.connection_id,
        profile_key: terminalStarted.profile_key,
        replacement_id: terminalStarted.replacement_id,
        ...(terminalStarted.surface_id ? { surface_id: terminalStarted.surface_id } : {}),
        cause: terminalStarted.cause,
        next_generation: 2,
      }),
    ReplacementReplayConflictError
  );

  const completedStarted = ledger.start({
    cause: "idle_ttl",
    connection_id: "connection-complete",
    idempotency_key: "complete-before-terminal",
    profile_key: "profile-complete",
    surface_id: "surface-complete",
  });
  ledger.complete({
    connection_id: completedStarted.connection_id,
    profile_key: completedStarted.profile_key,
    replacement_id: completedStarted.replacement_id,
    ...(completedStarted.surface_id ? { surface_id: completedStarted.surface_id } : {}),
    cause: completedStarted.cause,
    next_generation: 3,
  });
  assert.throws(
    () =>
      ledger.terminate({
        connection_id: completedStarted.connection_id,
        profile_key: completedStarted.profile_key,
        replacement_id: completedStarted.replacement_id,
        ...(completedStarted.surface_id ? { surface_id: completedStarted.surface_id } : {}),
        cause: completedStarted.cause,
        outcome: "abandoned",
      }),
    ReplacementReplayConflictError
  );
});

test("pure completion requires an independently observed generation", () => {
  const ledger = createBrowserSurfaceReplacementLedger();
  const started = ledger.start({
    cause: "allocator_internal_ensure_surface",
    connection_id: "connection-generation",
    idempotency_key: "missing-generation",
    profile_key: "profile-generation",
    surface_id: "surface-generation",
  });
  assert.throws(
    () =>
      ledger.complete({
        connection_id: started.connection_id,
        profile_key: started.profile_key,
        replacement_id: started.replacement_id,
        ...(started.surface_id ? { surface_id: started.surface_id } : {}),
        cause: started.cause,
      }),
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    /observed generation hash/
  );
});

function lifecycleSurface(
  overrides: Partial<BrowserSurfaceWithPersistenceMetadata> = {}
): BrowserSurfaceWithPersistenceMetadata {
  return {
    backend: "neko",
    browser_generation_hash: "a".repeat(64),
    cdp_url: "http://neko:9222",
    connector_id: "connector-generation",
    container_id: "container-generation",
    created_at: "2026-07-16T12:00:00.000Z",
    health: "ready",
    last_used_at: "2026-07-16T12:00:00.000Z",
    profile_key: "profile-generation",
    stream_base_url: "http://neko:8080",
    surface_id: "surface-generation",
    surface_subject_id: "subject-generation",
    ...overrides,
  };
}

function notImplementedInLifecycleFake(method: string): never {
  throw new Error(`${method} is not implemented in this lifecycle-hooks test fake`);
}

function lifecyclePersistence(initialSurface: BrowserSurfaceWithPersistenceMetadata): {
  readonly leaseStore: BrowserSurfaceLeaseStore;
  readonly receiptStore: BrowserSurfaceReplacementReceiptStore;
  readonly receipts: ReplacementReceipt[];
  readonly getSurface: () => BrowserSurfaceWithPersistenceMetadata;
} {
  // biome-ignore lint/suspicious/noShadow: localized test assertion preserves its explicit contract.
  let surface = initialSurface;
  const receipts: ReplacementReceipt[] = [];
  const leaseStore: BrowserSurfaceLeaseStore = {
    clearSurfaceActiveLease: async () => notImplementedInLifecycleFake("clearSurfaceActiveLease"),
    getLease: async () => notImplementedInLifecycleFake("getLease"),
    getSurface: async () => surface,
    listLeases: async () => notImplementedInLifecycleFake("listLeases"),
    listNonTerminalLeases: async () => notImplementedInLifecycleFake("listNonTerminalLeases"),
    listSurfaces: async () => notImplementedInLifecycleFake("listSurfaces"),
    repairStaleSurfaceActiveLeases: async () => notImplementedInLifecycleFake("repairStaleSurfaceActiveLeases"),
    // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
    updateBrowserGenerationHash: async (_surfaceId, browserGenerationHash) => {
      surface = { ...surface, browser_generation_hash: browserGenerationHash };
    },
    updateLeaseTerminal: async () => notImplementedInLifecycleFake("updateLeaseTerminal"),
    upsertLease: async () => notImplementedInLifecycleFake("upsertLease"),
    upsertSurface: async () => notImplementedInLifecycleFake("upsertSurface"),
    withLeaseTransaction: async () => notImplementedInLifecycleFake("withLeaseTransaction"),
  };
  const receiptStore: BrowserSurfaceReplacementReceiptStore = {
    // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
    append: async (receipt) => {
      receipts.push(receipt);
      return receipt;
    },
    findPendingForScope: async ({ connection_id, surface_subject_id, profile_key }) =>
      receipts
        .filter(
          (receipt) =>
            receipt.connection_id === connection_id &&
            (receipt.surface_subject_id ?? null) === surface_subject_id &&
            receipt.profile_key === profile_key &&
            receipt.phase === "started" &&
            !receipts.some(
              (resolution) =>
                resolution.replacement_id === receipt.replacement_id &&
                (resolution.phase === "completed" || resolution.phase === "terminal")
            )
        )
        .sort((left, right) => right.event_seq - left.event_seq)[0] ?? null,
    findPendingForSurface: async (surfaceId) =>
      receipts.find(
        (receipt) =>
          receipt.surface_id === surfaceId &&
          receipt.phase === "started" &&
          !receipts.some(
            (resolution) =>
              resolution.replacement_id === receipt.replacement_id &&
              (resolution.phase === "completed" || resolution.phase === "terminal")
          )
      ) ?? null,
    list: async () => receipts.slice(),
    listForScope: async () => notImplementedInLifecycleFake("listForScope"),
    selectCurrent: async () => notImplementedInLifecycleFake("selectCurrent"),
    selectSystemActionable: ({ connection_id, profile_key, surface_subject_id }) => {
      const scoped = receipts.filter(
        (receipt) =>
          receipt.connection_id === connection_id &&
          receipt.profile_key === profile_key &&
          (receipt.surface_subject_id ?? undefined) === surface_subject_id
      );
      const latestStarted = scoped.filter((receipt) => receipt.phase === "started").at(-1);
      const latest = scoped.filter((receipt) => receipt.replacement_id === latestStarted?.replacement_id).at(-1);
      return Promise.resolve(
        latest?.phase === "terminal" && latest.terminal_outcome === "failed" && latest.cause === "external_or_host_loss"
          ? latest
          : null
      );
    },
  };
  return {
    getSurface: () => surface,
    leaseStore,
    receiptStore,
    receipts,
  };
}

test("mid-wait browser generation records stable-container change, unchanged is a no-op, and unproven identity is external", async () => {
  const persistence = lifecyclePersistence(lifecycleSurface());
  const hooks = createReplacementLifecycleHooks({
    allocator: null,
    leaseStore: persistence.leaseStore,
    log: {},
    receiptStore: persistence.receiptStore,
  });
  const lease = minimalLease("lease-generation");
  const changed: BrowserSurfaceReadinessProbeSuccess = {
    browserGenerationHash: "b".repeat(64),
    ok: true,
    pageTargetCount: 1,
  };

  await hooks.recordBrowserGeneration(
    lease,
    persistence.getSurface(),
    "connector-generation",
    "run-generation",
    changed
  );
  assert.deepEqual(
    persistence.receipts.map((receipt) => receipt.phase),
    ["started", "completed"]
  );
  const [, firstCompletion] = persistence.receipts;
  assert.ok(firstCompletion, "expected a completion receipt after the first recordBrowserGeneration call");
  assert.equal(firstCompletion.cause, "same_container_browser_generation_change");

  await hooks.recordBrowserGeneration(
    lease,
    persistence.getSurface(),
    "connector-generation",
    "run-generation",
    changed
  );
  assert.equal(persistence.receipts.length, 2, "unchanged generation must not append another causal chain");

  const { container_id: _droppedContainerId, ...unproven } = lifecycleSurface({
    browser_generation_hash: "b".repeat(64),
  });
  await hooks.recordBrowserGeneration(lease, unproven, "connector-generation", "run-generation", {
    browserGenerationHash: "c".repeat(64),
    ok: true,
    pageTargetCount: 1,
  });
  const lastReceipt = persistence.receipts.at(-1);
  assert.ok(lastReceipt, "expected a receipt after the unproven-identity recordBrowserGeneration call");
  assert.equal(lastReceipt.cause, "external_or_host_loss");
  assert.notEqual(lastReceipt.cause, "same_container_browser_generation_change");
});

test("readiness completes a durable pending stop after cleanup rotates the surface id", async () => {
  const persistence = lifecyclePersistence(lifecycleSurface({ surface_id: "surface-new" }));
  const oldPending = createBrowserSurfaceReplacementLedger().start({
    cause: "idle_ttl",
    connection_id: "subject-generation",
    connector_id: "connector-generation",
    idempotency_key: "idle-stop-old-surface",
    previous_generation_hash: "a".repeat(64),
    profile_key: "profile-generation",
    surface_id: "surface-old",
    surface_subject_id: "subject-generation",
  });
  await persistence.receiptStore.append(oldPending);

  const hooksAfterRestart = createReplacementLifecycleHooks({
    allocator: null,
    leaseStore: persistence.leaseStore,
    log: {},
    receiptStore: persistence.receiptStore,
  });
  await hooksAfterRestart.recordBrowserGeneration(
    minimalLease("lease-generation"),
    persistence.getSurface(),
    "connector-generation",
    "run-generation",
    { browserGenerationHash: "b".repeat(64), ok: true, pageTargetCount: 1 }
  );

  assert.deepEqual(
    persistence.receipts.map((receipt) => receipt.phase),
    ["started", "completed"]
  );
  const [, completedReceipt] = persistence.receipts;
  assert.ok(completedReceipt, "expected a completed receipt after readiness recordBrowserGeneration");
  assert.equal(completedReceipt.replacement_id, oldPending.replacement_id);
  assert.equal(completedReceipt.surface_id, "surface-old");
});

test("external loss stays pending until a scoped successor proves its generation", async () => {
  const previous = lifecycleSurface({ surface_id: "surface-lost" });
  const persistence = lifecyclePersistence(previous);
  const hooks = createReplacementLifecycleHooks({
    allocator: null,
    leaseStore: persistence.leaseStore,
    log: {},
    receiptStore: persistence.receiptStore,
  });

  await hooks.recordExternalSurfaceLoss(previous);
  assert.deepEqual(
    persistence.receipts.map((receipt) => receipt.phase),
    ["started"]
  );

  await hooks.recordBrowserGeneration(
    minimalLease("lease-successor"),
    { ...previous, container_id: "container-successor", surface_id: "surface-successor" },
    previous.connector_id,
    "run-confirming",
    { browserGenerationHash: "b".repeat(64), ok: true, pageTargetCount: 1 }
  );

  assert.deepEqual(
    persistence.receipts.map((receipt) => receipt.phase),
    ["started", "completed"]
  );
  const completed = persistence.receipts.at(-1);
  assert.ok(completed);
  assert.equal(completed.cause, "external_or_host_loss");
  assert.equal(completed.next_generation_hash, "b".repeat(64));
  assert.equal(completed.surface_id, "surface-lost", "the receipt retains the replaced surface provenance");
});

test("a failed successor terminalizes the scoped external-loss receipt", async () => {
  const previous = lifecycleSurface({ surface_id: "surface-lost" });
  const persistence = lifecyclePersistence(previous);
  const hooks = createReplacementLifecycleHooks({
    allocator: {
      ensureSurface: async () => Promise.reject(new Error("allocator unavailable")),
      getSurfaceStatus: async () => null,
      listSurfaces: async () => [],
      stopSurface: async () => null,
    },
    leaseStore: persistence.leaseStore,
    log: {},
    receiptStore: persistence.receiptStore,
  });

  await hooks.recordExternalSurfaceLoss(previous);
  await assert.rejects(
    () =>
      hooks.allocator?.ensureSurface({
        connectorId: previous.connector_id,
        profileKey: previous.profile_key,
        surfaceId: "surface-successor",
        ...(previous.surface_subject_id ? { surfaceSubjectId: previous.surface_subject_id } : {}),
      }) ?? Promise.reject(new Error("allocator wrapper missing")),
    ALLOCATOR_UNAVAILABLE
  );

  assert.deepEqual(
    persistence.receipts.map((receipt) => [receipt.phase, receipt.terminal_outcome]),
    [
      ["started", undefined],
      ["terminal", "failed"],
    ]
  );

  await hooks.recordBrowserGeneration(
    minimalLease("lease-recovered"),
    { ...previous, container_id: "container-recovered", surface_id: "surface-recovered" },
    previous.connector_id,
    "run-recovered",
    { browserGenerationHash: "a".repeat(64), ok: true, pageTargetCount: 1 }
  );
  assert.equal(
    persistence.receipts.at(-1)?.phase,
    "completed",
    "a later confirmed successor supersedes the failed runtime boundary"
  );
  assert.equal(
    await persistence.receiptStore.selectSystemActionable({
      connection_id: previous.surface_subject_id ?? previous.connector_id,
      profile_key: previous.profile_key,
      ...(previous.surface_subject_id ? { surface_subject_id: previous.surface_subject_id } : {}),
    }),
    null,
    "the confirming successor clears the failed external-loss runtime boundary"
  );

  await hooks.recordExternalSurfaceLoss({
    ...previous,
    last_used_at: "2026-07-16T13:00:00.000Z",
  });
  const repeatedLoss = persistence.receipts.at(-1);
  assert.equal(repeatedLoss?.phase, "started");
  assert.notEqual(
    repeatedLoss?.replacement_id,
    persistence.receipts[0]?.replacement_id,
    "a later host-loss observation creates a new durable replacement boundary"
  );
});

test("current selection never revives an older pending boundary", () => {
  const ledger = createBrowserSurfaceReplacementLedger();
  const older = ledger.start({
    cause: "idle_ttl",
    connection_id: "selection-connection",
    idempotency_key: "older-pending",
    profile_key: "selection-profile",
    surface_id: "surface-old",
    surface_subject_id: "selection-subject",
  });
  const newer = ledger.start({
    connection_id: older.connection_id,
    idempotency_key: "newer-completed",
    profile_key: older.profile_key,
    ...(older.surface_subject_id ? { surface_subject_id: older.surface_subject_id } : {}),
    cause: "operator_requested",
    surface_id: "surface-new",
  });
  ledger.complete({
    connection_id: newer.connection_id,
    profile_key: newer.profile_key,
    replacement_id: newer.replacement_id,
    ...(newer.surface_subject_id ? { surface_subject_id: newer.surface_subject_id } : {}),
    ...(newer.surface_id ? { surface_id: newer.surface_id } : {}),
    cause: newer.cause,
    next_generation_hash: "b".repeat(64),
  });
  assert.equal(ledger.selectCurrent(older.connection_id, older.surface_subject_id, "c".repeat(64)), null);

  const terminal = ledger.start({
    connection_id: older.connection_id,
    idempotency_key: "newest-terminal",
    profile_key: older.profile_key,
    ...(older.surface_subject_id ? { surface_subject_id: older.surface_subject_id } : {}),
    cause: "readiness_invalidated",
    surface_id: "surface-terminal",
  });
  ledger.terminate({
    connection_id: terminal.connection_id,
    profile_key: terminal.profile_key,
    replacement_id: terminal.replacement_id,
    ...(terminal.surface_subject_id ? { surface_subject_id: terminal.surface_subject_id } : {}),
    ...(terminal.surface_id ? { surface_id: terminal.surface_id } : {}),
    cause: terminal.cause,
    outcome: "failed",
  });
  assert.equal(ledger.selectCurrent(older.connection_id, older.surface_subject_id, "b".repeat(64)), null);
});

test("current selection follows the newest started boundary across interleaved events", () => {
  const ledger = createBrowserSurfaceReplacementLedger();
  const first = ledger.start({
    cause: "idle_ttl",
    connection_id: "interleaved-connection",
    idempotency_key: "interleaved-first",
    profile_key: "interleaved-profile",
    surface_id: "surface-first",
    surface_subject_id: "interleaved-subject",
  });
  const second = ledger.start({
    connection_id: first.connection_id,
    idempotency_key: "interleaved-second",
    profile_key: first.profile_key,
    ...(first.surface_subject_id ? { surface_subject_id: first.surface_subject_id } : {}),
    cause: "operator_requested",
    surface_id: "surface-second",
  });
  const firstCompleted = ledger.complete({
    connection_id: first.connection_id,
    profile_key: first.profile_key,
    replacement_id: first.replacement_id,
    ...(first.surface_subject_id ? { surface_subject_id: first.surface_subject_id } : {}),
    ...(first.surface_id ? { surface_id: first.surface_id } : {}),
    cause: first.cause,
    next_generation_hash: "a".repeat(64),
  });

  assert.equal(
    ledger.selectCurrent(first.connection_id, first.surface_subject_id, firstCompleted.next_generation_hash),
    second,
    "a newer pending start remains authoritative over an interleaved older completion"
  );
});
