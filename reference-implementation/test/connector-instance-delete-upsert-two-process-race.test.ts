// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Genuine two-OS-process discriminator for the connector-instance
 * delete/upsert tombstone TOCTOU
 * (openspec/changes/fix-owner-delete-resurrection).
 *
 * `withConnectorInstanceWrite`'s Postgres path serializes via a REAL
 * `pg_try_advisory_lock` keyed on `connector_instance_id` -- exclusion
 * enforced by the Postgres server across separate connections/sessions, not
 * anything in-process. One Node process racing two `async` calls proves
 * nothing about that: the coordinator's process-local `keyedGates` mutex
 * would trivially serialize them even with the advisory-lock code deleted
 * entirely. A genuine discriminator requires a SECOND OS process holding
 * its OWN Postgres session, racing the SAME identity's advisory lock --
 * exactly what `test/fixtures/connector-instance-two-process-race-fixture.mjs`
 * provides, mirroring the existing SQLite two-process oracle's structure
 * (`connector-summary-evidence-engine-two-process-interleaving.test.js`).
 *
 * Race under test: process A deletes an existing device-collected
 * connection (writes the tombstone, then removes the row). Process B
 * concurrently upserts the SAME identity (simulating the startup migration
 * sweep, or a device re-enrollment, racing the owner's delete). WITHOUT
 * per-identity coordination around `upsert`'s tombstone-check-then-INSERT,
 * B could read "no tombstone yet" before A's delete transaction commits,
 * then B's INSERT lands AFTER A's DELETE completes -- resurrecting the
 * connection as active despite the owner's concurrent delete. WITH
 * coordination, the two operations serialize on the real advisory lock: the
 * loser's own lock-acquisition attempt genuinely blocks (subject to
 * `PDPP_INGEST_LOCK_WAIT_MS`) until the winner releases, so B always
 * observes A's fully-committed outcome (either the pre-existing row, if B
 * won and ran first, or the tombstone, if A won and ran first) --  never an
 * interleaved read.
 *
 * What is proved, each of N attempts:
 *   (a) The final state is NEVER a resurrected active row when process A
 *       (delete) is the one whose commit precedes process B's (upsert)
 *       attempt in wall-clock terms -- i.e. delete-then-upsert for the same
 *       identity never resurrects, regardless of which process the OS
 *       schedules first.
 *   (b) Exactly one coherent outcome results: either the connection stays
 *       deleted (tombstone present, no live row) because B's upsert
 *       observed A's tombstone and was refused, or B's upsert legitimately
 *       preceded A's delete in commit order and A's delete then tombstones
 *       it correctly (both are valid outcomes of a genuine race; a torn or
 *       inconsistent state — e.g. a live row with no matching tombstone
 *       protection, or a "connection_tombstoned" error with a row still
 *       resurrected — is never observed).
 *
 * Empirically verified regression sensitivity: with the per-identity
 * coordination removed from `upsert` (reverting to the uncoordinated
 * function), this test's race window — B's upsert reading the
 * pre-tombstone state, then writing after A's delete commits — reproduces
 * the exact live-incident resurrection shape; see the "mutation proof"
 * companion test in `connector-instance-store.test.js` for the
 * single-process version of this same defect.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import {
  createPostgresConnectorInstanceStore,
  makeConnectorInstanceSourceBindingKey,
} from "../server/stores/connector-instance-store.ts";

const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/connector-instance-two-process-race-fixture.mjs", import.meta.url)
);
const DELAY_MS = 250;
const ATTEMPTS = 4;
const NOW = "2026-05-15T12:00:00.000Z";
const LATER = "2026-05-15T12:01:00.000Z";

