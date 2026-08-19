// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenSpec task 2.2 / 6.1 residual (openspec/changes/reconcile-active-summary-evidence
 * design.md "Acceptance Strategy"): `connector-summary-evidence-no-op-and-
 * failure-conformance.test.js`'s "accepted replay" and "partial-prefix
 * resume" cases construct their scenario by calling `ingestRecord` directly,
 * record-by-record — never through the real device-batch HTTP entry point
 * (`/_ref/device-exporters/:id/ingest-batches`, exercised by
 * `device-ingest-conformance.test.js`'s driver). `connector-summary-evidence-
 * throughput-integration.test.js`'s manifest/backfill-ordering case is also
 * real but strictly serial (M1 registers, then ingest, then M2 registers,
 * then ingest) rather than a genuine race.
 *
 * This file closes both residuals using the SAME real production entry
 * points and fault-injection seams `device-ingest-conformance.test.js`
 * already exercises for throughput/idempotency correctness, layering new
 * `connector_summary_evidence` assertions on top rather than reinventing the
 * device-batch protocol:
 *
 * - an accepted replay of an already-committed batch (the same construction
 *   `runDuplicateAndNewerWriterOracle` and the phase-fault matrix's "replay"
 *   step use: re-POST the identical batch envelope after it is durably
 *   accepted) must not double-count `total_records` or move the composite
 *   checkpoint;
 * - a partial-prefix resume (the same construction `runPhaseFaultMatrix`
 *   uses: `__setDeviceIngestPhaseFaultHookForTest` throws after the durable
 *   phase commits records but before the batch reservation reaches
 *   `accepted`, then the client resumes by re-POSTing the whole original
 *   batch) must repair only the genuinely new suffix, not double-count the
 *   already-committed prefix, and land on the correct final checkpoint;
 * - a genuine manifest-registration race against an in-flight device batch,
 *   using the exact same `inside-instance-fence` pause hook
 *   (`__setSqliteRecordSortBackfillPhaseHookForTest` /
 *   `__setPostgresRecordSortBackfillPhaseHookForTest`) that
 *   `device-ingest-conformance.test.js`'s `runManifestRegistrationOracle`
 *   uses for its "registration-first" scenario, must converge
 *   `connector_summary_evidence` correctly regardless of which side actually
 *   lands first.
 *
 * Both SQLite and a real disposable PostgreSQL database run every case here
 * (the `ORACLES`-style backend loop below), matching design.md's Acceptance
 * Strategy requirement that forced fixtures run against both backends, not
 * SQLite alone.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { registerConnector } from "../server/auth.ts";
import { COLLECTOR_PROTOCOL_VERSION } from "../server/collector-protocol.ts";
import { reconcileConnectorSummaryEvidence } from "../server/connector-summary-evidence-engine.ts";
import {
  getConnectorSummaryEvidence,
  reconcileDirtyConnectorSummaryEvidence,
} from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { __setPostgresRecordSortBackfillPhaseHookForTest } from "../server/postgres-records.ts";
import { closePostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { __setSqliteRecordSortBackfillPhaseHookForTest } from "../server/records.ts";
import { __setDeviceIngestPhaseFaultHookForTest } from "../server/routes/ref-device-exporters.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const DEDICATED_POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const PROTOCOL_HEADERS = { "X-PDPP-Collector-Protocol": COLLECTOR_PROTOCOL_VERSION };
const RE_PAYLOAD_SENTINEL = /payload-sentinel-never-in-spine/;

let unique = 0;
function nextId(prefix: string): string {
  unique += 1;
  return `${prefix}-${process.pid}-${Date.now()}-${unique}`;
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

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function canonical(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  const rec = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(rec)
      .sort()
      .filter((key) => rec[key] !== undefined)
      .map((key) => [key, canonical(rec[key])])
  );
}

function bodyHash(records: unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(records)))
    .digest("hex");
}

function deviceRecord(key: string, content: string, { op = "upsert", timestamp = "2026-07-17T00:00:00.000Z" } = {}) {
  return {
    data:
      op === "delete" ? {} : { content, id: key, role: "user", session_id: `session-${key}`, timestamp, type: "text" },
    emitted_at: timestamp,
    op,
    record_key: key,
    stream: "messages",
  };
}

function batch(
  device: Record<string, unknown>,
  batchId: string,
  records: unknown[],
  batchSeq = 1
): Record<string, unknown> {
  return {
    batch_id: batchId,
    batch_seq: batchSeq,
    body_hash: bodyHash(records),
    connector_id: device.connector_id,
    device_id: device.device_id,
    records,
    source_instance_id: device.source_instance_id,
  };
}

function deterministicBackend(): Record<string, () => unknown> {
  return {
    available: () => true,
    dimensions: () => 3,
    distanceMetric: () => "cosine",
    embedDocument: async () => new Float32Array([0.1, 0.2, 0.3]),
    embedQuery: async () => new Float32Array([0.1, 0.2, 0.3]),
    model: () => "device-batch-summary-evidence-stub",
    supportsDeviceAttemptDeadline: () => true,
  };
}

async function closeServer(server: {
  asServer: import("node:http").Server;
  rsServer: import("node:http").Server;
}): Promise<void> {
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  const closeOne = (httpServer: import("node:http").Server) =>
    new Promise<void>((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      }, 2000);
      httpServer.close(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve();
        }
      });
    });
  await Promise.allSettled([closeOne(server.asServer), closeOne(server.rsServer)]);
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

function authHeaders(deviceToken: string): Record<string, string> {
  return { Authorization: `Bearer ${deviceToken}`, ...PROTOCOL_HEADERS };
}

async function enrollDevice(asUrl: string, localBindingName: string): Promise<Record<string, unknown>> {
  const code = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
    connector_id: "codex",
    local_binding_name: localBindingName,
  });
  assert.equal(code.status, 201, JSON.stringify(code.body));
  const enrolled = await postJson(
    `${asUrl}/_ref/device-exporters/enroll`,
    { enrollment_code: code.body.enrollment_code as string },
    PROTOCOL_HEADERS
  );
  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
  return enrolled.body;
}

function deviceIngestUrl(asUrl: string, device: Record<string, unknown>): string {
  return `${asUrl}/_ref/device-exporters/${encodeURIComponent(String(device.device_id))}/ingest-batches`;
}

async function withTemporaryPostgres(fn: (url: string) => Promise<void>) {
  const database = `pdpp_devbatch_summary_${process.pid}_${Date.now()}_${unique}`;
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: DEDICATED_POSTGRES_URL ?? "",
      databaseName: database,
    },
    fn
  );
}

interface Driver {
  asUrl: string;
  enroll: (name: string) => Promise<Record<string, unknown>>;
  ingest: (
    device: Record<string, unknown>,
    request: unknown
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
  kind: string;
  manifest: () => Promise<unknown>;
  registerManifest: (manifest: unknown, options?: Record<string, unknown>) => Promise<void>;
  target: (instanceId: string) => { connector_id: string; connector_instance_id: string };
}

function createDriver(kind: string, server: { asPort: number }): Driver {
  const asUrl = `http://localhost:${server.asPort}`;
  return {
    asUrl,
    async enroll(name: string) {
      return await enrollDevice(asUrl, `${name}-${nextId("binding")}`);
    },
    async ingest(device: Record<string, unknown>, request: unknown) {
      return await postJson(deviceIngestUrl(asUrl, device), request, authHeaders(String(device.device_token)));
    },
    kind,
    async manifest() {
      const row =
        kind === "sqlite"
          ? getDb().prepare("SELECT manifest FROM connectors WHERE connector_id = ?").get("codex")
          : (await postgresQuery("SELECT manifest FROM connectors WHERE connector_id = $1", ["codex"])).rows[0];
      assert.ok(row, "the shipped codex connector must be registered before device ingest");
      return typeof (row as { manifest: unknown }).manifest === "string"
        ? JSON.parse((row as { manifest: string }).manifest)
        : (row as { manifest: unknown }).manifest;
    },
    async registerManifest(manifest: unknown, options: Record<string, unknown> = {}) {
      await registerConnector(manifest as never, options as never);
    },
    target(instanceId: string) {
      return { connector_id: "codex", connector_instance_id: instanceId };
    },
  };
}

