// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.js";
import { closePostgresStorage, initPostgresStorage } from "../server/postgres-storage.js";
import {
  createPostgresBrowserSurfaceReplacementReceiptStore,
  createSqliteBrowserSurfaceReplacementReceiptStore,
  POSTGRES_BROWSER_SURFACE_REPLACEMENT_LEDGER_SCHEMA,
  SQLITE_BROWSER_SURFACE_REPLACEMENT_LEDGER_SCHEMA,
} from "../server/stores/browser-surface-replacement-ledger-store.ts";
import {
  createBrowserSurfaceReplacementLedger,
  deriveOpaqueGenerationHash,
  ReplacementReplayConflictError,
} from "../runtime/browser-surface/replacement-receipt-ledger.ts";

const NOW = "2026-07-16T12:00:00.000Z";
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

function receiptSequence(connectionId, subjectId) {
  const ledger = createBrowserSurfaceReplacementLedger({ now: () => NOW, idPrefix: "store-test" });
  const started = ledger.start({
    idempotency_key: `start:${connectionId}`,
    connection_id: connectionId,
    connector_id: "chatgpt",
    profile_key: "shared-profile",
    surface_subject_id: subjectId,
    surface_id: `${connectionId}:surface`,
    previous_generation_hash: deriveOpaqueGenerationHash(`${connectionId}:container-old`),
    cause: "allocator_internal_ensure_surface",
    observed_at: NOW,
  });
  const completed = ledger.complete({
    replacement_id: started.replacement_id,
    connection_id: connectionId,
    profile_key: started.profile_key,
    surface_subject_id: subjectId,
    surface_id: started.surface_id,
    next_generation_hash: deriveOpaqueGenerationHash(`${connectionId}:container-new`),
    cause: started.cause,
    observed_at: NOW,
  });
  return { started, completed };
}

