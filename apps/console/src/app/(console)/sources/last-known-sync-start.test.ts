// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the client-side last-known sync-start marker.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  clearSyncStartToast,
  markSyncStartToast,
  readSyncStartToast,
  syncStartToastDismissDelayMs,
  syncStartToastKey,
} from "./last-known-sync-start.ts";

function withFakeSessionStorage(run: (store: Map<string, string>) => void): void {
  const store = new Map<string, string>();
  const fakeWindow = {
    sessionStorage: {
      getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      removeItem: (k: string) => {
        store.delete(k);
      },
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    },
  };
  const g = globalThis as unknown as { window?: unknown };
  const prev = g.window;
  g.window = fakeWindow;
  try {
    run(store);
  } finally {
    g.window = prev;
  }
}

test("sync-start marker key is scoped per source", () => {
  assert.equal(syncStartToastKey("a"), "pdpp.sources.syncStartToast.a");
  assert.equal(syncStartToastKey("b"), "pdpp.sources.syncStartToast.b");
});

test("sync-start marker is a no-op when sessionStorage is unavailable", () => {
  assert.equal(readSyncStartToast("missing"), null);
  assert.doesNotThrow(() =>
    markSyncStartToast("missing", { message: "Sync started.", runId: "run_1", tone: "info" }, 10_000)
  );
  assert.doesNotThrow(() => clearSyncStartToast("missing"));
});

test("sync-start marker round-trips while unexpired", () => {
  withFakeSessionStorage((store) => {
    const now = 1_700_000_000_000;
    const originalNow = Date.now;
    Date.now = () => now;
    try {
      markSyncStartToast("source-a", { message: "Sync started.", runId: "run_1", tone: "info" }, 15_000);
      assert.equal(store.has(syncStartToastKey("source-a")), true);
      assert.deepEqual(readSyncStartToast("source-a"), {
        expiresAt: now + 15_000,
        message: "Sync started.",
        runId: "run_1",
        tone: "info",
      });
    } finally {
      Date.now = originalNow;
    }
  });
});

test("expired or corrupt sync-start markers are cleared", () => {
  withFakeSessionStorage((store) => {
    const key = syncStartToastKey("source-a");
    store.set(key, JSON.stringify({ expiresAt: 1, message: "Sync started.", tone: "info" }));
    assert.equal(readSyncStartToast("source-a"), null);
    store.set(key, "not-json");
    assert.equal(readSyncStartToast("source-a"), null);
  });
});

test("sync-start remount dismisses using the original absolute expiry, not a fresh 15s", () => {
  withFakeSessionStorage(() => {
    const originalNow = Date.now;
    const baseNow = 1_700_000_000_000;
    Date.now = () => baseNow;
    try {
      markSyncStartToast("source-a", { message: "Sync started.", runId: "run_1", tone: "info" }, 15_000);

      Date.now = () => baseNow + 14_000;
      const restored = readSyncStartToast("source-a");
      assert.deepEqual(restored, {
        expiresAt: baseNow + 15_000,
        message: "Sync started.",
        runId: "run_1",
        tone: "info",
      });
      assert.equal(syncStartToastDismissDelayMs(restored ?? { expiresAt: baseNow + 15_000 }), 1000);

      Date.now = () => baseNow + 15_001;
      assert.equal(readSyncStartToast("source-a"), null);
    } finally {
      Date.now = originalNow;
    }
  });
});
