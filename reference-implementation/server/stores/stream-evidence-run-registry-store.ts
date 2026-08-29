// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Durable cross-invocation half of STREAM_EVIDENCE rule 5 ("at most one
 * accepted STREAM_EVIDENCE per stream per run_id").
 *
 * Independent exact-head re-review (STREAM-EVIDENCE-P1-2-EXACT-HEAD-REREVIEW.md)
 * found the prior in-memory `streamEvidenceSeenByRunId` Map
 * (runtime/index.ts) loses the same-run_id uniqueness fact on process
 * restart, while root profile rule 5 defines "same run" strictly by run_id
 * and grants no restart exception: a caller-chosen run_id reused across a
 * retry that spans a process restart would silently pass as unseen. This
 * store closes that gap by recording accepted facts in the same durable
 * database every other runtime-owned idempotency table
 * (`connector_detail_gaps`, `connector_coverage_horizons`) already lives
 * in, rather than introducing a second, ad hoc persistence mechanism this
 * deployment does not otherwise have.
 *
 * The primary key is EXACTLY `(run_id, stream)` — the scope
 * spec-collection-profile.md rule 5 defines "same run" over. The wire
 * protocol's guarantee is not connector/instance-scoped, so this store must
 * not narrow it to one; `connectorInstanceId` is recorded on each row for
 * operational lookups only and is never part of the uniqueness check.
 *
 * Single atomic claim operation, not check-then-mark: a separate
 * `hasStreamEvidenceForRunId()` followed by `markStreamEvidenceForRunId()`
 * is a TOCTOU race — two concurrent invocations for the same `(run_id,
 * stream)` could both observe "absent" before either marks, and both
 * would then accept. `claimStreamEvidenceForRunId` instead performs the
 * insert and reports, from the database's own authoritative row-count /
 * `RETURNING` result, whether THIS call won the claim; only the winner may
 * treat the STREAM_EVIDENCE as accepted. No TTL/reap: a forgotten run_id
 * must never become reusable, so rows are never deleted; growth is bounded
 * by legitimate accepted STREAM_EVIDENCE events, the same bound the prior
 * in-memory registry already accepted as safe (see runtime/index.ts's call
 * site doc comment for the estimate).
 */

import { execDynamicSqlAcknowledged } from "../../lib/db.ts";
import { isPostgresStorageBackend, postgresQuery } from "../postgres-storage.ts";

export interface StreamEvidenceRunRegistryStore {
  /**
   * Atomically claim `(runId, stream)` for this STREAM_EVIDENCE acceptance.
   * Returns `true` if THIS call performed the first-ever insert for the
   * pair (the caller may accept), `false` if a row already existed (the
   * caller MUST reject as a duplicate, per rule 5) — whether that row was
   * inserted by an earlier invocation, an earlier process lifetime, or a
   * concurrent call that raced this one and won.
   */
  claimStreamEvidenceForRunId: (connectorInstanceId: string, runId: string, stream: string) => Promise<boolean>;
}

export function createSqliteStreamEvidenceRunRegistryStore(): StreamEvidenceRunRegistryStore {
  return {
    // biome-ignore lint/suspicious/useAwait: The async signature is part of this store's cross-backend contract.
    async claimStreamEvidenceForRunId(connectorInstanceId, runId, stream) {
      // REVIEWED-DYNAMIC: idempotent insert into the store-owned registry
      // table. `changes` is better-sqlite3's authoritative row-count for
      // this exact statement, so `changes === 1` means THIS call's insert
      // is the one that landed — a concurrent racer's `INSERT OR IGNORE`
      // against the same primary key reports `changes === 0` instead of
      // throwing, which is exactly the atomic claim-or-lose signal needed.
      const result = execDynamicSqlAcknowledged(
        "INSERT OR IGNORE INTO stream_evidence_run_registry (connector_instance_id, run_id, stream) VALUES (?, ?, ?)",
        [connectorInstanceId, runId, stream]
      );
      return Number(result.changes || 0) === 1;
    },
  };
}

export function createPostgresStreamEvidenceRunRegistryStore(): StreamEvidenceRunRegistryStore {
  return {
    async claimStreamEvidenceForRunId(connectorInstanceId, runId, stream) {
      // `ON CONFLICT ... DO NOTHING RETURNING run_id` returns a row only
      // for the call whose insert actually landed; a concurrent racer that
      // hits the same primary key gets zero rows back, atomically.
      const result = await postgresQuery(
        "INSERT INTO stream_evidence_run_registry (connector_instance_id, run_id, stream) VALUES ($1, $2, $3) " +
          "ON CONFLICT (run_id, stream) DO NOTHING RETURNING run_id",
        [connectorInstanceId, runId, stream]
      );
      return result.rows.length === 1;
    },
  };
}

export function getDefaultStreamEvidenceRunRegistryStore(): StreamEvidenceRunRegistryStore {
  return isPostgresStorageBackend()
    ? createPostgresStreamEvidenceRunRegistryStore()
    : createSqliteStreamEvidenceRunRegistryStore();
}