async function assertStoreContract(store) {
  const namespace = `store-contract-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const id = (value) => `${namespace}:${value}`;
  const first = receiptSequence(id("connection-a"), id("subject-a"));
  const second = receiptSequence(id("connection-b"), id("subject-b"));
  const storedStart = await store.append(first.started);
  const replayedStart = await store.append(first.started);
  const storedCompletion = await store.append(first.completed);
  await store.append(second.started);
  const concurrentReplays = await Promise.all(
    Array.from({ length: 8 }, () => store.append(first.started)),
  );

  assert.deepEqual(
    concurrentReplays.map((row) => row.event_seq),
    Array.from({ length: 8 }, () => storedStart.event_seq),
    "concurrent exact replays return the authoritative store sequence",
  );
  await assert.rejects(
    () => store.append({ ...first.started, cause: "idle_ttl" }),
    ReplacementReplayConflictError,
    "same idempotency/phase cannot be reused with a different immutable event",
  );
  await assert.rejects(
    () => store.append({ ...first.started, idempotency_key: "different-start-key" }),
    ReplacementReplayConflictError,
    "same replacement/phase cannot be reused with a different immutable event",
  );

  assert.equal(storedStart.phase, "started");
  assert.equal(storedCompletion.phase, "completed");
  assert.equal(replayedStart.event_seq, storedStart.event_seq, "same phase replay is idempotent");
  assert.ok(storedCompletion.event_seq > storedStart.event_seq, "completion is an append-only second row");

  const rows = await store.list();
  assert.deepEqual(rows.slice(0, 2).map((row) => row.phase), ["started", "completed"]);
  assert.deepEqual(
    rows.map((row) => row.event_seq),
    [...rows].sort((left, right) => left.event_seq - right.event_seq).map((row) => row.event_seq),
  );
  assert.equal(
    await store.selectCurrent({ connection_id: id("connection-a"), surface_subject_id: id("subject-a") }),
    null,
    "completed receipt needs an independently observed current generation",
  );
  assert.equal(
    (await store.selectCurrent({
      connection_id: id("connection-a"),
      surface_subject_id: id("subject-a"),
      current_generation_hash: storedCompletion.next_generation_hash,
    }))?.replacement_id,
    storedCompletion.replacement_id,
  );
  assert.equal(
    await store.selectCurrent({
      connection_id: id("connection-a"),
      surface_subject_id: id("subject-a"),
      current_generation_hash: deriveOpaqueGenerationHash("unrelated-current-generation"),
    }),
    null,
  );
  assert.equal(
    (await store.selectCurrent({
      connection_id: id("connection-b"),
      surface_subject_id: id("subject-b"),
    }))?.phase,
    "started",
    "a pending receipt remains current without a generation match",
  );
  const pendingBeforeRestart = await store.findPendingForSurface(second.started.surface_id);
  assert.equal(pendingBeforeRestart?.replacement_id, second.started.replacement_id, "pending lookup is durable and surface-scoped");
  assert.equal(pendingBeforeRestart?.phase, "started");

  const scoped = receiptSequence(id("connection-scope"), id("subject-scope"));
  const oldSurfacePending = { ...scoped.started, surface_id: id("surface-retired") };
  const authoritativeScopedPending = await store.append(oldSurfacePending);
  assert.equal(
    (await store.findPendingForScope({
      connection_id: id("connection-scope"),
      surface_subject_id: id("subject-scope"),
      profile_key: "shared-profile",
      preferred_surface_id: id("surface-new"),
    }))?.replacement_id,
    authoritativeScopedPending.replacement_id,
    "scope lookup finds a pending receipt across a retired surface id",
  );
  assert.equal(
    await store.findPendingForScope({
      connection_id: id("connection-scope"),
      surface_subject_id: null,
      profile_key: "shared-profile",
    }),
    null,
    "nullable surface subject is an exact scope key",
  );
  assert.equal(
    await store.findPendingForScope({
      connection_id: id("other-connection"),
      surface_subject_id: id("subject-scope"),
      profile_key: "shared-profile",
    }),
    null,
    "connection is an exact scope key",
  );
  assert.equal(
    await store.findPendingForScope({
      connection_id: id("connection-scope"),
      surface_subject_id: id("subject-scope"),
      profile_key: "other-profile",
    }),
    null,
    "profile is an exact scope key",
  );
  const restartedLedger = createBrowserSurfaceReplacementLedger({ now: () => NOW, idPrefix: "restarted" });
  const pending = pendingBeforeRestart;
  restartedLedger.hydrate(pending ? [pending] : []);
  const restartedCompletion = restartedLedger.complete({
    replacement_id: second.started.replacement_id,
    connection_id: second.started.connection_id,
    profile_key: second.started.profile_key,
    ...(second.started.surface_subject_id ? { surface_subject_id: second.started.surface_subject_id } : {}),
    ...(second.started.surface_id ? { surface_id: second.started.surface_id } : {}),
    next_generation_hash: deriveOpaqueGenerationHash(id("connection-b:browser-process-new")),
    cause: second.started.cause,
  });
  const authoritativeRestartedCompletion = await store.append(restartedCompletion);
  assert.equal(authoritativeRestartedCompletion.cause, second.started.cause);
  assert.equal(
    await store.findPendingForSurface(second.started.surface_id),
    null,
    "completion closes the durable pending replacement",
  );
  assert.equal(
    (await store.selectCurrent({
      connection_id: id("connection-b"),
      surface_subject_id: id("subject-b"),
      current_generation_hash: authoritativeRestartedCompletion.next_generation_hash,
    }))?.replacement_id,
    second.started.replacement_id,
  );

  const selectionLedger = createBrowserSurfaceReplacementLedger({ now: () => NOW, idPrefix: "selection-test" });
  const olderPending = selectionLedger.start({
    idempotency_key: id("selection-older-pending"),
    connection_id: id("connection-selection"),
    profile_key: id("selection-profile"),
    surface_subject_id: id("subject-selection"),
    surface_id: id("surface-old"),
    cause: "idle_ttl",
    observed_at: NOW,
  });
  await store.append(olderPending);
  const newerStarted = selectionLedger.start({
    idempotency_key: id("selection-newer-completed"),
    connection_id: olderPending.connection_id,
    profile_key: olderPending.profile_key,
    surface_subject_id: olderPending.surface_subject_id,
    surface_id: id("surface-new"),
    cause: "operator_requested",
    observed_at: NOW,
  });
  const newerCompleted = selectionLedger.complete({
    replacement_id: newerStarted.replacement_id,
    connection_id: newerStarted.connection_id,
    profile_key: newerStarted.profile_key,
    surface_subject_id: newerStarted.surface_subject_id,
    surface_id: newerStarted.surface_id,
    cause: newerStarted.cause,
    next_generation_hash: "b".repeat(64),
    observed_at: NOW,
  });
  await store.append(newerStarted);
  await store.append(newerCompleted);
  assert.equal(
    await store.selectCurrent({
      connection_id: olderPending.connection_id,
      surface_subject_id: olderPending.surface_subject_id,
      current_generation_hash: "c".repeat(64),
    }),
    null,
    "a newer completed mismatch cannot revive an older pending boundary",
  );

  const newestTerminalStarted = selectionLedger.start({
    idempotency_key: id("selection-newest-terminal"),
    connection_id: olderPending.connection_id,
    profile_key: olderPending.profile_key,
    surface_subject_id: olderPending.surface_subject_id,
    surface_id: id("surface-terminal"),
    cause: "readiness_invalidated",
    observed_at: NOW,
  });
  await store.append(newestTerminalStarted);
  await store.append(terminalReceipt(newestTerminalStarted));
  assert.equal(
    await store.selectCurrent({
      connection_id: olderPending.connection_id,
      surface_subject_id: olderPending.surface_subject_id,
      current_generation_hash: newerCompleted.next_generation_hash,
    }),
    null,
    "a newer terminal boundary cannot revive an older completed generation",
  );

  const interleavingLedger = createBrowserSurfaceReplacementLedger({ now: () => NOW, idPrefix: "interleaving-test" });
  const interleavedFirst = interleavingLedger.start({
    idempotency_key: id("interleaving-first"),
    connection_id: id("connection-interleaving"),
    profile_key: id("interleaving-profile"),
    surface_subject_id: id("subject-interleaving"),
    surface_id: id("surface-interleaving-first"),
    cause: "idle_ttl",
    observed_at: NOW,
  });
  const interleavedSecond = interleavingLedger.start({
    idempotency_key: id("interleaving-second"),
    connection_id: interleavedFirst.connection_id,
    profile_key: interleavedFirst.profile_key,
    surface_subject_id: interleavedFirst.surface_subject_id,
    surface_id: id("surface-interleaving-second"),
    cause: "operator_requested",
    observed_at: NOW,
  });
  const interleavedFirstCompleted = interleavingLedger.complete({
    replacement_id: interleavedFirst.replacement_id,
    connection_id: interleavedFirst.connection_id,
    profile_key: interleavedFirst.profile_key,
    surface_subject_id: interleavedFirst.surface_subject_id,
    surface_id: interleavedFirst.surface_id,
    cause: interleavedFirst.cause,
    next_generation_hash: "a".repeat(64),
    observed_at: NOW,
  });
  await store.append(interleavedFirst);
  await store.append(interleavedSecond);
  await store.append(interleavedFirstCompleted);
  assert.equal(
    (await store.selectCurrent({
      connection_id: interleavedFirst.connection_id,
      surface_subject_id: interleavedFirst.surface_subject_id,
      current_generation_hash: interleavedFirstCompleted.next_generation_hash,
    }))?.replacement_id,
    interleavedSecond.replacement_id,
    "SQLite keeps the newest started boundary current across interleaved completion events",
  );

  const resolutionRace = receiptSequence(id("connection-resolution-race"), id("subject-resolution-race"));
  await store.append(resolutionRace.started);
  await store.append(resolutionRace.completed);
  await assert.rejects(
    () => store.append({
      ...resolutionRace.started,
      idempotency_key: id("resolution-race-terminal-after-complete"),
      phase: "terminal",
      terminal_outcome: "failed",
    }),
    ReplacementReplayConflictError,
    "a completed receipt is final and cannot gain a terminal row",
  );

  const terminalFirst = receiptSequence(id("connection-terminal-first"), id("subject-terminal-first"));
  await store.append(terminalReceipt(terminalFirst.started));
  await assert.rejects(
    () => store.append(terminalFirst.completed),
    ReplacementReplayConflictError,
    "a terminal receipt is final and cannot gain a completed row",
  );
}

function terminalReceipt(started) {
  return {
    ...started,
    event_seq: started.event_seq + 1000,
    idempotency_key: `${started.idempotency_key}:terminal`,
    phase: "terminal",
    terminal_outcome: "failed",
  };
}

function rowFromReceipt(receipt) {
  return {
    ...receipt,
    connector_id: receipt.connector_id ?? null,
    surface_subject_id: receipt.surface_subject_id ?? null,
    run_id: receipt.run_id ?? null,
    lease_id: receipt.lease_id ?? null,
    surface_id: receipt.surface_id ?? null,
    previous_generation_hash: receipt.previous_generation_hash ?? null,
    next_generation_hash: receipt.next_generation_hash ?? null,
    terminal_outcome: receipt.terminal_outcome ?? null,
  };
}

test("SQLite replacement ledger is append-only, redacted, idempotent, and generation-scoped", async () => {
  initDb();
  try {
    await assertStoreContract(createSqliteBrowserSurfaceReplacementReceiptStore());
    const columns = getDb()
      .prepare("PRAGMA table_info(browser_surface_replacement_receipts)")
      .all()
      .map((row) => row.name);
    assert.equal(columns.includes("container_id"), false);
    assert.equal(columns.includes("cdp_url"), false);
    assert.equal(columns.includes("websocket_url"), false);
    assert.match(SQLITE_BROWSER_SURFACE_REPLACEMENT_LEDGER_SCHEMA, /CREATE UNIQUE INDEX IF NOT EXISTS .*one_resolution/);
  } finally {
    closeDb();
  }
});

test("SQLite scoped pending lookup survives a store/controller restart", async () => {
  const directory = mkdtempSync("/tmp/pdpp-replacement-ledger-restart-");
  const databasePath = join(directory, "ledger.sqlite");
  const pending = receiptSequence("connection-restart-scope", "subject-restart-scope").started;
  try {
    initDb(databasePath);
    await createSqliteBrowserSurfaceReplacementReceiptStore().append({ ...pending, surface_id: "surface-retired" });
    closeDb();
    initDb(databasePath);
    const afterRestart = await createSqliteBrowserSurfaceReplacementReceiptStore().findPendingForScope({
      connection_id: pending.connection_id,
      surface_subject_id: pending.surface_subject_id,
      profile_key: pending.profile_key,
      preferred_surface_id: "surface-new",
    });
    assert.equal(afterRestart?.replacement_id, pending.replacement_id);
    assert.equal(afterRestart?.surface_id, "surface-retired");
  } finally {
    closeDb();
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "Postgres replacement ledger matches SQLite append/order/selection contract",
  { skip: !POSTGRES_URL },
  async () => {
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      await assertStoreContract(createPostgresBrowserSurfaceReplacementReceiptStore());
    } finally {
      await closePostgresStorage();
    }
  },
);

test("injectable Postgres append rereads a concurrent opposite resolution", async () => {
  const { started, completed } = receiptSequence("connection-pg-race", "subject-pg-race");
  const terminal = terminalReceipt(started);
  let initialResolutionRead = true;
  const query = async (sql) => {
    if (sql.startsWith("INSERT INTO")) return { rows: [] };
    if (sql.includes("ORDER BY event_seq DESC LIMIT 1")) return { rows: [rowFromReceipt(started)] };
    if (sql.includes("idempotency_key")) {
      if (initialResolutionRead) {
        initialResolutionRead = false;
        return { rows: [] };
      }
      return { rows: [rowFromReceipt(terminal)] };
    }
    throw new Error(`unexpected injectable Postgres query: ${sql}`);
  };
  const store = createPostgresBrowserSurfaceReplacementReceiptStore(query);
  await assert.rejects(
    () => store.append(completed),
    ReplacementReplayConflictError,
    "a concurrent terminal winner is reported as a deterministic replay conflict",
  );
  assert.match(POSTGRES_BROWSER_SURFACE_REPLACEMENT_LEDGER_SCHEMA, /CREATE UNIQUE INDEX IF NOT EXISTS .*one_resolution/);
});

test("Postgres replacement scope contains no NUL byte", async () => {
  const { started } = receiptSequence("connection-pg-nul", "subject-pg-nul");
  let insertValues;
  const query = async (sql, values) => {
    if (sql.startsWith("INSERT INTO")) {
      insertValues = values;
      return { rows: [rowFromReceipt(started)] };
    }
    return { rows: [] };
  };

  await createPostgresBrowserSurfaceReplacementReceiptStore(query).append(started);

  assert.equal(insertValues[2], JSON.stringify(["connection-pg-nul", "subject-pg-nul"]));
  assert.equal(insertValues[2].includes("\0"), false);
});

test("injectable Postgres scoped pending lookup preserves exact nullable scope", async () => {
  const pending = receiptSequence("connection-pg-scope", "subject-pg-scope").started;
  let captured;
  const query = async (sql, values) => {
    captured = { sql, values };
    return { rows: [rowFromReceipt({ ...pending, surface_id: "surface-retired" })] };
  };
  const store = createPostgresBrowserSurfaceReplacementReceiptStore(query);
  const result = await store.findPendingForScope({
    connection_id: pending.connection_id,
    surface_subject_id: pending.surface_subject_id,
    profile_key: pending.profile_key,
    preferred_surface_id: "surface-new",
  });
  assert.equal(result?.surface_id, "surface-retired");
  assert.match(captured.sql, /surface_subject_id IS NOT DISTINCT FROM/);
  assert.match(captured.sql, /profile_key = \$3/);
  assert.deepEqual(captured.values, ["connection-pg-scope", "subject-pg-scope", "shared-profile", "surface-new"]);
});
