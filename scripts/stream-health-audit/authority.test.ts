// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { FetchImpl } from "../lib/owner-session.ts";
import { auditStreamHealth } from "./audit.ts";
import { evaluateStreamHealthAuthority, parseOwnerSourcesDom, type StreamHealthAuthorityResult } from "./authority.ts";
import { runLiveStreamHealthAuthority } from "./live.ts";

type Json = Record<string, unknown>;

const REVISION = "pdpp-reference@1.0.0+abcdef123456";
const SUCCESSFUL_RUNTIME_EVIDENCE_PATTERN = /successful runtime evidence/;
const DISAGREEMENT_PATTERN = /disagrees/;

function manifest(overrides: Json = {}): Json {
  return {
    connector_id: "mail",
    version: "manifest-1",
    streams: [{ name: "messages", required: true }],
    ...overrides,
  };
}

function healthyConnection(overrides: Json = {}): Json {
  return {
    connection_id: "c1",
    connector_id: "mail",
    status: "active",
    revoked_at: null,
    streams: ["messages"],
    manifest_version: "manifest-1",
    manifest_declaration: { state: "current" },
    record_snapshot: { state: "current" },
    terminal_facts: { state: "current" },
    owner_state: { resolver: "healthy", owner_of_state: "system", posture: "observed" },
    connection_health: {
      state: "healthy",
      axes: { coverage: "complete", freshness: "fresh", attention: "none", outbox: "idle" },
      conditions: [{ type: "ProjectionReliable", status: "true" }],
    },
    rendered_verdict: { pill: { tone: "green", label: "Healthy" } },
    last_run: { status: "succeeded", run_id: "run-1" },
    last_successful_run: { status: "succeeded", run_id: "run-1" },
    collection_report: [
      {
        stream: "messages",
        coverage_condition: "complete",
        coverage_strategy: "full_inventory",
        freshness_strategy: "manual_as_of",
        checkpoint: "checkpoint-1",
        considered: 1,
        covered: 1,
      },
    ],
    stream_records: [{ stream: "messages", record_count: 3, count_state: "known", declaration_state: "declared" }],
    ...overrides,
  };
}

function evaluate(connection: Json, connectorManifest = manifest()): StreamHealthAuthorityResult {
  return evaluateStreamHealthAuthority({ connections: [connection], manifests: [connectorManifest] });
}

function streamResult(result: StreamHealthAuthorityResult): StreamHealthAuthorityResult["streams"][number] {
  const stream = result.streams.find((item) => item.stream === "messages");
  assert.ok(stream, "expected a messages stream finding");
  return stream;
}

function response(body: unknown, status = 200, revision = REVISION) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    headers: {
      get(name: string): string | null {
        return name.toLowerCase() === "pdpp-reference-revision" ? revision : null;
      },
    },
    status,
    text: async () => text,
  };
}

test("derives an exact green numerator/denominator from active production streams", () => {
  const second = healthyConnection({ connection_id: "c2" });
  const result = evaluateStreamHealthAuthority({
    connections: [healthyConnection(), second],
    manifests: [manifest()],
  });

  assert.equal(result.status, "pass");
  assert.equal(result.ok, true);
  assert.deepEqual(result.score, { denominator: 2, numerator: 2, percentage: 100, ratio: "2/2" });
  assert.equal(result.activeConnectionCount, 2);
  assert.equal(result.productionStreamCount, 2);
  assert.equal(result.perClass.green, 2);
});

test("a healthy empty stream requires explicit verified-empty proof", () => {
  const connection = healthyConnection();
  const [report] = connection.collection_report as Json[];
  const [record] = connection.stream_records as Json[];
  assert.ok(report);
  assert.ok(record);
  report.considered = 0;
  report.covered = 0;
  report.verified_empty = true;
  record.record_count = 0;
  record.count_state = "known_zero";

  const result = evaluate(connection);
  assert.equal(result.status, "pass");
  assert.deepEqual(result.score, { denominator: 1, numerator: 1, percentage: 100, ratio: "1/1" });
  assert.equal(streamResult(result).reason, "successful runtime evidence plus explicit verified-empty proof");
});

