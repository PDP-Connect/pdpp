#!/usr/bin/env node

/**
 * compact-record-history-dry-run-all
 *
 * Read-only operator convenience wrapper around
 * `compact-record-history.mjs`. It enumerates the registered compaction
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
 * the operator runs the single-stream `compact-record-history.mjs`
 * with `--apply` per scope, exactly as the dashboard drilldown and the
 * OpenSpec design.md procedure describe. This wrapper deliberately does
 * not wrap `--apply`: a batch mutation across streams is precisely the
 * operation that should stay an explicit, per-scope, owner decision.
 *
 * Usage:
 *   # survey every registered policy for one connection
 *   node reference-implementation/scripts/compact-record-history-dry-run-all.mjs \
 *     --connector-instance-id=cin_...
 *
 *   # restrict to one connector_id's policies (no DB lookup of the cin)
 *   node reference-implementation/scripts/compact-record-history-dry-run-all.mjs \
 *     --connector-instance-id=cin_... --connector-id=usaa
 *
 *   # survey every connection that has at least one registered policy
 *   node reference-implementation/scripts/compact-record-history-dry-run-all.mjs --all
 *
 *   # machine-readable
 *   node reference-implementation/scripts/compact-record-history-dry-run-all.mjs --all --json
 *
 * Env:
 *   PDPP_DATABASE_URL or PDPP_TEST_POSTGRES_URL    required
 *
 * Spec: openspec/changes/compact-retained-record-history/specs/
 *       reference-implementation-architecture/spec.md
 */

import process from 'node:process';
import { pathToFileURL } from 'node:url';

import pg from 'pg';

import {
  COMPACTION_POLICIES,
  findPolicy,
  isCanonicalEligible,
  parseMode,
  planCompaction,
} from './compact-record-history.mjs';

const { Pool } = pg;

// ─── Pure scope resolution ──────────────────────────────────────────────

/**
 * Resolve the (connectorId, stream) policies to dry-run for a single
 * connection whose connector_id is known.
 *
 * Returns the registered policies for that connector_id, each paired with
 * the supplied connectorInstanceId. Pure — no IO.
 */
export function policiesForConnector(connectorInstanceId, connectorId, policies = COMPACTION_POLICIES) {
  return policies
    .filter((p) => p.connectorIds.includes(connectorId))
    .map((p) => ({
      connectorInstanceId,
      connectorId,
      stream: p.stream,
      policy: p,
    }));
}

/**
 * Format a finished set of dry-run plans into an aligned, operator-readable
 * table. Pure — takes the array of `{connectorInstanceId, connectorId,
 * stream, plan, error}` rows and returns a string. Rows with an `error`
 * (e.g. the scope could not be planned) are surfaced, not hidden.
 */
export function formatDryRunTable(rows) {
  const header = ['connection', 'connector', 'stream', 'scannedVersions', 'removableVersions', 'estRemovedBytes'];
  const body = rows.map((r) => {
    if (r.error) {
      return [r.connectorInstanceId, r.connectorId || '?', r.stream, 'ERROR', r.error, ''];
    }
    return [
      r.connectorInstanceId,
      r.connectorId || (r.plan.connectorIdsSeen?.[0] ?? '?'),
      r.stream,
      String(r.plan.scannedVersions),
      String(r.plan.removableVersions),
      String(r.plan.estimatedRemovedBytes),
    ];
  });
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((row) => String(row[i]).length)),
  );
  const fmt = (cols) => cols.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  const lines = [fmt(header), widths.map((w) => '-'.repeat(w)).join('  ')];
  for (const row of body) lines.push(fmt(row));
  return lines.join('\n');
}

/**
 * Sum the removable versions across plans (skipping error rows). Pure.
 */
export function totalRemovableVersions(rows) {
  return rows.reduce((n, r) => n + (r.error ? 0 : r.plan.removableVersions), 0);
}

// ─── DB-backed scope discovery (injectable) ─────────────────────────────

/**
 * Look up the connector_id for a connector_instance_id. Returns null when
 * the connection row is absent.
 */
export async function resolveConnectorId(pool, connectorInstanceId) {
  const r = await pool.query(
    `SELECT connector_id FROM connector_instances WHERE connector_instance_id = $1`,
    [connectorInstanceId],
  );
  return r.rows.length ? r.rows[0].connector_id : null;
}

/**
 * Enumerate every (connector_instance_id, connector_id) connection that
 * has at least one registered compaction policy. Used by `--all`.
 */
export async function listConnectionsWithPolicies(pool, policies = COMPACTION_POLICIES) {
  const eligibleConnectorIds = Array.from(
    new Set(policies.flatMap((p) => p.connectorIds)),
  );
  const r = await pool.query(
    `SELECT connector_instance_id, connector_id
       FROM connector_instances
      WHERE connector_id = ANY($1::text[])
      ORDER BY connector_id, connector_instance_id`,
    [eligibleConnectorIds],
  );
  return r.rows.map((row) => ({
    connectorInstanceId: row.connector_instance_id,
    connectorId: row.connector_id,
  }));
}

