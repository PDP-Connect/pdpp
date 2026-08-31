// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Postgres-backed reproduction of the live Codex enrollment blocker
// (decouple-device-enrollment-from-ingest-writer-admission, design D1).
//
// On the real Postgres backend, enrollment used to run a retrieval-index
// backfill inside `withConnectorInstanceWrite` — the SAME writer-admission gate
// and `pg_try_advisory_lock` that bulk ingest holds. When that gate is
// saturated, enrollment blocked on lock acquisition (the observed client hang
// with an idle Postgres session) or was rejected with connector_instance_busy.
//
// This test saturates the global admission gate (active limit forced to 1) by
// holding one writer on an unrelated instance, then drives a real enroll. After
// D1 the enroll no longer enters the fence, so it completes promptly. Before D1
// it would block until the held writer released (or time out as busy).
//
// Skipped unless PDPP_TEST_POSTGRES_URL points at the dedicated loopback
// listener.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: Biome resolver cannot model this installed package export
import pg from "pg";

import { COLLECTOR_PROTOCOL_VERSION } from "../server/collector-protocol.ts";
import { makeConnectorInstanceSourceBindingKey } from "../server/connector-instance-utils.ts";
import {
  ConnectorInstanceAdmissionError,
  connectorInstanceAdvisoryLockKey,
  withConnectorInstanceWrite,
} from "../server/connector-instance-write-coordinator.ts";
import { closeDb, initDb } from "../server/db.ts";
import { startServer as startServerBase } from "../server/index.ts";
import {
  __setPostgresLocalDeviceDuplicateDiscoveryHookForTest,
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
} from "../server/postgres-storage.ts";
import { __setEnrollPhaseFaultHookForTest } from "../server/routes/ref-device-exporters.ts";
import { createPostgresConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { createPostgresConnectorStateStore } from "../server/stores/connector-state-store.ts";
import { createPostgresDeviceExporterStore } from "../server/stores/device-exporter-store.ts";
import { commitTerminalRun, type ResolvedTerminalRunCommit } from "../server/stores/terminal-run-commit-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const DEDICATED_POSTGRES_URL = dedicatedPostgresTestUrl(POSTGRES_URL);
const RE_CONNECTOR_INSTANCE_PREFIX = /^cin_/;
const RE_CANNOT_COALESCE = /Cannot coalesce local-device connector instance .*colliding owned state/;
const PROTOCOL_HEADERS = { "X-PDPP-Collector-Protocol": COLLECTOR_PROTOCOL_VERSION };
const { Pool } = pg;

function startServer(
  options: Parameters<typeof startServerBase>[0] & { databaseUrl?: string; storageBackend?: "postgres" }
) {
  return startServerBase(options);
}

let dbCounter = 0;
function tempDbName(): string {
  dbCounter += 1;
  return `pdpp_enroll_admission_${process.pid}_${dbCounter}`;
}

async function closeServer(server: Awaited<ReturnType<typeof startServerBase>>): Promise<void> {
  server.abortStartupBackfill("test shutdown");
  server.schedulerManager?.stop?.();
  server.stopBrowserSurfaceLeaseSweep();
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
    server.controller.drainActiveRuns(5000),
    server.startupBackfillDone,
    server.startupSummaryEvidenceSweepDone,
    server.stopClientEventDeliveryWorker(),
  ]);
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: { Accept: "application/json", "Content-Type": "application/json", ...headers },
    method: "POST",
  });
  const text = await response.text();
  return { body: (text ? JSON.parse(text) : {}) as Record<string, unknown>, status: response.status };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {
    /* placeholder before promise construction */
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Bounds the D9 rendezvous hook's discovery wait so a fixture/product
// mismatch that stops the hook from ever firing (as `seedD9ExactDuplicateClass`
// did before its stable-key fix) fails this one test with a diagnostic
// message, instead of hanging until the external per-file watchdog kills the
// whole process and discards every test that already passed in the run.
async function awaitD9DiscoveryRendezvous(discovered: Promise<void>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      discovered,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label}: discovery hook was never invoked — the seeded class was not found`)),
          15_000
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function seedD9ExactDuplicateClass({
  canonicalId,
  deviceId,
  legacyIds,
  localBindingName,
  ownerSubjectId = "owner_local",
  sourceInstanceId,
}: {
  canonicalId: string;
  deviceId: string;
  legacyIds: readonly string[];
  localBindingName: string;
  ownerSubjectId?: string;
  sourceInstanceId: string;
}): Promise<{ now: string }> {
  const now = new Date().toISOString();
  const binding = {
    device_id: deviceId,
    kind: "local_device",
    local_binding_name: localBindingName,
    source_instance_id: sourceInstanceId,
  };
  // The canonical row must carry the STABLE key (hash of {kind,
  // local_binding_name} alone) — findExactPostgresLocalDeviceBindingClass
  // only recognizes a canonical row whose stored source_binding_key equals
  // this reduction, matching the post-enrollment live shape. Legacy rows
  // keep the obsolete full-binding-hash key so they remain distinguishable
  // duplicates under the same source_binding_json.
  const stableBindingKey = makeConnectorInstanceSourceBindingKey({
    kind: "local_device",
    local_binding_name: localBindingName,
  });
  await postgresQuery(
    `INSERT INTO connectors(connector_id, manifest) VALUES('codex', '{"connector_id":"codex","streams":[]}'::jsonb) ON CONFLICT DO NOTHING`
  );
  await postgresQuery(
    `INSERT INTO device_exporters(device_id, owner_subject_id, display_name, status, created_at, updated_at)
     VALUES($1, $2, $3, 'active', $4, $4)`,
    [deviceId, ownerSubjectId, localBindingName, now]
  );
  const ids = [canonicalId, ...legacyIds];
  await Promise.all(
    ids.map((id, index) =>
      postgresQuery(
        `INSERT INTO connector_instances(connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at)
         VALUES($1, $2, 'codex', $3, 'active', 'local_device', $4, $5::jsonb, $6, $6)`,
        [
          id,
          ownerSubjectId,
          localBindingName,
          id === canonicalId
            ? stableBindingKey
            : createHash("sha256")
                .update(`${index}:${JSON.stringify(binding)}`)
                .digest("hex"),
          JSON.stringify(binding),
          now,
        ]
      )
    )
  );
  await postgresQuery(
    `INSERT INTO device_source_instances(source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id, source_kind, display_name, status, created_at, updated_at)
     VALUES($1, $2, 'codex', $3, $4, 'local_device', $4, 'active', $5, $5)`,
    [sourceInstanceId, deviceId, canonicalId, localBindingName, now]
  );
  return { now };
}

async function mintCode(asUrl: string, localBindingName: string, connectorId = "codex"): Promise<string> {
  const code = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
    connector_id: connectorId,
    local_binding_name: localBindingName,
  });
  assert.equal(code.status, 201, JSON.stringify(code.body));
  return code.body.enrollment_code as string;
}

async function exchangeCode(
  asUrl: string,
  enrollmentCode: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  return await postJson(`${asUrl}/_ref/device-exporters/enroll`, { enrollment_code: enrollmentCode }, PROTOCOL_HEADERS);
}

async function enrollDevice(
  asUrl: string,
  localBindingName: string,
  connectorId = "codex"
): Promise<Record<string, unknown>> {
  const enrollmentCode = await mintCode(asUrl, localBindingName, connectorId);
  const enrolled = await exchangeCode(asUrl, enrollmentCode);
  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
  return enrolled.body;
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if ((value as Record<string, unknown>)[key] !== undefined) {
      output[key] = canonicalValue((value as Record<string, unknown>)[key]);
    }
  }
  return output;
}

function bodyHash(records: unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(records)))
    .digest("hex");
}

function messageRecord(id: string, timestamp = "2026-07-16T00:00:00.000Z") {
  return {
    data: { content: "seed", id, role: "user", session_id: id, timestamp, type: "text" },
    emitted_at: timestamp,
    record_key: id,
    stream: "messages",
  };
}

async function ingestOneRecord(asUrl: string, device: Record<string, unknown>): Promise<void> {
  const deviceId = String(device.device_id);
  const records = [messageRecord(`msg_${deviceId}`)];
  const batch = {
    batch_id: `batch_${deviceId}`,
    batch_seq: 1,
    body_hash: bodyHash(records),
    connector_id: device.connector_id,
    device_id: deviceId,
    records,
    source_instance_id: device.source_instance_id,
  };
  const response = await postJson(
    `${asUrl}/_ref/device-exporters/${encodeURIComponent(deviceId)}/ingest-batches`,
    batch,
    { Authorization: `Bearer ${String(device.device_token)}`, ...PROTOCOL_HEADERS }
  );
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.status, "accepted", JSON.stringify(response.body));
}

test("D1 (Postgres): enroll completes while the writer-admission gate is saturated by unrelated ingest", {
  skip: DEDICATED_POSTGRES_URL ? false : "set PDPP_TEST_POSTGRES_URL to the dedicated loopback listener",
}, async () => {
  const previousLimit = process.env.PDPP_INGEST_ACTIVE_BATCH_LIMIT;
  // Force the global admission gate down to a single active writer so one held
  // writer saturates it — the deterministic stand-in for live bulk ingest.
  process.env.PDPP_INGEST_ACTIVE_BATCH_LIMIT = "1";
  try {
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: DEDICATED_POSTGRES_URL ?? "",
        databaseName: tempDbName(),
      },
      async (url) => {
        initDb(":memory:");
        const server = await startServer({
          asPort: 0,
          databaseUrl: url,
          dbPath: ":memory:",
          quiet: true,
          rsPort: 0,
          storageBackend: "postgres",
        });
        await server.startupBackfillDone.catch(() => undefined);
        const asUrl = `http://localhost:${server.asPort}`;
        try {
          // Saturate the single admission slot with a held writer on an
          // unrelated instance — this is what bulk ingest does live.
          const entered = deferred();
          const release = deferred();
          const held = withConnectorInstanceWrite("cin_unrelated_bulk_ingest", async () => {
            entered.resolve();
            await release.promise;
          });
          await entered.promise;

          // Mint + exchange an enrollment code WHILE the gate is saturated.
          const codeResp = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
            connector_id: "codex",
            local_binding_name: "codex-home-admission",
          });
          assert.equal(codeResp.status, 201);

          // A coupled enroll (pre-D1) would block on admission until the held
          // writer releases (or time out as busy). We enroll WITHOUT releasing
          // the writer, and bound the wait: if the enroll does not resolve while
          // the gate is held, it is still coupled to the ingest fence. Release
          // is guaranteed afterward so teardown never hangs on the held writer.
          let enrollResp: { status: number; body: Record<string, unknown> } | undefined;
          try {
            enrollResp = await Promise.race([
              postJson(
                `${asUrl}/_ref/device-exporters/enroll`,
                { enrollment_code: codeResp.body.enrollment_code },
                PROTOCOL_HEADERS
              ),
              new Promise<never>((_, reject) =>
                setTimeout(
                  () =>
                    reject(
                      new Error(
                        "enroll did not resolve while the writer gate was held — still coupled to the ingest fence"
                      )
                    ),
                  6000
                )
              ),
            ]);
          } finally {
            release.resolve();
            await held.catch(() => undefined);
          }

          // After D1 the enroll does not touch the fence, so it returns 201 with
          // a device token even though the only writer slot is held elsewhere.
          assert.ok(enrollResp, "enroll must have resolved");
          assert.equal(enrollResp.status, 201, "enroll must succeed while the writer gate is saturated");
          assert.ok(enrollResp.body.device_token, "enroll must return a device token");
          assert.match(enrollResp.body.connector_instance_id as string, RE_CONNECTOR_INSTANCE_PREFIX);
        } finally {
          await closeServer(server);
          await closePostgresStorage().catch(() => undefined);
          closeDb();
        }
      }
    );
  } finally {
    if (previousLimit === undefined) {
      process.env.PDPP_INGEST_ACTIVE_BATCH_LIMIT = undefined;
    } else {
      process.env.PDPP_INGEST_ACTIVE_BATCH_LIMIT = previousLimit;
    }
  }
});

