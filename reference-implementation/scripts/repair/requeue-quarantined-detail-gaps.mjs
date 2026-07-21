#!/usr/bin/env node

/**
 * Requeue quarantined terminal detail gaps for one explicit connection.
 *
 * This is an owner/operator repair tool for the reference implementation's
 * durable detail-gap substrate. It exists for the narrow case where a connector
 * or runtime repair makes it reasonable to retry rows that previously exhausted
 * their no-progress budget and were terminalized as `quarantined`.
 *
 * Safety model:
 *   - Dry-run by default; `--apply` is required to write.
 *   - Requires one explicit connector id and connector instance id.
 *   - Optional `--stream` filters are additive; no payloads or locators print.
 *   - The implementation's apply path uses the tested detail-gap store
 *     primitive. It does not revive permanent terminal classes such as
 *     `not_found`, `gone`, or `permanent_forbidden`.
 *
 * Usage:
 *   PDPP_DATABASE_URL=postgres://... \
 *   node reference-implementation/scripts/repair/requeue-quarantined-detail-gaps.mjs \
 *     --connector-id=amazon \
 *     --connector-instance-id=cin_... \
 *     --stream=order_items \
 *     [--limit=100 --apply]
 */

import process from 'node:process';

import {
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
} from '../../server/postgres-storage.js';
import { createPostgresConnectorDetailGapStore } from '../../server/stores/connector-detail-gap-store.js';

function parseArgs(argv) {
  const out = {
    apply: false,
    connectorId: null,
    connectorInstanceId: null,
    limit: 100,
    streams: [],
  };
  const seenStreams = new Set();
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const key = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
    const value = eq > 0 ? arg.slice(eq + 1) : true;
    if (key === 'apply') {
      out.apply = true;
    } else if (key === 'connector-id') {
      out.connectorId = String(value);
    } else if (key === 'connector-instance-id') {
      out.connectorInstanceId = String(value);
    } else if (key === 'limit') {
      const parsed = Number.parseInt(String(value), 10);
      out.limit = Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 500) : out.limit;
    } else if (key === 'stream') {
      const stream = String(value);
      if (stream && !seenStreams.has(stream)) {
        seenStreams.add(stream);
        out.streams.push(stream);
      }
    }
  }
  return out;
}

function validateArgs(args) {
  if (!args.connectorId) return '--connector-id is required';
  if (!args.connectorInstanceId) return '--connector-instance-id is required';
  return null;
}

async function countQuarantined({ connectorId, connectorInstanceId, streams }) {
  const result = await postgresQuery(
    `
      SELECT COUNT(*) AS gap_count
      FROM connector_detail_gaps
      WHERE connector_id = $1
        AND connector_instance_id = $2
        AND status = 'terminal'
        AND reason = 'quarantined'
        AND ($3::text[] IS NULL OR stream = ANY($3::text[]))
    `,
    [connectorId, connectorInstanceId, streams.length ? streams : null],
  );
  return Number(result.rows[0]?.gap_count ?? 0);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const error = validateArgs(args);
  if (error) {
    console.error(error);
    process.exitCode = 2;
    return;
  }
  const databaseUrl = process.env.PDPP_DATABASE_URL || process.env.PDPP_TEST_POSTGRES_URL || null;
  if (!databaseUrl) {
    console.error('PDPP_DATABASE_URL is required');
    process.exitCode = 2;
    return;
  }

  await initPostgresStorage({ backend: 'postgres', databaseUrl });
  try {
    const matched = await countQuarantined(args);
    const summary = args.apply
      ? await createPostgresConnectorDetailGapStore().requeueQuarantinedTerminalGapsForConnectorInstance(
          args.connectorId,
          args.connectorInstanceId,
          {
            limit: args.limit,
            streams: args.streams,
          },
        )
      : { matched, requeued: 0 };

    console.log(JSON.stringify({
      applied: args.apply,
      connector_id: args.connectorId,
      connector_instance_id: args.connectorInstanceId,
      limit: args.limit,
      matched,
      requeued: summary.requeued,
      streams: args.streams,
    }, null, 2));
  } finally {
    await closePostgresStorage();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    await closePostgresStorage().catch(() => {});
    process.exitCode = 1;
  });
}
