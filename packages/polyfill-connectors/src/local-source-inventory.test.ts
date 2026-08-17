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
  buildDerivedCoverageRecord,
  describeDerivedCoverageReason,
  expectedLocalCoverageStoreDescriptors,
  INVENTORY_FINGERPRINT_EXCLUDE_KEYS,
  LOCAL_COVERAGE_STORE_DESCRIPTORS_BY_CONNECTOR,
  localCoverageStreamsMissingDescriptors,
  openInventoryFingerprintCursor,
  parseCoverageDiagnosticsStateSnapshot,
} from "./local-source-inventory.ts";
import { readPolyfillManifests } from "./manifest-registry.ts";

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
  const { stores } = coverageState();
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
  ["missing top-level fetched_at", (({ fetched_at: _fetchedAt, ...rest }) => rest)(coverageState())],
  ["missing top-level stores", (({ stores: _stores, ...rest }) => rest)(coverageState())],
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

// ─── buildDerivedCoverageRecord / describeDerivedCoverageReason ──────────
//
// The shared mechanical policy for a "derived" stream — one parsed out of
// another, already-scanned stream's source rather than its own
// KnownLocalStore entry (Claude Code's messages/attachments/memory_notes;
// Codex's messages/function_calls). This is the single source of truth for
// the status/reason rule both connectors' `emitDerivedCoverage` call into —
// it must not be reimplemented per connector.

test("buildDerivedCoverageRecord: a completed scan with emitted records is collected, reason names the count", () => {
  const record = buildDerivedCoverageRecord({
    connectorId: "claude_code",
    emitted: 3,
    examined: 5,
    label: "message",
    scanComplete: true,
    stream: "messages",
  });
  assert.equal(record.status, "collected");
  assert.equal(record.reason, "3 message records emitted");
});

test("buildDerivedCoverageRecord: a completed scan with zero examined is collected, not missing", () => {
  const record = buildDerivedCoverageRecord({
    connectorId: "claude_code",
    emitted: 0,
    examined: 0,
    label: "message",
    scanComplete: true,
    stream: "messages",
  });
  assert.equal(record.status, "collected", "an empty-but-complete scan is collected, not missing/unaccounted");
  assert.equal(record.reason, "enumeration complete, 0 examined");
});

test("buildDerivedCoverageRecord: examined>0 but emitted=0 (fingerprint-suppressed) is still collected", () => {
  const record = buildDerivedCoverageRecord({
    connectorId: "claude_code",
    emitted: 0,
    examined: 4,
    label: "message",
    scanComplete: true,
    stream: "messages",
  });
  assert.equal(record.status, "collected");
  assert.equal(record.reason, "enumeration complete, 4 examined (0 emitted)");
});

test("buildDerivedCoverageRecord: an incomplete scan is unaccounted with a generic fallback reason", () => {
  const record = buildDerivedCoverageRecord({
    connectorId: "claude_code",
    emitted: 0,
    examined: 0,
    label: "message",
    scanComplete: false,
    stream: "messages",
  });
  assert.equal(record.status, "unaccounted");
  assert.equal(record.reason, "enumeration did not complete");
});

test("buildDerivedCoverageRecord: a connector-supplied incompleteReason overrides the generic fallback", () => {
  const record = buildDerivedCoverageRecord({
    connectorId: "codex",
    emitted: 0,
    examined: 0,
    incompleteReason: "rollout enumeration failed: parse_error",
    label: "function_call",
    scanComplete: false,
    stream: "function_calls",
  });
  assert.equal(record.status, "unaccounted");
  assert.equal(
    record.reason,
    "rollout enumeration failed: parse_error",
    "a connector's own scan-outcome detail must survive through the shared builder"
  );
});

// ─── emitter <-> authority structural link ────────────────────────────────
//
// buildDerivedCoverageRecord no longer accepts a `store`/`id` from its
// caller -- it SELECTS them from LOCAL_COVERAGE_STORE_DESCRIPTORS_BY_CONNECTOR
// via selectLocalCoverageDerivedDescriptor, keyed on (connectorId, stream).
// This closes the drift class a manifest<->descriptor conformance test alone
// cannot: a connector's derived emitter could previously hard-code a store id
// string that silently diverged from the table with no failure anywhere.
// These tests exercise the actual selection path, not a hand-supplied store.

test("buildDerivedCoverageRecord: the emitted store id is exactly what the authority table declares for this (connector, stream) pair", () => {
  for (const [connectorId, stream, expectedStore] of [
    ["claude_code", "messages", "derived_messages"],
    ["claude_code", "attachments", "derived_attachments"],
    ["claude_code", "memory_notes", "derived_memory_notes"],
    ["codex", "messages", "derived_messages"],
    ["codex", "function_calls", "derived_function_calls"],
  ] as const) {
    const record = buildDerivedCoverageRecord({
      connectorId,
      emitted: 1,
      examined: 1,
      label: "x",
      scanComplete: true,
      stream,
    });
    assert.equal(
      record.store,
      expectedStore,
      `${connectorId}/${stream}: store id must come from the authority table, not a hard-coded literal`
    );
    assert.equal(record.id, `coverage:${expectedStore}`, "record id must be derived from the selected store");
  }
});

