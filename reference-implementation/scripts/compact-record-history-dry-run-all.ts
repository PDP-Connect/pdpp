#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * compact-record-history-dry-run-all
 *
 * Read-only operator convenience wrapper around
 * `compact-record-history.ts`. It enumerates the registered compaction
 * policies for a connection (or for every connection that has one) and
 * runs each as a DRY RUN, printing one compact row per (connection,
 * stream): how many historical versions are scanned and how many are
 * provably-redundant removable versions.
 *
 * Why this exists: the per-stream tool takes ONE `--stream` per
 * invocation. Closing out the current version-churn notice means
 * dry-running several streams per connection (gmail/labels,
 * usaa/statements, usaa/accounts, usaa/credit_card_billing,
 * chase/accounts, …). Hand-copying one command per stream — and reading
 * each plan separately — is the step where an operator mistypes a stream
 * or, worse, fat-fingers `--apply` onto the wrong scope. This wrapper
 * does the safe survey in one call.
 *
 * Safety: this script has NO `--apply` path and never opens a write
 * transaction. It calls only the exported, read-only `planCompaction`
 * from the canonical tool, so the fingerprint/retention logic is shared
 * one-for-one and never re-implemented here. To actually remove rows,
 * the operator runs the single-stream `compact-record-history.ts`
 * with `--apply` per scope, exactly as the dashboard drilldown and the
 * OpenSpec design.md procedure describe. This wrapper deliberately does
 * not wrap `--apply`: a batch mutation across streams is precisely the
 * operation that should stay an explicit, per-scope, owner decision.
 *
 * Usage:
 *   # survey every registered policy for one connection
 *   node reference-implementation/scripts/compact-record-history-dry-run-all.ts \
 *     --connector-instance-id=cin_...
 *
 *   # restrict to one connector_id's policies (no DB lookup of the cin)
 *   node reference-implementation/scripts/compact-record-history-dry-run-all.ts \
 *     --connector-instance-id=cin_... --connector-id=usaa
 *
 *   # survey every connection that has at least one registered policy
 *   node reference-implementation/scripts/compact-record-history-dry-run-all.ts --all
 *
 *   # machine-readable
 *   node reference-implementation/scripts/compact-record-history-dry-run-all.ts --all --json
 *
 * Env:
 *   PDPP_DATABASE_URL or PDPP_TEST_POSTGRES_URL    required
 *
 * Spec: openspec/changes/compact-retained-record-history/specs/
 *       reference-implementation-architecture/spec.md
 */

import process from "node:process";
import { pathToFileURL } from "node:url";

// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve this installed package export; Node and TypeScript resolve it.
import pg from "pg";
import type {
  CompactionMode,
  CompactionPlan,
  CompactionPolicy,
  ParseLimitKeysResult,
} from "./compact-record-history.ts";
import {
  COMPACTION_POLICIES,
  findPolicy,
  isCanonicalEligible,
  parseMode,
  planCompaction,
} from "./compact-record-history.ts";

const { Pool } = pg;

/** One (connectorInstanceId, connectorId, stream) scope paired with its registered policy. */
export interface DryRunScope {
  connectorId: string;
  connectorInstanceId: string;
  policy: CompactionPolicy;
  stream: string;
}

/** A finished dry-run row: either a plan or an error, never both. */
export interface DryRunRow {
  connectorId: string;
  connectorInstanceId: string;
  error?: string;
  plan?: CompactionPlan;
  policy?: CompactionPolicy;
  stream: string;
}

// ─── Pure scope resolution ──────────────────────────────────────────────

/**
 * Resolve the (connectorId, stream) policies to dry-run for a single
 * connection whose connector_id is known.
 *
 * Returns the registered policies for that connector_id, each paired with
 * the supplied connectorInstanceId. Pure — no IO.
 */
export function policiesForConnector(
  connectorInstanceId: string,
  connectorId: string,
  policies: CompactionPolicy[] = COMPACTION_POLICIES
): DryRunScope[] {
  return policies
    .filter((p) => p.connectorIds.includes(connectorId))
    .map((p) => ({
      connectorId,
      connectorInstanceId,
      policy: p,
      stream: p.stream,
    }));
}

/**
 * Format a finished set of dry-run plans into an aligned, operator-readable
 * table. Pure — takes the array of `{connectorInstanceId, connectorId,
 * stream, plan, error}` rows and returns a string. Rows with an `error`
 * (e.g. the scope could not be planned) are surfaced, not hidden.
 */
