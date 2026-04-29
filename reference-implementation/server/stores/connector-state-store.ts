// ConnectorStateStore — production storage interface for owner- and
// grant-scoped connector sync state.
//
// Hides the (connector_state, grant_connector_state) table split and the
// JSON-encoded `state_json` column behind a small semantic surface. Callers
// hand in a scope and a stream-keyed map; they never see raw rows, prepared
// statements, table names, or the registered `referenceQueries.*` keys.
//
// The SQLite-backed implementation preserves the current
// `getSyncState`/`putSyncState` behavior verbatim:
//   - Owner-scoped state is keyed by `(connector_id, stream)`; grant-scoped
//     state is keyed by `(grant_id, connector_id, stream)`.
//   - Reads narrow to `allowedStreams` without deleting unmatched rows.
//   - The projection's `updated_at` is the max `updated_at` across all
//     surfaced streams; null when no rows match.
//
// This module deliberately does NOT touch records, disclosure spine,
// blobs, or any non-state surface. Records/search/spine extraction is a
// separate gate per design.md.

import { allowUnboundedReadAcknowledged, exec, referenceQueries } from "../../lib/db.ts";
import { getStorageBackendKind, isPostgresStorageBackend, postgresQuery } from "../postgres-storage.js";

export interface ConnectorStateScope {
  readonly connectorId: string;
  readonly grantId?: string | null;
}

export interface ConnectorStateReadOptions {
  readonly allowedStreams?: Iterable<string> | null;
}

export type ConnectorStateMap = Readonly<Record<string, unknown>>;

export interface ConnectorStateProjection {
  readonly connector_id: string;
  readonly grant_id: string | null;
  readonly object: "stream_state";
  readonly state: ConnectorStateMap;
  readonly updated_at: string | null;
}

export interface ConnectorStateStore {
  getState(scope: ConnectorStateScope, options?: ConnectorStateReadOptions): Promise<ConnectorStateProjection>;
  putState(scope: ConnectorStateScope, stateByStream: ConnectorStateMap): Promise<ConnectorStateProjection>;
}

interface SyncStateRow {
  readonly state_json: string;
  readonly stream: string;
  readonly updated_at: string;
}

