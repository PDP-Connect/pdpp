#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Requeue `too_large` terminal detail gaps whose impossibility proof is
 * FABRICATED — and only those.
 *
 * Why this tool exists separately from `requeue-quarantined-detail-gaps.ts`
 * -------------------------------------------------------------------------
 * That tool refuses `too_large` categorically, and correctly so: a `too_large`
 * row can carry durable per-item proof (an observed byte size recorded
 * strictly greater than the configured cap), and requeuing a genuinely 29 MB
 * attachment against a 25 MB cap can never converge — it would spin the
 * recovery budget forever re-confirming the same impossibility. That refusal
 * is a safety property, not an oversight, and this tool does not relax it.
 *
 * What it turned out to miss is that a `too_large` proof is forgeable by an
 * ordinary bug. Gmail's attachment hydrator briefly sized attachments from
 * imapflow's `meta.expectedSize`, which is populated from the FETCH
 * `RFC822.SIZE` item — the size of the ENTIRE MESSAGE, identical for every
 * part of a multipart message. Checking that message-scoped number against a
 * per-part cap condemned EVERY attachment of a message whenever their sum
 * crossed the cap. On the owner's mailbox that wrote 32 terminal rows sharing
 * only 7 distinct "observed" sizes, each ≈ the sum of that message's parts;
 * the smallest item so condemned was 3,080 bytes against a 26,214,400-byte
 * cap. The connector was fixed to use the per-part BODYSTRUCTURE size, but the
 * rows it had already written stayed terminal, and `isProvenUnfillableGap`
 * reads them as durable proof — so the owner is told those emails are
 * permanently unrecoverable when every one of them is collectible.
 *
 * The distinction this tool draws
 * -------------------------------
 * A row is requeued ONLY when its claimed size is affirmatively CONTRADICTED
 * by the item's own recorded size being within the cap. Concretely
 * (`classifyTooLargeProof` in `server/connector-gap-classification.ts`):
 *
 *   - `fabricated_proof`        → requeue. The proof is false.
 *   - `proof_holds`             → STAYS terminal. The item really is over the
 *                                 cap; the original refusal was right.
 *   - `no_corroborating_record` → STAYS terminal, reported separately. Absence
 *                                 of contradiction is NOT proof of
 *                                 fabrication; requeuing on missing evidence
 *                                 would be the same fabrication inverted.
 *   - `not_a_size_proof`        → STAYS terminal. No parseable numbers, so
 *                                 there is no size claim to adjudicate.
 *
 * So the invariant's PURPOSE is preserved exactly — anything actually proven
 * unfillable is still refused. What changes is that a proof which independent
 * evidence shows to be false is no longer honored.
 *
 * Why not re-introduce the removed commit 10ed92599 wholesale
 * -----------------------------------------------------------
 * That earlier bridge was a Gmail-locked remeasurement path that returned
 * "unproven" rows to recovery. It keyed off the ABSENCE of proof, which is the
 * weaker and more dangerous test: under it, a row with no corroborating record
 * requeues, and the genuinely-oversized rows here (which do carry real proof)
 * were only excluded incidentally. This tool instead requires positive
 * contradiction from the item's own durable size, so `no_corroborating_record`
 * and `proof_holds` both stay terminal for stated reasons rather than as a
 * side effect of how "unproven" happened to be defined. Restoring the old
 * bridge would also restore its own copy of the size-vs-cap parsing; the
 * adjudication here reuses the single shared parser the health projection
 * already trusts, so the repair tool and the classifier can never disagree.
 *
 * Scope + safety model
 * --------------------
 *   - Dry-run by default; `--apply` is required to write.
 *   - Locked to `--connector-id=gmail` and stream `attachments`: the
 *     corroborating size (`records.record_json->>'size_bytes'`) is an
 *     attachment-record shape, and this tool must not guess that shape for a
 *     connector whose records it has not been reasoned about.
 *   - Requires an explicit connector instance id.
 *   - Every write re-checks `status = 'terminal' AND reason = 'too_large'` and
 *     targets one gap id, so a row that changed underneath is skipped rather
 *     than clobbered.
 *   - Each requeued row keeps an audit trail in `last_error_json`
 *     (`class: "too_large_proof_contradicted"`) recording the claimed size,
 *     the cap, and the item's real size — the evidence that justified the
 *     repair, rather than silently erasing the row's history.
 *   - Prints counts and per-row verdicts only: gap ids, byte sizes, and
 *     stream names. No filenames, subjects, addresses, or record payloads.
 *
 * Usage:
 *   PDPP_DATABASE_URL=postgres://... \
 *   node reference-implementation/scripts/repair/requeue-fabricated-too-large-detail-gaps.ts \
 *     --connector-instance-id=cin_... \
 *     [--limit=100] [--apply]
 */

