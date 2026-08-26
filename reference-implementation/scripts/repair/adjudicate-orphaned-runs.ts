#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * adjudicate-orphaned-runs
 *
 * Owner/operator-only tool that writes the missing terminal event for
 * `run.started` events which no process will ever report on again, emitting
 * `run.abandoned` with the same reason and provenance shape the boot
 * reconciler uses.
 *
 * Why this tool exists
 * --------------------
 * `resolveControllerId` used to fall back to `os.hostname()`, which under
 * Docker is the container ID and is fresh on every `docker run`. The boot
 * reconciler adjudicates only orphans whose `controller_id` matches its own,
 * so after any container replacement it matched nothing. Every run a prior
 * container left in flight became permanently non-terminal.
 *
 * The identity fix stops the bleeding, but it cannot heal the backlog: those
 * runs are stamped with container ids that no future boot will ever carry
 * again, so the reconciler's ownership filter will keep skipping them
 * forever. This is the one-shot pass that adjudicates them, deliberately
 * ignoring `controller_id` because on a single-controller deployment every
 * orphan is ours by construction.
 *
 * Why `run.abandoned` and not `run.failed`
 * ----------------------------------------
 * These runs are not known to have failed. Nobody knows what happened to
 * them -- the process that could have said died without saying. `failed` on
 * a bank connector means "ask the human"; `abandoned` means "nobody knows;
 * the normal schedule will pick it up". Collapsing the two is what wakes an
 * owner at 3am for a deploy. The distinction is the same one Kubernetes
 * draws between a condition that is `False` and one that is `Unknown`.
 *
 * That distinction is not academic here: of the 134 runs the older
 * controller path recorded as `run.failed`/`controller_restarted`, 55 had
 * staged a cursor and 34 had durably ingested a batch before being written
 * down as plain failures.
 *
 * What it does NOT do
 * -------------------
 *   - It never re-runs or re-queues anything. `chase`, `usaa`, `venmo`,
 *     `heb`, `amazon` and `reddit` need an interactive human sign-in; an
 *     automatic retry would either wake the owner or trip a provider rate
 *     limit. Adjudication is silent by design and lets the normal schedule
 *     pick the work up.
 *   - It never touches `records`, and it never revises `records_emitted`.
 *     Records validly ingested before the process died stay committed.
 *   - It never deletes or edits an existing event. The spine is append-only;
 *     this only adds terminal events where none exist.
 *
 * Safety model
 * ------------
 *   - Default is dry-run. `--apply` is required to write.
 *   - The full scope is planned and printed on every invocation, including
 *     under `--apply`, so `--apply` is never the first time the operator
 *     sees the counts.
 *   - Before any write, the pre-image of every targeted `run.started` event
 *     and every `run_history` row that will be re-projected is snapshotted
 *     into a backup table (prefix `aor_backup`), inside the same transaction
 *     as the write.
 *   - Idempotent by construction: each insert carries `caused_by_event_id`,
 *     which the `spine_run_abandoned_cause_unique` partial index enforces.
 *     A second run adjudicates nothing.
 *   - `--limit` bounds how many orphans a single invocation will adjudicate,
 *     so the first apply can be a small, reversible slice.
 *
 * Output discipline
 * -----------------
 * Run ids and connector ids are operational identifiers, not record
 * payloads, but instance ids are elided anyway (`truncateId`). No record
 * content, cursor value, or event payload is ever printed -- only counts,
 * connector names, and dates. The pre-image lives in the backup table for
 * the operator to inspect under their own authorization.
 *
 * Authorization is by direct database access -- possession of
 * `PDPP_DATABASE_URL` (the same credential that grants owner-level access to
 * the reference Postgres). Postgres-only, matching the sibling repair tools.
 *
 * Usage:
 *   node reference-implementation/scripts/repair/adjudicate-orphaned-runs.ts \
 *     [--connector=ynab] [--limit=25] [--apply]
 *
 * Env:
 *   PDPP_DATABASE_URL   required (postgres connection string).
 *                       PDPP_TEST_POSTGRES_URL is accepted as a fallback so
 *                       the same CLI can run against a throwaway database.
 *
 * Exit codes:
 *   0  dry-run completed, or apply completed successfully.
 *   1  apply failed (transaction rolled back).
 *   2  usage / configuration error (no DB url, bad --limit).
 */

