/**
 * Regression tests for the sandbox `DashboardDataSource`.
 *
 * The seam exists so the same dashboard feature views render against
 * both live AS/RS and the deterministic mock dataset. These tests
 * exercise the sandbox binding and verify the shapes match what the
 * shared views expect.
 *
 * The live `DashboardDataSource` is not exercised here — it requires a
 * running reference server and owner session — but the type-level
 * binding in `apps/web/src/app/dashboard/lib/data-source.ts` proves the
 * surfaces are interchangeable.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { sandboxDashboardDataSource as ds } from "./data-source.ts";

const NOT_FOUND_RE = /\(404\)/;

test("sandbox source identifies as sandbox kind", () => {
  assert.equal(ds.kind, "sandbox");
});

test("listConnectorSummaries returns demo connectors with run + stream metadata", async () => {
  const resp = await ds.listConnectorSummaries();
  assert.equal(resp.object, "list");
  assert.ok(resp.data.length >= 3);
  for (const c of resp.data) {
    assert.equal(typeof c.connector_id, "string");
    assert.equal(typeof c.display_name, "string");
    assert.ok(Array.isArray(c.streams));
    assert.equal(typeof c.total_records, "number");
  }
});

test("listConnectorManifests returns dashboard-shaped manifests", async () => {
  const manifests = await ds.listConnectorManifests();
  assert.ok(manifests.length >= 3);
  for (const m of manifests) {
    assert.equal(typeof m.connector_id, "string");
    assert.ok(Array.isArray(m.streams));
    for (const s of m.streams ?? []) {
      assert.equal(typeof s.name, "string");
    }
  }
});

test("getConnectorOverview returns ConnectorOverview with last+last-successful run", async () => {
  const manifests = await ds.listConnectorManifests();
  const acme = manifests.find((m) => m.connector_id === "acme_payroll_demo");
  if (!acme) {
    throw new Error("acme_payroll_demo manifest missing");
  }
  const overview = await ds.getConnectorOverview(acme);
  assert.equal(overview.connector.connector_id, "acme_payroll_demo");
  assert.ok(overview.streams.length >= 1);
  assert.equal(typeof overview.totalRecords, "number");
  assert.ok(overview.lastRun);
  assert.equal(typeof overview.lastRun?.run_id, "string");
});

test("queryRecords returns dashboard StreamRecord envelope shape", async () => {
  const page = await ds.queryRecords("acme_payroll_demo", "pay_statements", { limit: 2 });
  assert.equal(page.object, "list");
  assert.ok(page.data.length >= 1);
  const first = page.data[0];
  if (!first) {
    throw new Error("expected first record");
  }
  assert.equal(first.object, "record");
  assert.equal(typeof first.id, "string");
  assert.equal(typeof first.stream, "string");
  assert.equal(typeof first.emitted_at, "string");
  assert.equal(typeof first.data, "object");
});

test("getRecord returns the canonical envelope; throws 404-shaped error for unknowns", async () => {
  const rec = await ds.getRecord("acme_payroll_demo", "pay_statements", "rec_sb_paystmt_2026_03");
  assert.equal(rec.id, "rec_sb_paystmt_2026_03");
  assert.equal(rec.stream, "pay_statements");
  await assert.rejects(() => ds.getRecord("acme_payroll_demo", "pay_statements", "does_not_exist"), NOT_FOUND_RE);
});

test("listGrants/listRuns/listTraces filter by status and return live shapes", async () => {
  const issued = await ds.listGrants({ status: "issued" });
  assert.ok(issued.data.every((g) => g.status === "issued"));
  for (const g of issued.data) {
    assert.equal(g.object, "grant_summary");
    assert.equal(typeof g.first_at, "string");
    assert.equal(typeof g.last_at, "string");
  }
  const failedRuns = await ds.listRuns({ status: "failed" });
  assert.ok(failedRuns.data.every((r) => r.status === "failed"));
  for (const r of failedRuns.data) {
    assert.equal(r.object, "run_summary");
  }
  const allTraces = await ds.listTraces({});
  for (const t of allTraces.data) {
    assert.equal(t.object, "trace_summary");
    assert.ok(Array.isArray(t.kinds));
  }
});

test("timeline envelopes use spine event shape with live field set", async () => {
  const env = await ds.getGrantTimeline("grant_sb_quill_paystmt");
  if (!env) {
    throw new Error("expected envelope");
  }
  assert.ok(env.events.length > 0);
  const first = env.events[0];
  if (!first) {
    throw new Error("expected first event");
  }
  // The shared TimelineView expects all of these keys to exist (they
  // can be null) — this guards against partial spine event shapes.
  for (const key of [
    "actor_id",
    "actor_type",
    "client_id",
    "data",
    "event_id",
    "event_type",
    "grant_id",
    "interaction_id",
    "object_id",
    "object_type",
    "occurred_at",
    "provider_id",
    "recorded_at",
    "request_id",
    "run_id",
    "scenario_id",
    "status",
    "stream_id",
    "subject_id",
    "subject_type",
    "token_id",
    "trace_id",
    "version",
  ]) {
    assert.ok(key in first, `missing spine event key: ${key}`);
  }
});

test("getDatasetSummary maps to the live DatasetSummary shape used by OverviewHero", async () => {
  const s = await ds.getDatasetSummary();
  assert.equal(s.object, "dataset_summary");
  assert.equal(typeof s.connector_count, "number");
  assert.equal(typeof s.stream_count, "number");
  assert.equal(typeof s.record_count, "number");
  assert.ok("earliest_ingested_at" in s);
  assert.ok("latest_ingested_at" in s);
  assert.ok(Array.isArray(s.top_connectors));
});

test("listPendingApprovals is always empty (sandbox has no live owner)", async () => {
  const resp = await ds.listPendingApprovals();
  assert.equal(resp.data.length, 0);
});

test("isSemanticRetrievalAdvertised is false (sandbox is lexical-only)", async () => {
  assert.equal(await ds.isSemanticRetrievalAdvertised(), false);
});

test("getDeploymentDiagnostics returns the live shape with sandbox-flavored values", async () => {
  const r = await ds.getDeploymentDiagnostics();
  assert.ok(r.database.path.includes("sandbox"));
  assert.ok(Array.isArray(r.environment));
  assert.ok(Array.isArray(r.warnings));
  assert.equal(r.lexical.index.state, "built");
  assert.equal(r.semantic.backend.configured, false);
});

test("refSearch is exact-id sensitive and returns live artifact shapes", async () => {
  const exact = await ds.refSearch("grant_sb_quill_paystmt");
  assert.ok(exact.exact);
  assert.equal(exact.exact?.kind, "grant");
  const noisy = await ds.refSearch("payroll");
  // Lexical match across grant ids / connector ids
  assert.equal(typeof noisy.grants.length, "number");
  assert.equal(typeof noisy.runs.length, "number");
  assert.equal(typeof noisy.traces.length, "number");
});

test("searchRecordsLexical paginates and returns SearchResultPage shape", async () => {
  const page = await ds.searchRecordsLexical("payroll", { limit: 25 });
  assert.equal(page.object, "list");
  for (const hit of page.data) {
    assert.equal(hit.object, "search_result");
    assert.equal(typeof hit.connector_id, "string");
    assert.equal(typeof hit.stream, "string");
    assert.equal(typeof hit.record_key, "string");
    assert.equal(typeof hit.emitted_at, "string");
  }
});
