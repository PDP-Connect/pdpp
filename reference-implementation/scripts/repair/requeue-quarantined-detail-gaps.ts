#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
 *   node reference-implementation/scripts/repair/requeue-quarantined-detail-gaps.ts \
 *     --connector-id=amazon \
 *     --connector-instance-id=cin_... \
 *     --stream=order_items \
 *     [--limit=100 --apply]
 */

import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../../server/postgres-storage.ts";
import { createPostgresConnectorDetailGapStore } from "../../server/stores/connector-detail-gap-store.ts";

interface ParsedRequeueArgs {
  apply: boolean;
  connectorId: string | null;
  connectorInstanceId: string | null;
  limit: number;
  streams: string[];
}

/**
 * Apply one parsed `--key[=value]` flag to `out` in place. Extracted from
 * `parseArgs`'s loop purely to keep that loop's own cognitive complexity
 * under Biome's budget -- the per-key dispatch and value-parsing behavior is
 * unchanged from the inline version it replaces.
 */
function applyParsedFlag(out: ParsedRequeueArgs, seenStreams: Set<string>, key: string, value: string | boolean): void {
  if (key === "apply") {
    out.apply = true;
  } else if (key === "connector-id") {
    out.connectorId = String(value);
  } else if (key === "connector-instance-id") {
    out.connectorInstanceId = String(value);
  } else if (key === "limit") {
    const parsed = Number.parseInt(String(value), 10);
    out.limit = Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 500) : out.limit;
  } else if (key === "stream") {
    const stream = String(value);
    if (stream && !seenStreams.has(stream)) {
      seenStreams.add(stream);
      out.streams.push(stream);
    }
  }
}

function parseArgs(argv: string[]): ParsedRequeueArgs {
  const out: ParsedRequeueArgs = {
    apply: false,
    connectorId: null,
    connectorInstanceId: null,
    limit: 100,
    streams: [],
  };
  const seenStreams = new Set<string>();
  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      continue;
    }
    const eq = arg.indexOf("=");
    const key = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
    const value = eq > 0 ? arg.slice(eq + 1) : true;
    applyParsedFlag(out, seenStreams, key, value);
  }
  return out;
}

function validateArgs(args: ParsedRequeueArgs): string | null {
  if (!args.connectorId) {
    return "--connector-id is required";
  }
  if (!args.connectorInstanceId) {
    return "--connector-instance-id is required";
  }
  return null;
}

interface CountQuarantinedScope {
  connectorId: string;
  connectorInstanceId: string;
  streams: string[];
}

/**
 * The subset of `postgresQuery`'s result shape this tool reads.
 * `server/postgres-storage.js` is untyped JS (checkJs: false); this
 * interface is the honest contract for exactly the row shape the
 * `COUNT(*) AS gap_count` query below returns.
 */
interface GapCountRow {
  gap_count: string | number;
}

interface PostgresQueryResult<Row> {
  rows: Row[];
}

async function countQuarantined({ connectorId, connectorInstanceId, streams }: CountQuarantinedScope): Promise<number> {
  const result: PostgresQueryResult<GapCountRow> = await postgresQuery(
    `
      SELECT COUNT(*) AS gap_count
      FROM connector_detail_gaps
      WHERE connector_id = $1
        AND connector_instance_id = $2
        AND status = 'terminal'
        AND reason = 'quarantined'
        AND ($3::text[] IS NULL OR stream = ANY($3::text[]))
    `,
    [connectorId, connectorInstanceId, streams.length ? streams : null]
  );
  // biome-ignore lint/suspicious/noUnnecessaryConditions: false positive -- Biome does not model noUncheckedIndexedAccess; `result.rows[0]` is genuinely `GapCountRow | undefined` (verified with an isolated tsc repro), so both `?.` and `?? 0` are live for the zero-rows case.
  return Number(result.rows[0]?.gap_count ?? 0);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const error = validateArgs(args);
  if (error) {
    console.error(error);
    process.exitCode = 2;
    return;
  }
  const databaseUrl = process.env.PDPP_DATABASE_URL || process.env.PDPP_TEST_POSTGRES_URL || null;
  if (!databaseUrl) {
    console.error("PDPP_DATABASE_URL is required");
    process.exitCode = 2;
    return;
  }
  const { connectorId, connectorInstanceId } = args;
  if (!(connectorId && connectorInstanceId)) {
    // Unreachable given validateArgs above; narrows the types for the calls below.
    console.error("--connector-id and --connector-instance-id are required");
    process.exitCode = 2;
    return;
  }

  await initPostgresStorage({ backend: "postgres", databaseUrl });
  try {
    const matched = await countQuarantined({ connectorId, connectorInstanceId, streams: args.streams });
    const summary = args.apply
      ? await createPostgresConnectorDetailGapStore().requeueQuarantinedTerminalGapsForConnectorInstance(
          connectorId,
          connectorInstanceId,
          {
            limit: args.limit,
            streams: args.streams,
          }
        )
      : { matched, requeued: 0 };

    console.log(
      JSON.stringify(
        {
          applied: args.apply,
          connector_id: connectorId,
          connector_instance_id: connectorInstanceId,
          limit: args.limit,
          matched,
          requeued: summary.requeued,
          streams: args.streams,
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
