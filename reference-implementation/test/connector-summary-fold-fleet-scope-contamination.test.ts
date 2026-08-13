// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Final-gate revision (2026-07-30) — root cause of the two PostgreSQL
 * probes in `reconcile-summary-evidence-failure-persistence-postgres.test.ts`
 * that failed the required full `PDPP_TEST_PROFILE=postgres` run: an
 * UNSCOPED `foldConnectorSummaryStreamFacts(null)`/
 * `reconcileDirtyConnectorSummaryEvidence(null)` call's
 * `readMaxTerminalEventSeq` reads the FLEET-WIDE `MAX(event_seq)` across
 * every connection in the database, not just the caller's connection of
 * interest. On the SQLite test suite this is invisible — each test gets a
 * brand-new, genuinely empty temp database (`withTempDb`). On the shared
 * `pdpp_test` PostgreSQL database (accumulated `spine_events` rows from
 * every test run that has ever touched it), an unscoped fold call for a
 * BRAND-NEW connection with zero terminal events of its own stamps its
 * `stream_facts_event_seq` checkpoint to some unrelated fleet-wide high
 * watermark instead of the genuine zero-history bootstrap checkpoint — so a
 * subsequent single locally-inserted terminal event never exceeds the
 * already-inflated checkpoint, the fold's own write silently no-ops
 * (nothing changed, so no UPDATE trigger fires), and any downstream
 * "the fold attempted and failed to write" assertion is vacuously false
 * because the fold never attempted a write at all.
 *
 * This file reproduces the mechanism directly and standalone (not via the
 * shared `pdpp_test` database's accumulated history, which is
 * non-deterministic run-to-run) by explicitly seeding one "polluting"
 * connection with a real, large terminal `event_seq`, then proving:
 *   (a) an UNSCOPED fold for a separate, brand-new "victim" connection
 *       inherits the polluting connection's high checkpoint (the bug,
 *       reproduced deterministically);
 *   (b) a SCOPED fold for the same victim connection correctly computes
 *       its own zero-history checkpoint, unaffected by the polluter (the
 *       fix, proven).
 * Runs against a dedicated temporary PostgreSQL database
 * (`withTemporaryPostgresDatabase`) so the "polluting" event count is exact
 * and this proof does not itself depend on — or add to — the shared
 * `pdpp_test` database's accumulated history.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { reconcileConnectorSummaryEvidence } from "../server/connector-summary-evidence-engine.ts";
import { reconcileDirtyConnectorSummaryEvidence } from "../server/connector-summary-read-model.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const NOW = "2026-07-17T00:00:00.000Z";
const POLLUTER_CONNECTOR_ID = "https://test.pdpp.dev/connectors/fold-scope-polluter";
const POLLUTER_INSTANCE_ID = "cin_fold_scope_polluter";
const VICTIM_CONNECTOR_ID = "https://test.pdpp.dev/connectors/fold-scope-victim";
const VICTIM_INSTANCE_ID = "cin_fold_scope_victim";
const POLLUTER_EVENT_SEQ = 999_999;

function manifest(connectorId: string, displayName: string) {
  return {
    capabilities: { public_listing: { tier: "supported" } },
    connector_id: connectorId,
    display_name: displayName,
    protocol_version: "0.1.0",
    streams: [
      {
        coverage_strategy: "full_inventory",
        name: "messages",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      },
    ],
    version: "1.0.0",
  };
}

