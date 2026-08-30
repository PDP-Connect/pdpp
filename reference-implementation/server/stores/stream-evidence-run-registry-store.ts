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
 * The claim row atomically carries the normalized terminal payload, its
 * digest, and the deterministic terminal event ID. This is what makes a
 * claim-before-terminal-event interruption recoverable without inventing
 * evidence from the incoming replay.
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

import { createHash } from "node:crypto";
import { execDynamicSqlAcknowledged, iterateDynamicSqlAcknowledged } from "../../lib/db.ts";
import { isPostgresStorageBackend, postgresQuery } from "../postgres-storage.ts";

export interface StreamEvidenceClaimPayload {
  /** The exact terminal-event payload, including provenance metadata. */
  readonly normalizedPayloadJson: string;
  readonly payloadDigest: string;
  /**
   * The accepted-fact identity. This deliberately excludes changing grant,
   * source, connector-instance, and connection metadata; those fields remain
   * provenance in `normalizedPayloadJson`, not replay identity.
   */
  readonly replayIdentityJson: string;
  readonly terminalEventId: string;
}

export interface StreamEvidenceClaim {
  readonly normalizedPayloadJson: string;
  readonly payloadDigest: string;
  readonly terminalEventId: string;
  readonly terminalEvidencePersisted: boolean;
}

export interface StreamEvidenceClaimResult {
  readonly claim: StreamEvidenceClaim;
  readonly claimed: boolean;
}

export interface StreamEvidenceRollbackGateStatus {
  readonly inFlightNewFormatClaims: number;
  readonly safe: boolean;
}

export function streamEvidencePayloadDigest(replayIdentityJson: string): string {
  return `sha256:${createHash("sha256").update(replayIdentityJson, "utf8").digest("hex")}`;
}

export function streamEvidenceTerminalEventId(runId: string, stream: string, payloadDigest: string): string {
  const identity = `${runId}\u0000${stream}\u0000${payloadDigest}`;
  return `evt_stream_evidence_${createHash("sha256").update(identity, "utf8").digest("hex")}`;
}

export class StreamEvidenceClaimIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamEvidenceClaimIntegrityError";
  }
}

function rollbackGateStatus(inFlightNewFormatClaims: number): StreamEvidenceRollbackGateStatus {
  return {
    inFlightNewFormatClaims,
    safe: inFlightNewFormatClaims === 0,
  };
}

interface StreamEvidenceClaimRow {
  readonly event_id: string | null;
  readonly payload_digest: string | null;
  readonly payload_json: string | null;
  readonly replay_identity_json: string | null;
}

function assertPayloadDigest(payload: StreamEvidenceClaimPayload): void {
  if (streamEvidencePayloadDigest(payload.replayIdentityJson) !== payload.payloadDigest) {
    throw new StreamEvidenceClaimIntegrityError(
      "STREAM_EVIDENCE claim payload digest mismatch: the supplied digest does not match the replay identity"
    );
  }
}

function assertTerminalEventId(runId: string, stream: string, payload: StreamEvidenceClaimPayload): void {
  if (streamEvidenceTerminalEventId(runId, stream, payload.payloadDigest) !== payload.terminalEventId) {
    throw new StreamEvidenceClaimIntegrityError(
      `STREAM_EVIDENCE terminal event identity mismatch for (run_id=${runId}, stream=${stream})`
    );
  }
}

function assertExistingClaimMatches(
  runId: string,
  stream: string,
  payload: StreamEvidenceClaimPayload,
  existing: StreamEvidenceClaimRow
): void {
  if (!(existing.payload_json && existing.payload_digest && existing.event_id)) {
    throw new StreamEvidenceClaimIntegrityError(
      `STREAM_EVIDENCE claim for (run_id=${runId}, stream=${stream}) has no recoverable normalized payload`
    );
  }
  if (streamEvidenceTerminalEventId(runId, stream, existing.payload_digest) !== existing.event_id) {
    throw new StreamEvidenceClaimIntegrityError(
      `STREAM_EVIDENCE stored terminal event identity mismatch for (run_id=${runId}, stream=${stream})`
    );
  }

  if (existing.replay_identity_json) {
    if (streamEvidencePayloadDigest(existing.replay_identity_json) !== existing.payload_digest) {
      throw new StreamEvidenceClaimIntegrityError(
        `STREAM_EVIDENCE claim for (run_id=${runId}, stream=${stream}) has an invalid replay identity digest`
      );
    }
    if (existing.payload_digest !== payload.payloadDigest) {
      throw new StreamEvidenceClaimIntegrityError(
        `STREAM_EVIDENCE claim digest mismatch for (run_id=${runId}, stream=${stream}); refusing divergent replay`
      );
    }
    return;
  }

  // Rows written by 14767dd predate the explicit replay identity. Preserve
  // exact replay for those rows, but never infer a new identity from a
  // key-only legacy row or silently reinterpret old provenance.
  if (streamEvidencePayloadDigest(existing.payload_json) !== existing.payload_digest) {
    throw new StreamEvidenceClaimIntegrityError(
      `STREAM_EVIDENCE claim for (run_id=${runId}, stream=${stream}) has an invalid pre-replay-identity digest`
    );
  }
  if (existing.payload_json !== payload.normalizedPayloadJson) {
    throw new StreamEvidenceClaimIntegrityError(
      `STREAM_EVIDENCE claim digest mismatch for (run_id=${runId}, stream=${stream}); refusing divergent replay`
    );
  }
}