import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve this installed package export; Node and TypeScript resolve it.
import pg from "pg";

const { Pool } = pg;

const PG_IDENTIFIER_MAX = 63;

/** Backup-table prefix, so an operator can find the pre-image snapshots. */
export const BACKUP_TABLE_PREFIX = "aor_backup";

/**
 * The terminal reason written for a run whose controller died mid-flight.
 * Deliberately identical to `lib/controller-boot.ts`'s
 * `ABANDONED_AT_BOOT_REASON`, so a backfilled adjudication is
 * indistinguishable from one the boot reconciler wrote.
 */
export const ABANDONED_AT_BOOT_REASON = "controller_terminated_before_run_finished";

/** The `run_history.status` the generic writer derives for `run.abandoned`. */
export const ABANDONED_RUN_HISTORY_STATUS = "abandoned";

/** The spine's canonical terminal set. Must match `check-run-terminal.sql`. */
const TERMINAL_EVENT_TYPES = [
  "run.completed",
  "run.failed",
  "run.browser_surface_failed",
  "run.cancelled",
  "run.abandoned",
] as const;

// Identifier helpers

/** Truncate any identifier for payload-free output (head...tail elision). */
export function truncateId(value: unknown): string {
  const s = String(value ?? "");
  if (s.length <= 16) {
    return s;
  }
  return `${s.slice(0, 8)}...${s.slice(-4)}`;
}

/** Validate a token so it is safe to interpolate into a `CREATE TABLE` name. */
export function sanitizeIdentifierToken(value: unknown, label: string): string {
  const s = String(value ?? "");
  const cleaned = s.replace(/[^A-Za-z0-9]/g, "_").toLowerCase();
  if (!cleaned || cleaned.length > 96) {
    throw new Error(`unsafe ${label} for backup-table name: ${JSON.stringify(value)}`);
  }
  return cleaned;
}

/**
 * Compose a collision-safe backup-table name within Postgres' 63-byte
 * identifier limit: `<prefix>_<hash8>__<scope>__<stamp>`.
 */
export function backupTableName({ scope, stamp }: { scope: string; stamp: string }): string {
  const scopeToken = sanitizeIdentifierToken(scope, "scope");
  const stampToken = sanitizeIdentifierToken(stamp, "stamp");
  const hash8 = createHash("sha256")
    .update(JSON.stringify([scopeToken, stampToken]))
    .digest("hex")
    .slice(0, 8);
  const base = `${BACKUP_TABLE_PREFIX}_${hash8}`;
  const stampPart = stampToken.slice(0, 16);
  const remaining = PG_IDENTIFIER_MAX - base.length - 4 - stampPart.length;
  const scopePart = remaining > 0 ? scopeToken.slice(0, remaining) : "";
  const name = `${base}__${scopePart}__${stampPart}`;
  if (name.length > PG_IDENTIFIER_MAX) {
    throw new Error(`backup-table name exceeds ${PG_IDENTIFIER_MAX} bytes: ${name}`);
  }
  return name;
}

// Argument parsing

export interface ParsedArgs {
  apply: boolean;
  connectors: string[];
  limit: number | null;
}

