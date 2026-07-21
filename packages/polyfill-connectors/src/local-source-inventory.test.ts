// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Focused tests for the inventory-record churn gate. An `inventory_only`
// record exists to answer the local-agent-collector completeness contract
// ("this store exists, here is its path/type/classification/reason"). The
// volatile `mtime_epoch`/`size_bytes` file-stat fields tick on every normal
// tool write and must NOT re-version an otherwise-unchanged metadata record.
//
// These tests pin the gate's exact boundary:
//   1. a pure mtime/size tick is a no-op emit;
//   2. a real inventory transition (type/path/classification/reason) re-emits;
//   3. STATE carry-forward survives a skipped record;
//   4. a store that disappears is pruned so its re-appearance re-emits.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCoverageDiagnosticsStateSnapshot,
  expectedLocalCoverageStoreDescriptors,
  INVENTORY_FINGERPRINT_EXCLUDE_KEYS,
  openInventoryFingerprintCursor,
  parseCoverageDiagnosticsStateSnapshot,
} from "./local-source-inventory.ts";

function inventoryRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "backups:abc123",
    store: "backups",
    relative_path: "backups",
    path_hash: "abc123",
    type: "directory",
    size_bytes: null,
    mtime_epoch: 1_717_000_000,
    classification: "inventory_only",
    reason: "backup payloads require owner review before collection",
    ...over,
  };
}

test("excluded keys are exactly mtime_epoch and size_bytes", () => {
  assert.deepEqual([...INVENTORY_FINGERPRINT_EXCLUDE_KEYS], ["mtime_epoch", "size_bytes"]);
});

function coverageState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const expected = expectedLocalCoverageStoreDescriptors("claude-code");
  assert.ok(expected);
  return {
    fetched_at: "2026-07-21T12:00:00.000Z",
    stores: expected.map(({ store, stream }) => ({ store, stream, status: "inventory_only" })),
    ...overrides,
  };
}

function coverageStores(): Record<string, unknown>[] {
  const stores = coverageState().stores;
  assert.ok(Array.isArray(stores));
  return stores as Record<string, unknown>[];
}

test("coverage STATE parser accepts the exact sanitized producer schema", () => {
  const expected = expectedLocalCoverageStoreDescriptors("claude-code");
  assert.ok(expected);
  const snapshot = buildCoverageDiagnosticsStateSnapshot(
    expected.map(({ store, stream }) => ({
      id: `coverage:${store}`,
      reason: "producer-only metadata",
      status: "inventory_only" as const,
      store,
      stream,
    }))
  );
  const parsed = parseCoverageDiagnosticsStateSnapshot("claude-code", {
    fetched_at: "2026-07-21T12:00:00.000Z",
    stores: snapshot,
  });
  assert.equal(parsed.hasCommittedSnapshot, true);
  assert.equal(parsed.malformed, false);
  assert.deepEqual(
    parsed.rows,
    [...snapshot].sort((left, right) => left.store.localeCompare(right.store))
  );
});

for (const [name, state] of [
  ["private top-level field", coverageState({ secret_path: "/private/home" })],
  ["future top-level version", coverageState({ version: 2 })],
  ["missing top-level fetched_at", (({ fetched_at: _fetchedAt, ...state }) => state)(coverageState())],
  ["missing top-level stores", (({ stores: _stores, ...state }) => state)(coverageState())],
  ["missing fetched_at", coverageState({ fetched_at: undefined })],
  ["malformed fetched_at", coverageState({ fetched_at: "not-a-timestamp" })],
  [
    "private tuple field",
    coverageState({
      stores: [{ ...coverageStores()[0], secret_path: "/private/home" }, ...coverageStores().slice(1)],
    }),
  ],
  [
    "conflicting tuple stream",
    coverageState({
      stores: [{ ...coverageStores()[0], stream: "conflicting" }, ...coverageStores().slice(1)],
    }),
  ],
  [
    "duplicate tuple",
    coverageState({
      stores: [...coverageStores(), coverageStores()[0]],
    }),
  ],
] as const) {
  test(`coverage STATE parser rejects ${name} fail closed without echoing private values`, () => {
    const parsed = parseCoverageDiagnosticsStateSnapshot("claude-code", state);
    assert.equal(parsed.hasCommittedSnapshot, false);
    assert.equal(parsed.malformed || parsed.duplicateStores.length > 0, true);
    assert.equal(JSON.stringify(parsed).includes("/private/home"), false);
  });
}

test("mtime-only tick on a directory inventory record is a no-op emit", () => {
  const run1 = openInventoryFingerprintCursor(undefined);
  assert.equal(run1.shouldEmit(inventoryRecord()), true, "first run emits the record");
  const state = { fingerprints: run1.toState() };

  // Backup directory's mtime ticks because a new backup was written, but the
  // inventory meaning (the directory still exists, same path, same class) is
  // unchanged. Must not re-version.
  const run2 = openInventoryFingerprintCursor(state);
  assert.equal(
    run2.shouldEmit(inventoryRecord({ mtime_epoch: 1_717_009_999 })),
    false,
    "a pure mtime tick must not re-emit"
  );
});

