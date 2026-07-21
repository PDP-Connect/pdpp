// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, initDb } from "../server/db.js";
import { createSqliteBrowserSurfaceLeaseStore } from "../server/stores/browser-surface-lease-store.ts";
import { createSqliteBrowserSurfaceReplacementReceiptStore } from "../server/stores/browser-surface-replacement-ledger-store.ts";
import {
  createBrowserSurfaceReplacementLedger,
  createReplacementObservingAllocator,
  deriveOpaqueGenerationHash,
  ReplacementReplayConflictError,
} from "../runtime/browser-surface/replacement-receipt-ledger.ts";
import { createReplacementLifecycleHooks } from "../runtime/browser-surface/replacement-lifecycle-hooks.ts";

const surface = {
  surface_id: "surface-1",
  backend: "neko",
  profile_key: "chatgpt",
  connector_id: "chatgpt",
  surface_subject_id: "subject-1",
  cdp_url: "http://neko:9222",
  stream_base_url: "http://neko:8080",
  health: "ready",
  container_id: "container-1",
  created_at: "2026-07-16T12:00:00.000Z",
  last_used_at: "2026-07-16T12:00:00.000Z",
};

function allocator(stopSurface) {
  return {
    ensureSurface: async () => surface,
    getSurfaceStatus: async () => surface,
    stopSurface,
    listSurfaces: async () => [surface],
  };
}

test("container replacement appends started before readiness and does not invent a completion hash", async () => {
  const ledger = createBrowserSurfaceReplacementLedger();
  const persisted = [];
  const oldSurface = { ...surface, container_id: "container-old" };
  const newSurface = { ...surface, container_id: "container-new" };
  const observed = createReplacementObservingAllocator(
    {
      ensureSurface: async () => newSurface,
      getSurfaceStatus: async () => oldSurface,
      stopSurface: async () => null,
      listSurfaces: async () => [newSurface],
    },
    {
      ledger,
      persist: async (receipt) => {
        persisted.push(receipt);
        return receipt;
      },
    },
  );

  await observed.ensureSurface({
    surfaceId: surface.surface_id,
    connectorId: surface.connector_id,
    profileKey: surface.profile_key,
  });

  assert.deepEqual(persisted.map((receipt) => receipt.phase), ["started"]);
  assert.equal(persisted[0].next_generation_hash, undefined);
});

function advertisedReplacementSurface(containerId = "container-1") {
  return {
    ...surface,
    container_id: containerId,
    allocator_metadata: { ensure_disposition: "replace" },
  };
}

test("pre-claim ensure persists started before the replacement effect in SQLite", async () => {
  initDb();
  try {
    const receiptStore = createSqliteBrowserSurfaceReplacementReceiptStore();
    const ledger = createBrowserSurfaceReplacementLedger({ now: () => "2026-07-16T12:00:00.000Z" });
    const before = { ...advertisedReplacementSurface("container-old"), surface_id: "preclaim-order" };
    const after = { ...advertisedReplacementSurface("container-new"), surface_id: "preclaim-order" };
    const order = [];
    const observed = createReplacementObservingAllocator(
      {
        ensureSurface: async () => {
          order.push("effect");
          return after;
        },
        getSurfaceStatus: async () => before,
        stopSurface: async () => null,
        listSurfaces: async () => [after],
      },
      {
        ledger,
        createEnsureAttemptId: () => "ensure-attempt-1",
        persist: async (receipt) => {
          order.push(`persist:${receipt.phase}`);
          return receiptStore.append(receipt);
        },
      },
    );

    await observed.ensureSurface({ surfaceId: "preclaim-order", connectorId: "chatgpt", profileKey: "chatgpt" });
    assert.deepEqual(order, ["persist:started", "effect"]);
    const receipts = (await receiptStore.list()).filter((receipt) => receipt.surface_id === "preclaim-order");
    assert.deepEqual(receipts.map((receipt) => receipt.phase), ["started"]);
    assert.match(receipts[0].idempotency_key, /ensure-attempt-1$/);
  } finally {
    closeDb();
  }
});

