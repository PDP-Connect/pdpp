// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `total_records`/`total_records_state` propagation for a failed record
 * snapshot (Sol third-verdict P1.3 / minimum-closure item 4): "Propagate
 * failed/stale total-count semantics through ConnectorSummary.total_records,
 * canonical detail/generated contract, and console header/view model. Route
 * JSON + rendered tests for prior-zero and prior-nonzero; never render
 * failed snapshot as authoritative numeric zero."
 *
 * Proves the fix through the real production entry points
 * (`listConnectorSummaries`, `getConnectorDetail`) for BOTH starting
 * conditions Sol's verdict specifically distinguished:
 *   - prior-NONZERO: a real current count (1), then a repair failure that
 *     leaves the durable row's total_records untouched at 1 — the number
 *     must still be present (a real prior value is a useful hint) but its
 *     state must read "stale", never "known".
 *   - prior-ZERO: a real current zero count, then the same repair failure —
 *     the exact failure mode Sol reproduced: the number stays 0, but 0 must
 *     NOT read "known_zero" (an authoritative exact-zero claim) once the
 *     component backing it is no longer current.
 *
 * Per-stream `stream_records[].count_state` was already fixed in a prior
 * REVISE cycle (Sol's second-verdict P2.3); this file targets the
 * TOP-LEVEL `total_records`/`total_records_state` gap the third verdict
 * found still unfixed, plus the canonical `getConnectorDetail` mirror.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reconcileConnectorSummaryEvidence } from "../server/connector-summary-evidence-engine.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { deleteRecord, ingestRecord } from "../server/records.ts";
import {
  getConnectorDetail,
  invalidateConnectorSummariesCache,
  listConnectorSummaries,
} from "../server/ref-control.ts";

const NOW = "2026-07-17T00:00:00.000Z";
interface JsonRecord {
  [key: string]: any;
}