async function withBackend(kind: string, fn: (driver: Driver) => Promise<void>) {
  const backend = deterministicBackend();
  if (kind === "sqlite") {
    const server = await startServer({
      asPort: 0,
      dbPath: ":memory:",
      quiet: true,
      rsPort: 0,
      semanticRetrievalBackend: backend,
    });
    try {
      await server.startupBackfillDone.catch(() => undefined);
      await fn(createDriver(kind, server));
    } finally {
      __setDeviceIngestPhaseFaultHookForTest(null);
      __setSqliteRecordSortBackfillPhaseHookForTest(null);
      __setPostgresRecordSortBackfillPhaseHookForTest(null);
      await closeServer(server);
      closeDb();
    }
    return;
  }

  await withTemporaryPostgres(async (url) => {
    initDb(":memory:");
    const previousDatabaseUrl = process.env.PDPP_DATABASE_URL;
    process.env.PDPP_DATABASE_URL = url;
    const server = await startServer({
      asPort: 0,
      dbPath: ":memory:",
      quiet: true,
      rsPort: 0,
      semanticRetrievalBackend: backend,
    });
    try {
      await server.startupBackfillDone.catch(() => undefined);
      await fn(createDriver(kind, server));
    } finally {
      __setDeviceIngestPhaseFaultHookForTest(null);
      __setSqliteRecordSortBackfillPhaseHookForTest(null);
      __setPostgresRecordSortBackfillPhaseHookForTest(null);
      await closeServer(server);
      await closePostgresStorage().catch(() => undefined);
      closeDb();
      if (previousDatabaseUrl === undefined) {
        delete process.env.PDPP_DATABASE_URL;
      } else {
        process.env.PDPP_DATABASE_URL = previousDatabaseUrl;
      }
    }
  });
}

