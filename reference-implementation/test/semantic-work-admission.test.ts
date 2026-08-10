// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, initDb } from "../server/db.ts";
import {
  configureSemanticBackend,
  makeStubBackend,
  semanticIndexUpsert,
  semanticWorkStatsForTests,
} from "../server/search-semantic.ts";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  const holder: { resolve: ((value: T) => void) | undefined } = { resolve: undefined };
  const promise = new Promise<T>((done) => {
    holder.resolve = done;
  });
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const resolve = holder.resolve;
  if (!resolve) {
    throw new Error("resolve must be assigned synchronously by the Promise executor");
  }
  return { promise, resolve };
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

function upsert(recordKey: string, text: string) {
  return semanticIndexUpsert({
    connectorId: "semantic-admission",
    connectorInstanceId: "cin_semantic_admission",
    data: { text },
    declaredFields: ["text"],
    recordKey,
    stream: "messages",
  });
}

test("timed semantic admission removes its waiter without stealing a later FIFO permit", async () => {
  const previousDeadline = process.env.PDPP_SEMANTIC_WORK_ACQUIRE_DEADLINE_MS;
  const previousLimit = process.env.PDPP_SEMANTIC_WORK_LIMIT;
  const previousQueue = process.env.PDPP_SEMANTIC_WORK_QUEUE_LIMIT;
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const thirdEntered = deferred();
  const base = makeStubBackend({ dimensions: 8 });
  const backend = {
    ...base,
    embedDocument: async (text: string) => {
      if (text === "first") {
        firstEntered.resolve();
        await releaseFirst.promise;
      }
      if (text === "third") {
        thirdEntered.resolve();
      }
      return base.embedDocument(text);
    },
  };

  process.env.PDPP_SEMANTIC_WORK_LIMIT = "1";
  process.env.PDPP_SEMANTIC_WORK_QUEUE_LIMIT = "2";
  process.env.PDPP_SEMANTIC_WORK_ACQUIRE_DEADLINE_MS = "10";
  initDb(":memory:");
  configureSemanticBackend(backend);
  try {
    const first = upsert("first", "first");
    await firstEntered.promise;
    const timedOut = upsert("second", "second");
    await assert.rejects(
      timedOut,
      (error: unknown) =>
        error !== null && typeof error === "object" && "code" in error && error.code === "semantic_work_busy"
    );
    assert.deepEqual(semanticWorkStatsForTests(), { active: 1, queued: 0 });

    const third = upsert("third", "third");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(semanticWorkStatsForTests(), { active: 1, queued: 1 });
    releaseFirst.resolve();
    await Promise.all([first, third]);
    await thirdEntered.promise;
    assert.deepEqual(semanticWorkStatsForTests(), { active: 0, queued: 0 });
  } finally {
    configureSemanticBackend(null);
    closeDb();
    restoreEnv("PDPP_SEMANTIC_WORK_ACQUIRE_DEADLINE_MS", previousDeadline);
    restoreEnv("PDPP_SEMANTIC_WORK_LIMIT", previousLimit);
    restoreEnv("PDPP_SEMANTIC_WORK_QUEUE_LIMIT", previousQueue);
  }
});

test("PDPP_SEMANTIC_WORK_LIMIT=2 admits two concurrent jobs (proves the admission mechanism, not a specific default)", async () => {
  // Regression for the stale hardcoded DEFAULT_SEMANTIC_WORK_LIMIT=1: this
  // proves the semaphore itself admits >1 concurrently when configured to.
  // Deliberately does NOT assert on the *unconfigured* default reached via
  // effectiveCpuCount()/effectiveMemoryBudgetBytes() — those read the REAL
  // host/cgroup state (server/cpu-quota.ts's REAL_PROBE), which this test
  // process cannot control and which correctly (by design) floors to 1
  // whenever the cgroup quota is ambiguous, e.g. this exact sandbox: a
  // cgroup IS mounted (nested under a scope this env's fixed
  // /sys/fs/cgroup/cpu.max read does not resolve) but the quota file isn't
  // at the path this module checks, so the safe "unknown" floor applies.
  // See test/cpu-quota.test.ts and test/embedding-concurrency.test.ts for
  // injectable-probe coverage of the actual derivation logic.
  const previousLimit = process.env.PDPP_SEMANTIC_WORK_LIMIT;
  process.env.PDPP_SEMANTIC_WORK_LIMIT = "2";
  const firstEntered = deferred();
  const secondEntered = deferred();
  const releaseBoth = deferred();
  const base = makeStubBackend({ dimensions: 8 });
  const backend = {
    ...base,
    embedDocument: async (text: string) => {
      if (text === "first") {
        firstEntered.resolve();
      }
      if (text === "second") {
        secondEntered.resolve();
      }
      if (text === "first" || text === "second") {
        await releaseBoth.promise;
      }
      return base.embedDocument(text);
    },
  };

  initDb(":memory:");
  configureSemanticBackend(backend);
  try {
    const first = upsert("first", "first");
    await firstEntered.promise;
    const second = upsert("second", "second");
    await secondEntered.promise;
    // Both admitted concurrently: the default limit is > 1 on this host.
    assert.equal(semanticWorkStatsForTests().active, 2);
    releaseBoth.resolve();
    await Promise.all([first, second]);
  } finally {
    configureSemanticBackend(null);
    closeDb();
    restoreEnv("PDPP_SEMANTIC_WORK_LIMIT", previousLimit);
  }
});