test("false-known-zero is unobserved, while records/checkpoints without a successful run never turn green", () => {
  const falseZero = healthyConnection();
  const [falseZeroReport] = falseZero.collection_report as Json[];
  const [falseZeroRecord] = falseZero.stream_records as Json[];
  assert.ok(falseZeroReport);
  assert.ok(falseZeroRecord);
  falseZeroReport.considered = 0;
  falseZeroReport.covered = 0;
  falseZeroRecord.record_count = 0;
  falseZeroRecord.count_state = "known_zero";
  const falseZeroResult = evaluate(falseZero);
  assert.equal(streamResult(falseZeroResult).class, "unobserved");
  assert.equal(falseZeroResult.numerator, 0);
  assert.equal(falseZeroResult.status, "fail");

  const recordsNoProof = healthyConnection({ last_run: null, last_successful_run: null });
  const recordsNoProofResult = evaluate(recordsNoProof);
  assert.equal(streamResult(recordsNoProofResult).class, "unobserved");
  assert.match(streamResult(recordsNoProofResult).reason, SUCCESSFUL_RUNTIME_EVIDENCE_PATTERN);
  assert.equal(recordsNoProofResult.ok, false);
});

test("mutation counterweight: the legacy records-present shortcut passes what the final authority must reject", () => {
  const falseZero = healthyConnection();
  const [report] = falseZero.collection_report as Json[];
  const [record] = falseZero.stream_records as Json[];
  assert.ok(report);
  assert.ok(record);
  report.considered = 0;
  report.covered = 0;
  record.record_count = 0;
  record.count_state = "known_zero";

  const legacy = auditStreamHealth([falseZero]);
  const authority = evaluate(falseZero);
  assert.equal(legacy.ok, true, "the old ad hoc audit is the mutation being discriminated");
  assert.equal(authority.ok, false);
  assert.equal(streamResult(authority).class, "unobserved");
});

test("stale projection is distinct from unobserved and cannot be laundered by a green pill", () => {
  const connection = healthyConnection();
  (connection.record_snapshot as Json).state = "stale";
  const result = evaluate(connection);

  assert.equal(streamResult(result).class, "stale");
  assert.equal(result.perClass.stale, 1);
  assert.equal(result.status, "fail");
});

test("distinguishes active work, owner interaction, provider/config blocked, failed, unobserved, optional unsupported, and revoked", () => {
  const cases: Array<{ expected: string; make: () => Json; connectorManifest?: Json }> = [
    {
      expected: "active_bounded_work",
      make: () => healthyConnection({ owner_state: { resolver: "collecting" } }),
    },
    {
      expected: "owner_interaction",
      make: () => healthyConnection({ owner_state: { resolver: "needs_owner" } }),
    },
    {
      expected: "provider_config_blocked",
      make: () =>
        healthyConnection({
          connection_health: { state: "blocked", axes: {} },
          rendered_verdict: { pill: { tone: "red" } },
        }),
    },
    {
      expected: "failed",
      make: () => healthyConnection({ last_run: { status: "failed" }, rendered_verdict: { pill: { tone: "red" } } }),
    },
    {
      expected: "unobserved",
      make: () => {
        const connection = healthyConnection();
        connection.collection_report = undefined;
        return connection;
      },
    },
    {
      expected: "optional_unsupported",
      make: () => healthyConnection(),
      connectorManifest: manifest({ streams: [{ name: "messages", required: false, coverage_policy: "unsupported" }] }),
    },
    {
      expected: "revoked",
      make: () => healthyConnection({ status: "revoked", revoked_at: "2026-08-11T00:00:00.000Z" }),
    },
  ];

  for (const item of cases) {
    const result = evaluate(item.make(), item.connectorManifest ?? manifest());
    assert.equal(streamResult(result).class, item.expected, item.expected);
  }
});