// Live counterexample (post-deploy, f0a6fe0fe): a direct enroll POST returned a
// typed 503 connector_instance_busy while the fresh code stayed pending, with
// controller_active_runs=0 and an idle Postgres session after
// `SELECT pg_try_advisory_lock`. D1 only skips `ensureReferenceConnectorCatalogEntry`'s
// retrieval-index backfill (`registerConnector(..., { backfillRetrievalIndexes: false })`).
// `registerConnector` (auth.ts) ALSO unconditionally runs
// `postgresBackfillRecordSortPositionsForManifest` on the Postgres branch, BEFORE the
// `backfillRetrievalIndexes` short-circuit. That function enumerates every
// `connector_instance_id` already holding records under the manifest's `connector_id`
// (`codex` / `claude-code` — shared across every device enrolled for that connector
// type, not scoped to the instance being enrolled) and takes `withConnectorInstanceWrite`
// — the SAME fence bulk ingest holds — for each one it finds. The design.md "zero rows
// for a fresh enroll" argument only holds for the very first-ever enroll of a connector
// type; it is false once ANY device has ever ingested a record for that connector_id,
// which is the live steady state, not a fresh install.
//
// This test enrolls and ingests one record for a FIRST codex device (populating
// `records` for connector_id=codex), then saturates the admission gate on that first
// device's connector_instance_id, then enrolls a SECOND, independent codex device while
// the gate is held. Before D4 this reproduces the live failure (blocks on the fence /
// times out as busy). After D4 the second enroll completes promptly.
test("D4 (Postgres): a SECOND enroll for an already-ingesting connector type completes while the writer-admission gate is saturated", {
  skip: DEDICATED_POSTGRES_URL ? false : "set PDPP_TEST_POSTGRES_URL to the dedicated loopback listener",
}, async () => {
  const previousLimit = process.env.PDPP_INGEST_ACTIVE_BATCH_LIMIT;
  process.env.PDPP_INGEST_ACTIVE_BATCH_LIMIT = "1";
  try {
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: DEDICATED_POSTGRES_URL ?? "",
        databaseName: tempDbName(),
      },
      async (url) => {
        initDb(":memory:");
        const server = await startServer({
          asPort: 0,
          databaseUrl: url,
          dbPath: ":memory:",
          quiet: true,
          rsPort: 0,
          storageBackend: "postgres",
        });
        await server.startupBackfillDone.catch(() => undefined);
        const asUrl = `http://localhost:${server.asPort}`;
        try {
          // First device: real enroll + real ingest, so `records` now has a
          // row under connector_id=codex for THIS device's connector_instance_id.
          const firstDevice = await enrollDevice(asUrl, "codex-first-device");
          await ingestOneRecord(asUrl, firstDevice);

          // Saturate the single admission slot with a held writer on the
          // FIRST device's connector_instance_id — this is what bulk ingest
          // does live while a collector drains.
          const entered = deferred();
          const release = deferred();
          const held = withConnectorInstanceWrite(String(firstDevice.connector_instance_id), async () => {
            entered.resolve();
            await release.promise;
          });
          await entered.promise;

          // Mint + exchange a SECOND, independent codex enrollment code WHILE
          // the first device's fence is held. A coupled enroll (pre-D4) runs
          // postgresBackfillRecordSortPositionsForManifest, which enumerates
          // connector_instance_id's for connector_id=codex — including the
          // first device's — and blocks entering its held fence.
          const codeResp = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
            connector_id: "codex",
            local_binding_name: "codex-second-device",
          });
          assert.equal(codeResp.status, 201);

          let enrollResp: { status: number; body: Record<string, unknown> } | undefined;
          try {
            enrollResp = await Promise.race([
              postJson(
                `${asUrl}/_ref/device-exporters/enroll`,
                { enrollment_code: codeResp.body.enrollment_code },
                PROTOCOL_HEADERS
              ),
              new Promise<never>((_, reject) =>
                setTimeout(
                  () =>
                    reject(
                      new Error(
                        "second enroll did not resolve while the first device's writer gate was held — " +
                          "still coupled to the ingest fence via postgresBackfillRecordSortPositionsForManifest"
                      )
                    ),
                  6000
                )
              ),
            ]);
          } finally {
            release.resolve();
            await held.catch(() => undefined);
          }

          assert.ok(enrollResp, "second enroll must have resolved");
          assert.equal(
            enrollResp.status,
            201,
            "second enroll must succeed while the first device's writer gate is saturated"
          );
          assert.ok(enrollResp.body.device_token, "second enroll must return a device token");
          assert.notEqual(
            enrollResp.body.connector_instance_id,
            firstDevice.connector_instance_id,
            "the two devices must remain distinct connector instances"
          );
        } finally {
          await closeServer(server);
          await closePostgresStorage().catch(() => undefined);
          closeDb();
        }
      }
    );
  } finally {
    if (previousLimit === undefined) {
      process.env.PDPP_INGEST_ACTIVE_BATCH_LIMIT = undefined;
    } else {
      process.env.PDPP_INGEST_ACTIVE_BATCH_LIMIT = previousLimit;
    }
  }
});

// Live counterexample (post-deploy, ace356a7d): the same PENDING code returned
// HTTP 500 / Postgres 23505 duplicate connector_instances_pkey on retry.
// Causal sequence proven here: a first enroll attempt reaches identity
// creation (device, connector instance, source instance all durably written),
// then fails BEFORE consumeEnrollmentCode — the code stays `pending` while the
// identity rows persist. Before D5, retrying that still-pending code re-runs
// performFirstEnrollment from scratch: it generates a FRESH random device_id
// and source_instance_id (no way to know a device already exists for this
// code), but connector_instances' id is independently deterministic from
// (owner, connector, source_kind, source_binding_key) — unrelated to the
// device_id — so the retry's INSERT collides with the orphaned first
// attempt's row on connector_instances_pkey. D2 does not help: it only
// activates for a CONSUMED code (the transport-loss-after-consume case); this
// code never reached consume.
//
// This test injects the exact failure point via __setEnrollPhaseFaultHookForTest
// ("after_identity_before_consume", wired in performFirstEnrollment right after
// upsertSourceInstance and before the credential rotation + consume), then
// retries the SAME still-pending code with the hook cleared. Asserts: the
// retry returns 201 (not 500/23505), consumes the code exactly once, and
// converges on ONE device / ONE source instance / ONE connector instance / ONE
// active credential — never two.
test("D5 (Postgres): retrying a still-PENDING code after a partial first attempt (identity created, consume never reached) resumes idempotently", {
  skip: DEDICATED_POSTGRES_URL ? false : "set PDPP_TEST_POSTGRES_URL to the dedicated loopback listener",
}, async () => {
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: DEDICATED_POSTGRES_URL ?? "",
      databaseName: tempDbName(),
    },
    async (url) => {
      initDb(":memory:");
      const server = await startServer({
        asPort: 0,
        databaseUrl: url,
        dbPath: ":memory:",
        quiet: true,
        rsPort: 0,
        storageBackend: "postgres",
      });
      await server.startupBackfillDone.catch(() => undefined);
      const asUrl = `http://localhost:${server.asPort}`;
      try {
        const enrollmentCode = await mintCode(asUrl, "codex-partial-write");

        // First attempt: identity creation succeeds, then the injected fault
        // throws before consumeEnrollmentCode runs. The code must remain
        // pending and no response is ever sent for this attempt.
        __setEnrollPhaseFaultHookForTest((point) => {
          if (point === "after_identity_before_consume") {
            throw new Error("injected: writer-pressure failure after identity creation, before consume");
          }
        });
        try {
          await exchangeCode(asUrl, enrollmentCode);
        } finally {
          __setEnrollPhaseFaultHookForTest(null);
        }

        const codeRow = await postgresQuery("SELECT status, device_id FROM device_enrollment_codes");
        assert.equal(codeRow.rows[0]?.status, "pending", "code must remain pending after the partial first attempt");

        const devicesAfterFirstAttempt = await postgresQuery("SELECT device_id FROM device_exporters");
        assert.equal(
          devicesAfterFirstAttempt.rows.length,
          1,
          "identity creation must have left exactly one orphaned device row"
        );

        // Retry the SAME still-pending code with the fault cleared. This must
        // NOT re-run identity creation from scratch (which would 23505 on the
        // deterministic connector_instances row) — it must resume.
        const retryResp = await exchangeCode(asUrl, enrollmentCode);
        assert.equal(
          retryResp.status,
          201,
          `retry of a partial-write pending code must return 201, got: ${JSON.stringify(retryResp.body)}`
        );
        assert.ok(retryResp.body.device_token, "retry must return a device token");
        assert.match(retryResp.body.connector_instance_id as string, RE_CONNECTOR_INSTANCE_PREFIX);
        const retryDeviceId = String(retryResp.body.device_id);

        // Convergence: exactly one device, one source instance, one connector
        // instance, one active credential — never two, regardless of how many
        // attempts touched this code.
        const devices = await postgresQuery("SELECT device_id FROM device_exporters");
        assert.equal(devices.rows.length, 1, "exactly one device must exist after resume");
        const [devRow0] = devices.rows;
        assert.ok(devRow0);
        assert.equal(devRow0.device_id, retryDeviceId);

        const sourceInstances = await postgresQuery(
          "SELECT source_instance_id FROM device_source_instances WHERE device_id = $1",
          [retryDeviceId]
        );
        assert.equal(sourceInstances.rows.length, 1, "exactly one source instance must exist for the device");

        const connectorInstances = await postgresQuery(
          "SELECT connector_instance_id FROM connector_instances WHERE connector_id = $1",
          ["codex"]
        );
        assert.equal(connectorInstances.rows.length, 1, "exactly one connector instance must exist for this binding");

        const activeCredentials = await postgresQuery(
          "SELECT credential_id FROM device_ingest_credentials WHERE device_id = $1 AND status = 'active'",
          [retryDeviceId]
        );
        assert.equal(activeCredentials.rows.length, 1, "exactly one active credential must exist after resume");

        // Code consumed exactly once, bound to the same device the retry returned.
        const finalCodeRow = await postgresQuery("SELECT status, device_id FROM device_enrollment_codes");
        const [finalCodeRow0] = finalCodeRow.rows;
        assert.ok(finalCodeRow0);
        assert.equal(finalCodeRow0.status, "consumed");
        assert.equal(finalCodeRow0.device_id, retryDeviceId);

        // The retry's token must actually work — proves it was really delivered.
        const heartbeat = await postJson(
          `${asUrl}/_ref/device-exporters/${encodeURIComponent(retryDeviceId)}/heartbeat`,
          { status: "healthy" },
          { Authorization: `Bearer ${String(retryResp.body.device_token)}`, ...PROTOCOL_HEADERS }
        );
        assert.equal(heartbeat.status, 200, JSON.stringify(heartbeat.body));
      } finally {
        __setEnrollPhaseFaultHookForTest(null);
        await closeServer(server);
        await closePostgresStorage().catch(() => undefined);
        closeDb();
      }
    }
  );
});

// Adversarial: a still-PENDING code with NO existing device row must still
// take the normal first-enrollment path (not be misrouted into the D5 resume
// path, which requires an existing device to prove a same-binding retry).
test("D5 adversarial (Postgres): a pending code with no prior attempt still enrolls normally", {
  skip: DEDICATED_POSTGRES_URL ? false : "set PDPP_TEST_POSTGRES_URL to the dedicated loopback listener",
}, async () => {
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: DEDICATED_POSTGRES_URL ?? "",
      databaseName: tempDbName(),
    },
    async (url) => {
      initDb(":memory:");
      const server = await startServer({
        asPort: 0,
        databaseUrl: url,
        dbPath: ":memory:",
        quiet: true,
        rsPort: 0,
        storageBackend: "postgres",
      });
      await server.startupBackfillDone.catch(() => undefined);
      const asUrl = `http://localhost:${server.asPort}`;
      try {
        const enrolled = await enrollDevice(asUrl, "codex-fresh-no-prior-attempt");
        assert.ok(enrolled.device_token);
        const devices = await postgresQuery("SELECT device_id FROM device_exporters");
        assert.equal(devices.rows.length, 1);
      } finally {
        await closeServer(server);
        await closePostgresStorage().catch(() => undefined);
        closeDb();
      }
    }
  );
});

// D5 concurrency, real Postgres connections: genuinely concurrent FIRST
// attempts (no prior successful enroll) for the same still-pending code, sent
// as true parallel HTTP requests against a real Postgres backend — the class
// of race SQLite's single-writer serialization can mask. Proves
// ON CONFLICT(device_id) DO NOTHING (createDevice) and rotateDeviceCredential
// (in place of a plain createCredential insert) converge concurrent first
// attempts on exactly one device, one connector instance, one source
// instance, and one active credential, with none raising 23505.
test("D5 concurrency (Postgres): genuinely concurrent first attempts for the same pending code converge with no 23505", {
  skip: DEDICATED_POSTGRES_URL ? false : "set PDPP_TEST_POSTGRES_URL to the dedicated loopback listener",
}, async () => {
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: DEDICATED_POSTGRES_URL ?? "",
      databaseName: tempDbName(),
    },
    async (url) => {
      initDb(":memory:");
      const server = await startServer({
        asPort: 0,
        databaseUrl: url,
        dbPath: ":memory:",
        quiet: true,
        rsPort: 0,
        storageBackend: "postgres",
      });
      await server.startupBackfillDone.catch(() => undefined);
      const asUrl = `http://localhost:${server.asPort}`;
      try {
        const enrollmentCode = await mintCode(asUrl, "codex-pg-concurrent-first-attempt");

        const attempts = await Promise.all([
          exchangeCode(asUrl, enrollmentCode),
          exchangeCode(asUrl, enrollmentCode),
          exchangeCode(asUrl, enrollmentCode),
          exchangeCode(asUrl, enrollmentCode),
        ]);
        for (const a of attempts) {
          assert.equal(
            a.status,
            201,
            `every concurrent first attempt must return 201 (never 500/23505), got: ${JSON.stringify(a.body)}`
          );
        }
        const deviceIds = new Set(attempts.map((a) => a.body.device_id));
        assert.equal(deviceIds.size, 1, "concurrent first attempts must converge on exactly one device");

        const devices = await postgresQuery("SELECT device_id FROM device_exporters");
        assert.equal(devices.rows.length, 1, "exactly one device row must exist");
        const [deviceRow] = devices.rows;
        assert.ok(deviceRow, "device row must exist");
        const deviceId = deviceRow.device_id as string;

        const connectorInstances = await postgresQuery(
          "SELECT connector_instance_id FROM connector_instances WHERE connector_id = $1",
          ["codex"]
        );
        assert.equal(connectorInstances.rows.length, 1, "exactly one connector instance row must exist");

        const sourceInstances = await postgresQuery(
          "SELECT source_instance_id FROM device_source_instances WHERE device_id = $1",
          [deviceId]
        );
        assert.equal(sourceInstances.rows.length, 1, "exactly one source instance row must exist");

        const activeCredentials = await postgresQuery(
          "SELECT credential_id FROM device_ingest_credentials WHERE device_id = $1 AND status = 'active'",
          [deviceId]
        );
        assert.equal(activeCredentials.rows.length, 1, "exactly one active credential must exist");

        const tokens = attempts.map((a) => a.body.device_token);
        const heartbeats = await Promise.all(
          tokens.map((token) =>
            postJson(
              `${asUrl}/_ref/device-exporters/${encodeURIComponent(deviceId)}/heartbeat`,
              { status: "healthy" },
              { Authorization: `Bearer ${String(token)}`, ...PROTOCOL_HEADERS }
            )
          )
        );
        const workingCount = heartbeats.filter((r) => r.status === 200).length;
        assert.equal(workingCount, 1, "exactly one of the concurrently-issued tokens must be current");
      } finally {
        await closeServer(server);
        await closePostgresStorage().catch(() => undefined);
        closeDb();
      }
    }
  );
});

