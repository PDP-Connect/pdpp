/**
 * Unit tests for the pure stream-health machine audit
 * (scripts/stream-health-audit/audit.mjs).
 *
 * Fixture connection objects are shaped like the `GET /_ref/connectors`
 * summary entries (`ConnectorSummary` in server/ref-control.ts):
 * `rendered_verdict.pill.label`, `collection_report[]`. No server is
 * started — auditStreamHealth is a pure function of these fixtures per
 * openspec/changes/define-stream-coverage-freshness-evidence tasks.md 9.1.
 *
 * Contract highlights pinned here:
 *   - No active-run exemption: under active work the pill must render
 *     Syncing/Checking, never Healthy, so Healthy + active work +
 *     required-unknown is an impossible snapshot and FAILS.
 *   - Accepted-absence coverage conditions resolve a stream only when it is
 *     non-required. required:true + accepted-absence is a contradictory
 *     manifest (`pickRequiredAcceptedCoverage`,
 *     server/connector-coverage-policy.ts) and FAILS beneath Healthy.
 *   - Failure classes are neutral evidence facts, not inferred causes:
 *     strategy_declaration_missing / runtime_evidence_missing /
 *     accepted_absence_on_required.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { auditStreamHealth } from "../../scripts/stream-health-audit/audit.mjs";

function healthyVerdict() {
  return { pill: { label: "Healthy", tone: "green" } };
}

function baseEntry(overrides = {}) {
  return {
    stream: "orders",
    coverage_condition: "complete",
    forward_disposition: "complete",
    coverage_strategy: "checkpoint_window",
    freshness_strategy: "manual_as_of",
    checkpoint: "2026-07-09T00:00:00.000Z",
    considered: 12,
    covered: 12,
    required: true,
    ...overrides,
  };
}

test("masked case: Healthy connection with a required stream resting unmeasured fails, strategy present -> runtime_evidence_missing", () => {
  const connection = {
    connection_id: "conn_amazon_1",
    display_name: "Amazon",
    rendered_verdict: healthyVerdict(),
    last_run: { status: "succeeded" },
    collection_report: [
      baseEntry(),
      baseEntry({
        stream: "order_items",
        coverage_condition: "unknown",
        forward_disposition: "unmeasured",
        coverage_strategy: "parent_detail_accounting",
        checkpoint: "unknown",
        considered: "unknown",
        covered: "unknown",
      }),
    ],
  };

  const result = auditStreamHealth([connection]);

  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].connection_id, "conn_amazon_1");
  assert.deepEqual(result.failures[0].streams, [{ stream: "order_items", class: "runtime_evidence_missing" }]);
});

test("masked case: missing coverage_strategy on the entry classifies as strategy_declaration_missing", () => {
  const connection = {
    connection_id: "conn_usaa_1",
    display_name: "USAA",
    rendered_verdict: healthyVerdict(),
    last_run: { status: "succeeded" },
    collection_report: [
      baseEntry({
        stream: "statements",
        coverage_condition: "unknown",
        forward_disposition: "unmeasured",
        coverage_strategy: null,
        checkpoint: "unknown",
        considered: "unknown",
        covered: "unknown",
      }),
    ],
  };

  const result = auditStreamHealth([connection]);

  assert.equal(result.ok, false);
  assert.deepEqual(result.failures[0].streams, [{ stream: "statements", class: "strategy_declaration_missing" }]);
});

test("honest case: Healthy connection with all required streams proven complete passes", () => {
  const connection = {
    connection_id: "conn_chase_1",
    display_name: "Chase",
    rendered_verdict: healthyVerdict(),
    last_run: { status: "succeeded" },
    collection_report: [baseEntry({ stream: "balances" }), baseEntry({ stream: "current_activity" })],
  };

  const result = auditStreamHealth([connection]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test("accepted-policy case: non-required unknown coverage does not fail even when Healthy", () => {
  const connection = {
    connection_id: "conn_slack_1",
    display_name: "Slack",
    rendered_verdict: healthyVerdict(),
    last_run: { status: "succeeded" },
    collection_report: [
      baseEntry({ stream: "messages" }),
      baseEntry({
        stream: "stars",
        coverage_condition: "unknown",
        forward_disposition: "unmeasured",
        coverage_strategy: "full_inventory",
        required: false,
        checkpoint: "unknown",
        considered: "unknown",
        covered: "unknown",
      }),
    ],
  };

  const result = auditStreamHealth([connection]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test("accepted-policy case: accepted-absence conditions on NON-required streams pass", () => {
  const connection = {
    connection_id: "conn_slack_2",
    display_name: "Slack Accepted",
    rendered_verdict: healthyVerdict(),
    last_run: { status: "succeeded" },
    collection_report: [
      baseEntry({ stream: "messages" }),
      baseEntry({ stream: "a", coverage_condition: "deferred", forward_disposition: "complete", required: false }),
      baseEntry({ stream: "b", coverage_condition: "inventory_only", forward_disposition: "complete", required: false }),
      baseEntry({ stream: "c", coverage_condition: "unavailable", forward_disposition: "complete", required: false }),
      baseEntry({ stream: "d", coverage_condition: "unsupported", forward_disposition: "complete", required: false }),
    ],
  };

  const result = auditStreamHealth([connection]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test("contradictory-manifest case: accepted-absence conditions on REQUIRED streams fail beneath Healthy", () => {
  const connection = {
    connection_id: "conn_contradictory_1",
    display_name: "Contradictory Manifest",
    rendered_verdict: healthyVerdict(),
    last_run: { status: "succeeded" },
    collection_report: [
      baseEntry({ stream: "a", coverage_condition: "deferred", forward_disposition: "complete" }),
      baseEntry({ stream: "b", coverage_condition: "inventory_only", forward_disposition: "complete" }),
      baseEntry({ stream: "c", coverage_condition: "unavailable", forward_disposition: "complete" }),
      baseEntry({ stream: "d", coverage_condition: "unsupported", forward_disposition: "complete" }),
    ],
  };

  const result = auditStreamHealth([connection]);

  assert.equal(result.ok, false);
  assert.deepEqual(result.failures[0].streams, [
    { stream: "a", class: "accepted_absence_on_required" },
    { stream: "b", class: "accepted_absence_on_required" },
    { stream: "c", class: "accepted_absence_on_required" },
    { stream: "d", class: "accepted_absence_on_required" },
  ]);
});

test("impossible-snapshot case: Healthy pill with an in-progress run AND a required-unknown stream still fails", () => {
  // Under active bounded work the verdict contract renders Syncing/Checking,
  // never Healthy — this snapshot is internally impossible and must FAIL,
  // not be excused by the active run.
  const connection = {
    connection_id: "conn_impossible_1",
    display_name: "Impossible Snapshot",
    rendered_verdict: healthyVerdict(),
    last_run: { status: "in_progress" },
    collection_report: [
      baseEntry({
        stream: "messages",
        coverage_condition: "unknown",
        forward_disposition: "checking",
        checkpoint: "unknown",
        considered: "unknown",
        covered: "unknown",
      }),
    ],
  };

  const result = auditStreamHealth([connection]);

  assert.equal(result.ok, false);
  assert.deepEqual(result.failures[0].streams, [{ stream: "messages", class: "runtime_evidence_missing" }]);
});

test("impossible-snapshot case: an explicit active_run boolean does not excuse Healthy + required-unknown", () => {
  const connection = {
    connection_id: "conn_impossible_2",
    display_name: "Impossible Snapshot 2",
    rendered_verdict: healthyVerdict(),
    active_run: true,
    collection_report: [
      baseEntry({
        stream: "messages",
        coverage_condition: "unknown",
        forward_disposition: "unmeasured",
        checkpoint: "unknown",
        considered: "unknown",
        covered: "unknown",
      }),
    ],
  };

  const result = auditStreamHealth([connection]);

  assert.equal(result.ok, false);
  assert.deepEqual(result.failures[0].streams, [{ stream: "messages", class: "runtime_evidence_missing" }]);
});

test("active-run case with a Checking pill: non-Healthy verdicts are not audited", () => {
  // The legitimate active-work rendering: the pill itself reads Checking
  // (or Syncing), not Healthy. The audit only inspects Healthy pills, so
  // this connection passes regardless of its unresolved streams.
  const connection = {
    connection_id: "conn_checking_1",
    display_name: "Checking Source",
    rendered_verdict: { pill: { label: "Checking", tone: "grey" } },
    last_run: { status: "in_progress" },
    collection_report: [
      baseEntry({
        stream: "messages",
        coverage_condition: "unknown",
        forward_disposition: "checking",
        checkpoint: "unknown",
        considered: "unknown",
        covered: "unknown",
      }),
    ],
  };

  const result = auditStreamHealth([connection]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test("non-Healthy connections are not audited even with masked-looking required streams", () => {
  const connection = {
    connection_id: "conn_degraded_1",
    display_name: "Degraded Source",
    rendered_verdict: { pill: { label: "Degraded", tone: "amber" } },
    last_run: { status: "succeeded" },
    collection_report: [
      baseEntry({
        stream: "messages",
        coverage_condition: "unknown",
        forward_disposition: "unmeasured",
        checkpoint: "unknown",
        considered: "unknown",
        covered: "unknown",
      }),
    ],
  };

  const result = auditStreamHealth([connection]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test("proven local-diagnostic completes (proven coverage condition) do not fail even at unmeasured freshness", () => {
  const connection = {
    connection_id: "conn_local_1",
    display_name: "Local Device",
    rendered_verdict: healthyVerdict(),
    last_run: { status: "succeeded" },
    collection_report: [
      baseEntry({
        stream: "device_export",
        coverage_condition: "complete",
        forward_disposition: "complete",
        freshness_strategy: "device_heartbeat",
      }),
    ],
  };

  const result = auditStreamHealth([connection]);

  assert.equal(result.ok, true);
});

test("missing required field on the entry is treated as required (fail closed)", () => {
  const entry = baseEntry({
    stream: "transactions",
    coverage_condition: "unknown",
    forward_disposition: "unmeasured",
    checkpoint: "unknown",
    considered: "unknown",
    covered: "unknown",
  });
  delete entry.required;

  const connection = {
    connection_id: "conn_no_required_field_1",
    display_name: "Pre-required-field Source",
    rendered_verdict: healthyVerdict(),
    last_run: { status: "succeeded" },
    collection_report: [entry],
  };

  const result = auditStreamHealth([connection]);

  assert.equal(result.ok, false);
  assert.equal(result.failures[0].streams[0].stream, "transactions");
});

test("multiple failures across connections are all reported", () => {
  const connections = [
    {
      connection_id: "conn_a",
      display_name: "A",
      rendered_verdict: healthyVerdict(),
      last_run: { status: "succeeded" },
      collection_report: [
        baseEntry({ stream: "s1", coverage_condition: "unknown", forward_disposition: "unmeasured" }),
      ],
    },
    {
      connection_id: "conn_b",
      display_name: "B",
      rendered_verdict: healthyVerdict(),
      last_run: { status: "succeeded" },
      collection_report: [
        baseEntry({ stream: "s2", coverage_condition: "unknown", forward_disposition: "unmeasured" }),
      ],
    },
  ];

  const result = auditStreamHealth(connections);

  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 2);
});

test("empty input passes", () => {
  const result = auditStreamHealth([]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});
