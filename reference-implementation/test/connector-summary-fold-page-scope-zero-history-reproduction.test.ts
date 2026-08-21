// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reproduction (2026-08-18): two production rows (a finished Google Maps
 * Timeline import and a finished WhatsApp archive import, both
 * `source_kind='manual'`, zero `run.*`/terminal spine events ever) are
 * durably stuck at `terminal_facts_state: 'stale'` /
 * `terminal_facts_reason_code: 'terminal_facts_historical'` in production,
 * even though `connector-summary-historical-terminal-facts-health.test.ts`'s
 * own doc comment says a genuinely never-folded zero-history row "converges
 * to `terminal_facts_state: 'current'`... and never reaches
 * `terminal_facts_historical` at all."
 *
 * That existing test only exercises
 * `foldConnectorSummaryStreamFacts([INSTANCE_ID])` — a SINGLETON scope. The
 * real periodic maintenance sweep never calls the fold that way: it walks
 * PAGES of many connection ids at once
 * (`observeConnectorSummaryEvidence(pageIds, { deadline, ... })`, default
 * page size 25 — see `runBoundedSummaryEvidenceSweep` in
 * connector-summary-read-model.ts). When a zero-history row shares a page
 * with ANY other connection that has real terminal history (true for almost
 * any production page), `readMaxTerminalEventSeq(pageIds)` returns a
 * non-null, page-wide high-water mark, so the `maxSeq === null` bootstrap
 * branch (`stampZeroCheckpointForBootstrap`) never fires for that page at
 * all.
 *
 * The mechanism this file proves: `seedFoldState` seeds
 * `generationCurrentSeedByInstance` for each row from its OWN INCOMING
 * `terminal_facts_reason_code` — a row already stamped
 * `terminal_facts_historical` seeds `false` ("not current"). A zero-history
 * row's scoped terminal-event read always returns an empty batch (it has no
 * terminal events, full stop), so `foldTerminalEventFacts` — the ONLY thing
 * that can flip `generationCurrentByInstance` back to `true` — is never
 * invoked for it. The seeded `false` survives untouched to the write phase,
 * so `terminalFactsCurrent = ownReplayConverged && sourceGenerationCurrent`
 * evaluates to `false` even though `ownReplayConverged` is `true` (its own
 * cursor genuinely reached its own high-water). The row re-writes itself
 * back to `terminal_facts_historical` every single page-scoped pass,
 * forever — a self-perpetuating state with no path back to `current` once
 * ANYTHING (a stale pre-fairness-fix fold pass, or this same bug) first
 * stamps it `historical`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { reconcileDirtyConnectorSummaryEvidence } from "../server/connector-summary-read-model.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const NOW = "2026-07-17T00:00:00.000Z";
const POLLUTER_CONNECTOR_ID = "https://test.pdpp.dev/connectors/page-scope-polluter";
const POLLUTER_INSTANCE_ID = "cin_page_scope_polluter";
const VICTIM_CONNECTOR_ID = "https://test.pdpp.dev/connectors/page-scope-victim";
const VICTIM_INSTANCE_ID = "cin_page_scope_victim";
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