/**
 * Run dry-run plans for the resolved scopes. `planFn` defaults to the
 * canonical read-only `planCompaction`; injectable for tests. Never
 * mutates — `planCompaction` is read-only by construction.
 */
export async function runDryRuns({ pool, scopes, limitKeys = null, mode = 'audit', planFn = planCompaction }) {
  const rows = [];
  for (const scope of scopes) {
    const policy = scope.policy || findPolicy(scope.connectorId, scope.stream);
    if (!policy) {
      rows.push({ ...scope, error: 'no policy' });
      continue;
    }
    // In canonical mode, only canonical-eligible policies are surveyed; an
    // ineligible scope would (correctly) throw in planCompaction, so we skip it
    // with an explicit, non-fatal note rather than a scary error row.
    if (mode === 'canonical' && !isCanonicalEligible(policy)) {
      rows.push({ ...scope, error: 'not canonical-eligible (skipped)' });
      continue;
    }
    try {
      const plan = await planFn({
        pool,
        connectorInstanceId: scope.connectorInstanceId,
        stream: scope.stream,
        policy,
        limitKeys,
        mode,
      });
      rows.push({ ...scope, plan });
    } catch (err) {
      rows.push({ ...scope, error: err && err.message ? err.message : String(err) });
    }
  }
  return rows;
}

// ─── Argv parsing (shared shape with the canonical tool) ────────────────

export function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
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

const invokedAsScript = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedAsScript) {
  await runCli();
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.apply) {
    console.error(
      'compact-record-history-dry-run-all is read-only and does not support --apply. ' +
        'To remove rows, run compact-record-history.mjs --apply per scope after reviewing this survey.',
    );
    process.exit(2);
  }

  const connectorInstanceId = args['connector-instance-id'] || null;
  const explicitConnectorId = args['connector-id'] || null;
  const all = !!args.all;
  const json = !!args.json;
  const mode = parseMode(args.mode);
  const databaseUrl =
    process.env.PDPP_DATABASE_URL || process.env.PDPP_TEST_POSTGRES_URL || null;

  if (!all && !connectorInstanceId) {
    console.error(
      'usage: compact-record-history-dry-run-all (--connector-instance-id=<id> [--connector-id=<id>] | --all) [--mode=audit|canonical] [--json]',
    );
    process.exit(2);
  }
  if (mode === 'invalid') {
    console.error('--mode must be one of: audit|canonical (default audit)');
    process.exit(2);
  }
  if (!databaseUrl) {
    console.error(
      'PDPP_DATABASE_URL (or PDPP_TEST_POSTGRES_URL) is required — authorization is by direct database access',
    );
    process.exit(2);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  let exitCode = 0;
  try {
    let scopes = [];
    if (all) {
      const connections = await listConnectionsWithPolicies(pool);
      scopes = connections.flatMap((c) =>
        policiesForConnector(c.connectorInstanceId, c.connectorId),
      );
    } else {
      let connectorId = explicitConnectorId;
      if (!connectorId) {
        connectorId = await resolveConnectorId(pool, connectorInstanceId);
        if (!connectorId) {
          console.error(
            `connector_instance_id "${connectorInstanceId}" not found and --connector-id was not supplied`,
          );
          process.exit(2);
        }
      }
      scopes = policiesForConnector(connectorInstanceId, connectorId);
    }

    if (!scopes.length) {
      console.log('compact-record-history-dry-run-all: DRY-RUN — no registered compaction policy matched the requested scope.');
      return;
    }

    const rows = await runDryRuns({ pool, scopes, mode });

    if (json) {
      console.log(
        JSON.stringify(
          {
            run: 'dry-run',
            mode,
            rows: rows.map((r) => ({
              connector_instance_id: r.connectorInstanceId,
              connector_id: r.connectorId,
              stream: r.stream,
              error: r.error || null,
              scanned_versions: r.error ? null : r.plan.scannedVersions,
              removable_versions: r.error ? null : r.plan.removableVersions,
              estimated_removed_bytes: r.error ? null : r.plan.estimatedRemovedBytes,
            })),
            total_removable_versions: totalRemovableVersions(rows),
          },
          null,
          2,
        ),
      );
    } else {
      console.log(`compact-record-history-dry-run-all: DRY-RUN [${mode} mode] (read-only; no rows deleted)\n`);
      console.log(formatDryRunTable(rows));
      console.log(
        `\ntotal removable versions across surveyed scopes: ${totalRemovableVersions(rows)}`,
      );
      console.log(
        'To remove a scope, review it then run:\n' +
          '  node reference-implementation/scripts/compact-record-history.mjs ' +
          '--connector-instance-id=<id> --stream=<stream> --apply',
      );
    }
  } catch (err) {
    console.error(
      'compact-record-history-dry-run-all failed:',
      err && err.message ? err.message : err,
    );
    exitCode = 1;
  } finally {
    await pool.end();
  }
  process.exit(exitCode);
}
