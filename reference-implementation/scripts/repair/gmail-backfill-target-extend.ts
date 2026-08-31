#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * gmail-backfill-target-extend
 *
 * Owner/operator-only repair for the Gmail "downtime-then-forward-resume" hole:
 * a UID band that neither the forward pass nor the historical backfill will
 * ever fetch, so the mail in it is missing permanently and silently.
 *
 * The defect
 * ----------
 * The Gmail connector keeps two independent UID cursors on the `messages`
 * stream (see `connectors/gmail/index.ts`):
 *
 *   all_mail.forward_uidnext   forward watermark; the next run fetches
 *                              `forward_uidnext:*` (selectAllMailFetchRange).
 *   backfill.target_uid        ceiling of the historical walk; the backfill
 *                              fetches `backfilled_through_uid+1 : target_uid`
 *                              (selectMessagesBackfillFetchRange).
 *
 * `target_uid` is frozen at the value it had when the backfill cursor was
 * first written — `advanceMessagesBackfillCursor` reads
 * `prior.target_uid ?? priorEnd` and never re-derives it from a live
 * `uidnext`. That freeze is correct for its purpose (it stops the historical
 * walk from chasing a moving mailbox forever), but it has an unguarded
 * consequence.
 *
 * The forward pass only advances when a run actually happens. If the
 * connector is down while mail arrives, those UIDs land BELOW the
 * `forward_uidnext` written by the first run after recovery, and ABOVE the
 * `target_uid` frozen by that same run. Both cursors step over the band:
 *
 *     UID:  1 .......... target_uid | ORPHANED | forward_uidnext ....... *
 *           \___ backfill walks ___/            \___ forward walks ___/
 *
 * Nothing ever fetches the middle. The connector still reports
 * `covered == considered` throughout, because it did process everything it
 * fetched — it simply never fetched this band. That is why no coverage,
 * continuity, or health gate flagged it.
 *
 * What this tool does
 * -------------------
 * Raises `backfill.target_uid` on the `messages` cursor so the already-running
 * historical walk continues past its frozen ceiling and through the orphaned
 * band, instead of stopping short of it.
 *
 * It is deliberately the smallest possible intervention:
 *
 *   - It RAISES `target_uid` only. The tool refuses to lower it.
 *   - It NEVER touches `backfilled_through_uid`, so in-flight backfill
 *     progress is preserved exactly (rewinding it would discard the work and
 *     re-walk the mailbox from the start).
 *   - It NEVER touches `forward_uidnext` or `highest_modseq`, so forward
 *     collection of new mail is unaffected.
 *   - It never triggers a run. The owner triggers the run explicitly
 *     afterwards, keeping the reset and the run separately auditable.
 *
 * Why re-collection is safe (idempotent)
 * --------------------------------------
 * `records` is keyed `UNIQUE(connector_instance_id, stream, record_key)` and
 * ingest upserts via `ON CONFLICT ... DO UPDATE`. A re-collected message that
 * is byte-identical to the stored row takes the `noop` disposition in
 * `writePostgresIngestMutation`'s caller: no version bump and no
 * `record_changes` row. So the walk crossing UIDs already collected costs
 * fetch time only — it cannot duplicate records or churn change history.
 *
 * Why it is bounded
 * -----------------
 * The extension is a UID interval, not a resync. The backfill continues to
 * consume it one bounded page per run (`PDPP_GMAIL_MESSAGES_BACKFILL_WINDOW_UIDS`,
 * default 500). Raising the ceiling adds exactly
 * `new_target_uid - old_target_uid` UIDs of work, no more.
 *
 * Safety model
 * ------------
 *   - Default is dry-run. `--apply` is required to write.
 *   - Apply mode acquires the SAME transaction-scoped connector-instance
 *     advisory lock (`pg_advisory_xact_lock` on
 *     `connectorInstanceAdvisoryLockKey(connectorInstanceId)`) that
 *     `commitTerminalRun`/`createPostgresConnectorStateStore().putState` take
 *     via `withPostgresTransaction({ lockConnectorInstanceId })`, as the
 *     FIRST statement after BEGIN — before the cursor read used to plan the
 *     extension and before the guarded write. This serializes the extend
 *     against D9 coalescence
 *     (`coalesceExactPostgresLocalDeviceBindingDuplicates`, which acquires
 *     the same lock class before merging) and against any other production
 *     writer of this connector instance's state, closing the race the prior
 *     revision of this tool explicitly accepted. See
 *     PR238-POSTGRES-D9-FIX-R5-0831.md.
 *   - Before any write, the prior `state_json` is snapshotted into a backup
 *     table (prefix `gbte_backup`) inside the same transaction as the update,
 *     after the lock is held.
 *   - The update is ALSO guarded in SQL so a concurrent connector STATE
 *     commit on the SAME instance cannot be clobbered: it re-checks that
 *     `target_uid` still holds the value that was read, and that the new
 *     target is strictly greater. The advisory lock and the CAS guard cover
 *     different things — the lock serializes against a DIFFERENT
 *     connector_instance_id's coalescence merge; the CAS guard catches a
 *     same-id write that lands between this tool's own read and write. Lock
 *     order: connector-instance lock first, CAS-guarded write second; no
 *     narrower lock is acquired before the connector-instance lock.
 *   - Refuses to run if the stored cursor has no `backfill.target_uid`, or if
 *     `uidvalidity` does not match the expected epoch (a UIDVALIDITY change
 *     invalidates every stored UID and calls for a full resync instead).
 *
 * Output discipline
 * -----------------
 * Cursor UIDs are mailbox positions, not record payloads, so they are printed
 * — they are exactly what the operator must review before applying. No message
 * content, subject, address, or record key is ever read or printed.
 *
 * Authorization is by direct database access — possession of
 * `PDPP_DATABASE_URL`, the same credential that grants owner-level access to
 * the reference Postgres. Postgres-only, matching the sibling repair tools.
 *
 * Usage:
 *   node reference-implementation/scripts/repair/gmail-backfill-target-extend.ts \
 *     --connector-instance-id=cin_... \
 *     --new-target-uid=324020 \
 *     [--expect-uidvalidity=1] [--apply]
 *
 * Env:
 *   PDPP_DATABASE_URL   required (postgres connection string).
 *                       PDPP_TEST_POSTGRES_URL is accepted as a fallback.
 *
 * Exit codes:
 *   0  dry-run completed, or apply completed successfully.
 *   1  apply failed, or preconditions not met (transaction rolled back).
 *   2  usage / configuration error.
 */

