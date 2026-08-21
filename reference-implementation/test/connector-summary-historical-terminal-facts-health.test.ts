// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `terminal_facts_historical` is the generation fence's signal that a real
 * terminal event exists but is stamped with a legacy/non-current manifest
 * generation (see `foldTerminalEventFacts` in connector-summary-read-model.ts)
 * — design.md "Health boundary": "Every attributable terminal spine event is
 * stamped with that connection's current generation... Legacy or unattributed
 * terminal events are historical, never current proof." It is NOT the
 * terminal state of "a source with zero run.* events ever" — a genuinely
 * never-folded row (e.g. a fresh manual import with no run history at all)
 * converges to `terminal_facts_state: "current"` on its first fold pass via
 * `stampZeroCheckpointForBootstrap` / the round-robin drain's short-batch
 * convergence, and never reaches `terminal_facts_historical` at all.
 *
 * This test locks in that `terminal_facts_historical` keeps forcing
 * `ProjectionReliable: false` / headline `unknown`, per the design's
 * highest-precedence, non-overwritable "Health boundary" rule — it must not
 * be carved out of `evidenceUnreliableSources` (ref-control.ts), because
 * doing so would let a legacy/stale fact stand in as current proof for
 * whatever component's generation-mismatched event orphaned it.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ConnectionHealthCondition } from "../runtime/connection-health.ts";
import { reconcileConnectorSummaryEvidence } from "../server/connector-summary-evidence-engine.ts";
import { foldConnectorSummaryStreamFacts } from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { ingestRecord } from "../server/records.ts";
import {
  type ConnectorSummary,
  invalidateConnectorSummariesCache,
  listConnectorSummaries,
} from "../server/ref-control.ts";

const OWNER = "owner_local";
const NOW = "2026-07-17T00:00:00.000Z";
const CONNECTOR_ID = "https://test.pdpp.dev/connectors/historical-terminal-facts-health";
const INSTANCE_ID = "cin_historical_terminal_facts_health";
const STREAM = "locations";

const MANIFEST = {
  capabilities: {
    public_listing: { tier: "supported" },
  },
  connector_id: CONNECTOR_ID,
  display_name: "Historical Terminal Facts Health Probe",
  protocol_version: "0.1.0",
  streams: [
    {
      coverage_strategy: "full_inventory",
      name: STREAM,
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
    },
  ],
  version: "1.0.0",
};

async function withTempDb<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-historical-terminal-facts-health-"));
  invalidateConnectorSummariesCache();
  initDb(join(dir, "pdpp.sqlite"));
  try {
    return await fn();
  } finally {
    invalidateConnectorSummariesCache();
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
}

function seedConnector() {
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(CONNECTOR_ID, JSON.stringify(MANIFEST), NOW);
}

function seedInstance() {
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES (?, ?, ?, ?, 'active', 'manual', ?, '{}', ?, ?, NULL)`
    )
    .run(INSTANCE_ID, OWNER, CONNECTOR_ID, "Historical Terminal Facts Health Probe", INSTANCE_ID, NOW, NOW);
}

function storageTarget() {
  return { connector_id: CONNECTOR_ID, connector_instance_id: INSTANCE_ID };
}

// biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
async function listBypassCache() {
  return listConnectorSummaries(null, { concurrency: 1, includeRunSummaries: false });
}

function summaryFor(summaries: readonly ConnectorSummary[]): ConnectorSummary {
  const summary = summaries.find((row) => row.connector_instance_id === INSTANCE_ID);
  assert.ok(summary, "summary for the probe connection must be visible");
  return summary;
}

function projectionReliable(summary: ConnectorSummary): ConnectionHealthCondition | undefined {
  return summary.connection_health.conditions.find((condition) => condition.type === "ProjectionReliable");
}

test("a fresh manual-import source with zero run.* events converges terminal_facts to current, not historical", () =>
  withTempDb(async () => {
    seedConnector();
    seedInstance();

    // Records arrive via a direct manual import — no run_history row, no
    // run.* spine event, ever, for this connection.
    await ingestRecord(storageTarget(), {
      data: { id: "loc_1" },
      emitted_at: NOW,
      key: "loc_1",
      stream: STREAM,
    });
    const first = await reconcileConnectorSummaryEvidence(null);
    assert.equal(first.failed, 0);
    await foldConnectorSummaryStreamFacts([INSTANCE_ID]);

    const row = getDb()
      .prepare(
        "SELECT terminal_facts_state, terminal_facts_reason_code FROM connector_summary_evidence WHERE connector_instance_id = ?"
      )
      .get(INSTANCE_ID) as { terminal_facts_state: string; terminal_facts_reason_code: string | null };
    assert.equal(
      row.terminal_facts_state,
      "current",
      "a source with zero attributable terminal events ever must converge to current, not historical"
    );
    assert.equal(row.terminal_facts_reason_code, null);
  }));

test("terminal_facts_historical (a legacy generation-mismatched fact) still forces ProjectionReliable false and the connection unknown", () =>
  withTempDb(async () => {
    seedConnector();
    seedInstance();

    await ingestRecord(storageTarget(), {
      data: { id: "loc_1" },
      emitted_at: NOW,
      key: "loc_1",
      stream: STREAM,
    });
    const first = await reconcileConnectorSummaryEvidence(null);
    assert.equal(first.failed, 0);

    // Model the fold's real verdict for a row whose only attributable
    // terminal event was stamped with a manifest generation that has since
    // advanced (a manifest re-registration bumps every instance's
    // generation — see auth.ts persistManifestAndAdvanceGenerations): the
    // event is refused as historical, never current proof, per design.md
    // "Health boundary".
    getDb()
      .prepare(
        `UPDATE connector_summary_evidence
            SET terminal_facts_state = 'stale',
                terminal_facts_reason_code = 'terminal_facts_historical',
                stream_facts_event_seq = 0,
                stream_latest_facts_json = NULL
          WHERE connector_instance_id = ?`
      )
      .run(INSTANCE_ID);

    const summary = summaryFor(await listBypassCache());

    const projection = projectionReliable(summary);
    assert.equal(
      projection?.status,
      "false",
      "a legacy/generation-mismatched terminal fact must keep ProjectionReliable false — it is not current proof of anything"
    );
    assert.equal(
      summary.connection_health.state,
      "unknown",
      "terminal_facts_historical has highest precedence and forces unknown, per design.md Health boundary"
    );
  }));
