// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Control-plane `_ref` listing and search helpers.
 *
 * These endpoints are reference-designated and read-only. They support the
 * operator console and the CLI. Coverage here proves:
 *
 * - pagination / limit behaves consistently across traces/grants/runs
 * - status and correlation-id filters work the way the console depends on
 * - search surfaces exact-id hits for deep-linking
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { emitSpineEvent } from "../lib/spine.ts";
import { runConnector } from "../runtime/index.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { ingestRecord } from "../server/records.ts";
import {
  createSqliteConnectorInstanceStore,
  makeDefaultAccountConnectorInstanceId,
} from "../server/stores/connector-instance-store.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const TEST_DCR_INITIAL_ACCESS_TOKEN = "pdpp-reference-test-initial-access-token";

/**
 * `server/index.js` (startServer) is untyped JS (allowJs, checkJs:false)
 * under server/**, forbidden to touch. Same boundary-cast pattern used in
 * `run-interaction-stream-routes.test.ts` and
 * `connector-failure-diagnostics-control-plane.test.ts`: model the real
 * call/return shape locally from the source and cast the untyped import once,
 * rather than fighting incomplete structural inference at dozens of call
 * sites.
 */
interface ClosableServer {
  asPort: number;
  asServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  rsPort: number;
  rsServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
}

interface StartServerOptions {
  asPort?: number;
  dbPath?: string;
  dynamicClientRegistrationInitialAccessTokens?: string[];
  quiet?: boolean;
  rsPort?: number;
}

const typedStartServer = startServer as unknown as (opts: StartServerOptions) => Promise<ClosableServer>;

/**
 * `runtime/index.ts` (runConnector) is untyped JS under runtime/**,
 * forbidden to touch. This test only reads `ownerToken` off the seed
 * helper's own return value (never a property of runConnector's result), so
 * the result is modeled as `unknown` rather than invented a divergent shape.
 */
interface RunConnectorOptions {
  admitRunConnection: (input: {
    connectorId: string;
    connectorInstanceId: string | null;
    ownerSubjectId: string | null;
  }) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }>;
  collectionMode: string;
  connectorId: string;
  connectorPath: string;
  manifest: SpotifyManifest;
  ownerSubjectId: string;
  ownerToken: string;
  rsUrl: string;
  state: null;
}

const typedRunConnector = runConnector as unknown as (opts: RunConnectorOptions) => Promise<unknown>;

/**
 * `server/records.js` (ingestRecord) is untyped JS under server/**,
 * forbidden to touch. This test never reads ingestRecord's return value, so
 * only the parameter shape it actually constructs is modeled.
 */
interface IngestRecordInput {
  data: Record<string, unknown>;
  emitted_at: string;
  key: string;
  op?: string;
  stream: string;
}

const typedIngestRecord = ingestRecord as unknown as (
  storageTarget: string,
  record: IngestRecordInput
) => Promise<unknown>;

/**
 * `server/db.js` (getDb) is untyped JS under server/**, forbidden to touch.
 * `db.prepare(sql).run(...)` / `.get(...)` calls in this file only ever
 * bind positional params and read back rows the test itself constructed, so
 * a minimal `better-sqlite3`-shaped interface covers every call site here
 * without importing the real (also untyped) driver types.
 */
interface PreparedStatement {
  get: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => unknown;
}

interface DbHandle {
  prepare: (sql: string) => PreparedStatement;
}

const typedGetDb = getDb as unknown as () => DbHandle;

interface SpotifyManifest {
  connector_id: string;
  [key: string]: unknown;
}

interface FetchJsonResult<T> {
  body: T;
  status: number;
}

async function closeServer(server: ClosableServer): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise<void>((r) => server.asServer.close(() => r())),
    new Promise<void>((r) => server.rsServer.close(() => r())),
  ]);
}

async function fetchJson<T = Record<string, unknown>>(
  url: string,
  opts: RequestInit = {}
): Promise<FetchJsonResult<T>> {
  const resp = await fetch(url, opts);
  const body = (await resp.json()) as T;
  return { body, status: resp.status };
}

