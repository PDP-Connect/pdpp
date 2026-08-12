// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";

import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

function adminUrl(connectionString) {
  const url = new URL(connectionString);
  url.pathname = "/postgres";
  return url.toString();
}

async function assertDatabaseDropped(targetDatabaseName) {
  const admin = new Pool({ connectionString: adminUrl(POSTGRES_URL) });
  try {
    const result = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [targetDatabaseName]);
    assert.equal(result.rowCount, 0);
  } finally {
    await admin.end();
  }
}

function databaseName(suffix) {
  return `pdpp_temp_helper_${suffix}_${process.pid}_${Date.now()}`;
}

if (POSTGRES_URL) {
  test("temporary Postgres database helper closes connections before dropping the database", async () => {
    const temporaryDatabase = databaseName("close");
    let temporaryPool;
    let closed = false;

    await withTemporaryPostgresDatabase(
      {
        closeConnections: async () => {
          await temporaryPool.end();
          closed = true;
        },
        connectionString: POSTGRES_URL,
        databaseName: temporaryDatabase,
      },
      async (connectionString) => {
        temporaryPool = new Pool({ connectionString });
        const result = await temporaryPool.query("SELECT current_database() AS database_name");
        assert.equal(result.rows[0]?.database_name, temporaryDatabase);
      }
    );

    assert.equal(closed, true);

    await assertDatabaseDropped(temporaryDatabase);
  });

  test("temporary Postgres database helper preserves a callback failure", async () => {
    const temporaryDatabase = databaseName("callback");
    const callbackError = new Error("callback failed");

    await assert.rejects(
      withTemporaryPostgresDatabase({ connectionString: POSTGRES_URL, databaseName: temporaryDatabase }, () => {
        throw callbackError;
      }),
      (error) => error === callbackError
    );

    await assertDatabaseDropped(temporaryDatabase);
  });

  test("temporary Postgres database helper reports a cleanup failure after dropping the database", async () => {
    const temporaryDatabase = databaseName("cleanup");
    const cleanupError = new Error("cleanup failed");

    await assert.rejects(
      withTemporaryPostgresDatabase(
        {
          closeConnections: () => {
            throw cleanupError;
          },
          connectionString: POSTGRES_URL,
          databaseName: temporaryDatabase,
        },
        () => undefined
      ),
      (error) => error === cleanupError
    );

    await assertDatabaseDropped(temporaryDatabase);
  });

  test("temporary Postgres database helper preserves callback and cleanup failures", async () => {
    const temporaryDatabase = databaseName("combined");
    const callbackError = new Error("callback failed");
    const cleanupError = new Error("cleanup failed");

    await assert.rejects(
      withTemporaryPostgresDatabase(
        {
          closeConnections: () => {
            throw cleanupError;
          },
          connectionString: POSTGRES_URL,
          databaseName: temporaryDatabase,
        },
        () => {
          throw callbackError;
        }
      ),
      (error) =>
        error instanceof AggregateError &&
        error.errors.length === 2 &&
        error.errors[0] === callbackError &&
        error.errors[1] === cleanupError
    );

    await assertDatabaseDropped(temporaryDatabase);
  });
} else {
  test("temporary Postgres database helper (skipped: PDPP_TEST_POSTGRES_URL unset)", { skip: true }, () => undefined);
}
