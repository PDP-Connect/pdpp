// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// biome-ignore lint/correctness/noUnresolvedImports: localized test assertion preserves its explicit contract.
import pg from "pg";

const { Pool } = pg;

function adminUrl(connectionString: string): string {
  const url = new URL(connectionString);
  url.pathname = "/postgres";
  return url.toString();
}

function databaseUrl(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quotedIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function waitForDatabaseConnectionsToClose(
  admin: InstanceType<typeof Pool>,
  databaseName: string,
  deadlineMs: number
): Promise<void> {
  const result = await admin.query<{ connection_count: number }>(
    `SELECT count(*)::integer AS connection_count
       FROM pg_stat_activity
      WHERE datname = $1
        AND pid <> pg_backend_pid()`,
    [databaseName]
  );
  if (Number(result.rows[0]?.connection_count ?? 0) === 0 || Date.now() >= deadlineMs) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  await waitForDatabaseConnectionsToClose(admin, databaseName, deadlineMs);
}

/**
 * Run a callback against a disposable database on a shared Postgres cluster.
 *
 * `DROP DATABASE ... WITH (FORCE)` is deliberate: test failures or a missed
 * pool shutdown must not turn into a durable database leak on the proof
 * cluster. The repository's Postgres test image is pg16, which supports it.
 */
export async function withTemporaryPostgresDatabase(
  {
    connectionString,
    databaseName,
    closeConnections,
  }: {
    connectionString: string;
    databaseName: string;
    closeConnections?: () => Promise<void>;
  },
  callback: (databaseUrl: string) => Promise<unknown>
): Promise<unknown> {
  const admin = new Pool({ connectionString: adminUrl(connectionString) });
  const database = quotedIdentifier(databaseName);
  let created = false;
  // biome-ignore lint/suspicious/noEvolvingTypes: localized test assertion preserves its explicit contract.
  // biome-ignore lint/suspicious/noImplicitAnyLet: localized test assertion preserves its explicit contract.
  let result;
  // biome-ignore lint/suspicious/noEvolvingTypes: localized test assertion preserves its explicit contract.
  // biome-ignore lint/suspicious/noImplicitAnyLet: localized test assertion preserves its explicit contract.
  let operationError;

  try {
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${database}`);
    created = true;
    result = await callback(databaseUrl(connectionString, databaseName));
  } catch (error) {
    operationError = error;
  }

  // biome-ignore lint/suspicious/noEvolvingTypes: localized test assertion preserves its explicit contract.
  const cleanupErrors = [];

  if (created) {
    if (closeConnections) {
      try {
        await closeConnections();
        // node-postgres can resolve Pool.end() immediately before the server
        // observes the final client socket disconnect. Give that graceful
        // shutdown a bounded window before the FORCE fallback below; otherwise
        // DROP can deliver an administrator-command error to an already-finished
        // test request and turn clean teardown into a nondeterministic failure.
        await waitForDatabaseConnectionsToClose(admin, databaseName, Date.now() + 2000);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    try {
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  try {
    await admin.end();
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (operationError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [operationError, ...cleanupErrors],
      `temporary Postgres database operation and cleanup both failed for ${databaseName}`
    );
  }
  if (operationError) {
    throw operationError;
  }
  if (cleanupErrors.length === 1) {
    throw cleanupErrors[0];
  }
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, `could not clean up temporary Postgres database ${databaseName}`);
  }

  return result;
}