test("buildDerivedCoverageRecord: refuses to build a record for a stream the authority table doesn't declare a descriptor for", () => {
  assert.throws(
    () =>
      buildDerivedCoverageRecord({
        connectorId: "claude_code",
        emitted: 1,
        examined: 1,
        label: "x",
        scanComplete: true,
        stream: "some_future_stream_with_no_descriptor",
      }),
    /expected exactly one descriptor/,
    "an emitter cannot fabricate coverage for a stream the shared authority has not declared -- this is the exact " +
      "structural failure mode a hard-coded store id previously allowed silently"
  );
});

test("buildDerivedCoverageRecord: refuses an ambiguous stream mapped by more than one descriptor rather than silently picking one", () => {
  // codex's `sessions` stream is deliberately declared by TWO static
  // descriptors (`sessions` and `state_db`) -- a derived-stream caller for
  // `sessions` has no single authoritative store to select and must fail
  // loud, not guess.
  assert.throws(
    () =>
      buildDerivedCoverageRecord({
        connectorId: "codex",
        emitted: 1,
        examined: 1,
        label: "x",
        scanComplete: true,
        stream: "sessions",
      }),
    /expected exactly one descriptor for derived stream 'sessions', found 2/
  );
});

test("buildDerivedCoverageRecord: refuses a connector with no authoritative descriptor table at all", () => {
  assert.throws(
    () =>
      buildDerivedCoverageRecord({
        connectorId: "some_unregistered_connector",
        emitted: 1,
        examined: 1,
        label: "x",
        scanComplete: true,
        stream: "messages",
      }),
    /no authoritative local coverage inventory/
  );
});

test("buildDerivedCoverageRecord: carries an optional scopeFingerprint as collection_scope, omits it when absent", () => {
  const withScope = buildDerivedCoverageRecord({
    connectorId: "claude_code",
    emitted: 1,
    examined: 1,
    label: "message",
    scanComplete: true,
    scopeFingerprint: "fp-abc",
    stream: "messages",
  });
  assert.equal((withScope as { collection_scope?: string }).collection_scope, "fp-abc");

  const withoutScope = buildDerivedCoverageRecord({
    connectorId: "claude_code",
    emitted: 1,
    examined: 1,
    label: "message",
    scanComplete: true,
    stream: "messages",
  });
  assert.equal(
    "collection_scope" in withoutScope,
    false,
    "an omitted scopeFingerprint must not appear as an explicit undefined key"
  );
});

test("describeDerivedCoverageReason: identical inputs from two different connectors produce the identical reason string", () => {
  // The whole point of the extraction: two connectors calling the SAME
  // function with the SAME shape must not be able to drift.
  const claudeCodeStyle = describeDerivedCoverageReason({
    emitted: 2,
    examined: 2,
    label: "message",
    scanComplete: true,
  });
  const codexStyle = describeDerivedCoverageReason({
    emitted: 2,
    examined: 2,
    label: "message",
    scanComplete: true,
  });
  assert.equal(claudeCodeStyle, codexStyle);
  assert.equal(claudeCodeStyle, "2 message records emitted");
});

// ─── descriptor-authority / manifest conformance ──────────────────────────
//
// LOCAL_COVERAGE_STORE_DESCRIPTORS_BY_CONNECTOR is "an authority shared by
// emitters and the server proof reader" (see its own doc comment above) --
// its whole reason to exist is to make a partial/drifted descriptor set
// detectable rather than silently capping a connector's provable coverage.
// These tests pin that promise directly against the connector's own shipped
// manifest, so a required stream that quietly loses its descriptor (as
// claude_code's messages/attachments/memory_notes and codex's
// messages/function_calls once did) fails CI instead of only being
// discoverable by reading a live UAT snapshot.

interface ManifestStreamEntry {
  readonly name: string;
  readonly required?: boolean;
}

interface LocalCoverageManifest {
  readonly connector_key: string;
  readonly streams: readonly ManifestStreamEntry[];
}

function isLocalCoverageManifest(manifest: unknown): manifest is LocalCoverageManifest {
  if (!manifest || typeof manifest !== "object") {
    return false;
  }
  const candidate = manifest as { connector_key?: unknown; streams?: unknown };
  return typeof candidate.connector_key === "string" && Array.isArray(candidate.streams);
}