test("pre-claim persistence failure fails closed before the replacement effect", async () => {
  const ledger = createBrowserSurfaceReplacementLedger();
  const before = { ...advertisedReplacementSurface("container-old"), surface_id: "preclaim-persist-failure" };
  const persistenceError = new Error("receipt store unavailable");
  let ensureCalls = 0;
  const observed = createReplacementObservingAllocator(
    {
      ensureSurface: async () => {
        ensureCalls += 1;
        return { ...before, container_id: "container-new" };
      },
      getSurfaceStatus: async () => before,
      stopSurface: async () => null,
      listSurfaces: async () => [before],
    },
    {
      ledger,
      persist: async () => {
        throw persistenceError;
      },
    },
  );

  await assert.rejects(
    () => observed.ensureSurface({ surfaceId: before.surface_id, connectorId: "chatgpt", profileKey: "chatgpt" }),
    persistenceError,
  );
  assert.equal(ensureCalls, 0);
});

test("independent pre-claim ensure attempts have distinct receipt identities", async () => {
  initDb();
  try {
    const receiptStore = createSqliteBrowserSurfaceReplacementReceiptStore();
    const ledger = createBrowserSurfaceReplacementLedger();
    const before = { ...advertisedReplacementSurface("container-old"), surface_id: "preclaim-retry" };
    const after = { ...before, container_id: "container-new" };
    let attempt = 0;
    const observed = createReplacementObservingAllocator(
      {
        ensureSurface: async () => after,
        getSurfaceStatus: async () => before,
        stopSurface: async () => null,
        listSurfaces: async () => [after],
      },
      {
        ledger,
        createEnsureAttemptId: () => `ensure-attempt-${++attempt}`,
        persist: (receipt) => receiptStore.append(receipt),
      },
    );

    const request = { surfaceId: before.surface_id, connectorId: "chatgpt", profileKey: "chatgpt" };
    await observed.ensureSurface(request);
    await observed.ensureSurface(request);
    const receipts = (await receiptStore.list()).filter((receipt) => receipt.surface_id === before.surface_id);
    assert.deepEqual(receipts.map((receipt) => receipt.phase), ["started", "started"]);
    assert.notEqual(receipts[0].replacement_id, receipts[1].replacement_id);
    assert.notEqual(receipts[0].idempotency_key, receipts[1].idempotency_key);
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
    const before = { ...advertisedReplacementSurface("container-old"), surface_id: "preclaim-failure" };
    const observed = createReplacementObservingAllocator(
      {
        ensureSurface: async () => {
          throw failure;
        },
        getSurfaceStatus: async () => before,
        stopSurface: async () => null,
        listSurfaces: async () => [before],
      },
      { ledger, persist: (receipt) => receiptStore.append(receipt) },
    );

    await assert.rejects(
      () => observed.ensureSurface({ surfaceId: "preclaim-failure", connectorId: "chatgpt", profileKey: "chatgpt" }),
      failure,
    );
    const receipts = (await receiptStore.list()).filter((receipt) => receipt.surface_id === "preclaim-failure");
    assert.deepEqual(receipts.map((receipt) => [receipt.phase, receipt.terminal_outcome]), [
      ["started", undefined],
      ["terminal", "failed"],
    ]);
  } finally {
    closeDb();
  }
});

test("pre-claim ensure returning the same generation is terminally abandoned", async () => {
  initDb();
  try {
    const receiptStore = createSqliteBrowserSurfaceReplacementReceiptStore();
    const ledger = createBrowserSurfaceReplacementLedger();
    const before = { ...advertisedReplacementSurface("container-same"), surface_id: "preclaim-same" };
    const observed = createReplacementObservingAllocator(
      {
        ensureSurface: async () => before,
        getSurfaceStatus: async () => before,
        stopSurface: async () => null,
        listSurfaces: async () => [before],
      },
      { ledger, persist: (receipt) => receiptStore.append(receipt) },
    );

    await observed.ensureSurface({ surfaceId: "preclaim-same", connectorId: "chatgpt", profileKey: "chatgpt" });
    const receipts = (await receiptStore.list()).filter((receipt) => receipt.surface_id === "preclaim-same");
    assert.deepEqual(receipts.map((receipt) => [receipt.phase, receipt.terminal_outcome]), [
      ["started", undefined],
      ["terminal", "abandoned"],
    ]);
  } finally {
    closeDb();
  }
});

