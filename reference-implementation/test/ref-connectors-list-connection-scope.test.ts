// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Route-wiring test for the optional connection selector on
 * `GET /_ref/connectors` (mountRefConnectorsList).
 *
 * Spec: openspec/changes/scope-ref-connectors-summary-to-one-connection/
 *       specs/reference-implementation-architecture/spec.md
 *
 * Records subpages resolve one connection from the route param. Before this
 * change they called the all-connector summary projection and filtered the
 * result in the browser, so opening one connection's records page ran the
 * per-connection fan-out for EVERY configured connection (~8N reads). With the
 * selector, the route resolves and projects only the requested connection.
 *
 * What this pins
 * --------------
 * 1. A scoped request (`?connection=<id>`) calls `getConnectorSummaryForRoute`
 *    and never reaches the bounded page capability — the records-subpage hot
 *    path no longer hydrates every connector.
 * 2. The scoped envelope is the same `{object: 'list', data}` shape with a
 *    single matching item.
 * 3. A scoped request that resolves nothing returns an empty list, not a
 *    silently-unscoped full list.
 * 4. An unscoped request with no `limit` fails explicitly (terminal-gate
 *    revision, 2026-07-29): a "complete fleet" response is inherently
 *    fleet-N, so the route no longer serves one. `limit` is required; a bare
 *    GET returns 400 `invalid_request` instead of silently scanning the
 *    fleet.
 * 5. The route itself never calls `reconcileDirtyConnectorSummaryEvidence`
 *    directly (Sol P1.2): that was a genuinely redundant, always-UNSCOPED
 *    second barrier pass ahead of a caller (`getConnectorSummaryForRoute`/
 *    the bounded page capability) that already runs its own barrier
 *    internally, scoped to the resolved connection when one is known —
 *    defeating the whole point of the connection selector's scoping.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { RefConnectorsListEnvelope, RefConnectorsListItem } from "../operations/ref-connectors-list/index.ts";
import {
  ConnectorSummaryPageRequestError,
  encodeConnectorSummaryPageCursor,
} from "../operations/ref-connectors-list/pagination.ts";

process.env.PDPP_CREDENTIAL_ENCRYPTION_KEY ??= "test connector-summary cursor key";

import type { MiddlewareHandler } from "../server/routes/_route-contract.ts";
import { type MountRefConnectorsContext, mountRefConnectorsList } from "../server/routes/ref-connectors.ts";

// AppLike requires delete/get/patch/post/put; this harness only exercises the
// GET route mountRefConnectorsList registers, so the other verbs are typed as
// unreachable no-ops rather than widening the harness's own surface. Neither
// AppLike nor its RouteRequest/RouteResponse/RouteHandler are exported from
// ref-connectors.ts, so they are rederived structurally: `app.get`'s variadic
// arg is `RouteArg<RouteHandler> = { contract?, bodyLimit? } | MiddlewareHandler |
// RouteHandler`. A plain `Extract<..., (...) => unknown>` also keeps
// MiddlewareHandler (its `...args: unknown[]` rest signature structurally
// matches any fixed-arity filter), which collapses the union's call
// parameters to `unknown` — so MiddlewareHandler is excluded explicitly to
// land on the one true two-fixed-parameter route handler.
type AppLike = Parameters<typeof mountRefConnectorsList>[0];
type RouteArgUnion = Parameters<AppLike["get"]>[2];
type RouteHandler = Exclude<Extract<RouteArgUnion, (...args: never[]) => unknown>, MiddlewareHandler>;
type RouteRequest = Parameters<RouteHandler>[0];
type RouteResponse = Parameters<RouteHandler>[1];

function summaryItem(connectorId: string, connectionId: string = connectorId): RefConnectorsListItem {
  return {
    connection_health: null,
    connection_id: connectionId,
    connector_id: connectorId,
    connector_instance_id: connectionId,
    display_name: connectorId,
    freshness: { status: "unknown" },
    last_run: null,
    last_successful_run: null,
    manifest_version: "1.0.0",
    refresh_policy: null,
    schedule: null,
    streams: [],
    total_records: 0,
  };
}

