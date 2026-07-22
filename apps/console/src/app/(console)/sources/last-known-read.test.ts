// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the client-side last-known-good read marker.
 *
 * This is the bridge that lets the records error boundary say "showing
 * last-known status from <ts>" without a server read. The tests pin three
 * properties that keep it safe to call from a render path:
 *   1. round-trip — a stamped time reads back;
 *   2. SSR/no-storage safety — both helpers no-op/return null without throwing
 *      when `sessionStorage` is unavailable (the node default here);
 *   3. corruption safety — a non-numeric / negative stored value reads as null,
 *      never a bogus timestamp.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { markRecordsReadFresh, readLastRecordsReadAt } from "./last-known-read.ts";

const STORAGE_KEY = "pdpp.records.lastGoodReadAt";

/** Install a minimal in-memory `window.sessionStorage` for a test. */
function withFakeSessionStorage(run: (store: Map<string, string>) => void): void {
  const store = new Map<string, string>();
  const fakeWindow = {
    sessionStorage: {
      getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    },
  };
  const g = globalThis as unknown as { window?: unknown };
  const prev = g.window;
  g.window = fakeWindow;
  try {
    run(store);
  } finally {
    // Restore (or clear) the prior global. Assign rather than `delete` so the
    // marker's `typeof window` SSR guard still reads `undefined` afterwards.
    g.window = prev;
  }
}

test("no sessionStorage (SSR/node): mark is a no-op and read returns null without throwing", () => {
  // No `window` in node by default.
  assert.equal(readLastRecordsReadAt(), null);
  assert.doesNotThrow(() => markRecordsReadFresh(123));
  assert.equal(readLastRecordsReadAt(), null);
});

test("round-trips a stamped timestamp through sessionStorage", () => {
  withFakeSessionStorage(() => {
    markRecordsReadFresh(1_700_000_000_000);
    assert.equal(readLastRecordsReadAt(), 1_700_000_000_000);
  });
});

test("the latest stamp wins", () => {
  withFakeSessionStorage(() => {
    markRecordsReadFresh(1000);
    markRecordsReadFresh(2000);
    assert.equal(readLastRecordsReadAt(), 2000);
  });
});

test("a corrupt or non-positive stored value reads back as null, never a bogus time", () => {
  withFakeSessionStorage((store) => {
    store.set(STORAGE_KEY, "not-a-number");
    assert.equal(readLastRecordsReadAt(), null);
    store.set(STORAGE_KEY, "0");
    assert.equal(readLastRecordsReadAt(), null);
    store.set(STORAGE_KEY, "-5");
    assert.equal(readLastRecordsReadAt(), null);
  });
});