import { createHash } from "node:crypto";
import process from "node:process";
// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve this installed package export; Node and TypeScript resolve it.
import pg from "pg";
import {
  ConnectorInstanceAdmissionError,
  connectorInstanceAdvisoryLockKey,
  connectorInstanceLockWaitMs,
} from "../../server/connector-instance-write-coordinator.ts";

const { Pool } = pg;

// Postgres SQLSTATE raised when `SET LOCAL lock_timeout` expires waiting on
// `pg_advisory_xact_lock` — same translation as
// `acquireConnectorInstanceXactLock` in postgres-storage.ts.
const POSTGRES_LOCK_NOT_AVAILABLE_SQLSTATE = "55P03";

/**
 * Acquire the transaction-scoped connector-instance advisory lock, matching
 * `acquireConnectorInstanceXactLock` (postgres-storage.ts) exactly: same
 * derived key, same bounded `SET LOCAL lock_timeout` before the blocking
 * call, same `55P03` -> `ConnectorInstanceAdmissionError` translation. Must
 * be the first statement inside the transaction, before the cursor read
 * used to plan the extension, so this CLI's read-then-write serializes
 * against commitTerminalRun / putState / D9 coalescence exactly as if it
 * were another production writer.
 */
async function acquireConnectorInstanceLock(client: pg.PoolClient, connectorInstanceId: string): Promise<void> {
  const key = connectorInstanceAdvisoryLockKey(connectorInstanceId);
  await client.query(`SET LOCAL lock_timeout = '${connectorInstanceLockWaitMs()}ms'`);
  try {
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [key]);
  } catch (err) {
    if ((err as { code?: string } | null)?.code === POSTGRES_LOCK_NOT_AVAILABLE_SQLSTATE) {
      // biome-ignore lint/style/useErrorCause: matches ConnectorInstanceAdmissionError's existing no-arg constructor contract.
      throw new ConnectorInstanceAdmissionError();
    }
    throw err;
  }
}