// Minimal Express-shaped harness that captures the GET handler registered by
// mountRefConnectorsList and invokes it with a query and a response recorder.
// The owner-session middleware is a no-op here; auth posture is covered
// elsewhere. The ctx spies record which projection dependency the route used.
function buildHarness({
  page = null,
  summaryForRoute,
}: {
  page?:
    | {
        readonly data: readonly RefConnectorsListItem[];
        readonly has_more: boolean;
        readonly next_cursor: string | null;
      }
    | ((request: { readonly cursor: unknown; readonly limit: number }) => {
        readonly data: readonly RefConnectorsListItem[];
        readonly has_more: boolean;
        readonly next_cursor: string | null;
      })
    | null;
  summaryForRoute: (routeId: string) => RefConnectorsListItem | null;
}) {
  const calls = {
    getConnectorSummaryForRoute: [] as string[],
    listConnectorSummaryPage: 0,
    pdppError: [] as { status: number; code: string; param: string | null | undefined }[],
    reconcileDirtyConnectorSummaryEvidence: 0,
  };
  // mountRefConnectorsList only reads the six members through the end of this
  // object literal; the rest of MountRefConnectorsContext belongs to sibling
  // routes (run/schedule/revoke/delete/etc.) this test never mounts. They are
  // still required members of the shared interface, so they get honest
  // never-called stubs rather than an `as` cast that would hide a real
  // mismatch on the six members this route actually uses.
  function unusedByThisRoute(name: string): never {
    throw new Error(`${name} is not used by mountRefConnectorsList and should not be called by this test`);
  }
  const ctx: MountRefConnectorsContext = {
    canonicalConnectorKey: () => unusedByThisRoute("canonicalConnectorKey"),
    createRequestConnectorInstanceStore: () => unusedByThisRoute("createRequestConnectorInstanceStore"),
    createTraceContext: () => unusedByThisRoute("createTraceContext"),
    deleteConnection: () => unusedByThisRoute("deleteConnection"),
    deleteSchedule: () => unusedByThisRoute("deleteSchedule"),
    emitSpineEvent: () => unusedByThisRoute("emitSpineEvent"),
    ensureRequestId: () => unusedByThisRoute("ensureRequestId"),
    getConnectorDetail: () => unusedByThisRoute("getConnectorDetail"),
    getConnectorSummaryForRoute(routeId: string) {
      calls.getConnectorSummaryForRoute.push(routeId);
      return summaryForRoute(routeId);
    },
    getFleetHealthVerdict: () => unusedByThisRoute("getFleetHealthVerdict"),
    getOwnerSubjectId: () => "owner_test",
    // Unlike the other stubs above, this route DOES call getRuntimeStatus —
    // executeRefConnectorsList reads it unconditionally to build the optional
    // `runtime` envelope field. A steady "ok" verdict keeps every test's
    // envelope shape unaffected by controller-liveness, which none of these
    // tests assert on.
    getRuntimeStatus: () => ({
      label: "ok",
      message: null,
      object: "ref_runtime_status",
      ok: true,
      reason: null,
    }),
    getSchedule: () => unusedByThisRoute("getSchedule"),
    handleError(_res: unknown, err: unknown) {
      throw err;
    },
    ...(page
      ? {
          listConnectorSummaryPage(_ownerSubjectId, request) {
            calls.listConnectorSummaryPage += 1;
            return typeof page === "function" ? page(request) : page;
          },
        }
      : {}),
    listSchedules: () => unusedByThisRoute("listSchedules"),
    pdppError(_res, status, code, _message, param) {
      calls.pdppError.push({ code, param, status });
    },
    requireOwnerSession: (_req: unknown, _res: unknown, next: unknown) =>
      typeof next === "function" ? next() : undefined,
    resolveOwnerConnectorNamespace: () => unusedByThisRoute("resolveOwnerConnectorNamespace"),
    resolveRegisteredConnectorManifest: () => unusedByThisRoute("resolveRegisteredConnectorManifest"),
    // Mirror the production helper: take the first string value, ignore arrays
    // and non-strings, and treat empty as absent.
    resolveSingleConnectorIdQueryValue(raw: unknown) {
      const value = Array.isArray(raw) ? raw[0] : raw;
      return typeof value === "string" && value.length > 0 ? value : null;
    },
    runNow: () => unusedByThisRoute("runNow"),
    setReferenceTraceId: () => unusedByThisRoute("setReferenceTraceId"),
    setScheduleEnabled: () => unusedByThisRoute("setScheduleEnabled"),
    updateConnectorInstanceStatus: () => unusedByThisRoute("updateConnectorInstanceStatus"),
    upsertSchedule: () => unusedByThisRoute("upsertSchedule"),
  };

  let handler: RouteHandler | null = null;
  const app: AppLike = {
    delete() {
      throw new Error("not exercised by this harness");
    },
    get(_path: string, ..._handlers: unknown[]) {
      handler = _handlers.at(-1) as RouteHandler;
      return app;
    },
    patch() {
      throw new Error("not exercised by this harness");
    },
    post() {
      throw new Error("not exercised by this harness");
    },
    put() {
      throw new Error("not exercised by this harness");
    },
  };
  mountRefConnectorsList(app, ctx);

  const headers = new Map<string, string>();

  return {
    calls,
    headers,
    // A refused bare GET responds only via `ctx.pdppError` (see calls.pdppError)
    // and never calls `res.json`, so `invoke` returns `null` rather than
    // asserting an envelope always exists.
    async invoke(query: Readonly<Record<string, unknown>> = {}): Promise<RefConnectorsListEnvelope | null> {
      let recorded: RefConnectorsListEnvelope | undefined;
      const res: RouteResponse = {
        end: () => unusedByThisRoute("res.end"),
        getHeader: () => unusedByThisRoute("res.getHeader"),
        json(body: unknown) {
          recorded = body as RefConnectorsListEnvelope;
          return body;
        },
        // No route path sets a response header today; kept as a permissive
        // recorder so a future header emission doesn't require touching this
        // harness.
        setHeader: (name: string, value: string) => {
          headers.set(name, value);
        },
        status: () => unusedByThisRoute("res.status"),
      };
      if (!handler) {
        throw new Error("mountRefConnectorsList must register a GET handler");
      }
      const req: RouteRequest = { params: {}, query };
      await handler(req, res);
      return recorded ?? null;
    },
  };
}