// D5 lock oracle (Postgres, deterministic — REVISE from independent gate
// 2026-07-25): the Promise.all-based D5 concurrency test above is NOT
// discriminating for the empty-credential-row race: real HTTP request timing
// gives no guarantee that two rotateDeviceCredential transactions actually
// overlap at the moment neither has inserted a credential row yet. Before the
// device-row lock fix, rotateDeviceCredential's revoke-then-insert only takes
// a row lock on credential rows the revoke UPDATE actually matches — when the
// device has ZERO credential rows (first-ever rotation), the UPDATE matches
// nothing, locks nothing, and two concurrent transactions can both fall
// through to INSERT an active credential.
//
// This test forces the exact overlap deterministically using TWO sequential
// rendezvous points:
//   1. "after_identity_before_consume" — both attempts hold here until BOTH
//      have committed identity (device, connector instance, source instance)
//      with ZERO credential rows written. Released together so both enter
//      rotateDeviceCredential against a guaranteed-empty credentials table —
//      the exact database state the empty-credential-row race requires.
//   2. "after_rotation_before_consume" — both attempts hold here AGAIN,
//      immediately after their own rotateDeviceCredential call returns but
//      BEFORE consumeEnrollmentCode runs. This is essential: performFirstEnrollment's
//      `!consumed` fallback (the attempt that loses the consumeEnrollmentCode
//      race) itself calls rotateDeviceCredential a THIRD time, which
//      incidentally revokes-and-replaces whatever the race left behind and
//      would silently mask a lock defect if the test only inspected DB state
//      after both HTTP responses complete. Inspecting state at rendezvous 2 —
//      after both racing rotations, before either consume/cleanup path can
//      run — observes the invariant at the one moment nothing downstream can
//      paper over a failure.
test("D5 lock (Postgres, deterministic): two attempts racing rotateDeviceCredential against an empty credentials table still converge on exactly one active credential", {
  skip: DEDICATED_POSTGRES_URL ? false : "set PDPP_TEST_POSTGRES_URL to the dedicated loopback listener",
}, async () => {
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: DEDICATED_POSTGRES_URL ?? "",
      databaseName: tempDbName(),
    },
    async (url) => {
      initDb(":memory:");
      const server = await startServer({
        asPort: 0,
        databaseUrl: url,
        dbPath: ":memory:",
        quiet: true,
        rsPort: 0,
        storageBackend: "postgres",
      });
      await server.startupBackfillDone.catch(() => undefined);
      const asUrl = `http://localhost:${server.asPort}`;
      try {
        const enrollmentCode = await mintCode(asUrl, "codex-pg-lock-rendezvous");

        let identityArrivedCount = 0;
        let rotationArrivedCount = 0;
        const identityArrivals: [ReturnType<typeof deferred>, ReturnType<typeof deferred>] = [deferred(), deferred()];
        const identityReleases: [ReturnType<typeof deferred>, ReturnType<typeof deferred>] = [deferred(), deferred()];
        const rotationArrivals: [ReturnType<typeof deferred>, ReturnType<typeof deferred>] = [deferred(), deferred()];
        const rotationReleases: [ReturnType<typeof deferred>, ReturnType<typeof deferred>] = [deferred(), deferred()];
        __setEnrollPhaseFaultHookForTest(async (point) => {
          if (point === "after_identity_before_consume") {
            const slot = identityArrivedCount;
            identityArrivedCount += 1;
            if (slot > 1) {
              throw new Error("unexpected third arrival at the D5 identity rendezvous");
            }
            identityArrivals[slot as 0 | 1].resolve();
            await identityReleases[slot as 0 | 1].promise;
            return;
          }
          if (point === "after_rotation_before_consume") {
            const slot = rotationArrivedCount;
            rotationArrivedCount += 1;
            if (slot > 1) {
              throw new Error("unexpected third arrival at the D5 rotation rendezvous");
            }
            rotationArrivals[slot as 0 | 1].resolve();
            await rotationReleases[slot as 0 | 1].promise;
          }
        });

        // Always release both rendezvous points and drain both in-flight
        // requests before the test returns, regardless of whether an
        // assertion below throws — otherwise a failed assertion leaves both
        // HTTP requests permanently blocked inside the hook, and closing the
        // server out from under them surfaces as an unrelated-looking
        // "socket closed" / unhandled rejection instead of the real
        // assertion failure.
        const releaseAll = () => {
          for (const d of [...identityReleases, ...rotationReleases]) {
            d.resolve();
          }
        };
        const attemptA = exchangeCode(asUrl, enrollmentCode);
        const attemptB = exchangeCode(asUrl, enrollmentCode);
        try {
          // Rendezvous 1: both attempts have durably created identity with
          // zero credential rows written.
          await Promise.all([identityArrivals[0].promise, identityArrivals[1].promise]);
          const credentialsAtIdentity = await postgresQuery("SELECT credential_id FROM device_ingest_credentials");
          assert.equal(
            credentialsAtIdentity.rows.length,
            0,
            "both attempts must be held with zero credential rows written — this is the exact race window"
          );
          const devicesAtIdentity = await postgresQuery("SELECT device_id FROM device_exporters");
          assert.equal(devicesAtIdentity.rows.length, 1, "both attempts must have already converged on one device row");

          // Release both together into rotateDeviceCredential against the
          // guaranteed-empty credentials table.
          identityReleases[0].resolve();
          identityReleases[1].resolve();

          // Rendezvous 2: both attempts' OWN rotateDeviceCredential call
          // has returned; neither has consumed the code yet, so the
          // `!consumed` cleanup-rotation fallback cannot have run for
          // either.
          await Promise.all([rotationArrivals[0].promise, rotationArrivals[1].promise]);

          const activeAtRotation = await postgresQuery(
            "SELECT credential_id FROM device_ingest_credentials WHERE status = 'active'"
          );
          assert.equal(
            activeAtRotation.rows.length,
            1,
            `exactly one active credential must exist immediately after both racing rotations, before either consumes or any cleanup rotation can run — found ${activeAtRotation.rows.length}`
          );
          const allAtRotation = await postgresQuery("SELECT credential_id, status FROM device_ingest_credentials");
          assert.equal(
            allAtRotation.rows.length,
            2,
            "both attempts must each have written a credential row (one active, one revoked by the other's rotation)"
          );

          // Release both into consumeEnrollmentCode / the response.
          releaseAll();

          const [respA, respB] = await Promise.all([attemptA, attemptB]);
          for (const [label, resp] of [
            ["A", respA],
            ["B", respB],
          ] as [string, typeof respA][]) {
            assert.equal(resp.status, 201, `attempt ${label} must return 201, got: ${JSON.stringify(resp.body)}`);
          }
          assert.equal(respA.body.device_id, respB.body.device_id, "both attempts must resolve to the same device");

          const activeFinal = await postgresQuery(
            "SELECT credential_id FROM device_ingest_credentials WHERE status = 'active'"
          );
          assert.equal(
            activeFinal.rows.length,
            1,
            `exactly one active credential must exist in the final state, found ${activeFinal.rows.length}`
          );

          // The winning token must actually authenticate; the loser's token
          // must not (it was revoked).
          const heartbeats = await Promise.all(
            [respA, respB].map((resp) =>
              postJson(
                `${asUrl}/_ref/device-exporters/${encodeURIComponent(String(resp.body.device_id))}/heartbeat`,
                { status: "healthy" },
                { Authorization: `Bearer ${String(resp.body.device_token)}`, ...PROTOCOL_HEADERS }
              )
            )
          );
          const workingCount = heartbeats.filter((r) => r.status === 200).length;
          assert.equal(
            workingCount,
            1,
            "exactly one of the two held attempts' tokens must be the current active credential"
          );
        } finally {
          // Whether the assertions above passed or threw, unblock any
          // still-held attempt and wait for both requests to actually settle
          // before the outer finally tears the server down.
          releaseAll();
          __setEnrollPhaseFaultHookForTest(null);
          await Promise.allSettled([attemptA, attemptB]);
        }
      } finally {
        __setEnrollPhaseFaultHookForTest(null);
        await closeServer(server);
        await closePostgresStorage().catch(() => undefined);
        closeDb();
      }
    }
  );
});

// D6 (Postgres, deterministic — critical mid-turn correction, 2026-07-25):
// the D5 identity fix derived device_id/source_instance_id from
// enrollment.enrollmentCodeId, which is minted fresh every time
// POST /enrollment-codes runs. That is the WRONG stable key: it made a retry
// of the SAME code idempotent, but a NEW code minted for the SAME physical
// collector/binding — the real live scenario when a partial-write code
// expires before it can be retried — would derive a DIFFERENT device id,
// leak a second orphaned device/source-instance pair, and still collide on
// the connector_instances row (keyed on owner/connector/binding, independent
// of the code). D6 re-derives from the STABLE (owner, connector,
// sourceBindingKey) tuple instead — the SAME tuple connector_instances
// already uses — so ANY code ever minted for the same collector converges on
// the same identity, with no special-casing of specific live IDs and no
// manual DB cleanup required.
//
// This test reproduces the exact live scenario: code A reaches identity
// creation then fails before consume (the D5 fault-injection hook); code A's
// expiry is moved into the past (simulating real time passing without a
// retry); code B is minted for the SAME connector + local binding and
// exchanged. Asserts: code B succeeds and adopts the identity code A's
// partial attempt left (no new/second device, connector instance, or source
// instance); the final state has exactly one active device, one connector
// instance, one source instance, one active credential; code A remains
// expired and was never consumed or resurrected.
test("D6 (Postgres): a fresh code for the same binding adopts an expired code's partial-write identity with no manual cleanup", {
  skip: DEDICATED_POSTGRES_URL ? false : "set PDPP_TEST_POSTGRES_URL to the dedicated loopback listener",
}, async () => {
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: DEDICATED_POSTGRES_URL ?? "",
      databaseName: tempDbName(),
    },
    async (url) => {
      initDb(":memory:");
      const server = await startServer({
        asPort: 0,
        databaseUrl: url,
        dbPath: ":memory:",
        quiet: true,
        rsPort: 0,
        storageBackend: "postgres",
      });
      await server.startupBackfillDone.catch(() => undefined);
      const asUrl = `http://localhost:${server.asPort}`;
      try {
        const codeA = await mintCode(asUrl, "codex-d6-stable-binding");

        // Code A: identity creation succeeds, the injected fault throws
        // before consume — the exact live partial-write shape.
        __setEnrollPhaseFaultHookForTest((point) => {
          if (point === "after_identity_before_consume") {
            throw new Error("injected: code A fails after identity creation, before consume");
          }
        });
        try {
          await exchangeCode(asUrl, codeA);
        } finally {
          __setEnrollPhaseFaultHookForTest(null);
        }

        const codeARow = await postgresQuery(
          "SELECT enrollment_code_id, status, expires_at FROM device_enrollment_codes WHERE local_binding_id = $1",
          ["codex-d6-stable-binding"]
        );
        assert.equal(codeARow.rows.length, 1, "exactly one enrollment-code row for this binding must exist so far");
        const [codeARow0] = codeARow.rows;
        assert.ok(codeARow0);
        assert.equal(codeARow0.status, "pending", "code A must remain pending after its partial attempt");

        const devicesAfterA = await postgresQuery("SELECT device_id FROM device_exporters");
        assert.equal(
          devicesAfterA.rows.length,
          1,
          "code A's partial attempt must have left exactly one orphaned device row"
        );
        const [devicesAfterA0] = devicesAfterA.rows;
        assert.ok(devicesAfterA0);
        const orphanedDeviceId = devicesAfterA0.device_id;

        // Move code A's expiry into the past — simulates the live scenario
        // where the operator does not retry code A before it lapses.
        await postgresQuery("UPDATE device_enrollment_codes SET expires_at = $1 WHERE enrollment_code_id = $2", [
          "2020-01-01T00:00:00.000Z",
          codeARow0.enrollment_code_id,
        ]);

        // Code A is now unusable: exchanging it must fail closed as expired,
        // not silently resume the orphaned identity.
        const codeAExpiredRetry = await exchangeCode(asUrl, codeA);
        assert.equal(codeAExpiredRetry.status, 410, "code A must fail closed as expired, not resume");
        assert.ok(!codeAExpiredRetry.body.device_token, "an expired code must never return a device token");

        // A FRESH code (code B) minted for the SAME connector + local binding
        // — the real remediation an operator takes for a lapsed code, no DB
        // access required.
        const codeB = await mintCode(asUrl, "codex-d6-stable-binding");
        const enrolledB = await exchangeCode(asUrl, codeB);
        assert.equal(enrolledB.status, 201, `code B must enroll successfully, got: ${JSON.stringify(enrolledB.body)}`);
        assert.ok(enrolledB.body.device_token, "code B must return a working device token");

        // Code B must ADOPT code A's orphaned identity — not fork a second one.
        assert.equal(
          enrolledB.body.device_id,
          orphanedDeviceId,
          "code B must resolve to the SAME device code A's partial attempt already created, not a new one"
        );

        // Final convergence: exactly one of everything, system-wide for this
        // binding — no orphan left behind, no duplicate created.
        const devicesFinal = await postgresQuery("SELECT device_id FROM device_exporters");
        assert.equal(devicesFinal.rows.length, 1, "exactly one device must exist in the final state");

        const connectorInstancesFinal = await postgresQuery(
          "SELECT connector_instance_id FROM connector_instances WHERE connector_id = $1",
          ["codex"]
        );
        assert.equal(
          connectorInstancesFinal.rows.length,
          1,
          "exactly one connector instance must exist in the final state"
        );

        const sourceInstancesFinal = await postgresQuery(
          "SELECT source_instance_id FROM device_source_instances WHERE device_id = $1",
          [orphanedDeviceId]
        );
        assert.equal(sourceInstancesFinal.rows.length, 1, "exactly one source instance must exist in the final state");

        const activeCredentialsFinal = await postgresQuery(
          "SELECT credential_id FROM device_ingest_credentials WHERE device_id = $1 AND status = 'active'",
          [orphanedDeviceId]
        );
        assert.equal(
          activeCredentialsFinal.rows.length,
          1,
          "exactly one active credential must exist in the final state"
        );

        // Code A stays fail-closed — the expiry check revokes a pending code
        // on the first expired exchange attempt (revokeEnrollmentCode:
        // status -> 'revoked'); never consumed, never resurrected by code B's
        // success.
        const codeAFinal = await postgresQuery(
          "SELECT status, device_id FROM device_enrollment_codes WHERE enrollment_code_id = $1",
          [codeARow0.enrollment_code_id]
        );
        const [codeAFinal0] = codeAFinal.rows;
        assert.ok(codeAFinal0);
        assert.equal(codeAFinal0.status, "revoked", "code A must be revoked by the expiry check, never resurrected");
        assert.equal(codeAFinal0.device_id, null, "code A must never be marked consumed/bound to a device");

        // Code B's own row is the one actually consumed.
        const codeAHashRow = await postgresQuery(
          "SELECT code_hash FROM device_enrollment_codes WHERE enrollment_code_id = $1",
          [codeARow0.enrollment_code_id]
        );
        const [codeAHashRow0] = codeAHashRow.rows;
        assert.ok(codeAHashRow0);
        const codeBRow = await postgresQuery(
          "SELECT status, device_id FROM device_enrollment_codes WHERE code_hash != $1 AND local_binding_id = $2",
          [codeAHashRow0.code_hash, "codex-d6-stable-binding"]
        );
        assert.equal(codeBRow.rows.length, 1, "code B row must exist distinct from code A");
        const [codeBRow0] = codeBRow.rows;
        assert.ok(codeBRow0);
        assert.equal(codeBRow0.status, "consumed", "code B must be the one actually consumed");
        assert.equal(codeBRow0.device_id, orphanedDeviceId);

        // The token code B returned must actually authenticate.
        const heartbeat = await postJson(
          `${asUrl}/_ref/device-exporters/${encodeURIComponent(String(enrolledB.body.device_id))}/heartbeat`,
          { status: "healthy" },
          { Authorization: `Bearer ${String(enrolledB.body.device_token)}`, ...PROTOCOL_HEADERS }
        );
        assert.equal(heartbeat.status, 200, JSON.stringify(heartbeat.body));
      } finally {
        __setEnrollPhaseFaultHookForTest(null);
        await closeServer(server);
        await closePostgresStorage().catch(() => undefined);
        closeDb();
      }
    }
  );
});