const PG_IDENTIFIER_MAX = 63;

export const BACKUP_TABLE_PREFIX = "gbte_backup";

const MESSAGES_STREAM = "messages";

// Identifier helpers

/** Truncate any identifier for payload-free output (head...tail elision). */
export function truncateId(value: unknown): string {
  const s = String(value ?? "");
  if (s.length <= 16) {
    return s;
  }
  return `${s.slice(0, 8)}...${s.slice(-4)}`;
}

/**
 * Validate a token against a conservative identifier grammar so it is safe to
 * interpolate into a `CREATE TABLE` name. Parameters cannot be used for
 * identifiers, so the backup-table name is built from validated tokens only.
 */
export function sanitizeIdentifierToken(value: unknown, label: string): string {
  const s = String(value ?? "");
  const cleaned = s.replace(/[^A-Za-z0-9]/g, "_").toLowerCase();
  if (!cleaned || cleaned.length > 96) {
    throw new Error(`unsafe ${label} for backup-table name: ${JSON.stringify(value)}`);
  }
  return cleaned;
}

export interface BackupTableNameInput {
  connectorInstanceId: string;
  stamp: string;
}

/**
 * Compose a collision-safe backup-table name that stays within Postgres'
 * 63-byte identifier limit: `<prefix>_<hash8>__<cinFragment>__<stamp>`.
 */
export function backupTableName({ connectorInstanceId, stamp }: BackupTableNameInput): string {
  const cin = sanitizeIdentifierToken(connectorInstanceId, "connector-instance-id");
  const stmp = sanitizeIdentifierToken(stamp, "stamp");
  const hash8 = createHash("sha256")
    .update(JSON.stringify([cin, MESSAGES_STREAM, stmp]))
    .digest("hex")
    .slice(0, 8);
  const base = `${BACKUP_TABLE_PREFIX}_${hash8}`;
  const stampPart = stmp.slice(0, 16);
  const remaining = PG_IDENTIFIER_MAX - base.length - 4 - stampPart.length;
  const cinPart = remaining > 0 ? cin.slice(0, remaining) : "";
  const name = `${base}__${cinPart}__${stampPart}`;
  if (name.length > PG_IDENTIFIER_MAX) {
    throw new Error(`backup-table name exceeds ${PG_IDENTIFIER_MAX} bytes: ${name}`);
  }
  return name;
}

// Argument parsing

export interface ParsedArgs {
  apply: boolean;
  connectorInstanceId: string | null;
  expectUidvalidity: number | null;
  newTargetUid: number | null;
}

/** Parse argv into the tool's option record. */
export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    apply: false,
    connectorInstanceId: null,
    expectUidvalidity: null,
    newTargetUid: null,
  };
  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      continue;
    }
    const eq = arg.indexOf("=");
    const key = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
    const val = eq > 0 ? arg.slice(eq + 1) : "";
    if (key === "connector-instance-id") {
      out.connectorInstanceId = String(val);
    } else if (key === "new-target-uid") {
      out.newTargetUid = Number(val);
    } else if (key === "expect-uidvalidity") {
      out.expectUidvalidity = Number(val);
    } else if (key === "apply") {
      out.apply = true;
    }
  }
  return out;
}

