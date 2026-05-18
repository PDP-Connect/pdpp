/**
 * Postgres-backed driver for the connector-state / schedule / active-run
 * conformance harness.
 *
 * This is a *test-only* proof adapter. It exists to demonstrate that the
 * persistence obligations pinned by
 * `helpers/connector-state-scheduler-conformance.js` can be satisfied by
 * a non-SQLite backend without reaching into the SQLite reference at
 * all. It deliberately re-implements the three concerns (state,
 * schedule, active-run + restart reconciliation) directly against
 * Postgres so that the harness's pass/fail signal is owned by Postgres
 * semantics, not by the SQLite helpers we are trying to falsify against.
 *
 *   - DDL is local to this driver. The driver creates a fresh,
 *     uniquely-named schema in `setup()` and drops it in `teardown()`,
 *     so concurrent harness runs do not collide.
 *
 *   - Active-run reconciliation is implemented by this driver itself:
 *     `simulateRestart()` drains `controller_active_runs` and records
 *     each drained run id into a private `terminal_failed_runs` table;
 *     `wasRunMarkedFailed(runId)` reads from that table. There is no
 *     coupling to the SQLite reference's spine schema. The harness
 *     contract only requires that `wasRunMarkedFailed` reports `true`
 *     for any run that was active at the time of the simulated restart.
 *
 *   - There is no runtime `ConnectorStateStore` / `SchedulerStore`
 *     interface being selected by this slice. The driver exists only
 *     to evidence that the conformance harness is portable to a second
 *     backend with credibly Postgres-shaped semantics (jsonb, stable
 *     `ON CONFLICT` upsert, UNIQUE constraints, transaction-safe
 *     reconciliation).
 *
 * The driver is gated behind an explicit `PDPP_TEST_POSTGRES_URL` env
 * var by its caller (the test file). It SHALL NOT be imported from
 * production code paths.
 *
 * Spec: openspec/changes/add-postgres-storage-adapters/
 */

import pg from 'pg';

const { Client } = pg;

const SCHEMA_PREFIX = 'pdpp_proof_';

function uniqueSchemaName() {
  // Schema names must be valid PostgreSQL identifiers; restrict to
  // lowercase hex.
  const stamp = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 1e8).toString(36);
  return `${SCHEMA_PREFIX}${stamp}_${rand}`.toLowerCase().replace(/[^a-z0-9_]/g, '');
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * @param {object} options
 * @param {string} options.connectionString  e.g. PDPP_TEST_POSTGRES_URL
 */