async function configureMessagesManifest(driver: Driver) {
  const manifest = structuredClone(await driver.manifest()) as {
    streams: { name: string; query: { search: { lexical_fields: string[]; semantic_fields: string[] } } }[];
  };
  const messages = manifest.streams.find((stream) => stream.name === "messages");
  assert.ok(messages, "shipped codex manifest must retain messages");
  messages.query.search.lexical_fields = ["content"];
  messages.query.search.semantic_fields = ["content"];
  await driver.registerManifest(manifest);
  return manifest;
}

async function enrollConfiguredDevice(driver: Driver, name: string) {
  const device = await driver.enroll(name);
  await configureMessagesManifest(driver);
  return device;
}

/**
 * Read the composite checkpoint for one connection's summary-evidence row
 * directly (it is an internal storage column, not part of the shaped
 * envelope `getConnectorSummaryEvidence` returns), the same way
 * `connector-summary-evidence-no-op-and-failure-conformance.test.js` does
 * for SQLite — extended here to also work against a real Postgres backend.
 */
async function checkpointFor(driver: Driver, connectorInstanceId: string) {
  if (driver.kind === "sqlite") {
    return (
      getDb()
        .prepare("SELECT record_checkpoint_json FROM connector_summary_evidence WHERE connector_instance_id = ?")
        .get(connectorInstanceId)?.record_checkpoint_json ?? null
    );
  }
  const result = await postgresQuery(
    "SELECT record_checkpoint_json::text AS record_checkpoint_json FROM connector_summary_evidence WHERE connector_instance_id = $1",
    [connectorInstanceId]
  );
  return result.rows[0]?.record_checkpoint_json ?? null;
}