function makeClaim(
  normalizedPayloadJson: string,
  payloadDigest: string,
  terminalEventId: string,
  terminalEvidencePersisted: boolean
): StreamEvidenceClaim {
  return {
    normalizedPayloadJson,
    payloadDigest,
    terminalEventId,
    terminalEvidencePersisted,
  };
}

export interface StreamEvidenceRunRegistryStore {
  /** Atomically insert the claim and its complete replay payload. */
  claimStreamEvidenceForRunId: (
    connectorInstanceId: string,
    runId: string,
    stream: string,
    payload: StreamEvidenceClaimPayload
  ) => Promise<StreamEvidenceClaimResult>;
  /**
   * Read an existing claim, including the payload needed to complete a
   * terminal-evidence write interrupted after the claim committed.
   */
  getStreamEvidenceClaim: (
    runId: string,
    stream: string,
    payload: StreamEvidenceClaimPayload
  ) => Promise<StreamEvidenceClaim | null>;
}

export function createSqliteStreamEvidenceRunRegistryStore(): StreamEvidenceRunRegistryStore {
  function getStreamEvidenceClaim(
    runId: string,
    stream: string,
    payload: StreamEvidenceClaimPayload
  ): StreamEvidenceClaim | null {
    assertPayloadDigest(payload);
    assertTerminalEventId(runId, stream, payload);
    const [existing] = [
      ...iterateDynamicSqlAcknowledged<StreamEvidenceClaimRow>(
        `SELECT payload_json, payload_digest, event_id, replay_identity_json
         FROM stream_evidence_run_registry
        WHERE run_id = ? AND stream = ?`,
        [runId, stream]
      ),
    ];
    if (!existing) {
      return null;
    }
    assertExistingClaimMatches(runId, stream, payload, existing);
    const [terminalEvent] = [
      ...iterateDynamicSqlAcknowledged<{
        event_type: string;
        run_id: string | null;
        stream_id: string | null;
      }>(
        `SELECT event_type, run_id, stream_id
         FROM spine_events
        WHERE event_id = ?`,
        [existing.event_id]
      ),
    ];
    if (
      terminalEvent &&
      (terminalEvent.event_type !== "run.stream_evidence_declared" ||
        terminalEvent.run_id !== runId ||
        terminalEvent.stream_id !== stream)
    ) {
      throw new StreamEvidenceClaimIntegrityError(
        `STREAM_EVIDENCE terminal event id collision for (run_id=${runId}, stream=${stream})`
      );
    }
    return makeClaim(
      existing.payload_json as string,
      existing.payload_digest as string,
      existing.event_id as string,
      Boolean(terminalEvent)
    );
  }

  return {
    // biome-ignore lint/suspicious/useAwait: The async signature is part of this store's cross-backend contract.
    async claimStreamEvidenceForRunId(connectorInstanceId, runId, stream, payload) {
      assertPayloadDigest(payload);
      assertTerminalEventId(runId, stream, payload);
      // REVIEWED-DYNAMIC: idempotent insert into the store-owned registry
      // table. `changes` is better-sqlite3's authoritative row-count for
      // this exact statement, so `changes === 1` means THIS call's insert
      // is the one that landed — a concurrent racer's `INSERT OR IGNORE`
      // against the same primary key reports `changes === 0` instead of
      // throwing, which is exactly the atomic claim-or-lose signal needed.
      const result = execDynamicSqlAcknowledged(
        "INSERT OR IGNORE INTO stream_evidence_run_registry (connector_instance_id, run_id, stream, payload_json, replay_identity_json, payload_digest, event_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          connectorInstanceId,
          runId,
          stream,
          payload.normalizedPayloadJson,
          payload.replayIdentityJson,
          payload.payloadDigest,
          payload.terminalEventId,
        ]
      );
      if (Number(result.changes || 0) === 1) {
        return {
          claim: makeClaim(payload.normalizedPayloadJson, payload.payloadDigest, payload.terminalEventId, false),
          claimed: true,
        };
      }
      const existing = getStreamEvidenceClaim(runId, stream, payload);
      if (!existing) {
        throw new StreamEvidenceClaimIntegrityError(
          `STREAM_EVIDENCE claim disappeared for (run_id=${runId}, stream=${stream})`
        );
      }
      return { claim: existing, claimed: false };
    },
    getStreamEvidenceClaim: async (runId, stream, payload) => getStreamEvidenceClaim(runId, stream, payload),
  };
}

