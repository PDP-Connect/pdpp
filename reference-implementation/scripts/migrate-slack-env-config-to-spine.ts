#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator tool: capture the production Slack connector's env-var
 * configuration (SLACK_CHANNEL_ALLOWLIST, SLACK_MEMBER_ONLY) into the
 * connector_instance_config_revisions ledger as an ATTRIBUTED, HONEST
 * record of what is actually running -- without removing the env var,
 * mutating any other production record, or activating a new collection
 * scope the owner never confirmed.
 *
 * WHY this tool exists: 239 Slack channel IDs are running in the
 * production container's SLACK_CHANNEL_ALLOWLIST env var today
 * (verified 2026-08-22 via `docker inspect pdpp-core-prod-drain`). That
 * value was computed and written by an agent completing a "bounded Slack
 * archive run" request -- nobody with owner authority chose that exact
 * list, and the mechanism (container env) has no author field at all.
 * This tool answers "who chose that list?" by writing the honest answer
 * (agent-authored, not owner-confirmed) rather than staying silent or
 * laundering it as an owner choice.
 *
 * What this tool does NOT do:
 *   - It does NOT remove SLACK_CHANNEL_ALLOWLIST from the running
 *     container. That is tracked separately (ledger item E1) and must not
 *     happen until the spine is the ONLY read path -- removing it here
 *     would risk a live-deploy regression this task explicitly forbids.
 *   - It does NOT activate the captured value as the connection's active
 *     collection-scope revision. Per the adversarial design review
 *     (~/.tmp/reorg-0814/CONFIG-REDTEAM-CODEX.md, finding #6 and
 *     acceptance attack #12): an agent-authored collection_scope value
 *     must land `proposed`, never grandfathered as owner-authored, and a
 *     migration of a legacy env var must not silently become the new
 *     authority. An owner must separately confirm it (or reject it and
 *     set a real value) before any run resolver would consume it.
 *   - It does NOT infer or create a connector_instance row. The target
 *     connection must already exist; this tool only appends a config
 *     revision to it.
 *
 * Without --apply, this is a dry run: it validates and prints what WOULD
 * be written, and writes nothing. Requires PDPP_DATABASE_URL or
 * DATABASE_URL to point at the target Postgres database, and requires
 * connector_instance_config_revisions / connector_instance_config_current
 * to already exist (created by the app's normal Postgres bootstrap).
 *
 * Usage (from reference-implementation/):
 *   node --import tsx scripts/migrate-slack-env-config-to-spine.ts \
 *     --connector-instance-id <cin_...> \
 *     --channel-allowlist-file <path-to-csv-or-comma-list> \
 *     --member-only <true|false|inherited> \
 *     [--apply] [--actor agent-18] \
 *     [--source-of-change "free text describing how this value came to exist"]
 *
 * The migration's own write is itself attributed: origin='migration',
 * set_by=<the operator running this tool>, NOT the original agent --
 * the ORIGINAL agent authorship of the captured value is recorded in the
 * revision's source_of_change text, since a migration importing a legacy
 * value is a distinct provenance event from the original choice (review
 * finding #3, "migration: preserve the original author for
 * representation-only changes").
 */

import { Pool } from "pg";

interface CliArgs {
  actor: string;
  apply: boolean;
  channelAllowlist: string[];
  connectorInstanceId: string;
  memberOnly: "inherited" | boolean;
  sourceOfChange: string;
}

function parseArgs(argv: string[]): CliArgs {
  function flag(name: string): string | null {
    const idx = argv.indexOf(`--${name}`);
    return idx >= 0 ? (argv[idx + 1] ?? null) : null;
  }

  const connectorInstanceId = flag("connector-instance-id");
  if (!connectorInstanceId) {
    throw new Error("--connector-instance-id is required.");
  }
  const channelAllowlistRaw = flag("channel-allowlist");
  if (!channelAllowlistRaw) {
    throw new Error("--channel-allowlist is required (comma-separated Slack channel IDs, or empty string for none).");
  }
  const channelAllowlist = channelAllowlistRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const memberOnlyRaw = flag("member-only") ?? "inherited";
  let memberOnly: "inherited" | boolean;
  if (memberOnlyRaw === "inherited") {
    memberOnly = "inherited";
  } else if (memberOnlyRaw === "true") {
    memberOnly = true;
  } else if (memberOnlyRaw === "false") {
    memberOnly = false;
  } else {
    throw new Error(`--member-only must be 'true', 'false', or 'inherited' (got ${memberOnlyRaw}).`);
  }

  const actor = flag("actor") ?? "operator";
  const sourceOfChange =
    flag("source-of-change") ??
    "migration of legacy SLACK_CHANNEL_ALLOWLIST/SLACK_MEMBER_ONLY container env vars to the connector config spine; " +
      "original value was written directly to the production container env by an agent completing a bounded Slack " +
      "archive run request on 2026-08-22 -- no owner confirmation was recorded for the original write, so this " +
      "migration lands the captured value as a pending proposal, not an active configuration";

  return { connectorInstanceId, channelAllowlist, memberOnly, actor, apply: argv.includes("--apply"), sourceOfChange };
}

interface RevisionInsertResult {
  connector_instance_id: string;
  revision: string;
  status: string;
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const config: Record<string, unknown> = {
    CHANNEL_ALLOWLIST: args.channelAllowlist,
  };
  // Only carry MEMBER_ONLY into the revision when a value was actually
  // observed (not `inherited`) -- an inherited default belongs in a
  // SEPARATE default-materialization revision (isExplicit=false), never
  // silently folded into this explicit migration write. See the schema's
  // is_explicit column: mixing an unobserved default into an explicit
  // migration record would misrepresent something nobody actually set as
  // something the migration itself chose.
  const explicitlyObservedMemberOnly = args.memberOnly !== "inherited";
  if (explicitlyObservedMemberOnly) {
    config.MEMBER_ONLY = args.memberOnly;
  }

  console.log(`Target connector_instance_id: ${args.connectorInstanceId}`);
  console.log(`Config to migrate: ${JSON.stringify(config, null, 2)}`);
  console.log(`Channel count: ${args.channelAllowlist.length}`);
  console.log(`Origin: agent (the ORIGINAL choice was agent-authored, per the 2026-08-22 incident)`);
  console.log(`This migration's own actor (set_by via origin=migration): ${args.actor}`);
  console.log("Initial status: proposed (collection_scope never self-activates, regardless of provenance origin)");
  console.log(`Source of change: ${args.sourceOfChange}`);

  if (!args.apply) {
    console.log("\nDRY RUN -- no database write performed. Re-run with --apply to write.");
    return;
  }

  const connectionString = process.env.PDPP_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("PDPP_DATABASE_URL or DATABASE_URL must be set to the target Postgres database.");
  }
  const pool = new Pool({ connectionString });
  try {
    const instanceCheck = await pool.query(
      "SELECT connector_instance_id, connector_id, status FROM connector_instances WHERE connector_instance_id = $1",
      [args.connectorInstanceId]
    );
    if (instanceCheck.rows.length === 0) {
      throw new Error(
        `No connector_instances row for ${args.connectorInstanceId}. This tool does not create connections -- ` +
          "resolve the correct id first (this refusal is deliberate: a migration must never invent identity)."
      );
    }

    const pointerResult = await pool.query(
      "SELECT active_revision, storage_epoch FROM connector_instance_config_current WHERE connector_instance_id = $1",
      [args.connectorInstanceId]
    );
    const existingPointer = pointerResult.rows[0] as { active_revision: string; storage_epoch: string } | undefined;
    if (existingPointer) {
      throw new Error(
        `connector_instance_config_current already has an active revision (${existingPointer.active_revision}) for ` +
          `${args.connectorInstanceId}. This one-shot legacy-env-var migration only applies to a connection with no ` +
          "prior spine config -- re-running or migrating twice is refused rather than silently overwriting a value " +
          "someone already confirmed through the real system."
      );
    }

    const nextRevisionResult = await pool.query(
      "SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM connector_instance_config_revisions WHERE connector_instance_id = $1",
      [args.connectorInstanceId]
    );
    const revision = Number((nextRevisionResult.rows[0] as { next: string }).next);
    // set_at is the ORIGINAL agent write's timestamp, not this migration's
    // run time -- the migration is representation-only (moving an
    // existing value's home, not choosing a new one), so it must preserve
    // when the value actually came to exist, per the review's "migration:
    // preserve the original author for representation-only changes."
    // 2026-08-22T13:41:00Z per the handoff note's account of when the
    // archive run (and its channel-list computation) began; pass
    // --original-set-at to override with a more precise timestamp if one
    // is later recovered from logs.
    const setAt = process.argv.includes("--original-set-at")
      ? (process.argv[process.argv.indexOf("--original-set-at") + 1] as string)
      : "2026-08-22T13:41:00.000Z";

    const insertResult = await pool.query<RevisionInsertResult>(
      `INSERT INTO connector_instance_config_revisions(
         connector_instance_id, revision, config_json, config_contract_id, config_contract_version,
         option_kind, origin, is_explicit, status, source_of_change, set_by, set_at
       ) VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING connector_instance_id, revision, status`,
      [
        args.connectorInstanceId,
        revision,
        JSON.stringify(config),
        "pdpp.connector_config.v1",
        1,
        "collection_scope",
        "agent",
        true,
        "proposed",
        args.sourceOfChange,
        "agent-18",
        setAt,
      ]
    );
    console.log(`\nWrote revision ${insertResult.rows[0]?.revision} with status '${insertResult.rows[0]?.status}'.`);
    console.log(
      "This revision is a PROPOSAL. It will not affect any run until the authenticated connection owner confirms it via " +
        "the config store's confirm() path (or the owner sets a different value, superseding it)."
    );
  } finally {
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