async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
  const clientId = "cli_longview";
  const { body: device } = await fetchJson<{ device_code: string; user_code: string }>(
    `${asUrl}/oauth/device_authorization`,
    {
      body: new URLSearchParams({ client_id: clientId }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    }
  );
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const { body: tokenBody } = await fetchJson<{ access_token: string }>(`${asUrl}/oauth/token`, {
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

interface HarnessContext {
  asUrl: string;
  rsUrl: string;
  spotifyManifest: SpotifyManifest;
}

async function withHarness(fn: (ctx: HarnessContext) => Promise<void>): Promise<void> {
  const server = await typedStartServer({
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
  ) as SpotifyManifest;
  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const connectorId = canonicalManifestConnectorId(spotifyManifest);
    createSqliteConnectorInstanceStore().ensureDefaultAccountConnection({
      connectorId,
      displayName: connectorId,
      now: "2026-04-24T00:00:00.000Z",
      ownerSubjectId: "owner_local",
    });
    await fn({ asUrl, rsUrl, spotifyManifest });
  } finally {
    await closeServer(server);
  }
}

async function seedOneRun({ asUrl, rsUrl, spotifyManifest }: HarnessContext): Promise<{
  ownerToken: string;
  runResult: unknown;
}> {
  const ownerToken = await issueOwnerToken(asUrl);
  const runResult = await typedRunConnector({
    admitRunConnection: async ({ connectorId, connectorInstanceId, ownerSubjectId }) => {
      await Promise.resolve();
      const exactId = makeDefaultAccountConnectorInstanceId("owner_local", connectorId);
      assert.ok(connectorInstanceId === null || connectorInstanceId === exactId);
      assert.equal(ownerSubjectId, "owner_local");
      return { connectorId, connectorInstanceId: exactId, ownerSubjectId: "owner_local" };
    },
    collectionMode: "full_refresh",
    connectorId: spotifyManifest.connector_id,
    connectorPath: join(REFERENCE_IMPL_DIR, "connectors/seed/index.ts"),
    manifest: spotifyManifest,
    ownerSubjectId: "owner_local",
    ownerToken,
    rsUrl,
    state: null,
  });
  return { ownerToken, runResult };
}

function canonicalManifestConnectorId(manifest: SpotifyManifest): string {
  return canonicalConnectorKey(manifest.connector_id) ?? manifest.connector_id;
}

interface ListBody<T> {
  data: T[];
  has_more?: boolean;
  next_cursor?: string | null;
  object: string;
}

interface TraceSummary {
  event_count: number;
  kinds: string[];
  object: string;
  trace_id: string;
}

interface RunSummary {
  browser_surface_lease_id?: string | null;
  browser_surface_status?: string | null;
  browser_surface_wait_reason?: string | null;
  connector_id: string;
  failure_reason: string | null;
  needs_input?: boolean;
  object: string;
  run_id: string;
  status: string;
}

interface GrantSummary {
  status: string;
}

interface TimelineEvent {
  actor_id: string;
  data: Record<string, unknown>;
  event_type: string;
}

interface TimelineBody {
  data: TimelineEvent[];
  object: string;
  run_id: string;
}

interface SearchResultBody {
  exact: { id: string; kind: string } | null;
  grants: unknown[];
  object: string;
  runs: unknown[];
  traces: { trace_id: string }[];
}

test("_ref listing helpers", async (t) => {
  await t.test("GET /_ref/traces returns paginated trace summaries", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      await seedOneRun({ asUrl, rsUrl, spotifyManifest });

      const { status, body } = await fetchJson<ListBody<TraceSummary>>(`${asUrl}/_ref/traces?limit=100`);
      assert.equal(status, 200);
      assert.equal(body.object, "list");
      assert.ok(Array.isArray(body.data));
      assert.ok(body.data.length > 0, "expected at least one trace");
      // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
      const sample = body.data[0];
      assert.ok(sample, "expected a trace summary sample");
      assert.equal(sample.object, "trace_summary");
      assert.ok(sample.trace_id.startsWith("trc_"));
      assert.ok(Array.isArray(sample.kinds));
      assert.ok(typeof sample.event_count === "number" && sample.event_count >= 1);
    });
  });

  await t.test("GET /_ref/traces honors limit and returns has_more + cursor", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      // Seed several runs so there are multiple trace artifacts.
      await seedOneRun({ asUrl, rsUrl, spotifyManifest });
      await seedOneRun({ asUrl, rsUrl, spotifyManifest });
      await seedOneRun({ asUrl, rsUrl, spotifyManifest });

      const { body: firstPage } = await fetchJson<ListBody<TraceSummary>>(`${asUrl}/_ref/traces?limit=2`);
      assert.equal(firstPage.data.length, 2);
      if (firstPage.has_more) {
        assert.ok(typeof firstPage.next_cursor === "string");
        const { body: nextPage } = await fetchJson<ListBody<TraceSummary>>(
          `${asUrl}/_ref/traces?limit=2&cursor=${encodeURIComponent(firstPage.next_cursor ?? "")}`
        );
        // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
        const firstPageSample = firstPage.data[0];
        assert.ok(firstPageSample, "expected a first-page trace summary sample");
        assert.notEqual(
          firstPageSample.trace_id,
          nextPage.data[0]?.trace_id ?? null,
          "cursor should advance past first page"
        );
      }
    });
  });

  await t.test("GET /_ref/runs returns run summaries with connector_id", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      await seedOneRun({ asUrl, rsUrl, spotifyManifest });
      const { status, body } = await fetchJson<ListBody<RunSummary>>(`${asUrl}/_ref/runs?limit=10`);
      assert.equal(status, 200);
      assert.equal(body.object, "list");
      assert.ok(body.data.length > 0);
      // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
      const run = body.data[0];
      assert.ok(run, "expected a run summary");
      assert.equal(run.object, "run_summary");
      assert.ok(run.run_id.startsWith("run_"));
      assert.equal(run.connector_id, canonicalManifestConnectorId(spotifyManifest));
    });
  });

  await t.test("GET /_ref/runs filters by connector_id", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      await seedOneRun({ asUrl, rsUrl, spotifyManifest });
      const { body } = await fetchJson<ListBody<RunSummary>>(
        `${asUrl}/_ref/runs?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`
      );
      assert.ok(body.data.length > 0);
      for (const r of body.data) {
        assert.equal(r.connector_id, canonicalManifestConnectorId(spotifyManifest));
      }

      const { body: canonical } = await fetchJson<ListBody<RunSummary>>(
        `${asUrl}/_ref/runs?connector_id=${encodeURIComponent(canonicalManifestConnectorId(spotifyManifest))}`
      );
      assert.ok(canonical.data.length > 0);

      const { body: none } = await fetchJson<ListBody<RunSummary>>(`${asUrl}/_ref/runs?connector_id=does.not.exist`);
      assert.equal(none.data.length, 0);
    });
  });

  await t.test("GET /_ref/runs filters by status", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      await seedOneRun({ asUrl, rsUrl, spotifyManifest });

      const { body: succeeded } = await fetchJson<ListBody<RunSummary>>(`${asUrl}/_ref/runs?status=succeeded`);
      for (const r of succeeded.data) {
        assert.equal(r.status, "succeeded");
      }

      const { body: failed } = await fetchJson<ListBody<RunSummary>>(`${asUrl}/_ref/runs?status=failed`);
      for (const r of failed.data) {
        assert.equal(r.status, "failed");
      }
    });
  });

  await t.test(
    "GET /_ref/runs surfaces browser-surface queued and deferred runs without connector failures",
    async () => {
      await withHarness(async ({ asUrl, spotifyManifest }) => {
        const spotifyId = canonicalManifestConnectorId(spotifyManifest);
        const source = { id: spotifyId, kind: "connector" };
        const base = {
          actor_id: spotifyId,
          actor_type: "runtime",
          object_type: "run",
          scenario_id: "scn_browser_surface_operator_status",
          source_id: spotifyId,
          source_kind: "connector",
        };
        await emitSpineEvent({
          ...base,
          data: {
            browser_surface: {
              browser_surface_lease_id: "lease_waiting",
              browser_surface_profile_key: "spotify-profile",
              browser_surface_status: "waiting_for_browser_surface",
              browser_surface_wait_reason: "capacity_full",
              pending_run_id: "run_browser_surface_waiting",
            },
            source,
          },
          event_type: "run.browser_surface_requested",
          object_id: "run_browser_surface_waiting",
          occurred_at: "2026-04-24T00:03:00.000Z",
          run_id: "run_browser_surface_waiting",
          status: "waiting_for_browser_surface",
          trace_id: "trc_browser_surface_waiting",
        });
        await emitSpineEvent({
          ...base,
          data: {
            browser_surface: {
              browser_surface_lease_id: "lease_waiting",
              browser_surface_profile_key: "spotify-profile",
              browser_surface_status: "waiting_for_browser_surface",
              browser_surface_wait_reason: "capacity_full",
              pending_run_id: "run_browser_surface_waiting",
            },
            source,
          },
          event_type: "run.browser_surface_queued",
          object_id: "run_browser_surface_waiting",
          occurred_at: "2026-04-24T00:03:01.000Z",
          run_id: "run_browser_surface_waiting",
          status: "waiting_for_browser_surface",
          trace_id: "trc_browser_surface_waiting",
        });
        await emitSpineEvent({
          ...base,
          data: {
            browser_surface: {
              browser_surface_lease_id: "lease_deferred",
              browser_surface_profile_key: "other-profile",
              browser_surface_status: "deferred",
              browser_surface_wait_reason: "incompatible_static_profile",
              pending_run_id: "run_browser_surface_deferred",
            },
            source,
          },
          event_type: "run.browser_surface_deferred",
          object_id: "run_browser_surface_deferred",
          occurred_at: "2026-04-24T00:04:00.000Z",
          run_id: "run_browser_surface_deferred",
          status: "deferred",
          trace_id: "trc_browser_surface_deferred",
        });

        const { status, body } = await fetchJson<ListBody<RunSummary>>(`${asUrl}/_ref/runs?limit=10`);
        assert.equal(status, 200);
        const waiting = body.data.find((run) => run.run_id === "run_browser_surface_waiting");
        assert.ok(waiting, "queued browser-surface run should appear in run list");
        assert.equal(waiting.status, "waiting_for_browser_surface");
        assert.equal(waiting.browser_surface_status, "waiting_for_browser_surface");
        assert.equal(waiting.browser_surface_wait_reason, "capacity_full");
        assert.equal(waiting.browser_surface_lease_id, "lease_waiting");
        assert.equal(waiting.failure_reason, null);

        const deferred = body.data.find((run) => run.run_id === "run_browser_surface_deferred");
        assert.ok(deferred, "deferred browser-surface run should appear in run list");
        assert.equal(deferred.status, "deferred");
        assert.equal(deferred.browser_surface_status, "deferred");
        assert.equal(deferred.browser_surface_wait_reason, "incompatible_static_profile");
        assert.equal(deferred.browser_surface_lease_id, "lease_deferred");
        assert.equal(deferred.failure_reason, null);

        const { body: waitingTimeline } = await fetchJson<TimelineBody>(
          `${asUrl}/_ref/runs/${encodeURIComponent("run_browser_surface_waiting")}/timeline`
        );
        assert.ok(
          !waitingTimeline.data.some((event) => event.event_type === "run.failed"),
          "queued browser-surface backpressure must not be projected as connector failure"
        );
      });
    }
  );

  await t.test("GET /_ref/runs reports pending interaction state without relying on event-kind sets", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const spotifyId = canonicalManifestConnectorId(spotifyManifest);
      const source = { connector_id: spotifyId };
      const instances = createSqliteConnectorInstanceStore();
      const instance = instances.ensureDefaultAccountConnection({
        connectorId: spotifyId,
        displayName: spotifyId,
        now: "2026-04-24T00:00:00.000Z",
        ownerSubjectId: "owner_local",
      });
      assert.ok(instance?.connectorInstanceId, "registered test connector must have a default instance");
      const secondInstance = instances.upsert({
        connectorId: spotifyId,
        connectorInstanceId: "cin_pending_interaction_second",
        createdAt: "2026-04-24T00:00:00.000Z",
        displayName: `${spotifyId} pending interaction second`,
        ownerSubjectId: "owner_local",
        sourceBinding: { kind: "test_account", label: "pending-interaction-second" },
        sourceBindingKey: "pending-interaction-second",
        sourceKind: "account",
        status: "active",
        updatedAt: "2026-04-24T00:00:00.000Z",
      });
      assert.ok(secondInstance?.connectorInstanceId, "second active synthetic run needs a distinct connection");
      const insertActiveRun = typedGetDb().prepare(
        `INSERT INTO controller_active_runs(connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at)
         VALUES(?, ?, ?, ?, ?, ?)`
      );
      insertActiveRun.run(
        instance.connectorInstanceId,
        instance.connectorId,
        "run_pending_input",
        "trc_pending_interaction_test",
        "scn_pending_interaction_test",
        "2026-04-24T00:00:00.000Z"
      );
      insertActiveRun.run(
        secondInstance.connectorInstanceId,
        secondInstance.connectorId,
        "run_second_input",
        "trc_pending_interaction_test",
        "scn_pending_interaction_test",
        "2026-04-24T00:02:00.000Z"
      );
      // Spine-layer stamping requirement: every run.started must carry
      // boot_epoch+seq. Harness ran startServer which initialized the
      // singleton; read it once and merge into every synthetic emit.
      const { getCurrentBootEpoch } = await import("../lib/spine.ts");
      const _epoch = getCurrentBootEpoch();
      const runStartedStamp = _epoch
        ? {
            boot_epoch: _epoch.boot_epoch,
            controller_id: _epoch.controller_id,
            seq: _epoch.seq,
          }
        : { boot_epoch: "synthetic", controller_id: "synthetic", seq: 1 };
      const base = {
        actor_id: spotifyId,
        actor_type: "runtime",
        object_type: "run",
        scenario_id: "scn_pending_interaction_test",
        trace_id: "trc_pending_interaction_test",
      };

      await emitSpineEvent({
        ...base,
        data: { connector_instance_id: instance.connectorInstanceId, source, ...runStartedStamp },
        event_type: "run.started",
        object_id: "run_pending_input",
        occurred_at: "2026-04-24T00:00:00.000Z",
        run_id: "run_pending_input",
        status: "started",
      });
      await emitSpineEvent({
        ...base,
        data: { kind: "otp", message: "enter code", source },
        event_type: "run.interaction_required",
        interaction_id: "int_first",
        object_id: "run_pending_input",
        occurred_at: "2026-04-24T00:00:01.000Z",
        run_id: "run_pending_input",
        status: "started",
      });
      await emitSpineEvent({
        ...base,
        data: { connector_instance_id: instance.connectorInstanceId, source, ...runStartedStamp },
        event_type: "run.started",
        object_id: "run_terminal_stale_input",
        occurred_at: "2026-04-24T00:01:00.000Z",
        run_id: "run_terminal_stale_input",
        status: "started",
      });
      await emitSpineEvent({
        ...base,
        data: { kind: "manual_action", message: "manual step", source },
        event_type: "run.interaction_required",
        interaction_id: "int_stale",
        object_id: "run_terminal_stale_input",
        occurred_at: "2026-04-24T00:01:01.000Z",
        run_id: "run_terminal_stale_input",
        status: "started",
      });
      await emitSpineEvent({
        ...base,
        data: { reason: "runtime_error", source },
        event_type: "run.failed",
        object_id: "run_terminal_stale_input",
        occurred_at: "2026-04-24T00:01:02.000Z",
        run_id: "run_terminal_stale_input",
        status: "failed",
      });
      await emitSpineEvent({
        ...base,
        data: { connector_instance_id: secondInstance.connectorInstanceId, source, ...runStartedStamp },
        event_type: "run.started",
        object_id: "run_second_input",
        occurred_at: "2026-04-24T00:02:00.000Z",
        run_id: "run_second_input",
        status: "started",
      });
      await emitSpineEvent({
        ...base,
        data: { kind: "credentials", message: "credentials", source },
        event_type: "run.interaction_required",
        interaction_id: "int_old",
        object_id: "run_second_input",
        occurred_at: "2026-04-24T00:02:01.000Z",
        run_id: "run_second_input",
        status: "started",
      });
      await emitSpineEvent({
        ...base,
        data: { source, status: "success" },
        event_type: "run.interaction_completed",
        interaction_id: "int_old",
        object_id: "run_second_input",
        occurred_at: "2026-04-24T00:02:02.000Z",
        run_id: "run_second_input",
        status: "success",
      });
      await emitSpineEvent({
        ...base,
        data: { kind: "otp", message: "new code", source },
        event_type: "run.interaction_required",
        interaction_id: "int_new",
        object_id: "run_second_input",
        occurred_at: "2026-04-24T00:02:03.000Z",
        run_id: "run_second_input",
        status: "started",
      });

      const { body } = await fetchJson<ListBody<RunSummary>>(`${asUrl}/_ref/runs?limit=50&q=run_`);
      const byId = new Map(body.data.map((run) => [run.run_id, run]));

      assert.equal(byId.get("run_pending_input")?.needs_input, true);
      assert.equal(byId.get("run_terminal_stale_input")?.needs_input, false);
      assert.equal(byId.get("run_second_input")?.needs_input, true);
    });
  });

  await t.test("GET /_ref/search finds exact trace id for deep-linking", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      await seedOneRun({ asUrl, rsUrl, spotifyManifest });
      const { body: tracesList } = await fetchJson<ListBody<TraceSummary>>(`${asUrl}/_ref/traces?limit=1`);
      // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
      const tracesListSample = tracesList.data[0];
      assert.ok(tracesListSample, "expected a trace summary sample");
      const traceId = tracesListSample.trace_id;

      const { body: search } = await fetchJson<SearchResultBody>(
        `${asUrl}/_ref/search?q=${encodeURIComponent(traceId)}`
      );
      assert.equal(search.object, "search_result");
      assert.deepEqual(search.exact, { id: traceId, kind: "trace" });
      // biome-ignore lint/suspicious/noShadow: localized test assertion preserves its explicit contract.
      assert.ok(search.traces.some((t) => t.trace_id === traceId));
    });
  });

  await t.test("GET /_ref/search finds exact run id", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      await seedOneRun({ asUrl, rsUrl, spotifyManifest });
      const { body: runsList } = await fetchJson<ListBody<RunSummary>>(`${asUrl}/_ref/runs?limit=1`);
      assert.ok(runsList.data.length > 0);
      // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
      const runsListSample = runsList.data[0];
      assert.ok(runsListSample, "expected a run summary sample");
      const runId = runsListSample.run_id;

      const { body: search } = await fetchJson<SearchResultBody>(`${asUrl}/_ref/search?q=${encodeURIComponent(runId)}`);
      assert.deepEqual(search.exact, { id: runId, kind: "run" });
    });
  });

  await t.test("GET /_ref/search with empty query returns empty result without error", async () => {
    await withHarness(async ({ asUrl }) => {
      const { status, body } = await fetchJson<SearchResultBody>(`${asUrl}/_ref/search?q=`);
      assert.equal(status, 200);
      assert.equal(body.object, "search_result");
      assert.equal(body.exact, null);
      assert.deepEqual(body.traces, []);
      assert.deepEqual(body.grants, []);
      assert.deepEqual(body.runs, []);
    });
  });

  await t.test("GET /_ref/grants summarizes status as grant lifecycle (issued), not raw event status", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      // A run doesn't create grants; register a client + go through PAR/consent
      // is heavy for this coverage. Use the seeded client set instead: seed
      // records then do an owner device flow (issues a grant).
      await issueOwnerToken(asUrl);
      await seedOneRun({ asUrl, rsUrl, spotifyManifest });

      const { body } = await fetchJson<ListBody<GrantSummary>>(`${asUrl}/_ref/grants?limit=50`);
      for (const g of body.data) {
        // Status must be one of the lifecycle states, not `succeeded` or other
        // raw event statuses that leak through without lifecycle derivation.
        assert.ok(
          ["issued", "revoked", "denied", "failed", "pending"].includes(g.status),
          `expected grant lifecycle status, got ${g.status}`
        );
      }
    });
  });

  await t.test("operator journey: list run → pivot to timeline preserves correlation", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      await seedOneRun({ asUrl, rsUrl, spotifyManifest });
      const { body: runs } = await fetchJson<ListBody<RunSummary>>(`${asUrl}/_ref/runs?limit=1`);
      assert.ok(runs.data.length > 0);
      // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
      const runsSample = runs.data[0];
      assert.ok(runsSample, "expected a run summary sample");
      const runId = runsSample.run_id;

      const { status, body: timeline } = await fetchJson<TimelineBody>(
        `${asUrl}/_ref/runs/${encodeURIComponent(runId)}/timeline`
      );
      assert.equal(status, 200);
      assert.equal(timeline.object, "run_timeline");
      assert.equal(timeline.run_id, runId);
      assert.ok(timeline.data.length > 0);
      const startedEvent = timeline.data.find((e) => e.event_type === "run.started");
      assert.ok(startedEvent);
      // actor_id on runtime events is the canonical connector key, which the run list should report.
      assert.equal(startedEvent.actor_id, canonicalManifestConnectorId(spotifyManifest));
    });
  });
});