/** Parse argv into `{ apply, connectors[], limit }`. `--connector` repeats. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { apply: false, connectors: [], limit: null };
  const seen = new Set<string>();
  for (const arg of argv) {
    if (arg === "--apply") {
      out.apply = true;
    } else if (arg.startsWith("--connector=")) {
      const v = arg.slice("--connector=".length);
      if (v && !seen.has(v)) {
        seen.add(v);
        out.connectors.push(v);
      }
    } else if (arg.startsWith("--limit=")) {
      out.limit = Number(arg.slice("--limit=".length));
    }
  }
  return out;
}

/** Validate parsed args. Returns an error string, or null when acceptable. */
export function validateArgs({ limit }: Pick<ParsedArgs, "limit">): string | null {
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
    return "--limit must be a positive integer";
  }
  return null;
}

// Planning

export interface OrphanRow {
  actor_id: string;
  connector_instance_id: string | null;
  event_id: string;
  occurred_at: string;
  original_boot_epoch: string | null;
  original_controller_id: string | null;
  run_id: string;
  scenario_id: string | null;
  trace_id: string | null;
}

export interface PlanSummary {
  byConnector: { connector: string; count: number; first: string; last: string }[];
  total: number;
}

/**
 * Group the planned orphans for display. Kept pure so the printed scope can
 * be tested without a database.
 */
export function summarizePlan(rows: readonly OrphanRow[]): PlanSummary {
  const byConnector = new Map<string, { count: number; first: string; last: string }>();
  for (const row of rows) {
    const at = row.occurred_at.slice(0, 10);
    const found = byConnector.get(row.actor_id);
    if (found) {
      found.count += 1;
      found.first = at < found.first ? at : found.first;
      found.last = at > found.last ? at : found.last;
    } else {
      byConnector.set(row.actor_id, { count: 1, first: at, last: at });
    }
  }
  return {
    byConnector: [...byConnector.entries()]
      .map(([connector, v]) => ({ connector, ...v }))
      .sort((a, b) => b.count - a.count || a.connector.localeCompare(b.connector)),
    total: rows.length,
  };
}

/**
 * Select `run.started` events with no terminal event and no prior
 * adjudication.
 *
 * Deliberately does NOT filter on `controller_id`. That field is the thing
 * that broke: the stranded runs carry dead container ids, so an ownership
 * filter would skip exactly the rows this tool exists to heal. On a
 * single-controller deployment every orphan is ours by construction. An
 * operator running a genuine multi-controller fleet should scope with
 * `--connector` instead.
 *
 * It DOES exclude runs belonging to the newest `controller.booted` epoch,
 * and that exclusion is load-bearing. A run started by the process that is
 * still running is not an orphan, it is live work: it has no terminal event
 * for the ordinary reason that it has not finished yet. Adjudicating it
 * would declare live work abandoned and free its connection for a competing
 * run -- the duplicate-execution hazard that River, Oban, Celery and Sidekiq
 * all document for wall-clock reapers, reintroduced by a backfill.
 *
 * This was not hypothetical. A dry run against production listed two runs
 * that the live container had started ninety seconds earlier and was still
 * executing.
 *
 * The epoch is the right fence rather than an age cutoff for the same reason
 * it is right everywhere else here: a run stamped with an epoch that is not
 * the newest one is provably not being worked on, with no threshold to tune
 * and no live-work false positive to trade against.
 */
