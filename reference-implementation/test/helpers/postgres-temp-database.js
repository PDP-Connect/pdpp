import { Pool } from "pg";

function adminUrl(connectionString) {
  const url = new URL(connectionString);
  url.pathname = "/postgres";
  return url.toString();
}

function databaseUrl(connectionString, databaseName) {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quotedIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * Run a callback against a disposable database on a shared Postgres cluster.
 *
 * `DROP DATABASE ... WITH (FORCE)` is deliberate: test failures or a missed
 * pool shutdown must not turn into a durable database leak on the proof
 * cluster. The repository's Postgres test image is pg16, which supports it.
 */
export async function withTemporaryPostgresDatabase({ connectionString, databaseName, closeConnections }, callback) {
  const admin = new Pool({ connectionString: adminUrl(connectionString) });
  const database = quotedIdentifier(databaseName);
  let created = false;
  let result;
  let operationError;

  try {
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${database}`);
    created = true;
    result = await callback(databaseUrl(connectionString, databaseName));
  } catch (error) {
    operationError = error;
  }

  const cleanupErrors = [];

  if (created) {
    if (closeConnections) {
      try {
        await closeConnections();
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