// D6 isolation: two DIFFERENT physical collectors (distinct local binding
// names) for the same owner/connector must NEVER converge on the same
// identity, even though both go through the same D6 binding-keyed derivation.
test("D6 isolation (Postgres): two distinct local bindings for the same connector never collide", {
  skip: DEDICATED_POSTGRES_URL ? false : "set PDPP_TEST_POSTGRES_URL to the dedicated loopback listener",
}, async () => {
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: DEDICATED_POSTGRES_URL ?? "",
      databaseName: tempDbName(),
    },
    async (url) => {
      initDb(":memory:");
      const server = await startServer({
        asPort: 0,
        databaseUrl: url,
        dbPath: ":memory:",
        quiet: true,
        rsPort: 0,
        storageBackend: "postgres",
      });
      await server.startupBackfillDone.catch(() => undefined);
      const asUrl = `http://localhost:${server.asPort}`;
      try {
        const deviceX = await enrollDevice(asUrl, "codex-d6-binding-x");
        const deviceY = await enrollDevice(asUrl, "codex-d6-binding-y");

        assert.notEqual(
          deviceX.device_id,
          deviceY.device_id,
          "distinct physical collectors must never share a device id"
        );
        assert.notEqual(
          deviceX.connector_instance_id,
          deviceY.connector_instance_id,
          "distinct physical collectors must never share a connector instance"
        );
        assert.notEqual(deviceX.source_instance_id, deviceY.source_instance_id);

        const devices = await postgresQuery("SELECT device_id FROM device_exporters");
        assert.equal(devices.rows.length, 2, "exactly two independent devices must exist");

        // A FRESH code minted for X's binding after X is already fully
        // enrolled (a consumed code exists for X) is a genuine new
        // enrollment, not an orphan resume — it legitimately mints a NEW
        // device for X (matching the pre-existing "re-enroll forks a fresh
        // device_id, resumes the connector_instance" contract in
        // device-exporter-routes.test.ts), while still resuming the SAME
        // connector_instance and never crossing to Y's identity.
        const retryCodeX = await mintCode(asUrl, "codex-d6-binding-x");
        const retryX = await exchangeCode(asUrl, retryCodeX);
        assert.equal(retryX.status, 201);
        assert.notEqual(
          retryX.body.device_id,
          deviceX.device_id,
          "a fresh code for an already-completed binding mints a new device"
        );
        assert.notEqual(retryX.body.device_id, deviceY.device_id, "must never cross to Y's identity");
        assert.equal(
          retryX.body.connector_instance_id,
          deviceX.connector_instance_id,
          "the connector_instance stays stable across re-enrollment"
        );

        const devicesAfterRetry = await postgresQuery("SELECT device_id FROM device_exporters");
        assert.equal(devicesAfterRetry.rows.length, 3, "X gained a new device, Y is unaffected: three devices total");
      } finally {
        await closeServer(server);
        await closePostgresStorage().catch(() => undefined);
        closeDb();
      }
    }
  );
});

test("D7 (Postgres): local_device and browser_collector enrollments sharing owner+connector+binding never adopt or collide", {
  skip: DEDICATED_POSTGRES_URL ? false : "set PDPP_TEST_POSTGRES_URL to the dedicated loopback listener",
}, async () => {
  // Design D7 (fix-enroll-source-kind-identity-gap). resolveOrCreateEnrollmentDevice's
  // lock key and orphan query are now qualified by sourceKind, not just
  // (owner, connector, binding). This drives resolveOrCreateEnrollmentDevice
  // directly (the store layer under test, not just the route) with the SAME
  // ownerSubjectId + connectorId + localBindingId but two DISTINCT sourceKind
  // values — exactly the scenario the pre-D7 gap could not distinguish — and
  // proves neither an orphan nor a live device from one kind is ever adopted
  // by, or blocks, the other kind's identity resolution.
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: DEDICATED_POSTGRES_URL ?? "",
      databaseName: tempDbName(),
    },
    async (url) => {
      initDb(":memory:");
      const server = await startServer({
        asPort: 0,
        databaseUrl: url,
        dbPath: ":memory:",
        quiet: true,
        rsPort: 0,
        storageBackend: "postgres",
      });
      await server.startupBackfillDone.catch(() => undefined);
      try {
        const store = createPostgresDeviceExporterStore();
        const ownerSubjectId = "owner_d7_cross_kind";
        const connectorId = "codex";
        const localBindingId = "shared-binding-name";
        const now = new Date().toISOString();

        // Both kinds start with NO orphan and NO live device: each resolves
        // to its OWN fresh device despite sharing owner+connector+binding.
        const localResolved = await store.resolveOrCreateEnrollmentDevice({
          candidateDeviceId: "dexp_d7_local_1",
          candidateSourceInstanceId: "dsrc_d7_local_1",
          collectorProtocolVersion: null,
          connectorId,
          displayName: "local device",
          localBindingId,
          now,
          ownerSubjectId,
          sourceKind: "local_device",
        });
        const browserResolved = await store.resolveOrCreateEnrollmentDevice({
          candidateDeviceId: "dexp_d7_browser_1",
          candidateSourceInstanceId: "dsrc_d7_browser_1",
          collectorProtocolVersion: null,
          connectorId,
          displayName: "browser collector",
          localBindingId,
          now,
          ownerSubjectId,
          sourceKind: "browser_collector",
        });
        assert.equal(localResolved.adopted, false);
        assert.equal(browserResolved.adopted, false);
        assert.notEqual(
          localResolved.deviceId,
          browserResolved.deviceId,
          "local_device and browser_collector enrollments for the same owner+connector+binding must never share a device id"
        );

        // Fail both attempts before consume, so both are orphans under their
        // OWN kind — mirroring D6's partial-write scenario, per kind.
        await store.upsertSourceInstance({
          connectorId,
          connectorInstanceId: "cin_d7_local_placeholder",
          createdAt: now,
          deviceId: localResolved.deviceId,
          displayName: "local device",
          localBindingId,
          sourceInstanceId: localResolved.sourceInstanceId,
          sourceKind: "local_device",
          updatedAt: now,
        });
        await store.upsertSourceInstance({
          connectorId,
          connectorInstanceId: "cin_d7_browser_placeholder",
          createdAt: now,
          deviceId: browserResolved.deviceId,
          displayName: "browser collector",
          localBindingId,
          sourceInstanceId: browserResolved.sourceInstanceId,
          sourceKind: "browser_collector",
          updatedAt: now,
        });

        // A SECOND local_device attempt (e.g. a fresh code after the first
        // expired) must adopt the LOCAL orphan only — never the browser
        // orphan, even though both share owner+connector+binding and both
        // are equally eligible by every predicate except sourceKind.
        const localRetry = await store.resolveOrCreateEnrollmentDevice({
          candidateDeviceId: "dexp_d7_local_2",
          candidateSourceInstanceId: "dsrc_d7_local_2",
          collectorProtocolVersion: null,
          connectorId,
          displayName: "local device retry",
          localBindingId,
          now,
          ownerSubjectId,
          sourceKind: "local_device",
        });
        assert.equal(localRetry.adopted, true, "a second local_device attempt must adopt the local_device orphan");
        assert.equal(
          localRetry.deviceId,
          localResolved.deviceId,
          "must adopt the SAME-kind orphan, not create a third device"
        );
        assert.notEqual(localRetry.deviceId, browserResolved.deviceId, "must never adopt the browser_collector orphan");

        // Symmetric check for browser_collector.
        const browserRetry = await store.resolveOrCreateEnrollmentDevice({
          candidateDeviceId: "dexp_d7_browser_2",
          candidateSourceInstanceId: "dsrc_d7_browser_2",
          collectorProtocolVersion: null,
          connectorId,
          displayName: "browser collector retry",
          localBindingId,
          now,
          ownerSubjectId,
          sourceKind: "browser_collector",
        });
        assert.equal(
          browserRetry.adopted,
          true,
          "a second browser_collector attempt must adopt the browser_collector orphan"
        );
        assert.equal(
          browserRetry.deviceId,
          browserResolved.deviceId,
          "must adopt the SAME-kind orphan, not create a third device"
        );
        assert.notEqual(browserRetry.deviceId, localResolved.deviceId, "must never adopt the local_device orphan");

        // Exactly two independent devices exist for this owner+connector+binding
        // — one per kind — never merged, never a third spurious device.
        const devices = await postgresQuery(
          "SELECT device_id FROM device_exporters WHERE owner_subject_id = $1 ORDER BY device_id",
          [ownerSubjectId]
        );
        assert.equal(
          devices.rows.length,
          2,
          "exactly one device per source kind must exist, never merged or duplicated"
        );

        // Mutation-grade proof: querying WITHOUT the source_kind predicate
        // (the pre-D7 shape) would see BOTH rows as one ambiguous orphan set
        // for either kind, proving the predicate is load-bearing rather than
        // incidental.
        const withoutKindPredicate = await postgresQuery(
          `SELECT dsi.device_id
             FROM device_source_instances dsi
             JOIN device_exporters de ON de.device_id = dsi.device_id
            WHERE de.owner_subject_id = $1
              AND dsi.connector_id = $2
              AND dsi.local_binding_id = $3
              AND dsi.status != 'revoked'
              AND de.status != 'revoked'
              AND NOT EXISTS (
                SELECT 1 FROM device_enrollment_codes dec
                WHERE dec.device_id = dsi.device_id AND dec.status = 'consumed'
              )`,
          [ownerSubjectId, connectorId, localBindingId]
        );
        assert.equal(
          withoutKindPredicate.rows.length,
          2,
          "without the source_kind predicate the orphan set is ambiguous across kinds — proving the predicate is load-bearing"
        );
      } finally {
        await closeServer(server);
        await closePostgresStorage().catch(() => undefined);
        closeDb();
      }
    }
  );
});

