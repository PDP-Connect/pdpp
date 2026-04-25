import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAuthServerMetadata,
  buildDatasetSummary,
  buildGrantsList,
  buildGrantTimeline,
  buildProtectedResourceMetadata,
  buildRecordDetail,
  buildRecordsList,
  buildRunsList,
  buildRunTimeline,
  buildSchemaResponse,
  buildSearchResponse,
  buildStreamDetail,
  buildStreamsList,
  buildTracesList,
  buildTraceTimeline,
  paginate,
} from "./builders.ts";

test("paginate returns deterministic envelopes with cursor and total", () => {
  const rows = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const page1 = paginate(rows, { limit: 3 });
  assert.equal(page1.object, "list");
  assert.equal(page1.is_demo, true);
  assert.deepEqual(page1.data, [1, 2, 3]);
  assert.equal(page1.has_more, true);
  assert.equal(page1.next_cursor, "3");
  assert.equal(page1.total, 10);
  const page2 = paginate(rows, { limit: 3, cursor: page1.next_cursor });
  assert.deepEqual(page2.data, [4, 5, 6]);
  const last = paginate(rows, { limit: 100 });
  assert.equal(last.has_more, false);
  assert.equal(last.next_cursor, null);
});

test("schema response lists every connector and stream", () => {
  const schema = buildSchemaResponse();
  assert.equal(schema.object, "schema_graph");
  assert.equal(schema.is_demo, true);
  assert.ok(schema.connectors.length >= 3);
  for (const connector of schema.connectors) {
    assert.ok(connector.streams.length >= 1, `connector ${connector.connector_id} has no streams`);
  }
});

test("streams list and detail return matching shapes", () => {
  const list = buildStreamsList({});
  assert.ok(list.data.length >= 1);
  for (const summary of list.data) {
    assert.ok(typeof summary.record_count === "number");
    const detail = buildStreamDetail(summary.stream);
    assert.ok(detail);
    assert.equal(detail?.stream, summary.stream);
  }
  assert.equal(buildStreamDetail("does_not_exist"), null);
});

test("records list returns null for missing stream and pages correctly", () => {
  assert.equal(buildRecordsList({ stream: "does_not_exist" }), null);
  const page = buildRecordsList({ stream: "pay_statements", limit: 1 });
  assert.ok(page);
  assert.equal(page?.data.length, 1);
  assert.ok(page?.has_more);
});

test("record detail returns null for unknown ids and full fields for known ones", () => {
  assert.equal(buildRecordDetail("pay_statements", "rec_does_not_exist"), null);
  const detail = buildRecordDetail("pay_statements", "rec_sb_paystmt_2026_03");
  assert.ok(detail);
  assert.equal(detail?.fields.currency, "USD");
});

test("search returns deterministic hits with snippets and matched_fields", () => {
  const empty = buildSearchResponse("");
  assert.equal(empty.object, "list");
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.data, []);
  const payroll = buildSearchResponse("payroll");
  assert.ok(payroll.total > 0);
  assert.equal(payroll.data.length, payroll.total);
  assert.equal(payroll.has_more, false);
  for (const hit of payroll.data) {
    assert.equal(hit.object, "search_result");
    assert.ok(hit.record_url.startsWith("/sandbox/v1/streams/"));
    assert.ok(hit.matched_fields.length > 0);
    assert.ok(hit.snippet.text.length > 0);
  }
  // Repeat call yields identical structure.
  const payroll2 = buildSearchResponse("payroll");
  assert.deepEqual(
    payroll2.data.map((h) => h.record_key),
    payroll.data.map((h) => h.record_key)
  );
});

test("search with no matches returns an empty hit list", () => {
  const result = buildSearchResponse("ZZZ_definitely_no_match_ZZZ");
  assert.equal(result.total, 0);
  assert.deepEqual(result.data, []);
});

test("grants list filters by status", () => {
  const all = buildGrantsList({});
  const issued = buildGrantsList({ status: "issued" });
  const revoked = buildGrantsList({ status: "revoked" });
  assert.ok(issued.data.every((g) => g.status === "issued"));
  assert.ok(revoked.data.every((g) => g.status === "revoked"));
  assert.equal(all.total, all.data.length);
});

test("grant timeline returns null for unknown ids and events for known ones", () => {
  assert.equal(buildGrantTimeline("grant_does_not_exist"), null);
  const t = buildGrantTimeline("grant_sb_quill_paystmt");
  assert.ok(t);
  assert.equal(t?.subject_type, "grant");
  assert.ok(t && t.events.length >= 3);
});

test("runs list and timeline behave like grants", () => {
  const failed = buildRunsList({ status: "failed" });
  assert.ok(failed.data.every((r) => r.status === "failed"));
  assert.equal(buildRunTimeline("run_does_not_exist"), null);
  const t = buildRunTimeline("run_sb_acme_2026_04_22");
  assert.ok(t);
  assert.equal(t?.subject_type, "run");
});

test("traces list and timeline behave like grants", () => {
  const denied = buildTracesList({ status: "denied" });
  assert.ok(denied.data.every((t) => t.status === "denied"));
  assert.equal(buildTraceTimeline("trace_does_not_exist"), null);
  const t = buildTraceTimeline("trace_sb_quill_paystmt");
  assert.ok(t);
  assert.equal(t?.subject_type, "trace");
});

test("dataset summary reports counts that line up with the dataset", () => {
  const summary = buildDatasetSummary();
  assert.equal(summary.is_demo, true);
  assert.ok(summary.connector_count >= 3);
  assert.ok(summary.stream_count >= 4);
  assert.ok(summary.record_count >= 5);
  assert.ok(summary.top_connectors.length >= 1);
});

const SANDBOX_SUFFIX_RE = /\/sandbox$/;
const SANDBOX_AUTHORIZE_RE = /\/sandbox\/authorize$/;
const SANDBOX_SCHEMA_RE = /\/sandbox\/v1\/schema$/;

test("well-known metadata advertises sandbox-prefixed endpoints", () => {
  const auth = buildAuthServerMetadata("https://pdpp.dev/sandbox");
  assert.equal(auth.is_demo, true);
  assert.match(auth.issuer, SANDBOX_SUFFIX_RE);
  assert.match(auth.authorization_endpoint, SANDBOX_AUTHORIZE_RE);
  assert.match(auth.pdpp_demo.schema_endpoint, SANDBOX_SCHEMA_RE);
  assert.equal(auth.issuer, "https://pdpp.dev/sandbox");
  const rs = buildProtectedResourceMetadata("https://pdpp.dev/sandbox");
  assert.equal(rs.is_demo, true);
  assert.match(rs.resource, SANDBOX_SUFFIX_RE);
  assert.ok(rs.authorization_servers.every((s) => s.endsWith("/sandbox")));
  assert.equal(rs.resource_documentation, "https://pdpp.dev/docs");
});
