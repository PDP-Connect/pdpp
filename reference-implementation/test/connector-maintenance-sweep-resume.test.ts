// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBrowserSurfaceLeaseSweepTimer } from "../runtime/browser-surface-lease-sweep-timer.ts";
import { createResumableConnectorMaintenanceSweep } from "../server/connector-maintenance-sweep.ts";
import { closeDb, initDb } from "../server/db.ts";
import { runStartupSummaryEvidenceSweepToCompletion as runStartupSummaryEvidenceSweepToCompletionUntyped } from "../server/index.ts";
import {
  type ConnectorMaintenanceCursorLease,
  type ConnectorMaintenanceCursorStore,
  createConnectorMaintenanceCursorStore,
} from "../server/stores/connector-maintenance-cursor-store.ts";

const INVALID_RESUMABLE_RESULT = /invalid resumable result/;

const runStartupSummaryEvidenceSweepToCompletion = runStartupSummaryEvidenceSweepToCompletionUntyped as (args: {
  runSweep: (args: {
    afterId?: string | null;
    maxDurationMs?: number;
    pageSize?: number;
  }) => Promise<{ incomplete: boolean; resumeAfterId: string | null } | null>;
  maxDurationMs: number;
  maxRounds: number;
  pageSize: number;
}) => Promise<Array<{ incomplete: boolean; resumeAfterId: string | null }>>;

function memoryCursorStore(): ConnectorMaintenanceCursorStore & { readonly writes: Array<string | null> } {
  let cursor: string | null = null;
  let generation = 0;
  let lease: ConnectorMaintenanceCursorLease | null = null;
  const writes: Array<string | null> = [];
  return {
    acquire: () => {
      if (lease) {
        return Promise.resolve(null);
      }
      generation += 1;
      lease = { generation, resumeAfterId: cursor, token: `lease_${generation}` };
      return Promise.resolve(lease);
    },
    commit: ({ lease: candidate, resumeAfterId }) => {
      if (lease?.generation !== candidate.generation || lease.token !== candidate.token) {
        return Promise.resolve(false);
      }
      cursor = resumeAfterId;
      lease = null;
      writes.push(resumeAfterId);
      return Promise.resolve(true);
    },
    release: (candidate) => {
      if (lease?.generation !== candidate.generation || lease.token !== candidate.token) {
        return Promise.resolve(false);
      }
      lease = null;
      return Promise.resolve(true);
    },
    writes,
  };
}

function runner(
  cursorStore: ConnectorMaintenanceCursorStore,
  runEvidenceSweep: (afterId: string | null | undefined) => Promise<unknown>
) {
  return createResumableConnectorMaintenanceSweep(
    {
      evidenceSweepMaxDurationMs: 1,
      evidenceSweepPageSize: 1,
      runEvidenceSweep: ({ afterId }) => runEvidenceSweep(afterId),
    },
    cursorStore
  );
}

test("maintenance resumes a persisted keyset cursor across restart and converges after more than one time budget", async () => {
  initDb(":memory:");
  const cursorStore = memoryCursorStore();
  const received: Array<string | null | undefined> = [];
  const pages = [
    { incomplete: true, resumeAfterId: "cin_page_1" },
    { incomplete: true, resumeAfterId: "cin_page_2" },
    { incomplete: false, resumeAfterId: null },
  ];
  try {
    const firstProcess = runner(cursorStore, (afterId) => {
      received.push(afterId);
      return Promise.resolve(pages[0]);
    });
    await firstProcess.run();
    assert.deepEqual(cursorStore.writes, ["cin_page_1"]);

    // A new runner simulates the periodic worker after a process restart. It
    // must load the durable cursor, not replay the first time-budget page.
    let page = 1;
    const restartedProcess = runner(cursorStore, (afterId) => {
      received.push(afterId);
      const next = pages[page];
      page += 1;
      return Promise.resolve(next);
    });
    await restartedProcess.run();
    await restartedProcess.run();

    assert.deepEqual(received, [null, "cin_page_1", "cin_page_2"]);
    assert.deepEqual(cursorStore.writes, ["cin_page_1", "cin_page_2", null]);
    assert.equal(
      restartedProcess.getResumeAfterId(),
      null,
      "a completed fleet clears the durable cursor for the next full pass"
    );
  } finally {
    closeDb();
  }
});