test("D8 (Postgres): retrying against a legacy completed binding whose connector_instance_id predates the deterministic id formula recovers by migrating the legacy row in place, with no manual cleanup", {
  skip: DEDICATED_POSTGRES_URL ? false : "set PDPP_TEST_POSTGRES_URL to the dedicated loopback listener",
}, async () => {
  // Design D8 (fix-enroll-connector-instance-pk-collision). Live counterexample:
  // a legacy, already-completed connector_instances row for (owner, codex,
  // vivid-fish) computed its source_binding_key from the OLDER, larger
  // sourceBinding shape (kind + device_id + local_binding_name +
  // source_instance_id) that predates deviceExporterSourceBindingIdentity's
  // stable {kind, local_binding_name}-only shape. This is the SAME logical
  // binding as any fresh enrollment for (owner_local, codex, vivid-fish) —
  // only its key derivation is stale. A partial-write orphan for the same
  // binding (source_kind local_device, connector_instance_id NULL, from a
  // first attempt that failed before consume) exists alongside it. Every
  // retry of a fresh pending code for this binding hit `INSERT ...
  // ON CONFLICT(owner, connector, source_kind, source_binding_key) DO
  // UPDATE` — but the legacy row's OWN (stale) source_binding_key never
  // matches today's stable key, so the ON CONFLICT target never matches the
  // legacy row and Postgres attempts a fresh INSERT — which collides on the
  // PRIMARY KEY (connector_instance_id) against that SAME legacy row,
  // because today's deterministic id formula computes the SAME id the
  // legacy row already holds. This surfaced as a raw 23505 mapped to a
  // permanent 503 enrollment_identity_conflict on every retry, with no
  // operator remediation available through the API. The fix recognizes the
  // colliding row is provably the SAME logical binding and migrates its key
  // in place, in a single connector_instance_id, rather than forking a
  // second row or touching an unrelated one.
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: DEDICATED_POSTGRES_URL ?? "",
      databaseName: tempDbName(),
    },
    async (url) => {
      initDb(":memory:");
      const server = await startServer({
        asPort: 0,
        databaseUrl: url,
        dbPath: ":memory:",
        quiet: true,
        rsPort: 0,
        storageBackend: "postgres",
      });
      await server.startupBackfillDone.catch(() => undefined);
      const asUrl = `http://localhost:${server.asPort}`;
      try {
        const ownerSubjectId = "owner_local";
        const legacyDeviceId = "dexp_b07c56a6e71de9ae";
        const legacySourceInstanceId = "dsrc_fbff3caefba6c972";
        // The exact live id: today's makeConnectorInstanceId formula
        // deterministically computes this SAME id for (owner_local, codex,
        // local_device, {kind:'local_device', local_binding_name:'vivid-fish'})
        // — reproducing the real coincidental PK collision, not a synthetic
        // stand-in id chosen to force a failure.
        const legacyConnectorInstanceId = "cin_da9889ea09f0132af33c2f4e";
        // The legacy source_binding_key: a hash of the OLDER, larger binding
        // shape {kind, device_id, local_binding_name, source_instance_id} —
        // distinct from today's {kind, local_binding_name}-only key, which is
        // exactly why the ON CONFLICT target cannot find this row.
        const legacySourceBindingKey = "6432f1862f0447383db425ceb4aef3b65fadb1c3c86645bd262629742581984d";
        const now = new Date().toISOString();

        await postgresQuery(
          `INSERT INTO device_exporters(device_id, owner_subject_id, display_name, status, agent_version, collector_protocol_version, last_heartbeat_at, last_error_json, created_at, updated_at, revoked_at)
           VALUES($1, $2, 'vivid-fish', 'active', NULL, NULL, NULL, NULL, $3, $3, NULL)`,
          [legacyDeviceId, ownerSubjectId, now]
        );
        await postgresQuery(
          `INSERT INTO connectors(connector_id, manifest) VALUES('codex', '{"connector_id":"codex","streams":[]}'::jsonb) ON CONFLICT DO NOTHING`
        );
        await postgresQuery(
          `INSERT INTO connector_instances(connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at)
           VALUES($1, $2, 'codex', 'vivid-fish', 'active', 'local_device', $3, $4::jsonb, $5, $5, NULL)`,
          [
            legacyConnectorInstanceId,
            ownerSubjectId,
            legacySourceBindingKey,
            JSON.stringify({
              device_id: legacyDeviceId,
              kind: "local_device",
              local_binding_name: "vivid-fish",
              source_instance_id: legacySourceInstanceId,
            }),
            now,
          ]
        );
        await postgresQuery(
          `INSERT INTO device_source_instances(source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id, source_kind, display_name, status, last_error_json, created_at, updated_at, revoked_at)
           VALUES($1, $2, 'codex', $3, 'vivid-fish', NULL, 'vivid-fish', 'active', NULL, $4, $4, NULL)`,
          [legacySourceInstanceId, legacyDeviceId, legacyConnectorInstanceId, now]
        );
        await postgresQuery(
          `INSERT INTO device_enrollment_codes(enrollment_code_id, code_hash, owner_subject_id, connector_id, local_binding_id, display_name, device_id, status, created_at, expires_at, consumed_at, revoked_at)
           VALUES('denroll_legacy_completed', 'hash_legacy_completed', $1, 'codex', 'vivid-fish', NULL, $2, 'consumed', $3, $3, $3, NULL)`,
          [ownerSubjectId, legacyDeviceId, now]
        );

        // The partial-write orphan: a first attempt for a LATER code that
        // durably created a device + source-instance row for this binding
        // (source_kind local_device, connector_instance_id still NULL —
        // the crash happened before the connector-instance upsert step)
        // but never consumed its code.
        const orphanDeviceId = "dexp_3fab667e951ed1d7";
        const orphanSourceId = "dsrc_83b8eae8f40c5b86";
        await postgresQuery(
          `INSERT INTO device_exporters(device_id, owner_subject_id, display_name, status, agent_version, collector_protocol_version, last_heartbeat_at, last_error_json, created_at, updated_at, revoked_at)
           VALUES($1, $2, 'vivid-fish', 'active', NULL, NULL, NULL, NULL, $3, $3, NULL)`,
          [orphanDeviceId, ownerSubjectId, now]
        );
        await postgresQuery(
          `INSERT INTO device_source_instances(source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id, source_kind, display_name, status, last_error_json, created_at, updated_at, revoked_at)
           VALUES($1, $2, 'codex', NULL, 'vivid-fish', 'local_device', 'vivid-fish', 'active', NULL, $3, $3, NULL)`,
          [orphanSourceId, orphanDeviceId, now]
        );

        // A fresh pending code for the SAME binding — the exact live
        // remediation path (the only one available once an earlier code
        // expires) — must recover with no manual DB cleanup.
        const freshCode = await mintCode(asUrl, "vivid-fish", "codex");

        // Mutation-grade: the pre-D8 code hits this 23505 on EVERY retry,
        // deterministically — assert across three consecutive attempts, not
        // just the first, since the live symptom was "every retry fails
        // identically." Attempts are necessarily sequential: each retry is
        // a new HTTP round-trip that must observe the previous attempt's DB state.
        async function assertIdempotentAttempt(attemptNumber: number) {
          const resp = await exchangeCode(asUrl, freshCode);
          assert.equal(
            resp.status,
            201,
            `attempt ${attemptNumber} must succeed with no manual cleanup, got ${resp.status}: ${JSON.stringify(resp.body)}`
          );
          // Idempotent: every attempt converges on the SAME resolved
          // identity, not a new row per retry.
          assert.equal(resp.body.device_id, orphanDeviceId, "must adopt the orphan device, not mint a new one");
          // The legacy row's own connector_instance_id is REUSED — this is
          // the SAME logical binding, migrated in place, never a second row.
          assert.equal(
            resp.body.connector_instance_id,
            legacyConnectorInstanceId,
            "the fresh enroll must migrate the legacy row in place and reuse its connector_instance_id, not fork a second connector instance"
          );
          return resp;
        }
        const lastAttempt = await assertIdempotentAttempt(1)
          .then(() => assertIdempotentAttempt(2))
          .then(() => assertIdempotentAttempt(3));

        // The legacy row survives under the SAME id, now migrated to the
        // current stable source_binding_key/source_binding_json shape.
        const migratedRow = await postgresQuery(
          "SELECT connector_instance_id, source_binding_key, source_binding_json, status FROM connector_instances WHERE connector_instance_id = $1",
          [legacyConnectorInstanceId]
        );
        assert.equal(migratedRow.rows.length, 1, "the legacy connector instance row must survive under its own id");
        const [migratedRow0] = migratedRow.rows;
        assert.ok(migratedRow0);
        assert.notEqual(
          migratedRow0.source_binding_key,
          legacySourceBindingKey,
          "the stale legacy key must be migrated to the current stable key, not left as-is"
        );
        const migratedBinding =
          typeof migratedRow0.source_binding_json === "string"
            ? JSON.parse(migratedRow0.source_binding_json as string)
            : migratedRow0.source_binding_json;
        assert.equal((migratedBinding as Record<string, unknown>).kind, "local_device");
        assert.equal((migratedBinding as Record<string, unknown>).local_binding_name, "vivid-fish");
        assert.equal(migratedRow0.status, "active");

        // Exactly ONE connector instance exists for this owner+connector+
        // binding — the legacy row, migrated — never a spurious second row
        // forked alongside it.
        const allInstances = await postgresQuery(
          `SELECT connector_instance_id FROM connector_instances WHERE owner_subject_id = $1 AND connector_id = 'codex' AND status = 'active'`,
          [ownerSubjectId]
        );
        assert.equal(
          allInstances.rows.length,
          1,
          "exactly one connector instance must exist for this binding — the legacy row, migrated in place, never a duplicate"
        );

        // The resolved token actually authenticates.
        const heartbeat = await postJson(
          `${asUrl}/_ref/device-exporters/${encodeURIComponent(String(lastAttempt.body.device_id))}/heartbeat`,
          {},
          { Authorization: `Bearer ${String(lastAttempt.body.device_token)}`, ...PROTOCOL_HEADERS }
        );
        assert.equal(heartbeat.status, 200, JSON.stringify(heartbeat.body));
      } finally {
        await closeServer(server);
        await closePostgresStorage().catch(() => undefined);
        closeDb();
      }
    }
  );
});

test("D9 (Postgres): restart coalesces an exact post-enrollment legacy/stable duplicate without losing its state", {
  skip: DEDICATED_POSTGRES_URL ? false : "set PDPP_TEST_POSTGRES_URL to the dedicated loopback listener",
}, async () => {
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: DEDICATED_POSTGRES_URL ?? "",
      databaseName: tempDbName(),
    },
    async (url) => {
      initDb(":memory:");
      let server = await startServer({
        asPort: 0,
        autoEnrollEligibleSchedules: false,
        databaseUrl: url,
        dbPath: ":memory:",
        quiet: true,
        rsPort: 0,
        storageBackend: "postgres",
      });
      await server.startupBackfillDone.catch(() => undefined);
      const now = new Date().toISOString();
      const ownerSubjectId = "owner_local";
      const deviceId = "dexp_3fab667e951ed1d7";
      const sourceInstanceId = "dsrc_83b8eae8f40c5b86";
      const canonicalId = "cin_da9889ea09f0132af33c2f4e";
      const legacyId = "cin_ed74ea9b5c76cb51d2665a63";
      const fullBinding = {
        device_id: deviceId,
        kind: "local_device",
        local_binding_name: "vivid-fish",
        source_instance_id: sourceInstanceId,
      };
      const stableBindingKey = createHash("sha256")
        .update('{"kind":"local_device","local_binding_name":"vivid-fish"}')
        .digest("hex");
      const legacyBindingKey = createHash("sha256").update(JSON.stringify(fullBinding)).digest("hex");
      try {
        // This is the live post-enrollment shape: the exact source row points
        // to the stable row, while the obsolete full-binding-key row remains.
        await postgresQuery(
          `INSERT INTO connectors(connector_id, manifest) VALUES('codex', '{"connector_id":"codex","streams":[]}'::jsonb) ON CONFLICT DO NOTHING`
        );
        await postgresQuery(
          `INSERT INTO device_exporters(device_id, owner_subject_id, display_name, status, created_at, updated_at)
           VALUES($1, $2, 'vivid-fish', 'active', $3, $3)`,
          [deviceId, ownerSubjectId, now]
        );
        await Promise.all(
          (
            [
              [canonicalId, stableBindingKey],
              [legacyId, legacyBindingKey],
            ] as [string, string][]
          ).map(([id, key]) =>
            postgresQuery(
              `INSERT INTO connector_instances(connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at)
             VALUES($1, $2, 'codex', 'vivid-fish', 'active', 'local_device', $3, $4::jsonb, $5, $5)`,
              [id, ownerSubjectId, key, JSON.stringify(fullBinding), now]
            )
          )
        );
        await postgresQuery(
          `INSERT INTO device_source_instances(source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id, source_kind, display_name, status, created_at, updated_at)
           VALUES($1, $2, 'codex', $3, 'vivid-fish', 'local_device', 'vivid-fish', 'active', $4, $4)`,
          [sourceInstanceId, deviceId, canonicalId, now]
        );
        await postgresQuery(
          `INSERT INTO connector_state(connector_id, connector_instance_id, stream, state_json, updated_at)
           VALUES('codex', $1, 'messages', '{"cursor":"preserved"}'::jsonb, $2)`,
          [legacyId, now]
        );
        await postgresQuery(
          `INSERT INTO connector_instance_credentials(
             connector_instance_id, owner_subject_id, credential_kind, sealed_secret, fingerprint,
             status, captured_at, rotated_at, revoked_at, rejected_at, rejection_reason
           ) VALUES($1, $2, 'api_key', 'sealed-preserved', 'fp-preserved', 'active', $3, NULL, NULL, NULL, NULL)`,
          [legacyId, ownerSubjectId, now]
        );
        // Exact live projection topology: both identities have derived
        // summary evidence, and their lexical metadata overlaps. These are
        // rebuildable caches, not competing authoritative state.
        await Promise.all(
          [canonicalId, legacyId].map((id) =>
            postgresQuery(
              `INSERT INTO connector_summary_evidence(connector_instance_id, connector_id, manifest_generation)
             VALUES($1, 'codex', 1)`,
              [id]
            )
          )
        );
        await Promise.all(
          (
            [
              [canonicalId, 7],
              [legacyId, 6],
            ] as [string, number][]
          ).flatMap(([id, streamCount]) =>
            Array.from({ length: streamCount }, (_, i) => i + 1).map((stream) =>
              postgresQuery(
                `INSERT INTO lexical_search_meta(connector_id, connector_instance_id, stream, fields_fingerprint, updated_at)
               VALUES('codex', $1, $2, $3, $4)`,
                [id, `stream_${stream}`, `fingerprint_${id}_${stream}`, now]
              )
            )
          )
        );

        await closeServer(server);
        await closePostgresStorage();
        closeDb();
        server = await startServer({
          asPort: 0,
          autoEnrollEligibleSchedules: false,
          databaseUrl: url,
          dbPath: ":memory:",
          quiet: true,
          rsPort: 0,
          storageBackend: "postgres",
        });
        await server.startupBackfillDone.catch(() => undefined);

        const instances = await postgresQuery(
          `SELECT connector_instance_id, source_binding_key, source_binding_json FROM connector_instances WHERE owner_subject_id = $1 AND connector_id = 'codex' ORDER BY connector_instance_id`,
          [ownerSubjectId]
        );
        assert.equal(instances.rows.length, 1);
        assert.equal(instances.rows[0]?.connector_instance_id, canonicalId);
        assert.equal(instances.rows[0]?.source_binding_key, stableBindingKey);
        assert.deepEqual(
          instances.rows[0]?.source_binding_json,
          fullBinding,
          "stable keying must not erase full enrolled binding metadata"
        );
        const source = await postgresQuery(
          "SELECT connector_instance_id FROM device_source_instances WHERE source_instance_id = $1",
          [sourceInstanceId]
        );
        assert.equal(
          source.rows[0]?.connector_instance_id,
          canonicalId,
          "source must retain the enrolled canonical identity"
        );
        const state = await postgresQuery("SELECT connector_instance_id, state_json FROM connector_state");
        assert.equal(
          state.rows[0]?.connector_instance_id,
          canonicalId,
          "legacy-owned state must be repointed, never dropped"
        );
        const credential = await postgresQuery(
          "SELECT connector_instance_id, credential_kind, fingerprint, status FROM connector_instance_credentials"
        );
        assert.deepEqual(
          credential.rows,
          [
            {
              connector_instance_id: canonicalId,
              credential_kind: "api_key",
              fingerprint: "fp-preserved",
              status: "active",
            },
          ],
          "legacy-owned credentials must be repointed, never dropped"
        );
        const summary = await postgresQuery("SELECT connector_instance_id FROM connector_summary_evidence");
        assert.deepEqual(
          summary.rows,
          [{ connector_instance_id: canonicalId }],
          "canonical summary evidence must win over the rebuildable legacy projection"
        );
        const lexicalMeta = await postgresQuery(
          `SELECT connector_instance_id, count(*)::int AS count
             FROM lexical_search_meta
            WHERE connector_instance_id = ANY($1::text[])
            GROUP BY connector_instance_id`,
          [[canonicalId, legacyId]]
        );
        assert.deepEqual(
          lexicalMeta.rows,
          [{ connector_instance_id: canonicalId, count: 6 }],
          "canonical lexical metadata must be rebuilt from the manifest while the stale legacy projection is removed"
        );

        // A second independent boot is the idempotence oracle. The old
        // migration rewrote the binding every boot; this must now be a no-op.
        await closeServer(server);
        await closePostgresStorage();
        closeDb();
        server = await startServer({
          asPort: 0,
          autoEnrollEligibleSchedules: false,
          databaseUrl: url,
          dbPath: ":memory:",
          quiet: true,
          rsPort: 0,
          storageBackend: "postgres",
        });
        await server.startupBackfillDone.catch(() => undefined);
        const afterReentry = await postgresQuery(
          "SELECT connector_instance_id, source_binding_json FROM connector_instances WHERE owner_subject_id = $1 AND connector_id = $2",
          [ownerSubjectId, "codex"]
        );
        assert.deepEqual(
          afterReentry.rows,
          [{ connector_instance_id: canonicalId, source_binding_json: fullBinding }],
          "re-entry must retain full enrolled binding metadata"
        );
      } finally {
        await closeServer(server);
        await closePostgresStorage().catch(() => undefined);
        closeDb();
      }
    }
  );
});