test("size-only growth on a file inventory record is a no-op emit", () => {
  const fileRecord = (size: number, mtime: number): Record<string, unknown> =>
    inventoryRecord({
      id: "history:def456",
      store: "history",
      relative_path: "history.jsonl",
      path_hash: "def456",
      type: "file",
      size_bytes: size,
      mtime_epoch: mtime,
      reason: "metadata-only until prompt-history payload contract is approved",
    });

  const run1 = openInventoryFingerprintCursor(undefined);
  assert.equal(run1.shouldEmit(fileRecord(1024, 1_717_000_000)), true);
  const state = { fingerprints: run1.toState() };

  // history.jsonl grew (codex appended a line) — size_bytes and mtime both
  // move, but it is still the same inventory-only store. No re-version.
  const run2 = openInventoryFingerprintCursor(state);
  assert.equal(run2.shouldEmit(fileRecord(2048, 1_717_009_999)), false, "size growth + mtime tick must not re-emit");
});

test("a real inventory transition (type change) re-emits", () => {
  const run1 = openInventoryFingerprintCursor(undefined);
  assert.equal(run1.shouldEmit(inventoryRecord()), true);
  const state = { fingerprints: run1.toState() };

  // The store changed shape on disk: what was a directory is now a file. That
  // is a meaningful inventory transition and must re-version.
  const run2 = openInventoryFingerprintCursor(state);
  assert.equal(
    run2.shouldEmit(inventoryRecord({ type: "file", size_bytes: 99, mtime_epoch: 1_717_009_999 })),
    true,
    "a type change must re-emit even alongside a mtime tick"
  );
});

test("a classification change re-emits", () => {
  const run1 = openInventoryFingerprintCursor(undefined);
  assert.equal(run1.shouldEmit(inventoryRecord()), true);
  const state = { fingerprints: run1.toState() };

  const run2 = openInventoryFingerprintCursor(state);
  assert.equal(
    run2.shouldEmit(inventoryRecord({ classification: "defer", mtime_epoch: 1_717_009_999 })),
    true,
    "a privacy-classification change must re-emit"
  );
});

test("skipped record carries its fingerprint forward into the next STATE", () => {
  const run1 = openInventoryFingerprintCursor(undefined);
  run1.shouldEmit(inventoryRecord());
  const state1 = { fingerprints: run1.toState() };

  // Run 2: same record, only mtime moved → skipped. The fingerprint must
  // still survive into STATE so run 3 also skips it (no re-emit churn).
  const run2 = openInventoryFingerprintCursor(state1);
  assert.equal(run2.shouldEmit(inventoryRecord({ mtime_epoch: 1_717_009_999 })), false);
  const state2 = { fingerprints: run2.toState() };
  assert.deepEqual(state2.fingerprints, state1.fingerprints, "skipped record's fingerprint is carried forward");

  const run3 = openInventoryFingerprintCursor(state2);
  assert.equal(run3.shouldEmit(inventoryRecord({ mtime_epoch: 1_717_020_000 })), false, "still a no-op on run 3");
});

test("a store that disappears is pruned and re-emits on re-appearance", () => {
  const run1 = openInventoryFingerprintCursor(undefined);
  run1.shouldEmit(inventoryRecord());
  run1.pruneStale();
  const state1 = { fingerprints: run1.toState() };
  assert.ok("backups:abc123" in state1.fingerprints, "present store stays in cursor");

  // Run 2: the backups store is gone this run (not observed). Full-scan prune
  // drops it from the cursor.
  const run2 = openInventoryFingerprintCursor(state1);
  run2.pruneStale();
  const state2 = { fingerprints: run2.toState() };
  assert.equal(Object.keys(state2.fingerprints).length, 0, "absent store is pruned");

  // Run 3: the store re-appears with the same content. Because the prior
  // fingerprint was pruned, it re-emits (does not stay gated as a no-op).
  const run3 = openInventoryFingerprintCursor(state2);
  assert.equal(run3.shouldEmit(inventoryRecord()), true, "re-appeared store re-emits");
});

test("legacy cursor (no fingerprints field) re-emits everything once", () => {
  // A pre-gate STATE cursor shape — only { fetched_at } — must not throw and
  // must re-emit every record exactly once so the gate self-heals.
  const cursor = openInventoryFingerprintCursor({ fetched_at: "2026-06-01T00:00:00Z" });
  assert.equal(cursor.shouldEmit(inventoryRecord()), true, "legacy cursor re-emits");
});
