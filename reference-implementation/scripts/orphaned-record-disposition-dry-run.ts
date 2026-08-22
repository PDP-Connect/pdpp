// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Orphaned-record disposition DRY RUN. Reports only — never mutates.
 *
 * Two distinct conditions strand the owner's records, and they need different
 * dispositions. This script classifies every affected connector instance and
 * prints a table the owner can approve or reject. It issues `SELECT`
 * statements exclusively: no DELETE, no UPDATE, no INSERT, no reassociation.
 *
 * Condition A — ORPHANED: live records whose `connector_instance_id` has no
 * `connector_instances` row. `records` has no foreign key to
 * `connector_instances`, so a connection delete leaves its rows behind. No
 * owner surface enumerates these, so they are invisible everywhere.
 *
 * Condition B — HIDDEN FRAGMENT: a `connector_instances` row that DOES exist
 * but is excluded from the Sources list by
 * `SOURCES_VISIBLE_IDENTITY_PAGE` (binding kind `historical_archive` +
 * `recovery_reason` `connection_metadata_missing`, no UAT-transfer marker).
 * These remain reachable through Explore's connection facets; they are hidden
 * from one list, not stranded.
 *
 * For each orphaned instance the script computes whether its records are a
 * strict subset of what a surviving connection for the same connector already
 * holds, keyed on `(stream, record_key)`. That is the difference between
 * "provable duplicate, safe to drop" and "unique data that must be surfaced".
 *
 * Usage (Postgres):
 *   PDPP_STORAGE_BACKEND=postgres DATABASE_URL=... \
 *     node --experimental-strip-types scripts/orphaned-record-disposition-dry-run.ts
 */

import {
  closePostgresStorage,
  initExistingPostgresRepairStorage,
  postgresQuery,
  resolveStorageBackend,
} from "../server/postgres-storage.ts";

interface OrphanDispositionRow {
  connector_id: string | null;
  connector_instance_id: string;
  live_records: string | number;
  streams: string | number;
  tombstoned: boolean;
  unique_records: string | number;
  [column: string]: unknown;
}

interface FragmentRow {
  connector_id: string;
  connector_instance_id: string;
  live_records: string | number;
  sibling_visible: string | number;
  status: string;
  [column: string]: unknown;
}

// Orphaned instances, with a per-instance count of records that exist under
// NO surviving connection for the same connector. `connector_id` is taken
// from the records themselves (the instance row is gone, so it is the only
// surviving attribution). The duplicate test is keyed on
// `(stream, record_key)` — the same identity the ingest UNIQUE constraint
// uses — against every instance that still has a row.
const ORPHAN_DISPOSITION_SQL = `
WITH orphan AS (
  SELECT r.connector_instance_id, r.connector_id, r.stream, r.record_key
  FROM records r
  LEFT JOIN connector_instances ci ON ci.connector_instance_id = r.connector_instance_id
  WHERE NOT r.deleted AND ci.connector_instance_id IS NULL
),
surviving AS (
  SELECT DISTINCT r.connector_id, r.stream, r.record_key
  FROM records r
  JOIN connector_instances ci ON ci.connector_instance_id = r.connector_instance_id
  WHERE NOT r.deleted
)
SELECT
  o.connector_instance_id,
  MIN(o.connector_id) AS connector_id,
  EXISTS (
    SELECT 1 FROM connector_instance_tombstones t
    WHERE t.connector_instance_id = o.connector_instance_id
  ) AS tombstoned,
  COUNT(*) AS live_records,
  COUNT(*) FILTER (WHERE s.record_key IS NULL) AS unique_records,
  COUNT(DISTINCT o.stream) AS streams
FROM orphan o
LEFT JOIN surviving s
  ON s.connector_id = o.connector_id
 AND s.stream = o.stream
 AND s.record_key = o.record_key
GROUP BY o.connector_instance_id
ORDER BY COUNT(*) FILTER (WHERE s.record_key IS NULL) DESC, COUNT(*) DESC`;

