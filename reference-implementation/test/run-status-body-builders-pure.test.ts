// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for the run-status envelope builders in
// server/routes/ref-run-status.ts. Neither is imported by name. They build the
// `run_status` object returned by GET /_ref/runs/:id/status; the active-vs-terminal
// field shapes, the connector_id/trace_id/started_at fallbacks, and the
// terminal_reason dual-key lookup are the mutation surface.
//
// Mutation surface:
//   buildActiveRunStatusBody -- status='active', completed_at/failure/terminal_reason
//     all null, timeline link, fields carried from the active-run struct.
//   buildTerminalRunStatusBody -- completed_at from terminal, status from terminal,
//     connector_id = readConnectorId(started) ?? readConnectorId(terminal)
//     (actor_id, else data.source.id for a connector source), started_at from
//     started (else null), trace_id = started.trace_id ?? terminal.trace_id,
//     terminal_reason = data.reason ?? data.failure_reason.

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildActiveRunStatusBody,
  buildTerminalRunStatusBody,
  type RunStatusLifecycleEvent,
  type RunStatusTerminalEvent,
} from "../server/routes/ref-run-status.ts";

// ---------------------------------------------------------------------------
// buildActiveRunStatusBody
// ---------------------------------------------------------------------------

test("buildActiveRunStatusBody: active-run shape with null terminal fields and a timeline link", () => {
  const body = buildActiveRunStatusBody({
    connector_id: "amazon",
    connector_instance_id: "ci-1",
    run_id: "run-1",
    started_at: "2024-01-01T00:00:00Z",
    trace_id: "tr-1",
  });
  assert.equal(body.object, "run_status");
  assert.equal(body.status, "active");
  assert.equal(body.completed_at, null);
  assert.equal(body.failure, null);
  assert.equal(body.terminal_reason, null);
  assert.equal(body.connector_id, "amazon");
  assert.equal(body.connector_instance_id, "ci-1");
  assert.equal(body.started_at, "2024-01-01T00:00:00Z");
  assert.equal(body.trace_id, "tr-1");
  assert.deepEqual(body.links, { timeline: "/_ref/runs/run-1/timeline" }, "timeline link URL-encodes the run id");
});

test("buildActiveRunStatusBody: run id is URL-encoded in the timeline link", () => {
  const body = buildActiveRunStatusBody({
    connector_id: "amazon",
    connector_instance_id: "ci-1",
    run_id: "run/with slash",
    started_at: "2024-01-01T00:00:00Z",
    trace_id: "tr-1",
  });
  assert.equal(body.links.timeline, "/_ref/runs/run%2Fwith%20slash/timeline");
});

// ---------------------------------------------------------------------------
// buildTerminalRunStatusBody
// ---------------------------------------------------------------------------

const succeededTerminal: RunStatusTerminalEvent = {
  actor_id: null,
  data: {},
  event_type: "run.succeeded",
  occurred_at: "2024-01-02T00:00:00Z",
  status: "completed",
  trace_id: "tr-terminal",
};

test("buildTerminalRunStatusBody: completed_at + status come from the terminal event", () => {
  const body = buildTerminalRunStatusBody("run-2", succeededTerminal, null);
  assert.equal(body.status, "completed");
  assert.equal(body.completed_at, "2024-01-02T00:00:00Z");
  assert.equal(body.connector_instance_id, null, "spine does not carry the connection id");
  assert.deepEqual(body.links, { timeline: "/_ref/runs/run-2/timeline" });
});

test("buildTerminalRunStatusBody: trace_id prefers the started event, started_at comes from started", () => {
  const started: RunStatusLifecycleEvent = {
    actor_id: null,
    data: {},
    event_type: "run.started",
    occurred_at: "2024-01-01T00:00:00Z",
    trace_id: "tr-started",
  };
  const body = buildTerminalRunStatusBody("run-2", succeededTerminal, started);
  assert.equal(body.trace_id, "tr-started", "started trace_id wins over terminal");
  assert.equal(body.started_at, "2024-01-01T00:00:00Z");
});

test("buildTerminalRunStatusBody: with no started event, trace_id falls back to terminal and started_at is null", () => {
  const body = buildTerminalRunStatusBody("run-2", succeededTerminal, null);
  assert.equal(body.trace_id, "tr-terminal", "terminal trace_id used when no started");
  assert.equal(body.started_at, null);
});

test("buildTerminalRunStatusBody: connector_id resolves from started actor_id, then data.source, then terminal", () => {
  // started.actor_id wins.
  const startedActor: RunStatusLifecycleEvent = {
    actor_id: "started-connector",
    data: {},
    event_type: "run.started",
    occurred_at: "s",
    trace_id: "t",
  };
  assert.equal(buildTerminalRunStatusBody("r", succeededTerminal, startedActor).connector_id, "started-connector");

  // started has no actor_id but a connector data.source.
  const startedSource: RunStatusLifecycleEvent = {
    actor_id: null,
    data: { source: { id: "source-connector", kind: "connector" } },
    event_type: "run.started",
    occurred_at: "s",
    trace_id: "t",
  };
  assert.equal(buildTerminalRunStatusBody("r", succeededTerminal, startedSource).connector_id, "source-connector");

  // no started -> falls back to the terminal event's connector id.
  const terminalWithActor: RunStatusTerminalEvent = { ...succeededTerminal, actor_id: "terminal-connector" };
  assert.equal(buildTerminalRunStatusBody("r", terminalWithActor, null).connector_id, "terminal-connector");
});

test("buildTerminalRunStatusBody: terminal_reason reads data.reason, then data.failure_reason", () => {
  const withReason: RunStatusTerminalEvent = {
    ...succeededTerminal,
    data: { reason: "primary_reason" },
    status: "failed",
  };
  assert.equal(buildTerminalRunStatusBody("r", withReason, null).terminal_reason, "primary_reason");

  const withFailureReason: RunStatusTerminalEvent = {
    ...succeededTerminal,
    data: { failure_reason: "fallback_reason" },
    status: "failed",
  };
  assert.equal(buildTerminalRunStatusBody("r", withFailureReason, null).terminal_reason, "fallback_reason");

  // reason takes precedence over failure_reason.
  const withBoth: RunStatusTerminalEvent = {
    ...succeededTerminal,
    data: { failure_reason: "lose", reason: "win" },
    status: "failed",
  };
  assert.equal(buildTerminalRunStatusBody("r", withBoth, null).terminal_reason, "win");

  // neither -> null.
  assert.equal(buildTerminalRunStatusBody("r", succeededTerminal, null).terminal_reason, null);
});
