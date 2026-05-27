/**
 * Live-shape invariants for the sandbox HTTP routes.
 *
 * These tests assert that `/sandbox/v1/**`, `/sandbox/_ref/**`, and
 * `/sandbox/.well-known/**` return JSON shaped like the live PDPP
 * reference envelopes documented in:
 *   - reference-implementation/server/index.js
 *   - reference-implementation/server/search.js
 *   - reference-implementation/server/metadata.ts
 *
 * The sandbox is a callable mock AS/RS, so an agent or developer can
 * call it the same way they would call the real server. Sandbox
 * markers are conveyed via the `x-pdpp-demo` HTTP header rather than
 * payload fields — payloads are intended to be shape-compatible with
 * the live reference.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { GET as datasetSummaryGet } from "../ref/dataset/summary/route.ts";
import { GET as grantTimelineGet } from "../ref/grants/[grantId]/timeline/route.ts";
import { GET as grantsListGet } from "../ref/grants/route.ts";
import { GET as runTimelineGet } from "../ref/runs/[runId]/timeline/route.ts";
import { GET as runsListGet } from "../ref/runs/route.ts";
import { GET as traceTimelineGet } from "../ref/traces/[traceId]/route.ts";
import { GET as tracesListGet } from "../ref/traces/route.ts";
import { GET as schemaGet } from "../v1/schema/route.ts";
import { GET as searchGet } from "../v1/search/route.ts";
import { GET as recordDetailGet } from "../v1/streams/[stream]/records/[recordId]/route.ts";
import { GET as recordsListGet } from "../v1/streams/[stream]/records/route.ts";
import { GET as streamDetailGet } from "../v1/streams/[stream]/route.ts";
import { GET as streamsListGet } from "../v1/streams/route.ts";
import { GET as authServerGet } from "../well-known/oauth-authorization-server/route.ts";
import { GET as protectedResourceGet } from "../well-known/oauth-protected-resource/route.ts";

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await res.text());
}

function assertSandboxHeader(res: Response): void {
  assert.equal(res.headers.get("x-pdpp-demo"), "1", "expected x-pdpp-demo header");
}

// ─── /sandbox/v1/schema ────────────────────────────────────────────────────

test("/sandbox/v1/schema returns the live `schema` envelope (no demo-shaped object)", async () => {
  const res = await schemaGet();
  assert.equal(res.status, 200);
  assertSandboxHeader(res);
  const body = (await jsonOf(res)) as {
    object: string;
    bearer: { token_kind: string; scope: string };
    connectors: Array<{
      object: string;
      connector_id: string;
      source: { kind: string; id: string };
      stream_count: number;
      streams: Record<string, unknown>[];
    }>;
  };
  assert.equal(body.object, "schema", "schema response must use object: 'schema' (live shape)");
  assert.notEqual(body.object, "schema_graph", "schema_graph was the demo-shaped envelope");
  assert.equal(typeof body.bearer.token_kind, "string");
  assert.equal(typeof body.bearer.scope, "string");
  assert.ok(body.connectors.length >= 3);
  for (const c of body.connectors) {
    assert.equal(c.object, "connector");
    assert.equal(c.source.kind, "connector");
    assert.equal(c.source.id, c.connector_id);
    assert.equal(typeof c.stream_count, "number");
    assert.equal(c.streams.length, c.stream_count);
    for (const s of c.streams) {
      assert.equal(s.object, "stream_metadata");
      assert.equal(typeof s.name, "string");
      assert.ok(s.schema, "stream_metadata.schema is required");
      assert.ok(Array.isArray(s.primary_key));
    }
  }
});

// ─── /sandbox/v1/streams ───────────────────────────────────────────────────

test("/sandbox/v1/streams returns a live `list` of `stream` summaries", async () => {
  const res = await streamsListGet(new Request("https://example.invalid/sandbox/v1/streams"));
  assert.equal(res.status, 200);
  assertSandboxHeader(res);
  const body = (await jsonOf(res)) as {
    object: string;
    has_more: boolean;
    data: Record<string, unknown>[];
  };
  assert.equal(body.object, "list");
  assert.equal(typeof body.has_more, "boolean");
  assert.ok(body.data.length >= 1);
  for (const s of body.data) {
    assert.equal(s.object, "stream", "list entries use object: 'stream' (live shape)");
    assert.equal(typeof s.name, "string");
    assert.equal(typeof s.record_count, "number");
    assert.ok("last_updated" in s);
    assert.ok((s as { freshness?: unknown }).freshness);
  }
});

test("/sandbox/v1/streams supports connector_id filtering", async () => {
  const res = await streamsListGet(
    new Request("https://example.invalid/sandbox/v1/streams?connector_id=acme_payroll_demo")
  );
  const body = (await jsonOf(res)) as { data: Array<{ name: string }> };
  assert.ok(body.data.length >= 1);
});

// ─── /sandbox/v1/streams/:s ───────────────────────────────────────────────

test("/sandbox/v1/streams/:s returns the live `stream_metadata` envelope", async () => {
  const res = await streamDetailGet(new Request("https://example.invalid/sandbox/v1/streams/pay_statements"), {
    params: Promise.resolve({ stream: "pay_statements" }),
  });
  assert.equal(res.status, 200);
  assertSandboxHeader(res);
  const body = (await jsonOf(res)) as Record<string, unknown>;
  assert.equal(body.object, "stream_metadata");
  assert.equal(body.name, "pay_statements");
  assert.ok(body.schema, "stream_metadata.schema required");
  assert.ok(Array.isArray(body.primary_key));
  assert.ok("cursor_field" in body);
  assert.ok("freshness" in body);
});

test("/sandbox/v1/streams/:s returns 404 for unknown stream", async () => {
  const res = await streamDetailGet(new Request("https://example.invalid/sandbox/v1/streams/no_such"), {
    params: Promise.resolve({ stream: "no_such" }),
  });
  assert.equal(res.status, 404);
  assertSandboxHeader(res);
  const body = (await jsonOf(res)) as Record<string, unknown>;
  const error = body.error as Record<string, unknown>;
  assert.equal(error.type, "not_found_error");
  assert.equal(error.code, "not_found");
  assert.equal(typeof error.request_id, "string");
  assert.ok(!("object" in body), "live error envelopes do not use object: 'error'");
  assert.ok(!("is_demo" in body), "sandbox marker belongs in x-pdpp-demo, not the error payload");
});

// ─── /sandbox/v1/streams/:s/records ──────────────────────────────────────

test("/sandbox/v1/streams/:s/records returns a live `list` of `record` envelopes with id, data, emitted_at", async () => {
  const res = await recordsListGet(
    new Request("https://example.invalid/sandbox/v1/streams/pay_statements/records?limit=2"),
    { params: Promise.resolve({ stream: "pay_statements" }) }
  );
  assert.equal(res.status, 200);
  assertSandboxHeader(res);
  const body = (await jsonOf(res)) as {
    object: string;
    has_more: boolean;
    next_cursor?: string;
    url?: string;
    data: Record<string, unknown>[];
  };
  assert.equal(body.object, "list");
  assert.equal(typeof body.has_more, "boolean");
  assert.equal(body.url, "/sandbox/v1/streams/pay_statements/records");
  assert.equal(body.data.length, 2);
  // The live record envelope is { object: "record", id, stream, data, emitted_at }
  // — NOT the demo-shaped `record_id`/`fields`/`record_time`/`ingested_at`.
  for (const r of body.data) {
    assert.equal(r.object, "record", "records use object: 'record' (live shape)");
    assert.equal(typeof r.id, "string");
    assert.equal(typeof r.stream, "string");
    assert.equal(typeof r.emitted_at, "string");
    assert.equal(typeof r.data, "object");
    assert.ok(!("record_id" in r), "demo-shaped 'record_id' must not appear");
    assert.ok(!("fields" in r), "demo-shaped 'fields' must not appear (use 'data')");
    assert.ok(!("ingested_at" in r), "demo-shaped 'ingested_at' must not appear (use 'emitted_at')");
  }
  // Pagination invariant: more rows -> next_cursor present.
  if (body.has_more) {
    assert.equal(typeof body.next_cursor, "string");
  }
});

test("/sandbox/v1/streams/:s/records returns 404 for unknown stream", async () => {
  const res = await recordsListGet(new Request("https://example.invalid/sandbox/v1/streams/no_such/records"), {
    params: Promise.resolve({ stream: "no_such" }),
  });
  assert.equal(res.status, 404);
  const body = (await jsonOf(res)) as Record<string, unknown>;
  assert.equal((body.error as Record<string, unknown>).type, "not_found_error");
});

// ─── /sandbox/v1/streams/:s/records/:id ──────────────────────────────────

test("/sandbox/v1/streams/:s/records/:id returns a live `record` envelope", async () => {
  const res = await recordDetailGet(
    new Request("https://example.invalid/sandbox/v1/streams/pay_statements/records/rec_sb_paystmt_2026_03"),
    { params: Promise.resolve({ stream: "pay_statements", recordId: "rec_sb_paystmt_2026_03" }) }
  );
  assert.equal(res.status, 200);
  const body = (await jsonOf(res)) as Record<string, unknown>;
  assert.equal(body.object, "record");
  assert.equal(body.id, "rec_sb_paystmt_2026_03");
  assert.equal(body.stream, "pay_statements");
  assert.equal(typeof body.emitted_at, "string");
  assert.equal(typeof body.data, "object");
});

// ─── /sandbox/v1/search ──────────────────────────────────────────────────

test("/sandbox/v1/search returns the live `list` envelope with bm25-shaped scores", async () => {
  const res = await searchGet(new Request("https://example.invalid/sandbox/v1/search?q=payroll"));
  assert.equal(res.status, 200);
  assertSandboxHeader(res);
  const body = (await jsonOf(res)) as {
    object: string;
    url: string;
    has_more: boolean;
    data: Record<string, unknown>[];
  };
  assert.equal(body.object, "list");
  assert.equal(body.url, "/sandbox/v1/search");
  assert.ok(body.data.length > 0);
  for (const hit of body.data) {
    assert.equal(hit.object, "search_result");
    assert.equal(typeof hit.stream, "string");
    assert.equal(typeof hit.record_key, "string");
    assert.equal(typeof hit.connector_id, "string");
    assert.equal(typeof hit.record_url, "string");
    assert.equal(typeof hit.emitted_at, "string");
    assert.ok(Array.isArray(hit.matched_fields));
    if (hit.score) {
      const score = hit.score as { kind: string; order: string; value: number };
      assert.equal(score.kind, "bm25", "score.kind must be 'bm25' (live shape)");
      assert.equal(score.order, "lower_is_better");
      assert.equal(typeof score.value, "number");
    }
  }
});

// `/sandbox/v1/search` is now a host of the canonical `rs.search.lexical`
// operation. The operation enforces the v1 contract for every host: empty
// or missing `q` is `invalid_request`. (Owner guidance:
// `tmp/workstreams/mount-rs-search-lexical-operation-owner-guidance-1.md`.
// The dashboard search UI may render an empty result state without calling
// the API, but the API itself does not lie about the contract.)
test("/sandbox/v1/search rejects empty `q` with invalid_request (canonical contract)", async () => {
  const res = await searchGet(new Request("https://example.invalid/sandbox/v1/search?q="));
  assert.equal(res.status, 400);
  const body = (await jsonOf(res)) as {
    error: { type: string; code: string; message: string; param?: string };
  };
  assert.equal(body.error.code, "invalid_request");
  assert.equal(body.error.param, "q");
});

test("/sandbox/v1/search rejects missing `q` with invalid_request (canonical contract)", async () => {
  const res = await searchGet(new Request("https://example.invalid/sandbox/v1/search"));
  assert.equal(res.status, 400);
  const body = (await jsonOf(res)) as { error: { code: string; param?: string } };
  assert.equal(body.error.code, "invalid_request");
  assert.equal(body.error.param, "q");
});

test("/sandbox/v1/search rejects unsupported query parameters", async () => {
  const res = await searchGet(new Request("https://example.invalid/sandbox/v1/search?q=payroll&connector_id=foo"));
  assert.equal(res.status, 400);
  const body = (await jsonOf(res)) as { error: { code: string; param?: string } };
  assert.equal(body.error.code, "invalid_request");
  assert.equal(body.error.param, "connector_id");
});

test("/sandbox/v1/search exact filter narrows hits to a matching record", async () => {
  const res = await searchGet(
    new Request(
      "https://example.invalid/sandbox/v1/search?q=northwind&streams[]=pay_statements&filter[period_end]=2026-03-31"
    )
  );
  assert.equal(res.status, 200);
  const body = (await jsonOf(res)) as { object: string; data: Record<string, unknown>[] };
  assert.equal(body.object, "list");
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0]?.record_key, "rec_sb_paystmt_2026_03");
});

test("/sandbox/v1/search exact filter with non-matching value returns an empty list", async () => {
  const res = await searchGet(
    new Request(
      "https://example.invalid/sandbox/v1/search?q=northwind&streams[]=pay_statements&filter[period_end]=2099-01-01"
    )
  );
  assert.equal(res.status, 200);
  const body = (await jsonOf(res)) as { object: string; data: unknown[]; has_more: boolean };
  assert.equal(body.object, "list");
  assert.equal(body.data.length, 0);
  assert.equal(body.has_more, false);
});

const UNKNOWN_FIELD_MESSAGE = /Unknown field/;
const RANGE_NOT_DECLARED_MESSAGE = /Range filters are not declared/;

test("/sandbox/v1/search unknown filter field returns invalid_request", async () => {
  const res = await searchGet(
    new Request("https://example.invalid/sandbox/v1/search?q=northwind&streams[]=pay_statements&filter[bogus_field]=x")
  );
  assert.equal(res.status, 400);
  const body = (await jsonOf(res)) as { error: { code: string; param?: string; message: string } };
  assert.equal(body.error.code, "invalid_request");
  assert.equal(body.error.param, "filter");
  assert.match(body.error.message, UNKNOWN_FIELD_MESSAGE);
});

test("/sandbox/v1/search unsupported range filter returns invalid_request (sandbox declares no range_filters)", async () => {
  const res = await searchGet(
    new Request(
      "https://example.invalid/sandbox/v1/search?q=northwind&streams[]=pay_statements&filter[period_end][gte]=2026-01-01"
    )
  );
  assert.equal(res.status, 400);
  const body = (await jsonOf(res)) as { error: { code: string; param?: string; message: string } };
  assert.equal(body.error.code, "invalid_request");
  assert.equal(body.error.param, "filter");
  assert.match(body.error.message, RANGE_NOT_DECLARED_MESSAGE);
});

test("/sandbox/v1/search filter[...] without streams[] returns operation-owned invalid_request", async () => {
  const res = await searchGet(
    new Request("https://example.invalid/sandbox/v1/search?q=northwind&filter[period_end]=2026-03-31")
  );
  assert.equal(res.status, 400);
  const body = (await jsonOf(res)) as { error: { code: string; param?: string } };
  assert.equal(body.error.code, "invalid_request");
  // Operation-owned coupling rule names `streams` as the rejected param.
  assert.equal(body.error.param, "streams");
});

test("/sandbox/v1/search filters by streams[] and supports cursor round-trip", async () => {
  // First page (empty q? no — pick a hit in the demo dataset and bound it
  // by stream so we exercise the operation's real plan/snapshot flow).
  const res1 = await searchGet(
    new Request("https://example.invalid/sandbox/v1/search?q=northwind&streams[]=pay_statements&limit=1")
  );
  assert.equal(res1.status, 200);
  const body1 = (await jsonOf(res1)) as {
    object: string;
    has_more: boolean;
    data: Record<string, unknown>[];
    next_cursor?: string;
  };
  assert.equal(body1.object, "list");
  if (body1.has_more) {
    assert.equal(typeof body1.next_cursor, "string");
    const res2 = await searchGet(
      new Request(
        `https://example.invalid/sandbox/v1/search?q=northwind&streams[]=pay_statements&limit=1&cursor=${encodeURIComponent(body1.next_cursor as string)}`
      )
    );
    assert.equal(res2.status, 200);
  }
  for (const hit of body1.data) {
    assert.equal(hit.stream, "pay_statements");
  }
});

// ─── /sandbox/_ref/{traces,grants,runs} lists ───────────────────────────

test("/sandbox/_ref/traces returns the live `list` of `trace_summary` rows", async () => {
  const res = await tracesListGet(new Request("https://example.invalid/sandbox/_ref/traces"));
  assert.equal(res.status, 200);
  const body = (await jsonOf(res)) as { object: string; data: Record<string, unknown>[] };
  assert.equal(body.object, "list");
  for (const t of body.data) {
    assert.equal(t.object, "trace_summary");
    assert.equal(typeof t.trace_id, "string");
    assert.ok(Array.isArray(t.kinds));
    assert.equal(typeof t.event_count, "number");
    // Live trace_summary uses `failure: { event_type, reason } | null` — not
    // the demo-shaped scalar `failure_reason`.
    if (t.failure !== null && t.failure !== undefined) {
      const f = t.failure as { event_type: string; reason: string | null };
      assert.equal(typeof f.event_type, "string");
    }
  }
});

test("/sandbox/_ref/grants returns the live `list` of `grant_summary` rows", async () => {
  const res = await grantsListGet(new Request("https://example.invalid/sandbox/_ref/grants"));
  const body = (await jsonOf(res)) as { object: string; data: Record<string, unknown>[] };
  assert.equal(body.object, "list");
  for (const g of body.data) {
    assert.equal(g.object, "grant_summary");
    assert.equal(typeof g.grant_id, "string");
    assert.ok(Array.isArray(g.kinds), "grant_summary.kinds is required (live shape)");
  }
});

test("/sandbox/_ref/runs returns the live `list` of `run_summary` rows", async () => {
  const res = await runsListGet(new Request("https://example.invalid/sandbox/_ref/runs"));
  const body = (await jsonOf(res)) as { object: string; data: Record<string, unknown>[] };
  assert.equal(body.object, "list");
  for (const r of body.data) {
    assert.equal(r.object, "run_summary");
    assert.equal(typeof r.run_id, "string");
    assert.equal(typeof r.needs_input, "boolean");
    assert.ok("failure_reason" in r);
  }
});

test("/sandbox/_ref/runs filters by status", async () => {
  const res = await runsListGet(new Request("https://example.invalid/sandbox/_ref/runs?status=failed"));
  const body = (await jsonOf(res)) as { data: Array<{ status: string }> };
  for (const r of body.data) {
    assert.equal(r.status, "failed");
  }
});

// ─── /sandbox/_ref/{trace,grant,run}/timeline ────────────────────────────

test("/sandbox/_ref/traces/:id returns the live `trace` timeline (object='trace', data=events)", async () => {
  const res = await traceTimelineGet(
    new Request("https://example.invalid/sandbox/_ref/traces/trace_sb_quill_paystmt"),
    { params: Promise.resolve({ traceId: "trace_sb_quill_paystmt" }) }
  );
  assert.equal(res.status, 200);
  const body = (await jsonOf(res)) as {
    object: string;
    trace_id: string;
    event_count: number;
    data: Record<string, unknown>[];
  };
  assert.equal(body.object, "trace", "trace timelines use object: 'trace' (live shape)");
  assert.equal(body.trace_id, "trace_sb_quill_paystmt");
  assert.equal(typeof body.event_count, "number");
  assert.ok(Array.isArray(body.data), "data array required (events live under `data`, not `events`)");
  assert.equal(body.event_count, body.data.length);
  // Events are spine events; sort ascending by occurred_at.
  const occurredAts = body.data.map((e) => e.occurred_at as string);
  const sorted = [...occurredAts].sort();
  assert.deepEqual(occurredAts, sorted, "events sorted ascending by occurred_at");
});

test("/sandbox/_ref/grants/:id/timeline returns the live `grant_timeline` envelope", async () => {
  const res = await grantTimelineGet(
    new Request("https://example.invalid/sandbox/_ref/grants/grant_sb_quill_paystmt/timeline"),
    { params: Promise.resolve({ grantId: "grant_sb_quill_paystmt" }) }
  );
  assert.equal(res.status, 200);
  const body = (await jsonOf(res)) as {
    object: string;
    grant_id: string;
    trace_id: string | null;
    event_count: number;
    data: Record<string, unknown>[];
  };
  assert.equal(body.object, "grant_timeline");
  assert.equal(body.grant_id, "grant_sb_quill_paystmt");
  assert.ok(Array.isArray(body.data));
  assert.ok(body.data.length >= 3);
});

test("/sandbox/_ref/runs/:id/timeline returns the live `run_timeline` envelope", async () => {
  const res = await runTimelineGet(
    new Request("https://example.invalid/sandbox/_ref/runs/run_sb_acme_2026_04_22/timeline"),
    { params: Promise.resolve({ runId: "run_sb_acme_2026_04_22" }) }
  );
  assert.equal(res.status, 200);
  const body = (await jsonOf(res)) as { object: string; run_id: string; data: unknown[] };
  assert.equal(body.object, "run_timeline");
  assert.equal(body.run_id, "run_sb_acme_2026_04_22");
  assert.ok(Array.isArray(body.data));
});

// ─── /sandbox/_ref/dataset/summary ───────────────────────────────────────

test("/sandbox/_ref/dataset/summary returns the live `dataset_summary` envelope", async () => {
  const res = await datasetSummaryGet();
  assert.equal(res.status, 200);
  const body = (await jsonOf(res)) as Record<string, unknown>;
  assert.equal(body.object, "dataset_summary");
  for (const key of [
    "connector_count",
    "stream_count",
    "record_count",
    "record_json_bytes",
    "record_changes_json_bytes",
    "blob_bytes",
    "total_retained_bytes",
    "earliest_record_time",
    "latest_record_time",
    "earliest_ingested_at",
    "latest_ingested_at",
    "top_connectors",
  ]) {
    assert.ok(key in body, `dataset_summary missing live key: ${key}`);
  }
  for (const tc of body.top_connectors as Record<string, unknown>[]) {
    assert.equal(tc.object, "dataset_connector_summary");
    assert.equal(typeof tc.connector_id, "string");
    assert.equal(typeof tc.record_count, "number");
  }
});

// ─── /sandbox/.well-known/{authorization-server,protected-resource} ───────

test("/sandbox/.well-known/oauth-authorization-server returns the live AS metadata shape", async () => {
  const res = authServerGet(new Request("https://example.invalid/sandbox/.well-known/oauth-authorization-server"));
  assert.equal(res.status, 200);
  const body = (await jsonOf(res)) as Record<string, unknown>;
  assert.equal(body.issuer, "https://example.invalid/sandbox");
  assert.equal(typeof body.introspection_endpoint, "string");
  assert.ok(body.pdpp_provider_connect_capabilities, "live AS metadata requires pdpp_provider_connect_capabilities");
  // Live shape has no top-level `authorization_endpoint`/`scopes_supported`.
  assert.ok(!("authorization_endpoint" in body), "demo-shaped 'authorization_endpoint' must not appear");
  assert.ok(!("scopes_supported" in body), "demo-shaped 'scopes_supported' must not appear");
});

test("/sandbox/.well-known/oauth-protected-resource returns the live RS metadata shape", async () => {
  const res = await protectedResourceGet(new Request("https://example.invalid/sandbox/.well-known/oauth-protected-resource"));
  assert.equal(res.status, 200);
  const body = (await jsonOf(res)) as Record<string, unknown>;
  assert.equal(body.resource, "https://example.invalid/sandbox");
  assert.equal(typeof body.resource_name, "string");
  assert.deepEqual(body.bearer_methods_supported, ["header"]);
  assert.equal(body.pdpp_self_export_supported, true);
  assert.deepEqual(body.pdpp_token_kinds_supported, ["owner", "client"]);
  assert.equal(typeof body.pdpp_core_query_base, "string");
  assert.ok(body.pdpp_discovery_hints, "live RS metadata advertises pdpp_discovery_hints");
  const hints = body.pdpp_discovery_hints as Record<string, unknown>;
  assert.equal(typeof hints.schema_endpoint, "string");
  assert.equal(typeof hints.query_base, "string");
  const agentDiscovery = body.pdpp_agent_discovery as {
    advisory?: boolean;
    cli?: Record<string, unknown>;
    llms_full_txt?: string;
    llms_txt?: string;
    recommended_flow?: string;
    skill?: string;
    skill_catalog?: string;
    skill_name?: string;
  };
  assert.equal(agentDiscovery.advisory, true);
  assert.equal(agentDiscovery.skill_name, "pdpp-data-access");
  assert.equal(agentDiscovery.recommended_flow, "pdpp connect");
  assert.equal(agentDiscovery.skill_catalog, "https://example.invalid/.well-known/skills/index.json");
  assert.equal(agentDiscovery.skill, "https://example.invalid/.well-known/skills/pdpp-data-access/SKILL.md");
  assert.equal(agentDiscovery.llms_txt, "https://example.invalid/llms.txt");
  assert.equal(agentDiscovery.llms_full_txt, "https://example.invalid/llms-full.txt");
  assert.deepEqual(agentDiscovery.cli, {
    package: "@pdpp/cli",
    package_specifier: "@pdpp/cli@beta",
    bin_name: "pdpp",
    install_command: "npx -y @pdpp/cli@beta --help",
    run_command: "npx -y @pdpp/cli@beta connect https://example.invalid/sandbox",
    connect_command: "npx -y @pdpp/cli@beta connect <provider-url>",
    version_policy: "beta",
    no_owner_token: true,
    no_owner_token_policy: "owner_browser_approval_required",
  });
  // Lexical retrieval must be advertised because the route is implemented.
  const caps = body.capabilities as { lexical_retrieval?: { supported?: boolean; endpoint?: string } } | undefined;
  assert.equal(caps?.lexical_retrieval?.supported, true);
  assert.ok(caps?.lexical_retrieval?.endpoint);
});

test("sandbox metadata prefers X-Forwarded-Host/Proto over the request URL", async () => {
  // Under `next dev --hostname 0.0.0.0` the request URL would otherwise pin
  // the issuer to `http://0.0.0.0:...`, which is not an address a relying
  // party can resolve. The forwarded headers must win.
  const res = authServerGet(
    new Request("http://0.0.0.0:3010/sandbox/.well-known/oauth-authorization-server", {
      headers: {
        "x-forwarded-host": "pdpp.example.com",
        "x-forwarded-proto": "https",
        host: "0.0.0.0:3010",
      },
    })
  );
  assert.equal(res.status, 200);
  const body = (await jsonOf(res)) as Record<string, unknown>;
  assert.equal(body.issuer, "https://pdpp.example.com/sandbox");
});

test("sandbox metadata falls back to Host header when no forwarded headers are present", async () => {
  const res = await protectedResourceGet(
    new Request("http://0.0.0.0:3010/sandbox/.well-known/oauth-protected-resource", {
      headers: {
        host: "pdpp.example.com",
      },
    })
  );
  assert.equal(res.status, 200);
  const body = (await jsonOf(res)) as Record<string, unknown>;
  assert.equal(body.resource, "http://pdpp.example.com/sandbox");
});

test("sandbox metadata normalizes 0.0.0.0 to localhost when no forwarded or host headers are routable", async () => {
  // Last-resort fallback: a direct dev call to `0.0.0.0` should not advertise
  // `0.0.0.0` to the caller. Normalize to `localhost` while preserving the
  // port so the document still names a reachable origin.
  const res = authServerGet(
    new Request("http://0.0.0.0:3010/sandbox/.well-known/oauth-authorization-server", {
      headers: {
        host: "0.0.0.0:3010",
      },
    })
  );
  assert.equal(res.status, 200);
  const body = (await jsonOf(res)) as Record<string, unknown>;
  assert.equal(body.issuer, "http://localhost:3010/sandbox");
});

test("sandbox metadata preserves bracketed IPv6 hosts and only normalizes bind addresses", async () => {
  // Bracketed IPv6 in Host headers (`[::1]:3010`, `[2001:db8::1]:3010`) must
  // round-trip — the colon-split that works for IPv4 / DNS names would
  // otherwise truncate the address. The bind-only literal `::` is normalized
  // to `localhost`; routable IPv6 addresses are passed through.
  {
    const res = authServerGet(
      new Request("http://0.0.0.0:3010/sandbox/.well-known/oauth-authorization-server", {
        headers: { host: "[2001:db8::1]:3010" },
      })
    );
    const body = (await jsonOf(res)) as Record<string, unknown>;
    assert.equal(body.issuer, "http://[2001:db8::1]:3010/sandbox");
  }
  {
    const res = authServerGet(
      new Request("http://0.0.0.0:3010/sandbox/.well-known/oauth-authorization-server", {
        headers: { host: "[::]:3010" },
      })
    );
    const body = (await jsonOf(res)) as Record<string, unknown>;
    assert.equal(body.issuer, "http://localhost:3010/sandbox");
  }
});

test("sandbox metadata strips the first value from a comma-list X-Forwarded-Host", async () => {
  // X-Forwarded-Host can be a list when multiple proxies append. RFC 7239
  // semantics: the leftmost value is the original client. Mirror the live AS
  // helper which already does this.
  const res = authServerGet(
    new Request("http://0.0.0.0:3010/sandbox/.well-known/oauth-authorization-server", {
      headers: {
        "x-forwarded-host": "pdpp.example.com, internal-lb.example.com",
        "x-forwarded-proto": "https, http",
      },
    })
  );
  assert.equal(res.status, 200);
  const body = (await jsonOf(res)) as Record<string, unknown>;
  assert.equal(body.issuer, "https://pdpp.example.com/sandbox");
});