// ---------------------------------------------------------------------------
// 1. Accepted replay through the real device-batch HTTP entry point.
// ---------------------------------------------------------------------------

async function runAcceptedReplayOracle(driver: Driver) {
  const device = await enrollConfiguredDevice(driver, "accepted-replay");
  const connectorInstanceId = String(device.connector_instance_id);
  const request = batch(device, nextId("accepted-replay"), [
    deviceRecord("replay-msg-1", "first"),
    deviceRecord("replay-msg-2", "second", { timestamp: "2026-07-17T00:00:01.000Z" }),
  ]);

  const first = await driver.ingest(device, request);
  assert.equal(first.status, 201, "the original batch is accepted");

  const warm = await reconcileConnectorSummaryEvidence(null);
  assert.ok(warm.repaired >= 1, "fixture premise: the connection converges after the original batch");
  const evidenceAfterBatch = await getConnectorSummaryEvidence(connectorInstanceId);
  assert.ok(evidenceAfterBatch, "evidenceAfterBatch must not be null");
  assert.equal(evidenceAfterBatch.total_records, 2, "fixture premise: both records from the batch are counted");
  const checkpointAfterBatch = await checkpointFor(driver, connectorInstanceId);

  // The client replays the identical batch envelope through the real device
  // HTTP route — e.g. it never observed the 200/201 response and retries.
  // device-ingest-conformance.test.js's stranded-diagnostics oracle and
  // duplicate-writer oracle both prove this replay is a persistence/
  // diagnostics no-op at the device-batch layer; this proves the summary
  // primitive converges the same way.
  const replay = await driver.ingest(device, request);
  assert.equal(replay.status, 201, "an accepted replay of the identical batch is re-accepted, not rejected");

  const result = await reconcileConnectorSummaryEvidence(null);
  assert.equal(result.repaired, 0, "the accepted replay triggers zero repair work — nothing changed");
  assert.equal(
    await checkpointFor(driver, connectorInstanceId),
    checkpointAfterBatch,
    "the composite checkpoint is unchanged by the replay"
  );

  const evidenceAfterReplay = await getConnectorSummaryEvidence(connectorInstanceId);
  assert.ok(evidenceAfterReplay, "evidenceAfterReplay must not be null");
  assert.equal(evidenceAfterReplay.total_records, 2, "the replay does not double-count the two-record batch");
}

// ---------------------------------------------------------------------------
// 2. Partial-prefix resume through the real device-batch HTTP entry point,
//    using the same phase-fault seam runPhaseFaultMatrix uses.
// ---------------------------------------------------------------------------