function spawnFixture() {
  const child = spawn(process.execPath, [FIXTURE_PATH], {
    env: {
      ...process.env,
      PDPP_TEST_POSTGRES_URL: process.env.PDPP_TEST_POSTGRES_URL,
      // Widens the CHILD's upsert tombstone-check-to-INSERT window so the
      // parent's concurrent delete has a real, deterministic chance to
      // commit WHILE the child is inside it — the exact race the
      // per-identity coordination lock must close. See
      // testOnlyUpsertTombstoneCheckDelay in
      // server/stores/connector-instance-store.ts.
      PDPP_TEST_UPSERT_TOMBSTONE_CHECK_DELAY_MS: String(DELAY_MS),
    },
    stdio: ["pipe", "pipe", "inherit"],
  });

  let stdoutBuffer = "";
  const lines: string[] = [];
  const lineWaiters: Array<(line: string) => void> = [];
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    let idx = stdoutBuffer.indexOf("\n");
    while (idx >= 0) {
      const line = stdoutBuffer.slice(0, idx);
      stdoutBuffer = stdoutBuffer.slice(idx + 1);
      const waiter = lineWaiters.shift();
      if (waiter) {
        waiter(line);
      } else {
        lines.push(line);
      }
      idx = stdoutBuffer.indexOf("\n");
    }
  });

  function nextLine(): Promise<string> {
    if (lines.length > 0) {
      const line = lines.shift();
      assert.ok(line !== undefined, "a line just confirmed present in the buffer must be shiftable");
      return Promise.resolve(line);
    }
    return new Promise((resolve) => lineWaiters.push(resolve));
  }

  const exitCode = new Promise((resolve) => {
    child.once("exit", (code) => resolve(code));
  });

  return { child, exitCode, nextLine };
}

async function seedConnector(connectorId: string): Promise<void> {
  await postgresQuery(
    "INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3) ON CONFLICT(connector_id) DO NOTHING",
    [connectorId, JSON.stringify({ connector_id: connectorId }), NOW]
  );
}

async function cleanupIdentity(ownerSubjectId: string, connectorId: string): Promise<void> {
  await postgresQuery("DELETE FROM connector_instance_tombstones WHERE owner_subject_id = $1", [ownerSubjectId]);
  await postgresQuery("DELETE FROM connector_instances WHERE owner_subject_id = $1", [ownerSubjectId]);
  await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [connectorId]);
}

