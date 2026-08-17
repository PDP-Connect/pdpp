// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
// biome-ignore lint/correctness/noUnresolvedImports: Biome resolver lacks this runtime-supported dependency export shape.
import Database from "better-sqlite3";
import { emitSpineEvent, type SpineEventRecord } from "../lib/spine.ts";
import { runConnector } from "../runtime/index.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { closeDb as closeDbUntyped, getDb as getDbUntyped, initDb as initDbUntyped } from "../server/db.ts";
import { startServer as startServerUntyped } from "../server/index.ts";
import { ingestRecord as ingestRecordUntyped } from "../server/records.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { admitOwnerRunConnection } from "../server/stores/connector-instance-store.ts";

// Real ingest resolves the acting owner subject from the request's bearer
// token (`getOwnerTokenSubjectId` in server/index.ts), independent of
// `runConnector`'s own `ownerSubjectId` option (always null in this suite).
// This file's dominant owner-token subject is 'u1' (see `issueOwnerToken`
// call sites below), so admission must materialize/resolve that same subject
// via the real store — mirrors the exact production wiring in
// server/index.ts's `createController({ admitRunConnection: ... })`.
function fakeAdmitRunConnection(
  ownerSubjectIdDefault = "u1"
): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return async ({ connectorId, connectorInstanceId, ownerSubjectId: requestedOwnerSubjectId }) => {
    const ownerSubjectId = requestedOwnerSubjectId || ownerSubjectIdDefault;
    const namespace = await admitOwnerRunConnection({
      connectorId,
      connectorInstanceId,
      connectorInstanceStore: createRequestConnectorInstanceStore(),
      ownerSubjectId,
    });
    return { connectorId: namespace.connectorId, connectorInstanceId: namespace.connectorInstanceId, ownerSubjectId };
  };
}

/**
 * Naive echo admission double for the one test in this file that claims an
 * arbitrary, never-registered literal `connectorInstanceId` purely to assert
 * the runtime carries that exact claim onto its own spine events — it never
 * ingests through the real RS, so it does not need (and would fail against)
 * the real-store `fakeAdmitRunConnection` above.
 */
function fakeEchoAdmitRunConnection(): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return ({ connectorId, connectorInstanceId, ownerSubjectId: requestedOwnerSubjectId }) => {
    const ownerSubjectId = requestedOwnerSubjectId || "u1";
    const exactId = connectorInstanceId ?? `cin_${ownerSubjectId}_${connectorId.replace(/[^a-z0-9]+/gi, "_")}`;
    return Promise.resolve({ connectorId, connectorInstanceId: exactId, ownerSubjectId });
  };
}

const REGEXP_1 = /Access Denied/;
const REGEXP_2 = /view and fields are mutually exclusive/;
const REGEXP_3 = /Unknown field: not_a_real_field/;
const REGEXP_4 = /Unknown connector: missing_spotify_connector/;
const REGEXP_5 = /Unknown connector: missing_spotify_connector/;
const REGEXP_6 = /is not scoped to stream recently_played/;
const REGEXP_7 = /State persistence failed for other_items: 500/;
const REGEXP_8 = /Connector reported records_emitted 2 but runtime observed 1/;
const REGEXP_9 = /succeeded runs must not include terminal error details/;
const REGEXP_10 = /PROGRESS for undeclared stream/;
const REGEXP_11 = /SKIP_RESULT for undeclared stream/;
const REGEXP_12 = /Connector emitted invalid JSONL after DONE:/;
const REGEXP_13 = /INTERACTION for undeclared stream/;
const REGEXP_14 = /Connector emitted invalid JSONL while waiting for INTERACTION_RESPONSE:/;
const REGEXP_15 = /denied the request/;

/**
 * The real `SpineEventRecord.data` is `unknown` (each event type's payload
 * shape is genuinely dynamic). This suite reads many different top-level
 * payload fields by loose property access, plus two specific nested shapes
 * (`source.{kind,id}`, `error.{code,message}`) that recur across many event
 * types — those two are typed exactly; everything else stays `unknown` and
 * gets a local cast/narrowing guard at its own access site, same as any
 * other untyped-boundary read in this migration.
 */
interface TestSpineEventData {
  error?: { code: string; message: string };
  source?: { kind: string; id: string };
  [key: string]: unknown;
}
type TestSpineEvent = Omit<SpineEventRecord, "data"> & { data: TestSpineEventData };

/**
 * Narrows a value this suite has already implicitly asserted is present
 * (extracted from a prior response/DB read that must have succeeded for the
 * test to have gotten this far) before using it in a URL. Fails loudly with
 * a clear message rather than silently building a URL containing the string
 * "undefined"/"null" if that assumption is ever wrong.
 */
function requirePathSegment(value: string | null | undefined, label: string): string {
  assert.ok(typeof value === "string" && value.length > 0, `${label} must be a non-empty string`);
  return value;
}

/** `http.Server.address()` returns `string | AddressInfo | null` (a Unix socket path is a bare string). This suite only ever listens on TCP loopback. */
function requireTcpPort(server: http.Server): number {
  const address = server.address();
  assert.ok(address && typeof address === "object", "expected a TCP AddressInfo, not a Unix socket path");
  return address.port;
}

/** Shared response-body shapes for `.json()` calls not routed through `fetchJson<T>`. */
interface ParInitiateBody {
  request_uri: string;
}
interface ConsentApprovalBody {
  grant: { grant_id: string };
  token: string;
}

async function approveReviewedConsent(asUrl: string, requestUri: string, subjectId: string): Promise<Response> {
  const reviewResp = await fetch(`${asUrl}/consent/review`, {
    body: JSON.stringify({ request_uri: requestUri, subject_id: subjectId }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  const reviewBody = (await reviewResp.json()) as {
    approval_review?: unknown;
    approval_review_revision?: unknown;
  };
  assert.equal(reviewResp.status, 200, JSON.stringify(reviewBody));
  assert.ok(reviewBody.approval_review && typeof reviewBody.approval_review === "object");
  assert.equal(typeof reviewBody.approval_review_revision, "string");
  return fetch(`${asUrl}/consent/approve`, {
    body: JSON.stringify({
      approval_review_revision: reviewBody.approval_review_revision,
      request_uri: requestUri,
    }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
}
interface StreamRecordsBody {
  data: unknown[];
}
interface RegistrationBody {
  client_id?: string;
  client_name?: string;
  error?: string;
  redirect_uri_count?: number;
  requested_client_name?: string;
  requested_token_endpoint_auth_method?: string;
  token_endpoint_auth_method?: string;
}
interface DeviceTokenBody {
  access_token?: string;
  error?: string;
}

/** The shape `runConnector` rejects with (checkpoint/failure metadata on a real Error). */
interface RunConnectorError extends Error {
  checkpoint_summary?: {
    records_flushed?: number;
    state_streams_staged?: number;
    state_streams_committed?: number;
  };
  connector_error?: unknown;
  failure_reason?: string;
  run_id?: string;
  terminal_reason?: string;
}

interface TraceTimelineBody {
  data: TestSpineEvent[];
  grant_id?: string;
  [key: string]: unknown;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const TEST_DCR_INITIAL_ACCESS_TOKEN = "pdpp-reference-test-initial-access-token";
const SPOTIFY_CONNECTOR_KEY = canonicalConnectorKey("https://registry.pdpp.dev/connectors/spotify");

/**
 * `server/index.js`, `server/db.js`, `server/records.js`, `runtime/index.ts`
 * are unchecked JS (allowJs, checkJs:false); boundary-cast the shapes this
 * file actually touches once here, matching the pattern already established
 * in `run-interaction-stream-routes.test.ts`/`control-plane.test.ts`/
 * `control-actions.test.ts` (same startServer/getDb shape reused, not a
 * divergent one for the same functions).
 */
interface ClosableServer {
  asPort: number;
  asServer: { close: (cb: () => void) => void; closeAllConnections: () => void };
  rsPort: number;
  rsServer: { close: (cb: () => void) => void; closeAllConnections: () => void };
}
interface StartServerOptions {
  asPort?: number;
  dbPath?: string;
  dynamicClientRegistrationInitialAccessTokens?: string[];
  quiet?: boolean;
  rsPort?: number;
}
const startServer = startServerUntyped as unknown as (opts: StartServerOptions) => Promise<ClosableServer>;

interface PreparedStatement {
  all: <T = Record<string, unknown>>(...params: unknown[]) => T[];
  get: <T = Record<string, unknown>>(...params: unknown[]) => T | undefined;
  run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
}
interface DbHandle {
  pragma: (sql: string, options?: { simple?: boolean }) => unknown;
  prepare: (sql: string) => PreparedStatement;
  transaction: <T extends (...args: never[]) => unknown>(fn: T) => T;
}
const getDb = getDbUntyped as unknown as () => DbHandle;
const initDb = initDbUntyped as unknown as (path?: string, opts?: Record<string, unknown>) => void;
const closeDb = closeDbUntyped as unknown as () => void;

interface IngestRecordShape {
  data: unknown;
  emitted_at?: string;
  key: string;
  op?: string;
  stream: string;
}
interface IngestRecordResult {
  accepted: boolean;
  changed: boolean;
  self_healed?: boolean;
}
const ingestRecord = ingestRecordUntyped as unknown as (
  storageTarget: string,
  record: IngestRecordShape,
  options?: Record<string, unknown>
) => Promise<IngestRecordResult>;

async function closeServer(server: ClosableServer): Promise<void> {
  // Force-close keep-alive connections to prevent hanging.
  // Clear fallback timers when close callbacks win so the harness does not
  // retain stray timer handles after an otherwise clean shutdown.
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();

  const closeWithTimeout = (srv: ClosableServer["asServer"]) =>
    new Promise<void>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      }, 2000);

      srv.close(() => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });

  await Promise.allSettled([closeWithTimeout(server.asServer), closeWithTimeout(server.rsServer)]);
}

async function closeHttpServer(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function fetchJson<T = unknown>(
  url: string,
  opts: RequestInit = {}
): Promise<{ status: number; body: T; headers: Record<string, string> }> {
  const resp = await fetch(url, opts);
  const body = (await resp.json()) as T;
  return {
    body,
    headers: Object.fromEntries(resp.headers.entries()),
    status: resp.status,
  };
}

interface DeviceAuthorizationBody {
  device_code: string;
  user_code: string;
}
interface TokenBody {
  access_token: string;
}

async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
  const clientId = "cli_longview";
  const { body: device } = await fetchJson<DeviceAuthorizationBody>(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });

  const approveResp = await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(approveResp.status, 200);

  const { body: tokenBody } = await fetchJson<TokenBody>(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });

  return tokenBody.access_token;
}

interface TestConnectorManifest {
  connector_id: string;
  connector_key?: string;
  [key: string]: unknown;
}

interface HarnessContext {
  asUrl: string;
  rsUrl: string;
  spotifyManifest: TestConnectorManifest;
}

async function withHarness(fn: (ctx: HarnessContext) => Promise<void>): Promise<void> {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "manifests/spotify.json"), "utf8")
  ) as TestConnectorManifest;

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    await fn({ asUrl, rsUrl, spotifyManifest });
  } finally {
    await closeServer(server);
  }
}

// biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
async function registerDynamicClient(
  asUrl: string,
  metadata: Record<string, unknown>,
  initialAccessToken = TEST_DCR_INITIAL_ACCESS_TOKEN
) {
  return fetchJson<RegistrationBody>(`${asUrl}/oauth/register`, {
    body: JSON.stringify(metadata),
    headers: {
      Authorization: `Bearer ${initialAccessToken}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
}

interface NativeHarnessContext {
  asUrl: string;
  nativeManifest: Record<string, unknown>;
  rsUrl: string;
}

async function withNativeHarness(fn: (ctx: NativeHarnessContext) => Promise<void>): Promise<void> {
  const nativeManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "manifests/northstar-hr.json"), "utf8"));
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
    ...({ nativeManifest } as Record<string, unknown>),
  } as StartServerOptions);
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    await fn({ asUrl, nativeManifest, rsUrl });
  } finally {
    await closeServer(server);
  }
}

// biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
async function seedSpotify(
  rsUrl: string,
  manifest: Record<string, unknown>,
  ownerToken: string,
  options: { connectorInstanceId?: string; ownerSubjectId?: string } = {}
) {
  return runConnector({
    admitRunConnection: fakeAdmitRunConnection(options.ownerSubjectId ?? "u1"),
    connectorId: manifest.connector_id as string,
    connectorPath: join(REFERENCE_IMPL_DIR, "connectors/seed/index.ts"),
    ...(options.connectorInstanceId ? { connectorInstanceId: options.connectorInstanceId } : {}),
    collectionMode: "full_refresh",
    manifest,
    ownerToken,
    rsUrl,
    state: null,
  });
}

async function seedNorthstar(nativeManifest: Record<string, unknown>): Promise<void> {
  const storageBinding = nativeManifest.storage_binding as { connector_id: string };
  const connectorId = storageBinding.connector_id;
  const records = [
    {
      data: {
        currency: "USD",
        employee_id: "emp_123",
        employer: "Northstar HR",
        gross_pay: 5400,
        issued_at: "2026-04-16T12:00:00Z",
        net_pay: 3912,
        pay_period_end: "2026-04-15",
        pay_period_start: "2026-04-01",
        statement_id: "ps_2026_04_15",
      },
      emitted_at: "2026-04-16T12:00:00Z",
      key: "ps_2026_04_15",
      stream: "pay_statements",
    },
  ];

  for (const record of records) {
    // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
    await ingestRecord(connectorId, record);
  }
}

test("event spine", async (t) => {
  // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
  await t.test("migrates pre-source-column spine rows without losing row counts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-spine-migration-"));
    const dbPath = join(dir, "legacy.sqlite");
    const oldDb = new Database(dbPath);

    try {
      oldDb.exec(`
        CREATE TABLE spine_events (
          event_id         TEXT PRIMARY KEY,
          event_seq        INTEGER,
          event_type       TEXT NOT NULL,
          occurred_at      TEXT NOT NULL,
          recorded_at      TEXT NOT NULL,
          scenario_id      TEXT NOT NULL,
          trace_id         TEXT NOT NULL,
          actor_type       TEXT NOT NULL,
          actor_id         TEXT NOT NULL,
          subject_type     TEXT,
          subject_id       TEXT,
          object_type      TEXT NOT NULL,
          object_id        TEXT NOT NULL,
          status           TEXT NOT NULL,
          request_id       TEXT,
          grant_id         TEXT,
          run_id           TEXT,
          provider_id      TEXT,
          client_id        TEXT,
          stream_id        TEXT,
          token_id         TEXT,
          interaction_id   TEXT,
          data_json        TEXT NOT NULL,
          version          TEXT NOT NULL
        )
      `);
      const insert = oldDb.prepare(`
        INSERT INTO spine_events (
          event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
          actor_type, actor_id, object_type, object_id, status, provider_id, data_json, version
        )
        VALUES (@event_id, @event_seq, @event_type, @occurred_at, @recorded_at, @scenario_id, @trace_id,
          @actor_type, @actor_id, @object_type, @object_id, @status, @provider_id, @data_json, @version)
      `);
      insert.run({
        actor_id: "client_a",
        actor_type: "client",
        data_json: JSON.stringify({
          source: { binding_kind: "connector", connector_id: "conn_legacy" },
        }),
        event_id: "evt_connector_legacy",
        event_seq: 1,
        event_type: "query.received",
        object_id: "req_a",
        object_type: "query",
        occurred_at: "2026-04-01T00:00:00Z",
        provider_id: null,
        recorded_at: "2026-04-01T00:00:01Z",
        scenario_id: "scn_test",
        status: "succeeded",
        trace_id: "trc_test",
        version: "spine.v1",
      });
      insert.run({
        actor_id: "pdpp_reference",
        actor_type: "authorization_server",
        data_json: JSON.stringify({
          source: { binding_kind: "provider_native", provider_id: "provider_legacy" },
        }),
        event_id: "evt_native_legacy",
        event_seq: 2,
        event_type: "grant.issued",
        object_id: "grant_native",
        object_type: "grant",
        occurred_at: "2026-04-01T00:00:02Z",
        provider_id: "provider_legacy",
        recorded_at: "2026-04-01T00:00:03Z",
        scenario_id: "scn_test",
        status: "succeeded",
        trace_id: "trc_test",
        version: "spine.v1",
      });
      insert.run({
        actor_id: "conn_runtime_fallback",
        actor_type: "runtime",
        data_json: JSON.stringify({ source: "connector-payload-label" }),
        event_id: "evt_runtime_source_scalar",
        event_seq: 3,
        event_type: "run.completed",
        object_id: "run_runtime_fallback",
        object_type: "run",
        occurred_at: "2026-04-01T00:00:04Z",
        provider_id: null,
        recorded_at: "2026-04-01T00:00:05Z",
        scenario_id: "scn_test",
        status: "succeeded",
        trace_id: "trc_test",
        version: "spine.v1",
      });
      oldDb.close();

      const migrations: { droppedProviderId?: boolean; rowCount?: number }[] = [];
      initDb(dbPath, { onSchemaMigration: (event: { droppedProviderId?: boolean }) => migrations.push(event) });
      const db = getDb();
      const columns = db
        .prepare("PRAGMA table_info(spine_events)")
        .all()
        .map((row) => row.name);
      const rowCountRow = db.prepare("SELECT COUNT(*) AS count FROM spine_events").get<{ count: number }>();
      assert.ok(rowCountRow, "row count query must return a row");
      const rowCount = rowCountRow.count;

      // Boot performs only the bounded, idempotent schema DDL: it adds the
      // source columns and index and drops the superseded provider_id column,
      // preserving the row count. It NO LONGER backfills source values — the
      // unbounded per-row backfill that scanned the whole table on every boot
      // was moved to an explicit operator maintenance script. Legacy rows
      // therefore keep NULL source columns after boot; reads derive source
      // from data_json. See openspec/changes/harden-startup-data-backfills.
      const backfilledCountRow = db
        .prepare("SELECT COUNT(*) AS count FROM spine_events WHERE source_kind IS NOT NULL OR source_id IS NOT NULL")
        .get<{ count: number }>();
      assert.ok(backfilledCountRow, "backfilled count query must return a row");
      const backfilledCount = backfilledCountRow.count;

      assert.equal(rowCount, 3);
      assert.equal(backfilledCount, 0, "boot must not backfill legacy source values");
      assert.equal(columns.includes("provider_id"), false);
      assert.ok(columns.includes("source_kind"));
      assert.ok(columns.includes("source_id"));
      assert.equal(migrations[0]?.droppedProviderId, true);
      assert.equal(
        Object.hasOwn(migrations[0] || {}, "rowCount"),
        false,
        "schema migration telemetry must not count spine rows during boot"
      );
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  });

  // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
  await t.test("migrates pre-event-seq spine rows before creating event_seq indexes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-spine-event-seq-migration-"));
    const dbPath = join(dir, "legacy.sqlite");
    const oldDb = new Database(dbPath);

    try {
      oldDb.exec(`
        CREATE TABLE spine_events (
          event_id         TEXT PRIMARY KEY,
          event_type       TEXT NOT NULL,
          occurred_at      TEXT NOT NULL,
          recorded_at      TEXT NOT NULL,
          scenario_id      TEXT NOT NULL,
          trace_id         TEXT NOT NULL,
          actor_type       TEXT NOT NULL,
          actor_id         TEXT NOT NULL,
          subject_type     TEXT,
          subject_id       TEXT,
          object_type      TEXT NOT NULL,
          object_id        TEXT NOT NULL,
          status           TEXT NOT NULL,
          request_id       TEXT,
          grant_id         TEXT,
          run_id           TEXT,
          source_kind      TEXT,
          source_id        TEXT,
          client_id        TEXT,
          stream_id        TEXT,
          token_id         TEXT,
          interaction_id   TEXT,
          data_json        TEXT NOT NULL,
          version          TEXT NOT NULL
        );

        INSERT INTO spine_events (
          event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
          actor_type, actor_id, object_type, object_id, status, run_id,
          source_kind, source_id, data_json, version
        )
        VALUES (
          'evt_legacy_without_event_seq',
          'run.completed',
          '2026-04-01T00:00:00Z',
          '2026-04-01T00:00:01Z',
          'scn_test',
          'trc_test',
          'runtime',
          'conn_legacy',
          'run',
          'run_legacy',
          'succeeded',
          'run_legacy',
          'connector',
          'conn_legacy',
          '{"source":{"kind":"connector","id":"conn_legacy"}}',
          'spine.v1'
        );
      `);
      oldDb.close();

      initDb(dbPath);
      const db = getDb();
      const columns = db
        .prepare("PRAGMA table_info(spine_events)")
        .all()
        // biome-ignore lint/suspicious/noShadow: Shadowed name mirrors the protocol field being asserted.
        .map((row) => row.name);
      const indexes = db
        .prepare("PRAGMA index_list(spine_events)")
        .all()
        // biome-ignore lint/suspicious/noShadow: Shadowed name mirrors the protocol field being asserted.
        .map((row) => row.name);
      const row = db
        .prepare("SELECT event_seq FROM spine_events WHERE event_id = ?")
        .get<{ event_seq: number }>("evt_legacy_without_event_seq");

      assert.ok(columns.includes("event_seq"));
      assert.ok(row, "expected the migrated event_seq row to exist");
      assert.equal(row.event_seq, 1);
      assert.ok(indexes.includes("idx_spine_events_run_terminal"));
      assert.ok(indexes.includes("idx_spine_events_seq"));
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  });

  await t.test("backfills event_seq safely after an interrupted concurrent Gmail append", () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-spine-event-seq-concurrent-migration-"));
    const dbPath = join(dir, "legacy.sqlite");
    const legacyDb = new Database(dbPath);

    try {
      legacyDb.exec(`
        CREATE TABLE spine_events (
          event_id         TEXT PRIMARY KEY,
          event_type       TEXT NOT NULL,
          occurred_at      TEXT NOT NULL,
          recorded_at      TEXT NOT NULL,
          scenario_id      TEXT NOT NULL,
          trace_id         TEXT NOT NULL,
          actor_type       TEXT NOT NULL,
          actor_id         TEXT NOT NULL,
          subject_type     TEXT,
          subject_id       TEXT,
          object_type      TEXT NOT NULL,
          object_id        TEXT NOT NULL,
          status           TEXT NOT NULL,
          request_id       TEXT,
          grant_id         TEXT,
          run_id           TEXT,
          source_kind      TEXT,
          source_id        TEXT,
          client_id        TEXT,
          stream_id        TEXT,
          token_id         TEXT,
          interaction_id   TEXT,
          data_json        TEXT NOT NULL,
          version          TEXT NOT NULL
        )
      `);
      const insertLegacyEvent = legacyDb.prepare(`
        INSERT INTO spine_events(
          event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
          actor_type, actor_id, object_type, object_id, status, run_id, data_json, version
        ) VALUES (@event_id, @event_type, @occurred_at, @recorded_at, 'gmail', @trace_id,
          'runtime', 'gmail', 'run', @run_id, @status, @run_id, @data_json, 'spine.v1')
      `);
      for (const event of [
        {
          data_json: JSON.stringify({ connector_id: "gmail", connector_instance_id: "gmail-a" }),
          event_id: "evt_gmail_legacy_a",
          event_type: "run.started",
          occurred_at: "2026-08-07T12:00:00.000Z",
          recorded_at: "2026-08-07T12:00:00.000Z",
          run_id: "run_gmail_a",
          status: "running",
          trace_id: "trace_gmail_a",
        },
        {
          data_json: JSON.stringify({ connector_id: "gmail", connector_instance_id: "gmail-b" }),
          event_id: "evt_gmail_legacy_b",
          event_type: "run.started",
          occurred_at: "2026-08-07T12:00:01.000Z",
          recorded_at: "2026-08-07T12:00:01.000Z",
          run_id: "run_gmail_b",
          status: "running",
          trace_id: "trace_gmail_b",
        },
      ]) {
        insertLegacyEvent.run(event);
      }
    } finally {
      legacyDb.close();
    }

    // The interrupted first boot committed the additive column but not its
    // backfill. A concurrent Gmail writer then used the normal MAX()+1
    // allocator while the legacy rows still had NULL event_seq values.
    const interruptedBootDb = new Database(dbPath);
    interruptedBootDb.exec("ALTER TABLE spine_events ADD COLUMN event_seq INTEGER");
    const concurrentGmailDb = new Database(dbPath);
    try {
      concurrentGmailDb
        .prepare(`
          INSERT INTO spine_events(
            event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
            actor_type, actor_id, object_type, object_id, status, run_id, data_json, version
        ) VALUES (
            @event_id, (SELECT COALESCE(MAX(event_seq), 0) + 1 FROM spine_events),
            @event_type, @occurred_at, @recorded_at, 'gmail', @trace_id,
            'runtime', 'gmail', 'run', @run_id, @status, @run_id, @data_json, 'spine.v1'
          )
        `)
        .run({
          data_json: JSON.stringify({ connector_id: "gmail", connector_instance_id: "gmail-a" }),
          event_id: "evt_gmail_concurrent_append",
          event_type: "run.failed",
          occurred_at: "2026-08-07T12:00:02.000Z",
          recorded_at: "2026-08-07T12:00:02.000Z",
          run_id: "run_gmail_a",
          status: "failed",
          trace_id: "trace_gmail_a",
        });
    } finally {
      concurrentGmailDb.close();
      interruptedBootDb.close();
    }

    try {
      initDb(dbPath);
      const db = getDb();
      const rows = db
        .prepare("SELECT event_id, event_seq FROM spine_events ORDER BY event_seq")
        .all<{ event_id: string; event_seq: number }>();

      assert.deepEqual(rows, [
        { event_id: "evt_gmail_concurrent_append", event_seq: 1 },
        { event_id: "evt_gmail_legacy_a", event_seq: 2 },
        { event_id: "evt_gmail_legacy_b", event_seq: 3 },
      ]);
      assert.equal(new Set(rows.map((row) => row.event_seq)).size, rows.length);
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  });

  await t.test("captures dynamic client registration success and rejection as trace artifacts", async () => {
    await withHarness(async ({ asUrl }) => {
      const registration = await registerDynamicClient(asUrl, {
        client_name: "Dynamic Longview",
        redirect_uris: ["https://longview.example/callback"],
        token_endpoint_auth_method: "none",
      });

      assert.equal(registration.status, 201);
      const successRequestId = registration.headers["request-id"];
      const successTraceId = registration.headers["pdpp-reference-trace-id"];
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      assert.ok(successRequestId?.startsWith("req_"));
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      assert.ok(successTraceId?.startsWith("trc_"));

      const { body: successTrace } = await fetchJson<TraceTimelineBody>(
        `${asUrl}/_ref/traces/${encodeURIComponent(requirePathSegment(successTraceId, "successTraceId"))}`
      );
      const registeredEvent = (successTrace.data || []).find((event) => event.event_type === "client.registered");
      assert.ok(registeredEvent, "expected client.registered event");
      assert.equal(registeredEvent.request_id, successRequestId);
      assert.equal(registeredEvent.trace_id, successTraceId);
      assert.equal(registeredEvent.object_id, registration.body.client_id);
      assert.equal(registeredEvent.client_id, registration.body.client_id);
      assert.equal(registeredEvent.data?.client_name, "Dynamic Longview");
      assert.equal(registeredEvent.data?.token_endpoint_auth_method, "none");
      assert.equal(registeredEvent.data?.redirect_uri_count, 1);

      const rejectedResp = await fetch(`${asUrl}/oauth/register`, {
        body: JSON.stringify({
          client_name: "Rejected Client",
          token_endpoint_auth_method: "none",
        }),
        headers: {
          Authorization: "Bearer wrong-token",
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      assert.equal(rejectedResp.status, 401);
      const rejectedRequestId = rejectedResp.headers.get("Request-Id");
      const rejectedTraceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(rejectedRequestId?.startsWith("req_"));
      assert.ok(rejectedTraceId?.startsWith("trc_"));

      const { body: rejectedTrace } = await fetchJson<TraceTimelineBody>(
        `${asUrl}/_ref/traces/${encodeURIComponent(requirePathSegment(rejectedTraceId, "rejectedTraceId"))}`
      );
      const rejectedEvent = (rejectedTrace.data || []).find((event) => event.event_type === "client.register_rejected");
      assert.ok(rejectedEvent, "expected client.register_rejected event");
      assert.equal(rejectedEvent.request_id, rejectedRequestId);
      assert.equal(rejectedEvent.trace_id, rejectedTraceId);
      assert.equal(rejectedEvent.object_id, rejectedRequestId);
      assert.equal(rejectedEvent.data?.requested_client_name, "Rejected Client");
      assert.equal(rejectedEvent.data?.requested_token_endpoint_auth_method, "none");
      assert.equal(rejectedEvent.data?.error?.code, "invalid_client");
    });
  });

  await t.test("captures a grant trace through disclosure and revocation", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const initiateResp = await fetch(`${asUrl}/oauth/par`, {
        body: JSON.stringify({
          authorization_details: [
            {
              access_mode: "single_use",
              purpose_code: "https://pdpp.dev/purpose/personalization",
              purpose_description: "Recommend concerts based on recent listening history",
              source: { id: spotifyManifest.connector_id, kind: "connector" },
              streams: [{ name: "top_artists", view: "basic" }],
              type: "https://pdpp.dev/data-access",
            },
          ],
          client_id: "concert_recommendation_app",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(initiateResp.status, 201);
      const initiateRequestId = initiateResp.headers.get("Request-Id");
      const initiateTraceId = initiateResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(initiateRequestId?.startsWith("req_"));
      assert.ok(initiateTraceId?.startsWith("trc_"));
      const initiate = (await initiateResp.json()) as ParInitiateBody;

      const approveResp = await approveReviewedConsent(asUrl, initiate.request_uri, "u1");
      assert.equal(approveResp.status, 200);
      const approval = (await approveResp.json()) as ConsentApprovalBody;

      const queryResp = await fetch(`${rsUrl}/v1/streams/top_artists/records?limit=3`, {
        headers: { Authorization: `Bearer ${approval.token}` },
      });
      assert.equal(queryResp.status, 200);
      const queryBody = (await queryResp.json()) as StreamRecordsBody;
      assert.ok(Array.isArray(queryBody.data));

      const revokeResp = await fetch(`${asUrl}/grants/${approval.grant.grant_id}/revoke`, {
        headers: {
          Authorization: `Bearer ${approval.token}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      assert.equal(revokeResp.status, 200);
      const revokeRequestId = revokeResp.headers.get("Request-Id");
      const revokeTraceId = revokeResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(revokeRequestId?.startsWith("req_"));

      const { body: grantTimeline } = await fetchJson<TraceTimelineBody>(
        `${asUrl}/_ref/grants/${encodeURIComponent(requirePathSegment(approval.grant.grant_id, "approval_grant_grant_id"))}/timeline`
      );
      const grantIssued = (grantTimeline.data || []).find((event) => event.event_type === "grant.issued");
      assert.ok(grantIssued, "expected grant.issued event");
      assert.equal(grantTimeline.grant_id, approval.grant.grant_id);
      assert.equal(revokeTraceId, grantIssued.trace_id);

      const { body: traceTimeline } = await fetchJson<TraceTimelineBody>(
        `${asUrl}/_ref/traces/${encodeURIComponent(grantIssued.trace_id)}`
      );
      const traceTypes = (traceTimeline.data || []).map((event) => event.event_type);
      assert.deepEqual(
        traceTypes.filter((eventType) =>
          [
            "request.submitted",
            "consent.approved",
            "grant.issued",
            "token.issued",
            "query.received",
            "disclosure.served",
            "grant.revoked",
          ].includes(eventType)
        ),
        [
          "request.submitted",
          "consent.approved",
          "grant.issued",
          "token.issued",
          "query.received",
          "disclosure.served",
          "grant.revoked",
        ]
      );

      for (const eventType of [
        "request.submitted",
        "consent.approved",
        "grant.issued",
        "token.issued",
        "grant.revoked",
      ]) {
        const event = (traceTimeline.data || []).find((entry) => entry.event_type === eventType);
        assert.ok(event, `expected ${eventType} event`);
        assert.equal(event.data?.source?.kind, "connector");
        assert.equal(event.data?.source?.id, spotifyManifest.connector_id);
        assert.ok(
          !("connector_id" in (event.data || {})),
          `${eventType} should use source descriptors instead of raw connector_id`
        );
        if (eventType === "request.submitted") {
          assert.equal(event.request_id, initiateRequestId);
          assert.equal(event.trace_id, initiateTraceId);
        }
        if (eventType === "grant.revoked") {
          assert.equal(event.request_id, revokeRequestId);
        }
      }

      const tokenIssued = (traceTimeline.data || []).find((event) => event.event_type === "token.issued");
      assert.ok(tokenIssued, "expected token.issued event");
      assert.equal(tokenIssued.data?.issuance_path, "grant_approval");
    });
  });

  await t.test("captures consent denial on the original staged provider-connect trace", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiateResp = await fetch(`${asUrl}/oauth/par`, {
        body: JSON.stringify({
          authorization_details: [
            {
              access_mode: "single_use",
              purpose_code: "https://pdpp.dev/purpose/personalization",
              purpose_description: "Recommend concerts based on recent listening history",
              source: { id: spotifyManifest.connector_id, kind: "connector" },
              streams: [{ name: "top_artists", view: "basic" }],
              type: "https://pdpp.dev/data-access",
            },
          ],
          client_id: "concert_recommendation_app",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(initiateResp.status, 201);
      const requestId = initiateResp.headers.get("Request-Id");
      const traceId = initiateResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(requestId?.startsWith("req_"));
      assert.ok(traceId?.startsWith("trc_"));
      const initiate = (await initiateResp.json()) as ParInitiateBody;

      const denyResp = await fetch(`${asUrl}/consent/deny`, {
        body: JSON.stringify({ request_uri: initiate.request_uri }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(denyResp.status, 200);
      assert.equal(denyResp.headers.get("Request-Id"), requestId);
      assert.equal(denyResp.headers.get("PDPP-Reference-Trace-Id"), traceId);
      const denyBody = await denyResp.text();
      assert.match(denyBody, REGEXP_1);

      const { body: traceTimeline } = await fetchJson<TraceTimelineBody>(
        `${asUrl}/_ref/traces/${encodeURIComponent(requirePathSegment(traceId, "traceId"))}`
      );
      const submittedEvent = (traceTimeline.data || []).find(
        (event) => event.event_type === "request.submitted" && event.request_id === requestId
      );
      assert.ok(submittedEvent, "expected request.submitted for staged provider-connect request");

      const deniedEvent = (traceTimeline.data || []).find(
        (event) => event.event_type === "consent.denied" && event.request_id === requestId
      );
      assert.ok(deniedEvent, "expected consent.denied for consent-shell denial");
      assert.equal(deniedEvent.client_id, "concert_recommendation_app");
      assert.equal(deniedEvent.object_type, "pending_consent");
      assert.equal(deniedEvent.status, "denied");
      assert.equal(deniedEvent.data?.source?.kind, "connector");
      assert.equal(deniedEvent.data?.source?.id, spotifyManifest.connector_id);

      const grantIssuedEvent = (traceTimeline.data || []).find((event) => event.event_type === "grant.issued");
      assert.equal(grantIssuedEvent, undefined, "denied consent should not issue a grant");
    });
  });

  await t.test("captures owner device start, polling, approval, and owner-token issuance on one trace", async () => {
    await withHarness(async ({ asUrl }) => {
      const deviceResp = await fetch(`${asUrl}/oauth/device_authorization`, {
        body: new URLSearchParams({ client_id: "cli_longview" }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      assert.equal(deviceResp.status, 200);

      const requestId = deviceResp.headers.get("Request-Id");
      const traceId = deviceResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(requestId?.startsWith("req_"));
      assert.ok(traceId?.startsWith("trc_"));

      const deviceBody = (await deviceResp.json()) as DeviceAuthorizationBody;

      const pendingResp = await fetch(`${asUrl}/oauth/token`, {
        body: new URLSearchParams({
          client_id: "cli_longview",
          device_code: deviceBody.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      assert.equal(pendingResp.status, 400);
      assert.equal(pendingResp.headers.get("Request-Id"), requestId);
      assert.equal(pendingResp.headers.get("PDPP-Reference-Trace-Id"), traceId);
      const pendingBody = (await pendingResp.json()) as DeviceTokenBody;
      assert.equal(pendingBody.error, "authorization_pending");

      const approveResp = await fetch(`${asUrl}/device/approve`, {
        body: new URLSearchParams({
          subject_id: "u1",
          user_code: deviceBody.user_code,
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      assert.equal(approveResp.status, 200);

      const exchangeResp = await fetch(`${asUrl}/oauth/token`, {
        body: new URLSearchParams({
          client_id: "cli_longview",
          device_code: deviceBody.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      assert.equal(exchangeResp.status, 200);
      assert.equal(exchangeResp.headers.get("Request-Id"), requestId);
      assert.equal(exchangeResp.headers.get("PDPP-Reference-Trace-Id"), traceId);
      const exchangeBody = (await exchangeResp.json()) as DeviceTokenBody;
      assert.ok(exchangeBody.access_token);

      const { body: traceTimeline } = await fetchJson<TraceTimelineBody>(
        `${asUrl}/_ref/traces/${encodeURIComponent(requirePathSegment(traceId, "traceId"))}`
      );

      // device_code / user_code are bearer-equivalent on owner_device_auth
      // (harden-reference-auth-surfaces §7) and are redacted on public _ref
      // reads. Internal correlation by request_id, client_id, and
      // issuance_path remains intact.
      const submittedEvent = (traceTimeline.data || []).find(
        (event) =>
          event.event_type === "request.submitted" &&
          event.object_type === "owner_device_auth" &&
          event.data?.issuance_path === "owner_device_flow"
      );
      assert.ok(submittedEvent, "expected request.submitted for owner device start");
      assert.equal(submittedEvent.request_id, requestId);
      assert.equal(submittedEvent.client_id, "cli_longview");
      assert.equal(submittedEvent.object_type, "owner_device_auth");
      assert.equal(submittedEvent.object_id, "<redacted-device-code>");
      assert.equal(submittedEvent.data?.user_code, "<redacted-bearer>");

      const approvedEvent = (traceTimeline.data || []).find(
        (event) => event.event_type === "consent.approved" && event.object_type === "owner_device_auth"
      );
      assert.ok(approvedEvent, "expected consent.approved for owner device approval");
      assert.equal(approvedEvent.request_id, requestId);
      assert.equal(approvedEvent.client_id, "cli_longview");
      assert.equal(approvedEvent.object_id, "<redacted-device-code>");
      assert.equal(approvedEvent.data?.user_code, "<redacted-bearer>");

      const tokenIssuedEvent = (traceTimeline.data || []).find(
        (event) => event.event_type === "token.issued" && event.data?.issuance_path === "owner_device_flow"
      );
      assert.ok(tokenIssuedEvent, "expected token.issued for owner device exchange");
      assert.equal(tokenIssuedEvent.request_id, requestId);
      assert.equal(tokenIssuedEvent.client_id, "cli_longview");
      assert.equal(tokenIssuedEvent.data?.user_code, "<redacted-bearer>");
    });
  });

  await t.test("captures owner device denial on one trace", async () => {
    await withHarness(async ({ asUrl }) => {
      const deviceResp = await fetch(`${asUrl}/oauth/device_authorization`, {
        body: new URLSearchParams({ client_id: "cli_longview" }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      assert.equal(deviceResp.status, 200);

      const requestId = deviceResp.headers.get("Request-Id");
      const traceId = deviceResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(requestId?.startsWith("req_"));
      assert.ok(traceId?.startsWith("trc_"));

      const deviceBody = (await deviceResp.json()) as DeviceAuthorizationBody;

      const denyResp = await fetch(`${asUrl}/device/deny`, {
        body: new URLSearchParams({
          subject_id: "u1",
          user_code: deviceBody.user_code,
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      assert.equal(denyResp.status, 200);

      const exchangeResp = await fetch(`${asUrl}/oauth/token`, {
        body: new URLSearchParams({
          client_id: "cli_longview",
          device_code: deviceBody.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      assert.equal(exchangeResp.status, 400);
      assert.equal(exchangeResp.headers.get("Request-Id"), requestId);
      assert.equal(exchangeResp.headers.get("PDPP-Reference-Trace-Id"), traceId);
      const exchangeBody = (await exchangeResp.json()) as DeviceTokenBody;
      assert.equal(exchangeBody.error, "access_denied");

      const { body: traceTimeline } = await fetchJson<TraceTimelineBody>(
        `${asUrl}/_ref/traces/${encodeURIComponent(requirePathSegment(traceId, "traceId"))}`
      );

      const submittedEvent = (traceTimeline.data || []).find(
        (event) =>
          event.event_type === "request.submitted" &&
          event.object_type === "owner_device_auth" &&
          event.data?.issuance_path === "owner_device_flow"
      );
      assert.ok(submittedEvent, "expected request.submitted for owner device start");
      assert.equal(submittedEvent.request_id, requestId);
      assert.equal(submittedEvent.client_id, "cli_longview");
      assert.equal(submittedEvent.object_id, "<redacted-device-code>");
      assert.equal(submittedEvent.data?.user_code, "<redacted-bearer>");

      const rejectedEvent = (traceTimeline.data || []).find(
        (event) => event.event_type === "request.rejected" && event.request_id === requestId
      );
      assert.ok(rejectedEvent, "expected request.rejected for owner device denial");
      assert.equal(rejectedEvent.client_id, "cli_longview");
      assert.equal(rejectedEvent.object_type, "owner_device_auth");
      assert.equal(rejectedEvent.object_id, "<redacted-device-code>");
      assert.equal(rejectedEvent.data?.issuance_path, "owner_device_flow");
      assert.equal(rejectedEvent.data?.user_code, "<redacted-bearer>");
      assert.equal(rejectedEvent.data?.error?.code, "access_denied");
      assert.match(rejectedEvent.data?.error?.message || "", REGEXP_15);
    });
  });

  await t.test("captures rejected connector grant reads on the grant trace and timeline", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const { body: initiate } = await fetchJson<ParInitiateBody>(`${asUrl}/oauth/par`, {
        body: JSON.stringify({
          authorization_details: [
            {
              access_mode: "single_use",
              purpose_code: "https://pdpp.dev/purpose/personalization",
              purpose_description: "Recommend concerts based on recent listening history",
              source: { id: spotifyManifest.connector_id, kind: "connector" },
              streams: [{ name: "top_artists", view: "basic" }],
              type: "https://pdpp.dev/data-access",
            },
          ],
          client_id: "concert_recommendation_app",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      const approveResp = await approveReviewedConsent(asUrl, initiate.request_uri, "u1");
      assert.equal(approveResp.status, 200);
      const approval = (await approveResp.json()) as ConsentApprovalBody;

      const rejectedResp = await fetch(`${rsUrl}/v1/streams/top_artists/records?view=basic&fields=id`, {
        headers: { Authorization: `Bearer ${approval.token}` },
      });
      assert.equal(rejectedResp.status, 400);
      const requestId = rejectedResp.headers.get("Request-Id");
      const traceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(requestId?.startsWith("req_"));
      assert.ok(traceId?.startsWith("trc_"));

      const { body: grantTimeline } = await fetchJson<TraceTimelineBody>(
        `${asUrl}/_ref/grants/${encodeURIComponent(requirePathSegment(approval.grant.grant_id, "approval_grant_grant_id"))}/timeline`
      );
      const { body: traceTimeline } = await fetchJson<TraceTimelineBody>(
        `${asUrl}/_ref/traces/${encodeURIComponent(requirePathSegment(traceId, "traceId"))}`
      );

      for (const timeline of [grantTimeline, traceTimeline]) {
        const queryReceived = (timeline.data || []).find(
          (event) => event.event_type === "query.received" && event.object_id === requestId
        );
        assert.ok(queryReceived, "expected query.received for rejected connector grant read");
        assert.equal(queryReceived.data.query_shape, "record_list");
        assert.equal(queryReceived.data.source?.kind, "connector");
        assert.equal(queryReceived.data.source?.id, spotifyManifest.connector_id);
        assert.ok(!("connector_id" in (queryReceived.data || {})));

        const rejected = (timeline.data || []).find(
          (event) => event.event_type === "query.rejected" && event.object_id === requestId
        );
        assert.ok(rejected, "expected query.rejected for rejected connector grant read");
        assert.equal(rejected.data.query_shape, "record_list");
        assert.equal(rejected.data.source?.kind, "connector");
        assert.equal(rejected.data.source?.id, spotifyManifest.connector_id);
        assert.equal(rejected.data.error?.code, "invalid_request");
        assert.match(rejected.data.error?.message || "", REGEXP_2);
        assert.ok(!("connector_id" in (rejected.data || {})));
      }
    });
  });

  await t.test("captures unknown-field connector grant reads on the grant trace and timeline", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const { body: initiate } = await fetchJson<ParInitiateBody>(`${asUrl}/oauth/par`, {
        body: JSON.stringify({
          authorization_details: [
            {
              access_mode: "single_use",
              purpose_code: "https://pdpp.dev/purpose/personalization",
              purpose_description: "Recommend concerts based on recent listening history",
              source: { id: spotifyManifest.connector_id, kind: "connector" },
              streams: [{ fields: ["id", "name"], name: "saved_tracks" }],
              type: "https://pdpp.dev/data-access",
            },
          ],
          client_id: "concert_recommendation_app",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      const approveResp = await approveReviewedConsent(asUrl, initiate.request_uri, "u1");
      assert.equal(approveResp.status, 200);
      const approval = (await approveResp.json()) as ConsentApprovalBody;

      const rejectedResp = await fetch(`${rsUrl}/v1/streams/saved_tracks/records?fields=id,not_a_real_field`, {
        headers: { Authorization: `Bearer ${approval.token}` },
      });
      assert.equal(rejectedResp.status, 400);
      const requestId = rejectedResp.headers.get("Request-Id");
      const traceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(requestId?.startsWith("req_"));
      assert.ok(traceId?.startsWith("trc_"));

      const { body: grantTimeline } = await fetchJson<TraceTimelineBody>(
        `${asUrl}/_ref/grants/${encodeURIComponent(requirePathSegment(approval.grant.grant_id, "approval_grant_grant_id"))}/timeline`
      );
      const { body: traceTimeline } = await fetchJson<TraceTimelineBody>(
        `${asUrl}/_ref/traces/${encodeURIComponent(requirePathSegment(traceId, "traceId"))}`
      );

      for (const timeline of [grantTimeline, traceTimeline]) {
        const queryReceived = (timeline.data || []).find(
          (event) => event.event_type === "query.received" && event.object_id === requestId
        );
        assert.ok(queryReceived, "expected query.received for rejected connector unknown-field read");
        assert.equal(queryReceived.data.query_shape, "record_list");
        assert.equal(queryReceived.data.source?.kind, "connector");
        assert.equal(queryReceived.data.source?.id, spotifyManifest.connector_id);
        assert.ok(!("connector_id" in (queryReceived.data || {})));

        const rejected = (timeline.data || []).find(
          (event) => event.event_type === "query.rejected" && event.object_id === requestId
        );
        assert.ok(rejected, "expected query.rejected for rejected connector unknown-field read");
        assert.equal(rejected.data.query_shape, "record_list");
        assert.equal(rejected.data.source?.kind, "connector");
        assert.equal(rejected.data.source?.id, spotifyManifest.connector_id);
        assert.equal(rejected.data.error?.code, "unknown_field");
        assert.match(rejected.data.error?.message || "", REGEXP_3);
        assert.ok(!("connector_id" in (rejected.data || {})));
      }
    });
  });

  await t.test("captures rejected native reads on grant timelines and owner traces", async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      await seedNorthstar(nativeManifest);

      const parResp = await fetch(`${asUrl}/oauth/par`, {
        body: JSON.stringify({
          authorization_details: [
            {
              access_mode: "continuous",
              purpose_code: "https://pdpp.dev/purpose/financial_planning",
              purpose_description: "Support compensation planning and verification",
              source: { id: nativeManifest.provider_id, kind: "provider_native" },
              streams: [{ name: "pay_statements" }],
              type: "https://pdpp.dev/data-access",
            },
          ],
          client_id: "longview",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(parResp.status, 201);
      const initiate = (await parResp.json()) as ParInitiateBody;

      const consentResp = await approveReviewedConsent(asUrl, initiate.request_uri, "employee_1");
      assert.equal(consentResp.status, 200);
      const approval = (await consentResp.json()) as ConsentApprovalBody;

      const clientRejectedResp = await fetch(`${rsUrl}/v1/streams/pay_statements/records?view=summary&fields=id`, {
        headers: { Authorization: `Bearer ${approval.token}` },
      });
      assert.equal(clientRejectedResp.status, 400);
      const clientRequestId = clientRejectedResp.headers.get("Request-Id");
      assert.ok(clientRequestId?.startsWith("req_"));

      const { body: grantTimeline } = await fetchJson<TraceTimelineBody>(
        `${asUrl}/_ref/grants/${encodeURIComponent(requirePathSegment(approval.grant.grant_id, "approval_grant_grant_id"))}/timeline`
      );
      const clientRejected = (grantTimeline.data || []).find(
        (event) => event.event_type === "query.rejected" && event.object_id === clientRequestId
      );
      assert.ok(clientRejected, "expected query.rejected for rejected native client read");
      assert.equal(clientRejected.data.query_shape, "record_list");
      assert.equal(clientRejected.data.source?.kind, "provider_native");
      assert.equal(clientRejected.data.source?.id, nativeManifest.provider_id);
      assert.equal(clientRejected.data.error?.code, "invalid_request");
      assert.ok(!("connector_id" in (clientRejected.data || {})));

      const ownerToken = await issueOwnerToken(asUrl, "employee_1");
      const ownerRejectedResp = await fetch(`${rsUrl}/v1/streams/not_a_stream`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(ownerRejectedResp.status, 404);
      const ownerRequestId = ownerRejectedResp.headers.get("Request-Id");
      const ownerTraceId = ownerRejectedResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(ownerRequestId?.startsWith("req_"));
      assert.ok(ownerTraceId?.startsWith("trc_qry_"));

      const { body: ownerTrace } = await fetchJson<TraceTimelineBody>(
        `${asUrl}/_ref/traces/${encodeURIComponent(requirePathSegment(ownerTraceId, "ownerTraceId"))}`
      );
      const ownerRejected = (ownerTrace.data || []).find(
        (event) => event.event_type === "query.rejected" && event.object_id === ownerRequestId
      );
      assert.ok(ownerRejected, "expected query.rejected for rejected native owner read");
      assert.equal(ownerRejected.stream_id, "not_a_stream");
      assert.equal(ownerRejected.data.query_shape, "stream_metadata");
      assert.equal(ownerRejected.data.source?.kind, "provider_native");
      assert.equal(ownerRejected.data.source?.id, nativeManifest.provider_id);
      assert.equal(ownerRejected.data.error?.code, "not_found");
      assert.ok(!("connector_id" in (ownerRejected.data || {})));
    });
  });

  await t.test("stores connector and native source identities in queryable spine columns", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "employee_1");
      await seedSpotify(rsUrl, spotifyManifest, ownerToken, { ownerSubjectId: "employee_1" });

      const nativeProviderId = "provider_native_spine_column_test";
      await emitSpineEvent({
        actor_id: nativeProviderId,
        actor_type: "provider_native",
        data: { source: { id: nativeProviderId, kind: "provider_native" } },
        event_type: "test.native_source",
        object_id: "native_source",
        object_type: "test",
      });

      const db = getDb();
      const connectorRows = db
        .prepare("SELECT COUNT(*) AS count FROM spine_events WHERE source_kind = ? AND source_id = ?")
        .get<{ count: number }>("connector", SPOTIFY_CONNECTOR_KEY);
      const nativeRows = db
        .prepare("SELECT COUNT(*) AS count FROM spine_events WHERE source_kind = ? AND source_id = ?")
        .get<{ count: number }>("provider_native", nativeProviderId);
      const nullSourceIds = db
        .prepare(
          "SELECT COUNT(*) AS count FROM spine_events WHERE source_kind IS NOT NULL AND (source_id IS NULL OR source_id = '')"
        )
        .get<{ count: number }>();

      assert.ok(connectorRows, "expected a connector-events count row");
      assert.ok(nativeRows, "expected a native-events count row");
      assert.ok(nullSourceIds, "expected a null-source-ids count row");
      assert.ok(connectorRows.count > 0, "expected connector events to be queryable by source_kind/source_id");
      assert.ok(nativeRows.count > 0, "expected native events to be queryable by source_kind/source_id");
      assert.equal(nullSourceIds.count, 0, "sourced spine rows must always carry source_id");
    });
  });

  await t.test(
    "captures auth-gate client read failures on grant traces with auth-gate query.received artifacts",
    async () => {
      await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
        await seedNorthstar(nativeManifest);

        const parResp = await fetch(`${asUrl}/oauth/par`, {
          body: JSON.stringify({
            authorization_details: [
              {
                access_mode: "continuous",
                purpose_code: "https://pdpp.dev/purpose/financial_planning",
                purpose_description: "Trace auth-gate failures for native client reads",
                source: { id: nativeManifest.provider_id, kind: "provider_native" },
                streams: [{ name: "pay_statements" }],
                type: "https://pdpp.dev/data-access",
              },
            ],
            client_id: "longview",
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(parResp.status, 201);
        const initiate = (await parResp.json()) as ParInitiateBody;

        const consentResp = await approveReviewedConsent(asUrl, initiate.request_uri, "employee_1");
        assert.equal(consentResp.status, 200);
        const approval = (await consentResp.json()) as ConsentApprovalBody;

        const { body: grantTimelineBefore } = await fetchJson<TraceTimelineBody>(
          `${asUrl}/_ref/grants/${encodeURIComponent(requirePathSegment(approval.grant.grant_id, "approval_grant_grant_id"))}/timeline`
        );
        const issuedEvent = (grantTimelineBefore.data || []).find((event) => event.event_type === "grant.issued");
        assert.ok(issuedEvent, "expected grant.issued event");

        getDb()
          .prepare("UPDATE grants SET storage_binding_json = NULL WHERE grant_id = ?")
          .run(approval.grant.grant_id);

        const rejectedResp = await fetch(`${rsUrl}/v1/streams`, {
          headers: { Authorization: `Bearer ${approval.token}` },
        });
        assert.equal(rejectedResp.status, 403);
        const requestId = rejectedResp.headers.get("Request-Id");
        const traceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
        assert.ok(requestId?.startsWith("req_"));
        assert.equal(traceId, issuedEvent.trace_id);

        const { body: grantTimelineAfter } = await fetchJson<TraceTimelineBody>(
          `${asUrl}/_ref/grants/${encodeURIComponent(requirePathSegment(approval.grant.grant_id, "approval_grant_grant_id"))}/timeline`
        );
        const { body: traceTimeline } = await fetchJson<TraceTimelineBody>(
          `${asUrl}/_ref/traces/${encodeURIComponent(requirePathSegment(traceId, "traceId"))}`
        );

        for (const timeline of [grantTimelineAfter, traceTimeline]) {
          const received = (timeline.data || []).find(
            (event) => event.event_type === "query.received" && event.object_id === requestId
          );
          assert.ok(received, "expected auth-gate query.received artifact");
          assert.equal(received.trace_id, traceId);
          assert.equal(received.stream_id, null);
          assert.equal(received.data.query_shape, "stream_list");
          assert.equal(received.data.auth_gate, true);

          const rejected = (timeline.data || []).find(
            (event) => event.event_type === "query.rejected" && event.object_id === requestId
          );
          assert.ok(rejected, "expected auth-gate query.rejected artifact");
          assert.equal(rejected.trace_id, traceId);
          assert.equal(rejected.stream_id, null);
          assert.equal(rejected.data.query_shape, "stream_list");
          assert.equal(rejected.data.auth_gate, true);
          assert.equal(rejected.data.error?.code, "grant_invalid");
        }
      });
    }
  );

  await t.test("captures successful owner ingest and delete artifacts on owner traces", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const ingestResp = await fetch(
        `${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(requirePathSegment(spotifyManifest.connector_id, "spotifyManifest_connector_id"))}`,
        {
          body: `${JSON.stringify({
            data: { genres: ["idm"], id: "event_spine_owner_mutation_success", name: "Event Spine Success" },
            emitted_at: new Date().toISOString(),
            key: "event_spine_owner_mutation_success",
          })}\n${JSON.stringify({
            data: { id: "event_spine_owner_mutation_bad_json", name: "Broken" },
            emitted_at: new Date().toISOString(),
            key: "event_spine_owner_mutation_bad_json",
          }).slice(0, -1)}`,
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            "Content-Type": "application/x-ndjson",
          },
          method: "POST",
        }
      );
      assert.equal(ingestResp.status, 200);
      const ingestRequestId = ingestResp.headers.get("Request-Id");
      const ingestTraceId = ingestResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(ingestRequestId?.startsWith("req_"));
      assert.ok(ingestTraceId?.startsWith("trc_mut_"));
      const ingestBody = (await ingestResp.json()) as { records_accepted: number; records_rejected: number };
      assert.equal(ingestBody.records_accepted, 1);
      assert.equal(ingestBody.records_rejected, 1);

      const { body: ingestTrace } = await fetchJson<TraceTimelineBody>(
        `${asUrl}/_ref/traces/${encodeURIComponent(requirePathSegment(ingestTraceId, "ingestTraceId"))}`
      );
      const ingestRequested = (ingestTrace.data || []).find(
        (event) => event.event_type === "mutation.requested" && event.object_id === ingestRequestId
      );
      assert.ok(ingestRequested, "expected mutation.requested for successful owner ingest");
      assert.equal(ingestRequested.stream_id, "top_artists");
      assert.equal(ingestRequested.data.operation, "ingest_records");
      assert.equal(ingestRequested.data.submitted_record_count, 2);
      assert.equal(ingestRequested.data.source?.kind, "connector");
      assert.equal(ingestRequested.data.source?.id, SPOTIFY_CONNECTOR_KEY);
      assert.ok(!("connector_id" in (ingestRequested.data || {})));

      const ingestCompleted = (ingestTrace.data || []).find(
        (event) => event.event_type === "mutation.completed" && event.object_id === ingestRequestId
      );
      assert.ok(ingestCompleted, "expected mutation.completed for successful owner ingest");
      assert.equal(ingestCompleted.stream_id, "top_artists");
      assert.equal(ingestCompleted.data.operation, "ingest_records");
      assert.equal(ingestCompleted.data.records_accepted, 1);
      assert.equal(ingestCompleted.data.records_rejected, 1);
      assert.equal(ingestCompleted.data.error_count, 1);
      assert.equal(ingestCompleted.data.source?.kind, "connector");
      assert.equal(ingestCompleted.data.source?.id, SPOTIFY_CONNECTOR_KEY);
      assert.ok(!("connector_id" in (ingestCompleted.data || {})));

      const deleteResp = await fetch(
        `${rsUrl}/v1/streams/top_artists/records/${encodeURIComponent("event_spine_owner_mutation_success")}?connector_id=${encodeURIComponent(requirePathSegment(spotifyManifest.connector_id, "spotifyManifest_connector_id"))}`,
        {
          headers: { Authorization: `Bearer ${ownerToken}` },
          method: "DELETE",
        }
      );
      assert.equal(deleteResp.status, 204);
      const deleteRequestId = deleteResp.headers.get("Request-Id");
      const deleteTraceId = deleteResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(deleteRequestId?.startsWith("req_"));
      assert.ok(deleteTraceId?.startsWith("trc_mut_"));

      const { body: deleteTrace } = await fetchJson<TraceTimelineBody>(
        `${asUrl}/_ref/traces/${encodeURIComponent(requirePathSegment(deleteTraceId, "deleteTraceId"))}`
      );
      const deleteRequested = (deleteTrace.data || []).find(
        (event) => event.event_type === "mutation.requested" && event.object_id === deleteRequestId
      );
      assert.ok(deleteRequested, "expected mutation.requested for successful owner delete");
      assert.equal(deleteRequested.stream_id, "top_artists");
      assert.equal(deleteRequested.data.operation, "delete_record");
      assert.equal(deleteRequested.data.requested_record_id, "event_spine_owner_mutation_success");
      assert.equal(deleteRequested.data.source?.kind, "connector");
      assert.equal(deleteRequested.data.source?.id, SPOTIFY_CONNECTOR_KEY);
      assert.ok(!("connector_id" in (deleteRequested.data || {})));

      const deleteCompleted = (deleteTrace.data || []).find(
        (event) => event.event_type === "mutation.completed" && event.object_id === deleteRequestId
      );
      assert.ok(deleteCompleted, "expected mutation.completed for successful owner delete");
      assert.equal(deleteCompleted.stream_id, "top_artists");
      assert.equal(deleteCompleted.data.operation, "delete_record");
      assert.equal(deleteCompleted.data.requested_record_id, "event_spine_owner_mutation_success");
      assert.equal(deleteCompleted.data.deleted_record_count, 1);
      assert.equal(deleteCompleted.data.source?.kind, "connector");
      assert.equal(deleteCompleted.data.source?.id, SPOTIFY_CONNECTOR_KEY);
      assert.ok(!("connector_id" in (deleteCompleted.data || {})));
    });
  });

  await t.test("captures rejected owner mutation artifacts on owner traces", async () => {
    await withHarness(async ({ asUrl, rsUrl }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");

      const rejectedResp = await fetch(
        `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent("missing_spotify_connector")}`,
        {
          headers: { Authorization: `Bearer ${ownerToken}` },
          method: "DELETE",
        }
      );
      assert.equal(rejectedResp.status, 404);
      const requestId = rejectedResp.headers.get("Request-Id");
      const traceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(requestId?.startsWith("req_"));
      assert.ok(traceId?.startsWith("trc_mut_"));

      const { body: trace } = await fetchJson<TraceTimelineBody>(
        `${asUrl}/_ref/traces/${encodeURIComponent(requirePathSegment(traceId, "traceId"))}`
      );
      const requested = (trace.data || []).find(
        (event) => event.event_type === "mutation.requested" && event.object_id === requestId
      );
      assert.ok(requested, "expected mutation.requested for rejected owner delete");
      assert.equal(requested.stream_id, "top_artists");
      assert.equal(requested.data.operation, "delete_stream_records");

      const rejected = (trace.data || []).find(
        (event) => event.event_type === "mutation.rejected" && event.object_id === requestId
      );
      assert.ok(rejected, "expected mutation.rejected for rejected owner delete");
      assert.equal(rejected.stream_id, "top_artists");
      assert.equal(rejected.data.operation, "delete_stream_records");
      assert.equal(rejected.data.error?.code, "not_found");
      assert.match(rejected.data.error?.message || "", REGEXP_4);
    });
  });

  await t.test("captures owner state artifacts on owner traces", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");

      const updateResp = await fetch(
        `${rsUrl}/v1/state/${encodeURIComponent(requirePathSegment(spotifyManifest.connector_id, "spotifyManifest_connector_id"))}`,
        {
          body: JSON.stringify({ state: { top_artists: { cursor: "owner_trace_cursor" } } }),
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            "Content-Type": "application/json",
          },
          method: "PUT",
        }
      );
      assert.equal(updateResp.status, 200);
      const updateRequestId = updateResp.headers.get("Request-Id");
      const updateTraceId = updateResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(updateRequestId?.startsWith("req_"));
      assert.ok(updateTraceId?.startsWith("trc_state"));

      const { body: updateTrace } = await fetchJson<TraceTimelineBody>(
        `${asUrl}/_ref/traces/${encodeURIComponent(requirePathSegment(updateTraceId, "updateTraceId"))}`
      );
      const updateRequested = (updateTrace.data || []).find(
        (event) => event.event_type === "state.requested" && event.object_id === updateRequestId
      );
      assert.ok(updateRequested, "expected state.requested for owner state write");
      assert.equal(updateRequested.data.state_scope, "owner");
      assert.equal(updateRequested.data.operation, "write");
      assert.deepEqual(updateRequested.data.requested_streams, ["top_artists"]);
      assert.equal(updateRequested.data.source?.kind, "connector");
      assert.equal(updateRequested.data.source?.id, SPOTIFY_CONNECTOR_KEY);

      const updated = (updateTrace.data || []).find(
        (event) => event.event_type === "state.updated" && event.object_id === updateRequestId
      );
      assert.ok(updated, "expected state.updated for owner state write");
      assert.deepEqual(updated.data.persisted_streams, ["top_artists"]);

      const getResp = await fetch(
        `${rsUrl}/v1/state/${encodeURIComponent(requirePathSegment(spotifyManifest.connector_id, "spotifyManifest_connector_id"))}`,
        {
          headers: { Authorization: `Bearer ${ownerToken}` },
        }
      );
      assert.equal(getResp.status, 200);
      const getRequestId = getResp.headers.get("Request-Id");
      const getTraceId = getResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(getRequestId?.startsWith("req_"));
      assert.ok(getTraceId?.startsWith("trc_state"));
      const getBody = (await getResp.json()) as { state: unknown };
      assert.deepEqual(getBody.state, { top_artists: { cursor: "owner_trace_cursor" } });

      const { body: getTrace } = await fetchJson<TraceTimelineBody>(
        `${asUrl}/_ref/traces/${encodeURIComponent(requirePathSegment(getTraceId, "getTraceId"))}`
      );
      const served = (getTrace.data || []).find(
        (event) => event.event_type === "state.served" && event.object_id === getRequestId
      );
      assert.ok(served, "expected state.served for owner state read");
      assert.deepEqual(served.data.visible_streams, ["top_artists"]);

      const rejectedResp = await fetch(`${rsUrl}/v1/state/${encodeURIComponent("missing_spotify_connector")}`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(rejectedResp.status, 404);
      const rejectedRequestId = rejectedResp.headers.get("Request-Id");
      const rejectedTraceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(rejectedRequestId?.startsWith("req_"));
      assert.ok(rejectedTraceId?.startsWith("trc_state"));

      const { body: rejectedTrace } = await fetchJson<TraceTimelineBody>(
        `${asUrl}/_ref/traces/${encodeURIComponent(requirePathSegment(rejectedTraceId, "rejectedTraceId"))}`
      );
      const rejected = (rejectedTrace.data || []).find(
        (event) => event.event_type === "state.rejected" && event.object_id === rejectedRequestId
      );
      assert.ok(rejected, "expected state.rejected for rejected owner state read");
      assert.equal(rejected.data.state_scope, "owner");
      assert.equal(rejected.data.operation, "read");
      assert.equal(rejected.data.error?.code, "not_found");
      assert.match(rejected.data.error?.message || "", REGEXP_5);
    });
  });

  await t.test("captures grant-scoped state artifacts on grant timelines", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");
      await seedSpotify(rsUrl, spotifyManifest, ownerToken, { ownerSubjectId: "u1" });
      const parResp = await fetch(`${asUrl}/oauth/par`, {
        body: JSON.stringify({
          authorization_details: [
            {
              access_mode: "continuous",
              purpose_code: "https://pdpp.dev/purpose/personalization",
              purpose_description: "Maintain grant-scoped state for trace inspection",
              source: { id: spotifyManifest.connector_id, kind: "connector" },
              streams: [{ name: "top_artists" }],
              type: "https://pdpp.dev/data-access",
            },
          ],
          client_id: "concert_recommendation_app",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(parResp.status, 201);
      const initiate = (await parResp.json()) as ParInitiateBody;

      const consentResp = await approveReviewedConsent(asUrl, initiate.request_uri, "u1");
      assert.equal(consentResp.status, 200);
      const approval = (await consentResp.json()) as ConsentApprovalBody;

      const updateResp = await fetch(
        `${rsUrl}/v1/state/${encodeURIComponent(requirePathSegment(spotifyManifest.connector_id, "spotifyManifest_connector_id"))}?grant_id=${encodeURIComponent(requirePathSegment(approval.grant.grant_id, "approval_grant_grant_id"))}`,
        {
          body: JSON.stringify({ state: { top_artists: { cursor: "grant_trace_cursor" } } }),
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            "Content-Type": "application/json",
          },
          method: "PUT",
        }
      );
      assert.equal(updateResp.status, 200);
      const updateRequestId = updateResp.headers.get("Request-Id");
      const updateTraceId = updateResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(updateRequestId?.startsWith("req_"));
      assert.ok(updateTraceId?.startsWith("trc_"));

      const { body: timelineAfterUpdate } = await fetchJson<TraceTimelineBody>(
        `${asUrl}/_ref/grants/${encodeURIComponent(requirePathSegment(approval.grant.grant_id, "approval_grant_grant_id"))}/timeline`
      );
      const updateRequested = (timelineAfterUpdate.data || []).find(
        (event) => event.event_type === "state.requested" && event.object_id === updateRequestId
      );
      assert.ok(updateRequested, "expected state.requested for grant-scoped state write");
      assert.equal(updateRequested.trace_id, updateTraceId);
      assert.equal(updateRequested.data.state_scope, "grant");
      assert.equal(updateRequested.data.operation, "write");
      assert.deepEqual(updateRequested.data.requested_streams, ["top_artists"]);

      const updated = (timelineAfterUpdate.data || []).find(
        (event) => event.event_type === "state.updated" && event.object_id === updateRequestId
      );
      assert.ok(updated, "expected state.updated for grant-scoped state write");
      assert.equal(updated.trace_id, updateTraceId);
      assert.deepEqual(updated.data.persisted_streams, ["top_artists"]);

      const getResp = await fetch(
        `${rsUrl}/v1/state/${encodeURIComponent(requirePathSegment(spotifyManifest.connector_id, "spotifyManifest_connector_id"))}?grant_id=${encodeURIComponent(requirePathSegment(approval.grant.grant_id, "approval_grant_grant_id"))}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } }
      );
      assert.equal(getResp.status, 200);
      const getRequestId = getResp.headers.get("Request-Id");
      const getTraceId = getResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(getRequestId?.startsWith("req_"));
      assert.ok(getTraceId?.startsWith("trc_"));

      const { body: timelineAfterGet } = await fetchJson<TraceTimelineBody>(
        `${asUrl}/_ref/grants/${encodeURIComponent(requirePathSegment(approval.grant.grant_id, "approval_grant_grant_id"))}/timeline`
      );
      const served = (timelineAfterGet.data || []).find(
        (event) => event.event_type === "state.served" && event.object_id === getRequestId
      );
      assert.ok(served, "expected state.served for grant-scoped state read");
      assert.equal(served.trace_id, getTraceId);
      assert.deepEqual(served.data.visible_streams, ["top_artists"]);

      const rejectedResp = await fetch(
        `${rsUrl}/v1/state/${encodeURIComponent(requirePathSegment(spotifyManifest.connector_id, "spotifyManifest_connector_id"))}?grant_id=${encodeURIComponent(requirePathSegment(approval.grant.grant_id, "approval_grant_grant_id"))}`,
        {
          body: JSON.stringify({ state: { recently_played: { cursor: "outside_grant_cursor" } } }),
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            "Content-Type": "application/json",
          },
          method: "PUT",
        }
      );
      assert.equal(rejectedResp.status, 400);
      const rejectedRequestId = rejectedResp.headers.get("Request-Id");
      const rejectedTraceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(rejectedRequestId?.startsWith("req_"));
      assert.ok(rejectedTraceId?.startsWith("trc_"));

      const { body: timelineAfterRejectedPut } = await fetchJson<TraceTimelineBody>(
        `${asUrl}/_ref/grants/${encodeURIComponent(requirePathSegment(approval.grant.grant_id, "approval_grant_grant_id"))}/timeline`
      );
      const rejected = (timelineAfterRejectedPut.data || []).find(
        (event) => event.event_type === "state.rejected" && event.object_id === rejectedRequestId
      );
      assert.ok(rejected, "expected state.rejected for rejected grant-scoped state write");
      assert.equal(rejected.trace_id, rejectedTraceId);
      assert.equal(rejected.data.state_scope, "grant");
      assert.equal(rejected.data.operation, "write");
      assert.deepEqual(rejected.data.requested_streams, ["recently_played"]);
      assert.equal(rejected.data.error?.code, "invalid_request");
      assert.match(rejected.data.error?.message || "", REGEXP_6);
    });
  });

  await t.test("captures run lifecycle events for a seeded connector run", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");
      const result = await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      assert.ok(result.run_id, "expected run_id in runConnector result");
      const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
        `${asUrl}/_ref/runs/${encodeURIComponent(requirePathSegment(result.run_id, "result_run_id"))}/timeline`
      );
      const runTypes = (runTimeline.data || []).map((event) => event.event_type);
      assert.equal(runTimeline.run_id, result.run_id);

      assert.ok(runTypes.includes("run.started"));
      assert.ok(runTypes.includes("run.progress_reported"));
      assert.ok(runTypes.includes("run.batch_ingested"));
      assert.ok(runTypes.includes("run.state_staged"));
      assert.ok(runTypes.includes("run.state_advanced"));
      assert.ok(runTypes.includes("run.completed"));
      assert.ok(!runTypes.includes("run.failed"));

      const startedIndex = runTypes.indexOf("run.started");
      const stateStagedIndex = runTypes.indexOf("run.state_staged");
      const stateAdvancedIndex = runTypes.indexOf("run.state_advanced");
      const completedIndex = runTypes.indexOf("run.completed");
      assert.ok(startedIndex !== -1 && completedIndex !== -1 && startedIndex < completedIndex);
      assert.ok(startedIndex < stateStagedIndex, "run.state_staged should follow run.started");
      assert.ok(stateStagedIndex < stateAdvancedIndex, "run.state_advanced should follow run.state_staged");

      for (const event of runTimeline.data || []) {
        if (!String(event.event_type || "").startsWith("run.")) {
          continue;
        }
        if (!event.data) {
          continue;
        }
        assert.equal(event.data.source?.kind, "connector");
        assert.equal(event.data.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.ok(
          !("connector_id" in event.data),
          `${event.event_type} should use source descriptors instead of raw connector_id`
        );
      }

      const stagedEvent = (runTimeline.data || []).find((event) => event.event_type === "run.state_staged");
      assert.ok(stagedEvent, "expected run.state_staged event");
      const startedEvent = (runTimeline.data || []).find((event) => event.event_type === "run.started");
      assert.ok(startedEvent, "expected run.started event");
      assert.equal(startedEvent.data.collection_mode, "full_refresh");
      assert.equal(startedEvent.data.persist_state, true);
      assert.equal(startedEvent.data.state_commit_intent, "commit_on_success");
      assert.deepEqual(startedEvent.data.bindings, {
        browser: {},
        filesystem: {},
        interactive: {},
        network: {},
      });
      assert.deepEqual(startedEvent.data.scope, {
        streams: [{ name: "top_artists" }, { name: "saved_tracks" }, { name: "recently_played" }],
      });
      assert.deepEqual(startedEvent.data.scope_streams, ["top_artists", "saved_tracks", "recently_played"]);
      assert.equal(stagedEvent.data.checkpoint_mode, "checkpointed_streaming");
      assert.equal(stagedEvent.data.state_commit_intent, "commit_on_success");

      const progressEvents = (runTimeline.data || []).filter((event) => event.event_type === "run.progress_reported");
      assert.ok(progressEvents.length >= 3, "expected seed run progress to be durable in the run timeline");
      assert.ok(progressEvents.some((event) => event.data.stream === "top_artists"));

      const completedEvent = (runTimeline.data || []).find((event) => event.event_type === "run.completed");
      assert.ok(completedEvent, "expected run.completed event");
      assert.equal(completedEvent.data.checkpoint_mode, "checkpointed_streaming");
      assert.equal(completedEvent.data.checkpoint_commit_status, "committed");
      assert.equal(completedEvent.data.buffered_records_dropped, 0);
    });
  });

  await t.test("captures connection identity on runtime-authored run events", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");
      const dir = mkdtempSync(join(tmpdir(), "pdpp-runtime-connection-id-"));
      const connectorPath = join(dir, "connector.mjs");
      writeFileSync(
        connectorPath,
        `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
  }
});
`,
        "utf8"
      );
      try {
        const connectionId = "cin_spotify_runtime_identity";
        const result = await runConnector({
          // Claims an arbitrary, never-registered literal instance id purely
          // to assert it round-trips onto the run's spine events; never
          // ingests through the real RS, so a naive echo (not the real-store
          // fixture) is correct here.
          admitRunConnection: fakeEchoAdmitRunConnection(),
          collectionMode: "incremental",
          connectorId: spotifyManifest.connector_id,
          connectorInstanceId: connectionId,
          connectorPath,
          manifest: spotifyManifest,
          ownerToken,
          persistState: false,
          rsUrl,
          state: null,
        });

        const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
          `${asUrl}/_ref/runs/${encodeURIComponent(requirePathSegment(result.run_id, "result_run_id"))}/timeline`
        );
        const runEvents = (runTimeline.data || []).filter((event) => String(event.event_type || "").startsWith("run."));
        assert.ok(
          runEvents.some((event) => event.event_type === "run.started"),
          "expected run.started"
        );
        assert.ok(
          runEvents.some((event) => event.event_type === "run.completed"),
          "expected run.completed"
        );
        for (const event of runEvents) {
          assert.equal(event.data?.source?.kind, "connector");
          assert.equal(event.data?.source?.id, SPOTIFY_CONNECTOR_KEY);
          assert.equal(event.data?.connection_id, connectionId);
          assert.equal(event.data?.connector_instance_id, connectionId);
        }
      } finally {
        rmSync(dir, { force: true, recursive: true });
      }
    });
  });

  await t.test("captures per-stream checkpoint commit counts for multi-stream successful runs", async () => {
    const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const manifest = {
      connector_id: "event-spine-multi-stream-checkpoint-test",
      streams: [
        {
          name: "items",
          primary_key: ["id"],
          schema: {
            properties: {
              id: { type: "string" },
              value: { type: "string" },
            },
            required: ["id"],
            type: "object",
          },
        },
        {
          name: "other_items",
          primary_key: ["id"],
          schema: {
            properties: {
              id: { type: "string" },
              value: { type: "string" },
            },
            required: ["id"],
            type: "object",
          },
        },
      ],
      version: "0.1.0",
    };
    Object.assign(manifest, {
      source_declaration: {
        declaration_version: "event-spine-multi-stream-checkpoint-test.v1",
        display: { name: "Event Spine Multi-Stream Checkpoint Test" },
        protocol_version: "0.1.0",
        publisher: { id: "https://pdpp.dev/reference-implementation/tests" },
        source: { id: "https://registry.pdpp.dev/connectors/event-spine-multi-stream-checkpoint-test", kind: "connector" },
        streams: manifest.streams,
      },
    });

    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-event-spine-multi-stream-commit-"));
    const connectorPath = join(tmpDir, "connector.mjs");
    writeFileSync(
      connectorPath,
      `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'multi_stream_item',
    data: { id: 'multi_stream_item', value: 'items value' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'items',
    cursor: { cursor: 'items_cursor' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'other_items',
    key: 'multi_stream_other_item',
    data: { id: 'multi_stream_other_item', value: 'other value' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'other_items',
    cursor: { cursor: 'other_items_cursor' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 2,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
      "utf8"
    );

    try {
      const registerResp = await fetch(`${asUrl}/connectors`, {
        body: JSON.stringify(manifest),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(registerResp.status, 201);

      const ownerToken = await issueOwnerToken(asUrl, "u1");
      const result = await runConnector({
        admitRunConnection: fakeAdmitRunConnection(),
        collectionMode: "incremental",
        connectorId: manifest.connector_id,
        connectorPath,
        manifest,
        onInteraction: async () => ({}),
        ownerToken,
        persistState: true,
        rsUrl,
        state: null,
      });

      const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
        `${asUrl}/_ref/runs/${encodeURIComponent(requirePathSegment(result.run_id, "result_run_id"))}/timeline`
      );
      const stagedEvents = (runTimeline.data || []).filter((event) => event.event_type === "run.state_staged");
      const advancedEvents = (runTimeline.data || []).filter((event) => event.event_type === "run.state_advanced");

      assert.equal(stagedEvents.length, 2);
      assert.equal(advancedEvents.length, 2);
      assert.deepEqual(
        stagedEvents.map((event) => event.data.state_streams_staged as number).sort((a, b) => a - b),
        [1, 2]
      );
      assert.deepEqual(
        advancedEvents.map((event) => event.data.state_streams_committed as number).sort((a, b) => a - b),
        [1, 2]
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
      await closeServer(server);
    }
  });

  await t.test("captures partial checkpoint commit failures after DONE(succeeded)", async () => {
    const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
    const asUrl = `http://localhost:${server.asPort}`;
    const manifest = {
      connector_id: "https://registry.pdpp.dev/connectors/event-spine-partial-checkpoint-failure-test",
      protocol_version: "0.1.0",
      streams: [
        {
          name: "items",
          primary_key: ["id"],
          schema: {
            properties: {
              id: { type: "string" },
              value: { type: "string" },
            },
            required: ["id"],
            type: "object",
          },
        },
        {
          name: "other_items",
          primary_key: ["id"],
          schema: {
            properties: {
              id: { type: "string" },
              value: { type: "string" },
            },
            required: ["id"],
            type: "object",
          },
        },
      ],
      version: "0.1.0",
    };
    Object.assign(manifest, {
      source_declaration: {
        declaration_version: "event-spine-partial-checkpoint-failure-test.v1",
        display: { name: "Event Spine Partial Checkpoint Failure Test" },
        protocol_version: "0.1.0",
        publisher: { id: "https://pdpp.dev/reference-implementation/tests" },
        source: {
          id: manifest.connector_id,
          kind: "connector",
        },
        streams: manifest.streams,
      },
    });

    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-event-spine-partial-checkpoint-failure-"));
    const connectorPath = join(tmpDir, "connector.mjs");
    writeFileSync(
      connectorPath,
      `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'partial_checkpoint_item',
    data: { id: 'partial_checkpoint_item', value: 'items value' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'items',
    cursor: { cursor: 'items_cursor_partial_commit' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'other_items',
    key: 'partial_checkpoint_other_item',
    data: { id: 'partial_checkpoint_other_item', value: 'other value' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'other_items',
    cursor: { cursor: 'other_items_cursor_partial_commit' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 2,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
      "utf8"
    );

    const committedState: unknown[] = [];
    let stateWriteCount = 0;
    const rsServer = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "POST" && url.pathname.startsWith("/v1/ingest/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ records_accepted: 1, records_attempted: 1, records_rejected: 0, rejections: [] }));
        return;
      }

      if (req.method === "PUT" && url.pathname === `/v1/state/${encodeURIComponent(manifest.connector_id)}`) {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
        }
        stateWriteCount += 1;
        const payload = JSON.parse(body || "{}");
        if (stateWriteCount === 1) {
          committedState.push(payload.state);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "simulated_state_write_failure" }));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });

    try {
      await new Promise<void>((resolve) => rsServer.listen(0, () => resolve()));
      const rsPort = requireTcpPort(rsServer);

      const registerResp = await fetch(`${asUrl}/connectors`, {
        body: JSON.stringify(manifest),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(registerResp.status, 201);

      const ownerToken = await issueOwnerToken(asUrl, "u1");
      let rejected: RunConnectorError | undefined;
      await assert.rejects(
        async () => {
          await runConnector({
            admitRunConnection: fakeAdmitRunConnection(),
            collectionMode: "incremental",
            connectorId: manifest.connector_id,
            connectorPath,
            manifest,
            onInteraction: async () => ({}),
            ownerToken,
            persistState: true,
            rsUrl: `http://localhost:${rsPort}`,
            state: null,
          });
        },
        (err: RunConnectorError) => {
          rejected = err;
          assert.equal(err.failure_reason, "runtime_error");
          assert.equal(err.terminal_reason, "runtime_error");
          assert.ok(err.checkpoint_summary, "expected a checkpoint summary on the rejection");
          assert.equal(err.checkpoint_summary.state_streams_staged, 2);
          assert.equal(err.checkpoint_summary.state_streams_committed, 1);
          return true;
        }
      );
      assert.ok(rejected, "expected the connector run to reject");

      assert.deepEqual(committedState, [{ items: { cursor: "items_cursor_partial_commit" } }]);
      const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
        `${asUrl}/_ref/runs/${encodeURIComponent(requirePathSegment(rejected.run_id, "rejected.run_id"))}/timeline`
      );
      const runTypes = (runTimeline.data || []).map((event) => event.event_type);
      assert.ok(runTypes.includes("run.state_staged"));
      assert.ok(runTypes.includes("run.state_advanced"));
      assert.ok(runTypes.includes("run.state_commit_failed"));
      assert.ok(runTypes.includes("run.failed"));
      assert.ok(!runTypes.includes("run.completed"));

      const advancedEvents = (runTimeline.data || []).filter((event) => event.event_type === "run.state_advanced");
      assert.equal(advancedEvents.length, 1);
      // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
      const advancedEvent = advancedEvents[0];
      assert.ok(advancedEvent, "expected a run.state_advanced event");
      assert.equal(advancedEvent.stream_id, "items");
      assert.equal(advancedEvent.data.state_streams_committed, 1);

      const commitFailedEvents = (runTimeline.data || []).filter(
        (event) => event.event_type === "run.state_commit_failed"
      );
      assert.equal(commitFailedEvents.length, 1);
      // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
      const commitFailedEvent = commitFailedEvents[0];
      assert.ok(commitFailedEvent, "expected a run.state_commit_failed event");
      assert.equal(commitFailedEvent.stream_id, "other_items");
      assert.deepEqual(commitFailedEvent.data.cursor, { cursor: "other_items_cursor_partial_commit" });
      assert.equal(commitFailedEvent.data.state_streams_staged, 2);
      assert.equal(commitFailedEvent.data.state_streams_committed, 1);
      assert.match(commitFailedEvent.data.error_message as string, REGEXP_7);

      const failedEvent = (runTimeline.data || []).find((event) => event.event_type === "run.failed");
      assert.ok(failedEvent, "expected run.failed event for partial checkpoint commit failure");
      assert.equal(failedEvent.data.reason, "runtime_error");
      assert.equal(failedEvent.data.checkpoint_commit_status, "partially_committed");
      assert.equal(failedEvent.data.state_streams_staged, 2);
      assert.equal(failedEvent.data.state_streams_committed, 1);

      for (const event of [...advancedEvents, failedEvent]) {
        assert.equal(event.data.source?.kind, "connector");
        assert.equal(event.data.source?.id, manifest.connector_id);
        assert.ok(
          !("connector_id" in event.data),
          `${event.event_type} should use source descriptors instead of raw connector_id`
        );
      }
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
      await closeHttpServer(rsServer);
      await closeServer(server);
    }
  });

  await t.test("captures runtime authentication failures from ingest", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-event-spine-runtime-auth-failure-"));
      const connectorPath = join(tmpDir, "connector.mjs");
      writeFileSync(
        connectorPath,
        `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'top_artists',
    key: 'runtime_auth_failure_event',
    data: { id: 'runtime_auth_failure_event', value: 'before auth failure' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
        "utf8"
      );

      // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
      const rsServer = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (req.method === "POST" && url.pathname === "/v1/ingest/top_artists") {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message: "Invalid or expired token",
              },
            })
          );
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      });

      try {
        await new Promise<void>((resolve) => rsServer.listen(0, () => resolve()));
        const rsPort = requireTcpPort(rsServer);

        let rejected: RunConnectorError | undefined;
        await assert.rejects(
          async () => {
            await runConnector({
              admitRunConnection: fakeAdmitRunConnection(),
              collectionMode: "full_refresh",
              connectorId: spotifyManifest.connector_id,
              connectorPath,
              manifest: spotifyManifest,
              ownerToken: "invalid_owner_token",
              rsUrl: `http://localhost:${rsPort}`,
              state: null,
            });
          },
          (err: RunConnectorError) => {
            rejected = err;
            assert.equal(err.failure_reason, "authentication_error");
            assert.equal(err.terminal_reason, "authentication_error");
            return true;
          }
        );
        assert.ok(rejected, "expected the connector run to reject");

        const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
          `${asUrl}/_ref/runs/${encodeURIComponent(requirePathSegment(rejected.run_id, "rejected.run_id"))}/timeline`
        );
        const runTypes = (runTimeline.data || []).map((event) => event.event_type);
        assert.ok(runTypes.includes("run.failed"));
        assert.ok(!runTypes.includes("run.completed"));

        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === "run.failed");
        assert.ok(failedEvent, "expected run.failed event");
        assert.equal(failedEvent.data?.source?.kind, "connector");
        assert.equal(failedEvent.data?.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(failedEvent.data?.reason, "authentication_error");
        assert.equal(failedEvent.data?.records_emitted, 1);
        assert.equal(failedEvent.data?.records_flushed, 0);
        assert.equal(failedEvent.data?.buffered_records_dropped, 1);
        assert.equal(failedEvent.data?.checkpoint_commit_status, "not_committed");
      } finally {
        await closeHttpServer(rsServer);
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  await t.test("captures runtime permission failures from state persistence", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-event-spine-runtime-permission-failure-"));
      const connectorPath = join(tmpDir, "connector.mjs");
      writeFileSync(
        connectorPath,
        `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'top_artists',
    key: 'runtime_permission_failure_event',
    data: { id: 'runtime_permission_failure_event', value: 'before permission failure' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'top_artists',
    cursor: { cursor: 'runtime_permission_failure_cursor' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
        "utf8"
      );

      // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
      const rsServer = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (req.method === "POST" && url.pathname === "/v1/ingest/top_artists") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ records_accepted: 1, records_attempted: 1, records_rejected: 0, rejections: [] }));
          return;
        }

        if (
          req.method === "PUT" &&
          url.pathname ===
            `/v1/state/${encodeURIComponent(requirePathSegment(SPOTIFY_CONNECTOR_KEY, "SPOTIFY_CONNECTOR_KEY"))}`
        ) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message: "Owner token required",
              },
            })
          );
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      });

      try {
        await new Promise<void>((resolve) => rsServer.listen(0, () => resolve()));
        const rsPort = requireTcpPort(rsServer);

        let rejected: RunConnectorError | undefined;
        await assert.rejects(
          async () => {
            await runConnector({
              admitRunConnection: fakeAdmitRunConnection(),
              collectionMode: "incremental",
              connectorId: spotifyManifest.connector_id,
              connectorPath,
              manifest: spotifyManifest,
              ownerToken: "client_token_instead_of_owner",
              persistState: true,
              rsUrl: `http://localhost:${rsPort}`,
              state: null,
            });
          },
          (err: RunConnectorError) => {
            rejected = err;
            assert.equal(err.failure_reason, "permission_error");
            assert.equal(err.terminal_reason, "permission_error");
            return true;
          }
        );
        assert.ok(rejected, "expected the connector run to reject");

        const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
          `${asUrl}/_ref/runs/${encodeURIComponent(requirePathSegment(rejected.run_id, "rejected.run_id"))}/timeline`
        );
        const stagedEvent = (runTimeline.data || []).find((event) => event.event_type === "run.state_staged");
        assert.ok(stagedEvent, "expected run.state_staged event before permission failure");

        const advancedEvent = (runTimeline.data || []).find((event) => event.event_type === "run.state_advanced");
        assert.equal(advancedEvent, undefined, "permission failure should not commit checkpoint state");

        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === "run.failed");
        assert.ok(failedEvent, "expected run.failed event");
        assert.equal(failedEvent.data?.source?.kind, "connector");
        assert.equal(failedEvent.data?.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(failedEvent.data?.reason, "permission_error");
        assert.equal(failedEvent.data?.records_emitted, 1);
        assert.equal(failedEvent.data?.records_flushed, 1);
        assert.equal(failedEvent.data?.buffered_records_dropped, 0);
        assert.equal(failedEvent.data?.checkpoint_commit_status, "not_committed");
        assert.equal(failedEvent.data?.state_streams_staged, 1);
        assert.equal(failedEvent.data?.state_streams_committed, 0);
      } finally {
        await closeHttpServer(rsServer);
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  await t.test("captures deterministic runtime connector_invalid failures from ingest", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-event-spine-runtime-connector-invalid-"));
      const connectorPath = join(tmpDir, "connector.mjs");
      writeFileSync(
        connectorPath,
        `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'top_artists',
    key: 'runtime_connector_invalid_event',
    data: { id: 'runtime_connector_invalid_event', value: 'before connector invalid' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
        "utf8"
      );

      // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
      const rsServer = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (req.method === "POST" && url.pathname === "/v1/ingest/top_artists") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                code: "connector_invalid",
                message: "Connector manifest is malformed",
                type: "invalid_request_error",
              },
            })
          );
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      });

      try {
        await new Promise<void>((resolve) => rsServer.listen(0, () => resolve()));
        const rsPort = requireTcpPort(rsServer);

        let rejected: RunConnectorError | undefined;
        await assert.rejects(
          async () => {
            await runConnector({
              admitRunConnection: fakeAdmitRunConnection(),
              collectionMode: "full_refresh",
              connectorId: spotifyManifest.connector_id,
              connectorPath,
              manifest: spotifyManifest,
              ownerToken: "owner_token",
              rsUrl: `http://localhost:${rsPort}`,
              state: null,
            });
          },
          (err: RunConnectorError) => {
            rejected = err;
            assert.equal(err.failure_reason, "connector_invalid");
            assert.equal(err.terminal_reason, "connector_invalid");
            return true;
          }
        );
        assert.ok(rejected, "expected the connector run to reject");

        const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
          `${asUrl}/_ref/runs/${encodeURIComponent(requirePathSegment(rejected.run_id, "rejected.run_id"))}/timeline`
        );
        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === "run.failed");
        assert.ok(failedEvent, "expected run.failed event");
        assert.equal(failedEvent.data?.source?.kind, "connector");
        assert.equal(failedEvent.data?.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(failedEvent.data?.reason, "connector_invalid");
        assert.equal(failedEvent.data?.records_emitted, 1);
        assert.equal(failedEvent.data?.records_flushed, 0);
        assert.equal(failedEvent.data?.buffered_records_dropped, 1);
        assert.equal(failedEvent.data?.checkpoint_commit_status, "not_committed");
      } finally {
        await closeHttpServer(rsServer);
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  await t.test("captures retryable runtime rate_limit_error failures from ingest", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-event-spine-runtime-rate-limit-"));
      const connectorPath = join(tmpDir, "connector.mjs");
      writeFileSync(
        connectorPath,
        `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'top_artists',
    key: 'runtime_rate_limit_event',
    data: { id: 'runtime_rate_limit_event', value: 'before rate limit' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
        "utf8"
      );

      // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
      const rsServer = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (req.method === "POST" && url.pathname === "/v1/ingest/top_artists") {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message: "Too many requests",
              },
            })
          );
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      });

      try {
        await new Promise<void>((resolve) => rsServer.listen(0, () => resolve()));
        const rsPort = requireTcpPort(rsServer);

        let rejected: RunConnectorError | undefined;
        await assert.rejects(
          async () => {
            await runConnector({
              admitRunConnection: fakeAdmitRunConnection(),
              collectionMode: "full_refresh",
              connectorId: spotifyManifest.connector_id,
              connectorPath,
              manifest: spotifyManifest,
              ownerToken: "owner_token",
              rsUrl: `http://localhost:${rsPort}`,
              state: null,
            });
          },
          (err: RunConnectorError) => {
            rejected = err;
            assert.equal(err.failure_reason, "rate_limit_error");
            assert.equal(err.terminal_reason, "rate_limit_error");
            return true;
          }
        );
        assert.ok(rejected, "expected the connector run to reject");

        const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
          `${asUrl}/_ref/runs/${encodeURIComponent(requirePathSegment(rejected.run_id, "rejected.run_id"))}/timeline`
        );
        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === "run.failed");
        assert.ok(failedEvent, "expected run.failed event");
        assert.equal(failedEvent.data?.source?.kind, "connector");
        assert.equal(failedEvent.data?.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(failedEvent.data?.reason, "rate_limit_error");
        assert.equal(failedEvent.data?.records_emitted, 1);
        assert.equal(failedEvent.data?.records_flushed, 0);
        assert.equal(failedEvent.data?.buffered_records_dropped, 1);
        assert.equal(failedEvent.data?.checkpoint_commit_status, "not_committed");
      } finally {
        await closeHttpServer(rsServer);
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  await t.test("captures terminal counter mismatch failures after DONE(succeeded)", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-event-spine-terminal-counter-mismatch-"));
      const connectorPath = join(tmpDir, "connector.mjs");
      writeFileSync(
        connectorPath,
        `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'top_artists',
    key: 'terminal_counter_mismatch_event',
    data: { id: 'terminal_counter_mismatch_event', value: 'before terminal mismatch' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'top_artists',
    cursor: { cursor: 'terminal_counter_mismatch_cursor' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 2,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
        "utf8"
      );

      try {
        let rejected: RunConnectorError | undefined;
        await assert.rejects(
          async () => {
            await runConnector({
              admitRunConnection: fakeAdmitRunConnection(),
              collectionMode: "incremental",
              connectorId: spotifyManifest.connector_id,
              connectorPath,
              manifest: spotifyManifest,
              onInteraction: async () => ({}),
              ownerToken,
              persistState: true,
              rsUrl,
              state: null,
            });
          },
          (err: RunConnectorError) => {
            rejected = err;
            assert.equal(err.failure_reason, "connector_protocol_violation");
            assert.equal(err.terminal_reason, "connector_protocol_violation");
            assert.match(err.message, REGEXP_8);
            assert.ok(err.checkpoint_summary, "expected a checkpoint summary on the rejection");
            assert.equal(err.checkpoint_summary.records_flushed, 1);
            assert.equal(err.checkpoint_summary.state_streams_staged, 1);
            assert.equal(err.checkpoint_summary.state_streams_committed, 0);
            return true;
          }
        );
        assert.ok(rejected, "expected the connector run to reject");

        const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
          `${asUrl}/_ref/runs/${encodeURIComponent(requirePathSegment(rejected.run_id, "rejected.run_id"))}/timeline`
        );
        const runTypes = (runTimeline.data || []).map((event) => event.event_type);
        assert.ok(runTypes.includes("run.state_staged"));
        assert.ok(runTypes.includes("run.failed"));
        assert.ok(!runTypes.includes("run.state_advanced"));
        assert.ok(!runTypes.includes("run.completed"));

        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === "run.failed");
        assert.ok(failedEvent, "expected run.failed event for terminal counter mismatch");
        assert.equal(failedEvent.data.reason, "connector_protocol_violation");
        assert.equal(failedEvent.data.records_emitted, 1);
        assert.equal(failedEvent.data.reported_records_emitted, 2);
        assert.equal(failedEvent.data.records_flushed, 1);
        assert.equal(failedEvent.data.state_streams_staged, 1);
        assert.equal(failedEvent.data.state_streams_committed, 0);
        assert.equal(failedEvent.data.checkpoint_commit_status, "not_committed");

        for (const event of (runTimeline.data || []).filter((entry) =>
          ["run.state_staged", "run.failed"].includes(entry.event_type)
        )) {
          assert.equal(event.data.source?.kind, "connector");
          assert.equal(event.data.source?.id, SPOTIFY_CONNECTOR_KEY);
          assert.ok(
            !("connector_id" in event.data),
            `${event.event_type} should use source descriptors instead of raw connector_id`
          );
        }
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  await t.test("captures connector-declared terminal error details on failed runs", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-event-spine-terminal-error-"));
      const connectorPath = join(tmpDir, "connector.mjs");
      writeFileSync(
        connectorPath,
        `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'top_artists',
    key: 'terminal_error_event',
    data: { id: 'terminal_error_event', value: 'before terminal failure' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'failed',
    records_emitted: 1,
    error: { message: 'Remote provider rate limit', retryable: true },
  }) + '\\n');
  rl.close();
  process.exit(1);
});
`,
        "utf8"
      );

      try {
        const result = await runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "full_refresh",
          connectorId: spotifyManifest.connector_id,
          connectorPath,
          manifest: spotifyManifest,
          onInteraction: async () => ({}),
          ownerToken,
          rsUrl,
          state: null,
        });

        assert.equal(result.status, "failed");
        assert.equal(result.terminal_reason, "connector_reported_failed");
        assert.deepEqual(result.connector_error, {
          message: "Remote provider rate limit",
          retryable: true,
        });

        const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
          `${asUrl}/_ref/runs/${encodeURIComponent(requirePathSegment(result.run_id, "result_run_id"))}/timeline`
        );
        const runTypes = (runTimeline.data || []).map((event) => event.event_type);
        assert.ok(!runTypes.includes("run.completed"));
        assert.ok(runTypes.includes("run.failed"));

        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === "run.failed");
        assert.ok(failedEvent, "expected run.failed event");
        assert.equal(failedEvent.data.source?.kind, "connector");
        assert.equal(failedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(failedEvent.data.reason, "connector_reported_failed");
        assert.equal(failedEvent.data.connector_error_message, "Remote provider rate limit");
        assert.equal(failedEvent.data.connector_error_retryable, true);
        assert.equal(failedEvent.data.buffered_records_dropped, 1);
        assert.equal(failedEvent.data.checkpoint_commit_status, "not_committed");
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  await t.test("captures connector-declared terminal error details on cancelled runs", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-event-spine-terminal-cancelled-"));
      const connectorPath = join(tmpDir, "connector.mjs");
      writeFileSync(
        connectorPath,
        `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'top_artists',
    key: 'terminal_cancelled_event',
    data: { id: 'terminal_cancelled_event', value: 'before terminal cancellation' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'cancelled',
    records_emitted: 1,
    error: { message: 'User denied follow-up verification', retryable: false },
  }) + '\\n');
  rl.close();
  process.exit(1);
});
`,
        "utf8"
      );

      try {
        const result = await runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "full_refresh",
          connectorId: spotifyManifest.connector_id,
          connectorPath,
          manifest: spotifyManifest,
          onInteraction: async () => ({}),
          ownerToken,
          rsUrl,
          state: null,
        });

        assert.equal(result.status, "cancelled");
        assert.equal(result.terminal_reason, "connector_reported_cancelled");
        assert.deepEqual(result.connector_error, {
          message: "User denied follow-up verification",
          retryable: false,
        });

        const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
          `${asUrl}/_ref/runs/${encodeURIComponent(requirePathSegment(result.run_id, "result_run_id"))}/timeline`
        );
        const runTypes = (runTimeline.data || []).map((event) => event.event_type);
        assert.ok(!runTypes.includes("run.completed"));
        assert.ok(runTypes.includes("run.failed"));

        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === "run.failed");
        assert.ok(failedEvent, "expected run.failed event");
        assert.equal(failedEvent.status, "cancelled");
        assert.equal(failedEvent.data.source?.kind, "connector");
        assert.equal(failedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(failedEvent.data.reason, "connector_reported_cancelled");
        assert.equal(failedEvent.data.connector_error_message, "User denied follow-up verification");
        assert.equal(failedEvent.data.connector_error_retryable, false);
        assert.equal(failedEvent.data.buffered_records_dropped, 1);
        assert.equal(failedEvent.data.checkpoint_commit_status, "not_committed");
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  await t.test(
    "captures contradictory DONE(succeeded)+error protocol violations without recording success artifacts",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-event-spine-done-succeeded-error-"));
        const connectorPath = join(tmpDir, "connector.mjs");
        writeFileSync(
          connectorPath,
          `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 0,
    error: { message: 'contradictory terminal detail', retryable: false },
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
          "utf8"
        );

        try {
          let rejected: RunConnectorError | undefined;
          await assert.rejects(
            runConnector({
              admitRunConnection: fakeAdmitRunConnection(),
              collectionMode: "full_refresh",
              connectorId: spotifyManifest.connector_id,
              connectorPath,
              manifest: spotifyManifest,
              onInteraction: async () => ({}),
              ownerToken,
              rsUrl,
              state: null,
            }),
            (err: RunConnectorError) => {
              rejected = err;
              assert.equal(err.failure_reason, "connector_protocol_violation");
              assert.match(err.message, REGEXP_9);
              assert.equal(err.connector_error, null);
              return true;
            }
          );
          assert.ok(rejected, "expected the connector run to reject");

          const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
            `${asUrl}/_ref/runs/${encodeURIComponent(requirePathSegment(rejected.run_id, "rejected.run_id"))}/timeline`
          );
          const runTypes = (runTimeline.data || []).map((event) => event.event_type);
          assert.ok(!runTypes.includes("run.completed"));
          assert.ok(runTypes.includes("run.failed"));

          const failedEvent = (runTimeline.data || []).find((event) => event.event_type === "run.failed");
          assert.ok(failedEvent, "expected run.failed event");
          assert.equal(failedEvent.data.source?.kind, "connector");
          assert.equal(failedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
          assert.equal(failedEvent.data.reason, "connector_protocol_violation");
          assert.equal(failedEvent.data.checkpoint_commit_status, "not_committed");
          assert.ok(!("connector_error_message" in failedEvent.data));
          assert.ok(!("connector_error_retryable" in failedEvent.data));
        } finally {
          rmSync(tmpDir, { force: true, recursive: true });
        }
      });
    }
  );

  await t.test(
    "captures post-DONE protocol violations as failed run timelines without completed artifacts",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-event-spine-post-done-violation-"));
        const connectorPath = join(tmpDir, "connector.mjs");
        writeFileSync(
          connectorPath,
          `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'top_artists',
    key: 'before_done_violation_event',
    data: { id: 'before_done_violation_event', value: 'before_done' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'top_artists',
    cursor: { cursor: 'cursor_before_done_violation_event' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'top_artists',
    key: 'after_done_violation_event',
    data: { id: 'after_done_violation_event', value: 'after_done' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
          "utf8"
        );

        try {
          let rejected: RunConnectorError | undefined;
          await assert.rejects(
            runConnector({
              admitRunConnection: fakeAdmitRunConnection(),
              collectionMode: "incremental",
              connectorId: spotifyManifest.connector_id,
              connectorPath,
              manifest: spotifyManifest,
              onInteraction: async () => ({}),
              ownerToken,
              persistState: true,
              rsUrl,
              state: null,
            }),
            (err: RunConnectorError) => {
              rejected = err;
              assert.equal(err.failure_reason, "connector_protocol_violation");
              return true;
            }
          );
          assert.ok(rejected, "expected the connector run to reject");

          const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
            `${asUrl}/_ref/runs/${encodeURIComponent(requirePathSegment(rejected.run_id, "rejected.run_id"))}/timeline`
          );
          const runTypes = (runTimeline.data || []).map((event) => event.event_type);
          assert.ok(runTypes.includes("run.state_staged"));
          assert.ok(!runTypes.includes("run.state_advanced"));
          assert.ok(!runTypes.includes("run.completed"));
          assert.ok(runTypes.includes("run.failed"));

          const failedEvent = (runTimeline.data || []).find((event) => event.event_type === "run.failed");
          assert.ok(failedEvent, "expected run.failed event");
          assert.equal(failedEvent.data.source?.kind, "connector");
          assert.equal(failedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
          assert.equal(failedEvent.data.reason, "connector_protocol_violation");
          assert.equal(failedEvent.data.records_flushed, 1);
          assert.equal(failedEvent.data.buffered_records_dropped, 0);
          assert.equal(failedEvent.data.state_streams_staged, 1);
          assert.equal(failedEvent.data.state_streams_committed, 0);
          assert.equal(failedEvent.data.checkpoint_commit_status, "not_committed");
        } finally {
          rmSync(tmpDir, { force: true, recursive: true });
        }
      });
    }
  );

  await t.test("captures post-DONE progress protocol violations without recording progress artifacts", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-event-spine-post-done-progress-"));
      const connectorPath = join(tmpDir, "connector.mjs");
      writeFileSync(
        connectorPath,
        `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 0,
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'PROGRESS',
    stream: 'top_artists',
    message: 'after done should be rejected',
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
        "utf8"
      );

      try {
        let rejected: RunConnectorError | undefined;
        await assert.rejects(
          runConnector({
            admitRunConnection: fakeAdmitRunConnection(),
            collectionMode: "incremental",
            connectorId: spotifyManifest.connector_id,
            connectorPath,
            manifest: spotifyManifest,
            onInteraction: async () => ({}),
            ownerToken,
            persistState: true,
            rsUrl,
            state: null,
          }),
          (err: RunConnectorError) => {
            rejected = err;
            assert.equal(err.failure_reason, "connector_protocol_violation");
            return true;
          }
        );
        assert.ok(rejected, "expected the connector run to reject");

        const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
          `${asUrl}/_ref/runs/${encodeURIComponent(requirePathSegment(rejected.run_id, "rejected.run_id"))}/timeline`
        );
        const runTypes = (runTimeline.data || []).map((event) => event.event_type);
        assert.ok(!runTypes.includes("run.completed"));
        assert.ok(!runTypes.includes("run.progress_reported"));
        assert.ok(runTypes.includes("run.failed"));

        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === "run.failed");
        assert.ok(failedEvent, "expected run.failed event");
        assert.equal(failedEvent.data.source?.kind, "connector");
        assert.equal(failedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(failedEvent.data.reason, "connector_protocol_violation");
        assert.equal(failedEvent.data.records_flushed, 0);
        assert.equal(failedEvent.data.buffered_records_dropped, 0);
        assert.equal(failedEvent.data.checkpoint_commit_status, "not_committed");
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  await t.test(
    "captures undeclared-stream progress protocol violations without recording progress artifacts",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-event-spine-undeclared-progress-"));
        const connectorPath = join(tmpDir, "connector.mjs");
        writeFileSync(
          connectorPath,
          `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'PROGRESS',
    stream: 'undeclared_stream',
    message: 'undeclared progress should be rejected',
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
          "utf8"
        );

        try {
          let rejected: RunConnectorError | undefined;
          await assert.rejects(
            runConnector({
              admitRunConnection: fakeAdmitRunConnection(),
              collectionMode: "incremental",
              connectorId: spotifyManifest.connector_id,
              connectorPath,
              manifest: spotifyManifest,
              onInteraction: async () => ({}),
              ownerToken,
              persistState: true,
              rsUrl,
              state: null,
            }),
            (err: RunConnectorError) => {
              rejected = err;
              assert.equal(err.failure_reason, "connector_protocol_violation");
              assert.match(err.message, REGEXP_10);
              return true;
            }
          );
          assert.ok(rejected, "expected the connector run to reject");

          const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
            `${asUrl}/_ref/runs/${encodeURIComponent(requirePathSegment(rejected.run_id, "rejected.run_id"))}/timeline`
          );
          const runTypes = (runTimeline.data || []).map((event) => event.event_type);
          assert.ok(!runTypes.includes("run.progress_reported"));
          assert.ok(runTypes.includes("run.failed"));

          const failedEvent = (runTimeline.data || []).find((event) => event.event_type === "run.failed");
          assert.ok(failedEvent, "expected run.failed event");
          assert.equal(failedEvent.data.source?.kind, "connector");
          assert.equal(failedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
          assert.equal(failedEvent.data.reason, "connector_protocol_violation");
          assert.equal(failedEvent.data.records_flushed, 0);
          assert.equal(failedEvent.data.buffered_records_dropped, 0);
          assert.equal(failedEvent.data.checkpoint_commit_status, "not_committed");
        } finally {
          rmSync(tmpDir, { force: true, recursive: true });
        }
      });
    }
  );

  await t.test(
    "captures post-DONE interaction protocol violations without recording interaction artifacts",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-event-spine-post-done-interaction-"));
        const connectorPath = join(tmpDir, "connector.mjs");
        writeFileSync(
          connectorPath,
          `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 0,
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'INTERACTION',
    request_id: 'after_done_interaction_event',
    kind: 'manual_action',
    message: 'after done should be rejected',
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
          "utf8"
        );

        try {
          let rejected: RunConnectorError | undefined;
          await assert.rejects(
            runConnector({
              admitRunConnection: fakeAdmitRunConnection(),
              collectionMode: "incremental",
              connectorId: spotifyManifest.connector_id,
              connectorPath,
              manifest: spotifyManifest,
              onInteraction: async () => ({
                request_id: "after_done_interaction_event",
                status: "success",
                type: "INTERACTION_RESPONSE",
              }),
              ownerToken,
              persistState: true,
              rsUrl,
              state: null,
            }),
            (err: RunConnectorError) => {
              rejected = err;
              assert.equal(err.failure_reason, "connector_protocol_violation");
              return true;
            }
          );
          assert.ok(rejected, "expected the connector run to reject");

          const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
            `${asUrl}/_ref/runs/${encodeURIComponent(requirePathSegment(rejected.run_id, "rejected.run_id"))}/timeline`
          );
          const runTypes = (runTimeline.data || []).map((event) => event.event_type);
          assert.ok(!runTypes.includes("run.completed"));
          assert.ok(!runTypes.includes("run.interaction_required"));
          assert.ok(!runTypes.includes("run.interaction_completed"));
          assert.ok(runTypes.includes("run.failed"));

          const failedEvent = (runTimeline.data || []).find((event) => event.event_type === "run.failed");
          assert.ok(failedEvent, "expected run.failed event");
          assert.equal(failedEvent.data.source?.kind, "connector");
          assert.equal(failedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
          assert.equal(failedEvent.data.reason, "connector_protocol_violation");
          assert.equal(failedEvent.data.records_flushed, 0);
          assert.equal(failedEvent.data.buffered_records_dropped, 0);
          assert.equal(failedEvent.data.checkpoint_commit_status, "not_committed");
        } finally {
          rmSync(tmpDir, { force: true, recursive: true });
        }
      });
    }
  );

  await t.test("captures post-DONE skip-result protocol violations without recording skip artifacts", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-event-spine-post-done-skip-result-"));
      const connectorPath = join(tmpDir, "connector.mjs");
      writeFileSync(
        connectorPath,
        `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 0,
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'SKIP_RESULT',
    stream: 'top_artists',
    reason: 'after_done',
    message: 'after done should be rejected',
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
        "utf8"
      );

      try {
        let rejected: RunConnectorError | undefined;
        await assert.rejects(
          runConnector({
            admitRunConnection: fakeAdmitRunConnection(),
            collectionMode: "incremental",
            connectorId: spotifyManifest.connector_id,
            connectorPath,
            manifest: spotifyManifest,
            onInteraction: async () => ({}),
            ownerToken,
            persistState: true,
            rsUrl,
            state: null,
          }),
          (err: RunConnectorError) => {
            rejected = err;
            assert.equal(err.failure_reason, "connector_protocol_violation");
            return true;
          }
        );
        assert.ok(rejected, "expected the connector run to reject");

        const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
          `${asUrl}/_ref/runs/${encodeURIComponent(requirePathSegment(rejected.run_id, "rejected.run_id"))}/timeline`
        );
        const runTypes = (runTimeline.data || []).map((event) => event.event_type);
        assert.ok(!runTypes.includes("run.completed"));
        assert.ok(!runTypes.includes("run.stream_skipped"));
        assert.ok(runTypes.includes("run.failed"));

        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === "run.failed");
        assert.ok(failedEvent, "expected run.failed event");
        assert.equal(failedEvent.data.source?.kind, "connector");
        assert.equal(failedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(failedEvent.data.reason, "connector_protocol_violation");
        assert.equal(failedEvent.data.records_flushed, 0);
        assert.equal(failedEvent.data.buffered_records_dropped, 0);
        assert.equal(failedEvent.data.checkpoint_commit_status, "not_committed");
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  await t.test(
    "captures undeclared-stream skip-result protocol violations without recording skip artifacts",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-event-spine-undeclared-skip-result-"));
        const connectorPath = join(tmpDir, "connector.mjs");
        writeFileSync(
          connectorPath,
          `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'SKIP_RESULT',
    stream: 'undeclared_stream',
    reason: 'rate_limited',
    message: 'undeclared skip should be rejected',
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
          "utf8"
        );

        try {
          let rejected: RunConnectorError | undefined;
          await assert.rejects(
            runConnector({
              admitRunConnection: fakeAdmitRunConnection(),
              collectionMode: "incremental",
              connectorId: spotifyManifest.connector_id,
              connectorPath,
              manifest: spotifyManifest,
              onInteraction: async () => ({}),
              ownerToken,
              persistState: true,
              rsUrl,
              state: null,
            }),
            (err: RunConnectorError) => {
              rejected = err;
              assert.equal(err.failure_reason, "connector_protocol_violation");
              assert.match(err.message, REGEXP_11);
              return true;
            }
          );
          assert.ok(rejected, "expected the connector run to reject");

          const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
            `${asUrl}/_ref/runs/${encodeURIComponent(requirePathSegment(rejected.run_id, "rejected.run_id"))}/timeline`
          );
          const runTypes = (runTimeline.data || []).map((event) => event.event_type);
          assert.ok(!runTypes.includes("run.stream_skipped"));
          assert.ok(runTypes.includes("run.failed"));

          const failedEvent = (runTimeline.data || []).find((event) => event.event_type === "run.failed");
          assert.ok(failedEvent, "expected run.failed event");
          assert.equal(failedEvent.data.source?.kind, "connector");
          assert.equal(failedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
          assert.equal(failedEvent.data.reason, "connector_protocol_violation");
          assert.equal(failedEvent.data.records_flushed, 0);
          assert.equal(failedEvent.data.buffered_records_dropped, 0);
          assert.equal(failedEvent.data.checkpoint_commit_status, "not_committed");
        } finally {
          rmSync(tmpDir, { force: true, recursive: true });
        }
      });
    }
  );

  await t.test("captures post-DONE state protocol violations without recording checkpoint artifacts", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-event-spine-post-done-state-"));
      const connectorPath = join(tmpDir, "connector.mjs");
      writeFileSync(
        connectorPath,
        `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 0,
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'top_artists',
    cursor: { after: 'after_done_state' },
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
        "utf8"
      );

      try {
        let rejected: RunConnectorError | undefined;
        await assert.rejects(
          runConnector({
            admitRunConnection: fakeAdmitRunConnection(),
            collectionMode: "incremental",
            connectorId: spotifyManifest.connector_id,
            connectorPath,
            manifest: spotifyManifest,
            onInteraction: async () => ({}),
            ownerToken,
            persistState: true,
            rsUrl,
            state: null,
          }),
          (err: RunConnectorError) => {
            rejected = err;
            assert.equal(err.failure_reason, "connector_protocol_violation");
            return true;
          }
        );
        assert.ok(rejected, "expected the connector run to reject");

        const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
          `${asUrl}/_ref/runs/${encodeURIComponent(requirePathSegment(rejected.run_id, "rejected.run_id"))}/timeline`
        );
        const runTypes = (runTimeline.data || []).map((event) => event.event_type);
        assert.ok(!runTypes.includes("run.completed"));
        assert.ok(!runTypes.includes("run.state_staged"));
        assert.ok(!runTypes.includes("run.state_advanced"));
        assert.ok(runTypes.includes("run.failed"));

        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === "run.failed");
        assert.ok(failedEvent, "expected run.failed event");
        assert.equal(failedEvent.data.source?.kind, "connector");
        assert.equal(failedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(failedEvent.data.reason, "connector_protocol_violation");
        assert.equal(failedEvent.data.records_flushed, 0);
        assert.equal(failedEvent.data.buffered_records_dropped, 0);
        assert.equal(failedEvent.data.state_streams_staged, 0);
        assert.equal(failedEvent.data.state_streams_committed, 0);
        assert.equal(failedEvent.data.checkpoint_commit_status, "not_committed");
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  await t.test(
    "captures post-DONE invalid JSONL protocol violations without recording completion artifacts",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-event-spine-post-done-invalid-jsonl-"));
        const connectorPath = join(tmpDir, "connector.mjs");
        writeFileSync(
          connectorPath,
          `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 0,
  }) + '\\n');
  process.stdout.write('this is not valid jsonl after done\\n');
  rl.close();
  process.exit(0);
});
`,
          "utf8"
        );

        try {
          let rejected: RunConnectorError | undefined;
          await assert.rejects(
            runConnector({
              admitRunConnection: fakeAdmitRunConnection(),
              collectionMode: "incremental",
              connectorId: spotifyManifest.connector_id,
              connectorPath,
              manifest: spotifyManifest,
              onInteraction: async () => ({}),
              ownerToken,
              persistState: true,
              rsUrl,
              state: null,
            }),
            (err: RunConnectorError) => {
              rejected = err;
              assert.equal(err.failure_reason, "connector_protocol_violation");
              assert.match(err.message, REGEXP_12);
              return true;
            }
          );
          assert.ok(rejected, "expected the connector run to reject");

          const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
            `${asUrl}/_ref/runs/${encodeURIComponent(requirePathSegment(rejected.run_id, "rejected.run_id"))}/timeline`
          );
          const runTypes = (runTimeline.data || []).map((event) => event.event_type);
          assert.ok(!runTypes.includes("run.completed"));
          assert.ok(runTypes.includes("run.failed"));

          const failedEvent = (runTimeline.data || []).find((event) => event.event_type === "run.failed");
          assert.ok(failedEvent, "expected run.failed event");
          assert.equal(failedEvent.data.source?.kind, "connector");
          assert.equal(failedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
          assert.equal(failedEvent.data.reason, "connector_protocol_violation");
          assert.equal(failedEvent.data.records_flushed, 0);
          assert.equal(failedEvent.data.buffered_records_dropped, 0);
          assert.equal(failedEvent.data.checkpoint_commit_status, "not_committed");
        } finally {
          rmSync(tmpDir, { force: true, recursive: true });
        }
      });
    }
  );

  await t.test(
    "captures undeclared-stream interaction protocol violations without recording interaction artifacts",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-event-spine-undeclared-interaction-"));
        const connectorPath = join(tmpDir, "connector.mjs");
        writeFileSync(
          connectorPath,
          `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'INTERACTION',
    request_id: 'undeclared_stream_interaction_event',
    stream: 'ghost',
    kind: 'manual_action',
    message: 'undeclared stream interactions should be rejected',
  }) + '\\n');
  rl.close();
});
`,
          "utf8"
        );

        try {
          let rejected: RunConnectorError | undefined;
          await assert.rejects(
            runConnector({
              admitRunConnection: fakeAdmitRunConnection(),
              collectionMode: "incremental",
              connectorId: spotifyManifest.connector_id,
              connectorPath,
              manifest: spotifyManifest,
              onInteraction: async () => ({
                request_id: "undeclared_stream_interaction_event",
                status: "success",
                type: "INTERACTION_RESPONSE",
              }),
              ownerToken,
              persistState: true,
              rsUrl,
              state: null,
            }),
            (err: RunConnectorError) => {
              rejected = err;
              assert.equal(err.failure_reason, "connector_protocol_violation");
              assert.match(err.message, REGEXP_13);
              return true;
            }
          );
          assert.ok(rejected, "expected the connector run to reject");

          const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
            `${asUrl}/_ref/runs/${encodeURIComponent(requirePathSegment(rejected.run_id, "rejected.run_id"))}/timeline`
          );
          const runTypes = (runTimeline.data || []).map((event) => event.event_type);
          assert.ok(!runTypes.includes("run.interaction_required"));
          assert.ok(!runTypes.includes("run.interaction_completed"));
          assert.ok(!runTypes.includes("run.completed"));
          assert.ok(runTypes.includes("run.failed"));

          const failedEvent = (runTimeline.data || []).find((event) => event.event_type === "run.failed");
          assert.ok(failedEvent, "expected run.failed event");
          assert.equal(failedEvent.data.source?.kind, "connector");
          assert.equal(failedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
          assert.equal(failedEvent.data.reason, "connector_protocol_violation");
          assert.equal(failedEvent.data.records_flushed, 0);
          assert.equal(failedEvent.data.buffered_records_dropped, 0);
          assert.equal(failedEvent.data.checkpoint_commit_status, "not_committed");
        } finally {
          rmSync(tmpDir, { force: true, recursive: true });
        }
      });
    }
  );

  await t.test("captures interaction lifecycle events with source descriptors", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-event-spine-interaction-"));
      const connectorPath = join(tmpDir, "connector.mjs");
      writeFileSync(
        connectorPath,
        `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_evt_1',
      kind: 'credentials',
      message: 'Need a token',
      schema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] },
      timeout_seconds: 300
    }) + '\\n');
    return;
  }
  if (msg.type === 'INTERACTION_RESPONSE') {
    process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
    rl.close();
    process.exit(0);
  }
});
`,
        "utf8"
      );

      try {
        const result = await runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "full_refresh",
          connectorId: spotifyManifest.connector_id,
          connectorPath,
          manifest: spotifyManifest,
          onInteraction: async (interaction: unknown) => ({
            data: { token: "super_secret_token" },
            request_id: (interaction as { request_id: string }).request_id,
            status: "success",
            type: "INTERACTION_RESPONSE",
          }),
          ownerToken,
          rsUrl,
          state: null,
        });

        const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
          `${asUrl}/_ref/runs/${encodeURIComponent(requirePathSegment(result.run_id, "result_run_id"))}/timeline`
        );
        const interactionRequired = (runTimeline.data || []).find(
          (event) => event.event_type === "run.interaction_required"
        );
        const interactionCompleted = (runTimeline.data || []).find(
          (event) => event.event_type === "run.interaction_completed"
        );
        assert.ok(interactionRequired, "expected run.interaction_required event");
        assert.ok(interactionCompleted, "expected run.interaction_completed event");
        assert.equal(interactionRequired.data.kind, "credentials");
        assert.equal(interactionRequired.data.stream, null);
        assert.equal(interactionRequired.data.message, "Need a token");
        assert.deepEqual(interactionRequired.data.schema, {
          properties: { token: { type: "string" } },
          required: ["token"],
          type: "object",
        });
        assert.equal(interactionRequired.data.timeout_seconds, 300);
        assert.equal(interactionCompleted.data.kind, "credentials");
        assert.equal(interactionCompleted.data.stream, null);

        for (const event of [interactionRequired, interactionCompleted]) {
          assert.equal(event.data.source?.kind, "connector");
          assert.equal(event.data.source?.id, SPOTIFY_CONNECTOR_KEY);
          assert.ok(
            !("connector_id" in event.data),
            `${event.event_type} should use source descriptors instead of raw connector_id`
          );
        }

        const serializedTimeline = JSON.stringify(runTimeline.data || []);
        assert.ok(
          !serializedTimeline.includes("super_secret_token"),
          "interaction timelines should not persist INTERACTION_RESPONSE secret values"
        );
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  await t.test("captures interaction timeout lifecycle events", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-event-spine-interaction-timeout-"));
      const connectorPath = join(tmpDir, "connector.mjs");
      writeFileSync(
        connectorPath,
        `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_evt_timeout',
      kind: 'credentials',
      message: 'Need a token',
      schema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] },
      timeout_seconds: 0.05
    }) + '\\n');
    return;
  }
  if (msg.type === 'INTERACTION_RESPONSE') {
    process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
    rl.close();
    process.exit(0);
  }
});
`,
        "utf8"
      );

      try {
        const result = await runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "full_refresh",
          connectorId: spotifyManifest.connector_id,
          connectorPath,
          manifest: spotifyManifest,
          onInteraction: async () =>
            new Promise(() => {
              /* intentionally empty */
            }),
          ownerToken,
          rsUrl,
          state: null,
        });

        const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
          `${asUrl}/_ref/runs/${encodeURIComponent(requirePathSegment(result.run_id, "result_run_id"))}/timeline`
        );
        const interactionRequired = (runTimeline.data || []).find(
          (event) => event.event_type === "run.interaction_required"
        );
        const interactionCompleted = (runTimeline.data || []).find(
          (event) => event.event_type === "run.interaction_completed"
        );
        assert.ok(interactionRequired, "expected run.interaction_required event");
        assert.ok(interactionCompleted, "expected run.interaction_completed event");
        assert.equal(interactionCompleted.status, "timeout");
        assert.equal(interactionCompleted.data.status, "timeout");
        assert.equal(interactionRequired.data.message, "Need a token");
        assert.equal(interactionRequired.data.timeout_seconds, 0.05);
        assert.equal(interactionCompleted.data.kind, "credentials");
        assert.equal(interactionCompleted.data.stream, null);

        for (const event of [interactionRequired, interactionCompleted]) {
          assert.equal(event.data.source?.kind, "connector");
          assert.equal(event.data.source?.id, SPOTIFY_CONNECTOR_KEY);
          assert.ok(
            !("connector_id" in event.data),
            `${event.event_type} should use source descriptors instead of raw connector_id`
          );
        }
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  await t.test("captures interaction cancelled lifecycle events", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-event-spine-interaction-cancelled-"));
      const connectorPath = join(tmpDir, "connector.mjs");
      writeFileSync(
        connectorPath,
        `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_evt_cancelled',
      kind: 'credentials',
      message: 'Need a token',
      schema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] },
      timeout_seconds: 300
    }) + '\\n');
    return;
  }
  if (msg.type === 'INTERACTION_RESPONSE') {
    process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
    rl.close();
    process.exit(0);
  }
});
`,
        "utf8"
      );

      try {
        const result = await runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "full_refresh",
          connectorId: spotifyManifest.connector_id,
          connectorPath,
          manifest: spotifyManifest,
          // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
          onInteraction: async () => {
            throw new Error("user aborted interaction");
          },
          ownerToken,
          rsUrl,
          state: null,
        });

        const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
          `${asUrl}/_ref/runs/${encodeURIComponent(requirePathSegment(result.run_id, "result_run_id"))}/timeline`
        );
        const interactionRequired = (runTimeline.data || []).find(
          (event) => event.event_type === "run.interaction_required"
        );
        const interactionCompleted = (runTimeline.data || []).find(
          (event) => event.event_type === "run.interaction_completed"
        );
        assert.ok(interactionRequired, "expected run.interaction_required event");
        assert.ok(interactionCompleted, "expected run.interaction_completed event");
        assert.equal(interactionCompleted.status, "cancelled");
        assert.equal(interactionCompleted.data.status, "cancelled");
        assert.equal(interactionRequired.data.message, "Need a token");
        assert.equal(interactionRequired.data.timeout_seconds, 300);
        assert.equal(interactionCompleted.data.kind, "credentials");
        assert.equal(interactionCompleted.data.stream, null);

        for (const event of [interactionRequired, interactionCompleted]) {
          assert.equal(event.data.source?.kind, "connector");
          assert.equal(event.data.source?.id, SPOTIFY_CONNECTOR_KEY);
          assert.ok(
            !("connector_id" in event.data),
            `${event.event_type} should use source descriptors instead of raw connector_id`
          );
        }
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  await t.test("captures blocked interaction protocol violations without recording completion", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-event-spine-interaction-blocked-"));
      const connectorPath = join(tmpDir, "connector.mjs");
      writeFileSync(
        connectorPath,
        `