test("D9 adversarial (Postgres): restart does not coalesce a near duplicate with a different enrolled source", {
  skip: DEDICATED_POSTGRES_URL ? false : "set PDPP_TEST_POSTGRES_URL to the dedicated loopback listener",
}, async () => {
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: DEDICATED_POSTGRES_URL ?? "",
      databaseName: tempDbName(),
    },
    async (url) => {
      initDb(":memory:");
      let server = await startServer({
        asPort: 0,
        autoEnrollEligibleSchedules: false,
        databaseUrl: url,
        dbPath: ":memory:",
        quiet: true,
        rsPort: 0,
        storageBackend: "postgres",
      });
      await server.startupBackfillDone.catch(() => undefined);
      const now = new Date().toISOString();
      const ownerSubjectId = "owner_local";
      const deviceId = "dexp_d9_near_duplicate";
      const sourceInstanceId = "dsrc_d9_enrolled";
      const canonicalId = "cin_d9_near_canonical";
      const legacyId = "cin_d9_near_legacy";
      const canonicalBinding = {
        device_id: deviceId,
        kind: "local_device",
        local_binding_name: "near-duplicate",
        source_instance_id: sourceInstanceId,
      };
      const nearLegacyBinding = {
        ...canonicalBinding,
        source_instance_id: "dsrc_d9_other_source",
      };
      const stableBindingKey = createHash("sha256")
        .update('{"kind":"local_device","local_binding_name":"near-duplicate"}')
        .digest("hex");
      try {
        await postgresQuery(
          `INSERT INTO connectors(connector_id, manifest) VALUES('codex', '{"connector_id":"codex","streams":[]}'::jsonb) ON CONFLICT DO NOTHING`
        );
        await postgresQuery(
          `INSERT INTO device_exporters(device_id, owner_subject_id, display_name, status, created_at, updated_at)
           VALUES($1, $2, 'near-duplicate', 'active', $3, $3)`,
          [deviceId, ownerSubjectId, now]
        );
        await postgresQuery(
          `INSERT INTO connector_instances(connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at)
           VALUES($1, $2, 'codex', 'near-duplicate', 'active', 'local_device', $3, $4::jsonb, $5, $5)`,
          [canonicalId, ownerSubjectId, stableBindingKey, JSON.stringify(canonicalBinding), now]
        );
        await postgresQuery(
          `INSERT INTO connector_instances(connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at)
           VALUES($1, $2, 'codex', 'near-duplicate', 'active', 'local_device', $3, $4::jsonb, $5, $5)`,
          [
            legacyId,
            ownerSubjectId,
            createHash("sha256").update(JSON.stringify(nearLegacyBinding)).digest("hex"),
            JSON.stringify(nearLegacyBinding),
            now,
          ]
        );
        await postgresQuery(
          `INSERT INTO device_source_instances(source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id, source_kind, display_name, status, created_at, updated_at)
           VALUES($1, $2, 'codex', $3, 'near-duplicate', 'local_device', 'near-duplicate', 'active', $4, $4)`,
          [sourceInstanceId, deviceId, canonicalId, now]
        );
        await postgresQuery(
          `INSERT INTO connector_state(connector_id, connector_instance_id, stream, state_json, updated_at)
           VALUES('codex', $1, 'messages', '{"cursor":"must-not-move"}'::jsonb, $2)`,
          [legacyId, now]
        );

        await closeServer(server);
        await closePostgresStorage();
        closeDb();
        server = await startServer({
          asPort: 0,
          autoEnrollEligibleSchedules: false,
          databaseUrl: url,
          dbPath: ":memory:",
          quiet: true,
          rsPort: 0,
          storageBackend: "postgres",
        });
        await server.startupBackfillDone.catch(() => undefined);

        const identities = await postgresQuery(
          "SELECT connector_instance_id FROM connector_instances WHERE connector_id = $1 ORDER BY connector_instance_id",
          ["codex"]
        );
        assert.deepEqual(
          identities.rows,
          [{ connector_instance_id: canonicalId }, { connector_instance_id: legacyId }],
          "a different source_instance_id is a near duplicate, never an exact identity to coalesce"
        );
        const state = await postgresQuery("SELECT connector_instance_id, state_json FROM connector_state");
        assert.deepEqual(
          state.rows,
          [{ connector_instance_id: legacyId, state_json: { cursor: "must-not-move" } }],
          "near-duplicate state must remain on its own identity"
        );
      } finally {
        await closeServer(server);
        await closePostgresStorage().catch(() => undefined);
        closeDb();
      }
    }
  );
});

test("D9 (Postgres): restart rejects colliding duplicate-owned state without changing either identity", {
  skip: DEDICATED_POSTGRES_URL ? false : "set PDPP_TEST_POSTGRES_URL to the dedicated loopback listener",
}, async () => {
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: DEDICATED_POSTGRES_URL ?? "",
      databaseName: tempDbName(),
    },
    async (url) => {
      initDb(":memory:");
      const server = await startServer({
        asPort: 0,
        databaseUrl: url,
        dbPath: ":memory:",
        quiet: true,
        rsPort: 0,
        storageBackend: "postgres",
      });
      await server.startupBackfillDone.catch(() => undefined);
      const now = new Date().toISOString();
      const deviceId = "dexp_d9_collision";
      const sourceInstanceId = "dsrc_d9_collision";
      const canonicalId = "cin_d9_canonical";
      const legacyId = "cin_d9_legacy";
      const fullBinding = {
        device_id: deviceId,
        kind: "local_device",
        local_binding_name: "collision",
        source_instance_id: sourceInstanceId,
      };
      const stableBindingKey = createHash("sha256")
        .update('{"kind":"local_device","local_binding_name":"collision"}')
        .digest("hex");
      const legacyBindingKey = createHash("sha256").update(JSON.stringify(fullBinding)).digest("hex");
      try {
        await postgresQuery(
          `INSERT INTO connectors(connector_id, manifest) VALUES('codex', '{"connector_id":"codex","streams":[]}'::jsonb) ON CONFLICT DO NOTHING`
        );
        await postgresQuery(
          `INSERT INTO device_exporters(device_id, owner_subject_id, display_name, status, created_at, updated_at) VALUES($1, 'owner_local', 'collision', 'active', $2, $2)`,
          [deviceId, now]
        );
        await Promise.all(
          (
            [
              [canonicalId, stableBindingKey],
              [legacyId, legacyBindingKey],
            ] as [string, string][]
          ).map(([id, key]) =>
            postgresQuery(
              `INSERT INTO connector_instances(connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at)
             VALUES($1, 'owner_local', 'codex', 'collision', 'active', 'local_device', $2, $3::jsonb, $4, $4)`,
              [id, key, JSON.stringify(fullBinding), now]
            )
          )
        );
        await postgresQuery(
          `INSERT INTO device_source_instances(source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id, source_kind, display_name, status, created_at, updated_at) VALUES($1, $2, 'codex', $3, 'collision', 'local_device', 'collision', 'active', $4, $4)`,
          [sourceInstanceId, deviceId, canonicalId, now]
        );
        await Promise.all(
          [canonicalId, legacyId].map((id) =>
            postgresQuery(
              `INSERT INTO connector_state(connector_id, connector_instance_id, stream, state_json, updated_at) VALUES('codex', $1, 'messages', '{"cursor":"different-owner-state"}'::jsonb, $2)`,
              [id, now]
            )
          )
        );

        await closeServer(server);
        await closePostgresStorage();
        closeDb();
        await assert.rejects(
          startServer({
            asPort: 0,
            databaseUrl: url,
            dbPath: ":memory:",
            quiet: true,
            rsPort: 0,
            storageBackend: "postgres",
          }),
          RE_CANNOT_COALESCE
        );
        await closePostgresStorage().catch(() => undefined);

        const verificationPool = new Pool({ connectionString: url });
        try {
          const identities = await verificationPool.query(
            "SELECT connector_instance_id FROM connector_instances WHERE connector_id = $1 ORDER BY connector_instance_id",
            ["codex"]
          );
          assert.deepEqual(
            identities.rows,
            [{ connector_instance_id: canonicalId }, { connector_instance_id: legacyId }],
            "failed coalescence must rollback both identities"
          );
          const state = await verificationPool.query(
            "SELECT connector_instance_id FROM connector_state ORDER BY connector_instance_id"
          );
          assert.deepEqual(
            state.rows,
            [{ connector_instance_id: canonicalId }, { connector_instance_id: legacyId }],
            "failed coalescence must preserve both owned-state rows"
          );
        } finally {
          await verificationPool.end();
        }
      } finally {
        await closeServer(server);
        await closePostgresStorage().catch(() => undefined);
        closeDb();
      }
    }
  );
});

test("D9 adversarial (Postgres): binding mutation after discovery is revalidated before any merge", {
  skip: DEDICATED_POSTGRES_URL ? false : "set PDPP_TEST_POSTGRES_URL to the dedicated loopback listener",
}, async () => {
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: DEDICATED_POSTGRES_URL ?? "",
      databaseName: tempDbName(),
    },
    async (url) => {
      initDb(":memory:");
      let server = await startServer({
        asPort: 0,
        autoEnrollEligibleSchedules: false,
        databaseUrl: url,
        dbPath: ":memory:",
        quiet: true,
        rsPort: 0,
        storageBackend: "postgres",
      });
      await server.startupBackfillDone.catch(() => undefined);
      const canonicalId = "cin_d9_binding_canonical";
      const legacyId = "cin_d9_binding_legacy";
      try {
        await seedD9ExactDuplicateClass({
          canonicalId,
          deviceId: "dexp_d9_binding",
          legacyIds: [legacyId],
          localBindingName: "binding-race",
          sourceInstanceId: "dsrc_d9_binding",
        });
        await postgresQuery(
          `INSERT INTO connector_state(connector_id, connector_instance_id, stream, state_json, updated_at)
           VALUES('codex', $1, 'messages', '{"cursor":"preserved"}'::jsonb, $2)`,
          [legacyId, new Date().toISOString()]
        );
        await closeServer(server);
        await closePostgresStorage();
        closeDb();

        const discovered = deferred();
        const continueCoalescence = deferred();
        __setPostgresLocalDeviceDuplicateDiscoveryHookForTest(async () => {
          discovered.resolve();
          await continueCoalescence.promise;
        });
        const startup = startServer({
          asPort: 0,
          autoEnrollEligibleSchedules: false,
          databaseUrl: url,
          dbPath: ":memory:",
          quiet: true,
          rsPort: 0,
          storageBackend: "postgres",
        });
        await awaitD9DiscoveryRendezvous(discovered.promise, "binding mutation after discovery");
        await createPostgresConnectorInstanceStore().updateSourceBindingPatch(legacyId, {
          sourceBindingPatch: { source_instance_id: "dsrc_d9_binding_changed" },
          updatedAt: new Date().toISOString(),
        });
        continueCoalescence.resolve();
        server = await startup;
        await server.startupBackfillDone.catch(() => undefined);

        const identities = await postgresQuery(
          "SELECT connector_instance_id, source_binding_json FROM connector_instances WHERE connector_instance_id = ANY($1::text[]) ORDER BY connector_instance_id",
          [[canonicalId, legacyId]]
        );
        assert.equal(identities.rows.length, 2, "the changed class must retain both identities");
        const [canonical, legacy] = identities.rows;
        assert.equal(canonical?.connector_instance_id, canonicalId);
        assert.ok(legacy);
        assert.equal(legacy.connector_instance_id, legacyId);
        assert.equal(
          (legacy.source_binding_json as Record<string, unknown>).source_instance_id,
          "dsrc_d9_binding_changed",
          "a binding changed after discovery is a near duplicate, never a deletion candidate"
        );
        const state = await postgresQuery("SELECT connector_instance_id FROM connector_state");
        assert.deepEqual(state.rows, [{ connector_instance_id: legacyId }]);
      } finally {
        __setPostgresLocalDeviceDuplicateDiscoveryHookForTest(null);
        await closeServer(server);
        await closePostgresStorage().catch(() => undefined);
        closeDb();
      }
    }
  );
});

