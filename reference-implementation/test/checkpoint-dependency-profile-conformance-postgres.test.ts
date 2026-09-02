// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SQLite/Postgres parity proof for the checkpoint-dependency contract defined
 * in `spec-collection-profile.md` (§ Checkpoint dependency, § DONE:
 * Eligible-checkpoint algorithm).
 *
 * This file runs `runMultiParentScenario` from
 * `helpers/checkpoint-dependency-multi-parent-scenario.ts` — the EXACT SAME
 * scenario function (same manifest, same connector script, same assertions)
 * that `checkpoint-dependency-profile-conformance.test.ts`'s
 * "SQLite/Postgres parity scenario (SQLite side)" test runs — against a real
 * Postgres-backed `startServer` instance instead of SQLite. This is a
 * genuine same-scenario, cross-backend comparison: an earlier draft of this
 * file independently authored a similar-but-not-identical scenario, which an
 * independent review correctly flagged as an inflated "parity" claim (no
 * scenario was actually run against both backends). Sharing one scenario
 * function closes that gap.
 *
 * Gated on `PDPP_TEST_POSTGRES_URL`, following the existing project
 * convention (see `connector-state-scheduler-conformance-postgres.test.ts`):
 * when unset, this file registers a single skipped test so default
 * development and CI do not require Postgres.
 *
 * Run (against a disposable, isolated Postgres container — do NOT point this
 * at a shared/long-lived instance; use a fresh container on its own port):
 *   PDPP_TEST_POSTGRES_URL=postgres://pdpp:pdpp@127.0.0.1:<port>/pdpp \
 *     node --test --import tsx \
 *     reference-implementation/test/checkpoint-dependency-profile-conformance-postgres.test.ts
 */

import { randomUUID } from "node:crypto";
import test from "node:test";
import { runConnector } from "../runtime/index.ts";
import { startServer as startServerUntyped } from "../server/index.ts";
import { closePostgresStorage } from "../server/postgres-storage.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { admitOwnerRunConnection } from "../server/stores/connector-instance-store.ts";
import {
  runMultiParentScenario,
  runStaticParentEmitsCoverageScenario,
  runSubsetParentCoverageScenario,
  runUndeclaredParentScenario,
} from "./helpers/checkpoint-dependency-multi-parent-scenario.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

interface ClosableServer {
  abortStartupBackfill: (reason: unknown) => void;
  asPort: number;
  asServer: { close: (cb: () => void) => void; closeAllConnections: () => void };
  controller: { drainActiveRuns: (timeoutMs: number) => Promise<unknown> };
  rsPort: number;
  rsServer: { close: (cb: () => void) => void; closeAllConnections: () => void };
  schedulerManager?: { stop?: () => void };
  startupBackfillDone: Promise<unknown>;
  startupSummaryEvidenceSweepDone: Promise<unknown>;
  stopBrowserSurfaceLeaseSweep: () => void;
  stopClientEventDeliveryWorker: () => Promise<void>;
  stopConnectorMaintenanceSweep: () => void;
}
interface StartServerOptions {
  asPort?: number;
  databaseUrl?: string;
  dbPath?: string;
  quiet?: boolean;
  rsPort?: number;
  storageBackend?: "postgres";
}
const startServer = startServerUntyped as unknown as (opts: StartServerOptions) => Promise<ClosableServer>;

// Each scenario writes committed records to `records` and this file never
// truncates between tests, so a shared database would leave the second
// scenario's admission fail-closed on the first scenario's rows (the guard's
// intended behavior -- see postgres-test-database-guard.ts). Each scenario
// therefore gets its own disposable database via withTemporaryPostgresDatabase,
// the same isolation pattern other multi-test Postgres suites use.
async function withScenarioServer(baseUrl: string, scenario: (server: ClosableServer) => Promise<void>): Promise<void> {
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: baseUrl,
      databaseName: `pdpp_checkpoint_dependency_profile_${randomUUID().replaceAll("-", "")}`,
    },
    async (databaseUrl) => {
      const server = await startServer({
        asPort: 0,
        databaseUrl,
        quiet: true,
        rsPort: 0,
        storageBackend: "postgres",
      });
      try {
        await scenario(server);
      } finally {
        await closeServer(server);
      }
    }
  );
}

async function closeServer(server: ClosableServer): Promise<void> {
  server.abortStartupBackfill("test shutdown");
  server.schedulerManager?.stop?.();
  server.stopBrowserSurfaceLeaseSweep();
  server.stopConnectorMaintenanceSweep();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise<void>((resolve) => server.asServer.close(() => resolve())),
    new Promise<void>((resolve) => server.rsServer.close(() => resolve())),
    server.controller.drainActiveRuns(5000),
    server.startupBackfillDone,
    server.startupSummaryEvidenceSweepDone,
    server.stopClientEventDeliveryWorker(),
  ]);
  await closePostgresStorage();
}

if (POSTGRES_URL) {
  const baseUrl = POSTGRES_URL;

  test("SQLite/Postgres parity scenario (Postgres side): one detail stream independently proves two parent checkpoints", async () => {
    await withScenarioServer(baseUrl, async (server) => {
      const asUrl = `http://localhost:${server.asPort}`;
      const rsUrl = `http://localhost:${server.rsPort}`;
      await runMultiParentScenario({
        admitOwnerRunConnection,
        asUrl,
        connectorId: "checkpoint-profile-postgres-parity-test",
        createRequestConnectorInstanceStore,
        rsUrl,
        runConnector,
      });
    });
  });

  // Case 7: SQLite/Postgres parity for the core rejection + subset-withholding
  // cases, run against the SAME scenario functions the SQLite conformance
  // file uses (see checkpoint-dependency-multi-parent-scenario.ts).
  test("case 1/5/6 (Postgres): a state_stream-declared stream emitting DETAIL_COVERAGE is rejected", async () => {
    await withScenarioServer(baseUrl, async (server) => {
      const asUrl = `http://localhost:${server.asPort}`;
      const rsUrl = `http://localhost:${server.rsPort}`;
      await runStaticParentEmitsCoverageScenario({
        admitOwnerRunConnection,
        asUrl,
        connectorId: "checkpoint-profile-postgres-static-parent-violation-test",
        createRequestConnectorInstanceStore,
        rsUrl,
        runConnector,
      });
    });
  });

  test("case 2 (Postgres): a parent_streams stream emitting DETAIL_COVERAGE naming an undeclared parent is rejected", async () => {
    await withScenarioServer(baseUrl, async (server) => {
      const asUrl = `http://localhost:${server.asPort}`;
      const rsUrl = `http://localhost:${server.rsPort}`;
      await runUndeclaredParentScenario({
        admitOwnerRunConnection,
        asUrl,
        connectorId: "checkpoint-profile-postgres-undeclared-parent-test",
        createRequestConnectorInstanceStore,
        rsUrl,
        runConnector,
      });
    });
  });

  test("case 3/4 (Postgres): a declared parent with no live coverage report is withheld", async () => {
    await withScenarioServer(baseUrl, async (server) => {
      const asUrl = `http://localhost:${server.asPort}`;
      const rsUrl = `http://localhost:${server.rsPort}`;
      await runSubsetParentCoverageScenario({
        admitOwnerRunConnection,
        asUrl,
        connectorId: "checkpoint-profile-postgres-subset-parent-test",
        createRequestConnectorInstanceStore,
        rsUrl,
        runConnector,
      });
    });
  });
} else {
  test("SQLite/Postgres parity scenario (Postgres side, skipped: PDPP_TEST_POSTGRES_URL unset)", {
    skip: true,
    // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
  }, () => {});
}