test("uses the collection-report forward disposition and fails closed on manifest vocabulary/contradictions", () => {
  const active = healthyConnection();
  const [activeReport] = active.collection_report as Json[];
  assert.ok(activeReport);
  activeReport.forward_disposition = "checking";
  assert.equal(streamResult(evaluate(active)).class, "active_bounded_work");

  const ownerRefresh = healthyConnection();
  (ownerRefresh.connection_health as Json).forward_disposition = "awaiting_owner";
  assert.equal(streamResult(evaluate(ownerRefresh)).class, "owner_interaction");

  const terminal = healthyConnection();
  (terminal.connection_health as Json).forward_disposition = "terminal";
  assert.equal(streamResult(evaluate(terminal)).class, "failed");

  const unmeasured = healthyConnection();
  (unmeasured.connection_health as Json).forward_disposition = "unmeasured";
  assert.equal(streamResult(evaluate(unmeasured)).class, "unobserved");

  const contradictory = evaluate(
    healthyConnection(),
    manifest({ streams: [{ name: "messages", required: true, coverage_policy: "unsupported" }] })
  );
  assert.equal(streamResult(contradictory).class, "projection_disagreement");
  assert.equal(contradictory.status, "fail");

  const unknown = evaluate(
    healthyConnection(),
    manifest({ streams: [{ name: "messages", required: false, coverage_policy: "future_policy" }] })
  );
  assert.equal(streamResult(unknown).class, "unknown_vocabulary");
  assert.equal(unknown.status, "inconclusive");
});

test("catalog metadata excludes synthetic fixtures without excluding a production connector by name", () => {
  const connection = healthyConnection({ connector_id: "pg_runtime_demo" });
  const synthetic = manifest({ connector_id: "pg_runtime_demo", catalog: { kind: "test_fixture" } });
  const syntheticResult = evaluate(connection, synthetic);
  assert.equal(syntheticResult.score.denominator, 0);
  assert.equal(syntheticResult.score.numerator, 0);
  assert.equal(syntheticResult.syntheticFixtureCount, 1);
  assert.equal(syntheticResult.perClass.synthetic_fixture, 1);
  assert.equal(syntheticResult.domAgreement.status, "agree");

  const metadataOnly = evaluate(connection, { connector_id: "pg_runtime_demo", catalog: { kind: "test_fixture" } });
  assert.equal(metadataOnly.score.denominator, 0);
  assert.equal(metadataOnly.perClass.synthetic_fixture, 1);

  const production = manifest({ connector_id: "pg_runtime_demo", catalog: { kind: "production" } });
  const productionResult = evaluate(connection, production);
  assert.deepEqual(productionResult.score, { denominator: 1, numerator: 1, percentage: 100, ratio: "1/1" });
});

test("projection disagreement is visible instead of trusting the connection stream list", () => {
  const connection = healthyConnection({ streams: ["wrong_stream"] });
  const result = evaluate(connection);

  assert.equal(streamResult(result).class, "projection_disagreement");
  assert.equal(result.status, "fail");
  assert.match(streamResult(result).reason, DISAGREEMENT_PATTERN);
});

test("malformed owner inventory rows fail closed instead of disappearing from the score", () => {
  const result = evaluateStreamHealthAuthority({ connections: [null] });

  assert.equal(result.connectionCount, 1);
  assert.equal(result.perClass.projection_disagreement, 1);
  assert.equal(result.status, "fail");
  assert.equal(result.ok, false);
});

test("resolved authenticated DOM must agree with every real owner connection", () => {
  const result = evaluateStreamHealthAuthority({
    connections: [healthyConnection()],
    manifests: [manifest()],
    dom: { authenticated: true, connectionIds: [], paginationComplete: true, resolved: true },
  });

  assert.equal(result.domAgreement.status, "disagree");
  assert.deepEqual(result.domAgreement.missingConnectionIds, ["c1"]);
  assert.equal(result.perClass.projection_disagreement, 1);
  assert.equal(result.status, "fail");
});