test("D9 adversarial (Postgres): state mutation after discovery rejects the locked class with zero changes", {
  skip: DEDICATED_POSTGRES_URL ? false : "set PDPP_TEST_POSTGRES_URL to the dedicated loopback listener",
}, async () => {
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: DEDICATED_POSTGRES_URL ?? "",
      databaseName: tempDbName(),
    },
    async (url) => {
      initDb(":memory:");
      const server = await startServer({
        asPort: 0,
        autoEnrollEligibleSchedules: false,
        databaseUrl: url,
        dbPath: ":memory:",
        quiet: true,
        rsPort: 0,
        storageBackend: "postgres",
      });
      await server.startupBackfillDone.catch(() => undefined);
      const canonicalId = "cin_d9_state_canonical";
      const legacyId = "cin_d9_state_legacy";
      try {
        await seedD9ExactDuplicateClass({
          canonicalId,
          deviceId: "dexp_d9_state",
          legacyIds: [legacyId],
          localBindingName: "state-race",
          sourceInstanceId: "dsrc_d9_state",
        });
        await createPostgresConnectorStateStore().putState(
          { connectorId: "codex", connectorInstanceId: legacyId },
          { messages: { cursor: "legacy" } }
        );
        await closeServer(server);
        await closePostgresStorage();
        closeDb();

        const discovered = deferred();
        const continueCoalescence = deferred();
        __setPostgresLocalDeviceDuplicateDiscoveryHookForTest(async () => {
          discovered.resolve();
          await continueCoalescence.promise;
        });
        const startup = startServer({
          asPort: 0,
          autoEnrollEligibleSchedules: false,
          databaseUrl: url,
          dbPath: ":memory:",
          quiet: true,
          rsPort: 0,
          storageBackend: "postgres",
        });
        await awaitD9DiscoveryRendezvous(discovered.promise, "state mutation after discovery");
        await createPostgresConnectorStateStore().putState(
          { connectorId: "codex", connectorInstanceId: canonicalId },
          { messages: { cursor: "canonical" } }
        );
        continueCoalescence.resolve();
        await assert.rejects(startup, RE_CANNOT_COALESCE);
        await closePostgresStorage().catch(() => undefined);

        const verificationPool = new Pool({ connectionString: url });
        try {
          const identities = await verificationPool.query(
            "SELECT connector_instance_id FROM connector_instances WHERE connector_instance_id = ANY($1::text[]) ORDER BY connector_instance_id",
            [[canonicalId, legacyId]]
          );
          assert.deepEqual(identities.rows, [
            { connector_instance_id: canonicalId },
            { connector_instance_id: legacyId },
          ]);
          const state = await verificationPool.query(
            "SELECT connector_instance_id, state_json FROM connector_state ORDER BY connector_instance_id"
          );
          assert.deepEqual(state.rows, [
            { connector_instance_id: canonicalId, state_json: { cursor: "canonical" } },
            { connector_instance_id: legacyId, state_json: { cursor: "legacy" } },
          ]);
        } finally {
          await verificationPool.end();
        }
      } finally {
        __setPostgresLocalDeviceDuplicateDiscoveryHookForTest(null);
        await closeServer(server);
        await closePostgresStorage().catch(() => undefined);
        closeDb();
      }
    }
  );
});

test("D9 adversarial (Postgres): a different-stream state mutation after discovery rejects the locked class with zero changes", {
  skip: DEDICATED_POSTGRES_URL ? false : "set PDPP_TEST_POSTGRES_URL to the dedicated loopback listener",
}, async () => {
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: DEDICATED_POSTGRES_URL ?? "",
      databaseName: tempDbName(),
    },
    async (url) => {
      initDb(":memory:");
      const server = await startServer({
        asPort: 0,
        autoEnrollEligibleSchedules: false,
        databaseUrl: url,
        dbPath: ":memory:",
        quiet: true,
        rsPort: 0,
        storageBackend: "postgres",
      });
      await server.startupBackfillDone.catch(() => undefined);
      const canonicalId = "cin_d9_other_stream_canonical";
      const legacyId = "cin_d9_other_stream_legacy";
      try {
        await seedD9ExactDuplicateClass({
          canonicalId,
          deviceId: "dexp_d9_other_stream",
          legacyIds: [legacyId],
          localBindingName: "other-stream-race",
          sourceInstanceId: "dsrc_d9_other_stream",
        });
        await createPostgresConnectorStateStore().putState(
          { connectorId: "codex", connectorInstanceId: legacyId },
          { messages: { cursor: "legacy" } }
        );
        await closeServer(server);
        await closePostgresStorage();
        closeDb();

        const discovered = deferred();
        const continueCoalescence = deferred();
        __setPostgresLocalDeviceDuplicateDiscoveryHookForTest(async () => {
          discovered.resolve();
          await continueCoalescence.promise;
        });
        const startup = startServer({
          asPort: 0,
          autoEnrollEligibleSchedules: false,
          databaseUrl: url,
          dbPath: ":memory:",
          quiet: true,
          rsPort: 0,
          storageBackend: "postgres",
        });
        await awaitD9DiscoveryRendezvous(discovered.promise, "different-stream state mutation after discovery");
        // The canonical identity now authoritatively owns a DIFFERENT stream
        // than the one the legacy identity owns. A same-stream-only collision
        // check would miss this and let the merge combine both state
        // histories before deleting the legacy identity.
        await createPostgresConnectorStateStore().putState(
          { connectorId: "codex", connectorInstanceId: canonicalId },
          { photos: { cursor: "canonical" } }
        );
        continueCoalescence.resolve();
        await assert.rejects(startup, RE_CANNOT_COALESCE);
        await closePostgresStorage().catch(() => undefined);

        const verificationPool = new Pool({ connectionString: url });
        try {
          const identities = await verificationPool.query(
            "SELECT connector_instance_id FROM connector_instances WHERE connector_instance_id = ANY($1::text[]) ORDER BY connector_instance_id",
            [[canonicalId, legacyId]]
          );
          assert.deepEqual(identities.rows, [
            { connector_instance_id: canonicalId },
            { connector_instance_id: legacyId },
          ]);
          const state = await verificationPool.query(
            "SELECT connector_instance_id, stream, state_json FROM connector_state ORDER BY connector_instance_id, stream"
          );
          assert.deepEqual(state.rows, [
            { connector_instance_id: canonicalId, state_json: { cursor: "canonical" }, stream: "photos" },
            { connector_instance_id: legacyId, state_json: { cursor: "legacy" }, stream: "messages" },
          ]);
        } finally {
          await verificationPool.end();
        }
      } finally {
        __setPostgresLocalDeviceDuplicateDiscoveryHookForTest(null);
        await closeServer(server);
        await closePostgresStorage().catch(() => undefined);
        closeDb();
      }
    }
  );
});

test("D9 adversarial (Postgres): a different-stream grant-scoped state mutation after discovery rejects the locked class with zero changes", {
  skip: DEDICATED_POSTGRES_URL ? false : "set PDPP_TEST_POSTGRES_URL to the dedicated loopback listener",
}, async () => {
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: DEDICATED_POSTGRES_URL ?? "",
      databaseName: tempDbName(),
    },
    async (url) => {
      initDb(":memory:");
      const server = await startServer({
        asPort: 0,
        autoEnrollEligibleSchedules: false,
        databaseUrl: url,
        dbPath: ":memory:",
        quiet: true,
        rsPort: 0,
        storageBackend: "postgres",
      });
      await server.startupBackfillDone.catch(() => undefined);
      const canonicalId = "cin_d9_grant_other_stream_canonical";
      const legacyId = "cin_d9_grant_other_stream_legacy";
      const grantId = "grant_d9_other_stream";
      try {
        await seedD9ExactDuplicateClass({
          canonicalId,
          deviceId: "dexp_d9_grant_other_stream",
          legacyIds: [legacyId],
          localBindingName: "grant-other-stream-race",
          sourceInstanceId: "dsrc_d9_grant_other_stream",
        });
        await createPostgresConnectorStateStore().putState(
          { connectorId: "codex", connectorInstanceId: legacyId, grantId },
          { messages: { cursor: "legacy" } }
        );
        await closeServer(server);
        await closePostgresStorage();
        closeDb();

        const discovered = deferred();
        const continueCoalescence = deferred();
        __setPostgresLocalDeviceDuplicateDiscoveryHookForTest(async () => {
          discovered.resolve();
          await continueCoalescence.promise;
        });
        const startup = startServer({
          asPort: 0,
          autoEnrollEligibleSchedules: false,
          databaseUrl: url,
          dbPath: ":memory:",
          quiet: true,
          rsPort: 0,
          storageBackend: "postgres",
        });
        await awaitD9DiscoveryRendezvous(
          discovered.promise,
          "different-stream grant-scoped state mutation after discovery"
        );
        // Same race, but the state is owned by the grant rather than the
        // connector instance directly: the canonical identity's grant now
        // authoritatively owns a DIFFERENT stream than the legacy identity's
        // grant does.
        await createPostgresConnectorStateStore().putState(
          { connectorId: "codex", connectorInstanceId: canonicalId, grantId },
          { photos: { cursor: "canonical" } }
        );
        continueCoalescence.resolve();
        await assert.rejects(startup, RE_CANNOT_COALESCE);
        await closePostgresStorage().catch(() => undefined);

        const verificationPool = new Pool({ connectionString: url });
        try {
          const identities = await verificationPool.query(
            "SELECT connector_instance_id FROM connector_instances WHERE connector_instance_id = ANY($1::text[]) ORDER BY connector_instance_id",
            [[canonicalId, legacyId]]
          );
          assert.deepEqual(identities.rows, [
            { connector_instance_id: canonicalId },
            { connector_instance_id: legacyId },
          ]);
          const grantState = await verificationPool.query(
            "SELECT connector_instance_id, stream, state_json FROM grant_connector_state WHERE grant_id = $1 ORDER BY connector_instance_id, stream",
            [grantId]
          );
          assert.deepEqual(grantState.rows, [
            { connector_instance_id: canonicalId, state_json: { cursor: "canonical" }, stream: "photos" },
            { connector_instance_id: legacyId, state_json: { cursor: "legacy" }, stream: "messages" },
          ]);
        } finally {
          await verificationPool.end();
        }
      } finally {
        __setPostgresLocalDeviceDuplicateDiscoveryHookForTest(null);
        await closeServer(server);
        await closePostgresStorage().catch(() => undefined);
        closeDb();
      }
    }
  );
});

function terminalRunCommitInput(overrides: Partial<ResolvedTerminalRunCommit> = {}): ResolvedTerminalRunCommit {
  return {
    collectionBoundary: "unscoped",
    commitId: "commit-d9-terminal-race-1",
    connectorId: "codex",
    connectorInstanceId: "cin_d9_terminal_race_canonical",
    deviceId: "dexp_d9_terminal_race",
    envelopeHash: "a".repeat(64),
    normalizedFacts: [{ checkpoint: "committed", collected: 0, coverage_statuses: ["collected"], stream: "photos" }],
    runId: "run-d9-terminal-race-1",
    sourceInstanceId: "dsrc_d9_terminal_race",
    stateDelta: { photos: { cursor: "canonical-terminal-run" } },
    ...overrides,
  };
}

test("D9 adversarial (Postgres): a different-stream terminal-run commit after discovery rejects the locked class with zero changes", {
  skip: DEDICATED_POSTGRES_URL ? false : "set PDPP_TEST_POSTGRES_URL to the dedicated loopback listener",
}, async () => {
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: DEDICATED_POSTGRES_URL ?? "",
      databaseName: tempDbName(),
    },
    async (url) => {
      initDb(":memory:");
      const server = await startServer({
        asPort: 0,
        autoEnrollEligibleSchedules: false,
        databaseUrl: url,
        dbPath: ":memory:",
        quiet: true,
        rsPort: 0,
        storageBackend: "postgres",
      });
      await server.startupBackfillDone.catch(() => undefined);
      const canonicalId = "cin_d9_terminal_race_canonical";
      const legacyId = "cin_d9_terminal_race_legacy";
      try {
        await seedD9ExactDuplicateClass({
          canonicalId,
          deviceId: "dexp_d9_terminal_race",
          legacyIds: [legacyId],
          localBindingName: "terminal-race",
          sourceInstanceId: "dsrc_d9_terminal_race",
        });
        // Legacy identity authoritatively owns "messages", exactly like the
        // sibling different-stream tests above.
        await createPostgresConnectorStateStore().putState(
          { connectorId: "codex", connectorInstanceId: legacyId },
          { messages: { cursor: "legacy" } }
        );
        await closeServer(server);
        await closePostgresStorage();
        closeDb();

        const discovered = deferred();
        const continueCoalescence = deferred();
        __setPostgresLocalDeviceDuplicateDiscoveryHookForTest(async () => {
          discovered.resolve();
          await continueCoalescence.promise;
        });
        const startup = startServer({
          asPort: 0,
          autoEnrollEligibleSchedules: false,
          databaseUrl: url,
          dbPath: ":memory:",
          quiet: true,
          rsPort: 0,
          storageBackend: "postgres",
        });
        await awaitD9DiscoveryRendezvous(discovered.promise, "different-stream terminal-run commit after discovery");
        // Drive the REAL production terminal-run writer (not the
        // createPostgresConnectorStateStore().putState helper the sibling
        // tests use) against the canonical identity, for a DIFFERENT stream
        // ("photos") than the legacy identity owns ("messages"). Matches the
        // sibling tests' exact race shape: the hook has already fired
        // (post-discovery, pre-lock), so the coalescer has not yet started
        // its own transaction/lock acquisition on this connector instance —
        // this write is therefore uncontended and commits normally. THEN
        // continueCoalescence resolves, letting the coalescer proceed to
        // BEGIN, acquire the class's connector-instance locks (now including
        // canonicalId, already released by this commit), and revalidate.
        // Revalidation must see the canonical identity now authoritatively
        // owns "photos" (a different stream than legacy's "messages") and
        // fail closed via assertPostgresConnectorInstanceClassCanMerge's
        // any-two-owners check on connector_state — exactly the same
        // detection path the sibling different-stream tests exercise, but
        // reached through the real production terminal-run writer instead
        // of the createPostgresConnectorStateStore().putState helper. This
        // also exercises the lock-topology fix directly: commitTerminalRun's
        // withPostgresTransaction call now takes lockConnectorInstanceId,
        // so it acquires and releases the SAME advisory lock the coalescer
        // will acquire next, in the same key space and (trivially, since
        // uncontended here) succeeds before the coalescer ever contends it.
        const terminalRunAttempt = await commitTerminalRun(
          terminalRunCommitInput({ connectorInstanceId: canonicalId })
        );
        assert.equal(terminalRunAttempt.replayed, false);
        continueCoalescence.resolve();
        await assert.rejects(startup, RE_CANNOT_COALESCE);
        await closePostgresStorage().catch(() => undefined);

        const verificationPool = new Pool({ connectionString: url });
        try {
          const identities = await verificationPool.query(
            "SELECT connector_instance_id FROM connector_instances WHERE connector_instance_id = ANY($1::text[]) ORDER BY connector_instance_id",
            [[canonicalId, legacyId]]
          );
          assert.deepEqual(identities.rows, [
            { connector_instance_id: canonicalId },
            { connector_instance_id: legacyId },
          ]);
          const state = await verificationPool.query(
            "SELECT connector_instance_id, stream, state_json FROM connector_state ORDER BY connector_instance_id, stream"
          );
          // The terminal-run commit landed and committed BEFORE the
          // coalescer ever contended the canonical identity's lock (it ran
          // to completion during the discovery-hook pause, before
          // continueCoalescence.resolve()), so it is a durable, legitimate,
          // independent write. It must NOT be combined with legacy's row
          // under one identity — the coalescer's own separate transaction
          // is what fails closed and rolls back (already asserted above via
          // assert.rejects(startup, RE_CANNOT_COALESCE)).
          assert.deepEqual(state.rows, [
            { connector_instance_id: canonicalId, state_json: { cursor: "canonical-terminal-run" }, stream: "photos" },
            { connector_instance_id: legacyId, state_json: { cursor: "legacy" }, stream: "messages" },
          ]);
          // The terminal-run commit's own transaction (event + run-history +
          // state, one commit/rollback unit) committed durably — it is not
          // part of the coalescer's failed transaction, so its receipt must
          // be fully present, not rolled back.
          const events = await verificationPool.query("SELECT event_id FROM spine_events WHERE run_id = $1", [
            "run-d9-terminal-race-1",
          ]);
          assert.equal(events.rows.length, 1);
          const runs = await verificationPool.query("SELECT run_id, status FROM run_history WHERE run_id = $1", [
            "run-d9-terminal-race-1",
          ]);
          assert.deepEqual(runs.rows, [{ run_id: "run-d9-terminal-race-1", status: "succeeded" }]);
        } finally {
          await verificationPool.end();
        }
      } finally {
        __setPostgresLocalDeviceDuplicateDiscoveryHookForTest(null);
        await closeServer(server);
        await closePostgresStorage().catch(() => undefined);
        closeDb();
      }
    }
  );
});