import { createInterface } from 'readline';
process.on('SIGTERM', () => process.exit(1));
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_evt_blocked_1',
      kind: 'credentials',
      message: 'Need a token',
      schema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] },
      timeout_seconds: 300
    }) + '\\n');
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        type: 'INTERACTION',
        request_id: 'int_evt_blocked_2',
        kind: 'confirmation',
        message: 'Should never be admitted',
        schema: { type: 'object' },
        timeout_seconds: 300
      }) + '\\n');
    }, 10);
  }
});
`,
        "utf8"
      );

      try {
        let rejected: RunConnectorError | undefined;
        await assert.rejects(
          async () => {
            await runConnector({
              admitRunConnection: fakeAdmitRunConnection(),
              collectionMode: "full_refresh",
              connectorId: spotifyManifest.connector_id,
              connectorPath,
              manifest: spotifyManifest,
              onInteraction: async () =>
                new Promise(() => {
                  /* intentionally empty */
                }),
              ownerToken,
              rsUrl,
              state: null,
            });
          },
          (err: RunConnectorError) => {
            rejected = err;
            assert.equal(err.message, "Connector emitted INTERACTION while waiting for INTERACTION_RESPONSE");
            assert.equal(err.failure_reason, "connector_protocol_violation");
            return true;
          }
        );
        assert.ok(rejected, "expected the connector run to reject");

        const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
          `${asUrl}/_ref/runs/${encodeURIComponent(requirePathSegment(rejected.run_id, "rejected.run_id"))}/timeline`
        );
        const interactionRequiredEvents = (runTimeline.data || []).filter(
          (event) => event.event_type === "run.interaction_required"
        );
        const interactionCompletedEvents = (runTimeline.data || []).filter(
          (event) => event.event_type === "run.interaction_completed"
        );
        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === "run.failed");

        assert.equal(interactionRequiredEvents.length, 1, "only the first interaction should reach the event spine");
        assert.equal(
          interactionCompletedEvents.length,
          0,
          "blocked interaction violations should not record completion"
        );
        assert.ok(failedEvent, "expected run.failed event for blocked interaction protocol violation");
        assert.equal(failedEvent.data.reason, "connector_protocol_violation");
        assert.equal(failedEvent.data.checkpoint_commit_status, "not_committed");

        for (const event of [...interactionRequiredEvents, failedEvent]) {
          assert.equal(event.data.source?.kind, "connector");
          assert.equal(event.data.source?.id, SPOTIFY_CONNECTOR_KEY);
          assert.ok(
            !("connector_id" in event.data),
            `${event.event_type} should use source descriptors instead of raw connector_id`
          );
        }
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  await t.test("captures blocked interaction state violations without recording checkpoint artifacts", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-event-spine-interaction-state-blocked-"));
      const connectorPath = join(tmpDir, "connector.mjs");
      writeFileSync(
        connectorPath,
        `