test("scoped request projects only the resolved connection and skips the bounded page capability", async () => {
  const all = [summaryItem("gmail", "conn-work"), summaryItem("github", "conn-gh")];
  const harness = buildHarness({
    summaryForRoute: (routeId) => all.find((s) => s.connection_id === routeId) ?? null,
  });

  const envelope = await harness.invoke({ connection: "conn-work" });

  // The whole point: the records-subpage hot path resolved ONE connection and
  // never reached the bounded page capability.
  assert.equal(harness.calls.listConnectorSummaryPage, 0, "scoped request must NOT reach the page capability");
  assert.equal(
    harness.calls.reconcileDirtyConnectorSummaryEvidence,
    0,
    "the route no longer owns a redundant barrier call (Sol P1.2) — getConnectorSummaryForRoute/listConnectorSummaryPage each run their own barrier internally"
  );
  assert.deepEqual(harness.calls.getConnectorSummaryForRoute, ["conn-work"]);

  assert.ok(envelope);
  assert.equal(envelope.object, "list");
  assert.equal(envelope.data.length, 1, "scoped request returns a 0-or-1 list");
  const [onlyItem] = envelope.data;
  assert.ok(onlyItem, "scoped envelope must contain the one resolved item");
  assert.equal(onlyItem.connection_id, "conn-work");
});

test("scoped request that resolves nothing returns an empty list, not the full list", async () => {
  const harness = buildHarness({
    summaryForRoute: () => null,
  });

  const envelope = await harness.invoke({ connection: "does-not-exist" });

  assert.equal(
    harness.calls.listConnectorSummaryPage,
    0,
    "an empty resolution must not fall back to the bounded page capability"
  );
  assert.equal(
    harness.calls.reconcileDirtyConnectorSummaryEvidence,
    0,
    "the route no longer owns a redundant barrier call (Sol P1.2) — getConnectorSummaryForRoute/listConnectorSummaryPage each run their own barrier internally"
  );
  // Not a full deepEqual against `{ object: 'list', data: [] }`: the real
  // MountRefConnectorsContext.getRuntimeStatus is a required (non-optional)
  // field, so a production envelope always carries `runtime` too. Assert on
  // the two fields this test is actually about instead.
  assert.ok(envelope);
  assert.equal(envelope.object, "list");
  assert.deepEqual(envelope.data, []);
});