test("successful stop retains the started retirement for later readiness completion", async () => {
  const ledger = createBrowserSurfaceReplacementLedger({ now: () => "2026-07-16T12:00:00.000Z" });
  const persisted = [];
  const observed = createReplacementObservingAllocator(allocator(async () => null), {
    ledger,
    persist: async (receipt) => {
      persisted.push(receipt);
      return receipt;
    },
  });

  await observed.stopSurface({ surfaceId: surface.surface_id, reason: "idle_ttl" });

  assert.deepEqual(persisted.map((receipt) => [receipt.phase, receipt.terminal_outcome]), [["started", undefined]]);
});

test("failed stop resolves the started retirement terminally and propagates the stop error", async () => {
  const ledger = createBrowserSurfaceReplacementLedger();
  const persisted = [];
  const stopError = new Error("allocator stop failed");
  const observed = createReplacementObservingAllocator(allocator(async () => {
    throw stopError;
  }), {
    ledger,
    persist: async (receipt) => {
      persisted.push(receipt);
      return receipt;
    },
  });

  await assert.rejects(
    () => observed.stopSurface({ surfaceId: surface.surface_id, reason: "surface_failed" }),
    stopError,
  );
  assert.equal(persisted.at(-1).terminal_outcome, "failed");
  assert.equal(ledger.selectCurrent("subject-1", "subject-1"), null);
});

test("independent stop attempts survive SQLite terminality and exact rotated readiness", async () => {
  initDb();
  try {
    const receiptStore = createSqliteBrowserSurfaceReplacementReceiptStore();
    const leaseStore = createSqliteBrowserSurfaceLeaseStore();
    const firstGeneration = deriveOpaqueGenerationHash("container-1:ready-1");
    const secondGeneration = deriveOpaqueGenerationHash("container-2:ready-2");
    const rotatedSurface = {
      ...surface,
      surface_id: "surface-2",
      container_id: "container-2",
      browser_generation_hash: firstGeneration,
    };
    await leaseStore.upsertSurface(rotatedSurface);

    let stopCalls = 0;
    let attemptCalls = 0;
    const effectOrder = [];
    const stopError = new Error("capacity stop failed once");
    const ledger = createBrowserSurfaceReplacementLedger({ now: () => "2026-07-16T12:00:00.000Z" });
    const observed = createReplacementObservingAllocator(
      {
        ensureSurface: async () => rotatedSurface,
        getSurfaceStatus: async () => surface,
        stopSurface: async () => {
          stopCalls += 1;
          effectOrder.push(`effect:${stopCalls}`);
          if (stopCalls === 1) throw stopError;
          return null;
        },
        listSurfaces: async () => [surface],
      },
      {
        ledger,
        createStopAttemptId: () => `attempt-${++attemptCalls}`,
        persist: async (receipt) => {
          effectOrder.push(`persist:${receipt.phase}`);
          return receiptStore.append(receipt);
        },
      },
    );

    await assert.rejects(
      () => observed.stopSurface({ surfaceId: surface.surface_id, reason: "capacity_pressure" }),
      stopError,
    );
    await observed.stopSurface({ surfaceId: surface.surface_id, reason: "capacity_pressure" });

    const afterStops = await receiptStore.list();
    assert.deepEqual(afterStops.map((receipt) => receipt.phase), ["started", "terminal", "started"]);
    assert.equal(afterStops[1].terminal_outcome, "failed");
    assert.notEqual(afterStops[0].replacement_id, afterStops[2].replacement_id);
    assert.notEqual(afterStops[0].idempotency_key, afterStops[2].idempotency_key);
    assert.deepEqual(effectOrder, ["persist:started", "effect:1", "persist:terminal", "persist:started", "effect:2"]);

    const replay = await receiptStore.append(afterStops[2]);
    assert.equal(replay.event_seq, afterStops[2].event_seq, "one formed receipt remains idempotent on replay");

    const hooks = createReplacementLifecycleHooks({
      allocator: null,
      leaseStore,
      receiptStore,
      log: {},
    });
    await hooks.recordBrowserGeneration(
      { lease_id: "lease-2" },
      rotatedSurface,
      surface.connector_id,
      "run-2",
      { ok: true, pageTargetCount: 1, browserGenerationHash: secondGeneration },
    );

    const afterReadiness = await receiptStore.list();
    assert.deepEqual(afterReadiness.map((receipt) => receipt.phase), ["started", "terminal", "started", "completed"]);
    assert.equal(afterReadiness[1].phase, "terminal", "attempt 1 remains terminal");
    assert.equal(afterReadiness[1].terminal_outcome, "failed");
    assert.equal(afterReadiness[3].replacement_id, afterReadiness[2].replacement_id);
    assert.equal(afterReadiness[3].next_generation_hash, secondGeneration);
    assert.equal(
      (await receiptStore.selectCurrent({
        connection_id: surface.surface_subject_id,
        surface_subject_id: surface.surface_subject_id,
        current_generation_hash: secondGeneration,
      }))?.replacement_id,
      afterReadiness[2].replacement_id,
      "only attempt 2 is current after its exact readiness generation",
    );
    assert.equal(
      await receiptStore.selectCurrent({
        connection_id: surface.surface_subject_id,
        surface_subject_id: surface.surface_subject_id,
        current_generation_hash: firstGeneration,
      }),
      null,
    );

    const isolated = ledger.start({
      idempotency_key: "isolated-stop-attempt",
      connection_id: "subject-other",
      connector_id: surface.connector_id,
      profile_key: surface.profile_key,
      surface_subject_id: "subject-other",
      surface_id: "surface-other",
      cause: "capacity_pressure",
    });
    await receiptStore.append(isolated);
    assert.equal(
      (await receiptStore.findPendingForScope({
        connection_id: "subject-other",
        surface_subject_id: "subject-other",
        profile_key: surface.profile_key,
      }))?.replacement_id,
      isolated.replacement_id,
    );
    assert.equal(
      await receiptStore.findPendingForScope({
        connection_id: surface.surface_subject_id,
        surface_subject_id: "subject-other",
        profile_key: surface.profile_key,
      }),
      null,
    );
    assert.equal(
      await receiptStore.findPendingForScope({
        connection_id: surface.surface_subject_id,
        surface_subject_id: surface.surface_subject_id,
        profile_key: "other-profile",
      }),
      null,
    );
    assert.equal(
      (await receiptStore.selectCurrent({
        connection_id: "subject-other",
        surface_subject_id: "subject-other",
      }))?.replacement_id,
      isolated.replacement_id,
    );
    assert.equal(
      await receiptStore.selectCurrent({
        connection_id: surface.surface_subject_id,
        surface_subject_id: "subject-other",
      }),
      null,
    );
  } finally {
    closeDb();
  }
});