import { createInterface } from 'readline';
process.on('SIGTERM', () => process.exit(1));
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_evt_blocked_state_1',
      kind: 'credentials',
      message: 'Need a token',
      schema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] },
      timeout_seconds: 300
    }) + '\\n');
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        type: 'STATE',
        stream: 'top_artists',
        cursor: { after: 'should_not_stage' }
      }) + '\\n');
    }, 10);
  }
});
`,
        "utf8"
      );

      try {
        let rejected: RunConnectorError | undefined;
        await assert.rejects(
          async () => {
            await runConnector({
              admitRunConnection: fakeAdmitRunConnection(),
              collectionMode: "incremental",
              connectorId: spotifyManifest.connector_id,
              connectorPath,
              manifest: spotifyManifest,
              onInteraction: async () =>
                new Promise(() => {
                  /* intentionally empty */
                }),
              ownerToken,
              persistState: true,
              rsUrl,
              state: null,
            });
          },
          (err: RunConnectorError) => {
            rejected = err;
            assert.equal(err.message, "Connector emitted STATE while waiting for INTERACTION_RESPONSE");
            assert.equal(err.failure_reason, "connector_protocol_violation");
            return true;
          }
        );
        assert.ok(rejected, "expected the connector run to reject");

        const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
          `${asUrl}/_ref/runs/${encodeURIComponent(requirePathSegment(rejected.run_id, "rejected.run_id"))}/timeline`
        );
        const interactionRequiredEvents = (runTimeline.data || []).filter(
          (event) => event.event_type === "run.interaction_required"
        );
        const interactionCompletedEvents = (runTimeline.data || []).filter(
          (event) => event.event_type === "run.interaction_completed"
        );
        const stateStagedEvents = (runTimeline.data || []).filter((event) => event.event_type === "run.state_staged");
        const stateAdvancedEvents = (runTimeline.data || []).filter(
          (event) => event.event_type === "run.state_advanced"
        );
        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === "run.failed");

        assert.equal(interactionRequiredEvents.length, 1, "only the first interaction should reach the event spine");
        assert.equal(
          interactionCompletedEvents.length,
          0,
          "blocked interaction state violations should not record completion"
        );
        assert.equal(stateStagedEvents.length, 0, "blocked interaction state violations should not stage checkpoints");
        assert.equal(
          stateAdvancedEvents.length,
          0,
          "blocked interaction state violations should not commit checkpoints"
        );
        assert.ok(failedEvent, "expected run.failed event for blocked interaction state protocol violation");
        assert.equal(failedEvent.data.reason, "connector_protocol_violation");
        assert.equal(failedEvent.data.state_streams_staged, 0);
        assert.equal(failedEvent.data.state_streams_committed, 0);
        assert.equal(failedEvent.data.checkpoint_commit_status, "not_committed");

        for (const event of [...interactionRequiredEvents, failedEvent]) {
          assert.equal(event.data.source?.kind, "connector");
          assert.equal(event.data.source?.id, SPOTIFY_CONNECTOR_KEY);
          assert.ok(
            !("connector_id" in event.data),
            `${event.event_type} should use source descriptors instead of raw connector_id`
          );
        }
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  await t.test("captures blocked interaction progress violations without recording progress artifacts", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-event-spine-interaction-progress-blocked-"));
      const connectorPath = join(tmpDir, "connector.mjs");
      writeFileSync(
        connectorPath,
        `
