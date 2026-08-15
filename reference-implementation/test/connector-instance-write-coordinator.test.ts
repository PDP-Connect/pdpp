const TOP_LEVEL_REGEX_1 = /forged, stale, or bound to another instance/;
const TOP_LEVEL_REGEX_2 = /forged, stale, or bound to another instance/;
const TOP_LEVEL_REGEX_3 = /forged, stale, or bound to another instance/;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  ConnectorInstanceAdmissionError,
  type ConnectorInstanceWriteOwnership,
  connectorInstanceWriteCoordinatorStatsForTests,
  withConnectorInstanceWrite,
} from "../server/connector-instance-write-coordinator.ts";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withCoordinatorEnvironment<T>(
  values: Record<string, string | number>,
  operation: () => Promise<T>
): Promise<T> {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      process.env[key] = String(value);
    }
    return await operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

// `withConnectorInstanceWrite` is now a PURE in-process gate (per-instance
// keyed mutex + global admission slot + ownership capability bookkeeping).
// Cross-process/cross-session exclusion moved to `postgres-storage.ts`'s
// `withPostgresTransaction({ lockConnectorInstanceId })` — see
// postgres-transaction-connector-instance-lock.test.ts for that coverage.
// See harden-connector-instance-write-fence-transaction-native.

test("connector-instance ownership is instance-bound, opaque in practice, and stale after release", async () => {
  let issued: ConnectorInstanceWriteOwnership | undefined;
  await withConnectorInstanceWrite("cin_owner", async (ownership) => {
    issued = ownership;
    await withConnectorInstanceWrite(
      "cin_owner",
      // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
      async (nested) => {
        assert.equal(nested, ownership);
      },
      ownership
    );
    await assert.rejects(
      () => withConnectorInstanceWrite("cin_other", async () => undefined, ownership),
      TOP_LEVEL_REGEX_1
    );
  });

  await assert.rejects(() => withConnectorInstanceWrite("cin_owner", async () => undefined, issued), TOP_LEVEL_REGEX_2);
  await assert.rejects(
    () =>
      withConnectorInstanceWrite("cin_owner", async () => undefined, {
        connectorInstanceId: "cin_owner",
        token: Symbol("fake"),
      }),
    TOP_LEVEL_REGEX_3
  );
  assert.equal(connectorInstanceWriteCoordinatorStatsForTests().activeOwnerships, 0);
});

test("a hot keyed wait expires, removes itself, and leaves the coordinator reusable", async () => {
  await withCoordinatorEnvironment({ PDPP_INGEST_LOCK_WAIT_MS: 20 }, async () => {
    const releaseFirst = deferred();
    const first = withConnectorInstanceWrite("cin_hot", async () => releaseFirst.promise);
    await new Promise((resolve) => setTimeout(resolve, 1));
    await assert.rejects(
      () => withConnectorInstanceWrite("cin_hot", async () => undefined),
      (error: unknown) => error instanceof ConnectorInstanceAdmissionError && error.code === "connector_instance_busy"
    );
    releaseFirst.resolve();
    await first;
    assert.deepEqual(connectorInstanceWriteCoordinatorStatsForTests(), {
      activeOwnerships: 0,
      activeWriters: 0,
      keyedEntries: 0,
      queuedWriters: 0,
    });
    await withConnectorInstanceWrite("cin_hot", async () => undefined);
  });
});

test("admission saturation rejects a new writer once PDPP_INGEST_ACTIVE_BATCH_LIMIT is exhausted, independent of any Postgres pool", async () => {
  await withCoordinatorEnvironment({ PDPP_INGEST_ACTIVE_BATCH_LIMIT: 1, PDPP_INGEST_LOCK_WAIT_MS: 20 }, async () => {
    const releaseFirst = deferred();
    const first = withConnectorInstanceWrite("cin_admission_a", async () => releaseFirst.promise);
    await new Promise((resolve) => setTimeout(resolve, 1));
    // A DIFFERENT key: this proves admission (not the per-key gate) is what
    // rejects — the whole point of removing the dedicated lock pool is that
    // admission no longer needs to be clamped to any pool's capacity.
    await assert.rejects(
      () => withConnectorInstanceWrite("cin_admission_b", async () => undefined),
      (error: unknown) => error instanceof ConnectorInstanceAdmissionError && error.code === "connector_instance_busy"
    );
    releaseFirst.resolve();
    await first;
    assert.deepEqual(connectorInstanceWriteCoordinatorStatsForTests(), {
      activeOwnerships: 0,
      activeWriters: 0,
      keyedEntries: 0,
      queuedWriters: 0,
    });
  });
});
