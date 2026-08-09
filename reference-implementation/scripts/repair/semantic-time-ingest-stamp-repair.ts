#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * semantic-time-ingest-stamp-repair
 *
 * Owner/operator-only repair for SQLite records whose `semantic_time` holds an
 * INGEST timestamp instead of a semantic date.
 *
 * Why this tool exists
 * --------------------
 * `server/semantic-time-coercion.ts` fixed the ingest path: a record with no
 * real semantic date now stores `SEMANTIC_TIME_UNKNOWN` (empty string) rather
 * than the ingest clock. That fix is forward-only. Rows written BEFORE it
 * still carry `semantic_time = emitted_at`, which is not a date the owner's
 * life produced — it is the moment the collector happened to run, wearing a
 * timeline position's clothes.
 *
 * The existing repair, `backfillSqliteRecordSemanticTimesForManifest`, could
 * have corrected them, but nothing ever called it over the fleet: it runs only
 * from `registerConnector` (server/auth.ts), and the two callers that sweep
 * every shipped manifest — polyfill manifest reconcile and local-collector
 * registration — both pass `backfillRetrievalIndexes: false`, whose early
 * return skips the derived-column repair entirely. So a connector whose
 * manifest was already up to date was never re-registered, and one that WAS
 * re-registered took the opt-out branch. This tool closes that gap by driving
 * the same fenced backfill directly, for every registered manifest.
 *
 * What it does NOT do
 * -------------------
 *   - It never invents a date. When the manifest's declared field is absent,
 *     null, or a provider "no value" sentinel, the honest result is ABSENCE,
 *     and that is what it writes. Absence is a complete answer.
 *   - It never touches a row whose `semantic_time` is a real, distinct date.
 *     Mode `ingest-stamped` restricts writes to rows that are empty or exactly
 *     equal to `emitted_at` — the only values that provably carry no
 *     information a recompute could destroy.
 *   - It never triggers a run, appends a record change, or notifies clients.
 *     A derived-column repair is not a data change in the owner's timeline.
 *
 * Safety model
 * ------------
 *   - Default is dry-run. `--apply` is required to write.
 *   - A dry run walks the SAME code path the write does (the backfill plans
 *     every row, then skips the write), so the preview cannot drift from the
 *     writer.
 *   - Writes go through `backfillSqliteRecordSemanticTimesForManifest`, which
 *     takes `withConnectorInstanceWrite` (the per-instance writer-admission
 *     fence bulk ingest holds) and wraps each stream's updates in
 *     `writeTransaction`.
 *   - Idempotent: a second run finds the corrected rows no longer differ from
 *     their recomputed value and writes nothing.
 *
 * Output discipline
 * -----------------
 * Record payloads are never printed. Output is per connector/stream counts and
 * the connector/stream names themselves.
 *
 * Usage:
 *   node reference-implementation/scripts/repair/semantic-time-ingest-stamp-repair.ts \
 *     --db=/var/lib/pdpp/pdpp.sqlite [--connector=steam] [--apply]
 */

import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { closeDb, getDb, initDb } from "../../server/db.ts";
import {
  backfillSqliteRecordSemanticTimesForManifest,
  type SemanticTimeBackfillStreamOutcome,
} from "../../server/records.ts";

export interface ParsedArgs {
  readonly apply: boolean;
  readonly connectors: readonly string[];
  readonly db: string | null;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let apply = false;
  let db: string | null = null;
  const connectors: string[] = [];
  for (const arg of argv) {
    if (arg === "--apply") {
      apply = true;
    } else if (arg.startsWith("--db=")) {
      db = arg.slice("--db=".length) || null;
    } else if (arg.startsWith("--connector=")) {
      const value = arg.slice("--connector=".length);
      if (value) {
        connectors.push(value);
      }
    }
  }
  return { apply, connectors, db };
}

export function validateArgs(args: ParsedArgs): string | null {
  if (!args.db) {
    return "--db=<path-to-pdpp.sqlite> is required";
  }
  return null;
}

interface ConnectorManifestRecord {
  readonly connectorId: string;
  readonly manifest: Record<string, unknown>;
}

/**
 * Every registered connector manifest, skipping rows whose stored JSON does not
 * parse. A malformed manifest is reported and skipped rather than aborting the
 * sweep: one bad row must not block repairing the rest of the fleet.
 */
function loadConnectorManifests(filter: readonly string[]): ConnectorManifestRecord[] {
  const wanted = new Set(filter);
  const rows = getDb().prepare("SELECT connector_id, manifest FROM connectors ORDER BY connector_id").all() as {
    connector_id: string;
    manifest: string | null;
  }[];
  const manifests: ConnectorManifestRecord[] = [];
  for (const row of rows) {
    if (wanted.size > 0 && !wanted.has(row.connector_id)) {
      continue;
    }
    if (!row.manifest) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(row.manifest);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        manifests.push({ connectorId: row.connector_id, manifest: parsed as Record<string, unknown> });
      }
    } catch {
      console.error(`  ! ${row.connector_id}: manifest JSON did not parse; skipped`);
    }
  }
  return manifests;
}

function reportStreams(connectorId: string, streams: readonly SemanticTimeBackfillStreamOutcome[]): number {
  let changed = 0;
  for (const stream of streams) {
    const total = stream.toSemanticDate + stream.toAbsence;
    if (total === 0) {
      continue;
    }
    changed += total;
    console.log(
      `  ${connectorId}/${stream.stream}: ${total} to change ` +
        `(${stream.toSemanticDate} -> semantic date, ${stream.toAbsence} -> absence; ` +
        `${stream.repairable} repairable of ${stream.examined} examined)`
    );
  }
  return changed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const invalid = validateArgs(args);
  if (invalid) {
    throw new Error(invalid);
  }
  initDb(resolve(args.db || ""));
  try {
    const manifests = loadConnectorManifests(args.connectors);
    console.log(
      `${args.apply ? "APPLY" : "DRY RUN"}: scanning ${manifests.length} registered manifest(s) in ingest-stamped mode\n`
    );

    // Always plan first and PRINT the whole fleet's intended changes before any
    // write, so `--apply` is never the first time the operator sees the scope.
    let plannedTotal = 0;
    const planned = new Map<string, number>();
    for (const entry of manifests) {
      // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
      const preview = await backfillSqliteRecordSemanticTimesForManifest(entry.manifest, {
        dryRun: true,
        mode: "ingest-stamped",
      });
      const changed = reportStreams(entry.connectorId, preview.streams);
      planned.set(entry.connectorId, changed);
      plannedTotal += changed;
    }
    console.log(`\nplanned changes: ${plannedTotal} record(s)`);

    if (!args.apply) {
      console.log("dry run only; re-run with --apply to write");
      return;
    }

    let appliedTotal = 0;
    console.log("\napplying...");
    for (const entry of manifests) {
      if ((planned.get(entry.connectorId) ?? 0) === 0) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
      const result = await backfillSqliteRecordSemanticTimesForManifest(entry.manifest, {
        mode: "ingest-stamped",
      });
      appliedTotal += result.updated;
      console.log(`  ${entry.connectorId}: updated ${result.updated}`);
    }
    console.log(`\napplied changes: ${appliedTotal} record(s)`);
  } finally {
    closeDb();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