/** Return a usage error string, or null when the args are well-formed. */
export function validateArgs(args: ParsedArgs): string | null {
  if (!args.connectorInstanceId) {
    return "--connector-instance-id is required";
  }
  if (args.newTargetUid === null || !Number.isSafeInteger(args.newTargetUid) || args.newTargetUid <= 0) {
    return "--new-target-uid must be a positive integer";
  }
  if (
    args.expectUidvalidity !== null &&
    (!Number.isSafeInteger(args.expectUidvalidity) || args.expectUidvalidity <= 0)
  ) {
    return "--expect-uidvalidity must be a positive integer when supplied";
  }
  return null;
}

// Cursor shape

interface MessagesCursor {
  all_mail?: {
    forward_uidnext?: number;
    highest_modseq?: number | string | null;
    uidnext?: number;
    uidvalidity?: number;
  };
  backfill?: {
    backfilled_through_uid?: number;
    completed_at?: string | null;
    target_uid?: number;
    uidvalidity?: number;
  };
}

export interface ExtendPlan {
  backfilledThroughUid: number;
  completedAt: string | null;
  forwardUidnext: number | null;
  newTargetUid: number;
  priorTargetUid: number;
  uidvalidity: number | null;
}

export interface ExtendResult {
  applied: boolean;
  backupTable: string | null;
  connectorInstanceId: string;
  error: string | null;
  failed: boolean;
  plan: ExtendPlan | null;
}

/**
 * Validate a stored cursor against the requested new target and return the
 * plan, or an error string explaining why the repair must not proceed.
 *
 * Pure: takes the decoded cursor, returns a decision. All preconditions that
 * decide whether the write is safe live here so they are directly testable.
 */
export function planExtend(args: {
  cursor: MessagesCursor | null;
  expectUidvalidity: number | null;
  newTargetUid: number;
}): { error: string } | { plan: ExtendPlan } {
  const { cursor } = args;
  if (!cursor) {
    return { error: "no stored `messages` cursor for this connector instance" };
  }
  const { backfill } = cursor;
  if (!backfill || typeof backfill.target_uid !== "number") {
    return {
      error: "stored `messages` cursor has no backfill.target_uid; nothing to extend (run a normal collection first)",
    };
  }
  const priorTargetUid = backfill.target_uid;
  const uidvalidity = typeof backfill.uidvalidity === "number" ? backfill.uidvalidity : null;
  if (args.expectUidvalidity !== null && uidvalidity !== args.expectUidvalidity) {
    return {
      error:
        `backfill.uidvalidity=${String(uidvalidity)} does not match --expect-uidvalidity=${args.expectUidvalidity}; ` +
        "refusing (a UIDVALIDITY change invalidates every stored UID — do a full resync instead)",
    };
  }
  if (args.newTargetUid <= priorTargetUid) {
    return {
      error:
        `--new-target-uid=${args.newTargetUid} does not raise the ceiling (stored target_uid=${priorTargetUid}); ` +
        "this tool only extends, never rewinds",
    };
  }
  const forwardUidnext = typeof cursor.all_mail?.forward_uidnext === "number" ? cursor.all_mail.forward_uidnext : null;
  if (forwardUidnext !== null && args.newTargetUid >= forwardUidnext) {
    return {
      error:
        `--new-target-uid=${args.newTargetUid} must stay below all_mail.forward_uidnext=${forwardUidnext}; ` +
        "at or above the forward watermark the two passes would overlap and re-walk new mail",
    };
  }
  return {
    plan: {
      backfilledThroughUid: typeof backfill.backfilled_through_uid === "number" ? backfill.backfilled_through_uid : 0,
      completedAt: backfill.completed_at ?? null,
      forwardUidnext,
      newTargetUid: args.newTargetUid,
      priorTargetUid,
      uidvalidity,
    },
  };
}

/** Parse a `connector_state.state_json` cell into the typed cursor shape (or null when absent). */
function decodeMessagesCursor(raw: unknown): MessagesCursor | null {
  // `state_json` is stored as text in some deployments and jsonb in others; the
  // driver hands back a string for the former and a decoded object for the latter.
  if (typeof raw === "string") {
    return JSON.parse(raw) as MessagesCursor;
  }
  if (raw !== null && raw !== undefined) {
    return raw as MessagesCursor;
  }
  return null;
}