export function formatDryRunTable(rows: DryRunRow[]): string {
  const header = ["connection", "connector", "stream", "scannedVersions", "removableVersions", "estRemovedBytes"];
  const body = rows.map((r) => {
    if (r.error) {
      return [r.connectorInstanceId, r.connectorId || "?", r.stream, "ERROR", r.error, ""];
    }
    const { plan } = r;
    if (!plan) {
      throw new Error(`dry-run row for ${r.connectorInstanceId}/${r.stream} has neither error nor plan`);
    }
    return [
      r.connectorInstanceId,
      r.connectorId || (plan.connectorIdsSeen[0] ?? "?"),
      r.stream,
      String(plan.scannedVersions),
      String(plan.removableVersions),
      String(plan.estimatedRemovedBytes),
    ];
  });
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => String(row[i] ?? "").length)));
  const fmt = (cols: string[]) => cols.map((c, i) => String(c).padEnd(widths[i] ?? 0)).join("  ");
  const lines = [fmt(header), widths.map((w) => "-".repeat(w)).join("  ")];
  for (const row of body) {
    lines.push(fmt(row));
  }
  return lines.join("\n");
}

/**
 * Sum the removable versions across plans (skipping error rows). Pure.
 */
export function totalRemovableVersions(rows: DryRunRow[]): number {
  return rows.reduce((n, r) => n + (r.error ? 0 : (r.plan?.removableVersions ?? 0)), 0);
}

// ─── DB-backed scope discovery (injectable) ─────────────────────────────

interface ConnectorIdRow {
  connector_id: string;
}

/**
 * Look up the connector_id for a connector_instance_id. Returns null when
 * the connection row is absent.
 */
export async function resolveConnectorId(pool: pg.Pool, connectorInstanceId: string): Promise<string | null> {
  const r = await pool.query<ConnectorIdRow>(
    "SELECT connector_id FROM connector_instances WHERE connector_instance_id = $1",
    [connectorInstanceId]
  );
  return r.rows.length ? (r.rows[0]?.connector_id ?? null) : null;
}

export interface ConnectionWithPolicy {
  connectorId: string;
  connectorInstanceId: string;
}

interface ConnectionRow {
  connector_id: string;
  connector_instance_id: string;
}

/**
 * Enumerate every (connector_instance_id, connector_id) connection that
 * has at least one registered compaction policy. Used by `--all`.
 */
export async function listConnectionsWithPolicies(
  pool: pg.Pool,
  policies: CompactionPolicy[] = COMPACTION_POLICIES
): Promise<ConnectionWithPolicy[]> {
  const eligibleConnectorIds = Array.from(new Set(policies.flatMap((p) => p.connectorIds)));
  const r = await pool.query<ConnectionRow>(
    `SELECT connector_instance_id, connector_id
       FROM connector_instances
      WHERE connector_id = ANY($1::text[])
      ORDER BY connector_id, connector_instance_id`,
    [eligibleConnectorIds]
  );
  return r.rows.map((row) => ({
    connectorId: row.connector_id,
    connectorInstanceId: row.connector_instance_id,
  }));
}

export interface RunDryRunsInput {
  limitKeys?: ParseLimitKeysResult | null;
  mode?: CompactionMode;
  planFn?: typeof planCompaction;
  pool: pg.Pool;
  scopes: DryRunScope[];
}

/**
 * Run dry-run plans for the resolved scopes. `planFn` defaults to the
 * canonical read-only `planCompaction`; injectable for tests. Never
 * mutates — `planCompaction` is read-only by construction.
 */