test("auth, Suspense/loading, unknown vocabulary, and revision disagreement fail closed", () => {
  const auth = evaluateStreamHealthAuthority({
    auth: { authenticated: false, resolved: false },
    connections: [],
    dom: { authenticated: false, connectionIds: [], paginationComplete: false, resolved: false, suspense: false },
    paginationComplete: false,
    revision: { dom: null, summaries: null },
  });
  assert.equal(auth.status, "inconclusive");
  assert.ok(auth.perClass.inconclusive_auth > 0);

  const suspense = evaluateStreamHealthAuthority({
    auth: { authenticated: true, resolved: true },
    connections: [],
    dom: { authenticated: true, connectionIds: [], paginationComplete: true, resolved: false, suspense: true },
  });
  assert.equal(suspense.status, "inconclusive");
  assert.ok(suspense.perClass.inconclusive_suspense > 0);

  const unknownConnection = healthyConnection({ owner_state: { resolver: "future_resolver" } });
  const unknown = evaluate(unknownConnection);
  assert.equal(unknown.status, "inconclusive");
  assert.ok(unknown.perClass.unknown_vocabulary > 0);

  const revision = evaluateStreamHealthAuthority({
    connections: [healthyConnection()],
    manifests: [manifest()],
    dom: { authenticated: true, connectionIds: ["c1"], paginationComplete: true, resolved: true },
    expectedSha: "abcdef123456",
    revision: { dom: REVISION, expected: "different-revision", sha: "abcdef123456", summaries: REVISION },
  });
  assert.equal(revision.status, "inconclusive");
  assert.equal(revision.gates.revision, "inconclusive");
  assert.equal(revision.perClass.inconclusive_revision, 1);
});

test("exact revision and SHA receipt is accepted only when summary and authenticated DOM agree", () => {
  const result = evaluateStreamHealthAuthority({
    connections: [healthyConnection()],
    manifests: [manifest()],
    dom: { authenticated: true, connectionIds: ["c1"], paginationComplete: true, resolved: true },
    expectedSha: "abcdef123456",
    revision: { dom: REVISION, expected: REVISION, sha: "abcdef123456", summaries: REVISION },
  });

  assert.equal(result.status, "pass");
  assert.equal(result.gates.revision, "exact");
  assert.deepEqual(result.revisionReceipt, {
    exact: true,
    observedDom: REVISION,
    observedSummaries: REVISION,
    sha: "abcdef123456",
  });
});

test("the DOM parser recognizes source identities, pagination, empty state, and unresolved auth/loading", () => {
  const resolved = parseOwnerSourcesDom(
    '<a href="/sources/c1">one</a><a href="/sources/c1/messages">messages</a><a href="/sources?page_cursor=next">Next</a>'
  );
  assert.equal(resolved.resolved, true);
  assert.deepEqual(resolved.connectionIds, ["c1"]);
  assert.deepEqual(resolved.streamKeys, [{ connectionId: "c1", stream: "messages" }]);
  assert.deepEqual(resolved.nextPageHrefs, ["/sources?page_cursor=next"]);

  assert.equal(parseOwnerSourcesDom('<div data-testid="sources-empty">No sources</div>').resolved, true);
  assert.equal(parseOwnerSourcesDom('<form><input name="password" /></form>').resolved, false);
  assert.equal(parseOwnerSourcesDom('<div aria-busy="true">Loading</div>').suspense, true);
});

