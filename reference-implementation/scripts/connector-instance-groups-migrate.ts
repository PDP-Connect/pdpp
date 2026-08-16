#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator tool: apply (or dry-run) a set of explicit connector-instance
 * groupings against Postgres. This is the ONLY way `connector_instance_groups`
 * rows should be written in production -- there is no runtime code path that
 * infers or writes a grouping automatically.
 *
 * A "grouping" declares that a fragment `connector_instances` row is the SAME
 * logical provider account as a canonical row. It is a pure alias/read-model
 * fact: this tool NEVER rewrites `connector_instances`, moves `records`, or
 * deletes anything. See server/connector-instance-canonicalization.ts for the
 * read-side resolver this table feeds, and the mapping input format below.
 *
 * Usage (from reference-implementation/):
 *   node --import tsx scripts/connector-instance-groups-migrate.ts <mappings.json>
 *       [--apply] [--actor <name>]
 *
 * Without --apply, this is a dry run: it validates every mapping, prints what
 * WOULD change, and writes nothing. Requires PDPP_DATABASE_URL or
 * DATABASE_URL to point at the target Postgres database. Requires
 * connector_instance_groups to already exist (created by the app's normal
 * Postgres bootstrap — run the app once against the target DB first, or apply
 * the CREATE TABLE block from server/postgres-storage.ts by hand).
 *
 * Mapping file shape (JSON array). Each entry is either a grouping directive
 * or an explicit no-group record (documents a considered-but-rejected pair so
 * the decision is never silent):
 *
 *   {
 *     "connectorInstanceId": "cin_...",        // the fragment
 *     "canonicalConnectorInstanceId": "cin_...", // the canonical row, or null for a no-group record
 *     "reason": "proven_subset" | "verified_identity" | "owner_confirmed" | "unresolved_identity",
 *     "evidence": { ...free-form proof, e.g. overlap counts, verified email, owner confirmation timestamp... }
 *   }
 *
 * Entries with `canonicalConnectorInstanceId: null` are validated (fragment
 * exists, owner matches) but never written to connector_instance_groups --
 * they exist purely so a rejected pairing (e.g. GitHub's different provider
 * user id) is recorded in the audit output as a considered-and-declined case,
 * not silently absent from the mapping file.
 */

import { readFileSync } from "node:fs";
import { Pool } from "pg";

interface MappingEntry {
  canonicalConnectorInstanceId: string | null;
  connectorInstanceId: string;
  evidence: Record<string, unknown>;
  reason: string;
}

interface ConnectorInstanceRow {
  connector_id: string;
  connector_instance_id: string;
  owner_subject_id: string;
  status: string;
}

interface AuditEntry {
  canonicalConnectorInstanceId: string | null;
  connectorInstanceId: string;
  detail: string;
  outcome: "grouped" | "unchanged" | "no_group_recorded" | "refused" | "would_group" | "would_be_no_op";
  reason: string;
}

function parseArgs(argv: string[]): { mappingsPath: string; apply: boolean; actor: string } {
  const positionals = argv.filter((arg) => !arg.startsWith("--"));
  const [mappingsPath] = positionals;
  if (!mappingsPath) {
    throw new Error(
      "Usage (from reference-implementation/): node --import tsx scripts/connector-instance-groups-migrate.ts <mappings.json> [--apply] [--actor <name>]"
    );
  }
  const apply = argv.includes("--apply");
  const actorFlagIndex = argv.indexOf("--actor");
  const actor = actorFlagIndex >= 0 ? argv[actorFlagIndex + 1] : "operator";
  if (!actor) {
    throw new Error("--actor requires a value.");
  }
  return { actor, apply, mappingsPath };
}