/**
 * Read the cursor, plan the extension, and (with `apply`) write it under a
 * guard that fails rather than clobbering a concurrent STATE commit.
 */
export async function runExtend(args: {
  apply: boolean;
  connectorInstanceId: string;
  expectUidvalidity: number | null;
  newTargetUid: number;
  pool: pg.Pool;
  stamp: string;
}): Promise<ExtendResult> {
  const base: ExtendResult = {
    applied: args.apply,
    backupTable: null,
    connectorInstanceId: args.connectorInstanceId,
    error: null,
    failed: false,
    plan: null,
  };

  if (!args.apply) {
    // Dry-run never writes, so it never needs the advisory lock — it reads
    // outside any transaction, exactly like before.
    const read = await args.pool.query(
      "SELECT state_json FROM connector_state WHERE connector_instance_id = $1 AND stream = $2",
      [args.connectorInstanceId, MESSAGES_STREAM]
    );
    const cursor = decodeMessagesCursor(read.rows[0]?.state_json ?? null);
    const planned = planExtend({ cursor, expectUidvalidity: args.expectUidvalidity, newTargetUid: args.newTargetUid });
    if ("error" in planned) {
      return { ...base, error: planned.error, failed: true };
    }
    return { ...base, plan: planned.plan };
  }

  const table = backupTableName({ connectorInstanceId: args.connectorInstanceId, stamp: args.stamp });
  const client = await args.pool.connect();
  try {
    await client.query("BEGIN");

    // Acquire the connector-instance advisory lock FIRST — before the cursor
    // read used to build the plan, and before any write. This is the same
    // lock class commitTerminalRun/createPostgresConnectorStateStore()
    // .putState take via withPostgresTransaction({ lockConnectorInstanceId }),
    // and the same lock class coalesceExactPostgresLocalDeviceBindingDuplicates
    // acquires before merging a duplicate class. Reading the cursor only
    // after the lock is held (rather than before BEGIN, as dry-run does)
    // means the plan is always built against a value that cannot be
    // concurrently coalesced out from under this transaction. Global lock
    // order for this tool: connector-instance lock, then the cursor read,
    // then the backup snapshot, then the CAS-guarded write; no narrower lock
    // is acquired before the connector-instance lock.
    await acquireConnectorInstanceLock(client, args.connectorInstanceId);

    const read = await client.query(
      "SELECT state_json FROM connector_state WHERE connector_instance_id = $1 AND stream = $2",
      [args.connectorInstanceId, MESSAGES_STREAM]
    );
    const cursor = decodeMessagesCursor(read.rows[0]?.state_json ?? null);
    const planned = planExtend({ cursor, expectUidvalidity: args.expectUidvalidity, newTargetUid: args.newTargetUid });
    if ("error" in planned) {
      await client.query("ROLLBACK");
      return { ...base, error: planned.error, failed: true };
    }
    const { plan } = planned;

    // Snapshot the exact pre-image inside the same transaction as the write.
    await client.query(
      `CREATE TABLE IF NOT EXISTS "${table}" (
         connector_instance_id text NOT NULL,
         stream text NOT NULL,
         state_json jsonb NOT NULL,
         backed_up_at timestamptz NOT NULL DEFAULT now()
       )`
    );
    await client.query(
      `INSERT INTO "${table}" (connector_instance_id, stream, state_json)
       SELECT connector_instance_id, stream, state_json::jsonb
         FROM connector_state
        WHERE connector_instance_id = $1 AND stream = $2`,
      [args.connectorInstanceId, MESSAGES_STREAM]
    );
    // Guarded update: only raise target_uid, and only if it still holds the
    // value we planned against. A concurrent connector STATE commit on the
    // SAME id changes that value and this write then matches zero rows
    // rather than clobbering. This CAS guard is a second, narrower fence on
    // top of the connector-instance lock above — it catches a same-id write
    // that could otherwise land between this transaction's read and write
    // (e.g. a non-coalescence STATE commit that does not contend on the same
    // advisory-lock key ordering point); the advisory lock is what fences
    // cross-identity D9 coalescence.
    const updated = await client.query(
      `UPDATE connector_state
          SET state_json = jsonb_set(
                state_json::jsonb,
                '{backfill,target_uid}',
                to_jsonb($3::bigint),
                false
              )
        WHERE connector_instance_id = $1
          AND stream = $2
          AND (state_json::jsonb #>> '{backfill,target_uid}')::bigint = $4::bigint`,
      [args.connectorInstanceId, MESSAGES_STREAM, plan.newTargetUid, plan.priorTargetUid]
    );
    if (updated.rowCount !== 1) {
      await client.query("ROLLBACK");
      return {
        ...base,
        error:
          "guarded update matched no row — the stored target_uid changed between read and write " +
          "(a run committed concurrently); re-run to re-plan against the current cursor",
        failed: true,
        plan,
      };
    }
    await client.query("COMMIT");
    return { ...base, backupTable: table, plan };
  } catch (e) {
    await client.query("ROLLBACK").catch((): undefined => undefined);
    return { ...base, error: e instanceof Error ? e.message : String(e), failed: true, plan: null };
  } finally {
    client.release();
  }
}