test("durable receipt persistence failures are not converted into successful lifecycle calls", async () => {
  const ledger = createBrowserSurfaceReplacementLedger();
  const persistenceError = new Error("database unavailable");
  let stopCalled = false;
  const observed = createReplacementObservingAllocator(allocator(async () => {
    stopCalled = true;
    return null;
  }), {
    ledger,
    persist: async () => {
      throw persistenceError;
    },
  });

  await assert.rejects(
    () => observed.stopSurface({ surfaceId: surface.surface_id, reason: "operator" }),
    persistenceError,
  );
  assert.equal(stopCalled, false);
});

test("successful ensure followed by receipt persistence failure does not invoke ensure-failure recording", async () => {
  const ledger = createBrowserSurfaceReplacementLedger();
  const persistenceError = new Error("database unavailable");
  const attempted = [];
  const oldSurface = { ...surface, container_id: "container-old" };
  const newSurface = { ...surface, container_id: "container-new" };
  let ensureCalls = 0;
  const observed = createReplacementObservingAllocator(
    {
      ensureSurface: async () => {
        ensureCalls += 1;
        return newSurface;
      },
      getSurfaceStatus: async () => oldSurface,
      stopSurface: async () => null,
      listSurfaces: async () => [newSurface],
    },
    {
      ledger,
      persist: async (receipt) => {
        attempted.push(receipt);
        if (attempted.length === 1) throw persistenceError;
        return receipt;
      },
    },
  );

  await assert.rejects(
    () => observed.ensureSurface({
      surfaceId: surface.surface_id,
      connectorId: surface.connector_id,
      profileKey: surface.profile_key,
      surfaceSubjectId: surface.surface_subject_id,
    }),
    persistenceError,
  );
  assert.equal(ensureCalls, 1, "the allocator succeeded exactly once");
  assert.deepEqual(attempted.map((receipt) => receipt.phase), ["started"]);
  assert.equal(attempted[0].cause, "allocator_internal_ensure_surface");
});

