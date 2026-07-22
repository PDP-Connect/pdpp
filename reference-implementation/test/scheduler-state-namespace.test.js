// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closeDb, initDb } from "../server/db.js";
import { getSyncState, putSyncState } from "../server/records.js";
import { makeDefaultAccountConnectorInstanceId } from "../server/stores/connector-instance-store.js";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../server/owner-auth.ts";

// Companion to controller-run-now-state-namespace.test.js for the scheduler half
// of the same state-handoff bug.
//
// The reference scheduler manager's `getState` / `setState` closures live inline
// inside `createReferenceSchedulerManager` (server/index.js) and are only wired
// up by a full `startServer()` boot — there is no exported seam that hands back
// those two closures, and the runtime `createScheduler` (exercised by
// scheduler.test.js) takes caller-supplied `getState`/`setState` stubs rather
// than the production ones. So the closures themselves cannot be unit-tested in
// this tranche without standing up the server (which the task forbids: no deploy,
// no touching the live Amazon run).
//
// What the fix actually changed in those closures is the storage TARGET they
// hand to `getSyncState` / `putSyncState`:
//
//   before:  getSyncState(connectorId, { connectorInstanceId })   // option ignored
//   after:   getSyncState(storageTargetForConnectorNamespace({ connectorId, connectorInstanceId }))
//
// where `storageTargetForConnectorNamespace` is the pure mapping
//   ({ connectorId, connectorInstanceId }) => ({ connector_id, connector_instance_id })
//
// This suite pins the load-bearing behavior of that exact target shape against
// the REAL state helpers: a write under the connection-instance target is read
// back under that same target, and is invisible to the default-account
// namespace (and vice-versa). This is precisely the isolation the scheduler now
// relies on; the only untested glue is the trivial positional→object mapping the
// closure performs, which mirrors `storageTargetForConnectorNamespace` verbatim.

const CONNECTOR = "amazon";

// Mirrors the scheduler's positional-arg → object-target transformation. The
// production helper (`storageTargetForConnectorNamespace`, module-private to
// index.js) is the same three-line mapping; replicated here because index.js
// exposes no import seam for it.
function schedulerStorageTarget(connectorId, connectorInstanceId) {
  return { connector_id: connectorId, connector_instance_id: connectorInstanceId };
}

function freshDb(t) {
  closeDb();
  initDb(join(mkdtempSync(join(tmpdir(), "pdpp-scheduler-state-ns-")), "pdpp.sqlite"));
  t.after(() => closeDb());
}

test("scheduler get/set storage target round-trips state under the connection namespace", async (t) => {
  freshDb(t);
  const state = { messages: { cursor: "from-scheduler" } };

  // setState path: write under the connection-instance target.
  await putSyncState(schedulerStorageTarget(CONNECTOR, "cin_sched"), state);

  // getState path: read back under the same target.
  const projection = await getSyncState(schedulerStorageTarget(CONNECTOR, "cin_sched"));
  assert.deepEqual(projection.state, state);
  assert.equal(projection.connector_instance_id, "cin_sched");
});

test("scheduler connection-namespace state is isolated from the default account namespace", async (t) => {
  freshDb(t);

  // A scheduled write for an explicit connection...
  await putSyncState(schedulerStorageTarget(CONNECTOR, "cin_sched"), {
    messages: { cursor: "connection" },
  });
  // ...and a default-account write (bare connectorId string) for the same
  // connector are two distinct namespaces.
  await putSyncState(CONNECTOR, { messages: { cursor: "default" } });

  const defaultId = makeDefaultAccountConnectorInstanceId(OWNER_AUTH_DEFAULT_SUBJECT_ID, CONNECTOR);
  assert.notEqual(defaultId, "cin_sched");

  const connectionProjection = await getSyncState(schedulerStorageTarget(CONNECTOR, "cin_sched"));
  const defaultProjection = await getSyncState(schedulerStorageTarget(CONNECTOR, defaultId));

  assert.deepEqual(connectionProjection.state, { messages: { cursor: "connection" } });
  assert.deepEqual(defaultProjection.state, { messages: { cursor: "default" } });
  // The connection's scheduled state did not leak into the default namespace.
  assert.notDeepEqual(connectionProjection.state, defaultProjection.state);
});