test("D9 lock (Postgres, deterministic): a terminal-run commit genuinely blocked by another transaction holding the connector-instance lock rolls back its whole transaction with nothing durable written", {
  skip: DEDICATED_POSTGRES_URL ? false : "set PDPP_TEST_POSTGRES_URL to the dedicated loopback listener",
}, async () => {
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: DEDICATED_POSTGRES_URL ?? "",
      databaseName: tempDbName(),
    },
    async (url) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl: url });
      const connectorInstanceId = "cin_d9_terminal_lock_contend";
      const now = new Date().toISOString();
      await postgresQuery(
        `INSERT INTO connectors(connector_id, manifest) VALUES('codex', '{"connector_id":"codex","streams":[]}'::jsonb) ON CONFLICT DO NOTHING`
      );
      await postgresQuery(
        `INSERT INTO connector_instances(connector_instance_id, owner_subject_id, connector_id, display_name, status, source_kind, source_binding_key, source_binding_json, created_at, updated_at)
         VALUES($1, 'owner_local', 'codex', 'lock-contend', 'active', 'local_device', 'lock-contend-key', '{}'::jsonb, $2, $2)`,
        [connectorInstanceId, now]
      );
      // Hold the SAME connector-instance advisory lock this test's
      // commitTerminalRun call will need, on a separate raw connection, in
      // an open (uncommitted) transaction — exactly modeling
      // acquireConnectorInstanceXactLocks holding the lock while
      // coalescence's merge transaction is still open. This proves the
      // lock-topology fix creates REAL serialization (not just a
      // revalidation side effect that happens to catch a prior commit): a
      // concurrent transaction that already holds the lock genuinely blocks
      // commitTerminalRun until commitTerminalRun's bounded lock_timeout
      // (connectorInstanceLockWaitMs, default 2000ms) expires.
      const holderPool = new Pool({ connectionString: url });
      const holder = await holderPool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock($1::bigint)", [
          connectorInstanceAdvisoryLockKey(connectorInstanceId),
        ]);

        await assert.rejects(
          commitTerminalRun(
            terminalRunCommitInput({
              commitId: "commit-d9-lock-contend-1",
              connectorInstanceId,
              runId: "run-d9-lock-contend-1",
            })
          ),
          (err: unknown) => err instanceof ConnectorInstanceAdmissionError
        );

        // The terminal-run commit is transactional: event + run-history +
        // state in one commit/rollback unit. Since the state write's lock
        // acquisition itself failed (SQLSTATE 55P03 -> lock_timeout ->
        // ConnectorInstanceAdmissionError, translated inside
        // acquireConnectorInstanceXactLock), the whole withPostgresTransaction
        // callback never ran and the transaction rolled back — nothing for
        // this run should be durable.
        const events = await postgresQuery("SELECT event_id FROM spine_events WHERE run_id = $1", [
          "run-d9-lock-contend-1",
        ]);
        assert.deepEqual(events.rows, []);
        const runs = await postgresQuery("SELECT run_id FROM run_history WHERE run_id = $1", ["run-d9-lock-contend-1"]);
        assert.deepEqual(runs.rows, []);
        const state = await postgresQuery("SELECT stream FROM connector_state WHERE connector_instance_id = $1", [
          connectorInstanceId,
        ]);
        assert.deepEqual(state.rows, []);

        await holder.query("ROLLBACK");
      } finally {
        holder.release();
        await holderPool.end();
      }

      // Once the holder releases the lock, an otherwise-identical commit
      // succeeds normally — proving the fix serializes rather than
      // permanently wedging the connector instance.
      const recovered = await commitTerminalRun(
        terminalRunCommitInput({
          commitId: "commit-d9-lock-contend-2",
          connectorInstanceId,
          runId: "run-d9-lock-contend-2",
        })
      );
      assert.equal(recovered.replayed, false);

      await closePostgresStorage().catch(() => undefined);
    }
  );
});

test("D9 legacy-target late writer (Postgres): a write against a just-deleted legacy connector_instance_id after successful coalescence does not resurrect combined state", {
  skip: DEDICATED_POSTGRES_URL ? false : "set PDPP_TEST_POSTGRES_URL to the dedicated loopback listener",
}, async () => {
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: DEDICATED_POSTGRES_URL ?? "",
      databaseName: tempDbName(),
    },
    async (url) => {
      initDb(":memory:");
      const server = await startServer({
        asPort: 0,
        autoEnrollEligibleSchedules: false,
        databaseUrl: url,
        dbPath: ":memory:",
        quiet: true,
        rsPort: 0,
        storageBackend: "postgres",
      });
      await server.startupBackfillDone.catch(() => undefined);
      const canonicalId = "cin_d9_legacy_late_canonical";
      const legacyId = "cin_d9_legacy_late_legacy";
      try {
        // A class with NO colliding owned state: the legacy identity owns
        // nothing, so this class coalesces successfully (unlike the
        // adversarial siblings above) and the legacy identity is deleted.
        await seedD9ExactDuplicateClass({
          canonicalId,
          deviceId: "dexp_d9_legacy_late",
          legacyIds: [legacyId],
          localBindingName: "legacy-late-writer",
          sourceInstanceId: "dsrc_d9_legacy_late",
        });
        await closeServer(server);
        await closePostgresStorage();
        closeDb();

        const restarted = await startServer({
          asPort: 0,
          autoEnrollEligibleSchedules: false,
          databaseUrl: url,
          dbPath: ":memory:",
          quiet: true,
          rsPort: 0,
          storageBackend: "postgres",
        });
        await restarted.startupBackfillDone.catch(() => undefined);
        await closeServer(restarted);

        const preVerificationPool = new Pool({ connectionString: url });
        try {
          const identities = await preVerificationPool.query(
            "SELECT connector_instance_id FROM connector_instances WHERE connector_instance_id = ANY($1::text[]) ORDER BY connector_instance_id",
            [[canonicalId, legacyId]]
          );
          // Coalescence succeeded: only the canonical identity remains.
          assert.deepEqual(identities.rows, [{ connector_instance_id: canonicalId }]);
        } finally {
          await preVerificationPool.end();
        }

        // connector_state has NO foreign key to connector_instances
        // (postgres-storage.ts:2368-2387), so nothing at the SCHEMA level
        // stops a write from still landing on the now-deleted legacy id.
        // createPostgresConnectorStateStore().putState DOES take the
        // connector-instance advisory lock (connector-state-store.ts:338,
        // `{ lockConnectorInstanceId: connectorInstanceId }`), but that lock
        // only serializes against another transaction that is CONCURRENTLY
        // holding the same connector-instance id's lock — it is not a
        // liveness check that the id still exists, and nothing here is
        // still holding the legacy id's lock (coalescence already committed
        // and released it before this write starts). Prove, rather than
        // assume, what currently happens: this write is expected to SUCCEED
        // and create an orphaned row, because the lock is uncontended and no
        // constraint prevents a write targeting an id that coalescence has
        // already finished with and released.
        const orphanWrite = await createPostgresConnectorStateStore().putState(
          { connectorId: "codex", connectorInstanceId: legacyId },
          { messages: { cursor: "late-writer-after-delete" } }
        );
        assert.deepEqual(orphanWrite.state, { messages: { cursor: "late-writer-after-delete" } });

        const verificationPool = new Pool({ connectionString: url });
        try {
          const orphan = await verificationPool.query(
            "SELECT connector_instance_id, stream, state_json FROM connector_state WHERE connector_instance_id = $1",
            [legacyId]
          );
          // KNOWN, ACCEPTED behavior: the write succeeds and creates an
          // orphaned row referencing a connector_instance_id that no longer
          // exists in connector_instances. This is possible only because
          // coalescence had ALREADY fully committed (legacy deleted, no
          // in-flight merge) before this write ran — there is no race with
          // an in-progress merge here, so the D9 fail-closed invariant is
          // not violated: no OTHER identity's state was combined with this
          // orphan. It is a known operator-visible side effect of the
          // schema's missing FK, not a coalescence-correctness defect.
          assert.deepEqual(orphan.rows, [
            {
              connector_instance_id: legacyId,
              state_json: { cursor: "late-writer-after-delete" },
              stream: "messages",
            },
          ]);
          const canonicalState = await verificationPool.query(
            "SELECT connector_instance_id, stream, state_json FROM connector_state WHERE connector_instance_id = $1",
            [canonicalId]
          );
          // The canonical identity's own state (empty here) is untouched by
          // the orphan write — the two histories are NOT combined.
          assert.deepEqual(canonicalState.rows, []);
        } finally {
          await verificationPool.end();
        }
      } finally {
        await closeServer(server);
        await closePostgresStorage().catch(() => undefined);
        closeDb();
      }
    }
  );
});

test("D9 adversarial (Postgres): a three-row two-credential class rolls back as one unit", {
  skip: DEDICATED_POSTGRES_URL ? false : "set PDPP_TEST_POSTGRES_URL to the dedicated loopback listener",
}, async () => {
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: DEDICATED_POSTGRES_URL ?? "",
      databaseName: tempDbName(),
    },
    async (url) => {
      initDb(":memory:");
      const server = await startServer({
        asPort: 0,
        autoEnrollEligibleSchedules: false,
        databaseUrl: url,
        dbPath: ":memory:",
        quiet: true,
        rsPort: 0,
        storageBackend: "postgres",
      });
      await server.startupBackfillDone.catch(() => undefined);
      const canonicalId = "cin_d9_credential_canonical";
      const legacyIds = ["cin_d9_credential_legacy_1", "cin_d9_credential_legacy_2"];
      try {
        const { now } = await seedD9ExactDuplicateClass({
          canonicalId,
          deviceId: "dexp_d9_credential",
          legacyIds,
          localBindingName: "credential-class",
          sourceInstanceId: "dsrc_d9_credential",
        });
        await Promise.all(
          legacyIds.map((connectorInstanceId, index) =>
            postgresQuery(
              `INSERT INTO connector_instance_credentials(
                 connector_instance_id, owner_subject_id, credential_kind, sealed_secret, fingerprint,
                 status, captured_at, rotated_at, revoked_at, rejected_at, rejection_reason
               ) VALUES($1, 'owner_local', 'api_key', $2, $3, 'active', $4, NULL, NULL, NULL, NULL)`,
              [connectorInstanceId, `sealed-${index}`, `fp-${index}`, now]
            )
          )
        );
        await closeServer(server);
        await closePostgresStorage();
        closeDb();
        await assert.rejects(
          startServer({
            asPort: 0,
            autoEnrollEligibleSchedules: false,
            databaseUrl: url,
            dbPath: ":memory:",
            quiet: true,
            rsPort: 0,
            storageBackend: "postgres",
          }),
          RE_CANNOT_COALESCE
        );
        await closePostgresStorage().catch(() => undefined);

        const verificationPool = new Pool({ connectionString: url });
        try {
          const identities = await verificationPool.query(
            "SELECT connector_instance_id FROM connector_instances WHERE connector_instance_id = ANY($1::text[]) ORDER BY connector_instance_id",
            [[canonicalId, ...legacyIds]]
          );
          assert.deepEqual(identities.rows, [
            { connector_instance_id: canonicalId },
            { connector_instance_id: legacyIds[0] },
            { connector_instance_id: legacyIds[1] },
          ]);
          const credentials = await verificationPool.query(
            "SELECT connector_instance_id, fingerprint FROM connector_instance_credentials ORDER BY connector_instance_id"
          );
          assert.deepEqual(credentials.rows, [
            { connector_instance_id: legacyIds[0], fingerprint: "fp-0" },
            { connector_instance_id: legacyIds[1], fingerprint: "fp-1" },
          ]);
        } finally {
          await verificationPool.end();
        }
      } finally {
        await closeServer(server);
        await closePostgresStorage().catch(() => undefined);
        closeDb();
      }
    }
  );
});