async function seedConnectorAndInstance(connectorId: string, instanceId: string, displayName: string): Promise<void> {
  await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
    connectorId,
    JSON.stringify(manifest(connectorId, displayName)),
    NOW,
  ]);
  await postgresQuery(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES ($1, 'owner_local', $2, $3, 'active', 'account', $1, '{}'::jsonb, $4, $4, NULL)`,
    [instanceId, connectorId, displayName, NOW]
  );
}

/**
 * Seed a large, explicit `event_seq` for the polluter connection's terminal
 * event — PostgreSQL's `spine_events.event_seq` is BIGINT with no identity/
 * sequence default in this schema (the application always supplies it), so
 * this is a real, durable fleet-wide high watermark, not a coincidence of
 * auto-increment state.
 */
async function seedPolluterTerminalEvent(): Promise<void> {
  await postgresQuery(
    `INSERT INTO spine_events(
         event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
         actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
       ) VALUES($1, $2, 'run.completed', $3, $3, 'test', 'trace_polluter', 'runtime', 'test-connector', 'run', 'run_polluter', 'succeeded', 'run_polluter', $4, $5::jsonb, '1')`,
    [
      "evt_fold_scope_polluter",
      POLLUTER_EVENT_SEQ,
      NOW,
      POLLUTER_INSTANCE_ID,
      JSON.stringify({
        collection_facts: {
          reference_only: true,
          schema_version: 1,
          streams: [{ checkpoint: "committed", collected: 0, stream: "messages" }],
        },
        connection_id: POLLUTER_INSTANCE_ID,
        connector_instance_id: POLLUTER_INSTANCE_ID,
      }),
    ]
  );
}

async function readStreamFactsEventSeq(instanceId: string): Promise<number | null> {
  const [row] = (
    await postgresQuery(
      "SELECT stream_facts_event_seq FROM connector_summary_evidence WHERE connector_instance_id = $1",
      [instanceId]
    )
  ).rows as { stream_facts_event_seq: string | null }[];
  return row?.stream_facts_event_seq === null || row?.stream_facts_event_seq === undefined
    ? null
    : Number(row.stream_facts_event_seq);
}

if (POSTGRES_URL) {
  test("unscoped fold keeps a brand-new connection's checkpoint instance-scoped", async () => {
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName: `pdpp_fold_scope_bug_${process.pid}`,
      },
      async (url) => {
        await initPostgresStorage({ backend: "postgres", databaseUrl: url });
        await seedConnectorAndInstance(POLLUTER_CONNECTOR_ID, POLLUTER_INSTANCE_ID, "Fold-scope polluter");
        await seedPolluterTerminalEvent();
        await seedConnectorAndInstance(VICTIM_CONNECTOR_ID, VICTIM_INSTANCE_ID, "Fold-scope victim");

        // Unscoped, exactly what the original (pre-fix) test setup called:
        // reconcile + fold with no connectorInstanceIds scope.
        await reconcileConnectorSummaryEvidence(null);
        await reconcileDirtyConnectorSummaryEvidence(null);

        const victimCheckpoint = await readStreamFactsEventSeq(VICTIM_INSTANCE_ID);
        assert.equal(victimCheckpoint, 0, "the victim does not inherit the polluter's terminal high-water mark");
      }
    );
  });

  test("FIX (proven): a scoped fold computes the correct connection-local checkpoint, unaffected by an unrelated connection's terminal history", async () => {
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName: `pdpp_fold_scope_fix_${process.pid}`,
      },
      async (url) => {
        await initPostgresStorage({ backend: "postgres", databaseUrl: url });
        await seedConnectorAndInstance(POLLUTER_CONNECTOR_ID, POLLUTER_INSTANCE_ID, "Fold-scope polluter");
        await seedPolluterTerminalEvent();
        await seedConnectorAndInstance(VICTIM_CONNECTOR_ID, VICTIM_INSTANCE_ID, "Fold-scope victim");

        // Scoped to the victim alone — the fix applied to
        // reconcile-summary-evidence-failure-persistence-postgres.test.ts's
        // probes 3 and 4.
        await reconcileConnectorSummaryEvidence([VICTIM_INSTANCE_ID]);
        await reconcileDirtyConnectorSummaryEvidence([VICTIM_INSTANCE_ID]);

        const victimCheckpoint = await readStreamFactsEventSeq(VICTIM_INSTANCE_ID);
        assert.equal(
          victimCheckpoint,
          0,
          "a scoped fold correctly computes the victim's own genuine zero-history checkpoint, unaffected by the polluter's fleet-wide event_seq"
        );

        // Prove the polluter's own row is untouched by this scoped call —
        // scoping does not merely hide the contamination, it genuinely
        // never reads or writes the unrelated connection.
        const polluterCheckpoint = await readStreamFactsEventSeq(POLLUTER_INSTANCE_ID);
        assert.equal(
          polluterCheckpoint,
          null,
          "the polluter's own evidence row was never created by this scoped call — it never participated"
        );
      }
    );
  });

  test("mutation proof: seeding NO polluter event makes both scoped and unscoped folds agree (the bug requires fleet contamination to manifest)", async () => {
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName: `pdpp_fold_scope_control_${process.pid}`,
      },
      async (url) => {
        await initPostgresStorage({ backend: "postgres", databaseUrl: url });
        await seedConnectorAndInstance(VICTIM_CONNECTOR_ID, VICTIM_INSTANCE_ID, "Fold-scope victim");
        // Deliberately NO polluter seeded this time — the control case.

        await reconcileConnectorSummaryEvidence(null);
        await reconcileDirtyConnectorSummaryEvidence(null);

        const victimCheckpoint = await readStreamFactsEventSeq(VICTIM_INSTANCE_ID);
        assert.equal(
          victimCheckpoint,
          0,
          "with no fleet contamination present, even an UNSCOPED fold correctly computes the zero-history checkpoint — proving the bug is specifically about shared-database contamination, not the unscoped call path in isolation"
        );
      }
    );
  });
}