/** Every shipped manifest that declares a descriptor-table entry for its connector key. */
function shippedManifestsWithDescriptorAuthority(): readonly LocalCoverageManifest[] {
  return readPolyfillManifests()
    .map((entry) => entry.manifest)
    .filter(isLocalCoverageManifest)
    .filter((manifest) => expectedLocalCoverageStoreDescriptors(manifest.connector_key) !== null);
}

test("every shipped manifest with a descriptor-table entry has a descriptor for each required stream", () => {
  const manifests = shippedManifestsWithDescriptorAuthority();
  // Guards the guard: if this list is empty the assertions below vacuously
  // pass without proving anything.
  assert.ok(
    manifests.some((manifest) => manifest.connector_key === "claude-code") &&
      manifests.some((manifest) => manifest.connector_key === "codex"),
    "expected the claude-code and codex manifests to be discovered under the descriptor authority"
  );

  for (const manifest of manifests) {
    const required = manifest.streams
      .filter((stream) => stream.required !== false && stream.name !== "coverage_diagnostics")
      .map((stream) => stream.name);
    const missing = localCoverageStreamsMissingDescriptors(manifest.connector_key, required);
    assert.deepEqual(
      missing,
      [],
      `${manifest.connector_key}: required manifest stream(s) [${missing.join(", ")}] have no ` +
        "LOCAL_COVERAGE_STORE_DESCRIPTORS_BY_CONNECTOR entry, so deriveLocalCoverageAxis can never " +
        "mark them complete regardless of what the connector actually collects"
    );
  }
});

test("descriptor authority carries no store whose stream is absent from its own connector's manifest", () => {
  // The inverse drift direction: a descriptor claims a stream the manifest
  // does not (or no longer) declare. Catches a stale/renamed entry the same
  // way -- e.g. a store left behind after a manifest stream rename, or a
  // synthetic store id (like the "logs" store seen live on an older codex
  // manifest_generation) that no longer corresponds to real emitter output.
  const manifests = shippedManifestsWithDescriptorAuthority();
  for (const manifest of manifests) {
    const manifestStreams = new Set(manifest.streams.map((stream) => stream.name));
    const descriptors =
      LOCAL_COVERAGE_STORE_DESCRIPTORS_BY_CONNECTOR[
        manifest.connector_key.replace(/-/g, "_") as keyof typeof LOCAL_COVERAGE_STORE_DESCRIPTORS_BY_CONNECTOR
      ];
    const orphaned = descriptors
      .filter((descriptor) => descriptor.stream !== null && !manifestStreams.has(descriptor.stream))
      .map((descriptor) => `${descriptor.store}->${descriptor.stream}`);
    assert.deepEqual(
      orphaned,
      [],
      `${manifest.connector_key}: descriptor(s) [${orphaned.join(", ")}] reference a stream the manifest does not declare`
    );
  }
});

test("coverage STATE parser tolerates an unexpected store while every expected store is present", () => {
  // A collector build older than the server reports a store the current
  // descriptor table no longer declares. It scanned MORE than asked, which
  // cannot weaken the coverage claim: the parser already excludes unexpected
  // stores from `rows`, so they can never corrupt the proof.
  //
  // Live case this reproduces: cin_ece4bfe5096b8bf67a1468c2 ("peregrine Codex")
  // reported a legacy `logs` store alongside every declared store. That single
  // extra name discarded a complete coverage proof over 1,293,596 collected
  // records and rendered the source "Not measured".
  const expected = expectedLocalCoverageStoreDescriptors("claude-code");
  assert.ok(expected);
  const parsed = parseCoverageDiagnosticsStateSnapshot("claude-code", {
    fetched_at: "2026-07-21T12:00:00.000Z",
    stores: [
      ...expected.map(({ store, stream }) => ({ status: "inventory_only" as const, store, stream })),
      { status: "inventory_only" as const, store: "logs", stream: "sessions" },
    ],
  });
  assert.equal(parsed.hasCommittedSnapshot, true);
  assert.deepEqual(parsed.unexpectedStores, ["logs"]);
  assert.equal(parsed.malformed, false);
  assert.equal(parsed.missingStores.length, 0);
  assert.equal(
    parsed.rows.some((row) => row.store === "logs"),
    false
  );
});

test("coverage STATE parser still fails closed when a required store is missing", () => {
  const expected = expectedLocalCoverageStoreDescriptors("claude-code");
  assert.ok(expected);
  const parsed = parseCoverageDiagnosticsStateSnapshot("claude-code", {
    fetched_at: "2026-07-21T12:00:00.000Z",
    stores: expected.slice(1).map(({ store, stream }) => ({ status: "inventory_only" as const, store, stream })),
  });
  assert.equal(parsed.hasCommittedSnapshot, false);
  assert.equal(parsed.missingStores.length, 1);
});