test("two genuine OS processes racing deleteConnection and upsert for the SAME identity never resurrect a deleted connection (Postgres advisory-lock discriminator) (skipped: PDPP_TEST_POSTGRES_URL unset)", {
  skip: !process.env.PDPP_TEST_POSTGRES_URL,
}, async () => {
  const databaseUrl = process.env.PDPP_TEST_POSTGRES_URL;
  assert.ok(databaseUrl, "Postgres URL is configured when this test runs");
  await initPostgresStorage({ backend: "postgres", databaseUrl });
  try {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      const ownerSubjectId = `owner_pg_race_${attempt}`;
      const connectorId = "codex";
      const localBindingName = `race-binding-${attempt}`;
      const bindingKey = makeConnectorInstanceSourceBindingKey({
        kind: "local_device",
        local_binding_name: localBindingName,
      });
      // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
      await seedConnector(connectorId);
      await cleanupIdentity(ownerSubjectId, connectorId);
      await seedConnector(connectorId);

      const store = createPostgresConnectorInstanceStore();
      const original = await store.upsert({
        connectorId,
        createdAt: NOW,
        displayName: "Codex",
        ownerSubjectId,
        sourceBinding: {
          device_id: "dexp_race_a",
          kind: "local_device",
          local_binding_name: localBindingName,
          source_instance_id: "dsrc_race_a",
        },
        sourceBindingKey: bindingKey,
        sourceKind: "local_device",
        status: "active",
        updatedAt: NOW,
      });
      assert.ok(original, `attempt ${attempt}: seeding upsert must return the created connector instance`);

      const fixture = spawnFixture();
      try {
        const readyLine = await fixture.nextLine();
        const ready = JSON.parse(readyLine);
        assert.equal(ready.ready, true, `attempt ${attempt}: fixture did not report ready: ${readyLine}`);

        // Child process B: upsert the SAME identity (simulating a
        // migration-sweep/re-enroll racing the delete), with a DIFFERENT
        // device_id/source_instance_id (a genuinely new enrollment
        // event), exactly like the live-incident shape.
        fixture.child.stdin.write(
          `${JSON.stringify({
            connectorId,
            connectorInstanceId: original.connectorInstanceId,
            now: LATER,
            op: "upsert",
            ownerSubjectId,
            sourceBinding: {
              device_id: "dexp_race_b",
              kind: "local_device",
              local_binding_name: localBindingName,
              source_instance_id: "dsrc_race_b",
            },
            sourceBindingKey: bindingKey,
          })}\n`
        );

        // Parent process A: delete the connection, as close in wall-clock
        // terms to the child's own go-signal as possible.
        const deletePromise = store.deleteConnection(original.connectorInstanceId, {
          now: LATER,
          ownerSubjectId,
          purge: {
            deleteRecordRowsPostgres: () => Promise.resolve(0),
            deleteRecordRowsSqlite: () => {
              throw new Error("deleteRecordRowsSqlite must not be called by the Postgres store");
            },
            enumerateStreams: () =>
              Promise.resolve({ connectorId, connectorInstanceId: original.connectorInstanceId, streams: [] }),
            teardownProjection: () => Promise.resolve(),
          },
        });

        const resultLine = await fixture.nextLine();
        const childOutcome = JSON.parse(resultLine);
        const exitCode = await fixture.exitCode;

        // The delete may legitimately win, lose, or race the child's
        // upsert — both `connection_tombstoned` (child lost, ran second)
        // and outright success (child won, ran first, delete then
        // tombstones the child's fresh row) are valid non-resurrecting
        // outcomes. What must NEVER happen is a resurrected row: either
        // the delete throws (should not, since it targets a real
        // pre-existing row) or the child's upsert both succeeds AND a
        // live row survives with an unprotected identity.
        let deleteOutcome: Awaited<ReturnType<typeof store.deleteConnection>> | undefined;
        let deleteError: Error | null = null;
        try {
          deleteOutcome = await deletePromise;
        } catch (err) {
          deleteError = err as Error;
        }

        assert.equal(
          deleteError,
          null,
          `attempt ${attempt}: delete must not throw when racing a concurrent upsert for the same identity — ${deleteError?.message}`
        );
        assert.ok(deleteOutcome, `attempt ${attempt}: delete must report a summary`);

        if (exitCode === 0) {
          // The child's upsert either observed the tombstone (impossible
          // here since it targets the SAME pre-existing connectorInstanceId
          // as delete — the two calls fully serialize, so the child's
          // upsert is really an ON CONFLICT DO UPDATE reactivation if it
          // ran BEFORE delete) or ran before the delete and got cleanly
          // superseded by it. Either way, after BOTH complete, the final
          // state must be exactly the delete's outcome: gone and
          // tombstoned.
        } else {
          assert.equal(
            childOutcome.code,
            "connection_tombstoned",
            `attempt ${attempt}: the ONLY acceptable child failure is the typed tombstone refusal — ${JSON.stringify(childOutcome)}`
          );
        }

        // The definitive invariant, checked directly against durable
        // state after BOTH processes have fully completed: the deleted
        // identity is NEVER left as a live, active row. Delete always
        // wins in the end because it targets the specific pre-existing
        // connectorInstanceId directly (upsert's ON CONFLICT DO UPDATE
        // on that same id, if it ran first, is itself removed by the
        // subsequent delete; if it ran second, it's refused by the
        // tombstone).
        const finalRow = await store.get(original.connectorInstanceId);
        assert.equal(
          finalRow,
          null,
          `attempt ${attempt}: CRITICAL — the connection must not survive as a live row after a concurrent delete completes, regardless of race outcome`
        );
        const tombstone = await postgresQuery(
          "SELECT 1 x FROM connector_instance_tombstones WHERE connector_instance_id = $1",
          [original.connectorInstanceId]
        );
        assert.equal(
          tombstone.rows.length,
          1,
          `attempt ${attempt}: the tombstone must be present after the delete completes`
        );
      } finally {
        if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
          fixture.child.kill("SIGKILL");
        }
      }
      await cleanupIdentity(ownerSubjectId, connectorId);
    }
  } finally {
    await closePostgresStorage();
  }
});