import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { classifyTooLargeProof, readClaimedSizeProof } from "../../server/connector-gap-classification.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../../server/postgres-storage.ts";

/** The only connector/stream pair whose corroborating record shape this tool understands. */
const SUPPORTED_CONNECTOR_ID = "gmail";
const SUPPORTED_STREAM = "attachments";
const TARGET_REASON = "too_large";

interface ParsedArgs {
  apply: boolean;
  connectorInstanceId: string | null;
  limit: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { apply: false, connectorInstanceId: null, limit: 100 };
  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      continue;
    }
    const eq = arg.indexOf("=");
    const key = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
    const value = eq > 0 ? arg.slice(eq + 1) : "";
    if (key === "apply") {
      out.apply = true;
    } else if (key === "connector-instance-id") {
      out.connectorInstanceId = value;
    } else if (key === "connector-id" && value && value !== SUPPORTED_CONNECTOR_ID) {
      out.connectorInstanceId = null;
    } else if (key === "limit") {
      const parsed = Number.parseInt(value, 10);
      out.limit = Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 500) : out.limit;
    }
  }
  return out;
}

/**
 * One candidate row joined to the item's own durable size. `recorded_size_bytes`
 * is null when no attachment record exists for the gap's record key — the
 * `no_corroborating_record` case, which is left terminal.
 */
interface CandidateRow {
  gap_id: string;
  last_error: unknown;
  record_key: string | null;
  recorded_size_bytes: string | number | null;
}

interface PostgresQueryResult<Row> {
  rows: Row[];
}

/**
 * Read every `too_large` terminal gap for the instance alongside the item's own
 * recorded size. The LEFT JOIN is deliberate: a gap with no matching record
 * must still surface, so it can be reported as `no_corroborating_record`
 * rather than silently dropped from the denominator.
 */
async function loadCandidates(connectorInstanceId: string): Promise<CandidateRow[]> {
  const result: PostgresQueryResult<CandidateRow> = await postgresQuery(
    `
      SELECT g.gap_id,
             g.record_key,
             g.last_error_json AS last_error,
             (r.record_json->>'size_bytes') AS recorded_size_bytes
      FROM connector_detail_gaps g
      LEFT JOIN records r
        ON r.connector_instance_id = g.connector_instance_id
       AND r.stream = g.stream
       AND r.record_key = g.record_key
       AND NOT r.deleted
      WHERE g.connector_id = $1
        AND g.connector_instance_id = $2
        AND g.stream = $3
        AND g.status = 'terminal'
        AND g.reason = $4
      ORDER BY g.gap_id
    `,
    [SUPPORTED_CONNECTOR_ID, connectorInstanceId, SUPPORTED_STREAM, TARGET_REASON]
  );
  return result.rows;
}