test("complete and terminate replay paths validate every supplied immutable field", () => {
  const ledger = createBrowserSurfaceReplacementLedger();
  const started = ledger.start({
    idempotency_key: "replay-start",
    connection_id: "connection-1",
    connector_id: "chatgpt",
    profile_key: "profile-1",
    surface_subject_id: "subject-1",
    surface_id: "surface-1",
    cause: "allocator_internal_ensure_surface",
  });
  const completed = ledger.complete({
    replacement_id: started.replacement_id,
    connection_id: started.connection_id,
    profile_key: started.profile_key,
    surface_subject_id: started.surface_subject_id,
    surface_id: started.surface_id,
    next_generation: 2,
  });

  assert.throws(
    () => ledger.complete({
      replacement_id: completed.replacement_id,
      connection_id: completed.connection_id,
      profile_key: completed.profile_key,
      surface_id: "other-surface",
      next_generation: 2,
    }),
    ReplacementReplayConflictError,
  );

  const terminalStarted = ledger.start({
    idempotency_key: "terminal-start",
    connection_id: "connection-2",
    profile_key: "profile-2",
    surface_id: "surface-2",
    cause: "idle_ttl",
  });
  const terminal = ledger.terminate({
    replacement_id: terminalStarted.replacement_id,
    connection_id: terminalStarted.connection_id,
    profile_key: terminalStarted.profile_key,
    surface_id: terminalStarted.surface_id,
    cause: terminalStarted.cause,
    outcome: "failed",
  });
  assert.throws(
    () => ledger.terminate({
      replacement_id: terminal.replacement_id,
      connection_id: terminal.connection_id,
      profile_key: terminal.profile_key,
      surface_id: "other-surface",
      cause: terminal.cause,
      outcome: "failed",
    }),
    ReplacementReplayConflictError,
  );
});

test("completed and terminal phases are mutually final", () => {
  const ledger = createBrowserSurfaceReplacementLedger();
  const terminalStarted = ledger.start({
    idempotency_key: "terminal-before-complete",
    connection_id: "connection-terminal",
    profile_key: "profile-terminal",
    surface_id: "surface-terminal",
    cause: "operator_requested",
  });
  ledger.terminate({
    replacement_id: terminalStarted.replacement_id,
    connection_id: terminalStarted.connection_id,
    profile_key: terminalStarted.profile_key,
    surface_id: terminalStarted.surface_id,
    cause: terminalStarted.cause,
    outcome: "failed",
  });
  assert.throws(
    () => ledger.complete({
      replacement_id: terminalStarted.replacement_id,
      connection_id: terminalStarted.connection_id,
      profile_key: terminalStarted.profile_key,
      surface_id: terminalStarted.surface_id,
      cause: terminalStarted.cause,
      next_generation: 2,
    }),
    ReplacementReplayConflictError,
  );

  const completedStarted = ledger.start({
    idempotency_key: "complete-before-terminal",
    connection_id: "connection-complete",
    profile_key: "profile-complete",
    surface_id: "surface-complete",
    cause: "idle_ttl",
  });
  ledger.complete({
    replacement_id: completedStarted.replacement_id,
    connection_id: completedStarted.connection_id,
    profile_key: completedStarted.profile_key,
    surface_id: completedStarted.surface_id,
    cause: completedStarted.cause,
    next_generation: 3,
  });
  assert.throws(
    () => ledger.terminate({
      replacement_id: completedStarted.replacement_id,
      connection_id: completedStarted.connection_id,
      profile_key: completedStarted.profile_key,
      surface_id: completedStarted.surface_id,
      cause: completedStarted.cause,
      outcome: "abandoned",
    }),
    ReplacementReplayConflictError,
  );
});

