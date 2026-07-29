const TOP_LEVEL_REGEX_1 = /CREATE UNIQUE INDEX IF NOT EXISTS .*one_resolution/;
const TOP_LEVEL_REGEX_2 = /CREATE UNIQUE INDEX IF NOT EXISTS .*one_resolution/;
const TOP_LEVEL_REGEX_3 = /surface_subject_id IS NOT DISTINCT FROM/;
const TOP_LEVEL_REGEX_4 = /profile_key = \$3/;
const SELECTION_OVERRIDE_ERROR = /selection override requires/;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  createBrowserSurfaceReplacementLedger,
  deriveOpaqueGenerationHash,
  type ReplacementCompletionInput,
  type ReplacementReceipt,
  ReplacementReplayConflictError,
  type ReplacementStartInput,
} from "../runtime/browser-surface/replacement-receipt-ledger.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage } from "../server/postgres-storage.ts";
import {
  type BrowserSurfaceReplacementReceiptStore,
  createPostgresBrowserSurfaceReplacementReceiptStore,
  createSqliteBrowserSurfaceReplacementReceiptStore,
  POSTGRES_BROWSER_SURFACE_REPLACEMENT_LEDGER_SCHEMA,
  SQLITE_BROWSER_SURFACE_REPLACEMENT_LEDGER_SCHEMA,
} from "../server/stores/browser-surface-replacement-ledger-store.ts";

const NOW = "2026-07-16T12:00:00.000Z";
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

interface SelectCurrentInput {
  readonly connection_id: string;
  readonly current_generation_hash?: string;
  readonly surface_subject_id?: string;
}

type Overrides<T> = { [K in keyof T]?: T[K] | undefined };

// Under exactOptionalPropertyTypes, an object literal with `key: undefined`
// cannot be assigned to a target whose `key?: T` is optional-but-absent —
// this drops any key whose value is `undefined` so the object satisfies that
// invariant, matching what these tests actually intend ("no override" for
// that field), not a suppression of a real error. The target type `T` is
// given explicitly at each call site (e.g. `omitUndefined<Target>(...)`)
// rather than inferred, since inferring from the input would just echo back
// the same "may be undefined" shape this exists to strip.
function omitUndefined<T extends object>(value: Overrides<T>): T {
  const result = {} as T;
  for (const key of Object.keys(value) as (keyof T)[]) {
    const propertyValue = value[key];
    if (propertyValue !== undefined) {
      result[key] = propertyValue;
    }
  }
  return result;
}

function mustExist<T>(value: T | null | undefined, description: string): T {
  assert.ok(value, description);
  return value;
}

function typedDb(): ReturnType<typeof getDb> {
  return getDb();
}

function receiptSequence(connectionId: string, subjectId: string) {
  const ledger = createBrowserSurfaceReplacementLedger({ idPrefix: "store-test", now: () => NOW });
  const started = ledger.start({
    cause: "allocator_internal_ensure_surface",
    connection_id: connectionId,
    connector_id: "chatgpt",
    idempotency_key: `start:${connectionId}`,
    observed_at: NOW,
    previous_generation_hash: deriveOpaqueGenerationHash(`${connectionId}:container-old`),
    profile_key: "shared-profile",
    surface_id: `${connectionId}:surface`,
    surface_subject_id: subjectId,
  });
  const completed = ledger.complete(
    omitUndefined<ReplacementCompletionInput>({
      cause: started.cause,
      connection_id: connectionId,
      next_generation_hash: deriveOpaqueGenerationHash(`${connectionId}:container-new`),
      observed_at: NOW,
      profile_key: started.profile_key,
      replacement_id: started.replacement_id,
      surface_id: started.surface_id,
      surface_subject_id: subjectId,
    })
  );
  return { completed, started };
}