function toFiniteNumber(value: string | number | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

interface AdjudicatedRow {
  claimedBytes: number | null;
  gapId: string;
  limitBytes: number | null;
  recordedSizeBytes: number | null;
  verdict: ReturnType<typeof classifyTooLargeProof>;
}

/** Pure: decide each row's fate from its own proof and the item's real size. */
export function adjudicateCandidates(rows: readonly CandidateRow[]): AdjudicatedRow[] {
  return rows.map((row) => {
    const recordedSizeBytes = toFiniteNumber(row.recorded_size_bytes);
    const proof = readClaimedSizeProof({ last_error: row.last_error });
    return {
      claimedBytes: proof?.claimedBytes ?? null,
      gapId: row.gap_id,
      limitBytes: proof?.limitBytes ?? null,
      recordedSizeBytes,
      verdict: classifyTooLargeProof({ last_error: row.last_error }, recordedSizeBytes),
    };
  });
}

/**
 * Flip one contradicted row back to pending. The WHERE clause re-asserts the
 * full terminal identity so a row that changed since it was read is skipped,
 * never clobbered. `attempt_count` is reset so the row gets a fresh bounded
 * budget rather than resuming already-exhausted; the prior count survives in
 * the audit trail.
 */
async function requeueRow(row: AdjudicatedRow, now: string): Promise<boolean> {
  const result: PostgresQueryResult<{ gap_id: string }> = await postgresQuery(
    `
      UPDATE connector_detail_gaps
      SET status = 'pending',
          attempt_count = 0,
          next_attempt_after = NULL,
          last_error_json = jsonb_build_object(
            'class', 'too_large_proof_contradicted',
            'previous_class', last_error_json->>'class',
            'previous_reason', reason,
            'claimed_bytes', $2::bigint,
            'limit_bytes', $3::bigint,
            'recorded_size_bytes', $4::bigint,
            'requeued_at', $5::text
          ),
          reason = 'temporary_unavailable',
          updated_at = $5
      WHERE gap_id = $1 AND status = 'terminal' AND reason = $6
      RETURNING gap_id
    `,
    [row.gapId, row.claimedBytes, row.limitBytes, row.recordedSizeBytes, now, TARGET_REASON]
  );
  return result.rows.length === 1;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.connectorInstanceId) {
    console.error(
      `--connector-instance-id is required (and --connector-id, if given, must be '${SUPPORTED_CONNECTOR_ID}')`
    );
    process.exitCode = 2;
    return;
  }
  const databaseUrl = process.env.PDPP_DATABASE_URL || process.env.PDPP_TEST_POSTGRES_URL || null;
  if (!databaseUrl) {
    console.error("PDPP_DATABASE_URL is required");
    process.exitCode = 2;
    return;
  }

  await initPostgresStorage({ backend: "postgres", databaseUrl });
  try {
    const adjudicated = adjudicateCandidates(await loadCandidates(args.connectorInstanceId));
    const fabricated = adjudicated.filter((row) => row.verdict === "fabricated_proof");
    const selected = fabricated.slice(0, args.limit);

    let requeued = 0;
    if (args.apply) {
      const now = new Date().toISOString();
      for (const row of selected) {
        // biome-ignore lint/performance/noAwaitInLoops: each row is one bounded, independently-guarded UPDATE against production; sequential writes keep the applied count exact and the blast radius one row at a time, which matters far more here than overlapping I/O on at most a few dozen rows.
        if (await requeueRow(row, now)) {
          requeued += 1;
        }
      }
    }

    console.log(
      JSON.stringify(
        {
          applied: args.apply,
          connector_id: SUPPORTED_CONNECTOR_ID,
          connector_instance_id: args.connectorInstanceId,
          limit: args.limit,
          matched: adjudicated.length,
          reason: TARGET_REASON,
          requeued,
          rows: adjudicated.map((row) => ({
            claimed_bytes: row.claimedBytes,
            gap_id: row.gapId,
            limit_bytes: row.limitBytes,
            recorded_size_bytes: row.recordedSizeBytes,
            verdict: row.verdict,
          })),
          stream: SUPPORTED_STREAM,
          verdicts: {
            fabricated_proof: fabricated.length,
            no_corroborating_record: adjudicated.filter((row) => row.verdict === "no_corroborating_record").length,
            not_a_size_proof: adjudicated.filter((row) => row.verdict === "not_a_size_proof").length,
            proof_holds: adjudicated.filter((row) => row.verdict === "proof_holds").length,
          },
          would_requeue: fabricated.length,
        },
        null,
        2
      )
    );
  } finally {
    await closePostgresStorage();
  }
}

/** Best-effort cleanup on the error path; a secondary close failure never masks the original error. */
async function closePostgresStorageBestEffort(): Promise<void> {
  try {
    await closePostgresStorage();
  } catch {
    // Intentionally swallowed; the caller's original error is what surfaces.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(async (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    await closePostgresStorageBestEffort();
    process.exitCode = 1;
  });
}