test("live authority exhausts summary pages and catches a DOM that hides the second owner connection", async () => {
  const c1 = healthyConnection();
  const c2 = healthyConnection({ connection_id: "c2" });
  const fetchImpl: FetchImpl = (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/_ref/connectors") {
      if (parsed.searchParams.get("cursor") === "page-2") {
        return Promise.resolve(response({ data: [c2], has_more: false, object: "list" }));
      }
      return Promise.resolve(response({ data: [c1], has_more: true, next_cursor: "page-2", object: "list" }));
    }
    if (parsed.pathname === "/connectors/mail") {
      return Promise.resolve(response(manifest()));
    }
    if (parsed.pathname === "/sources") {
      return Promise.resolve(response('<a href="/sources/c1">one</a>'));
    }
    throw new Error(`unexpected test URL ${url}`);
  };

  const result = await runLiveStreamHealthAuthority({
    env: { PDPP_OWNER_SESSION_COOKIE: "owner-session" },
    expectedRevision: REVISION,
    expectedSha: "abcdef123456",
    fetchImpl,
    origin: "https://example.test",
  });

  assert.equal(result.fetched, true);
  assert.equal(result.connectionCount, 2);
  assert.equal(result.score.denominator, 2);
  assert.deepEqual(result.domAgreement.missingConnectionIds, ["c2"]);
  assert.equal(result.perClass.projection_disagreement, 1);
  assert.equal(result.status, "fail");
});

test("live authority does not score a connection when its production manifest is missing", async () => {
  const fetchImpl: FetchImpl = (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/_ref/connectors") {
      return Promise.resolve(response({ data: [healthyConnection()], has_more: false, object: "list" }));
    }
    if (parsed.pathname === "/connectors/mail") {
      return Promise.resolve(response({ error: "not_found" }, 404));
    }
    if (parsed.pathname === "/sources") {
      return Promise.resolve(response('<a href="/sources/c1">one</a>'));
    }
    throw new Error(`unexpected test URL ${url}`);
  };

  const result = await runLiveStreamHealthAuthority({
    env: { PDPP_OWNER_SESSION_COOKIE: "owner-session" },
    expectedRevision: REVISION,
    expectedSha: "abcdef123456",
    fetchImpl,
    origin: "https://example.test",
  });

  assert.equal(result.fetched, true);
  assert.deepEqual(result.score, { denominator: 0, numerator: 0, percentage: null, ratio: "0/0" });
  assert.equal(result.perClass.manifest_unavailable, 1);
  assert.equal(result.status, "inconclusive");
});

test("live authority accepts a resolved authenticated empty owner surface with an exact revision receipt", async () => {
  const fetchImpl: FetchImpl = (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/_ref/connectors") {
      return Promise.resolve(response({ data: [], has_more: false, object: "list" }));
    }
    if (parsed.pathname === "/sources") {
      return Promise.resolve(response('<div data-testid="sources-empty">No sources yet</div>'));
    }
    throw new Error(`unexpected test URL ${url}`);
  };

  const result = await runLiveStreamHealthAuthority({
    env: { PDPP_OWNER_SESSION_COOKIE: "owner-session" },
    expectedRevision: REVISION,
    expectedSha: "abcdef123456",
    fetchImpl,
    origin: "https://example.test",
  });

  assert.equal(result.fetched, true);
  assert.equal(result.status, "pass");
  assert.deepEqual(result.score, { denominator: 0, numerator: 0, percentage: null, ratio: "0/0" });
  assert.equal(result.domAgreement.status, "agree");
  assert.equal(result.gates.dom, "resolved");
  assert.equal(result.gates.revision, "exact");
  assert.equal(result.revisionReceipt.exact, true);
});

test("live authority fails closed on a malformed/repeating summary cursor", async () => {
  const fetchImpl: FetchImpl = (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/_ref/connectors") {
      return Promise.resolve(response({ data: [], has_more: true, next_cursor: "same", object: "list" }));
    }
    throw new Error(`unexpected test URL ${url}`);
  };

  const result = await runLiveStreamHealthAuthority({
    env: { PDPP_OWNER_SESSION_COOKIE: "owner-session" },
    fetchImpl,
    origin: "https://example.test",
  });

  assert.equal(result.fetched, false);
  assert.equal(result.status, "inconclusive");
  assert.ok(result.perClass.inconclusive_pagination > 0);
});