test("pure completion requires an independently observed generation", () => {
  const ledger = createBrowserSurfaceReplacementLedger();
  const started = ledger.start({
    idempotency_key: "missing-generation",
    connection_id: "connection-generation",
    profile_key: "profile-generation",
    surface_id: "surface-generation",
    cause: "allocator_internal_ensure_surface",
  });
  assert.throws(
    () => ledger.complete({
      replacement_id: started.replacement_id,
      connection_id: started.connection_id,
      profile_key: started.profile_key,
      surface_id: started.surface_id,
      cause: started.cause,
    }),
    /observed generation hash/,
  );
});

function lifecycleSurface(overrides = {}) {
  return {
    surface_id: "surface-generation",
    backend: "neko",
    profile_key: "profile-generation",
    connector_id: "connector-generation",
    cdp_url: "http://neko:9222",
    stream_base_url: "http://neko:8080",
    health: "ready",
    container_id: "container-generation",
    browser_generation_hash: "a".repeat(64),
    created_at: "2026-07-16T12:00:00.000Z",
    last_used_at: "2026-07-16T12:00:00.000Z",
    surface_subject_id: "subject-generation",
    ...overrides,
  };
}

function lifecyclePersistence(initialSurface) {
  let surface = initialSurface;
  const receipts = [];
  return {
    leaseStore: {
      getSurface: async () => surface,
      updateBrowserGenerationHash: async (_surfaceId, browserGenerationHash) => {
        surface = { ...surface, browser_generation_hash: browserGenerationHash };
      },
    },
    receiptStore: {
      append: async (receipt) => {
        receipts.push(receipt);
        return receipt;
      },
      findPendingForSurface: async (surfaceId) =>
        receipts.find(
          (receipt) =>
            receipt.surface_id === surfaceId &&
            receipt.phase === "started" &&
            !receipts.some(
              (resolution) =>
                resolution.replacement_id === receipt.replacement_id &&
                (resolution.phase === "completed" || resolution.phase === "terminal"),
            ),
        ) ?? null,
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
                  (resolution.phase === "completed" || resolution.phase === "terminal"),
              ),
          )
          .sort((left, right) => right.event_seq - left.event_seq)[0] ?? null,
      list: async () => receipts.slice(),
    },
    receipts,
    getSurface: () => surface,
  };
}

test("mid-wait browser generation records stable-container change, unchanged is a no-op, and unproven identity is external", async () => {
  const persistence = lifecyclePersistence(lifecycleSurface());
  const hooks = createReplacementLifecycleHooks({
    allocator: null,
    leaseStore: persistence.leaseStore,
    receiptStore: persistence.receiptStore,
    log: {},
  });
  const lease = { lease_id: "lease-generation" };
  const changed = { ok: true, pageTargetCount: 1, browserGenerationHash: "b".repeat(64) };

  await hooks.recordBrowserGeneration(
    lease,
    persistence.getSurface(),
    "connector-generation",
    "run-generation",
    changed,
  );
  assert.deepEqual(persistence.receipts.map((receipt) => receipt.phase), ["started", "completed"]);
  assert.equal(persistence.receipts[1].cause, "same_container_browser_generation_change");

  await hooks.recordBrowserGeneration(
    lease,
    persistence.getSurface(),
    "connector-generation",
    "run-generation",
    changed,
  );
  assert.equal(persistence.receipts.length, 2, "unchanged generation must not append another causal chain");

  const unproven = lifecycleSurface({ container_id: undefined, browser_generation_hash: "b".repeat(64) });
  await hooks.recordBrowserGeneration(
    lease,
    unproven,
    "connector-generation",
    "run-generation",
    { ok: true, pageTargetCount: 1, browserGenerationHash: "c".repeat(64) },
  );
  assert.equal(persistence.receipts.at(-1).cause, "external_or_host_loss");
  assert.notEqual(persistence.receipts.at(-1).cause, "same_container_browser_generation_change");
});

