// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Owner-epoch adjudication across a container replacement — the oracle.
 *
 * The invariant under test, stated without reference to `controller_id`
 * (that field is the thing that broke, so the oracle must not depend on it):
 *
 *   For every `run.started` in the spine, either a terminal event exists for
 *   that run, or its `boot_epoch` equals the current process's boot epoch.
 *
 * Why this file exists rather than another case in
 * `boot-orphan-reconciliation.test.ts`: every test there passes an explicit
 * `controllerId`, so none of them ever exercises the real resolution path.
 * That is precisely how the production defect survived a test suite that
 * already covered boot-orphan reconciliation. `resolveControllerId` fell back
 * to `os.hostname()`, which under Docker is the container ID and is fresh on
 * every `docker run`, so the reconciler's ownership filter matched nothing
 * after any container replacement. 121 production runs from 106 distinct
 * controller ids were left permanently non-terminal between 2026-05 and
 * 2026-07.
 *
 * The load-bearing move here is therefore to simulate a NEW CONTAINER — a
 * different `os.hostname()` — and not merely a new process. A successor that
 * shares a hostname with its predecessor is the easy case, and it is the only
 * case the prior tests covered.
 */

import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: Biome resolver lacks this runtime-supported dependency export shape.
import Database from "better-sqlite3";
import { emitControllerBootedAndStashEpoch, reconcileOrphanedRunsAtBoot } from "../lib/controller-boot.ts";
import { clearCurrentBootEpoch } from "../lib/spine.ts";
import { closeDb, initDb } from "../server/db.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

/**
 * Run `fn` with `os.hostname()` reporting `name`, restoring the real
 * implementation afterwards. This is the container-replacement simulator:
 * a fresh container is, from the process's point of view, exactly a fresh
 * hostname over the same database volume.
 */
async function withHostname<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const original = os.hostname;
  (os as { hostname: () => string }).hostname = () => name;
  try {
    return await fn();
  } finally {
    (os as { hostname: () => string }).hostname = original;
  }
}

/** Seed a `run.started` owned by the given epoch/controller. */
function seedStartedRun(
  dbPath: string,
  {
    event_id,
    run_id,
    boot_epoch,
    controller_id,
  }: Record<"event_id" | "run_id" | "boot_epoch" | "controller_id", string>
): void {
  const raw = new Database(dbPath);
  try {
    const ts = "2026-05-10T12:00:00.000Z";
    raw
      .prepare(
        `INSERT INTO spine_events
           (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
            actor_type, actor_id, object_type, object_id, status, run_id, data_json, version)
         VALUES (?, 'run.started', ?, ?, 'default', 'trc_seed', 'runtime', 'conn_a', 'run', ?, 'started', ?, ?, 'v1')`
      )
      .run(event_id, ts, ts, run_id, run_id, JSON.stringify({ boot_epoch, controller_id, seq: 1 }));
  } finally {
    raw.close();
  }
}

/**
 * The invariant, evaluated against the real database: every `run.started`
 * either has a terminal event or belongs to the current boot epoch. Returns
 * the offending run ids, so a failure names the stranded runs.
 */
function runsViolatingInvariant(dbPath: string, currentBootEpoch: string): string[] {
  const raw = new Database(dbPath);
  try {
    return (
      raw
        .prepare(
          `SELECT s.run_id
             FROM spine_events s
            WHERE s.event_type = 'run.started'
              AND COALESCE(json_extract(s.data_json, '$.boot_epoch'), '') <> ?
              AND NOT EXISTS (
                SELECT 1 FROM spine_events t
                 WHERE t.run_id = s.run_id
                   AND t.event_type IN ('run.completed', 'run.failed',
                                        'run.browser_surface_failed',
                                        'run.cancelled', 'run.abandoned')
              )`
        )
        .all(currentBootEpoch) as { run_id: string }[]
    ).map((r) => r.run_id);
  } finally {
    raw.close();
  }
}

function readAbandonEvents(dbPath: string): { run_id: string; data: Record<string, unknown> }[] {
  const raw = new Database(dbPath);
  try {
    return (
      raw
        .prepare("SELECT run_id, data_json FROM spine_events WHERE event_type = 'run.abandoned' ORDER BY run_id")
        .all() as { run_id: string; data_json: string }[]
    ).map((r) => ({ data: JSON.parse(r.data_json) as Record<string, unknown>, run_id: r.run_id }));
  } finally {
    raw.close();
  }
}

