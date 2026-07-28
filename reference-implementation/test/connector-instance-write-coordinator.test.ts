const TOP_LEVEL_REGEX_1 = /forged, stale, or bound to another instance/;
const TOP_LEVEL_REGEX_2 = /forged, stale, or bound to another instance/;
const TOP_LEVEL_REGEX_3 = /forged, stale, or bound to another instance/;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  __setConnectorInstanceAdvisoryLifecycleFaultHookForTest,
  __setConnectorInstancePostgresLockPoolForTest,
  ConnectorInstanceAdmissionError,
  type ConnectorInstanceWriteOwnership,
  connectorInstanceWriteCoordinatorStatsForTests,
  withConnectorInstanceWrite,
} from "../server/connector-instance-write-coordinator.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const DEDICATED_POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

function dedicatedPostgresUrlForTest(): string {
  const databaseUrl = DEDICATED_POSTGRES_URL;
  assert.ok(databaseUrl, "DEDICATED_POSTGRES_URL is required for this test");
  return databaseUrl;
}

function mustRow<T extends Record<string, unknown>>(value: T | undefined, description: string): T {
  assert.ok(value, description);
  return value;
}

// `PostgresLockClient` is module-private in connector-instance-write-
// coordinator.ts; redeclared here matching its real shape so the test-only
// lock-pool seam's fake client can be typed honestly.
interface TestPostgresLockClient {
  query: (
    sql: string,
    params: readonly unknown[]
  ) => Promise<{ rows: Array<{ acquired?: boolean; unlocked?: boolean }> }>;
  release: (error?: boolean) => void;
}

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

test("a late lock-query result cannot release its client twice or strand local capacity", async () => {
  await withCoordinatorEnvironment(
    {
      PDPP_INGEST_ACTIVE_BATCH_LIMIT: 1,
      PDPP_INGEST_LOCK_QUERY_WAIT_MS: 10,
    },
    async () => {
      const queryResult = deferred<{ rows: { acquired: boolean }[] }>();
      let releaseCalls = 0;
      const client: TestPostgresLockClient = {
        query: async () => queryResult.promise,
        release: () => {
          releaseCalls += 1;
          if (releaseCalls > 1) {
            throw new Error("duplicate client release");
          }
        },
      };
      __setConnectorInstancePostgresLockPoolForTest({
        capacity: 1,
        pool: { connect: async () => client },
      });
      try {
        await assert.rejects(
          () => withConnectorInstanceWrite("cin_late_query", async () => undefined),
          (error: unknown) =>
            error instanceof ConnectorInstanceAdmissionError && error.code === "connector_instance_busy"
        );
        queryResult.resolve({ rows: [{ acquired: true }] });
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(releaseCalls, 1);
        assert.deepEqual(connectorInstanceWriteCoordinatorStatsForTests(), {
          activeOwnerships: 0,
          activeWriters: 0,
          keyedEntries: 0,
          queuedWriters: 0,
        });
      } finally {
        __setConnectorInstancePostgresLockPoolForTest(null);
      }
    }
  );
});

test("Postgres pool saturation and unlock uncertainty destroy the lock session", {
  skip: !DEDICATED_POSTGRES_URL,
}, async () => {
  await withCoordinatorEnvironment(
    {
      PDPP_INGEST_ACTIVE_BATCH_LIMIT: 8,
      PDPP_INGEST_LOCK_WAIT_MS: 30,
      PDPP_PG_INGEST_LOCK_POOL_SIZE: 1,
    },
    async () => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: dedicatedPostgresUrlForTest() });
      try {
        const releaseFirst = deferred();
        const first = withConnectorInstanceWrite("cin_pg_saturated_a", async () => releaseFirst.promise);
        await new Promise((resolve) => setTimeout(resolve, 1));
        await assert.rejects(
          () => withConnectorInstanceWrite("cin_pg_saturated_b", async () => undefined),
          (error: unknown) =>
            error instanceof ConnectorInstanceAdmissionError && error.code === "connector_instance_busy"
        );
        releaseFirst.resolve();
        await first;

        __setConnectorInstanceAdvisoryLifecycleFaultHookForTest((stage) => {
          assert.equal(stage, "before_unlock");
          throw new Error("forced unlock uncertainty");
        });
        await withConnectorInstanceWrite("cin_pg_unlock_uncertain", async () => undefined);
        __setConnectorInstanceAdvisoryLifecycleFaultHookForTest(null);
        await withConnectorInstanceWrite("cin_pg_unlock_uncertain", async () => undefined);
        assert.equal(connectorInstanceWriteCoordinatorStatsForTests().activeWriters, 0);
      } finally {
        __setConnectorInstanceAdvisoryLifecycleFaultHookForTest(null);
        await closePostgresStorage();
      }
    }
  );
});

test("an actual PostgreSQL advisory-session disconnect leaks no lock and the same key recovers", {
  skip: !DEDICATED_POSTGRES_URL,
}, async () => {
  await withCoordinatorEnvironment(
    {
      PDPP_INGEST_ACTIVE_BATCH_LIMIT: 1,
      PDPP_INGEST_LOCK_QUERY_WAIT_MS: 1000,
      PDPP_INGEST_LOCK_WAIT_MS: 2000,
      PDPP_PG_INGEST_LOCK_POOL_SIZE: 1,
    },
    async () => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: dedicatedPostgresUrlForTest() });
      try {
        const entered = deferred();
        const releaseOperation = deferred();
        const first = withConnectorInstanceWrite("cin_pg_real_disconnect", async () => {
          entered.resolve();
          await releaseOperation.promise;
        });
        await entered.promise;

        const held = await postgresQuery(
          `SELECT a.pid
           FROM pg_locks l
           JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE l.locktype = 'advisory'
            AND l.granted = TRUE
            AND a.datname = current_database()
            AND a.pid <> pg_backend_pid()`
        );
        assert.equal(held.rowCount, 1, "the isolated lock pool must own one live advisory session");
        const disconnectedPid = Number(mustRow(held.rows[0], "held advisory lock row exists").pid);
        const terminated = await postgresQuery("SELECT pg_terminate_backend($1) AS terminated", [disconnectedPid]);
        assert.equal(mustRow(terminated.rows[0], "termination result row exists").terminated, true);

        releaseOperation.resolve();
        await first;
        await withConnectorInstanceWrite("cin_pg_real_disconnect", async () => undefined);

        const leaked = await postgresQuery(
          `SELECT COUNT(*)::integer AS count
           FROM pg_locks l
           JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE l.locktype = 'advisory'
            AND l.granted = TRUE
            AND a.datname = current_database()`
        );
        assert.equal(
          mustRow(leaked.rows[0], "leaked lock count row exists").count,
          0,
          "disconnect and replacement acquisition must leave no advisory lock"
        );
        assert.deepEqual(connectorInstanceWriteCoordinatorStatsForTests(), {
          activeOwnerships: 0,
          activeWriters: 0,
          keyedEntries: 0,
          queuedWriters: 0,
        });
      } finally {
        await closePostgresStorage();
      }
    }
  );
});