test("readiness completes a durable pending stop after cleanup rotates the surface id", async () => {
  const persistence = lifecyclePersistence(lifecycleSurface({ surface_id: "surface-new" }));
  const oldPending = createBrowserSurfaceReplacementLedger().start({
    idempotency_key: "idle-stop-old-surface",
    connection_id: "subject-generation",
    connector_id: "connector-generation",
    profile_key: "profile-generation",
    surface_subject_id: "subject-generation",
    surface_id: "surface-old",
    previous_generation_hash: "a".repeat(64),
    cause: "idle_ttl",
  });
  await persistence.receiptStore.append(oldPending);

  const hooksAfterRestart = createReplacementLifecycleHooks({
    allocator: null,
    leaseStore: persistence.leaseStore,
    receiptStore: persistence.receiptStore,
    log: {},
  });
  await hooksAfterRestart.recordBrowserGeneration(
    { lease_id: "lease-generation" },
    persistence.getSurface(),
    "connector-generation",
    "run-generation",
    { ok: true, pageTargetCount: 1, browserGenerationHash: "b".repeat(64) },
  );

  assert.deepEqual(persistence.receipts.map((receipt) => receipt.phase), ["started", "completed"]);
  assert.equal(persistence.receipts[1].replacement_id, oldPending.replacement_id);
  assert.equal(persistence.receipts[1].surface_id, "surface-old");
});

test("current selection never revives an older pending boundary", () => {
  const ledger = createBrowserSurfaceReplacementLedger();
  const older = ledger.start({
    idempotency_key: "older-pending",
    connection_id: "selection-connection",
    profile_key: "selection-profile",
    surface_subject_id: "selection-subject",
    surface_id: "surface-old",
    cause: "idle_ttl",
  });
  const newer = ledger.start({
    idempotency_key: "newer-completed",
    connection_id: older.connection_id,
    profile_key: older.profile_key,
    surface_subject_id: older.surface_subject_id,
    surface_id: "surface-new",
    cause: "operator_requested",
  });
  ledger.complete({
    replacement_id: newer.replacement_id,
    connection_id: newer.connection_id,
    profile_key: newer.profile_key,
    surface_subject_id: newer.surface_subject_id,
    surface_id: newer.surface_id,
    cause: newer.cause,
    next_generation_hash: "b".repeat(64),
  });
  assert.equal(
    ledger.selectCurrent(older.connection_id, older.surface_subject_id, "c".repeat(64)),
    null,
  );

  const terminal = ledger.start({
    idempotency_key: "newest-terminal",
    connection_id: older.connection_id,
    profile_key: older.profile_key,
    surface_subject_id: older.surface_subject_id,
    surface_id: "surface-terminal",
    cause: "readiness_invalidated",
  });
  ledger.terminate({
    replacement_id: terminal.replacement_id,
    connection_id: terminal.connection_id,
    profile_key: terminal.profile_key,
    surface_subject_id: terminal.surface_subject_id,
    surface_id: terminal.surface_id,
    cause: terminal.cause,
    outcome: "failed",
  });
  assert.equal(
    ledger.selectCurrent(older.connection_id, older.surface_subject_id, "b".repeat(64)),
    null,
  );
});

test("current selection follows the newest started boundary across interleaved events", () => {
  const ledger = createBrowserSurfaceReplacementLedger();
  const first = ledger.start({
    idempotency_key: "interleaved-first",
    connection_id: "interleaved-connection",
    profile_key: "interleaved-profile",
    surface_subject_id: "interleaved-subject",
    surface_id: "surface-first",
    cause: "idle_ttl",
  });
  const second = ledger.start({
    idempotency_key: "interleaved-second",
    connection_id: first.connection_id,
    profile_key: first.profile_key,
    surface_subject_id: first.surface_subject_id,
    surface_id: "surface-second",
    cause: "operator_requested",
  });
  const firstCompleted = ledger.complete({
    replacement_id: first.replacement_id,
    connection_id: first.connection_id,
    profile_key: first.profile_key,
    surface_subject_id: first.surface_subject_id,
    surface_id: first.surface_id,
    cause: first.cause,
    next_generation_hash: "a".repeat(64),
  });

  assert.equal(
    ledger.selectCurrent(first.connection_id, first.surface_subject_id, firstCompleted.next_generation_hash),
    second,
    "a newer pending start remains authoritative over an interleaved older completion",
  );
});