import { createInterface } from 'readline';
process.on('SIGTERM', () => process.exit(1));
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_evt_blocked_progress_1',
      kind: 'credentials',
      message: 'Need a token',
      schema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] },
      timeout_seconds: 300
    }) + '\\n');
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        type: 'PROGRESS',
        stream: 'top_artists',
        message: 'should_not_be_recorded'
      }) + '\\n');
    }, 10);
  }
});
`,
        "utf8"
      );

      try {
        let rejected: RunConnectorError | undefined;
        await assert.rejects(
          async () => {
            await runConnector({
              admitRunConnection: fakeAdmitRunConnection(),
              collectionMode: "full_refresh",
              connectorId: spotifyManifest.connector_id,
              connectorPath,
              manifest: spotifyManifest,
              onInteraction: async () =>
                new Promise(() => {
                  /* intentionally empty */
                }),
              ownerToken,
              rsUrl,
              state: null,
            });
          },
          (err: RunConnectorError) => {
            rejected = err;
            assert.equal(err.message, "Connector emitted PROGRESS while waiting for INTERACTION_RESPONSE");
            assert.equal(err.failure_reason, "connector_protocol_violation");
            return true;
          }
        );
        assert.ok(rejected, "expected the connector run to reject");

        const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
          `${asUrl}/_ref/runs/${encodeURIComponent(requirePathSegment(rejected.run_id, "rejected.run_id"))}/timeline`
        );
        const interactionRequiredEvents = (runTimeline.data || []).filter(
          (event) => event.event_type === "run.interaction_required"
        );
        const interactionCompletedEvents = (runTimeline.data || []).filter(
          (event) => event.event_type === "run.interaction_completed"
        );
        const progressEvents = (runTimeline.data || []).filter((event) => event.event_type === "run.progress_reported");
        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === "run.failed");

        assert.equal(interactionRequiredEvents.length, 1, "only the first interaction should reach the event spine");
        assert.equal(
          interactionCompletedEvents.length,
          0,
          "blocked interaction progress violations should not record completion"
        );
        assert.equal(progressEvents.length, 0, "blocked interaction progress violations should not record progress");
        assert.ok(failedEvent, "expected run.failed event for blocked interaction progress protocol violation");
        assert.equal(failedEvent.data.reason, "connector_protocol_violation");
        assert.equal(failedEvent.data.checkpoint_commit_status, "not_committed");

        for (const event of [...interactionRequiredEvents, failedEvent]) {
          assert.equal(event.data.source?.kind, "connector");
          assert.equal(event.data.source?.id, SPOTIFY_CONNECTOR_KEY);
          assert.ok(
            !("connector_id" in event.data),
            `${event.event_type} should use source descriptors instead of raw connector_id`
          );
        }
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  await t.test("captures blocked interaction skip-result violations without recording skip artifacts", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-event-spine-interaction-skip-blocked-"));
      const connectorPath = join(tmpDir, "connector.mjs");
      writeFileSync(
        connectorPath,
        `
