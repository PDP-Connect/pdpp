import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closeDb, initDb } from "../server/db.js";
import {
  __resetControllerInteractionStateForTests,
  createController,
} from "../runtime/controller.ts";
import { getSyncState, putSyncState } from "../server/records.js";
import { makeDefaultAccountConnectorInstanceId } from "../server/stores/connector-instance-store.js";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../server/owner-auth.ts";

// Regression suite for the Amazon manual-Sync-Now full-refresh bug.
//
// A manual "Sync now" for connection `cin_…` started `collection_mode=full_refresh`
// even though that same connection already had durable Amazon `orders` state for
// 2005..2026. Root cause: `runNow` read prior state with
// `getSyncState(connectorId, { connectorInstanceId })`, but `getSyncState` keys
// storage off its *storage-target* (first) argument and ignores any
// `connectorInstanceId` option — so a bare `connectorId` string resolved to the
// default-account namespace, not the explicit connection. The controller saw an
// empty state and derived full_refresh.
//
// The fix makes connection-instance state a property of construction: `runNow`
// passes an explicit `{ connector_id, connector_instance_id }` storage target.
// These tests prove the controller hands the connection's own state to the
// connector run and defaults to incremental, and that default-namespace state
// can no longer satisfy an explicit connection run.
//
// Harness mirrors static-secret-controller-run-injection.test.js: a real DB +
// real `getSyncState` (imported by the controller from records.js) + a stubbed
// `runConnectorImpl` that captures the opts the connector child would receive.
// `state` and `collectionMode` are passed verbatim into `runConnectorImpl`
// (controller.ts runConnectorImpl({ …, state, collectionMode })), so asserting
// on the captured call proves the exact value the connector would scrape from.

const AMAZON = "amazon";
const AMAZON_MANIFEST = {
  connector_id: AMAZON,
  name: "Amazon",
  version: "1.0.0",
  runtime_requirements: { bindings: { browser: { required: true } } },
  streams: [],
};

// Mirrors the durable owner-scoped Amazon state observed in the incident:
// stream-keyed `orders.years` with historical years frozen.
const SEEDED_ORDERS_STATE = {
  orders: {
    years: {
      2025: { frozen: true, last_scraped: "2026-04-01T00:00:00.000Z" },
      2026: { frozen: false, last_scraped: "2026-05-01T00:00:00.000Z" },
    },
  },
};

function freshDb(t) {
  closeDb();
  initDb(join(mkdtempSync(join(tmpdir(), "pdpp-run-now-state-ns-")), "pdpp.sqlite"));
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });
}

function makeController(calls, overrides = {}) {
  // No browserSurfaceLeaseManager: amazon runs without acquiring a managed
  // surface, so the stubbed runConnectorImpl is reached directly.
  return createController({
    connectorPathResolver: () => "/tmp/connector.ts",
    detailGapStore: overrides.detailGapStore,
    logger: { error: () => {}, warn: () => {} },
    ownerSubjectId: "owner_1",
    runConnectorImpl:
      overrides.runConnectorImpl ||
      ((opts) => {
        calls.push(opts);
        return Promise.resolve({ status: "succeeded", records_emitted: 0 });
      }),
  });
}

async function drainUntilIdle(controller, limit = 5) {
  for (let i = 0; i < limit; i += 1) {
    const summary = await controller.drainActiveRuns(1000);
    if (summary.drained === 0 && summary.timedOut === 0) {
      return;
    }
  }
  throw new Error("controller did not become idle");
}

function pendingRecoveryGap(overrides = {}) {
  return {
    attempt_count: 1,
    connector_id: AMAZON,
    connector_instance_id: "cin_recovery",
    last_error: { class: "run_cap_deferred" },
    next_attempt_after: null,
    reason: "retry_exhausted",
    status: "pending",
    stream: "order_items",
    updated_at: "2026-07-07T21:00:00.000Z",
    ...overrides,
  };
}

function detailGapStoreForContinuation(rowsByCall) {
  let instanceReadCount = 0;
  return {
    listPendingGapsForConnector: () => [],
    listPendingGapsForConnectorInstance: () => {
      const rows = rowsByCall[Math.min(instanceReadCount, rowsByCall.length - 1)] || [];
      instanceReadCount += 1;
      return rows;
    },
  };
}

