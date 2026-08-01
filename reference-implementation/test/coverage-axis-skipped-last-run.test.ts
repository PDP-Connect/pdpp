// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Live fleet symptom (uat-fleet-evidence-closure-0801): connections whose
 * most recent `run_history` row is `status = 'skipped'` (pre-run gate
 * declined to dispatch — browser-surface unavailable, pending owner reauth,
 * etc.) read `coverage.axis: "unknown"` instead of `"partial"`. Confirmed
 * live against Postgres for 4 named connections (ChatGPT-everyone,
 * ChatGPT-dondochaka, H-E-B, Reddit-dondochaka): each connection's true
 * latest `run_history` row (by `completed_at`) has `status = 'skipped'`,
 * `error` populated with a real gate reason (`browser_surface_unavailable:
 * surface_start_failed`, `attention_unresolved: session_required`), and
 * substantial prior record history — i.e. these connections have run
 * successfully before and are not "unknown" in any honest sense.
 *
 * Root cause: `mapCoverageAxis` (ref-control.ts) special-cases
 * `lastRun.status` for `"failed" | "cancelled" | "abandoned"` -> `"partial"`
 * but had no branch for `"skipped"`, a distinct terminal non-success status
 * emitted by the scheduler's pre-run gate cascade
 * (`runtime/scheduler/pre-run-gate.ts`, `RunStatus` in
 * `scheduler-domain-types.ts`). A `skipped` last run fell through every
 * branch to the final `return "unknown"` — indistinguishable from a
 * connection with zero run history at all, even though a skip is real
 * evidence the connection exists, was evaluated, and was deliberately not
 * run this cycle. `controller.ts`'s `applyHistoryRowToScheduleFacts` already
 * groups `"skipped"` with `"failed"` for schedule-facts purposes
 * (`row.status === "failed" || row.status === "skipped"`), so this fix
 * brings `mapCoverageAxis` into line with that existing precedent rather
 * than inventing new semantics.
 *
 * This test proves: a connection whose only `run_history` row is
 * `status = 'skipped'` now surfaces `coverage.axis: "partial"`, not
 * `"unknown"`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  type ConnectorSummary,
  invalidateConnectorSummariesCache,
  listConnectorSummaries,
} from "../server/ref-control.ts";

const OWNER = "owner_local";
const NOW = "2026-08-01T12:00:00.000Z";
const CONNECTOR_ID = "https://test.pdpp.dev/connectors/coverage-axis-skipped-last-run";
const INSTANCE_ID = "cin_coverage_axis_skipped_last_run";
const STREAM = "messages";
const RUN_ID = "run_coverage_axis_skipped_last_run";

const MANIFEST = {
  capabilities: {
    public_listing: { listed: true, status: "test" },
  },
  connector_id: CONNECTOR_ID,
  display_name: "Coverage Axis Skipped Last Run Probe",
  protocol_version: "0.1.0",
  streams: [
    {
      coverage_strategy: "checkpoint_window",
      freshness_strategy: "manual_as_of",
      name: STREAM,
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
    },
  ],
  version: "1.0.0",
};

async function withTempDb<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-coverage-axis-skipped-last-run-"));
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
       ) VALUES (?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`
    )
    .run(INSTANCE_ID, OWNER, CONNECTOR_ID, "Coverage Axis Skipped Last Run Probe", INSTANCE_ID, NOW, NOW);
}

// Mirrors the live shape: a pre-run gate skip carries no records, no
// known_gaps, and a real `error` reason string — matching what the fleet
// audit observed for `browser_surface_unavailable: surface_start_failed`
// and `attention_unresolved: session_required` skips.
function seedSkippedRunHistory() {
  getDb()
    .prepare(
      `INSERT INTO run_history(
         connector_instance_id, connector_id, source_json, status, records_emitted,
         known_gaps_json, run_id, started_at, completed_at, attempt, error
       )
       VALUES (?, ?, '{}', 'skipped', 0, '[]', ?, ?, ?, 0, 'browser_surface_unavailable: surface_start_failed')`
    )
    .run(INSTANCE_ID, CONNECTOR_ID, RUN_ID, NOW, NOW);
}

// biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
async function listBypassCache() {
  return listConnectorSummaries(null, { concurrency: 1, includeRunSummaries: true });
}

function summaryFor(summaries: readonly ConnectorSummary[]): ConnectorSummary {
  const summary = summaries.find((row) => row.connector_instance_id === INSTANCE_ID);
  assert.ok(summary, "summary for the probe connection must be visible");
  return summary;
}

test("a connection whose only run_history row is status='skipped' surfaces coverage.axis 'partial', not 'unknown'", () =>
  withTempDb(async () => {
    seedConnector();
    seedInstance();
    seedSkippedRunHistory();

    const summary = summaryFor(await listBypassCache());

    assert.ok(summary.last_run, "fixture premise: a run_history row exists");
    assert.equal(summary.last_run?.status, "skipped", "fixture premise: the last run's status is 'skipped'");
    assert.equal(
      summary.connection_health.axes.coverage,
      "partial",
      "a skipped last run is real evidence the connection was evaluated and declined this cycle — it must not read identically to zero run history ('unknown')"
    );
  }));
