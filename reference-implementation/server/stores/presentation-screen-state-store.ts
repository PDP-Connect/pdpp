// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { getDb } from "../db.js";
import { isPostgresStorageBackend, postgresQuery } from "../postgres-storage.js";

export interface PresentationScreenConfiguration {
  readonly height: number;
  readonly rate?: number;
  readonly width: number;
}

export interface UnrestoredPresentationScreen {
  readonly baseline: PresentationScreenConfiguration;
  readonly browserSessionId: string;
  readonly capturedAt: string;
  readonly leaseId: string | null;
  readonly surfaceId: string;
}

export interface PresentationScreenStateStore {
  captureBaseline(record: UnrestoredPresentationScreen): Promise<void> | void;
  listUnrestored(): Promise<readonly UnrestoredPresentationScreen[]> | readonly UnrestoredPresentationScreen[];
  markRecycled(browserSessionId: string, recycledAt: string): Promise<void> | void;
  markRestored(browserSessionId: string, restoredAt: string): Promise<void> | void;
}

interface Row {
  readonly baseline_json: string | Record<string, unknown>;
  readonly browser_session_id: string;
  readonly captured_at: string;
  readonly lease_id: string | null;
  readonly surface_id: string;
}

function configuration(value: unknown): PresentationScreenConfiguration | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const width = Number(candidate.width);
  const height = Number(candidate.height);
  const rate = candidate.rate == null ? undefined : Number(candidate.rate);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    return null;
  }
  if (rate !== undefined && (!Number.isFinite(rate) || rate <= 0)) {
    return null;
  }
  return { width, height, ...(rate === undefined ? {} : { rate }) };
}

function rowToRecord(row: Row): UnrestoredPresentationScreen | null {
  let baseline: unknown = row.baseline_json;
  if (typeof baseline === "string") {
    try {
      baseline = JSON.parse(baseline);
    } catch {
      return null;
    }
  }
  const normalized = configuration(baseline);
  if (!normalized) {
    return null;
  }
  return {
    browserSessionId: row.browser_session_id,
    capturedAt: row.captured_at,
    leaseId: row.lease_id,
    surfaceId: row.surface_id,
    baseline: normalized,
  };
}

function assertRecord(record: UnrestoredPresentationScreen): UnrestoredPresentationScreen {
  const hasIdentity = Boolean(record.browserSessionId && record.surfaceId && record.capturedAt);
  const baseline = configuration(record.baseline);
  if (!(hasIdentity && baseline)) {
    throw new Error("presentation screen baseline record is invalid");
  }
  return { ...record, baseline };
}

export function createPresentationScreenStateStore(): PresentationScreenStateStore {
  if (isPostgresStorageBackend()) {
    return {
      async captureBaseline(record) {
        const valid = assertRecord(record);
        await postgresQuery(
          `INSERT INTO presentation_screen_states(
             browser_session_id, surface_id, lease_id, baseline_json, captured_at, resolved_at, resolution
           ) VALUES($1, $2, $3, $4::jsonb, $5, NULL, NULL)
           ON CONFLICT(browser_session_id) DO NOTHING`,
          [valid.browserSessionId, valid.surfaceId, valid.leaseId, JSON.stringify(valid.baseline), valid.capturedAt]
        );
      },
      async listUnrestored() {
        const result = await postgresQuery(
          `SELECT browser_session_id, surface_id, lease_id, baseline_json, captured_at
           FROM presentation_screen_states WHERE resolution IS NULL ORDER BY captured_at ASC`
        );
        return (result.rows as Row[])
          .map(rowToRecord)
          .filter((row): row is UnrestoredPresentationScreen => row !== null);
      },
      async markRecycled(browserSessionId, recycledAt) {
        await postgresQuery(
          `UPDATE presentation_screen_states SET resolved_at = $2, resolution = 'recycled'
           WHERE browser_session_id = $1 AND resolution IS NULL`,
          [browserSessionId, recycledAt]
        );
      },
      async markRestored(browserSessionId, restoredAt) {
        await postgresQuery(
          `UPDATE presentation_screen_states SET resolved_at = $2, resolution = 'restored'
           WHERE browser_session_id = $1 AND resolution IS NULL`,
          [browserSessionId, restoredAt]
        );
      },
    };
  }

  return {
    captureBaseline(record) {
      const valid = assertRecord(record);
      getDb()
        .prepare(
          `INSERT INTO presentation_screen_states(
             browser_session_id, surface_id, lease_id, baseline_json, captured_at, resolved_at, resolution
           ) VALUES(?, ?, ?, ?, ?, NULL, NULL)
           ON CONFLICT(browser_session_id) DO NOTHING`
        )
        .run(valid.browserSessionId, valid.surfaceId, valid.leaseId, JSON.stringify(valid.baseline), valid.capturedAt);
    },
    listUnrestored() {
      return getDb()
        .prepare(
          `SELECT browser_session_id, surface_id, lease_id, baseline_json, captured_at
           FROM presentation_screen_states WHERE resolution IS NULL ORDER BY captured_at ASC`
        )
        .all()
        .map(rowToRecord)
        .filter((row: UnrestoredPresentationScreen | null): row is UnrestoredPresentationScreen => row !== null);
    },
    markRecycled(browserSessionId, recycledAt) {
      getDb()
        .prepare(
          `UPDATE presentation_screen_states SET resolved_at = ?, resolution = 'recycled' WHERE browser_session_id = ? AND resolution IS NULL`
        )
        .run(recycledAt, browserSessionId);
    },
    markRestored(browserSessionId, restoredAt) {
      getDb()
        .prepare(
          `UPDATE presentation_screen_states SET resolved_at = ?, resolution = 'restored' WHERE browser_session_id = ? AND resolution IS NULL`
        )
        .run(restoredAt, browserSessionId);
    },
  };
}