test("maintenance preserves its durable cursor when an evidence result is malformed", async () => {
  initDb(":memory:");
  const cursorStore = memoryCursorStore();
  const received: Array<string | null | undefined> = [];
  const phases: string[] = [];
  try {
    const first = runner(cursorStore, (afterId) => {
      received.push(afterId);
      return Promise.resolve({ incomplete: true, resumeAfterId: "cin_resume" });
    });
    await first.run();
    const malformed = createResumableConnectorMaintenanceSweep(
      {
        evidenceSweepMaxDurationMs: 1,
        onPhaseError: (phase) => phases.push(phase),
        runEvidenceSweep: ({ afterId }) => {
          received.push(afterId);
          return Promise.resolve({ incomplete: true, resumeAfterId: null });
        },
      },
      cursorStore
    );
    await malformed.run();
    const resumed = runner(cursorStore, (afterId) => {
      received.push(afterId);
      return Promise.resolve({ incomplete: false, resumeAfterId: null });
    });
    await resumed.run();

    assert.deepEqual(received, [null, "cin_resume", "cin_resume"]);
    assert.deepEqual(phases, ["evidence"]);
    assert.deepEqual(cursorStore.writes, ["cin_resume", null]);
  } finally {
    closeDb();
  }
});

test("maintenance rejects a complete result that incorrectly carries a cursor", async () => {
  initDb(":memory:");
  const cursorStore = memoryCursorStore();
  const received: Array<string | null | undefined> = [];
  const phases: string[] = [];
  try {
    const first = runner(cursorStore, (afterId) => {
      received.push(afterId);
      return Promise.resolve({ incomplete: true, resumeAfterId: "cin_resume" });
    });
    await first.run();
    const malformed = createResumableConnectorMaintenanceSweep(
      {
        evidenceSweepMaxDurationMs: 1,
        onPhaseError: (phase) => phases.push(phase),
        runEvidenceSweep: ({ afterId }) => {
          received.push(afterId);
          return Promise.resolve({ incomplete: false, resumeAfterId: "cin_invalid_complete_cursor" });
        },
      },
      cursorStore
    );
    await malformed.run();
    const resumed = runner(cursorStore, (afterId) => {
      received.push(afterId);
      return Promise.resolve({ incomplete: false, resumeAfterId: null });
    });
    await resumed.run();

    assert.deepEqual(received, [null, "cin_resume", "cin_resume"]);
    assert.deepEqual(phases, ["evidence"]);
    assert.deepEqual(cursorStore.writes, ["cin_resume", null]);
  } finally {
    closeDb();
  }
});

test("SQLite retries a heavy first-page fold across restart and completes it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pdpp-maintenance-first-page-"));
  const databasePath = join(directory, "pdpp.sqlite");
  const received: Array<string | null | undefined> = [];
  try {
    initDb(databasePath);
    const firstProcess = runner(createConnectorMaintenanceCursorStore(), (afterId) => {
      received.push(afterId);
      return Promise.resolve({ incomplete: true, resumeAfterId: null });
    });
    assert.deepEqual(await firstProcess.runEvidenceSweepRound({ maxDurationMs: 1 }), {
      incomplete: true,
      resumeAfterId: null,
    });

    closeDb();
    initDb(databasePath);
    let remainingFoldBatches = 2;
    const restartedProcess = runner(createConnectorMaintenanceCursorStore(), (afterId) => {
      received.push(afterId);
      remainingFoldBatches -= 1;
      return Promise.resolve(
        remainingFoldBatches === 0
          ? { incomplete: false, resumeAfterId: null }
          : { incomplete: true, resumeAfterId: null }
      );
    });
    assert.deepEqual(await restartedProcess.runEvidenceSweepRound({ maxDurationMs: 1 }), {
      incomplete: true,
      resumeAfterId: null,
    });
    assert.deepEqual(await restartedProcess.runEvidenceSweepRound({ maxDurationMs: 1 }), {
      incomplete: false,
      resumeAfterId: null,
    });

    assert.deepEqual(received, [null, null, null]);
    assert.equal(remainingFoldBatches, 0, "repeated bounded rounds complete the first-page fold");
  } finally {
    closeDb();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("SQLite rejects a null cursor that would lose non-null progress", async () => {
  initDb(":memory:");
  try {
    const seeded = runner(createConnectorMaintenanceCursorStore(), () =>
      Promise.resolve({ incomplete: true, resumeAfterId: "cin_keep" })
    );
    await seeded.runEvidenceSweepRound({ maxDurationMs: 1 });

    const invalid = runner(createConnectorMaintenanceCursorStore(), () =>
      Promise.resolve({ incomplete: true, resumeAfterId: null })
    );
    await assert.rejects(invalid.runEvidenceSweepRound({ maxDurationMs: 1 }), INVALID_RESUMABLE_RESULT);

    const resumed = runner(createConnectorMaintenanceCursorStore(), (afterId) => {
      assert.equal(afterId, "cin_keep");
      return Promise.resolve({ incomplete: false, resumeAfterId: null });
    });
    await resumed.runEvidenceSweepRound({ maxDurationMs: 1 });
  } finally {
    closeDb();
  }
});

test("overlapping timer ticks do not race the persisted evidence cursor", async () => {
  initDb(":memory:");
  const cursorStore = memoryCursorStore();
  let releaseFirst: () => void = () => {
    throw new Error("first evidence round has not installed its release hook");
  };
  let hasReleaseHook = false;
  let startedFirst: (() => void) | null = null;
  const firstStarted = new Promise<void>((resolve) => {
    startedFirst = resolve;
  });
  let calls = 0;
  try {
    const sweep = runner(cursorStore, async () => {
      calls += 1;
      startedFirst?.();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
        hasReleaseHook = true;
      });
      return { incomplete: true, resumeAfterId: "cin_after_first" };
    });
    const first = sweep.run();
    await firstStarted;
    const overlapping = sweep.run();
    assert.ok(hasReleaseHook, "first evidence round must hold the in-flight guard before the second tick starts");
    releaseFirst();
    await Promise.all([first, overlapping]);

    assert.equal(calls, 1, "the overlapping tick skips evidence instead of racing the cursor writer");
    assert.deepEqual(cursorStore.writes, ["cin_after_first"]);
  } finally {
    closeDb();
  }
});