async function seedConnectorAndInstance(
  connectorId: string,
  instanceId: string,
  displayName: string,
  sourceKind = "account"
): Promise<void> {
  await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
    connectorId,
    JSON.stringify(manifest(connectorId, displayName)),
    NOW,
  ]);
  await postgresQuery(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES ($1, 'owner_local', $2, $3, 'paused', $4, $1, '{}'::jsonb, $5, $5, NULL)`,
    [instanceId, connectorId, displayName, sourceKind, NOW]
  );
}

async function seedPolluterTerminalEvent(): Promise<void> {
  await postgresQuery(
    `INSERT INTO spine_events(
         event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
         actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
       ) VALUES($1, $2, 'run.completed', $3, $3, 'test', 'trace_polluter', 'runtime', 'test-connector', 'run', 'run_polluter', 'succeeded', 'run_polluter', $4, $5::jsonb, '1')`,
    [
      "evt_page_scope_polluter",
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

async function readTerminalFacts(
  instanceId: string
): Promise<{ state: string | null; reasonCode: string | null; checkpoint: number | null }> {
  const [row] = (
    await postgresQuery(
      "SELECT terminal_facts_state, terminal_facts_reason_code, stream_facts_event_seq FROM connector_summary_evidence WHERE connector_instance_id = $1",
      [instanceId]
    )
  ).rows as {
    terminal_facts_state: string | null;
    terminal_facts_reason_code: string | null;
    stream_facts_event_seq: string | null;
  }[];
  return {
    checkpoint:
      row?.stream_facts_event_seq === null || row?.stream_facts_event_seq === undefined
        ? null
        : Number(row.stream_facts_event_seq),
    reasonCode: row?.terminal_facts_reason_code ?? null,
    state: row?.terminal_facts_state ?? null,
  };
}

if (POSTGRES_URL) {
  test("REPRODUCTION: a page-scoped bounded pass stamps a zero-history manual-import row historical, not current, when co-scoped with a real connection", async () => {
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName: `pdpp_page_scope_zero_history_${process.pid}`,
      },
      async (url) => {
        await initPostgresStorage({ backend: "postgres", databaseUrl: url });
        await seedConnectorAndInstance(POLLUTER_CONNECTOR_ID, POLLUTER_INSTANCE_ID, "Page-scope polluter");
        await seedPolluterTerminalEvent();
        await seedConnectorAndInstance(
          VICTIM_CONNECTOR_ID,
          VICTIM_INSTANCE_ID,
          "Page-scope victim (finished manual import, zero run.* events)",
          "manual"
        );

        // Mirror the real bounded sweep's call shape exactly:
        // `observeConnectorSummaryEvidence(pageIds, { deadline })` with BOTH
        // connections in the same page — this is what happens whenever a
        // zero-history row's page-sized batch (default 25) includes any
        // other connection with real terminal history, which is the common
        // case in a fleet of any size. `reconcileDirtyConnectorSummaryEvidence`
        // with a `maxDurationMs` option drives the same bounded/deadline path
        // (`observeConnectorSummaryEvidence`'s `overallDeadline !== null`
        // branch) that the periodic page walk uses.
        await reconcileDirtyConnectorSummaryEvidence([VICTIM_INSTANCE_ID, POLLUTER_INSTANCE_ID], {
          maxDurationMs: 5000,
        });

        const victim = await readTerminalFacts(VICTIM_INSTANCE_ID);
        assert.equal(
          victim.state,
          "current",
          `a genuinely never-folded zero-terminal-event row must converge to current, not '${victim.state}'/'${victim.reasonCode}', merely because it shares a bounded page with an unrelated connection that has real terminal history`
        );
        assert.equal(victim.reasonCode, null);
      }
    );
  });

  test("REPRODUCTION: once a zero-history row is externally stamped historical at a non-zero checkpoint, it can never self-heal back to current", async () => {
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName: `pdpp_page_scope_stuck_historical_${process.pid}`,
      },
      async (url) => {
        await initPostgresStorage({ backend: "postgres", databaseUrl: url });
        await seedConnectorAndInstance(POLLUTER_CONNECTOR_ID, POLLUTER_INSTANCE_ID, "Page-scope polluter");
        await seedPolluterTerminalEvent();
        await seedConnectorAndInstance(
          VICTIM_CONNECTOR_ID,
          VICTIM_INSTANCE_ID,
          "Page-scope victim (finished manual import, zero run.* events)",
          "manual"
        );

        // First pass to create the victim's evidence row at all.
        await reconcileDirtyConnectorSummaryEvidence([VICTIM_INSTANCE_ID, POLLUTER_INSTANCE_ID], {
          maxDurationMs: 5000,
        });
        const afterFirstPass = await readTerminalFacts(VICTIM_INSTANCE_ID);
        assert.equal(afterFirstPass.state, "current", "sanity: the first pass converges the victim to current");

        // Simulate whatever produced the production defect: some earlier
        // pass (a pre-fairness-fix code version, or a race) left the row
        // durably `terminal_facts_historical` at a NON-ZERO checkpoint —
        // exactly the shape of the two real production rows
        // (cin_50f5bf4b7ecbc7acd6f4c254 / cin_a6aa0550ed70c8ce6bd73170: both
        // `terminal_facts_state='stale'`,
        // `terminal_facts_reason_code='terminal_facts_historical'`,
        // `stream_facts_event_seq` in the millions, `dirty=0`).
        await postgresQuery(
          `UPDATE connector_summary_evidence
              SET terminal_facts_state = 'stale',
                  terminal_facts_reason_code = 'terminal_facts_historical'
            WHERE connector_instance_id = $1`,
          [VICTIM_INSTANCE_ID]
        );

        // Advance the fleet-wide high-water so the row is NOT excluded by
        // the checkpoint-lag predicate (`rowNeedsFoldParticipation`) — it
        // must genuinely re-participate in the next pass, exactly like the
        // production rows (whose checkpoint keeps advancing pass over pass
        // while staying `terminal_facts_historical`).
        await postgresQuery(
          `INSERT INTO spine_events(
               event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
               actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
             ) VALUES($1, $2, 'run.completed', $3, $3, 'test', 'trace_polluter2', 'runtime', 'test-connector', 'run', 'run_polluter2', 'succeeded', 'run_polluter2', $4, $5::jsonb, '1')`,
          [
            "evt_page_scope_polluter_2",
            POLLUTER_EVENT_SEQ + 1,
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

        await reconcileDirtyConnectorSummaryEvidence([VICTIM_INSTANCE_ID, POLLUTER_INSTANCE_ID], {
          maxDurationMs: 5000,
        });

        const victim = await readTerminalFacts(VICTIM_INSTANCE_ID);
        assert.equal(
          victim.state,
          "current",
          `a zero-history row must self-heal back to current on the very next pass once re-admitted, not stay stuck at '${victim.state}'/'${victim.reasonCode}' — this is the mechanism behind the two stuck production rows`
        );
        assert.equal(victim.reasonCode, null);
      }
    );
  });
}