import { createInterface } from 'readline';
process.on('SIGTERM', () => process.exit(1));
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_evt_blocked_skip_1',
      kind: 'credentials',
      message: 'Need a token',
      schema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] },
      timeout_seconds: 300
    }) + '\\n');
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        type: 'SKIP_RESULT',
        stream: 'top_artists',
        reason: 'should_not_be_recorded',
        message: 'blocked by pending interaction'
      }) + '\\n');
    }, 10);
  }
});
`,
        "utf8"
      );

      try {
        let rejected: RunConnectorError | undefined;
        await assert.rejects(
          async () => {
            await runConnector({
              admitRunConnection: fakeAdmitRunConnection(),
              collectionMode: "full_refresh",
              connectorId: spotifyManifest.connector_id,
              connectorPath,
              manifest: spotifyManifest,
              onInteraction: async () =>
                new Promise(() => {
                  /* intentionally empty */
                }),
              ownerToken,
              rsUrl,
              state: null,
            });
          },
          (err: RunConnectorError) => {
            rejected = err;
            assert.equal(err.message, "Connector emitted SKIP_RESULT while waiting for INTERACTION_RESPONSE");
            assert.equal(err.failure_reason, "connector_protocol_violation");
            return true;
          }
        );
        assert.ok(rejected, "expected the connector run to reject");

        const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
          `${asUrl}/_ref/runs/${encodeURIComponent(requirePathSegment(rejected.run_id, "rejected.run_id"))}/timeline`
        );
        const interactionRequiredEvents = (runTimeline.data || []).filter(
          (event) => event.event_type === "run.interaction_required"
        );
        const interactionCompletedEvents = (runTimeline.data || []).filter(
          (event) => event.event_type === "run.interaction_completed"
        );
        const skippedEvents = (runTimeline.data || []).filter((event) => event.event_type === "run.stream_skipped");
        const failedEvent = (runTimeline.data || []).find((event) => event.event_type === "run.failed");

        assert.equal(interactionRequiredEvents.length, 1, "only the first interaction should reach the event spine");
        assert.equal(
          interactionCompletedEvents.length,
          0,
          "blocked interaction skip-result violations should not record completion"
        );
        assert.equal(
          skippedEvents.length,
          0,
          "blocked interaction skip-result violations should not record skip artifacts"
        );
        assert.ok(failedEvent, "expected run.failed event for blocked interaction skip-result protocol violation");
        assert.equal(failedEvent.data.reason, "connector_protocol_violation");
        assert.equal(failedEvent.data.checkpoint_commit_status, "not_committed");

        for (const event of [...interactionRequiredEvents, failedEvent]) {
          assert.equal(event.data.source?.kind, "connector");
          assert.equal(event.data.source?.id, SPOTIFY_CONNECTOR_KEY);
          assert.ok(
            !("connector_id" in event.data),
            `${event.event_type} should use source descriptors instead of raw connector_id`
          );
        }
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    });
  });

  await t.test(
    "captures blocked interaction terminal violations without recording completion or terminal success artifacts",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-event-spine-interaction-done-blocked-"));
        const connectorPath = join(tmpDir, "connector.mjs");
        writeFileSync(
          connectorPath,
          `
