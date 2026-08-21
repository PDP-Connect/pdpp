// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
 *     each drained run id into a private `terminal_abandoned_runs` table;
 *     `wasRunAdjudicatedAbandoned(runId)` reads from that table. There is no
 *     coupling to the SQLite reference's spine schema. The harness
 *     contract only requires that `wasRunAdjudicatedAbandoned` reports `true`
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

// biome-ignore lint/correctness/noUnresolvedImports: Biome resolver lacks this runtime-supported dependency export shape.
import pg from "pg";

const REGEXP_1 = /^[a-z0-9_]+$/;

const { Client } = pg;

const SCHEMA_PREFIX = "pdpp_proof_";
type PgParam = string | number | boolean | null | Date;
interface StateScope {
  connectorId: string;
  grantId?: string | null;
}
interface StateByStream {
  [stream: string]: Record<string, unknown>;
}
interface SchedulePatch {
  enabled?: boolean;
  interval_seconds: number;
  jitter_seconds?: number;
}
interface ActiveRunInput {
  runGeneration?: number;
  runId: string;
  scenarioId: string;
  startedAt: string;
  traceId: string;
}
interface PgRow {
  [key: string]: unknown;
}

function uniqueSchemaName() {
  // Schema names must be valid PostgreSQL identifiers; restrict to
  // lowercase hex.
  const stamp = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 1e8).toString(36);
  return `${SCHEMA_PREFIX}${stamp}_${rand}`.toLowerCase().replace(/[^a-z0-9_]/g, "");
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * @param {object} options
 * @param {string} options.connectionString  e.g. PDPP_TEST_POSTGRES_URL
 */