function loadMappings(path: string): MappingEntry[] {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw)) {
    throw new Error(`${path} must contain a JSON array of mapping entries.`);
  }
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Mapping entry ${index} is not an object.`);
    }
    const { connectorInstanceId, canonicalConnectorInstanceId, reason, evidence } = entry as Record<string, unknown>;
    if (typeof connectorInstanceId !== "string" || connectorInstanceId.length === 0) {
      throw new Error(`Mapping entry ${index}: connectorInstanceId is required.`);
    }
    if (canonicalConnectorInstanceId !== null && typeof canonicalConnectorInstanceId !== "string") {
      throw new Error(`Mapping entry ${index}: canonicalConnectorInstanceId must be a string or null.`);
    }
    if (typeof reason !== "string" || reason.length === 0) {
      throw new Error(`Mapping entry ${index}: reason is required.`);
    }
    if (evidence !== undefined && (typeof evidence !== "object" || evidence === null || Array.isArray(evidence))) {
      throw new Error(`Mapping entry ${index}: evidence must be an object when present.`);
    }
    return {
      canonicalConnectorInstanceId: canonicalConnectorInstanceId as string | null,
      connectorInstanceId,
      evidence: evidence === undefined ? {} : (evidence as Record<string, unknown>),
      reason,
    };
  });
}

async function fetchInstance(pool: Pool, connectorInstanceId: string): Promise<ConnectorInstanceRow | null> {
  const result = await pool.query<ConnectorInstanceRow>(
    "SELECT connector_instance_id, owner_subject_id, connector_id, status FROM connector_instances WHERE connector_instance_id = $1",
    [connectorInstanceId]
  );
  return result.rows[0] ?? null;
}

async function fragmentHasLiveSyncState(pool: Pool, connectorInstanceId: string): Promise<boolean> {
  const credential = await pool.query(
    "SELECT 1 FROM connector_instance_credentials WHERE connector_instance_id = $1 AND status = 'active'",
    [connectorInstanceId]
  );
  if ((credential.rowCount ?? 0) > 0) {
    return true;
  }
  const schedule = await pool.query(
    "SELECT 1 FROM connector_schedules WHERE connector_instance_id = $1 AND enabled = true",
    [connectorInstanceId]
  );
  return (schedule.rowCount ?? 0) > 0;
}

/**
 * Validates one mapping entry against the live database and returns the
 * audit entry describing what happened (dry-run) or what will happen
 * (apply). Never writes when `apply` is false. Refuses (never groups) when:
 *   - the fragment or canonical row doesn't exist
 *   - the fragment and canonical row have different owners
 *   - the fragment IS the canonical row (self-grouping)
 *   - the canonical row is itself already a grouped fragment (no transitive
 *     chains -- a canonical id must be a terminal identity)
 *   - the fragment carries live credentials or an enabled schedule (grouping
 *     it would silently orphan real sync state)
 */
async function applyMapping(
  pool: Pool,
  entry: MappingEntry,
  { apply, actor, now }: { apply: boolean; actor: string; now: string }
): Promise<AuditEntry> {
  if (entry.canonicalConnectorInstanceId === null) {
    const fragment = await fetchInstance(pool, entry.connectorInstanceId);
    if (!fragment) {
      return {
        canonicalConnectorInstanceId: null,
        connectorInstanceId: entry.connectorInstanceId,
        detail: `Fragment '${entry.connectorInstanceId}' not found; no-group record still logged.`,
        outcome: "no_group_recorded",
        reason: entry.reason,
      };
    }
    return {
      canonicalConnectorInstanceId: null,
      connectorInstanceId: entry.connectorInstanceId,
      detail: `Explicitly declined to group '${entry.connectorInstanceId}' (${entry.reason}). No connector_instance_groups row written or removed.`,
      outcome: "no_group_recorded",
      reason: entry.reason,
    };
  }

  const canonicalId = entry.canonicalConnectorInstanceId;

  if (entry.connectorInstanceId === canonicalId) {
    return {
      canonicalConnectorInstanceId: canonicalId,
      connectorInstanceId: entry.connectorInstanceId,
      detail: "Refused: fragment and canonical id are the same row.",
      outcome: "refused",
      reason: entry.reason,
    };
  }

  const [fragment, canonical] = await Promise.all([
    fetchInstance(pool, entry.connectorInstanceId),
    fetchInstance(pool, canonicalId),
  ]);

  if (!fragment) {
    return {
      canonicalConnectorInstanceId: canonicalId,
      connectorInstanceId: entry.connectorInstanceId,
      detail: `Refused: fragment '${entry.connectorInstanceId}' does not exist.`,
      outcome: "refused",
      reason: entry.reason,
    };
  }
  if (!canonical) {
    return {
      canonicalConnectorInstanceId: canonicalId,
      connectorInstanceId: entry.connectorInstanceId,
      detail: `Refused: canonical '${canonicalId}' does not exist.`,
      outcome: "refused",
      reason: entry.reason,
    };
  }
  if (fragment.owner_subject_id !== canonical.owner_subject_id) {
    return {
      canonicalConnectorInstanceId: canonicalId,
      connectorInstanceId: entry.connectorInstanceId,
      detail: `Refused: fragment owner '${fragment.owner_subject_id}' does not match canonical owner '${canonical.owner_subject_id}'.`,
      outcome: "refused",
      reason: entry.reason,
    };
  }

  const canonicalIsAlreadyFragment = await pool.query(
    "SELECT 1 FROM connector_instance_groups WHERE connector_instance_id = $1",
    [canonicalId]
  );
  if ((canonicalIsAlreadyFragment.rowCount ?? 0) > 0) {
    return {
      canonicalConnectorInstanceId: canonicalId,
      connectorInstanceId: entry.connectorInstanceId,
      detail: `Refused: '${canonicalId}' is itself a grouped fragment; canonical targets must be terminal (no transitive chains).`,
      outcome: "refused",
      reason: entry.reason,
    };
  }

  if (await fragmentHasLiveSyncState(pool, entry.connectorInstanceId)) {
    return {
      canonicalConnectorInstanceId: canonicalId,
      connectorInstanceId: entry.connectorInstanceId,
      detail: `Refused: fragment '${entry.connectorInstanceId}' has an active credential or enabled schedule; grouping it would orphan live sync state.`,
      outcome: "refused",
      reason: entry.reason,
    };
  }

  const existing = await pool.query<{ canonical_connector_instance_id: string; reason: string }>(
    "SELECT canonical_connector_instance_id, reason FROM connector_instance_groups WHERE connector_instance_id = $1",
    [entry.connectorInstanceId]
  );
  const [existingRow] = existing.rows;
  if (
    existingRow &&
    existingRow.canonical_connector_instance_id === canonicalId &&
    existingRow.reason === entry.reason
  ) {
    return {
      canonicalConnectorInstanceId: canonicalId,
      connectorInstanceId: entry.connectorInstanceId,
      detail: "Already grouped identically; idempotent no-op.",
      outcome: apply ? "unchanged" : "would_be_no_op",
      reason: entry.reason,
    };
  }

  if (!apply) {
    return {
      canonicalConnectorInstanceId: canonicalId,
      connectorInstanceId: entry.connectorInstanceId,
      detail: `Would group '${entry.connectorInstanceId}' -> '${canonicalId}' (${entry.reason}). Dry run: no write performed.`,
      outcome: "would_group",
      reason: entry.reason,
    };
  }

  await pool.query(
    `INSERT INTO connector_instance_groups(
       connector_instance_id, canonical_connector_instance_id, owner_subject_id, reason, evidence, grouped_by, grouped_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT(connector_instance_id) DO UPDATE SET
       canonical_connector_instance_id = excluded.canonical_connector_instance_id,
       reason = excluded.reason,
       evidence = excluded.evidence,
       grouped_by = excluded.grouped_by,
       grouped_at = excluded.grouped_at`,
    [
      entry.connectorInstanceId,
      canonicalId,
      fragment.owner_subject_id,
      entry.reason,
      JSON.stringify(entry.evidence),
      actor,
      now,
    ]
  );

  return {
    canonicalConnectorInstanceId: canonicalId,
    connectorInstanceId: entry.connectorInstanceId,
    detail: `Grouped '${entry.connectorInstanceId}' -> '${canonicalId}' (${entry.reason}).`,
    outcome: "grouped",
    reason: entry.reason,
  };
}

async function main(): Promise<void> {
  const { mappingsPath, apply, actor } = parseArgs(process.argv.slice(2));
  const mappings = loadMappings(mappingsPath);

  const databaseUrl = process.env.PDPP_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("PDPP_DATABASE_URL or DATABASE_URL is required to run this tool.");
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const tableCheck = await pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_name = 'connector_instance_groups'"
    );
    if ((tableCheck.rowCount ?? 0) === 0) {
      throw new Error(
        "connector_instance_groups does not exist on the target database. Start the app once against this database (it bootstraps the table), then re-run this tool."
      );
    }

    const now = new Date().toISOString();
    const audit: AuditEntry[] = [];
    for (const entry of mappings) {
      // Deliberately sequential, not Promise.all: a later mapping entry's
      // "canonical is itself already a grouped fragment" refusal check reads
      // connector_instance_groups, so entries earlier in THIS run must be
      // durably applied (or refused) before a later entry can see them --
      // running them concurrently could let two entries in the same file
      // both pass that check by racing each other.
      // biome-ignore lint/performance/noAwaitInLoops: intentional in-order application, see comment above
      audit.push(await applyMapping(pool, entry, { actor, apply, now }));
    }

    console.log(
      JSON.stringify(
        {
          actor,
          mode: apply ? "apply" : "dry_run",
          ranAt: now,
          results: audit,
          summary: {
            grouped: audit.filter((a) => a.outcome === "grouped").length,
            no_group_recorded: audit.filter((a) => a.outcome === "no_group_recorded").length,
            refused: audit.filter((a) => a.outcome === "refused").length,
            unchanged: audit.filter((a) => a.outcome === "unchanged" || a.outcome === "would_be_no_op").length,
            would_group: audit.filter((a) => a.outcome === "would_group").length,
          },
        },
        null,
        2
      )
    );

    const refused = audit.filter((a) => a.outcome === "refused");
    if (refused.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