async function runPartialPrefixResumeOracle(driver: Driver) {
  const device = await enrollConfiguredDevice(driver, "partial-prefix-resume");
  const connectorInstanceId = String(device.connector_instance_id);
  const key1 = "prefix-msg-1";
  const key2 = "prefix-msg-2";
  const key3 = "prefix-msg-3";
  const request = batch(device, nextId("partial-prefix"), [
    deviceRecord(key1, "one"),
    deviceRecord(key2, "two", { timestamp: "2026-07-17T00:00:01.000Z" }),
    deviceRecord(key3, "three", { timestamp: "2026-07-17T00:00:02.000Z" }),
  ]);

  // Force the durable phase to fail after committing the first record but
  // before the batch reaches `accepted` — the exact `after-durable-record`
  // seam runPhaseFaultMatrix uses to build a real partial durable prefix.
  let fired = false;
  __setDeviceIngestPhaseFaultHookForTest((point, inputIndex) => {
    if (!fired && point === "after-durable-record" && inputIndex === 0) {
      fired = true;
      throw new Error("deterministic partial-prefix interruption");
    }
  });
  try {
    const interrupted = await driver.ingest(device, request);
    assert.equal(interrupted.status, 503, "the interrupted batch surfaces only retryable HTTP state");
  } finally {
    __setDeviceIngestPhaseFaultHookForTest(null);
  }

  const midway = await reconcileConnectorSummaryEvidence(null);
  assert.ok(midway.repaired >= 1, "fixture premise: the primitive observes the durably-committed prefix");
  const midwayEvidence = await getConnectorSummaryEvidence(connectorInstanceId);
  assert.ok(midwayEvidence, "midwayEvidence must not be null");
  assert.equal(midwayEvidence.total_records, 1, "only the durably-committed prefix record is visible mid-resume");
  const checkpointMidway = await checkpointFor(driver, connectorInstanceId);

  // The client resumes by re-sending the WHOLE original batch: the first
  // record replays as a no-op (already committed), and the remaining two are
  // genuinely new — the same resume construction runPhaseFaultMatrix uses.
  const resumed = await driver.ingest(device, request);
  assert.equal(resumed.status, 201, "the resumed batch is accepted");
  const resumedReplay = await driver.ingest(device, request);
  assert.equal(resumedReplay.status, 201, "a further replay after full acceptance is also accepted, not rejected");

  const result = await reconcileConnectorSummaryEvidence(null);
  assert.equal(result.repaired, 1, "the resumed batch repairs exactly the one connection whose checkpoint moved");
  assert.notEqual(
    await checkpointFor(driver, connectorInstanceId),
    checkpointMidway,
    "the checkpoint DID move once, reflecting the newly-landed suffix"
  );

  const finalEvidence = await getConnectorSummaryEvidence(connectorInstanceId);
  assert.ok(finalEvidence, "finalEvidence must not be null");
  assert.equal(
    finalEvidence.total_records,
    3,
    "the resumed batch lands the full 3 records without duplicating the already-committed prefix"
  );

  // A second reconcile after full convergence is idempotent.
  const secondPass = await reconcileConnectorSummaryEvidence(null);
  assert.equal(secondPass.repaired, 0, "a second pass after full convergence repairs nothing further");
}

// ---------------------------------------------------------------------------
// 3. Genuine manifest-registration race against an in-flight device batch —
//    the same `inside-instance-fence` pause hook
//    device-ingest-conformance.test.js's runManifestRegistrationOracle uses
//    for its "registration-first" scenario.
// ---------------------------------------------------------------------------

