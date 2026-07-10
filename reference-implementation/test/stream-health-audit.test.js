/**
 * Unit tests for the pure stream-health machine audit
 * (scripts/stream-health-audit/audit.mjs) and its live auth preflight.
 *
 * The audit now runs in settled/full mode over ConnectorSummary-shaped
 * fixtures:
 *   - required unknown/unmeasured and required+accepted-absence fail on
 *     settled connections regardless of pill label;
 *   - active bounded work is reported as inconclusive, but it does not
 *     suppress masked failures;
 *   - declared-stream count absence fails only when the retained-size
 *     projection is reliable, otherwise it stays inconclusive;
 *   - bearer auth is rejected before HTTP because /_ref/connectors is
 *     cookie-gated.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { auditStreamHealth } from "../../scripts/stream-health-audit/audit.mjs";
import { runLiveStreamHealthAudit } from "../../scripts/stream-health-audit/live.mjs";

function healthyVerdict(label = "Healthy", tone = "green") {
  return { pill: { label, tone } };
}

function coverageEntry(overrides = {}) {
  return {
    stream: "messages",
    coverage_condition: "complete",
    forward_disposition: "complete",
    coverage_strategy: "checkpoint_window",
    freshness_strategy: "scheduled_window",
    checkpoint: "2026-07-09T00:00:00.000Z",
    considered: 1,
    covered: 1,
    required: true,
    ...overrides,
  };
}

function retainedStream(stream, recordCount) {
  return { stream, record_count: recordCount, last_updated: null };
}

function settledConnection(overrides = {}) {
  return {
    connection_id: "conn_a",
    connector_id: "connector_a",
    display_name: "Conn A",
    status: "active",
    revoked_at: null,
    rendered_verdict: healthyVerdict(),
    connection_health: {
      badges: { syncing: false, stale: false },
      conditions: [{ type: "ProjectionReliable", status: "true" }],
      state: "healthy",
    },
    owner_state: { resolver: "healthy" },
    streams: ["messages", "attachments"],
    stream_records: [retainedStream("messages", 4), retainedStream("attachments", 0)],
    collection_report: [coverageEntry(), coverageEntry({ stream: "attachments" })],
    ...overrides,
  };
}

test("settled mode: degraded connection with a required unmeasured stream fails", () => {
  const result = auditStreamHealth([
    settledConnection({
      rendered_verdict: healthyVerdict("Degraded", "amber"),
      collection_report: [
        coverageEntry(),
        coverageEntry({
          stream: "attachments",
          coverage_condition: "unknown",
          forward_disposition: "unmeasured",
          checkpoint: "unknown",
          considered: "unknown",
          covered: "unknown",
        }),
      ],
    }),
  ]);

  assert.equal(result.status, "fail");
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.deepEqual(result.failures[0].streams, [
    { stream: "attachments", class: "runtime_evidence_missing" },
  ]);
});

test("settled mode: missing coverage_strategy is classified as stored-manifest drift", () => {
  const result = auditStreamHealth([
    settledConnection({
      collection_report: [
        coverageEntry(),
        coverageEntry({
          stream: "attachments",
          coverage_strategy: null,
          coverage_condition: "unknown",
          forward_disposition: "unmeasured",
          checkpoint: "unknown",
          considered: "unknown",
          covered: "unknown",
        }),
      ],
    }),
  ]);

  assert.equal(result.status, "fail");
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.deepEqual(result.failures[0].streams, [
    { stream: "attachments", class: "strategy_declaration_missing" },
  ]);
});

test("settled mode: blocked connection with a required unmeasured stream fails", () => {
  const result = auditStreamHealth([
    settledConnection({
      rendered_verdict: healthyVerdict("Can't collect", "red"),
      collection_report: [
        coverageEntry(),
        coverageEntry({
          stream: "attachments",
          coverage_condition: "unknown",
          forward_disposition: "unmeasured",
          checkpoint: "unknown",
          considered: "unknown",
          covered: "unknown",
        }),
      ],
    }),
  ]);

  assert.equal(result.status, "fail");
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.deepEqual(result.failures[0].streams, [
    { stream: "attachments", class: "runtime_evidence_missing" },
  ]);
});

test("settled mode: optional accepted absence does not fail", () => {
  const result = auditStreamHealth([
    settledConnection({
      collection_report: [
        coverageEntry(),
        coverageEntry({
          stream: "attachments",
          coverage_condition: "deferred",
          forward_disposition: "complete",
          required: false,
        }),
      ],
    }),
  ]);

  assert.equal(result.status, "pass");
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.inconclusive, []);
});

test("settled mode: active bounded work alone is inconclusive", () => {
  const result = auditStreamHealth([
    settledConnection({
      rendered_verdict: healthyVerdict("Checking", "grey"),
      connection_health: {
        badges: { syncing: true, stale: false },
        conditions: [{ type: "ProjectionReliable", status: "true" }],
        state: "unknown",
      },
      owner_state: { resolver: "collecting" },
    }),
  ]);

  assert.equal(result.status, "inconclusive");
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 0);
  assert.equal(result.inconclusive.length, 1);
  assert.deepEqual(result.inconclusive[0].streams, [
    { stream: "<active bounded work>", class: "active_bounded_work" },
  ]);
});

test("settled mode: contradictory active work still fails masked streams", () => {
  const result = auditStreamHealth([
    settledConnection({
      rendered_verdict: healthyVerdict("Healthy", "green"),
      connection_health: {
        badges: { syncing: true, stale: false },
        conditions: [{ type: "ProjectionReliable", status: "true" }],
        state: "unknown",
      },
      owner_state: { resolver: "collecting" },
      collection_report: [
        coverageEntry(),
        coverageEntry({
          stream: "attachments",
          coverage_condition: "unknown",
          forward_disposition: "unmeasured",
          checkpoint: "unknown",
          considered: "unknown",
          covered: "unknown",
        }),
      ],
    }),
  ]);

  assert.equal(result.status, "fail");
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.deepEqual(result.failures[0].streams, [
    { stream: "attachments", class: "runtime_evidence_missing" },
  ]);
  assert.equal(result.inconclusive.length, 1);
  assert.deepEqual(result.inconclusive[0].streams, [
    { stream: "<active bounded work>", class: "active_bounded_work" },
  ]);
});

test("settled mode: exact zero from a reliable retained projection passes", () => {
  const result = auditStreamHealth([
    settledConnection({
      streams: ["messages", "attachments"],
      stream_records: [retainedStream("messages", 4), retainedStream("attachments", 0)],
      collection_report: [coverageEntry(), coverageEntry({ stream: "attachments" })],
    }),
  ]);

  assert.equal(result.status, "pass");
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.inconclusive, []);
});

test("settled mode: dirty retained projection keeps declared-stream count unavailable and inconclusive", () => {
  const result = auditStreamHealth([
    settledConnection({
      connection_health: {
        badges: { syncing: false, stale: false },
        conditions: [{ type: "ProjectionReliable", status: "false" }],
        state: "healthy",
      },
      stream_records: [retainedStream("messages", 4)],
      collection_report: [coverageEntry(), coverageEntry({ stream: "attachments" })],
    }),
  ]);

  assert.equal(result.status, "inconclusive");
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 0);
  assert.equal(result.inconclusive.length, 1);
  assert.deepEqual(result.inconclusive[0].streams, [
    { stream: "attachments", class: "declared_stream_count_unavailable" },
  ]);
});

test("settled mode: required collection_report entries outside declared streams are still audited", () => {
  const result = auditStreamHealth([
    settledConnection({
      streams: ["messages"],
      stream_records: [retainedStream("messages", 4), retainedStream("legacy_stream", 0)],
      collection_report: [
        coverageEntry(),
        coverageEntry({
          stream: "legacy_stream",
          coverage_condition: "unknown",
          forward_disposition: "unmeasured",
          checkpoint: "unknown",
          considered: "unknown",
          covered: "unknown",
        }),
      ],
    }),
  ]);

  assert.equal(result.status, "fail");
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.deepEqual(result.failures[0].streams, [
    { stream: "legacy_stream", class: "runtime_evidence_missing" },
  ]);
  assert.deepEqual(result.inconclusive, []);
});

test("live audit: bearer auth is rejected before HTTP", async () => {
  let called = false;
  const result = await runLiveStreamHealthAudit({
    origin: "https://pdpp.example.com",
    env: { PDPP_OWNER_TOKEN: "owner-token-only" },
    fetchImpl: async () => {
      called = true;
      throw new Error("fetch should not run");
    },
  });

  assert.equal(called, false);
  assert.equal(result.fetched, false);
  assert.equal(result.authMode, "bearer");
  assert.equal(result.authCapability, "cookie_only");
  assert.equal(result.status, "inconclusive");
  assert.match(result.error, /not supported for \/_ref\/connectors/);
});

test("empty input passes", () => {
  const result = auditStreamHealth([]);
  assert.equal(result.status, "pass");
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.inconclusive, []);
});