export function createPostgresConnectorStateSchedulerDriver({ connectionString }) {
  if (!connectionString) {
    throw new Error('createPostgresConnectorStateSchedulerDriver requires connectionString');
  }

  const schema = uniqueSchemaName();
  let client = null;

  /**
   * Quote an identifier for safe interpolation into DDL where parameter
   * binding is not available (CREATE SCHEMA, SET search_path, table
   * names). The `schema` value comes from `uniqueSchemaName`, which
   * already restricts to `[a-z0-9_]+`, so this is defense-in-depth.
   */
  function q(ident) {
    if (!/^[a-z0-9_]+$/.test(ident)) {
      throw new Error(`unsafe identifier rejected: ${ident}`);
    }
    return `"${ident}"`;
  }

  async function exec(sql, params = []) {
    return client.query(sql, params);
  }

  return {
    async setup() {
      client = new Client({ connectionString });
      await client.connect();
      await exec(`CREATE SCHEMA ${q(schema)}`);
      await exec(`SET search_path TO ${q(schema)}`);

      // Connector sync state. Owner-scoped rows have grant_id IS NULL;
      // grant-scoped rows have grant_id set. The composite uniqueness
      // is intentionally enforced via two partial unique indexes
      // because Postgres treats NULLs in a UNIQUE constraint as
      // distinct, which would let owner-scoped state duplicate per
      // (connector_id, stream).
      await exec(`
        CREATE TABLE connector_state (
          connector_id TEXT NOT NULL,
          grant_id TEXT,
          stream TEXT NOT NULL,
          state JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        )
      `);
      await exec(`
        CREATE UNIQUE INDEX connector_state_owner_uniq
          ON connector_state (connector_id, stream)
          WHERE grant_id IS NULL
      `);
      await exec(`
        CREATE UNIQUE INDEX connector_state_grant_uniq
          ON connector_state (connector_id, grant_id, stream)
          WHERE grant_id IS NOT NULL
      `);

      // Schedule registry: one row per connector instance. The conformance
      // harness still addresses the compatibility single-instance path with
      // connectorId, so connector_instance_id is the same value here.
      await exec(`
        CREATE TABLE connector_schedules (
          connector_instance_id TEXT PRIMARY KEY,
          connector_id TEXT NOT NULL,
          interval_seconds INTEGER NOT NULL,
          jitter_seconds INTEGER NOT NULL DEFAULT 0,
          enabled BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        )
      `);

      // Active-run registry: per-instance exclusivity and global run_id
      // uniqueness. The harness exercises the legacy single-instance mapping
      // where connector_instance_id == connector_id.
      await exec(`
        CREATE TABLE controller_active_runs (
          connector_instance_id TEXT PRIMARY KEY,
          connector_id TEXT NOT NULL,
          run_id TEXT NOT NULL UNIQUE,
          trace_id TEXT NOT NULL,
          scenario_id TEXT NOT NULL,
          started_at TIMESTAMPTZ NOT NULL
        )
      `);

      // Terminal-failed-run marker table: this driver's local equivalent
      // of "spine emitted a run.failed event". The harness only looks
      // through `wasRunMarkedFailed(runId)`, so the contract here is
      // bounded to that lifecycle.
      await exec(`
        CREATE TABLE terminal_failed_runs (
          run_id TEXT PRIMARY KEY,
          connector_id TEXT NOT NULL,
          marked_at TIMESTAMPTZ NOT NULL
        )
      `);
    },

    async teardown() {
      if (!client) return;
      try {
        await exec(`DROP SCHEMA ${q(schema)} CASCADE`);
      } finally {
        await client.end();
        client = null;
      }
    },

    async putConnectorState(scope, stateByStream) {
      const connectorId = scope.connectorId;
      const grantId = scope.grantId || null;
      const now = nowIso();

      // Postgres infers the partial unique index from the conflict
      // tuple plus the predicate. Because Postgres treats each NULL
      // grant_id as distinct, we cannot rely on a non-partial index;
      // the predicate is what makes the inference unambiguous.
      for (const [stream, cursor] of Object.entries(stateByStream)) {
        if (grantId === null) {
          await exec(
            `
            INSERT INTO connector_state (connector_id, grant_id, stream, state, updated_at)
            VALUES ($1, NULL, $2, $3::jsonb, $4)
            ON CONFLICT (connector_id, stream) WHERE grant_id IS NULL
            DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at
            `,
            [connectorId, stream, JSON.stringify(cursor), now],
          );
        } else {
          await exec(
            `
            INSERT INTO connector_state (connector_id, grant_id, stream, state, updated_at)
            VALUES ($1, $2, $3, $4::jsonb, $5)
            ON CONFLICT (connector_id, grant_id, stream) WHERE grant_id IS NOT NULL
            DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at
            `,
            [connectorId, grantId, stream, JSON.stringify(cursor), now],
          );
        }
      }

      return this.getConnectorState(scope);
    },

    async getConnectorState(scope, opts = {}) {
      const connectorId = scope.connectorId;
      const grantId = scope.grantId || null;
      const allowedStreams = Array.isArray(opts.allowedStreams) ? opts.allowedStreams : null;

      const result = grantId === null
        ? await exec(
            `SELECT stream, state, updated_at
             FROM connector_state
             WHERE connector_id = $1 AND grant_id IS NULL`,
            [connectorId],
          )
        : await exec(
            `SELECT stream, state, updated_at
             FROM connector_state
             WHERE connector_id = $1 AND grant_id = $2`,
            [connectorId, grantId],
          );

      const allowedSet = allowedStreams ? new Set(allowedStreams) : null;
      const state = {};
      let updatedAt = null;
      for (const row of result.rows) {
        if (allowedSet && !allowedSet.has(row.stream)) continue;
        // pg returns jsonb as parsed JS values directly.
        state[row.stream] = row.state;
        const iso = row.updated_at instanceof Date
          ? row.updated_at.toISOString()
          : String(row.updated_at);
        if (!updatedAt || iso > updatedAt) updatedAt = iso;
      }
      return {
        object: 'stream_state',
        connector_id: connectorId,
        grant_id: grantId,
        state,
        updated_at: updatedAt,
      };
    },

    async upsertSchedule(connectorId, patch) {
      const now = nowIso();
      const interval = patch.interval_seconds;
      const jitter = patch.jitter_seconds ?? 0;
      const enabled = patch.enabled ?? true;

      const res = await exec(
        `
        INSERT INTO connector_schedules
          (connector_instance_id, connector_id, interval_seconds, jitter_seconds, enabled, created_at, updated_at)
        VALUES ($1, $1, $2, $3, $4, $5, $5)
        ON CONFLICT (connector_instance_id) DO UPDATE
          SET interval_seconds = EXCLUDED.interval_seconds,
              jitter_seconds = EXCLUDED.jitter_seconds,
              enabled = EXCLUDED.enabled,
              updated_at = EXCLUDED.updated_at
        RETURNING connector_instance_id, connector_id, interval_seconds, jitter_seconds, enabled,
                  created_at, updated_at
        `,
        [connectorId, interval, jitter, enabled, now],
      );
      return rowToSchedule(res.rows[0]);
    },

    async getSchedule(connectorId) {
      const res = await exec(
        `SELECT connector_instance_id, connector_id, interval_seconds, jitter_seconds, enabled,
                created_at, updated_at
         FROM connector_schedules WHERE connector_instance_id = $1`,
        [connectorId],
      );
      return res.rows[0] ? rowToSchedule(res.rows[0]) : null;
    },

    async listSchedules() {
      const res = await exec(
        `SELECT connector_instance_id, connector_id, interval_seconds, jitter_seconds, enabled,
                created_at, updated_at
         FROM connector_schedules`,
      );
      return res.rows.map(rowToSchedule);
    },

    async setScheduleEnabled(connectorId, enabled) {
      const now = nowIso();
      const res = await exec(
        `UPDATE connector_schedules
         SET enabled = $2, updated_at = $3
         WHERE connector_instance_id = $1
         RETURNING connector_instance_id, connector_id, interval_seconds, jitter_seconds, enabled,
                   created_at, updated_at`,
        [connectorId, enabled, now],
      );
      if (res.rowCount === 0) {
        throw new Error(`Schedule not found for connector: ${connectorId}`);
      }
      return rowToSchedule(res.rows[0]);
    },

    async deleteSchedule(connectorId) {
      const res = await exec(
        `DELETE FROM connector_schedules WHERE connector_instance_id = $1`,
        [connectorId],
      );
      return res.rowCount > 0;
    },

    async insertActiveRun(connectorId, run) {
      // Per-connector upsert mirrors the SQLite reference's
      // ON CONFLICT(connector_id) shape. The cross-connector run_id
      // uniqueness scenario inserts the same `run_id` under a different
      // connector; the UNIQUE(run_id) constraint causes Postgres to
      // raise SQLSTATE 23505. The harness explicitly tolerates either
      // throw OR no-op as long as the registry never holds the
      // duplicate, so we let the error surface unchanged.
      await exec(
        `INSERT INTO controller_active_runs
           (connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at)
         VALUES ($1, $1, $2, $3, $4, $5)
         ON CONFLICT (connector_instance_id) DO UPDATE
           SET run_id = EXCLUDED.run_id,
               connector_id = EXCLUDED.connector_id,
               trace_id = EXCLUDED.trace_id,
               scenario_id = EXCLUDED.scenario_id,
               started_at = EXCLUDED.started_at`,
        [connectorId, run.runId, run.traceId, run.scenarioId, run.startedAt],
      );
    },

    async getActiveRun(connectorId) {
      const res = await exec(
        `SELECT connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at
         FROM controller_active_runs WHERE connector_instance_id = $1`,
        [connectorId],
      );
      return res.rows[0] ? rowToActiveRun(res.rows[0]) : null;
    },

    async listActiveRuns() {
      const res = await exec(
        `SELECT connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at
         FROM controller_active_runs`,
      );
      return res.rows.map(rowToActiveRun);
    },

    async deleteActiveRun(connectorId, runId) {
      // Guarded delete: row only goes away if both instance and run id
      // match, so a stale delete with the wrong run id is a no-op.
      await exec(
        `DELETE FROM controller_active_runs
         WHERE connector_instance_id = $1 AND run_id = $2`,
        [connectorId, runId],
      );
    },

    async simulateRestart() {
      // Drain the active-run registry inside one transaction:
      //   1. snapshot the abandoned rows
      //   2. delete them
      //   3. mark each previously-active run id as terminal-failed
      // Steps (2) and (3) together encode the reconciliation
      // obligation the harness asserts.
      await exec('BEGIN');
      try {
        const abandoned = await exec(
          `SELECT connector_id, run_id FROM controller_active_runs`,
        );
        for (const row of abandoned.rows) {
          await exec(
            `INSERT INTO terminal_failed_runs (run_id, connector_id, marked_at)
             VALUES ($1, $2, $3)
             ON CONFLICT (run_id) DO NOTHING`,
            [row.run_id, row.connector_id, nowIso()],
          );
        }
        await exec(`DELETE FROM controller_active_runs`);
        await exec('COMMIT');
      } catch (err) {
        await exec('ROLLBACK');
        throw err;
      }
    },

    async wasRunMarkedFailed(runId) {
      const res = await exec(
        `SELECT 1 FROM terminal_failed_runs WHERE run_id = $1`,
        [runId],
      );
      return res.rowCount > 0;
    },
  };
}

function rowToSchedule(row) {
  return {
    connector_instance_id: row.connector_instance_id,
    connector_id: row.connector_id,
    interval_seconds: Number(row.interval_seconds),
    jitter_seconds: Number(row.jitter_seconds),
    enabled: Boolean(row.enabled),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function rowToActiveRun(row) {
  return {
    connector_instance_id: row.connector_instance_id,
    connector_id: row.connector_id,
    run_id: row.run_id,
    trace_id: row.trace_id,
    scenario_id: row.scenario_id,
    started_at: toIso(row.started_at),
  };
}

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