export function createPostgresConnectorStateSchedulerDriver({ connectionString }: { connectionString: string }) {
  if (!connectionString) {
    throw new Error("createPostgresConnectorStateSchedulerDriver requires connectionString");
  }

  const schema = uniqueSchemaName();
  let client: InstanceType<typeof Client> | null = null;

  /**
   * Quote an identifier for safe interpolation into DDL where parameter
   * binding is not available (CREATE SCHEMA, SET search_path, table
   * names). The `schema` value comes from `uniqueSchemaName`, which
   * already restricts to `[a-z0-9_]+`, so this is defense-in-depth.
   */
  function q(ident: string): string {
    if (!REGEXP_1.test(ident)) {
      throw new Error(`unsafe identifier rejected: ${ident}`);
    }
    return `"${ident}"`;
  }

  async function exec(sql: string, params: PgParam[] = []): Promise<{ rows: PgRow[]; rowCount: number }> {
    const result = await client?.query<PgRow>(sql, params);
    if (!result) {
      throw new Error("Postgres scheduler driver has not been set up");
    }
    return { rowCount: result.rowCount ?? 0, rows: result.rows };
  }

  return {
    async deleteActiveRun(connectorId: string, runId: string) {
      // Guarded delete: row only goes away if both instance and run id
      // match, so a stale delete with the wrong run id is a no-op.
      await exec(
        `DELETE FROM controller_active_runs
         WHERE connector_instance_id = $1 AND run_id = $2`,
        [connectorId, runId]
      );
    },

    async deleteSchedule(connectorId: string) {
      const res = await exec("DELETE FROM connector_schedules WHERE connector_instance_id = $1", [connectorId]);
      return res.rowCount > 0;
    },

    async getActiveRun(connectorId: string) {
      const res = await exec(
        `SELECT connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at, run_generation
         FROM controller_active_runs WHERE connector_instance_id = $1`,
        [connectorId]
      );
      return res.rows[0] ? rowToActiveRun(res.rows[0]) : null;
    },

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Conformance fixture keeps the complete protocol case matrix local.
    async getConnectorState(scope: StateScope, opts: { allowedStreams?: string[] } = {}) {
      // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
      const connectorId = scope.connectorId;
      const grantId = scope.grantId || null;
      const allowedStreams = Array.isArray(opts.allowedStreams) ? opts.allowedStreams : null;

      const result =
        grantId === null
          ? await exec(
              `SELECT stream, state, updated_at
             FROM connector_state
             WHERE connector_id = $1 AND grant_id IS NULL`,
              [connectorId]
            )
          : await exec(
              `SELECT stream, state, updated_at
             FROM connector_state
             WHERE connector_id = $1 AND grant_id = $2`,
              [connectorId, grantId]
            );

      const allowedSet = allowedStreams ? new Set(allowedStreams) : null;
      const state: Record<string, Record<string, unknown>> = {};
      // biome-ignore lint/suspicious/noEvolvingTypes: Accumulator evolves through deliberately heterogeneous fixture data.
      let updatedAt = null;
      for (const row of result.rows) {
        if (allowedSet && !allowedSet.has(String(row.stream))) {
          continue;
        }
        // pg returns jsonb as parsed JS values directly.
        const value = row.state;
        state[String(row.stream)] = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
        const iso = row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at);
        if (!updatedAt || iso > updatedAt) {
          updatedAt = iso;
        }
      }
      return {
        connector_id: connectorId,
        grant_id: grantId,
        object: "stream_state",
        state,
        updated_at: updatedAt,
      };
    },

    async getSchedule(connectorId: string) {
      const res = await exec(
        `SELECT connector_instance_id, connector_id, interval_seconds, jitter_seconds, enabled,
                created_at, updated_at
         FROM connector_schedules WHERE connector_instance_id = $1`,
        [connectorId]
      );
      return res.rows[0] ? rowToSchedule(res.rows[0]) : null;
    },

    async insertActiveRun(connectorId: string, run: ActiveRunInput) {
      // Fail closed on duplicate connector-instance admission. The
      // harness explicitly tolerates either throw OR no-op as long as
      // the registry never holds the replaced row, so we let the SQL
      // preserve the incumbent row.
      const result = await exec(
        `INSERT INTO controller_active_runs
           (connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at, run_generation)
         VALUES ($1, $1, $2, $3, $4, $5, $6)
         ON CONFLICT (connector_instance_id) DO NOTHING`,
        [connectorId, run.runId, run.traceId, run.scenarioId, run.startedAt, run.runGeneration ?? 1]
      );
      return result.rowCount > 0;
    },

    async listActiveRuns() {
      const res = await exec(
        `SELECT connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at, run_generation
         FROM controller_active_runs`
      );
      return res.rows.map(rowToActiveRun);
    },

    async listSchedules() {
      const res = await exec(
        `SELECT connector_instance_id, connector_id, interval_seconds, jitter_seconds, enabled,
                created_at, updated_at
         FROM connector_schedules`
      );
      return res.rows.map(rowToSchedule);
    },

    async putConnectorState(scope: StateScope, stateByStream: StateByStream) {
      // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
      const connectorId = scope.connectorId;
      const grantId = scope.grantId || null;
      const now = nowIso();

      // Postgres infers the partial unique index from the conflict
      // tuple plus the predicate. Because Postgres treats each NULL
      // grant_id as distinct, we cannot rely on a non-partial index;
      // the predicate is what makes the inference unambiguous.
      for (const [stream, cursor] of Object.entries(stateByStream)) {
        if (grantId === null) {
          // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
          await exec(
            `
            INSERT INTO connector_state (connector_id, grant_id, stream, state, updated_at)
            VALUES ($1, NULL, $2, $3::jsonb, $4)
            ON CONFLICT (connector_id, stream) WHERE grant_id IS NULL
            DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at
            `,
            [connectorId, stream, JSON.stringify(cursor), now]
          );
        } else {
          await exec(
            `
            INSERT INTO connector_state (connector_id, grant_id, stream, state, updated_at)
            VALUES ($1, $2, $3, $4::jsonb, $5)
            ON CONFLICT (connector_id, grant_id, stream) WHERE grant_id IS NOT NULL
            DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at
            `,
            [connectorId, grantId, stream, JSON.stringify(cursor), now]
          );
        }
      }

      return this.getConnectorState(scope);
    },

    async setScheduleEnabled(connectorId: string, enabled: boolean) {
      const now = nowIso();
      const res = await exec(
        `UPDATE connector_schedules
         SET enabled = $2, updated_at = $3
         WHERE connector_instance_id = $1
         RETURNING connector_instance_id, connector_id, interval_seconds, jitter_seconds, enabled,
                   created_at, updated_at`,
        [connectorId, enabled, now]
      );
      if (res.rowCount === 0) {
        throw new Error(`Schedule not found for connector: ${connectorId}`);
      }
      const [row] = res.rows;
      if (!row) {
        throw new Error(`Schedule update returned no row for connector: ${connectorId}`);
      }
      return rowToSchedule(row);
    },
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
          started_at TIMESTAMPTZ NOT NULL,
          run_generation INTEGER NOT NULL DEFAULT 1
        )
      `);

      // Abandonment-verdict marker table: this driver's local equivalent
      // of "spine emitted a run.abandoned event". The harness only looks
      // through `wasRunAdjudicatedAbandoned(runId)`, so the contract here is
      // bounded to that lifecycle.
      await exec(`
        CREATE TABLE terminal_abandoned_runs (
          run_id TEXT PRIMARY KEY,
          connector_id TEXT NOT NULL,
          marked_at TIMESTAMPTZ NOT NULL
        )
      `);
    },

    async simulateRestart() {
      // Drain the active-run registry inside one transaction:
      //   1. snapshot the abandoned rows
      //   2. delete them
      //   3. mark each previously-active run id as terminal-abandoned
      // Steps (2) and (3) together encode the reconciliation
      // obligation the harness asserts.
      await exec("BEGIN");
      try {
        const abandoned = await exec("SELECT connector_id, run_id FROM controller_active_runs");
        for (const row of abandoned.rows) {
          // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
          await exec(
            `INSERT INTO terminal_abandoned_runs (run_id, connector_id, marked_at)
             VALUES ($1, $2, $3)
             ON CONFLICT (run_id) DO NOTHING`,
            [String(row.run_id), String(row.connector_id), nowIso()]
          );
        }
        await exec("DELETE FROM controller_active_runs");
        await exec("COMMIT");
      } catch (err) {
        await exec("ROLLBACK");
        throw err;
      }
    },

    async teardown() {
      if (!client) {
        return;
      }
      try {
        await exec(`DROP SCHEMA ${q(schema)} CASCADE`);
      } finally {
        await client.end();
        client = null;
      }
    },

    async upsertSchedule(connectorId: string, patch: SchedulePatch) {
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
        [connectorId, interval, jitter, enabled, now]
      );
      const [row] = res.rows;
      if (!row) {
        throw new Error(`Schedule upsert returned no row for connector: ${connectorId}`);
      }
      return rowToSchedule(row);
    },

    async wasRunAdjudicatedAbandoned(runId: string) {
      const res = await exec("SELECT 1 FROM terminal_abandoned_runs WHERE run_id = $1", [runId]);
      return res.rowCount > 0;
    },
  };
}

function rowToSchedule(row: PgRow) {
  return {
    connector_id: String(row.connector_id),
    connector_instance_id: String(row.connector_instance_id),
    created_at: toIso(row.created_at),
    enabled: Boolean(row.enabled),
    interval_seconds: Number(row.interval_seconds),
    jitter_seconds: Number(row.jitter_seconds),
    updated_at: toIso(row.updated_at),
  };
}

function rowToActiveRun(row: PgRow) {
  return {
    connector_id: String(row.connector_id),
    connector_instance_id: String(row.connector_instance_id),
    run_generation: typeof row.run_generation === "number" ? row.run_generation : 1,
    run_id: String(row.run_id),
    scenario_id: String(row.scenario_id),
    started_at: toIso(row.started_at),
    trace_id: String(row.trace_id),
  };
}

function toIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}