async function assertStoreContract(store: BrowserSurfaceReplacementReceiptStore) {
  const namespace = `store-contract-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const id = (value: string) => `${namespace}:${value}`;
  const first = receiptSequence(id("connection-a"), id("subject-a"));
  const second = receiptSequence(id("connection-b"), id("subject-b"));
  const storedStart = await store.append(first.started);
  const replayedStart = await store.append(first.started);
  const storedCompletion = await store.append(first.completed);
  await store.append(second.started);
  const concurrentReplays = await Promise.all(Array.from({ length: 8 }, () => store.append(first.started)));

  assert.deepEqual(
    concurrentReplays.map((row) => row.event_seq),
    Array.from({ length: 8 }, () => storedStart.event_seq),
    "concurrent exact replays return the authoritative store sequence"
  );
  await assert.rejects(
    () => store.append({ ...first.started, cause: "idle_ttl" }),
    ReplacementReplayConflictError,
    "same idempotency/phase cannot be reused with a different immutable event"
  );
  await assert.rejects(
    () => store.append({ ...first.started, idempotency_key: "different-start-key" }),
    ReplacementReplayConflictError,
    "same replacement/phase cannot be reused with a different immutable event"
  );

  assert.equal(storedStart.phase, "started");
  assert.equal(storedCompletion.phase, "completed");
  assert.equal(replayedStart.event_seq, storedStart.event_seq, "same phase replay is idempotent");
  assert.ok(storedCompletion.event_seq > storedStart.event_seq, "completion is an append-only second row");

  const rows = await store.list();
  assert.deepEqual(
    rows.slice(0, 2).map((row) => row.phase),
    ["started", "completed"]
  );
  assert.deepEqual(
    rows.map((row) => row.event_seq),
    [...rows].sort((left, right) => left.event_seq - right.event_seq).map((row) => row.event_seq)
  );
  assert.equal(
    await store.selectCurrent({ connection_id: id("connection-a"), surface_subject_id: id("subject-a") }),
    null,
    "completed receipt needs an independently observed current generation"
  );
  assert.equal(
    (
      await store.selectCurrent(
        omitUndefined<SelectCurrentInput>({
          connection_id: id("connection-a"),
          current_generation_hash: storedCompletion.next_generation_hash,
          surface_subject_id: id("subject-a"),
        })
      )
    )?.replacement_id,
    storedCompletion.replacement_id
  );
  assert.equal(
    await store.selectCurrent({
      connection_id: id("connection-a"),
      current_generation_hash: deriveOpaqueGenerationHash("unrelated-current-generation"),
      surface_subject_id: id("subject-a"),
    }),
    null
  );
  assert.equal(
    (
      await store.selectCurrent({
        connection_id: id("connection-b"),
        surface_subject_id: id("subject-b"),
      })
    )?.phase,
    "started",
    "a pending receipt remains current without a generation match"
  );
  const pendingBeforeRestart = await store.findPendingForSurface(
    mustExist(second.started.surface_id, "second lease has a surface_id")
  );
  assert.equal(
    pendingBeforeRestart?.replacement_id,
    second.started.replacement_id,
    "pending lookup is durable and surface-scoped"
  );
  assert.equal(pendingBeforeRestart?.phase, "started");

  const scoped = receiptSequence(id("connection-scope"), id("subject-scope"));
  const oldSurfacePending = { ...scoped.started, surface_id: id("surface-retired") };
  const authoritativeScopedPending = await store.append(oldSurfacePending);
  assert.equal(
    (
      await store.findPendingForScope({
        connection_id: id("connection-scope"),
        preferred_surface_id: id("surface-new"),
        profile_key: "shared-profile",
        surface_subject_id: id("subject-scope"),
      })
    )?.replacement_id,
    authoritativeScopedPending.replacement_id,
    "scope lookup finds a pending receipt across a retired surface id"
  );
  assert.equal(
    await store.findPendingForScope({
      connection_id: id("connection-scope"),
      profile_key: "shared-profile",
      surface_subject_id: null,
    }),
    null,
    "nullable surface subject is an exact scope key"
  );
  assert.equal(
    await store.findPendingForScope({
      connection_id: id("other-connection"),
      profile_key: "shared-profile",
      surface_subject_id: id("subject-scope"),
    }),
    null,
    "connection is an exact scope key"
  );
  assert.equal(
    await store.findPendingForScope({
      connection_id: id("connection-scope"),
      profile_key: "other-profile",
      surface_subject_id: id("subject-scope"),
    }),
    null,
    "profile is an exact scope key"
  );
  const restartedLedger = createBrowserSurfaceReplacementLedger({ idPrefix: "restarted", now: () => NOW });
  const pending = pendingBeforeRestart;
  restartedLedger.hydrate(pending ? [pending] : []);
  const restartedCompletion = restartedLedger.complete({
    connection_id: second.started.connection_id,
    profile_key: second.started.profile_key,
    replacement_id: second.started.replacement_id,
    ...(second.started.surface_subject_id ? { surface_subject_id: second.started.surface_subject_id } : {}),
    ...(second.started.surface_id ? { surface_id: second.started.surface_id } : {}),
    cause: second.started.cause,
    next_generation_hash: deriveOpaqueGenerationHash(id("connection-b:browser-process-new")),
  });
  const authoritativeRestartedCompletion = await store.append(restartedCompletion);
  assert.equal(authoritativeRestartedCompletion.cause, second.started.cause);
  assert.equal(
    await store.findPendingForSurface(mustExist(second.started.surface_id, "second lease has a surface_id")),
    null,
    "completion closes the durable pending replacement"
  );
  assert.equal(
    (
      await store.selectCurrent(
        omitUndefined<SelectCurrentInput>({
          connection_id: id("connection-b"),
          current_generation_hash: authoritativeRestartedCompletion.next_generation_hash,
          surface_subject_id: id("subject-b"),
        })
      )
    )?.replacement_id,
    second.started.replacement_id
  );

  const selectionLedger = createBrowserSurfaceReplacementLedger({ idPrefix: "selection-test", now: () => NOW });
  const olderPending = selectionLedger.start({
    cause: "idle_ttl",
    connection_id: id("connection-selection"),
    idempotency_key: id("selection-older-pending"),
    observed_at: NOW,
    profile_key: id("selection-profile"),
    surface_id: id("surface-old"),
    surface_subject_id: id("subject-selection"),
  });
  await store.append(olderPending);
  const newerStarted = selectionLedger.start(
    omitUndefined<ReplacementStartInput>({
      cause: "operator_requested",
      connection_id: olderPending.connection_id,
      idempotency_key: id("selection-newer-completed"),
      observed_at: NOW,
      profile_key: olderPending.profile_key,
      surface_id: id("surface-new"),
      surface_subject_id: olderPending.surface_subject_id,
    })
  );
  const newerCompleted = selectionLedger.complete(
    omitUndefined<ReplacementCompletionInput>({
      cause: newerStarted.cause,
      connection_id: newerStarted.connection_id,
      next_generation_hash: "b".repeat(64),
      observed_at: NOW,
      profile_key: newerStarted.profile_key,
      replacement_id: newerStarted.replacement_id,
      surface_id: newerStarted.surface_id,
      surface_subject_id: newerStarted.surface_subject_id,
    })
  );
  await store.append(newerStarted);
  await store.append(newerCompleted);
  assert.equal(
    await store.selectCurrent(
      omitUndefined<SelectCurrentInput>({
        connection_id: olderPending.connection_id,
        current_generation_hash: "c".repeat(64),
        surface_subject_id: olderPending.surface_subject_id,
      })
    ),
    null,
    "a newer completed mismatch cannot revive an older pending boundary"
  );

  const newestTerminalStarted = selectionLedger.start(
    omitUndefined<ReplacementStartInput>({
      cause: "external_or_host_loss",
      connection_id: olderPending.connection_id,
      idempotency_key: id("selection-newest-terminal"),
      observed_at: NOW,
      profile_key: olderPending.profile_key,
      surface_id: id("surface-terminal"),
      surface_subject_id: olderPending.surface_subject_id,
    })
  );
  await store.append(newestTerminalStarted);
  await store.append(terminalReceipt(newestTerminalStarted));
  assert.equal(
    await store.selectCurrent(
      omitUndefined<SelectCurrentInput>({
        connection_id: olderPending.connection_id,
        current_generation_hash: newerCompleted.next_generation_hash,
        surface_subject_id: olderPending.surface_subject_id,
      })
    ),
    null,
    "a terminal receipt is not a current browser generation"
  );
  const selectedTerminal = await store.selectSystemActionable({
    connection_id: olderPending.connection_id,
    profile_key: olderPending.profile_key,
    ...(olderPending.surface_subject_id ? { surface_subject_id: olderPending.surface_subject_id } : {}),
  });
  assert.equal(selectedTerminal?.phase, "terminal", "a failed terminal boundary remains system evidence");
  assert.equal(selectedTerminal?.terminal_outcome, "failed");

  const failedRetirement = selectionLedger.start(
    omitUndefined<ReplacementStartInput>({
      cause: "idle_ttl",
      connection_id: olderPending.connection_id,
      idempotency_key: id("selection-failed-retirement"),
      observed_at: NOW,
      profile_key: olderPending.profile_key,
      surface_id: id("surface-idle-retirement"),
      surface_subject_id: olderPending.surface_subject_id,
    })
  );
  await store.append(failedRetirement);
  await store.append(terminalReceipt(failedRetirement));
  assert.equal(
    await store.selectSystemActionable({
      connection_id: olderPending.connection_id,
      profile_key: olderPending.profile_key,
      ...(olderPending.surface_subject_id ? { surface_subject_id: olderPending.surface_subject_id } : {}),
    }),
    null,
    "a failed idle retirement is historical stop evidence, not a failed successor"
  );

  const interleavingLedger = createBrowserSurfaceReplacementLedger({ idPrefix: "interleaving-test", now: () => NOW });
  const interleavedFirst = interleavingLedger.start({
    cause: "idle_ttl",
    connection_id: id("connection-interleaving"),
    idempotency_key: id("interleaving-first"),
    observed_at: NOW,
    profile_key: id("interleaving-profile"),
    surface_id: id("surface-interleaving-first"),
    surface_subject_id: id("subject-interleaving"),
  });
  const interleavedSecond = interleavingLedger.start(
    omitUndefined<ReplacementStartInput>({
      cause: "operator_requested",
      connection_id: interleavedFirst.connection_id,
      idempotency_key: id("interleaving-second"),
      observed_at: NOW,
      profile_key: interleavedFirst.profile_key,
      surface_id: id("surface-interleaving-second"),
      surface_subject_id: interleavedFirst.surface_subject_id,
    })
  );
  const interleavedFirstCompleted = interleavingLedger.complete(
    omitUndefined<ReplacementCompletionInput>({
      cause: interleavedFirst.cause,
      connection_id: interleavedFirst.connection_id,
      next_generation_hash: "a".repeat(64),
      observed_at: NOW,
      profile_key: interleavedFirst.profile_key,
      replacement_id: interleavedFirst.replacement_id,
      surface_id: interleavedFirst.surface_id,
      surface_subject_id: interleavedFirst.surface_subject_id,
    })
  );
  await store.append(interleavedFirst);
  await store.append(interleavedSecond);
  await store.append(interleavedFirstCompleted);
  assert.equal(
    (
      await store.selectCurrent(
        omitUndefined<SelectCurrentInput>({
          connection_id: interleavedFirst.connection_id,
          current_generation_hash: interleavedFirstCompleted.next_generation_hash,
          surface_subject_id: interleavedFirst.surface_subject_id,
        })
      )
    )?.replacement_id,
    interleavedSecond.replacement_id,
    "SQLite keeps the newest started boundary current across interleaved completion events"
  );

  const resolutionRace = receiptSequence(id("connection-resolution-race"), id("subject-resolution-race"));
  await store.append(resolutionRace.started);
  await store.append(resolutionRace.completed);
  await assert.rejects(
    () =>
      store.append({
        ...resolutionRace.started,
        idempotency_key: id("resolution-race-terminal-after-complete"),
        phase: "terminal",
        terminal_outcome: "failed",
      }),
    ReplacementReplayConflictError,
    "a completed receipt is final and cannot gain a terminal row"
  );

  const terminalFirst = receiptSequence(id("connection-terminal-first"), id("subject-terminal-first"));
  await store.append(terminalReceipt(terminalFirst.started));
  await assert.rejects(
    () => store.append(terminalFirst.completed),
    ReplacementReplayConflictError,
    "a terminal receipt is final and cannot gain a completed row"
  );

  await assertSelectionOverrideContract(store, id);
}

async function assertSelectionOverrideContract(
  store: BrowserSurfaceReplacementReceiptStore,
  id: (value: string) => string
): Promise<void> {
  const ledger = createBrowserSurfaceReplacementLedger({ idPrefix: "selection-override", now: () => NOW });
  const connectionId = id("selection-override-connection");
  const profileKey = id("selection-override-profile");
  const subjectId = id("selection-override-subject");
  const olderStarted = ledger.start({
    cause: "external_or_host_loss",
    connection_id: connectionId,
    connector_id: "chatgpt",
    idempotency_key: id("selection-override-older"),
    observed_at: NOW,
    profile_key: profileKey,
    surface_id: id("selection-override-older-surface"),
    surface_subject_id: subjectId,
  });
  const olderFailed = ledger.terminate({
    cause: olderStarted.cause,
    connection_id: olderStarted.connection_id,
    outcome: "failed",
    profile_key: olderStarted.profile_key,
    replacement_id: olderStarted.replacement_id,
    surface_id: mustExist(olderStarted.surface_id, "older failed receipt has surface id"),
    surface_subject_id: subjectId,
  });
  const priorStarted = ledger.start({
    cause: "external_or_host_loss",
    connection_id: connectionId,
    connector_id: "chatgpt",
    idempotency_key: id("selection-override-prior"),
    observed_at: NOW,
    profile_key: profileKey,
    surface_id: id("selection-override-prior-surface"),
    surface_subject_id: subjectId,
  });
  const priorFailed = ledger.terminate({
    cause: priorStarted.cause,
    connection_id: priorStarted.connection_id,
    outcome: "failed",
    profile_key: priorStarted.profile_key,
    replacement_id: priorStarted.replacement_id,
    surface_id: mustExist(priorStarted.surface_id, "prior failed receipt has surface id"),
    surface_subject_id: subjectId,
  });
  const syntheticStarted = ledger.start({
    cause: "external_or_host_loss",
    connection_id: connectionId,
    connector_id: "chatgpt",
    idempotency_key: id("selection-override-synthetic"),
    observed_at: "2026-07-29T21:07:59.000Z",
    profile_key: profileKey,
    surface_id: id("selection-override-synthetic-surface"),
    surface_subject_id: subjectId,
  });
  await store.append(olderStarted);
  await store.append(olderFailed);
  await store.append(priorStarted);
  await store.append(priorFailed);
  await store.append(syntheticStarted);

  const selectorInput = {
    connection_id: connectionId,
    profile_key: profileKey,
    surface_subject_id: subjectId,
  };
  assert.equal(
    await store.selectSystemActionable(selectorInput),
    null,
    "before the reviewed override, a newer pending boundary masks the older failed successor"
  );
  await assert.rejects(
    () =>
      store.applySelectionOverride({
        applied_at: NOW,
        connection_id: connectionId,
        connector_id: "chatgpt",
        idempotency_key: syntheticStarted.idempotency_key,
        observed_at: "2026-07-29T21:08:00.000Z",
        prior_failed_replacement_id: priorStarted.replacement_id,
        profile_key: profileKey,
        replacement_id: syntheticStarted.replacement_id,
        surface_id: syntheticStarted.surface_id ?? "",
        surface_subject_id: subjectId,
      }),
    SELECTION_OVERRIDE_ERROR,
    "a correction must match the exact receipt fingerprint; a nearby boot timestamp is not enough"
  );
  await assert.rejects(
    () =>
      store.applySelectionOverride({
        applied_at: NOW,
        connection_id: connectionId,
        connector_id: "chatgpt",
        idempotency_key: syntheticStarted.idempotency_key,
        observed_at: syntheticStarted.observed_at,
        prior_failed_replacement_id: olderStarted.replacement_id,
        profile_key: profileKey,
        replacement_id: syntheticStarted.replacement_id,
        surface_id: syntheticStarted.surface_id ?? "",
        surface_subject_id: subjectId,
      }),
    SELECTION_OVERRIDE_ERROR,
    "a correction must name the failed receipt the selector will actually restore"
  );
  await store.applySelectionOverride({
    applied_at: NOW,
    connection_id: connectionId,
    connector_id: "chatgpt",
    idempotency_key: syntheticStarted.idempotency_key,
    observed_at: syntheticStarted.observed_at,
    prior_failed_replacement_id: priorStarted.replacement_id,
    profile_key: profileKey,
    replacement_id: syntheticStarted.replacement_id,
    surface_id: syntheticStarted.surface_id ?? "",
    surface_subject_id: subjectId,
  });
  assert.equal(
    (await store.selectSystemActionable(selectorInput))?.replacement_id,
    priorStarted.replacement_id,
    "after the exact reviewed override, the prior failed successor is selected again"
  );
  await store.applySelectionOverride({
    applied_at: NOW,
    connection_id: connectionId,
    connector_id: "chatgpt",
    idempotency_key: syntheticStarted.idempotency_key,
    observed_at: syntheticStarted.observed_at,
    prior_failed_replacement_id: priorStarted.replacement_id,
    profile_key: profileKey,
    replacement_id: syntheticStarted.replacement_id,
    surface_id: syntheticStarted.surface_id ?? "",
    surface_subject_id: subjectId,
  });
  const syntheticTerminal = ledger.terminate({
    cause: syntheticStarted.cause,
    connection_id: syntheticStarted.connection_id,
    outcome: "abandoned",
    profile_key: syntheticStarted.profile_key,
    replacement_id: syntheticStarted.replacement_id,
    surface_id: mustExist(syntheticStarted.surface_id, "synthetic receipt has surface id"),
    surface_subject_id: subjectId,
  });
  await store.append(syntheticTerminal);
  await store.applySelectionOverride({
    applied_at: NOW,
    connection_id: connectionId,
    connector_id: "chatgpt",
    idempotency_key: syntheticStarted.idempotency_key,
    observed_at: syntheticStarted.observed_at,
    prior_failed_replacement_id: priorStarted.replacement_id,
    profile_key: profileKey,
    replacement_id: syntheticStarted.replacement_id,
    surface_id: syntheticStarted.surface_id ?? "",
    surface_subject_id: subjectId,
  });

  const otherStarted = ledger.start({
    cause: "external_or_host_loss",
    connection_id: id("other-connector-connection"),
    connector_id: "reddit",
    idempotency_key: id("other-connector-prior"),
    observed_at: NOW,
    profile_key: id("other-connector-profile"),
    surface_id: id("other-connector-prior-surface"),
    surface_subject_id: id("other-connector-subject"),
  });
  const otherFailed = ledger.terminate({
    cause: otherStarted.cause,
    connection_id: otherStarted.connection_id,
    outcome: "failed",
    profile_key: otherStarted.profile_key,
    replacement_id: otherStarted.replacement_id,
    surface_id: mustExist(otherStarted.surface_id, "other prior receipt has surface id"),
    surface_subject_id: mustExist(otherStarted.surface_subject_id, "other prior receipt has subject id"),
  });
  const otherPending = ledger.start({
    cause: "external_or_host_loss",
    connection_id: otherStarted.connection_id,
    connector_id: "reddit",
    idempotency_key: id("other-connector-pending"),
    observed_at: syntheticStarted.observed_at,
    profile_key: otherStarted.profile_key,
    surface_id: id("other-connector-pending-surface"),
    surface_subject_id: mustExist(otherStarted.surface_subject_id, "other pending receipt has subject id"),
  });
  await store.append(otherStarted);
  await store.append(otherFailed);
  await store.append(otherPending);
  assert.equal(
    await store.selectSystemActionable({
      connection_id: otherStarted.connection_id,
      profile_key: otherStarted.profile_key,
      ...(otherStarted.surface_subject_id ? { surface_subject_id: otherStarted.surface_subject_id } : {}),
    }),
    null,
    "an analogous non-ChatGPT pending row remains untouched without its own exact reviewed override"
  );

  await store.revokeSelectionOverride(syntheticStarted.replacement_id, "2026-07-30T00:00:00.000Z");
  assert.equal(
    await store.selectSystemActionable(selectorInput),
    null,
    "revoking the correction restores ordinary latest-start selection without deleting any receipt"
  );
}

function terminalReceipt(started: ReplacementReceipt): ReplacementReceipt {
  return {
    ...started,
    event_seq: started.event_seq + 1000,
    idempotency_key: `${started.idempotency_key}:terminal`,
    phase: "terminal",
    terminal_outcome: "failed",
  };
}

interface ReplacementReceiptRow {
  cause: ReplacementReceipt["cause"];
  connection_id: string;
  connector_id: string | null;
  event_seq: number | string;
  idempotency_key: string;
  lease_id: string | null;
  next_generation_hash: string | null;
  observed_at: string;
  phase: ReplacementReceipt["phase"];
  previous_generation_hash: string | null;
  profile_key: string;
  replacement_id: string;
  run_id: string | null;
  scope: string;
  surface_id: string | null;
  surface_subject_id: string | null;
  terminal_outcome: ReplacementReceipt["terminal_outcome"] | null;
}

function rowFromReceipt(receipt: ReplacementReceipt): ReplacementReceiptRow {
  return {
    ...receipt,
    connector_id: receipt.connector_id ?? null,
    lease_id: receipt.lease_id ?? null,
    next_generation_hash: receipt.next_generation_hash ?? null,
    previous_generation_hash: receipt.previous_generation_hash ?? null,
    run_id: receipt.run_id ?? null,
    surface_id: receipt.surface_id ?? null,
    surface_subject_id: receipt.surface_subject_id ?? null,
    terminal_outcome: receipt.terminal_outcome ?? null,
  };
}

test("SQLite replacement ledger is append-only, redacted, idempotent, and generation-scoped", async () => {
  initDb();
  try {
    await assertStoreContract(createSqliteBrowserSurfaceReplacementReceiptStore());
    const columns = typedDb()
      .prepare("PRAGMA table_info(browser_surface_replacement_receipts)")
      .all()
      .map((row) => row.name);
    assert.equal(columns.includes("container_id"), false);
    assert.equal(columns.includes("cdp_url"), false);
    assert.equal(columns.includes("websocket_url"), false);
    assert.match(SQLITE_BROWSER_SURFACE_REPLACEMENT_LEDGER_SCHEMA, TOP_LEVEL_REGEX_1);
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
      preferred_surface_id: "surface-new",
      profile_key: pending.profile_key,
      surface_subject_id: pending.surface_subject_id ?? null,
    });
    assert.equal(afterRestart?.replacement_id, pending.replacement_id);
    assert.equal(afterRestart?.surface_id, "surface-retired");
  } finally {
    closeDb();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("Postgres replacement ledger matches SQLite append/order/selection contract", {
  skip: !POSTGRES_URL,
}, async () => {
  assert.ok(POSTGRES_URL, "Postgres URL is configured when this test runs");
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  try {
    await assertStoreContract(createPostgresBrowserSurfaceReplacementReceiptStore());
  } finally {
    await closePostgresStorage();
  }
});

test("injectable Postgres append rereads a concurrent opposite resolution", async () => {
  const { started, completed } = receiptSequence("connection-pg-race", "subject-pg-race");
  const terminal = terminalReceipt(started);
  let initialResolutionRead = true;
  // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
  const query = async (sql: string): Promise<{ rows: ReplacementReceiptRow[] }> => {
    if (sql.startsWith("INSERT INTO")) {
      return { rows: [] };
    }
    if (sql.includes("ORDER BY event_seq DESC LIMIT 1")) {
      return { rows: [rowFromReceipt(started)] };
    }
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
    "a concurrent terminal winner is reported as a deterministic replay conflict"
  );
  assert.match(POSTGRES_BROWSER_SURFACE_REPLACEMENT_LEDGER_SCHEMA, TOP_LEVEL_REGEX_2);
});

test("Postgres replacement scope contains no NUL byte", async () => {
  const { started } = receiptSequence("connection-pg-nul", "subject-pg-nul");
  let insertValues: readonly unknown[] | undefined;
  // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
  const query = async (sql: string, values?: readonly unknown[]): Promise<{ rows: ReplacementReceiptRow[] }> => {
    if (sql.startsWith("INSERT INTO")) {
      insertValues = values;
      return { rows: [rowFromReceipt(started)] };
    }
    return { rows: [] };
  };

  await createPostgresBrowserSurfaceReplacementReceiptStore(query).append(started);

  const capturedInsertValues = mustExist(insertValues, "an INSERT query was issued");
  const scopeValue = mustExist(capturedInsertValues[2], "scope value present");
  assert.equal(scopeValue, JSON.stringify(["connection-pg-nul", "subject-pg-nul"]));
  assert.equal(String(scopeValue).includes("\0"), false);
});

test("injectable Postgres scoped pending lookup preserves exact nullable scope", async () => {
  const pending = receiptSequence("connection-pg-scope", "subject-pg-scope").started;
  let captured: { sql: string; values: readonly unknown[] | undefined } | undefined;
  // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
  const query = async (sql: string, values?: readonly unknown[]): Promise<{ rows: ReplacementReceiptRow[] }> => {
    captured = { sql, values };
    return { rows: [rowFromReceipt({ ...pending, surface_id: "surface-retired" })] };
  };
  const store = createPostgresBrowserSurfaceReplacementReceiptStore(query);
  const result = await store.findPendingForScope({
    connection_id: pending.connection_id,
    preferred_surface_id: "surface-new",
    profile_key: pending.profile_key,
    surface_subject_id: pending.surface_subject_id ?? null,
  });
  assert.equal(result?.surface_id, "surface-retired");
  const capturedQuery = mustExist(captured, "a query was issued");
  assert.match(capturedQuery.sql, TOP_LEVEL_REGEX_3);
  assert.match(capturedQuery.sql, TOP_LEVEL_REGEX_4);
  assert.deepEqual(capturedQuery.values, ["connection-pg-scope", "subject-pg-scope", "shared-profile", "surface-new"]);
});