export async function planOrphans(
  pool: pg.Pool,
  { connectors, limit }: Pick<ParsedArgs, "connectors" | "limit">
): Promise<OrphanRow[]> {
  const params: unknown[] = [TERMINAL_EVENT_TYPES];
  let connectorClause = "";
  if (connectors.length > 0) {
    params.push(connectors);
    connectorClause = `AND s.actor_id = ANY($${params.length}::text[])`;
  }
  let limitClause = "";
  if (limit !== null) {
    params.push(limit);
    limitClause = `LIMIT $${params.length}`;
  }

  const { rows } = await pool.query<OrphanRow>(
    `SELECT
       s.event_id,
       s.run_id,
       s.actor_id,
       s.trace_id,
       s.scenario_id,
       s.occurred_at,
       s.connector_instance_id,
       s.data_json->>'boot_epoch'    AS original_boot_epoch,
       s.data_json->>'controller_id' AS original_controller_id
     FROM spine_events s
     WHERE s.event_type = 'run.started'
       AND s.run_id IS NOT NULL
       ${connectorClause}
       -- Never adjudicate the newest epoch: those runs may still be executing
       -- in the live process. See this function's doc comment.
       AND (s.data_json->>'boot_epoch') IS DISTINCT FROM (
         SELECT b.data_json->>'epoch'
           FROM spine_events b
          WHERE b.event_type = 'controller.booted'
          ORDER BY b.event_seq DESC
          LIMIT 1
       )
       AND NOT EXISTS (
         SELECT 1 FROM spine_events t
          WHERE t.run_id = s.run_id
            AND t.event_type = ANY($1::text[])
       )
       AND NOT EXISTS (
         SELECT 1 FROM spine_events r
          WHERE r.event_type = 'run.abandoned'
            AND (r.data_json->>'caused_by_event_id') = s.event_id
       )
     ORDER BY s.occurred_at ASC
     ${limitClause}`,
    params
  );
  return rows;
}

// Apply

export interface AdjudicateResult {
  adjudicated: number;
  applied: boolean;
  backupTable: string | null;
  error?: string;
  failed: boolean;
  plan: PlanSummary;
  reprojected: number;
}

/**
 * Emit `run.abandoned` for each planned orphan and re-project the matching
 * `run_history` row, in one transaction, after snapshotting both pre-images.
 *
 * The event shape mirrors `lib/controller-boot.ts` exactly, with
 * `source: "repair_script"` as the one honest difference so an auditor can
 * tell a backfilled adjudication from a boot-time one.
 */
export async function adjudicateOrphans({
  pool,
  rows,
  apply,
  stamp,
  scope,
}: {
  apply: boolean;
  pool: pg.Pool;
  rows: readonly OrphanRow[];
  scope: string;
  stamp: string;
}): Promise<AdjudicateResult> {
  const plan = summarizePlan(rows);
  const result: AdjudicateResult = {
    adjudicated: 0,
    applied: apply,
    backupTable: null,
    failed: false,
    plan,
    reprojected: 0,
  };
  if (!apply || rows.length === 0) {
    return result;
  }

  const backupTable = backupTableName({ scope, stamp });
  result.backupTable = backupTable;
  const eventIds = rows.map((r) => r.event_id);
  const runIds = rows.map((r) => r.run_id);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Pre-image: the run.started events being adjudicated, plus the
    // run_history rows about to be re-projected. Both in one table so a
    // restore has the whole picture of what this invocation saw.
    await client.query(
      `CREATE TABLE "${backupTable}" AS
         SELECT 'spine_event'::text AS pre_image_kind,
                s.event_id, s.run_id, s.actor_id, s.connector_instance_id,
                s.occurred_at, s.status, s.data_json
           FROM spine_events s
          WHERE s.event_id = ANY($1::text[])`,
      [eventIds]
    );
    await client.query(
      `CREATE TABLE "${backupTable}_history" AS
         SELECT h.*
           FROM run_history h
          WHERE h.run_id = ANY($1::text[])`,
      [runIds]
    );

    for (const orphan of rows) {
      const eventId = `evt_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const occurredAt = new Date().toISOString();
      const dataJson = JSON.stringify({
        caused_by_event_id: orphan.event_id,
        original_boot_epoch: orphan.original_boot_epoch,
        original_controller_id: orphan.original_controller_id,
        reason: ABANDONED_AT_BOOT_REASON,
        source: "repair_script",
      });

      // biome-ignore lint/performance/noAwaitInLoops: One transaction, ordered writes; each insert must observe the prior one's idempotency index.
      const inserted = await client.query(
        `INSERT INTO spine_events (
           event_id, event_type, occurred_at, recorded_at,
           scenario_id, trace_id, actor_type, actor_id,
           object_type, object_id, status, run_id,
           data_json, version
         )
         VALUES ($1, 'run.abandoned', $2, $2, $3, $4, 'runtime', $5,
                 'run', $6, 'abandoned', $7, $8::jsonb, 'v1')
         ON CONFLICT DO NOTHING`,
        [
          eventId,
          occurredAt,
          orphan.scenario_id ?? "default",
          orphan.trace_id ?? `trc_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
          orphan.actor_id,
          orphan.run_id,
          orphan.run_id,
          dataJson,
        ]
      );
      if ((inserted.rowCount ?? 0) === 0) {
        continue;
      }
      result.adjudicated += 1;

      // Re-project, fenced on both the run identity pair and `running`, so
      // this cannot finalize a run some other path already terminalised.
      // `records_emitted` is deliberately untouched: records validly
      // ingested before the controller died stay committed.
      if (orphan.connector_instance_id) {
        // biome-ignore lint/performance/noAwaitInLoops: See above -- ordered within the single transaction.
        const projected = await client.query(
          `UPDATE run_history
              SET status = $1, completed_at = $2, terminal_reason = $3, facts_json = $4::jsonb
            WHERE run_id = $5
              AND connector_instance_id = $6
              AND status = 'running'`,
          [
            ABANDONED_RUN_HISTORY_STATUS,
            occurredAt,
            ABANDONED_AT_BOOT_REASON,
            dataJson,
            orphan.run_id,
            orphan.connector_instance_id,
          ]
        );
        result.reprojected += projected.rowCount ?? 0;
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Best-effort rollback; the original error is what the caller needs.
    }
    result.failed = true;
    result.adjudicated = 0;
    result.reprojected = 0;
    result.error = String(err && typeof err === "object" && "message" in err ? err.message : err);
    client.release();
    return result;
  }
  client.release();
  return result;
}