function normalizeAllowedStreams(allowed: Iterable<string> | null | undefined): Set<string> | null {
  if (!allowed) {
    return null;
  }
  if (allowed instanceof Set) {
    return allowed as Set<string>;
  }
  return new Set(allowed);
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createSqliteConnectorStateStore(): ConnectorStateStore {
  function getStateSync(scope: ConnectorStateScope, options: ConnectorStateReadOptions = {}): ConnectorStateProjection {
    const { connectorId } = scope;
    const grantId = scope.grantId ?? null;
    const allowedStreamSet = normalizeAllowedStreams(options.allowedStreams);

    // REVIEWED-BOUNDED: rows are one per (connector, [grant], stream); a
    // connector's manifest declares at most a few dozen streams.
    const rows = grantId
      ? allowUnboundedReadAcknowledged<SyncStateRow>(referenceQueries.recordsSyncStateListGrantConnectorState, [
          connectorId,
          grantId,
        ])
      : allowUnboundedReadAcknowledged<SyncStateRow>(referenceQueries.recordsSyncStateListConnectorState, [
          connectorId,
        ]);

    const state: { [stream: string]: unknown } = {};
    let updatedAt: string | null = null;
    for (const row of rows) {
      if (allowedStreamSet && !allowedStreamSet.has(row.stream)) {
        continue;
      }
      state[row.stream] = JSON.parse(row.state_json);
      if (!updatedAt || row.updated_at > updatedAt) {
        updatedAt = row.updated_at;
      }
    }

    return {
      object: "stream_state",
      connector_id: connectorId,
      grant_id: grantId,
      state,
      updated_at: updatedAt,
    };
  }

  function putStateSync(scope: ConnectorStateScope, stateByStream: ConnectorStateMap): ConnectorStateProjection {
    const { connectorId } = scope;
    const grantId = scope.grantId ?? null;
    const now = nowIso();

    for (const [stream, cursor] of Object.entries(stateByStream)) {
      if (grantId) {
        exec(referenceQueries.recordsSyncStateUpsertGrantConnectorState, [
          grantId,
          connectorId,
          stream,
          JSON.stringify(cursor),
          now,
        ]);
        continue;
      }
      exec(referenceQueries.recordsSyncStateUpsertConnectorState, [connectorId, stream, JSON.stringify(cursor), now]);
    }

    return getStateSync({ connectorId, grantId });
  }

  return {
    getState: (scope, options) => Promise.resolve(getStateSync(scope, options)),
    putState: (scope, stateByStream) => Promise.resolve(putStateSync(scope, stateByStream)),
  };
}

export function createPostgresConnectorStateStore(): ConnectorStateStore {
  async function getState(
    scope: ConnectorStateScope,
    options: ConnectorStateReadOptions = {}
  ): Promise<ConnectorStateProjection> {
    const { connectorId } = scope;
    const grantId = scope.grantId ?? null;
    const allowedStreamSet = normalizeAllowedStreams(options.allowedStreams);
    const result = grantId
      ? await postgresQuery(
          `SELECT stream, state_json, updated_at
           FROM grant_connector_state
           WHERE connector_id = $1 AND grant_id = $2
           ORDER BY stream`,
          [connectorId, grantId]
        )
      : await postgresQuery(
          `SELECT stream, state_json, updated_at
           FROM connector_state
           WHERE connector_id = $1
           ORDER BY stream`,
          [connectorId]
        );

    const state: { [stream: string]: unknown } = {};
    let updatedAt: string | null = null;
    for (const row of result.rows as Array<{ stream: string; state_json: unknown; updated_at: string }>) {
      if (allowedStreamSet && !allowedStreamSet.has(row.stream)) {
        continue;
      }
      state[row.stream] = row.state_json;
      if (!updatedAt || row.updated_at > updatedAt) {
        updatedAt = row.updated_at;
      }
    }

    return {
      object: "stream_state",
      connector_id: connectorId,
      grant_id: grantId,
      state,
      updated_at: updatedAt,
    };
  }

  return {
    getState,
    async putState(scope, stateByStream) {
      const { connectorId } = scope;
      const grantId = scope.grantId ?? null;
      const now = nowIso();
      for (const [stream, cursor] of Object.entries(stateByStream)) {
        if (grantId) {
          await postgresQuery(
            `INSERT INTO grant_connector_state(grant_id, connector_id, stream, state_json, updated_at)
             VALUES($1, $2, $3, $4::jsonb, $5)
             ON CONFLICT (grant_id, connector_id, stream) DO UPDATE
               SET state_json = EXCLUDED.state_json,
                   updated_at = EXCLUDED.updated_at`,
            [grantId, connectorId, stream, JSON.stringify(cursor), now]
          );
          continue;
        }
        await postgresQuery(
          `INSERT INTO connector_state(connector_id, stream, state_json, updated_at)
           VALUES($1, $2, $3::jsonb, $4)
           ON CONFLICT (connector_id, stream) DO UPDATE
             SET state_json = EXCLUDED.state_json,
                 updated_at = EXCLUDED.updated_at`,
          [connectorId, stream, JSON.stringify(cursor), now]
        );
      }
      return getState({ connectorId, grantId });
    },
  };
}

export function createConnectorStateStore(): ConnectorStateStore {
  return isPostgresStorageBackend() ? createPostgresConnectorStateStore() : createSqliteConnectorStateStore();
}

let defaultStore: ConnectorStateStore | null = null;
let defaultStoreBackend: string | null = null;

export function getDefaultConnectorStateStore(): ConnectorStateStore {
  const backend = getStorageBackendKind();
  if (!defaultStore || defaultStoreBackend !== backend) {
    defaultStore = createConnectorStateStore();
    defaultStoreBackend = backend;
  }
  return defaultStore;
}