export async function runDryRuns({
  pool,
  scopes,
  limitKeys = null,
  mode = "audit",
  planFn = planCompaction,
}: RunDryRunsInput): Promise<DryRunRow[]> {
  const rows: DryRunRow[] = [];
  for (const scope of scopes) {
    const policy = scope.policy || findPolicy(scope.connectorId, scope.stream);
    if (!policy) {
      rows.push({ ...scope, error: "no policy" });
      continue;
    }
    // In canonical mode, only canonical-eligible policies are surveyed; an
    // ineligible scope would (correctly) throw in planCompaction, so we skip it
    // with an explicit, non-fatal note rather than a scary error row.
    if (mode === "canonical" && !isCanonicalEligible(policy)) {
      rows.push({ ...scope, error: "not canonical-eligible (skipped)" });
      continue;
    }
    try {
      // biome-ignore lint/performance/noAwaitInLoops: each plan issues its own reads against the shared pool and rows are surfaced in the caller's requested scope order; parallelizing would race table output ordering against Postgres connection-pool exhaustion for an --all survey with many scopes.
      const plan = await planFn({
        connectorInstanceId: scope.connectorInstanceId,
        limitKeys: typeof limitKeys === "number" ? limitKeys : null,
        mode,
        policy,
        pool,
        stream: scope.stream,
      });
      rows.push({ ...scope, plan });
    } catch (err) {
      rows.push({ ...scope, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return rows;
}

// ─── Argv parsing (shared shape with the canonical tool) ────────────────

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        out[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        out[arg.slice(2)] = true;
      }
    }
  }
  return out;
}

// ─── CLI entry point ────────────────────────────────────────────────────

const invokedAsScript = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (invokedAsScript) {
  await runCli();
}

interface ResolveScopesInput {
  all: boolean;
  connectorInstanceId: string | null;
  explicitConnectorId: string | null;
  pool: pg.Pool;
}

/**
 * Resolve the dry-run scopes for either `--all` (every connection with a
 * registered policy) or a single `--connector-instance-id` (optionally
 * paired with an explicit `--connector-id` to skip the DB lookup). Extracted
 * from `runCli` purely to keep that function's own cognitive complexity under
 * Biome's budget; the resolution logic and exit-on-not-found behavior are
 * unchanged from the inline version it replaces.
 */
async function resolveScopes({
  pool,
  all,
  connectorInstanceId,
  explicitConnectorId,
}: ResolveScopesInput): Promise<DryRunScope[]> {
  if (all) {
    const connections = await listConnectionsWithPolicies(pool);
    return connections.flatMap((c) => policiesForConnector(c.connectorInstanceId, c.connectorId));
  }

  let connectorId = explicitConnectorId;
  if (!connectorId) {
    if (!connectorInstanceId) {
      throw new Error("connectorInstanceId is required when --connector-id is not supplied (guarded above)");
    }
    connectorId = await resolveConnectorId(pool, connectorInstanceId);
    if (!connectorId) {
      console.error(`connector_instance_id "${connectorInstanceId}" not found and --connector-id was not supplied`);
      process.exit(2);
    }
  }
  if (!connectorInstanceId) {
    throw new Error("connectorInstanceId is required (guarded above)");
  }
  return policiesForConnector(connectorInstanceId, connectorId);
}

async function runCli(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.apply) {
    console.error(
      "compact-record-history-dry-run-all is read-only and does not support --apply. " +
        "To remove rows, run compact-record-history.ts --apply per scope after reviewing this survey."
    );
    process.exit(2);
  }

  const connectorInstanceIdArg = args["connector-instance-id"];
  const connectorInstanceId = typeof connectorInstanceIdArg === "string" ? connectorInstanceIdArg : null;
  const explicitConnectorIdArg = args["connector-id"];
  const explicitConnectorId = typeof explicitConnectorIdArg === "string" ? explicitConnectorIdArg : null;
  const all = !!args.all;
  const json = !!args.json;
  const mode = parseMode(args.mode);
  const databaseUrl = process.env.PDPP_DATABASE_URL || process.env.PDPP_TEST_POSTGRES_URL || null;

  if (!(all || connectorInstanceId)) {
    console.error(
      "usage: compact-record-history-dry-run-all (--connector-instance-id=<id> [--connector-id=<id>] | --all) [--mode=audit|canonical] [--json]"
    );
    process.exit(2);
  }
  if (mode === "invalid") {
    console.error("--mode must be one of: audit|canonical (default audit)");
    process.exit(2);
  }
  if (!databaseUrl) {
    console.error(
      "PDPP_DATABASE_URL (or PDPP_TEST_POSTGRES_URL) is required — authorization is by direct database access"
    );
    process.exit(2);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  let exitCode = 0;
  try {
    const scopes = await resolveScopes({ all, connectorInstanceId, explicitConnectorId, pool });

    if (!scopes.length) {
      console.log(
        "compact-record-history-dry-run-all: DRY-RUN — no registered compaction policy matched the requested scope."
      );
      return;
    }

    const rows = await runDryRuns({ mode, pool, scopes });

    if (json) {
      console.log(
        JSON.stringify(
          {
            mode,
            rows: rows.map((r) => ({
              connector_id: r.connectorId,
              connector_instance_id: r.connectorInstanceId,
              error: r.error || null,
              estimated_removed_bytes: r.error ? null : (r.plan?.estimatedRemovedBytes ?? null),
              removable_versions: r.error ? null : (r.plan?.removableVersions ?? null),
              scanned_versions: r.error ? null : (r.plan?.scannedVersions ?? null),
              stream: r.stream,
            })),
            run: "dry-run",
            total_removable_versions: totalRemovableVersions(rows),
          },
          null,
          2
        )
      );
    } else {
      console.log(`compact-record-history-dry-run-all: DRY-RUN [${mode} mode] (read-only; no rows deleted)\n`);
      console.log(formatDryRunTable(rows));
      console.log(`\ntotal removable versions across surveyed scopes: ${totalRemovableVersions(rows)}`);
      console.log(
        "To remove a scope, review it then run:\n" +
          "  node reference-implementation/scripts/compact-record-history.ts " +
          "--connector-instance-id=<id> --stream=<stream> --apply"
      );
    }
  } catch (err) {
    console.error("compact-record-history-dry-run-all failed:", err instanceof Error ? err.message : err);
    exitCode = 1;
  } finally {
    await pool.end();
  }
  process.exit(exitCode);
}