test("explicit connection state is handed to the connector run and yields incremental mode", async (t) => {
  freshDb(t);

  // Seed durable state under the explicit connection namespace (object target),
  // exactly as the state HTTP route / scheduler writes it.
  await putSyncState(
    { connector_id: AMAZON, connector_instance_id: "cin_explicit" },
    SEEDED_ORDERS_STATE,
  );

  const calls = [];
  const controller = makeController(calls);
  await controller.runNow(AMAZON, {
    connectorInstanceId: "cin_explicit",
    manifest: AMAZON_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_explicit",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(calls.length, 1);
  // The connector child is handed the connection's OWN durable state...
  assert.deepEqual(calls[0].state, SEEDED_ORDERS_STATE);
  // ...so a non-empty same-connection state defaults to incremental, not the
  // accidental full_refresh that re-planned every year 2005..2026.
  assert.equal(calls[0].collectionMode, "incremental");
});

test("default-namespace state does NOT satisfy an explicit connection run", async (t) => {
  freshDb(t);

  // Seed state ONLY in the default-account namespace (bare connectorId string →
  // makeDefaultAccountConnectorInstanceId(OWNER_AUTH_DEFAULT_SUBJECT_ID, …)).
  await putSyncState(AMAZON, SEEDED_ORDERS_STATE);

  // Sanity: the seed really landed in the default namespace, and the explicit
  // connection namespace is genuinely empty. (Guards against the seed silently
  // writing to the connection namespace and making the assertion vacuous.)
  const defaultId = makeDefaultAccountConnectorInstanceId(OWNER_AUTH_DEFAULT_SUBJECT_ID, AMAZON);
  const defaultProjection = await getSyncState({
    connector_id: AMAZON,
    connector_instance_id: defaultId,
  });
  assert.deepEqual(defaultProjection.state, SEEDED_ORDERS_STATE);
  const explicitProjection = await getSyncState({
    connector_id: AMAZON,
    connector_instance_id: "cin_explicit",
  });
  assert.deepEqual(explicitProjection.state, {});

  const calls = [];
  const controller = makeController(calls);
  await controller.runNow(AMAZON, {
    connectorInstanceId: "cin_explicit",
    manifest: AMAZON_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_explicit",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(calls.length, 1);
  // The explicit connection has no state of its own; default-namespace state is
  // a different namespace and must NOT leak in. With the pre-fix bug this run
  // read the (populated) default namespace and wrongly went incremental from
  // another connection's state; with the fix it correctly sees an empty
  // connection and reports full_refresh.
  assert.equal(calls[0].state, null);
  assert.equal(calls[0].collectionMode, "full_refresh");
});

test("two connections of the same connector derive mode from their own state", async (t) => {
  freshDb(t);

  // Connection A has durable state; connection B has none.
  await putSyncState(
    { connector_id: AMAZON, connector_instance_id: "cin_a" },
    SEEDED_ORDERS_STATE,
  );

  const calls = [];
  const controller = makeController(calls);
  await controller.runNow(AMAZON, {
    connectorInstanceId: "cin_a",
    manifest: AMAZON_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_a",
  });
  await controller.runNow(AMAZON, {
    connectorInstanceId: "cin_b",
    manifest: AMAZON_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_b",
  });
  await controller.drainActiveRuns(1000);

  const byInstance = new Map(calls.map((c) => [c.connectorInstanceId, c]));
  assert.equal(byInstance.get("cin_a").collectionMode, "incremental");
  assert.deepEqual(byInstance.get("cin_a").state, SEEDED_ORDERS_STATE);
  assert.equal(byInstance.get("cin_b").collectionMode, "full_refresh");
  assert.equal(byInstance.get("cin_b").state, null);
});

test("runNow forwards stream resources as runtime scope", async (t) => {
  freshDb(t);

  const calls = [];
  const controller = makeController(calls);
  await controller.runNow("slack", {
    connectorInstanceId: "cin_slack",
    manifest: {
      connector_id: "slack",
      name: "Slack",
      version: "1.0.0",
      streams: [{ name: "messages" }],
    },
    ownerToken: "owner-token",
    resources: { messages: ["C07JYF0U8BY"] },
    runId: "run_slack_backfill",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].scope, {
    streams: [{ name: "messages", resources: ["C07JYF0U8BY"] }],
  });
});

test("runNow forwards recoveryOnly to the runtime", async (t) => {
  freshDb(t);

  const calls = [];
  const controller = makeController(calls);
  await controller.runNow(AMAZON, {
    connectorInstanceId: "cin_recovery",
    manifest: AMAZON_MANIFEST,
    ownerToken: "owner-token",
    recoveryOnly: true,
    runId: "run_recovery_only",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].recoveryOnly, true);
});

test("runNow continues eligible recovery after a successful progress batch", async (t) => {
  freshDb(t);

  const calls = [];
  const controller = makeController(calls, {
    detailGapStore: detailGapStoreForContinuation([[pendingRecoveryGap()], []]),
    runConnectorImpl: (opts) => {
      calls.push(opts);
      if (calls.length === 1) {
        return Promise.resolve({
          status: "succeeded",
          records_emitted: 1,
          detail_gaps: [{ gap_id: "gap_recovered", status: "recovered", stream: "order_items" }],
        });
      }
      return Promise.resolve({ status: "succeeded", records_emitted: 0, detail_gaps: [] });
    },
  });

  await controller.runNow(AMAZON, {
    connectorInstanceId: "cin_recovery",
    manifest: AMAZON_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_root",
  });
  await drainUntilIdle(controller);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].recoveryOnly, false);
  assert.equal(calls[1].connectorInstanceId, "cin_recovery");
  assert.equal(calls[1].recoveryOnly, true);
  assert.equal(calls[1].triggerKind, "manual");
});

test("runNow continues eligible recovery after a terminalized poison item", async (t) => {
  freshDb(t);

  const calls = [];
  const controller = makeController(calls, {
    detailGapStore: detailGapStoreForContinuation([[pendingRecoveryGap()], []]),
    runConnectorImpl: (opts) => {
      calls.push(opts);
      if (calls.length === 1) {
        return Promise.resolve({
          status: "succeeded",
          records_emitted: 0,
          detail_gaps: [{ gap_id: "gap_quarantined", reason: "quarantined", status: "terminal", stream: "order_items" }],
        });
      }
      return Promise.resolve({ status: "succeeded", records_emitted: 0, detail_gaps: [] });
    },
  });

  await controller.runNow(AMAZON, {
    connectorInstanceId: "cin_recovery",
    manifest: AMAZON_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_terminal_progress",
  });
  await drainUntilIdle(controller);

  assert.equal(calls.length, 2);
  assert.equal(calls[1].connectorInstanceId, "cin_recovery");
  assert.equal(calls[1].recoveryOnly, true);
  assert.equal(calls[1].triggerKind, "manual");
});

test("runNow continues eligible recovery after terminal known-gap progress", async (t) => {
  freshDb(t);

  const calls = [];
  const controller = makeController(calls, {
    detailGapStore: detailGapStoreForContinuation([[pendingRecoveryGap()], []]),
    runConnectorImpl: (opts) => {
      calls.push(opts);
      if (calls.length === 1) {
        return Promise.resolve({
          status: "succeeded",
          records_emitted: 0,
          detail_gaps: [],
          known_gaps: [
            {
              kind: "detail_gap",
              reason: "quarantined",
              recovery_hint: { action: "not_retriable", retryable: false },
              stream: "order_items",
            },
          ],
        });
      }
      return Promise.resolve({ status: "succeeded", records_emitted: 0, detail_gaps: [] });
    },
  });

  await controller.runNow(AMAZON, {
    connectorInstanceId: "cin_recovery",
    manifest: AMAZON_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_terminal_known_gap_progress",
  });
  await drainUntilIdle(controller);

  assert.equal(calls.length, 2);
  assert.equal(calls[1].connectorInstanceId, "cin_recovery");
  assert.equal(calls[1].recoveryOnly, true);
  assert.equal(calls[1].triggerKind, "manual");
});

test("runNow does not continue recovery when no detail gap made durable progress", async (t) => {
  freshDb(t);

  const calls = [];
  const controller = makeController(calls, {
    detailGapStore: detailGapStoreForContinuation([[pendingRecoveryGap()]]),
    runConnectorImpl: (opts) => {
      calls.push(opts);
      return Promise.resolve({
        status: "succeeded",
        records_emitted: 0,
        detail_gaps: [{ gap_id: "gap_still_pending", status: "pending", stream: "order_items" }],
      });
    },
  });

  await controller.runNow(AMAZON, {
    connectorInstanceId: "cin_recovery",
    manifest: AMAZON_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_no_progress",
  });
  await drainUntilIdle(controller);

  assert.equal(calls.length, 1);
});

test("runNow does not continue recovery for owner-required pending work", async (t) => {
  freshDb(t);

  const calls = [];
  const controller = makeController(calls, {
    detailGapStore: detailGapStoreForContinuation([
      [
        pendingRecoveryGap({
          last_error: { class: "owner_required" },
          reason: "auth_failure",
        }),
      ],
    ]),
    runConnectorImpl: (opts) => {
      calls.push(opts);
      return Promise.resolve({
        status: "succeeded",
        records_emitted: 1,
        detail_gaps: [{ gap_id: "gap_recovered", status: "recovered", stream: "order_items" }],
      });
    },
  });

  await controller.runNow(AMAZON, {
    connectorInstanceId: "cin_recovery",
    manifest: AMAZON_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_owner_required",
  });
  await drainUntilIdle(controller);

  assert.equal(calls.length, 1);
});