async function runManifestRaceOracle(driver: Driver) {
  const device = await enrollConfiguredDevice(driver, "manifest-race");
  const connectorInstanceId = String(device.connector_instance_id);

  // Seed one record under the current (M1) manifest and let the primitive
  // converge, establishing a baseline before the race.
  const seedRequest = batch(device, nextId("manifest-race-seed"), [deviceRecord("race-seed", "before race")]);
  assert.equal((await driver.ingest(device, seedRequest)).status, 201);
  const seedResult = await reconcileConnectorSummaryEvidence(null);
  assert.ok(seedResult.repaired >= 1, "fixture premise: the connection converges under M1 before the race");

  // Build M2: same connector/stream, with different declared search fields
  // (mirrors generationManifests' M1->M2 shift) so registration performs a
  // real backfill that takes the per-instance write fence.
  const m2 = structuredClone(await driver.manifest()) as {
    streams: { name: string; query: { search: { lexical_fields: string[]; semantic_fields: string[] } } }[];
  };
  const messages = m2.streams.find((stream) => stream.name === "messages");
  assert.ok(messages, "manifest must have messages stream");
  messages.query.search.lexical_fields = ["role"];
  messages.query.search.semantic_fields = ["role"];

  const backfillAtTarget = deferred();
  const releaseBackfill = deferred();
  const pauseAtTarget = async (point: string, context: Record<string, unknown>) => {
    if (point === "inside-instance-fence" && context.connectorInstanceId === connectorInstanceId) {
      backfillAtTarget.resolve();
      await releaseBackfill.promise;
    }
  };
  if (driver.kind === "postgres") {
    __setPostgresRecordSortBackfillPhaseHookForTest(pauseAtTarget);
  } else {
    __setSqliteRecordSortBackfillPhaseHookForTest(pauseAtTarget);
  }

  let registration: Promise<void> | undefined;
  try {
    // M2 registration enters the instance fence for this connection's
    // sort-backfill and pauses there — the exact "registration owns the
    // fence, then a device request races in" ordering
    // runManifestRegistrationOracle's second scenario constructs.
    registration = driver.registerManifest(m2);
    await within(backfillAtTarget.promise, "M2 sort backfill to own the target instance");

    // While registration holds the fence, issue a real device batch against
    // the SAME connection — it must queue behind the fence, not interleave
    // with it or corrupt summary evidence.
    const raceRequest = batch(device, nextId("manifest-race"), [
      deviceRecord("race-during-registration", "during race", { timestamp: "2026-07-17T00:00:05.000Z" }),
    ]);
    const devicePromise = driver.ingest(device, raceRequest);

    releaseBackfill.resolve();
    await within(registration, "M2 registration/backfill completes");
    const deviceResult = await within(devicePromise, "device ingest queued behind M2 registration");
    assert.equal(deviceResult.status, 201, "the raced device batch is accepted once the registration fence releases");
  } finally {
    releaseBackfill.resolve();
    __setSqliteRecordSortBackfillPhaseHookForTest(null);
    __setPostgresRecordSortBackfillPhaseHookForTest(null);
    if (registration) {
      await Promise.allSettled([registration]);
    }
  }

  // Whichever actually landed first at the storage layer, the summary
  // primitive must converge on the true post-race state: both records
  // visible, manifest_declaration current under M2, no lost update.
  const result = await reconcileConnectorSummaryEvidence(null);
  assert.ok(result.discovered >= 1);
  const finalEvidence = await getConnectorSummaryEvidence(connectorInstanceId);
  assert.ok(finalEvidence, "finalEvidence must not be null");
  assert.equal(
    finalEvidence.total_records,
    2,
    "both the pre-race and raced records survive the registration race, none lost or duplicated"
  );
  assert.equal(
    finalEvidence.manifest_declaration.state,
    "current",
    "the manifest declaration is current (not unavailable/failed) after the race settles"
  );

  const persistedManifestRowRaw =
    driver.kind === "sqlite"
      ? getDb().prepare("SELECT manifest FROM connectors WHERE connector_id = ?").get("codex")
      : (await postgresQuery("SELECT manifest FROM connectors WHERE connector_id = $1", ["codex"])).rows[0];
  assert.ok(persistedManifestRowRaw, "manifest row must exist");
  const persistedManifestRow = persistedManifestRowRaw as { manifest: unknown };
  const persistedManifest =
    typeof persistedManifestRow.manifest === "string"
      ? JSON.parse(persistedManifestRow.manifest)
      : persistedManifestRow.manifest;
  const persistedMessages = (
    persistedManifest as { streams: { name: string; query: { search: { lexical_fields: string[] } } }[] }
  ).streams.find((stream) => stream.name === "messages");
  assert.ok(persistedMessages, "messages stream must exist in persisted manifest");
  assert.deepEqual(
    persistedMessages.query.search.lexical_fields,
    ["role"],
    "the manifest fingerprint is not orphaned/stale — M2 is the durably stored manifest after the race"
  );

  // The engine-only reconcile above repairs the manifest/record/retained-
  // bytes components but deliberately leaves `terminal_facts_state` at
  // `stale`/`manifest_generation_changed` (see `classifyCandidate`'s
  // `component_stale` reason in connector-summary-evidence-engine.ts) —
  // since the 2026-07-29 terminal-gate revision, resolving that component is
  // the terminal-fold barrier's job (`reconcileDirtyConnectorSummaryEvidence`
  // / `rebuildConnectorSummaryEvidence`), run independently by the
  // maintenance sweep rather than inline on every engine reconcile. A
  // standalone `reconcileConnectorSummaryEvidence` pass legitimately keeps
  // rediscovering the row as `component_stale` until that separate fold
  // barrier actually runs — so settling the race requires both barriers,
  // exactly as `runConnectorMaintenanceSweep` composes them in production.
  await reconcileDirtyConnectorSummaryEvidence(null);

  // Now that both barriers have run, a further reconcile pass is idempotent.
  const secondPass = await reconcileConnectorSummaryEvidence(null);
  assert.equal(secondPass.repaired, 0, "a pass after both barriers settle repairs nothing further");
}