interface TopConnectorSummary {
  connector_id: string;
  record_count: number;
}

interface DatasetSummaryBody {
  blob_bytes: number;
  connector_count: number;
  earliest_ingested_at: string | null;
  earliest_record_time: string | null;
  latest_ingested_at: string | null;
  latest_record_time: string | null;
  object: string;
  projection: { state: string };
  record_changes_json_bytes: number;
  record_count: number;
  record_json_bytes: number;
  stream_count: number;
  top_connectors: TopConnectorSummary[];
  total_retained_bytes: number;
}

interface ReconcileBody {
  object: string;
  reconciled: number;
  residual: number;
  summary: DatasetSummaryBody;
}

test("_ref dataset summary", async (t) => {
  async function rebuildDatasetSummary(asUrl: string): Promise<unknown> {
    const resp = await fetch(`${asUrl}/_ref/dataset/summary/rebuild`, {
      method: "POST",
    });
    assert.equal(resp.status, 200);
    return resp.json();
  }

  await t.test("empty instance returns zeros, null timestamps, and empty top_connectors", async () => {
    await withHarness(async ({ asUrl }) => {
      const resp = await fetch(`${asUrl}/_ref/dataset/summary`);
      const body = (await resp.json()) as DatasetSummaryBody;
      assert.equal(resp.status, 200);
      assert.equal(body.object, "dataset_summary");
      assert.equal(body.connector_count, 0);
      assert.equal(body.stream_count, 0);
      assert.equal(body.record_count, 0);
      assert.equal(body.record_json_bytes, 0);
      assert.equal(body.record_changes_json_bytes, 0);
      assert.equal(body.blob_bytes, 0);
      assert.equal(body.total_retained_bytes, 0);
      assert.equal(body.earliest_record_time, null);
      assert.equal(body.latest_record_time, null);
      assert.equal(body.earliest_ingested_at, null);
      assert.equal(body.latest_ingested_at, null);
      assert.deepEqual(body.top_connectors, []);
      assert.equal(body.projection.state, "rebuilding");
    });
  });

  await t.test("populated instance reports honest aggregates across connectors and streams", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      // Seed records directly via ingestRecord so the test does not depend on
      // the full Collection-Profile runtime; the dataset summary reads raw
      // storage regardless of ingestion path.
      //
      // The spotify manifest registered by withHarness declares streams
      // `top_artists` (consent_time_field: source_updated_at), `saved_tracks`
      // (saved_at), and `recently_played` (played_at). Seed records matching
      // those streams with real-world timestamps so the dataset summary's
      // `consent_time_field`-driven bounds exercise the live manifest.
      // Records are stored under the canonical connector key (Decision 1), the
      // same key the connector catalog row is registered under, so the dataset
      // summary's manifest join (consent_time_field bounds) and the
      // top_connectors projection correlate. ingestRecord is the low-level
      // store called directly here, bypassing the route that would otherwise
      // canonicalize a URL-shaped id, so seed under the canonical key.
      const spotifyId = canonicalConnectorKey(spotifyManifest.connector_id) ?? spotifyManifest.connector_id;
      await typedIngestRecord(spotifyId, {
        data: { id: "track_1", name: "Alpha", saved_at: "2023-01-01T00:00:00.000Z" },
        emitted_at: "2026-04-20T00:00:00.000Z",
        key: "track_1",
        stream: "saved_tracks",
      });
      await typedIngestRecord(spotifyId, {
        data: { id: "track_2", name: "Bravo", saved_at: "2024-06-15T12:00:00.000Z" },
        emitted_at: "2026-04-20T00:00:00.000Z",
        key: "track_2",
        stream: "saved_tracks",
      });
      await typedIngestRecord(spotifyId, {
        data: { id: "play_1", played_at: "2022-07-03T09:15:00.000Z", track_id: "track_1" },
        emitted_at: "2026-04-20T00:00:00.000Z",
        key: "play_1",
        stream: "recently_played",
      });
      // Non-temporal stream (top_artists records without source_updated_at
      // are still valid; consent_time_field MIN/MAX will just see NULLs).
      await typedIngestRecord(spotifyId, {
        data: { id: "artist_1", name: "X", source_updated_at: "2025-03-10T18:00:00.000Z" },
        emitted_at: "2026-04-20T00:00:00.000Z",
        key: "artist_1",
        stream: "top_artists",
      });

      // Seed a blob directly so blob_bytes is exercised.
      typedGetDb()
        .prepare(`
        INSERT INTO blobs(blob_id, connector_id, connector_instance_id, stream, record_key, mime_type, size_bytes, sha256, data)
        VALUES ('blob_test_1', ?, (SELECT connector_instance_id FROM records WHERE connector_id = ? LIMIT 1), 'covers', 'cover_1', 'image/png', 2048, 'deadbeef', NULL)
      `)
        .run(spotifyId, spotifyId);

      await rebuildDatasetSummary(asUrl);
      const resp = await fetch(`${asUrl}/_ref/dataset/summary`);
      const body = (await resp.json()) as DatasetSummaryBody;
      assert.equal(resp.status, 200);
      assert.equal(body.object, "dataset_summary");
      assert.equal(body.connector_count, 1, "one configured connection with live records");
      assert.equal(body.stream_count, 3, "distinct connection/stream pairs with live records");
      assert.equal(body.record_count, 4);
      assert.ok(body.record_json_bytes > 0, "record_json_bytes should be positive with seeded records");
      assert.ok(
        body.record_changes_json_bytes >= body.record_json_bytes,
        "record_changes_json_bytes should include at least one version per seeded record"
      );
      assert.equal(body.blob_bytes, 2048);
      assert.equal(
        body.total_retained_bytes,
        body.record_json_bytes + body.record_changes_json_bytes + body.blob_bytes
      );

      // Real-world bounds pulled from manifest-declared consent_time_field
      // values inside record data.
      assert.equal(
        body.earliest_record_time,
        "2022-07-03T09:15:00.000Z",
        "earliest_record_time comes from recently_played.played_at"
      );
      assert.equal(
        body.latest_record_time,
        "2025-03-10T18:00:00.000Z",
        "latest_record_time comes from top_artists.source_updated_at"
      );

      // Ingestion bounds come from the runtime-set emitted_at column and are
      // always reported, independent of consent_time_field presence.
      assert.equal(body.earliest_ingested_at, "2026-04-20T00:00:00.000Z");
      assert.equal(body.latest_ingested_at, "2026-04-20T00:00:00.000Z");

      // top_connectors is sorted by record_count desc.
      assert.equal(body.top_connectors.length, 1);
      // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
      const topConnector = body.top_connectors[0];
      assert.ok(topConnector, "expected a top_connectors entry");
      assert.equal(topConnector.connector_id, spotifyId);
      assert.equal(topConnector.record_count, 4);
    });
  });

  await t.test("soft-deleted records are excluded from counts, bytes, and timestamp bounds", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      // Seed under the canonical connector key — see the populated-instance
      // test above for why ingestRecord must match the catalog's canonical key.
      const spotifyId = canonicalConnectorKey(spotifyManifest.connector_id) ?? spotifyManifest.connector_id;
      await typedIngestRecord(spotifyId, {
        data: { id: "track_live", name: "Live", saved_at: "2024-01-01T00:00:00.000Z" },
        emitted_at: "2026-04-20T00:00:00.000Z",
        key: "track_live",
        stream: "saved_tracks",
      });
      await typedIngestRecord(spotifyId, {
        data: { id: "track_tombstoned", name: "Tombstoned", saved_at: "2099-12-31T23:59:59.000Z" },
        emitted_at: "2026-04-20T00:00:00.000Z",
        key: "track_tombstoned",
        stream: "saved_tracks",
      });
      await typedIngestRecord(spotifyId, {
        data: { id: "track_tombstoned" },
        emitted_at: "2026-04-20T00:00:00.000Z",
        key: "track_tombstoned",
        op: "delete",
        stream: "saved_tracks",
      });

      await rebuildDatasetSummary(asUrl);
      const resp = await fetch(`${asUrl}/_ref/dataset/summary`);
      const body = (await resp.json()) as DatasetSummaryBody;
      assert.equal(body.record_count, 1, "soft-deleted rows must not count");
      assert.equal(
        body.latest_record_time,
        "2024-01-01T00:00:00.000Z",
        "tombstoned row must not shift latest_record_time"
      );
    });
  });

  await t.test("streams without consent_time_field do not contribute to record-time bounds", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const spotifyId = canonicalManifestConnectorId(spotifyManifest);
      // `tracks` is NOT a spotify manifest stream. Records seeded into it have
      // no manifest-declared consent_time_field, so they MUST NOT contribute
      // to earliest/latest_record_time even if data contains a timestamp-ish
      // property.
      await typedIngestRecord(spotifyId, {
        data: { id: "track_unmanifested", saved_at: "1999-01-01T00:00:00.000Z" },
        emitted_at: "2026-04-20T00:00:00.000Z",
        key: "track_unmanifested",
        stream: "tracks",
      });

      await rebuildDatasetSummary(asUrl);
      const resp = await fetch(`${asUrl}/_ref/dataset/summary`);
      const body = (await resp.json()) as DatasetSummaryBody;
      assert.equal(body.record_count, 1);
      assert.equal(
        body.earliest_record_time,
        null,
        "unmanifested stream data MUST NOT be mined for record-time bounds"
      );
      assert.equal(body.latest_record_time, null);
      assert.equal(
        body.earliest_ingested_at,
        "2026-04-20T00:00:00.000Z",
        "ingestion bounds are still reported for unmanifested streams"
      );
    });
  });

  await t.test(
    "record history is counted separately from live payload and folded into total_retained_bytes",
    async () => {
      await withHarness(async ({ asUrl, spotifyManifest }) => {
        const spotifyId = canonicalManifestConnectorId(spotifyManifest);
        // Three versions of the same record — one live row, two prior versions
        // in record_changes. The live payload counts once under
        // record_json_bytes; every version (including the live one) is mirrored
        // into record_changes and counts under record_changes_json_bytes.
        await typedIngestRecord(spotifyId, {
          data: { extra: "x".repeat(100), id: "track_versioned", name: "v1" },
          emitted_at: "2024-01-01T00:00:00.000Z",
          key: "track_versioned",
          stream: "tracks",
        });
        await typedIngestRecord(spotifyId, {
          data: { extra: "x".repeat(100), id: "track_versioned", name: "v2" },
          emitted_at: "2024-01-02T00:00:00.000Z",
          key: "track_versioned",
          stream: "tracks",
        });
        await typedIngestRecord(spotifyId, {
          data: { extra: "x".repeat(100), id: "track_versioned", name: "v3" },
          emitted_at: "2024-01-03T00:00:00.000Z",
          key: "track_versioned",
          stream: "tracks",
        });

        await rebuildDatasetSummary(asUrl);
        const resp = await fetch(`${asUrl}/_ref/dataset/summary`);
        const body = (await resp.json()) as DatasetSummaryBody;
        assert.equal(body.record_count, 1, "still one live record after three versions");
        assert.ok(
          body.record_changes_json_bytes > body.record_json_bytes,
          "three retained versions must exceed one live-payload size"
        );
        assert.equal(
          body.total_retained_bytes,
          body.record_json_bytes + body.record_changes_json_bytes + body.blob_bytes,
          "total_retained_bytes must sum the three labeled concepts"
        );
      });
    }
  );

  await t.test("response carries Request-Id correlation header for log cross-reference", async () => {
    await withHarness(async ({ asUrl }) => {
      const resp = await fetch(`${asUrl}/_ref/dataset/summary`);
      assert.equal(resp.status, 200);
      const requestId = resp.headers.get("request-id");
      assert.ok(requestId, "Request-Id header must be present on _ref responses");
    });
  });

  await t.test("reconcile route exposes residual dirty work for follow-up passes", async () => {
    await withHarness(async ({ asUrl }) => {
      await rebuildDatasetSummary(asUrl);
      const insert = typedGetDb().prepare(
        `INSERT INTO dataset_summary_stream_projection(
           connector_id,
           stream,
           record_count,
           record_json_bytes,
           consent_time_field,
           dirty_record_time_bounds,
           computed_at
         )
         VALUES(?, ?, 1, 1, 'created_at', 1, '2026-01-01T00:00:00.000Z')`
      );
      for (let i = 0; i < 260; i += 1) {
        insert.run("gmail", `route-stream-${String(i).padStart(4, "0")}`);
      }

      const { status, body } = await fetchJson<ReconcileBody>(`${asUrl}/_ref/dataset/summary/reconcile`, {
        method: "POST",
      });

      assert.equal(status, 200);
      assert.equal(body.object, "dataset_summary_reconcile");
      assert.equal(body.reconciled, 256);
      assert.equal(body.residual, 1);
      assert.equal(body.summary.projection.state, "stale");
    });
  });
});