test("a successor in a NEW container adjudicates the prior epoch's in-flight run", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-identity-");
  initDb(dbPath);
  try {
    // Boot 1: the original container. Its identity is resolved for real —
    // no explicit controllerId — so it seeds `controller_identity`.
    const first = await withHostname("container-aaaaaaaaaaaa", () =>
      emitControllerBootedAndStashEpoch({ bootEpoch: "boot-epoch-first" })
    );
    assert.equal(first.controller_id, "container-aaaaaaaaaaaa", "first boot seeds identity from the hostname");

    // That container starts a run, then dies without writing a terminal
    // event — exactly what SIGKILL after Docker's 10s grace produces.
    seedStartedRun(dbPath, {
      boot_epoch: first.boot_epoch,
      controller_id: first.controller_id,
      event_id: "evt_inflight",
      run_id: "run_inflight",
    });

    assert.deepEqual(
      runsViolatingInvariant(dbPath, first.boot_epoch),
      [],
      "the run belongs to the live epoch, so it is not yet a violation"
    );

    clearCurrentBootEpoch();

    // Boot 2: a REPLACEMENT container. Fresh hostname, same database volume.
    // This is the case that was broken in production.
    const second = await withHostname("container-bbbbbbbbbbbb", () =>
      emitControllerBootedAndStashEpoch({ bootEpoch: "boot-epoch-second" })
    );

    assert.equal(
      second.controller_id,
      first.controller_id,
      "identity must survive the container replacement, or the successor cannot claim the orphan"
    );
    assert.notEqual(second.boot_epoch, first.boot_epoch, "the epoch must still advance per boot");

    // Before adjudication the invariant is false — this is what makes it a
    // real oracle rather than a tautology.
    assert.deepEqual(
      runsViolatingInvariant(dbPath, second.boot_epoch),
      ["run_inflight"],
      "the prior epoch's run is stranded until the successor adjudicates it"
    );

    const result = await reconcileOrphanedRunsAtBoot(second);
    assert.equal(result.selected, 1);
    assert.equal(result.abandoned, 1);

    // The invariant now holds.
    assert.deepEqual(
      runsViolatingInvariant(dbPath, second.boot_epoch),
      [],
      "after adjudication every run.started is terminal or current-epoch"
    );

    // ...and it was adjudicated to the honest terminal state, by the
    // successor, naming the epoch that could no longer report on it.
    const abandons = readAbandonEvents(dbPath);
    assert.equal(abandons.length, 1);
    assert.equal(abandons[0]?.run_id, "run_inflight");
    assert.equal(abandons[0]?.data.reason, "controller_terminated_before_run_finished");
    assert.equal(abandons[0]?.data.original_boot_epoch, first.boot_epoch);
    assert.equal(abandons[0]?.data.reconciled_by_boot_epoch, second.boot_epoch);
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});

test("interruption is adjudicated as abandoned, never as a failure", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-identity-honest-");
  initDb(dbPath);
  try {
    const first = await withHostname("container-cccccccccccc", () =>
      emitControllerBootedAndStashEpoch({ bootEpoch: "boot-epoch-c1" })
    );
    seedStartedRun(dbPath, {
      boot_epoch: first.boot_epoch,
      controller_id: first.controller_id,
      event_id: "evt_honest",
      run_id: "run_honest",
    });
    clearCurrentBootEpoch();

    const second = await withHostname("container-dddddddddddd", () =>
      emitControllerBootedAndStashEpoch({ bootEpoch: "boot-epoch-c2" })
    );
    await reconcileOrphanedRunsAtBoot(second);

    const raw = new Database(dbPath);
    try {
      const failures = raw
        .prepare("SELECT count(*) AS n FROM spine_events WHERE event_type = 'run.failed' AND run_id = ?")
        .get("run_honest") as { n: number };
      assert.equal(failures.n, 0, "an interrupted run must not be recorded as a failure");

      const history = raw.prepare("SELECT status FROM run_history WHERE run_id = ?").all("run_honest") as {
        status: string;
      }[];
      for (const row of history) {
        assert.notEqual(row.status, "failed", "the projection must not claim failure either");
      }
    } finally {
      raw.close();
    }
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});

test("adjudication is idempotent across repeated successor boots", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-identity-idem-");
  initDb(dbPath);
  try {
    const first = await withHostname("container-eeeeeeeeeeee", () =>
      emitControllerBootedAndStashEpoch({ bootEpoch: "boot-epoch-e1" })
    );
    seedStartedRun(dbPath, {
      boot_epoch: first.boot_epoch,
      controller_id: first.controller_id,
      event_id: "evt_idem",
      run_id: "run_idem",
    });
    clearCurrentBootEpoch();

    for (const [hostname, epoch] of [
      ["container-ffffffffffff", "boot-epoch-e2"],
      ["container-gggggggggggg", "boot-epoch-e3"],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: Successive boots are the subject under test; each must observe the previous boot's writes, so they cannot be parallelized.
      const boot = await withHostname(hostname, () => emitControllerBootedAndStashEpoch({ bootEpoch: epoch }));
      // biome-ignore lint/performance/noAwaitInLoops: See above — the second boot must adjudicate against what the first one wrote.
      await reconcileOrphanedRunsAtBoot(boot);
      clearCurrentBootEpoch();
    }

    assert.equal(readAbandonEvents(dbPath).length, 1, "exactly one run.abandoned per orphan, however many boots run");
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});

test("an explicit PDPP_CONTROLLER_ID still overrides the durable identity", async () => {
  const dbPath = makeTemporaryDbPath("pdpp-identity-env-");
  initDb(dbPath);
  const priorEnv = process.env.PDPP_CONTROLLER_ID;
  try {
    process.env.PDPP_CONTROLLER_ID = "operator-pinned";
    const boot = await withHostname("container-hhhhhhhhhhhh", () =>
      emitControllerBootedAndStashEpoch({ bootEpoch: "boot-epoch-env" })
    );
    assert.equal(boot.controller_id, "operator-pinned", "the env override must still win for multi-controller setups");

    const raw = new Database(dbPath);
    try {
      const row = raw.prepare("SELECT controller_id FROM controller_identity WHERE id = 'singleton'").get() as
        | { controller_id: string }
        | undefined;
      assert.equal(row, undefined, "the env path must not write a durable row it did not resolve from");
    } finally {
      raw.close();
    }
  } finally {
    if (priorEnv === undefined) {
      process.env.PDPP_CONTROLLER_ID = undefined;
      delete process.env.PDPP_CONTROLLER_ID;
    } else {
      process.env.PDPP_CONTROLLER_ID = priorEnv;
    }
    clearCurrentBootEpoch();
    closeDb();
  }
});