// Output

export function formatSummary(result: AdjudicateResult): string {
  const lines: string[] = [];
  const mode = result.applied ? "APPLY" : "DRY RUN";
  lines.push(`adjudicate-orphaned-runs [${mode}]: ${result.plan.total} orphaned run(s) with no terminal event`);
  for (const entry of result.plan.byConnector) {
    lines.push(
      `  ${truncateId(entry.connector)}: ${entry.count} orphan(s)  ${entry.first} .. ${entry.last}` +
        `  -> ${result.applied ? "run.abandoned" : "would write run.abandoned"}`
    );
  }
  if (result.plan.total === 0) {
    lines.push("  nothing to adjudicate; every run.started already has a terminal event.");
    return lines.join("\n");
  }
  if (result.applied) {
    if (result.failed) {
      lines.push(`  FAILED: ${result.error} (transaction rolled back; no event written)`);
    } else {
      lines.push(
        `  adjudicated=${result.adjudicated} run_history_reprojected=${result.reprojected} ` +
          `backup_table=${result.backupTable}`
      );
      lines.push("  these runs are now terminal as `abandoned`; the normal schedule picks the work up.");
    }
  } else {
    lines.push("  (dry run) re-run with --apply to write these terminal events.");
  }
  return lines.join("\n");
}

// CLI

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const validationError = validateArgs(args);
  if (validationError) {
    console.error(validationError);
    process.exitCode = 2;
    return;
  }
  const databaseUrl = process.env.PDPP_DATABASE_URL || process.env.PDPP_TEST_POSTGRES_URL || null;
  if (!databaseUrl) {
    console.error("PDPP_DATABASE_URL is required");
    process.exitCode = 2;
    return;
  }

  const stamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
  const scope = args.connectors.length > 0 ? args.connectors.join("_") : "all";

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const rows = await planOrphans(pool, args);
    const result = await adjudicateOrphans({ apply: args.apply, pool, rows, scope, stamp });
    console.log(formatSummary(result));
    process.exitCode = result.failed ? 1 : 0;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
