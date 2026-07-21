// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  millisecondsUntilNextNightlySummary,
  notifyOvernightSummarySafely,
  resolveSchedulerPersistenceStore,
  type SchedulerPersistenceStore,
  type SchedulerSummary,
  scheduleNightlySummary,
} from "./scheduler-runner.ts";

const summary: SchedulerSummary = {
  counts: { ynab: "1/1 succeeded, 4 records" },
  failures: [],
  ok: true,
};

test("millisecondsUntilNextNightlySummary targets the next local nightly slot", () => {
  assert.equal(millisecondsUntilNextNightlySummary(new Date("2026-04-29T06:30:00"), 7, 0), 30 * 60 * 1000);
  assert.equal(millisecondsUntilNextNightlySummary(new Date("2026-04-29T07:00:00"), 7, 0), 24 * 60 * 60 * 1000);
});

test("notifyOvernightSummarySafely keeps ntfy failures non-fatal", async () => {
  await notifyOvernightSummarySafely(summary, () => Promise.reject(new Error("ntfy unavailable")));
});

test("scheduleNightlySummary sends summary and schedules the next run without network", async () => {
  const timers: Array<() => void> = [];
  const delays: number[] = [];
  const notified: SchedulerSummary[] = [];

  const schedule = scheduleNightlySummary(
    {
      summarize: async () => summary,
    },
    {
      now: () => new Date("2026-04-29T06:45:00"),
      notify: (nextSummary) => {
        notified.push(nextSummary);
        return Promise.resolve();
      },
      setTimeout: (callback, delayMs) => {
        timers.push(callback);
        delays.push(delayMs);
        return {};
      },
      clearTimeout: () => undefined,
    }
  );

  assert.equal(delays[0], 15 * 60 * 1000);

  timers[0]?.();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(notified, [summary]);
  assert.equal(delays.length, 2);

  schedule.stop();
});

test("scheduleNightlySummary stop clears the pending timer", () => {
  const cleared: unknown[] = [];
  const timer = {};
  const schedule = scheduleNightlySummary(
    {
      summarize: async () => summary,
    },
    {
      now: () => new Date("2026-04-29T06:45:00"),
      notify: () => Promise.resolve(),
      setTimeout: () => timer,
      clearTimeout: (pendingTimer) => {
        cleared.push(pendingTimer);
      },
    }
  );

  schedule.stop();

  assert.deepEqual(cleared, [timer]);
});

test("resolveSchedulerPersistenceStore disables persistence explicitly", async () => {
  const store = await resolveSchedulerPersistenceStore(false, () =>
    Promise.reject(new Error("default store should not load"))
  );

  assert.equal(store, null);
});

test("resolveSchedulerPersistenceStore uses injected store without loading the default", async () => {
  const injected: SchedulerPersistenceStore = {
    appendRunHistory: () => undefined,
    listLastRunTimes: () => [],
    listRunHistory: () => [],
    upsertLastRunTime: () => undefined,
  };

  const store = await resolveSchedulerPersistenceStore(injected, () =>
    Promise.reject(new Error("default store should not load"))
  );

  assert.equal(store, injected);
});

test("resolveSchedulerPersistenceStore loads the default store when omitted", async () => {
  const loaded: SchedulerPersistenceStore = {
    appendRunHistory: () => undefined,
    listLastRunTimes: () => [],
    listRunHistory: () => [],
    upsertLastRunTime: () => undefined,
  };

  const store = await resolveSchedulerPersistenceStore(undefined, () => Promise.resolve(loaded));

  assert.equal(store, loaded);
});
