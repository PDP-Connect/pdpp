// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ControllerOptions } from "../runtime/controller.ts";
import { __resetControllerInteractionStateForTests, createController } from "../runtime/controller.ts";
import type { RuntimeRunConnectorOptions } from "../runtime/index.ts";
import { reconcileDirtyConnectorSummaryEvidence } from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../server/owner-auth.ts";
import { getSyncState, putSyncState } from "../server/records.ts";
import { makeDefaultAccountConnectorInstanceId } from "../server/stores/connector-instance-store.ts";

/** Asserts index i exists and returns it typed — avoids noUncheckedIndexedAccess churn on calls[i] throughout this file. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  assert.ok(item, `expected an element at index ${index}`);
  return item;
}

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
  runtime_requirements: { bindings: { browser: { required: true } } },
  streams: [],
  version: "1.0.0",
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

function freshDb(t: TestContext) {
  closeDb();
  initDb(join(mkdtempSync(join(tmpdir(), "pdpp-run-now-state-ns-")), "pdpp.sqlite"));
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });
}

interface PendingDetailGapRowFixture {
  readonly attempt_count?: number | null;
  readonly connector_id?: string | null;
  readonly connector_instance_id?: string | null;
  readonly last_error?: { readonly class?: unknown } | null;
  readonly next_attempt_after?: string | null;
  readonly reason?: string | null;
  readonly status?: string | null;
  readonly stream?: string | null;
  readonly updated_at?: string | null;
}

interface DetailGapReadStoreFixture {
  listPendingGapsForConnector: (connectorId: string) => readonly PendingDetailGapRowFixture[];
  listPendingGapsForConnectorInstance?: (
    connectorId: string,
    connectorInstanceId: string
  ) => readonly PendingDetailGapRowFixture[];
}

interface MakeControllerOverrides {
  detailGapStore?: DetailGapReadStoreFixture;
  runConnectorImpl?: ControllerOptions["runConnectorImpl"];
}

// A minimal, production-shaped admission fixture: echoes back whatever
// connectorInstanceId the caller requested (each test in this file always
// passes an explicit one), falling back to a deterministic default-account id
// only when none is given — the same authority shape `admitOwnerRunConnection`
// enforces in production, without a real store.
function fakeAdmitRunConnection(): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return ({ connectorId, connectorInstanceId, ownerSubjectId: requestedOwnerSubjectId }) => {
    const ownerSubjectId = requestedOwnerSubjectId || "owner_local";
    const exactId = connectorInstanceId ?? `cin_${ownerSubjectId}_${connectorId.replace(/[^a-z0-9]+/gi, "_")}`;
    return Promise.resolve({ connectorId, connectorInstanceId: exactId, ownerSubjectId });
  };
}

function makeController(calls: RuntimeRunConnectorOptions[], overrides: MakeControllerOverrides = {}) {
  // No browserSurfaceLeaseManager: amazon runs without acquiring a managed
  // surface, so the stubbed runConnectorImpl is reached directly.
  return createController({
    admitRunConnection: fakeAdmitRunConnection(),
    connectorPathResolver: () => "/tmp/connector.ts",
    ...(overrides.detailGapStore ? { detailGapStore: overrides.detailGapStore } : {}),
    logger: { error: () => undefined, warn: () => undefined },
    ownerSubjectId: "owner_1",
    runConnectorImpl:
      overrides.runConnectorImpl ||
      ((opts) => {
        calls.push(opts);
        return Promise.resolve({ records_emitted: 0, status: "succeeded" });
      }),
  });
}

async function drainUntilIdle(controller: ReturnType<typeof createController>, limit = 5) {
  for await (const _ of Array.from({ length: limit })) {
    const summary = await controller.drainActiveRuns(1000);
    if (summary.drained === 0 && summary.timedOut === 0) {
      return;
    }
  }
  throw new Error("controller did not become idle");
}

function pendingRecoveryGap(overrides: Partial<PendingDetailGapRowFixture> = {}): PendingDetailGapRowFixture {
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

function detailGapStoreForContinuation(
  rowsByCall: readonly (readonly PendingDetailGapRowFixture[])[]
): DetailGapReadStoreFixture {
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

// Recovery-first work selection (`resolveEffectiveRecoveryOnly`, controller.ts)
// now also consults the connection's own forward-evidence-debt bound
// (fix-pre-provenance-terminal-generation-semantics), which reads a real
// `connector_summary_evidence` row. A `pendingRecoveryGap()` fixture implies a
// real prior run against a real registered connection (gaps are only ever
// written by an actual run), so seed the minimal `connectors` /
// `connector_instances` row plus a CURRENT, fresh `connector_summary_evidence`
// row for `cin_recovery` — the realistic state such a connection would be in,
// distinct from the "aged/historical evidence" case the debt bound exists to
// bound (covered separately by the dispatch-governor and recovery-decision
// suites).
async function seedCurrentRecoveryConnection() {
  const now = new Date().toISOString();
  getDb()
    .prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(AMAZON, JSON.stringify(AMAZON_MANIFEST), now);
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES ('cin_recovery', 'owner_1', ?, 'x', 'active', 'account', 'cin_recovery', '{}', ?, ?, NULL)`
    )
    .run(AMAZON, now, now);
  // A genuinely fresh, real forward-evidence fact map — not a fabricated
  // `connector_summary_evidence` row. The fold's own bootstrap/reconcile
  // logic wipes any fact map with no backing `spine_events` row, so a real
  // terminal event must be seeded and folded through the actual pipeline.
  // The forward-evidence-debt predicate (fix-pre-provenance-terminal-
  // generation-semantics, P1-A) reads the newest per-stream `evidence_as_of`
  // from `stream_latest_facts`, so a "current, recently-collected" fixture
  // must actually carry one via a real fold, or it reads as debt (empty fact
  // map -> debt=true) and these recovery-first tests would incorrectly
  // divert to forward mode.
  getDb()
    .prepare(
      `INSERT INTO spine_events(
         event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
         actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, manifest_generation, data_json, version
       ) VALUES ('evt_seed_current_recovery', (SELECT COALESCE(MAX(event_seq),0)+1 FROM spine_events), 'run.completed', ?, ?, 'test', 'trace_seed_current_recovery', 'runtime', 'test-connector', 'run', 'run_seed_current_recovery', 'succeeded', 'run_seed_current_recovery', 'cin_recovery', 0, ?, '1')`
    )
    .run(
      now,
      now,
      JSON.stringify({
        collection_facts: {
          reference_only: true,
          schema_version: 1,
          streams: [{ checkpoint: "committed", collected: 1, considered: 1, stream: "order_items" }],
        },
        connection_id: "cin_recovery",
        connector_instance_id: "cin_recovery",
      })
    );
  await reconcileDirtyConnectorSummaryEvidence(["cin_recovery"]);
}

test("explicit connection state is handed to the connector run and yields incremental mode", async (t) => {
  freshDb(t);

  // Seed durable state under the explicit connection namespace (object target),
  // exactly as the state HTTP route / scheduler writes it.
  await putSyncState({ connector_id: AMAZON, connector_instance_id: "cin_explicit" }, SEEDED_ORDERS_STATE);

  const calls: RuntimeRunConnectorOptions[] = [];
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
  assert.deepEqual(at(calls, 0).state, SEEDED_ORDERS_STATE);
  // ...so a non-empty same-connection state defaults to incremental, not the
  // accidental full_refresh that re-planned every year 2005..2026.
  assert.equal(at(calls, 0).collectionMode, "incremental");
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

  const calls: RuntimeRunConnectorOptions[] = [];
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
  assert.equal(at(calls, 0).state, null);
  assert.equal(at(calls, 0).collectionMode, "full_refresh");
});

test("two connections of the same connector derive mode from their own state", async (t) => {
  freshDb(t);

  // Connection A has durable state; connection B has none.
  await putSyncState({ connector_id: AMAZON, connector_instance_id: "cin_a" }, SEEDED_ORDERS_STATE);

  const calls: RuntimeRunConnectorOptions[] = [];
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
  const callA = byInstance.get("cin_a");
  const callB = byInstance.get("cin_b");
  assert.ok(callA);
  assert.ok(callB);
  assert.equal(callA.collectionMode, "incremental");
  assert.deepEqual(callA.state, SEEDED_ORDERS_STATE);
  assert.equal(callB.collectionMode, "full_refresh");
  assert.equal(callB.state, null);
});

test("runNow forwards stream resources as runtime scope", async (t) => {
  freshDb(t);

  const calls: RuntimeRunConnectorOptions[] = [];
  const controller = makeController(calls);
  await controller.runNow("slack", {
    connectorInstanceId: "cin_slack",
    manifest: {
      connector_id: "slack",
      name: "Slack",
      streams: [{ name: "messages" }],
      version: "1.0.0",
    },
    ownerToken: "owner-token",
    resources: { messages: ["C07JYF0U8BY"] },
    runId: "run_slack_backfill",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(calls.length, 1);
  assert.deepEqual(at(calls, 0).scope, {
    streams: [{ name: "messages", resources: ["C07JYF0U8BY"] }],
  });
});

test("runNow forwards recoveryOnly to the runtime", async (t) => {
  freshDb(t);

  const calls: RuntimeRunConnectorOptions[] = [];
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
  assert.equal(at(calls, 0).recoveryOnly, true);
});

test("runNow continues eligible recovery after a successful progress batch", async (t) => {
  freshDb(t);
  await seedCurrentRecoveryConnection();

  const calls: RuntimeRunConnectorOptions[] = [];
  const controller = makeController(calls, {
    // Recovery-first now reads pending gaps TWICE per runNow call: once as the
    // pre-run recovery-first work-selection check, once as the post-run
    // continuation check. Root call: pre-check sees the pending gap (so it
    // launches recoveryOnly itself), post-run-check sees it recovered (empty).
    // Continuation call (explicit recoveryOnly:true) skips its own pre-check
    // probe entirely; its post-run-check also sees empty.
    detailGapStore: detailGapStoreForContinuation([[pendingRecoveryGap()], [pendingRecoveryGap()], []]),
    runConnectorImpl: (opts) => {
      calls.push(opts);
      if (calls.length === 1) {
        return Promise.resolve({
          detail_gaps: [{ gap_id: "gap_recovered", status: "recovered", stream: "order_items" }],
          records_emitted: 1,
          status: "succeeded",
        });
      }
      return Promise.resolve({ detail_gaps: [], records_emitted: 0, status: "succeeded" });
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
  // THE FIX: an eligible pending recovery gap already existed at root-call
  // time, so recovery-first work selection makes the ROOT call itself
  // recoveryOnly — not just the after-the-fact continuation.
  assert.equal(at(calls, 0).recoveryOnly, true);
  assert.equal(at(calls, 1).connectorInstanceId, "cin_recovery");
  assert.equal(at(calls, 1).recoveryOnly, true);
  assert.equal(at(calls, 1).triggerKind, "manual");
});

test("runNow continues eligible recovery after a terminalized poison item", async (t) => {
  freshDb(t);
  await seedCurrentRecoveryConnection();

  const calls: RuntimeRunConnectorOptions[] = [];
  const controller = makeController(calls, {
    detailGapStore: detailGapStoreForContinuation([[pendingRecoveryGap()], [pendingRecoveryGap()], []]),
    runConnectorImpl: (opts) => {
      calls.push(opts);
      if (calls.length === 1) {
        return Promise.resolve({
          detail_gaps: [
            { gap_id: "gap_quarantined", reason: "quarantined", status: "terminal", stream: "order_items" },
          ],
          records_emitted: 0,
          status: "succeeded",
        });
      }
      return Promise.resolve({ detail_gaps: [], records_emitted: 0, status: "succeeded" });
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
  assert.equal(at(calls, 0).recoveryOnly, true);
  assert.equal(at(calls, 1).connectorInstanceId, "cin_recovery");
  assert.equal(at(calls, 1).recoveryOnly, true);
  assert.equal(at(calls, 1).triggerKind, "manual");
});

test("runNow continues eligible recovery after terminal known-gap progress", async (t) => {
  freshDb(t);
  await seedCurrentRecoveryConnection();

  const calls: RuntimeRunConnectorOptions[] = [];
  const controller = makeController(calls, {
    detailGapStore: detailGapStoreForContinuation([[pendingRecoveryGap()], [pendingRecoveryGap()], []]),
    runConnectorImpl: (opts) => {
      calls.push(opts);
      if (calls.length === 1) {
        return Promise.resolve({
          detail_gaps: [],
          known_gaps: [
            {
              kind: "detail_gap",
              reason: "quarantined",
              recovery_hint: { action: "not_retriable", retryable: false },
              stream: "order_items",
            },
          ],
          records_emitted: 0,
          status: "succeeded",
        });
      }
      return Promise.resolve({ detail_gaps: [], records_emitted: 0, status: "succeeded" });
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
  assert.equal(at(calls, 0).recoveryOnly, true);
  assert.equal(at(calls, 1).connectorInstanceId, "cin_recovery");
  assert.equal(at(calls, 1).recoveryOnly, true);
  assert.equal(at(calls, 1).triggerKind, "manual");
});

test("runNow does not continue recovery when no detail gap made durable progress", async (t) => {
  freshDb(t);

  const calls: RuntimeRunConnectorOptions[] = [];
  const controller = makeController(calls, {
    detailGapStore: detailGapStoreForContinuation([[pendingRecoveryGap()]]),
    runConnectorImpl: (opts) => {
      calls.push(opts);
      return Promise.resolve({
        detail_gaps: [{ gap_id: "gap_still_pending", status: "pending", stream: "order_items" }],
        records_emitted: 0,
        status: "succeeded",
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

  const calls: RuntimeRunConnectorOptions[] = [];
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
        detail_gaps: [{ gap_id: "gap_recovered", status: "recovered", stream: "order_items" }],
        records_emitted: 1,
        status: "succeeded",
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

// ─── Recovery-first work selection for manual runNow (boundary correction) ──
//
// The scheduler dispatch-governor's recovery-first fix only covers SCHEDULED
// dispatch. The two definitive live reproductions of the Gmail 10,264-gap
// stall were OWNER MANUAL runNow calls (Sync now / owner-agent run routes),
// which all converge on this same `runNow` and, before this fix, never
// consulted existing recovery work before defaulting `recoveryOnly` to
// `false` — a due manual run always claimed a fresh forward-walk page even
// with a huge eligible non-pressure backlog sitting untouched. These cases
// prove `runNow` now shares the same recovery-first selection
// (`resolveRecoveryFirstMode` in recovery-decision.ts) as the scheduler, but
// ONLY for an implicit, unscoped run.
//
// Two things do NOT disable recovery-first and must never be conflated with
// an explicit work-mode choice:
//   - `force: true` has one established, narrow meaning — bypass the
//     provider-pressure cooldown gate (`assertNotSourcePressureCoolingOff`).
//     It says nothing about work mode. A forced run with no other explicit
//     intent still prefers eligible recovery work exactly like an unforced
//     one.
//   - Explicit `recoveryOnly` (either value) and explicit `resources`
//     (scoped-stream targeting, e.g. a Slack channel backfill) both express
//     genuine caller work intent and are never silently coerced.
//
// `detailGapStoreForContinuation` with a single-entry array acts as a fixed
// store: every read (this selection's pre-check, and any post-run
// continuation check) sees the same rows, since
// `Math.min(instanceReadCount, rowsByCall.length - 1)` clamps to index 0.

test("manual runNow with no explicit recoveryOnly and an eligible non-pressure gap backlog launches recoveryOnly", async (t) => {
  freshDb(t);
  await seedCurrentRecoveryConnection();

  const calls: RuntimeRunConnectorOptions[] = [];
  const controller = makeController(calls, {
    detailGapStore: detailGapStoreForContinuation([[pendingRecoveryGap()]]),
  });

  await controller.runNow(AMAZON, {
    connectorInstanceId: "cin_recovery",
    manifest: AMAZON_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_manual_default_with_gaps",
  });
  await drainUntilIdle(controller);

  assert.equal(calls.length, 1);
  assert.equal(
    at(calls, 0).recoveryOnly,
    true,
    "an ordinary owner-triggered manual run (no explicit recoveryOnly, no force) must prefer existing eligible " +
      "recovery work over a fresh forward-walk pass — the live Gmail 10,264-gap stall reproduction"
  );
});

test("manual runNow with no explicit recoveryOnly and zero eligible gaps runs normal forward collection", async (t) => {
  freshDb(t);

  const calls: RuntimeRunConnectorOptions[] = [];
  const controller = makeController(calls, {
    detailGapStore: detailGapStoreForContinuation([[]]),
  });

  await controller.runNow(AMAZON, {
    connectorInstanceId: "cin_recovery",
    manifest: AMAZON_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_manual_default_no_gaps",
  });
  await drainUntilIdle(controller);

  assert.equal(calls.length, 1);
  assert.equal(
    at(calls, 0).recoveryOnly,
    false,
    "no recovery backlog -> ordinary forward collection, not recovery-only"
  );
});

test("explicit recoveryOnly:false from the caller is never overridden by recovery-first", async (t) => {
  freshDb(t);

  const calls: RuntimeRunConnectorOptions[] = [];
  const controller = makeController(calls, {
    detailGapStore: detailGapStoreForContinuation([[pendingRecoveryGap()]]),
  });

  await controller.runNow(AMAZON, {
    connectorInstanceId: "cin_recovery",
    manifest: AMAZON_MANIFEST,
    ownerToken: "owner-token",
    recoveryOnly: false,
    runId: "run_manual_explicit_false",
  });
  await drainUntilIdle(controller);

  assert.equal(calls.length, 1);
  assert.equal(
    at(calls, 0).recoveryOnly,
    false,
    "an explicit caller choice (even false) is a deliberate override and must win over the recovery-first default"
  );
});

test("force:true still selects eligible non-pressure recovery by default (force only bypasses the pressure cooldown gate)", async (t) => {
  freshDb(t);
  await seedCurrentRecoveryConnection();

  const calls: RuntimeRunConnectorOptions[] = [];
  const controller = makeController(calls, {
    detailGapStore: detailGapStoreForContinuation([[pendingRecoveryGap()]]),
  });

  await controller.runNow(AMAZON, {
    connectorInstanceId: "cin_recovery",
    force: true,
    manifest: AMAZON_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_manual_force",
  });
  await drainUntilIdle(controller);

  assert.equal(calls.length, 1);
  assert.equal(
    at(calls, 0).recoveryOnly,
    true,
    "force:true has no work-mode meaning — it only bypasses the provider-pressure cooldown gate, so an implicit " +
      "unscoped forced run still prefers eligible recovery work exactly like an unforced one"
  );
});

test("force:true with zero eligible gaps runs normal forward collection", async (t) => {
  freshDb(t);

  const calls: RuntimeRunConnectorOptions[] = [];
  const controller = makeController(calls, {
    detailGapStore: detailGapStoreForContinuation([[]]),
  });

  await controller.runNow(AMAZON, {
    connectorInstanceId: "cin_recovery",
    force: true,
    manifest: AMAZON_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_manual_force_no_gaps",
  });
  await drainUntilIdle(controller);

  assert.equal(calls.length, 1);
  assert.equal(at(calls, 0).recoveryOnly, false, "no recovery backlog -> ordinary forward collection under force too");
});

test("explicit resources/scoped streams preserve forward mode despite an eligible gap backlog", async (t) => {
  freshDb(t);

  const calls: RuntimeRunConnectorOptions[] = [];
  const probeCalls: unknown[][] = [];
  const controller = makeController(calls, {
    detailGapStore: {
      listPendingGapsForConnector: () => [],
      listPendingGapsForConnectorInstance: (...args) => {
        probeCalls.push(args);
        return [pendingRecoveryGap()];
      },
    },
  });

  await controller.runNow(AMAZON, {
    connectorInstanceId: "cin_recovery",
    manifest: AMAZON_MANIFEST,
    ownerToken: "owner-token",
    resources: { order_items: ["ORDER-123"] },
    runId: "run_manual_scoped_resources",
  });
  await drainUntilIdle(controller);

  assert.equal(calls.length, 1);
  assert.equal(
    at(calls, 0).recoveryOnly,
    false,
    "an explicit resources/scoped-stream request expresses caller work intent and must not be silently " +
      "converted to recovery-only, even with an eligible recovery backlog"
  );
  assert.deepEqual(at(calls, 0).scope, { streams: [{ name: "order_items", resources: ["ORDER-123"] }] });
  assert.equal(
    probeCalls.length,
    0,
    "a scoped request should short-circuit the recovery-first probe entirely (no unnecessary durable read)"
  );
});

test("explicit resources/scoped streams combined with recoveryOnly:true still honor the explicit recoveryOnly", async (t) => {
  freshDb(t);

  const calls: RuntimeRunConnectorOptions[] = [];
  const controller = makeController(calls, {
    detailGapStore: detailGapStoreForContinuation([[]]),
  });

  await controller.runNow(AMAZON, {
    connectorInstanceId: "cin_recovery",
    manifest: AMAZON_MANIFEST,
    ownerToken: "owner-token",
    recoveryOnly: true,
    resources: { order_items: ["ORDER-123"] },
    runId: "run_manual_scoped_recovery_only",
  });
  await drainUntilIdle(controller);

  assert.equal(calls.length, 1);
  assert.equal(
    at(calls, 0).recoveryOnly,
    true,
    "an explicit recoveryOnly choice takes precedence over scoping, per the documented precedence order"
  );
});