/**
 * Rollback is safe only after the runtime is drained of recoverable claims
 * whose terminal event is not yet durable. A prior binary can preserve the
 * uniqueness row, but it cannot replay a payload written by this repair.
 * Legacy key-only rows are excluded: they are already spent and fail closed.
 */
export async function getStreamEvidenceRollbackGateStatus(): Promise<StreamEvidenceRollbackGateStatus> {
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM stream_evidence_run_registry r
        WHERE r.payload_json IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
              FROM spine_events e
             WHERE e.event_id = r.event_id
               AND e.event_type = 'run.stream_evidence_declared'
               AND e.run_id = r.run_id
               AND e.stream_id = r.stream
          )`
    );
    return rollbackGateStatus(Number(result.rows[0]?.count ?? 0));
  }

  const [row] = [
    ...iterateDynamicSqlAcknowledged<{ count: number }>(
      `SELECT COUNT(*) AS count
         FROM stream_evidence_run_registry r
        WHERE r.payload_json IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
              FROM spine_events e
             WHERE e.event_id = r.event_id
               AND e.event_type = 'run.stream_evidence_declared'
               AND e.run_id = r.run_id
               AND e.stream_id = r.stream
          )`
    ),
  ];
  return rollbackGateStatus(Number(row?.count ?? 0));
}

export function createPostgresStreamEvidenceRunRegistryStore(): StreamEvidenceRunRegistryStore {
  async function getStreamEvidenceClaim(
    runId: string,
    stream: string,
    payload: StreamEvidenceClaimPayload
  ): Promise<StreamEvidenceClaim | null> {
    assertPayloadDigest(payload);
    assertTerminalEventId(runId, stream, payload);
    const existing = await postgresQuery<StreamEvidenceClaimRow>(
      "SELECT payload_json, payload_digest, event_id, replay_identity_json FROM stream_evidence_run_registry WHERE run_id = $1 AND stream = $2",
      [runId, stream]
    );
    const [row] = existing.rows;
    if (!row) {
      return null;
    }
    assertExistingClaimMatches(runId, stream, payload, row);
    const terminalEvent = await postgresQuery<{
      event_type: string;
      run_id: string | null;
      stream_id: string | null;
    }>("SELECT event_type, run_id, stream_id FROM spine_events WHERE event_id = $1", [row.event_id]);
    const [event] = terminalEvent.rows;
    if (
      event &&
      (event.event_type !== "run.stream_evidence_declared" || event.run_id !== runId || event.stream_id !== stream)
    ) {
      throw new StreamEvidenceClaimIntegrityError(
        `STREAM_EVIDENCE terminal event id collision for (run_id=${runId}, stream=${stream})`
      );
    }
    return makeClaim(row.payload_json as string, row.payload_digest as string, row.event_id as string, Boolean(event));
  }

  return {
    async claimStreamEvidenceForRunId(connectorInstanceId, runId, stream, payload) {
      assertPayloadDigest(payload);
      assertTerminalEventId(runId, stream, payload);
      // `ON CONFLICT ... DO NOTHING RETURNING run_id` returns a row only
      // for the call whose insert actually landed; a concurrent racer that
      // hits the same primary key gets zero rows back, atomically.
      const result = await postgresQuery(
        "INSERT INTO stream_evidence_run_registry (connector_instance_id, run_id, stream, payload_json, replay_identity_json, payload_digest, event_id) VALUES ($1, $2, $3, $4, $5, $6, $7) " +
          "ON CONFLICT (run_id, stream) DO NOTHING RETURNING run_id",
        [
          connectorInstanceId,
          runId,
          stream,
          payload.normalizedPayloadJson,
          payload.replayIdentityJson,
          payload.payloadDigest,
          payload.terminalEventId,
        ]
      );
      if (result.rows.length === 1) {
        return {
          claim: makeClaim(payload.normalizedPayloadJson, payload.payloadDigest, payload.terminalEventId, false),
          claimed: true,
        };
      }
      const existing = await getStreamEvidenceClaim(runId, stream, payload);
      if (!existing) {
        throw new StreamEvidenceClaimIntegrityError(
          `STREAM_EVIDENCE claim disappeared for (run_id=${runId}, stream=${stream})`
        );
      }
      return { claim: existing, claimed: false };
    },
    getStreamEvidenceClaim,
  };
}

export function getDefaultStreamEvidenceRunRegistryStore(): StreamEvidenceRunRegistryStore {
  return isPostgresStorageBackend()
    ? createPostgresStreamEvidenceRunRegistryStore()
    : createSqliteStreamEvidenceRunRegistryStore();
}
