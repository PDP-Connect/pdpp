// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { createResumableConnectorMaintenanceSweep } from "../server/connector-maintenance-sweep.ts";
import { closeDb, initDb } from "../server/db.ts";
import type {
  ConnectorMaintenanceCursorLease,
  ConnectorMaintenanceCursorStore,
} from "../server/stores/connector-maintenance-cursor-store.ts";

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