/** Render a payload-free operator summary. */
export function formatSummary(result: ExtendResult): string {
  const lines: string[] = [];
  const mode = result.applied ? "APPLY" : "DRY-RUN";
  lines.push(`gmail-backfill-target-extend [${mode}]: cin=${truncateId(result.connectorInstanceId)}`);
  if (result.plan) {
    const p = result.plan;
    lines.push(`  uidvalidity            ${String(p.uidvalidity)}`);
    lines.push(`  backfilled_through_uid ${p.backfilledThroughUid}  (untouched)`);
    lines.push(`  forward_uidnext        ${String(p.forwardUidnext)}  (untouched)`);
    lines.push(`  target_uid             ${p.priorTargetUid} -> ${p.newTargetUid}`);
    lines.push(
      `  reopened UID band      ${p.priorTargetUid + 1}..${p.newTargetUid} (${p.newTargetUid - p.priorTargetUid} UIDs)`
    );
    if (p.completedAt !== null) {
      lines.push("  note: backfill was marked complete; raising the target reopens it and it will resume.");
    }
  }
  if (result.failed) {
    lines.push(`  REFUSED: ${result.error}`);
  } else if (result.applied) {
    lines.push(`  backup_table=${result.backupTable}`);
    lines.push(
      "  next: trigger a run (POST /v1/owner/connections/<cin>/run). The backfill consumes the " +
        "reopened band one bounded page per run; re-collected messages upsert as no-ops."
    );
  } else {
    lines.push("  (dry-run) re-run with --apply to extend the ceiling.");
  }
  return lines.join("\n");
}

// CLI

const invokedAsScript = process.argv[1]
  ? import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1])
  : false;

if (invokedAsScript) {
  await runCli();
}

async function runCli(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const validationError = validateArgs(args);
  if (validationError) {
    console.error(validationError);
    process.exit(2);
  }
  const databaseUrl = process.env.PDPP_DATABASE_URL || process.env.PDPP_TEST_POSTGRES_URL || null;
  if (!databaseUrl) {
    console.error("PDPP_DATABASE_URL is required");
    process.exit(2);
  }
  const connectorInstanceId = args.connectorInstanceId as string;
  const newTargetUid = args.newTargetUid as number;

  const stamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);

  const pool = new Pool({ connectionString: databaseUrl });
  let exitCode = 0;
  try {
    const result = await runExtend({
      apply: args.apply,
      connectorInstanceId,
      expectUidvalidity: args.expectUidvalidity,
      newTargetUid,
      pool,
      stamp,
    });
    console.log(formatSummary(result));
    exitCode = result.failed ? 1 : 0;
  } finally {
    await pool.end();
  }
  process.exit(exitCode);
}