function manifestFor(connectorId: string): JsonRecord {
  return {
    capabilities: { public_listing: { tier: "supported" } },
    connector_id: connectorId,
    display_name: "Total Records State Probe",
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

async function withTempDb(fn: () => Promise<any>): Promise<any> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-total-records-state-"));
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

function seedConnector(connectorId: string, manifest: JsonRecord): void {
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(connectorId, JSON.stringify(manifest), NOW);
}

function seedInstance(instanceId: string, connectorId: string): void {
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES (?, 'owner_local', ?, 'Total Records State Probe', 'active', 'account', ?, '{}', ?, ?, NULL)`
    )
    .run(instanceId, connectorId, instanceId, NOW, NOW);
}

function storageTarget(connectorId: string, instanceId: string): JsonRecord {
  return { connector_id: connectorId, connector_instance_id: instanceId };
}

/**
 * Establish a PROVEN exact zero for the probe stream: an absent canonical
 * row on its own proves nothing (it is `unobserved` — see
 * `connector-summary-count-state-proof.test.ts`), so the stream is
 * canonically observed via the real ingest path and then emptied. That is
 * what makes the zero snapshots below genuinely `known_zero` rather than
 * merely uncollected.
 */
async function seedProvenZeroStream(connectorId: string, instanceId: string): Promise<void> {
  await ingestRecord(storageTarget(connectorId, instanceId), {
    data: { id: "msg_seed" },
    emitted_at: NOW,
    key: "msg_seed",
    stream: "messages",
  });
  await deleteRecord(storageTarget(connectorId, instanceId), "messages", "msg_seed");
}

async function listBypassCache() {
  invalidateConnectorSummariesCache();
  const summaries = await listConnectorSummaries(null, { concurrency: 1, includeRunSummaries: false });
  invalidateConnectorSummariesCache();
  return summaries;
}

function summaryFor(summaries: JsonRecord[], instanceId: string): JsonRecord {
  const summary = summaries.find((row: JsonRecord) => row.connector_instance_id === instanceId);
  assert.ok(summary, "summary for the probe connection must be visible");
  return summary;
}

// ─── prior-NONZERO: fails while carrying a real, previously-current count ──

test("list surface: total_records_state reads 'known' for a genuinely current nonzero snapshot", () =>
  withTempDb(async () => {
    const connectorId = "https://test.pdpp.dev/connectors/total-records-state-nonzero";
    const instanceId = "cin_trs_nonzero";
    seedConnector(connectorId, manifestFor(connectorId));
    seedInstance(instanceId, connectorId);
    await ingestRecord(storageTarget(connectorId, instanceId), {
      data: { id: "msg_1" },
      emitted_at: NOW,
      key: "msg_1",
      stream: "messages",
    });
    await reconcileConnectorSummaryEvidence(null);

    const summary = summaryFor(await listBypassCache(), instanceId);
    assert.equal(summary.total_records, 1);
    assert.equal(summary.total_records_state, "known", "a genuinely current nonzero count reads known, never stale");
  }));

test("list + detail surfaces: a repair failure downgrades total_records_state to 'stale' while PRESERVING the real prior nonzero number", () =>
  withTempDb(async () => {
    const connectorId = "https://test.pdpp.dev/connectors/total-records-state-nonzero-fail";
    const instanceId = "cin_trs_nonzero_fail";
    seedConnector(connectorId, manifestFor(connectorId));
    seedInstance(instanceId, connectorId);
    await ingestRecord(storageTarget(connectorId, instanceId), {
      data: { id: "msg_1" },
      emitted_at: NOW,
      key: "msg_1",
      stream: "messages",
    });
    await reconcileConnectorSummaryEvidence(null);
    const before = summaryFor(await listBypassCache(), instanceId);
    assert.equal(before.total_records, 1);
    assert.equal(before.total_records_state, "known");

    // A second real record lands so a repair candidate exists (checkpoint
    // mismatch), then force the repair's own durable write to fail — the
    // exact production-path fault Sol's verdict probes with. The durable
    // row keeps its LAST correctly-computed total_records (1) untouched;
    // only the state must degrade.
    await ingestRecord(storageTarget(connectorId, instanceId), {
      data: { id: "msg_2" },
      emitted_at: NOW,
      key: "msg_2",
      stream: "messages",
    });
    getDb().exec(
      `CREATE TRIGGER fault_trs_nonzero_repair
         BEFORE UPDATE OF total_records ON connector_summary_evidence
       BEGIN
         SELECT RAISE(ABORT, 'injected repair write fault');
       END`
    );
    // biome-ignore lint/suspicious/noEvolvingTypes: test fixture inference is intentionally widened
    // biome-ignore lint/suspicious/noImplicitAnyLet: value is assigned after backend initialization
    let listSummary;
    // biome-ignore lint/suspicious/noEvolvingTypes: test fixture inference is intentionally widened
    // biome-ignore lint/suspicious/noImplicitAnyLet: value is assigned after backend initialization
    let detail;
    try {
      const result = await reconcileConnectorSummaryEvidence(null);
      assert.equal(result.failed, 1);
      listSummary = summaryFor(await listBypassCache(), instanceId);
      detail = await getConnectorDetail(connectorId);
    } finally {
      getDb().exec("DROP TRIGGER fault_trs_nonzero_repair");
    }

    assert.equal(
      listSummary.total_records,
      1,
      "the real prior nonzero count is PRESERVED as a hint, not zeroed/nulled"
    );
    assert.equal(
      listSummary.total_records_state,
      "stale",
      "a repair-failed snapshot must read stale, never known, even though the carried-over number is nonzero"
    );

    assert.equal(detail.connection_resolution, "resolved");
    assert.equal(detail.total_records, 1, "the canonical detail mirror preserves the same real prior number");
    assert.equal(detail.total_records_state, "stale", "the canonical detail mirror carries the same stale state");
  }));

// ─── prior-ZERO: the exact failure mode Sol's verdict reproduced ──────────

test("list surface: total_records_state reads 'known_zero' for a genuinely current zero snapshot", () =>
  withTempDb(async () => {
    const connectorId = "https://test.pdpp.dev/connectors/total-records-state-zero";
    const instanceId = "cin_trs_zero";
    seedConnector(connectorId, manifestFor(connectorId));
    seedInstance(instanceId, connectorId);
    await seedProvenZeroStream(connectorId, instanceId);
    await reconcileConnectorSummaryEvidence(null);

    const summary = summaryFor(await listBypassCache(), instanceId);
    assert.equal(summary.total_records, 0);
    assert.equal(
      summary.total_records_state,
      "known_zero",
      "a genuinely current, proven-exact zero count reads known_zero, distinct from a merely-untrustworthy zero"
    );
  }));

test("list + detail surfaces: a repair failure on a prior-ZERO snapshot downgrades to 'stale', never renders as authoritative known_zero (the exact Sol reproduction)", () =>
  withTempDb(async () => {
    const connectorId = "https://test.pdpp.dev/connectors/total-records-state-zero-fail";
    const instanceId = "cin_trs_zero_fail";
    seedConnector(connectorId, manifestFor(connectorId));
    seedInstance(instanceId, connectorId);
    await seedProvenZeroStream(connectorId, instanceId);
    await reconcileConnectorSummaryEvidence(null);
    const before = summaryFor(await listBypassCache(), instanceId);
    assert.equal(before.total_records, 0);
    assert.equal(before.total_records_state, "known_zero");

    // A real record lands without a dirty hint reaching the repair engine's
    // own record_snapshot component write path in time — force the repair
    // INSERT/UPDATE to fail while the row still reads its prior current
    // zero. This is Sol's exact production-path probe: "start with a
    // current zero snapshot, add a canonical record without a dirty hint,
    // force repair failure while allowing the failure-state UPDATE to
    // land."
    await ingestRecord(storageTarget(connectorId, instanceId), {
      data: { id: "msg_1" },
      emitted_at: NOW,
      key: "msg_1",
      stream: "messages",
    });
    getDb().exec(
      `CREATE TRIGGER fault_trs_zero_repair
         BEFORE UPDATE OF total_records ON connector_summary_evidence
       BEGIN
         SELECT RAISE(ABORT, 'injected repair write fault');
       END`
    );
    // biome-ignore lint/suspicious/noEvolvingTypes: test fixture inference is intentionally widened
    // biome-ignore lint/suspicious/noImplicitAnyLet: value is assigned after backend initialization
    let listSummary;
    // biome-ignore lint/suspicious/noImplicitAnyLet: value is assigned after backend initialization
    // biome-ignore lint/suspicious/noEvolvingTypes: test fixture inference is intentionally widened
    let detail;
    try {
      const result = await reconcileConnectorSummaryEvidence(null);
      assert.equal(result.failed, 1);
      listSummary = summaryFor(await listBypassCache(), instanceId);
      detail = await getConnectorDetail(connectorId);
    } finally {
      getDb().exec("DROP TRIGGER fault_trs_zero_repair");
    }

    assert.equal(listSummary.total_records, 0, "the durable row's number is genuinely untouched by the rejected write");
    assert.notEqual(
      listSummary.total_records_state,
      "known_zero",
      "the failed snapshot's carried-over zero must NEVER read as an authoritative known_zero — the exact fail-open Sol reproduced"
    );
    assert.equal(listSummary.total_records_state, "stale");

    assert.equal(detail.total_records, 0);
    assert.notEqual(
      detail.total_records_state,
      "known_zero",
      "canonical detail must not render the failed snapshot's zero as authoritative either"
    );
    assert.equal(detail.total_records_state, "stale");
  }));

// ─── unresolved/ambiguous detail: total_records_state stays 'unobserved' ──

test("getConnectorDetail: an unresolved connector (zero connections) reports total_records_state 'unobserved', matching total_records null", () =>
  withTempDb(async () => {
    const connectorId = "https://test.pdpp.dev/connectors/total-records-state-unresolved";
    seedConnector(connectorId, manifestFor(connectorId));

    const detail = await getConnectorDetail(connectorId);
    assert.equal(detail.connection_resolution, "unresolved");
    assert.equal(detail.total_records, null);
    assert.equal(detail.total_records_state, "unobserved");
  }));
