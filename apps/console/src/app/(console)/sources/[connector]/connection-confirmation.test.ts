// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectionConfirmation } from "./connection-confirmation.tsx";

const BOUNDARY_GAP = {
  boundary_claim: "provider_history_boundary",
  earliest_available: "2021-04-03",
  note: "Provider export says this is the oldest available message.",
  reason_code: "provider_retention_policy",
  stream: "messages",
};

const LOSS_GAP = {
  recovery_hint: { action: "not_retriable" },
  stream: "orders",
};

const HORIZONS = [
  {
    basis: "provider_stated",
    confirmedAt: "2026-08-20T00:00:00.000Z",
    confirmedBy: "Tim",
    connectorInstanceId: "connection-1",
    earliestAvailable: "2021-04-03",
    horizonId: "horizon-current",
    note: "The original export set the boundary.",
    reason: "provider_retention_policy",
    stream: "messages",
    supersededAt: null,
    supersededByHorizonId: null,
  },
  {
    basis: "provider_confirmed",
    confirmedAt: "2026-08-19T00:00:00.000Z",
    confirmedBy: "Tim",
    connectorInstanceId: "connection-1",
    earliestAvailable: "2020-01-01",
    horizonId: "horizon-old",
    note: "Replaced after a newer export.",
    reason: "provider_deleted_history",
    stream: "messages",
    supersededAt: "2026-08-20T00:00:00.000Z",
    supersededByHorizonId: "horizon-current",
  },
] as const;

function renderConfirmation(props: Parameters<typeof ConnectionConfirmation>[0]): string {
  return renderToStaticMarkup(createElement(ConnectionConfirmation, props));
}

const ACTIONS = {
  acknowledgeConnectionLossAction: () => Promise.resolve(),
  confirmCoverageHorizonAction: () => Promise.resolve(),
};

test("the source detail surface renders both durable confirmation journeys", () => {
  const html = renderConfirmation({
    ...ACTIONS,
    acknowledgedLoss: null,
    connectionId: "connection-1",
    latestKnownGaps: [BOUNDARY_GAP, { ...BOUNDARY_GAP, stream: "events" }, LOSS_GAP],
    pendingHorizons: HORIZONS,
  });

  for (const value of [
    'id="coverage-confirmation"',
    'name="earliest_available"',
    'name="note"',
    'name="acknowledged_by"',
    'value="provider_access_withdrawn"',
    'value="provider_data_contradictory"',
    'value="provider_deleted_upstream"',
    'value="inferred_from_stable_boundary"',
    'value="provider_confirmed"',
    'value="provider_stated"',
    'value="consent_window"',
    'value="provider_deleted_history"',
    'value="provider_never_had_data"',
    'value="provider_retention_policy"',
    "The original export set the boundary.",
    "Replaced after a newer export.",
    "Superseded",
  ]) {
    assert.equal(html.includes(value), true, `rendered confirmation is missing ${value}`);
  }
  assert.equal(
    ["healthy", "green", "recovered", "restored"].some((word) => html.toLowerCase().includes(word)),
    false
  );
});

test("missing evidence and missing connection are not actionable", () => {
  assert.equal(
    renderConfirmation({
      ...ACTIONS,
      acknowledgedLoss: null,
      connectionId: "connection-1",
      latestKnownGaps: [],
      pendingHorizons: [],
    }),
    ""
  );
  assert.equal(
    renderConfirmation({
      ...ACTIONS,
      acknowledgedLoss: null,
      connectionId: null,
      latestKnownGaps: [BOUNDARY_GAP],
      pendingHorizons: [],
    }),
    ""
  );
});

test("the owner sees the full structured acknowledgement record", () => {
  const html = renderConfirmation({
    ...ACTIONS,
    acknowledgedLoss: {
      acknowledgedAt: "2026-08-21T00:00:00.000Z",
      acknowledgedBy: "Tim",
      cause: "provider_data_contradictory",
      note: "Reviewed with the owner.",
      scope: "partial",
      streams: ["messages"],
    },
    connectionId: "connection-1",
    latestKnownGaps: [LOSS_GAP],
    pendingHorizons: [],
  });

  for (const value of [
    "provider_data_contradictory",
    "partial",
    "Tim",
    "2026-08-21T00:00:00.000Z",
    "Reviewed with the owner.",
    'name="acknowledged_by"',
  ]) {
    assert.equal(html.includes(value), true, `rendered record is missing ${value}`);
  }
});

test("a stream-scoped acknowledgement leaves other loss evidence pending", () => {
  const html = renderConfirmation({
    ...ACTIONS,
    acknowledgedLoss: {
      acknowledgedAt: "2026-08-21T00:00:00.000Z",
      acknowledgedBy: "Tim",
      cause: "provider_deleted_upstream",
      scope: "partial",
      streams: ["messages"],
    },
    connectionId: "connection-1",
    latestKnownGaps: [LOSS_GAP, { recovery_action: "not_retriable", stream: "messages" }],
    pendingHorizons: [],
  });

  assert.equal(html.includes('name="acknowledged_by"'), true);
  assert.equal(html.includes('name="stream" value="orders"'), true);
});