test("unscoped request with no limit fails explicitly instead of scanning the fleet", async () => {
  const harness = buildHarness({
    summaryForRoute: () => assert.fail("a refused bare GET must not resolve a single connection"),
  });

  const envelope = await harness.invoke({});

  assert.equal(envelope, null, "a refused request never calls res.json");
  assert.equal(harness.calls.listConnectorSummaryPage, 0, "a refused request must not reach the page capability");
  assert.equal(harness.calls.getConnectorSummaryForRoute.length, 0);
  assert.deepEqual(harness.calls.pdppError, [{ code: "invalid_request", param: "limit", status: 400 }]);
});

test("empty/blank selector is treated as absent, and still requires limit like any unscoped request", async () => {
  const harness = buildHarness({
    summaryForRoute: () => assert.fail("blank selector must not resolve a single connection"),
  });

  const envelope = await harness.invoke({ connection: "" });

  assert.equal(envelope, null);
  assert.equal(harness.calls.getConnectorSummaryForRoute.length, 0);
  assert.deepEqual(harness.calls.pdppError, [{ code: "invalid_request", param: "limit", status: 400 }]);
});

test("explicit unscoped limit uses the bounded page capability and emits continuation fields", async () => {
  const all = [summaryItem("gmail", "conn-work"), summaryItem("github", "conn-gh")];
  const harness = buildHarness({
    page: { data: all.slice(0, 1), has_more: true, next_cursor: "rcs1.next" },
    summaryForRoute: () => assert.fail("unscoped page must not resolve a single connection"),
  });

  const envelope = await harness.invoke({ limit: "1" });

  assert.ok(envelope);
  assert.equal(harness.calls.listConnectorSummaryPage, 1);
  assert.equal(harness.calls.pdppError.length, 0);
  assert.deepEqual(
    envelope.data.map((item) => item.connection_id),
    ["conn-work"]
  );
  assert.equal(envelope.has_more, true);
  assert.equal(envelope.next_cursor, "rcs1.next");
});

test("explicit cursor forwards the decoded immutable boundary to the next page", async () => {
  const all = [summaryItem("gmail", "conn-work"), summaryItem("github", "conn-gh")];
  const harness = buildHarness({
    page: (request) => {
      assert.deepEqual(request.cursor, {
        connectorId: "gmail",
        connectorInstanceId: "conn-work",
        createdAt: "2026-07-29T12:00:00.000Z",
      });
      return { data: all.slice(1, 2), has_more: false, next_cursor: null };
    },
    summaryForRoute: () => assert.fail("unscoped page must not resolve a single connection"),
  });

  // Use a real issued cursor so the route decoder, scope binding, and adapter
  // are exercised together rather than merely passing a sentinel through.
  const cursor = encodeConnectorSummaryPageCursor(
    { connectorId: "gmail", connectorInstanceId: "conn-work", createdAt: "2026-07-29T12:00:00.000Z" },
    "owner_test"
  );
  const envelope = await harness.invoke({ cursor, limit: "1" });
  assert.ok(envelope);
  assert.deepEqual(
    envelope.data.map((item) => item.connection_id),
    ["conn-gh"]
  );
  assert.equal(envelope.has_more, false);
});

test("scoped connection requests remain unpaginated", async () => {
  const all = [summaryItem("gmail", "conn-work")];
  const harness = buildHarness({
    summaryForRoute: (routeId) => all.find((item) => item.connection_id === routeId) ?? null,
  });
  await assert.rejects(
    () => harness.invoke({ connection: "conn-work", limit: "1" }),
    (error) =>
      error instanceof ConnectorSummaryPageRequestError && error.code === "invalid_request" && error.param === "limit"
  );
  assert.equal(harness.calls.getConnectorSummaryForRoute.length, 0);
});