test("startup and periodic runners share durable ownership and never overlap evidence work", async () => {
  initDb(":memory:");
  const cursorStore = memoryCursorStore();
  let releaseStartup: (() => void) | null = null;
  let signalStartup: (() => void) | null = null;
  const startupReady = new Promise<void>((resolve) => {
    signalStartup = resolve;
  });
  let startupCalls = 0;
  let periodicCalls = 0;
  try {
    const startup = runner(cursorStore, async () => {
      startupCalls += 1;
      signalStartup?.();
      await new Promise<void>((resolve) => {
        releaseStartup = resolve;
      });
      return { incomplete: true, resumeAfterId: "cin_after_startup" };
    });
    const periodic = runner(cursorStore, () => {
      periodicCalls += 1;
      return Promise.resolve({ incomplete: false, resumeAfterId: null });
    });
    const startupRound = startup.runEvidenceSweepRound({ maxDurationMs: 1 });
    await startupReady;
    assert.equal(await periodic.runEvidenceSweepRound({ maxDurationMs: 1 }), null);
    assert.equal(periodicCalls, 0);
    const release = releaseStartup as (() => void) | null;
    assert.ok(release);
    release();
    assert.deepEqual(await startupRound, { incomplete: true, resumeAfterId: "cin_after_startup" });
    assert.equal(startupCalls, 1);
  } finally {
    closeDb();
  }
});

test("startup takes the first fenced round before an immediate periodic timer tick, so the bounded walker is never suppressed", async () => {
  initDb(":memory:");
  const cursorStore = memoryCursorStore();
  let releaseStartup: (() => void) | null = null;
  let signalStartup: (() => void) | null = null;
  const startupEntered = new Promise<void>((resolve) => {
    signalStartup = resolve;
  });
  let evidenceCalls = 0;
  let periodicTicks = 0;
  let intervalCallback: (() => void) | null = null;
  try {
    const coordinator = runner(cursorStore, async () => {
      evidenceCalls += 1;
      signalStartup?.();
      await new Promise<void>((resolve) => {
        releaseStartup = resolve;
      });
      return { incomplete: false, resumeAfterId: null };
    });

    // This is the production ordering in server/index.ts: invoking the
    // startup walk synchronously claims the coordinator before the periodic
    // timer is armed. The timer remains capable of an explicit immediate
    // activation; it simply cannot steal the startup owner's round.
    const startup = runStartupSummaryEvidenceSweepToCompletion({
      maxDurationMs: 1,
      maxRounds: 20,
      pageSize: 1,
      runSweep: (args) =>
        coordinator.runEvidenceSweepRound({
          ...(args.afterId === undefined ? {} : { afterId: args.afterId }),
          maxDurationMs: args.maxDurationMs ?? 1,
          ...(args.pageSize === undefined ? {} : { pageSize: args.pageSize }),
        }),
    });
    await startupEntered;

    const timer = createBrowserSurfaceLeaseSweepTimer({
      clearIntervalFn: () => undefined,
      intervalMs: 60_000,
      runImmediately: true,
      setIntervalFn: (callback) => {
        intervalCallback = callback;
        return {} as NodeJS.Timeout;
      },
      sweep: async () => {
        periodicTicks += 1;
        await coordinator.run();
      },
    });
    timer.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(periodicTicks, 1, "the explicit immediate timer activation ran");
    assert.equal(evidenceCalls, 1, "the immediate timer tick was fenced out of the startup-owned evidence round");

    const periodicTick = intervalCallback as (() => void) | null;
    assert.ok(periodicTick, "the timer installed its regular cadence callback");
    periodicTick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(periodicTicks, 2, "a periodic overlap is also allowed to attempt the shared coordinator");
    assert.equal(evidenceCalls, 1, "overlap never starts a second evidence writer");

    const release = releaseStartup as (() => void) | null;
    assert.ok(release, "the startup owner installed its completion hook");
    release();
    const rounds = await startup;
    assert.equal(rounds.length, 1, "the startup walker completed its authoritative first round, never zero rounds");
    assert.equal(rounds[0]?.incomplete, false);
    timer.stop();
  } finally {
    closeDb();
  }
});