// Instances the Sources list hides but that still exist and stay reachable
// through Explore. Reported so the owner can see the whole invisible-ish
// surface in one table, clearly separated from true orphans.
const HIDDEN_FRAGMENT_SQL = `
SELECT
  ci.connector_instance_id,
  ci.connector_id,
  ci.status,
  (SELECT COUNT(*) FROM records r
    WHERE r.connector_instance_id = ci.connector_instance_id AND NOT r.deleted) AS live_records,
  (SELECT COUNT(*) FROM connector_instances v
    WHERE v.connector_id = ci.connector_id
      AND v.connector_instance_id <> ci.connector_instance_id
      AND COALESCE(v.source_binding_json->>'recovery_reason', '') <> 'connection_metadata_missing'
  ) AS sibling_visible
FROM connector_instances ci
WHERE ci.source_binding_json->>'kind' = 'historical_archive'
  AND COALESCE(ci.source_binding_json->>'recovery_reason', '') = 'connection_metadata_missing'
  AND ci.source_binding_json->>'latest_uat_source_instance_id' IS NULL
ORDER BY live_records DESC`;

function n(value: string | number | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : " ".repeat(width - value.length) + value;
}

/**
 * Disposition for an orphaned instance.
 *
 * `MERGE` is deliberately NOT auto-applied anywhere: unique records mean the
 * only correct move is to give the data a home the owner can see, and which
 * home is a decision the owner makes.
 */
function classify(liveRecords: number, uniqueRecords: number): string {
  if (liveRecords === 0) {
    return "NO-OP (no live records)";
  }
  if (uniqueRecords === 0) {
    return "DUPLICATE (provable subset)";
  }
  if (uniqueRecords === liveRecords) {
    return "UNIQUE (must be surfaced)";
  }
  return "MIXED (partly unique)";
}

async function main(): Promise<void> {
  const config = resolveStorageBackend();
  if (config.backend !== "postgres") {
    console.error(
      "This dry run targets the Postgres backend. Set PDPP_STORAGE_BACKEND=postgres and PDPP_DATABASE_URL."
    );
    process.exitCode = 1;
    return;
  }

  // Opens existing tables only — never runs DDL, migrations, or bootstrap.
  await initExistingPostgresRepairStorage(config);

  const orphans = (await postgresQuery<OrphanDispositionRow>(ORPHAN_DISPOSITION_SQL, [])).rows;
  const fragments = (await postgresQuery<FragmentRow>(HIDDEN_FRAGMENT_SQL, [])).rows;

  console.log("");
  console.log("DRY RUN — reports only, mutates nothing.");
  console.log("");
  console.log("CONDITION A — ORPHANED: no connector_instances row; invisible on every surface.");
  console.log("");
  console.log(
    `${pad("connector_instance_id", 36)} ${pad("connector", 10)} ${padLeft("live", 8)} ${padLeft("unique", 8)} ${padLeft("streams", 8)}  tomb  disposition`
  );
  console.log("-".repeat(120));

  let orphanTotal = 0;
  let uniqueTotal = 0;
  for (const row of orphans) {
    const live = n(row.live_records);
    const unique = n(row.unique_records);
    orphanTotal += live;
    uniqueTotal += unique;
    console.log(
      `${pad(row.connector_instance_id, 36)} ${pad(row.connector_id ?? "-", 10)} ${padLeft(String(live), 8)} ${padLeft(String(unique), 8)} ${padLeft(String(n(row.streams)), 8)}  ${row.tombstoned ? " yes" : "  no"}  ${classify(live, unique)}`
    );
  }
  console.log("-".repeat(120));
  console.log(
    `${orphans.length} orphaned instance(s); ${orphanTotal} live record(s), of which ${uniqueTotal} exist under no surviving connection.`
  );

  console.log("");
  console.log("CONDITION B — HIDDEN FRAGMENT: instance row EXISTS; hidden from the Sources list only,");
  console.log("still reachable through Explore's connection facets.");
  console.log("");
  console.log(
    `${pad("connector_instance_id", 36)} ${pad("connector", 10)} ${pad("status", 8)} ${padLeft("live", 10)} ${padLeft("siblings", 9)}`
  );
  console.log("-".repeat(120));

  let fragmentTotal = 0;
  for (const row of fragments) {
    const live = n(row.live_records);
    fragmentTotal += live;
    console.log(
      `${pad(row.connector_instance_id, 36)} ${pad(row.connector_id, 10)} ${pad(row.status, 8)} ${padLeft(String(live), 10)} ${padLeft(String(n(row.sibling_visible)), 9)}`
    );
  }
  console.log("-".repeat(120));
  console.log(`${fragments.length} hidden fragment(s); ${fragmentTotal} live record(s).`);
  console.log("");
  console.log(`TOTAL not shown on /sources: ${orphanTotal + fragmentTotal} live record(s).`);
  console.log("");
  console.log("No mutation was performed. Owner approval is required before any remediation.");
}

try {
  await main();
} finally {
  await closePostgresStorage();
}