import { createInterface } from 'readline';
process.on('SIGTERM', () => process.exit(1));
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_evt_blocked_done_1',
      kind: 'credentials',
      message: 'Need a token',
      schema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] },
      timeout_seconds: 300
    }) + '\\n');
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        type: 'DONE',
        status: 'succeeded',
        records_emitted: 0
      }) + '\\n');
    }, 10);
  }
});
`,
          "utf8"
        );

        try {
          let rejected: RunConnectorError | undefined;
          await assert.rejects(
            async () => {
              await runConnector({
                admitRunConnection: fakeAdmitRunConnection(),
                collectionMode: "full_refresh",
                connectorId: spotifyManifest.connector_id,
                connectorPath,
                manifest: spotifyManifest,
                onInteraction: async () =>
                  new Promise(() => {
                    /* intentionally empty */
                  }),
                ownerToken,
                rsUrl,
                state: null,
              });
            },
            (err: RunConnectorError) => {
              rejected = err;
              assert.equal(err.message, "Connector emitted DONE while waiting for INTERACTION_RESPONSE");
              assert.equal(err.failure_reason, "connector_protocol_violation");
              return true;
            }
          );
          assert.ok(rejected, "expected the connector run to reject");

          const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
            `${asUrl}/_ref/runs/${encodeURIComponent(requirePathSegment(rejected.run_id, "rejected.run_id"))}/timeline`
          );
          const interactionRequiredEvents = (runTimeline.data || []).filter(
            (event) => event.event_type === "run.interaction_required"
          );
          const interactionCompletedEvents = (runTimeline.data || []).filter(
            (event) => event.event_type === "run.interaction_completed"
          );
          const completedEvents = (runTimeline.data || []).filter((event) => event.event_type === "run.completed");
          const failedEvent = (runTimeline.data || []).find((event) => event.event_type === "run.failed");

          assert.equal(
            interactionRequiredEvents.length,
            1,
            "only the initial interaction should reach the event spine"
          );
          assert.equal(
            interactionCompletedEvents.length,
            0,
            "blocked interaction terminal violations should not record completion"
          );
          assert.equal(
            completedEvents.length,
            0,
            "blocked interaction terminal violations should not record run.completed"
          );
          assert.ok(failedEvent, "expected run.failed event for blocked interaction terminal protocol violation");
          assert.equal(failedEvent.data.reason, "connector_protocol_violation");
          assert.equal(failedEvent.data.checkpoint_commit_status, "not_committed");

          for (const event of [...interactionRequiredEvents, failedEvent]) {
            assert.equal(event.data.source?.kind, "connector");
            assert.equal(event.data.source?.id, SPOTIFY_CONNECTOR_KEY);
            assert.ok(
              !("connector_id" in event.data),
              `${event.event_type} should use source descriptors instead of raw connector_id`
            );
          }
        } finally {
          rmSync(tmpDir, { force: true, recursive: true });
        }
      });
    }
  );

  await t.test(
    "captures blocked interaction invalid JSONL violations without recording completion artifacts",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-event-spine-interaction-invalid-jsonl-blocked-"));
        const connectorPath = join(tmpDir, "connector.mjs");
        writeFileSync(
          connectorPath,
          `