async function runTerminalCollectionEvidenceOracle(driver: Driver) {
  const device = await enrollConfiguredDevice(driver, "terminal-evidence");
  const deviceId = String(device.device_id);
  const sourceInstanceId = String(device.source_instance_id);
  const connectorInstanceId = String(device.connector_instance_id);
  const deviceToken = String(device.device_token);
  const request = batch(device, nextId("terminal-evidence"), [
    deviceRecord("terminal-evidence-msg", "payload-sentinel-never-in-spine"),
  ]);
  assert.equal((await driver.ingest(device, request)).status, 201);

  const omittedCoverageStatuses = await postJson(
    `${driver.asUrl}/_ref/device-exporters/${encodeURIComponent(deviceId)}/source-instances/${encodeURIComponent(sourceInstanceId)}/terminal-collection`,
    {
      connector_id: "codex",
      run_id: nextId("local-terminal-invalid"),
      source_instance_id: sourceInstanceId,
      streams: [{ pending_detail_gaps: 0, stream: "messages" }],
    },
    authHeaders(deviceToken)
  );
  assert.equal(
    omittedCoverageStatuses.status,
    400,
    "missing raw coverage status must not normalize to a complete fact"
  );

  const report = await postJson(
    `${driver.asUrl}/_ref/device-exporters/${encodeURIComponent(deviceId)}/source-instances/${encodeURIComponent(sourceInstanceId)}/terminal-collection`,
    {
      connector_id: "codex",
      run_id: nextId("local-terminal"),
      source_instance_id: sourceInstanceId,
      streams: [
        { coverage_statuses: ["collected"], stream: "messages" },
        { coverage_statuses: ["inventory_only"], stream: "history" },
        { coverage_statuses: ["deferred"], stream: "logs" },
        { coverage_statuses: ["missing"], stream: "rules" },
        { coverage_statuses: ["unaccounted"], stream: "skills" },
      ],
    },
    authHeaders(deviceToken)
  );
  assert.equal(report.status, 201, JSON.stringify(report.body));
  await reconcileDirtyConnectorSummaryEvidence([connectorInstanceId]);

  const summaryRaw =
    driver.kind === "sqlite"
      ? getDb()
          .prepare(
            "SELECT terminal_facts_state, stream_latest_facts_json FROM connector_summary_evidence WHERE connector_instance_id = ?"
          )
          .get(connectorInstanceId)
      : (
          await postgresQuery(
            "SELECT terminal_facts_state, stream_latest_facts_json::text AS stream_latest_facts_json FROM connector_summary_evidence WHERE connector_instance_id = $1",
            [connectorInstanceId]
          )
        ).rows[0];
  assert.ok(summaryRaw, "summary row must exist");
  const summary = summaryRaw as { terminal_facts_state: string; stream_latest_facts_json: string };
  assert.equal(summary.terminal_facts_state, "current");
  interface StreamFact {
    fact: Record<string, unknown>;
  }
  const facts = JSON.parse(summary.stream_latest_facts_json) as {
    messages?: StreamFact;
    history?: StreamFact;
    logs?: StreamFact;
    rules?: StreamFact;
    skills?: StreamFact;
    function_calls?: StreamFact;
  };
  assert.ok(facts.messages, "facts.messages must exist");
  assert.equal(facts.messages.fact.checkpoint, "committed");
  assert.equal(facts.messages.fact.pending_detail_gaps, 0, "collected evidence may establish zero pending gaps");
  assert.ok(facts.history, "facts.history must exist");
  assert.deepEqual(
    facts.history.fact.coverage_statuses,
    ["inventory_only"],
    "raw accepted-absence evidence survives the summary fold"
  );
  assert.ok(facts.logs, "facts.logs must exist");
  assert.deepEqual(
    facts.logs.fact.coverage_statuses,
    ["deferred"],
    "raw accepted-absence evidence survives the summary fold"
  );
  assert.ok(facts.rules, "facts.rules must exist");
  assert.equal(facts.rules.fact.pending_detail_gaps, 1, "missing evidence must retain an unresolved gap");
  assert.ok(facts.skills, "facts.skills must exist");
  assert.equal(facts.skills.fact.pending_detail_gaps, 1, "unaccounted evidence must retain an unresolved gap");
  assert.equal(facts.function_calls, undefined, "an omitted stream receives no invented terminal fact");

  const spineRaw =
    driver.kind === "sqlite"
      ? getDb()
          .prepare("SELECT data_json FROM spine_events WHERE connector_instance_id = ? AND event_type = ?")
          .get(connectorInstanceId, "run.completed")
      : (
          await postgresQuery(
            "SELECT data_json::text AS data_json FROM spine_events WHERE connector_instance_id = $1 AND event_type = $2",
            [connectorInstanceId, "run.completed"]
          )
        ).rows[0];
  assert.ok(spineRaw, "spine row must exist");
  assert.doesNotMatch((spineRaw as { data_json: string }).data_json, RE_PAYLOAD_SENTINEL);

  // A failed/incomplete local attempt has no successful terminal report, so
  // it cannot replace this committed fact. This is the producer boundary:
  // accepted batches alone remain insufficient evidence.
  const failedBatch = batch(device, nextId("failed-terminal-evidence"), [deviceRecord("failed-msg", "second")], 2);
  assert.equal((await driver.ingest(device, failedBatch)).status, 201);
  await reconcileConnectorSummaryEvidence(null);
  const afterFailedAttemptRaw =
    driver.kind === "sqlite"
      ? getDb()
          .prepare("SELECT stream_latest_facts_json FROM connector_summary_evidence WHERE connector_instance_id = ?")
          .get(connectorInstanceId)
      : (
          await postgresQuery(
            "SELECT stream_latest_facts_json::text AS stream_latest_facts_json FROM connector_summary_evidence WHERE connector_instance_id = $1",
            [connectorInstanceId]
          )
        ).rows[0];
  assert.ok(afterFailedAttemptRaw, "afterFailedAttempt row must exist");
  assert.equal(
    JSON.parse((afterFailedAttemptRaw as { stream_latest_facts_json: string }).stream_latest_facts_json).messages.fact
      .checkpoint,
    "committed"
  );
}

const ORACLES: [string, (driver: Driver) => Promise<void>][] = [
  ["accepted replay converges the summary primitive without double-counting", runAcceptedReplayOracle],
  ["partial-prefix resume converges the summary primitive on the correct final state", runPartialPrefixResumeOracle],
  [
    "manifest registration racing an in-flight device batch converges the summary primitive with no lost update",
    runManifestRaceOracle,
  ],
  [
    "terminal local-device evidence reaches the per-stream summary fold without inventing optional or failed-run facts",
    runTerminalCollectionEvidenceOracle,
  ],
];

for (const [name, oracle] of ORACLES) {
  test(`SQLite device-batch summary-evidence convergence: ${name}`, async () => {
    await withBackend("sqlite", oracle);
  });
  test(`PostgreSQL device-batch summary-evidence convergence: ${name} (skipped: PDPP_TEST_POSTGRES_URL unset)`, {
    skip: !DEDICATED_POSTGRES_URL,
  }, async () => {
    await withBackend("postgres", oracle);
  });
}