import { createInterface } from 'readline';
process.on('SIGTERM', () => process.exit(1));
const rl = createInterface({ input: process.stdin });
let started = false;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START' && !started) {
    started = true;
    process.stdout.write(JSON.stringify({
      type: 'INTERACTION',
      request_id: 'int_evt_blocked_invalid_jsonl_1',
      kind: 'credentials',
      message: 'Need a token',
      schema:
{ type: 'object', properties: { token: { type: 'string' } }, required: ['token'] },
      timeout_seconds: 300
    }) + '\\n');
    setTimeout(() => {
      process.stdout.write('this is not valid jsonl while waiting\\n');
    }, 10);
  }
});
`,
          "utf8"
        );

        try {
          let rejected: RunConnectorError | undefined;
          await assert.rejects(
            async () => {
              await runConnector({
                admitRunConnection: fakeAdmitRunConnection(),
                collectionMode: "full_refresh",
                connectorId: spotifyManifest.connector_id,
                connectorPath,
                manifest: spotifyManifest,
                onInteraction: async () =>
                  new Promise(() => {
                    /* intentionally empty */
                  }),
                ownerToken,
                rsUrl,
                state: null,
              });
            },
            (err: RunConnectorError) => {
              rejected = err;
              assert.match(err.message, REGEXP_14);
              assert.equal(err.failure_reason, "connector_protocol_violation");
              return true;
            }
          );
          assert.ok(rejected, "expected the connector run to reject");

          const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
            `${asUrl}/_ref/runs/${encodeURIComponent(requirePathSegment(rejected.run_id, "rejected.run_id"))}/timeline`
          );
          const interactionRequiredEvents = (runTimeline.data || []).filter(
            (event) => event.event_type === "run.interaction_required"
          );
          const interactionCompletedEvents = (runTimeline.data || []).filter(
            (event) => event.event_type === "run.interaction_completed"
          );
          const completedEvents = (runTimeline.data || []).filter((event) => event.event_type === "run.completed");
          const failedEvent = (runTimeline.data || []).find((event) => event.event_type === "run.failed");

          assert.equal(
            interactionRequiredEvents.length,
            1,
            "only the initial interaction should reach the event spine"
          );
          assert.equal(
            interactionCompletedEvents.length,
            0,
            "blocked interaction invalid JSONL should not record completion"
          );
          assert.equal(completedEvents.length, 0, "blocked interaction invalid JSONL should not record run.completed");
          assert.ok(failedEvent, "expected run.failed event for blocked interaction invalid JSONL");
          assert.equal(failedEvent.data.reason, "connector_protocol_violation");
          assert.equal(failedEvent.data.checkpoint_commit_status, "not_committed");

          for (const event of [...interactionRequiredEvents, failedEvent]) {
            assert.equal(event.data.source?.kind, "connector");
            assert.equal(event.data.source?.id, SPOTIFY_CONNECTOR_KEY);
            assert.ok(
              !("connector_id" in event.data),
              `${event.event_type} should use source descriptors instead of raw connector_id`
            );
          }
        } finally {
          rmSync(tmpDir, { force: true, recursive: true });
        }
      });
    }
  );
});
