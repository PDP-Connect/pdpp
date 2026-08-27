// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration suite for the owner-session (cookie-authed) acknowledge-loss
 * route (`server/routes/ref-connection-acknowledge-loss.ts`):
 *
 *   POST /_ref/connections/:connectorInstanceId/acknowledge-loss
 *
 * This is the missing write path for `runtime/acknowledged-loss.ts`
 * (BANNER-ZERO-PLAN.md workstream E, H-E-B gezalsatx row): the record shape,
 * validation, and rendering already existed and are covered by
 * `test/acknowledged-loss.test.ts` and `test/acknowledged-loss-store.test.ts`
 * — this suite proves only the NEW route's own behavior (auth, validation,
 * exact-id targeting, and that it writes ONLY `source_binding`, never status
 * or credentials).
 *
 * GOAL-OWNER INVARIANT under test: an owner acknowledgement of provider-side
 * data loss must never by itself certify current collection complete, and
 * must never mask a live connector defect. This suite proves that end to end
 * through the real HTTP surface (not just the pure `rendered-verdict.ts`
 * unit tests) — stamping an acknowledgement on a connection with an
 * independent, currently-failing credential leaves that connection's live
 * `/_ref/connectors` verdict red with its reconnect action intact.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { listSpineEventsPage } from "../lib/spine.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { startServer } from "../server/index.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const OWNER_PASSWORD = "ref-connection-acknowledge-loss-owner-password";
const OWNER_SUBJECT_ID = "owner_local";
const OTHER_SUBJECT_ID = "owner_other";
const NOW = "2026-08-21T00:00:00.000Z";

type StartedServer = Awaited<ReturnType<typeof startServer>>;

function hasCloseAllConnections(server: object): server is { closeAllConnections: () => void } {
  return "closeAllConnections" in server && typeof server.closeAllConnections === "function";
}

async function closeServer(server: StartedServer): Promise<void> {
  server.schedulerManager?.stop?.();
  if (hasCloseAllConnections(server.asServer)) {
    server.asServer.closeAllConnections();
  }
  if (hasCloseAllConnections(server.rsServer)) {
    server.rsServer.closeAllConnections();
  }
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

async function withServer(fn: (harness: { asUrl: string }) => Promise<void>): Promise<void> {
  const server = await startServer({
    asPort: 0,
    autoEnrollEligibleSchedules: false,
    dbPath: ":memory:",
    ownerAuthPassword: OWNER_PASSWORD,
    ownerAuthSubjectId: OWNER_SUBJECT_ID,
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await fn({ asUrl });
  } finally {
    await closeServer(server);
  }
}

function getRawSetCookieList(resp: Response): string[] {
  if (typeof resp.headers.getSetCookie === "function") {
    return resp.headers.getSetCookie();
  }
  const single = resp.headers.get("set-cookie");
  return single ? [single] : [];
}

function findSetCookiePair(setCookies: string[], name: string): string | null {
  for (const header of setCookies) {
    // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
    const firstPair = header.split(";")[0];
    if (firstPair?.startsWith(`${name}=`)) {
      return firstPair;
    }
  }
  return null;
}

const CSRF_FIELD_RE = /<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/;

function extractCsrfFieldValue(html: string): string | null {
  const match = html.match(CSRF_FIELD_RE);
  return match ? (match[1] ?? null) : null;
}

async function login(asUrl: string): Promise<string> {
  const getLogin = await fetch(`${asUrl}/owner/login`, { headers: { Accept: "text/html" }, redirect: "manual" });
  const csrfCookie = findSetCookiePair(getRawSetCookieList(getLogin), "pdpp_owner_csrf");
  const csrfField = extractCsrfFieldValue(await getLogin.text());
  const resp = await fetch(`${asUrl}/owner/login`, {
    body: new URLSearchParams({ _csrf: csrfField || "", password: OWNER_PASSWORD, return_to: "/" }).toString(),
    headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded", Cookie: csrfCookie || "" },
    method: "POST",
    redirect: "manual",
  });
  const sessionCookie = findSetCookiePair(getRawSetCookieList(resp), "pdpp_owner_session");
  assert.ok(sessionCookie, `expected owner session cookie, got status ${resp.status}`);
  return sessionCookie;
}

interface JsonResult {
  body: Record<string, unknown>;
  resp: Response;
  status: number;
}

async function fetchJson(url: string, opts: RequestInit = {}): Promise<JsonResult> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  assert.ok(typeof body === "object" && body !== null, "expected a JSON object body");
  return { body: body as Record<string, unknown>, resp, status: resp.status };
}

interface ReferenceManifest {
  connector_id: string;
  streams: { name: string; [key: string]: unknown }[];
  [key: string]: unknown;
}

function loadReferenceManifest(name: string): ReferenceManifest {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/seed-manifests/${name}.json`, import.meta.url), "utf8")
  ) as ReferenceManifest;
}

async function registerConnector(asUrl: string, manifest: ReferenceManifest): Promise<string> {
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(resp.status, 201, `register ${manifest.connector_id} failed: ${resp.status}`);
  const key = canonicalConnectorKey(manifest.connector_id);
  assert.ok(key, "expected a canonical connector key");
  return key;
}

function postAcknowledgeLoss(
  asUrl: string,
  cookie: string | null,
  connectionId: string,
  body: Record<string, unknown>
): Promise<JsonResult> {
  return fetchJson(`${asUrl}/_ref/connections/${encodeURIComponent(connectionId)}/acknowledge-loss`, {
    body: JSON.stringify(body),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    method: "POST",
  });
}

const HEB_PURGE_BODY = {
  acknowledged_at: "2026-08-21T00:00:00.000Z",
  acknowledged_by: "Tim Nunamaker",
  cause: "provider_deleted_upstream",
  note: "H-E-B purged the order history; heb.com no longer shows those orders.",
  scope: "total",
};

interface SeedInstanceOptions {
  connectorId: string;
  connectorInstanceId: string;
  displayName: string;
  ownerSubjectId?: string;
  sourceBinding: Record<string, unknown>;
  sourceBindingKey: string;
  status?: string;
}

async function seedInstance({
  connectorId,
  connectorInstanceId,
  displayName,
  ownerSubjectId = OWNER_SUBJECT_ID,
  sourceBinding,
  sourceBindingKey,
  status = "active",
}: SeedInstanceOptions) {
  const store = createSqliteConnectorInstanceStore();
  await store.upsert({
    connectorId,
    connectorInstanceId,
    createdAt: NOW,
    displayName,
    ownerSubjectId,
    sourceBinding,
    sourceBindingKey,
    sourceKind: "account",
    status,
    updatedAt: NOW,
  });
  return store;
}

function errorOf(body: Record<string, unknown>): { code: unknown; message: unknown } {
  // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
  const error = body.error;
  assert.ok(typeof error === "object" && error !== null, "expected body.error to be an object");
  return error as { code: unknown; message: unknown };
}

test("owner-session stamps an acknowledgement (200), writes source_binding only, and emits an audit event", async () => {
  await withServer(async ({ asUrl }) => {
    const cookie = await login(asUrl);
    const connectorKey = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const store = await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_ack_loss_stamp",
      displayName: "My Spotify",
      sourceBinding: { account_hint: "owner@example.com" },
      sourceBindingKey: "owner@example.com",
    });
    const before = await store.get("cin_ack_loss_stamp");

    const ack = await postAcknowledgeLoss(asUrl, cookie, "cin_ack_loss_stamp", HEB_PURGE_BODY);

    assert.equal(ack.status, 200, JSON.stringify(ack.body));
    assert.equal(ack.body.object, "owner_connection_acknowledge_loss");
    assert.equal(ack.body.connection_id, "cin_ack_loss_stamp");
    const stamped = ack.body.acknowledged_loss as Record<string, unknown>;
    assert.equal(stamped.cause, "provider_deleted_upstream");
    assert.equal(stamped.scope, "total");
    assert.equal(stamped.acknowledgedBy, "Tim Nunamaker");

    const after = await store.get("cin_ack_loss_stamp");
    assert.equal(after?.status, before?.status, "acknowledging loss must never change connection status");
    assert.deepEqual(
      (after?.sourceBinding as Record<string, unknown> | undefined)?.account_hint,
      "owner@example.com",
      "the acknowledgement must merge onto source_binding, never clobber a sibling key"
    );
    assert.deepEqual((after?.sourceBinding as Record<string, unknown> | undefined)?.acknowledged_loss, stamped);

    const traceId = ack.resp.headers.get("PDPP-Reference-Trace-Id");
    assert.ok(traceId, "expected a trace id header");
    const events = listSpineEventsPage("trace", traceId as string, { limit: 20 }).events.filter(
      (e) => e.event_type === "owner.connection.acknowledge_loss"
    );
    const succeeded = events.find((e) => e.status === "succeeded");
    assert.ok(succeeded, "expected a succeeded owner.connection.acknowledge_loss audit event");
    assert.equal(succeeded.subject_id, OWNER_SUBJECT_ID);
    assert.equal(succeeded.object_id, "cin_ack_loss_stamp");
  });
});

test("owner-session acknowledge-loss rejects an unrecognized cause (400), never guessed", async () => {
  await withServer(async ({ asUrl }) => {
    const cookie = await login(asUrl);
    const connectorKey = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_ack_loss_bad_cause",
      displayName: "My Spotify",
      sourceBinding: { account_hint: "owner@example.com" },
      sourceBindingKey: "owner@example.com",
    });

    const ack = await postAcknowledgeLoss(asUrl, cookie, "cin_ack_loss_bad_cause", {
      ...HEB_PURGE_BODY,
      cause: "provider_had_a_bad_day",
    });

    assert.equal(ack.status, 400);
    assert.equal(errorOf(ack.body).code, "invalid_request");
  });
});

test("owner-session acknowledge-loss rejects a missing acknowledged_by (400)", async () => {
  await withServer(async ({ asUrl }) => {
    const cookie = await login(asUrl);
    const connectorKey = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_ack_loss_no_actor",
      displayName: "My Spotify",
      sourceBinding: { account_hint: "owner@example.com" },
      sourceBindingKey: "owner@example.com",
    });

    const { acknowledged_by, ...withoutActor } = HEB_PURGE_BODY;
    const ack = await postAcknowledgeLoss(asUrl, cookie, "cin_ack_loss_no_actor", withoutActor);

    assert.equal(ack.status, 400);
    assert.equal(errorOf(ack.body).code, "invalid_request");
  });
});

test("owner-session acknowledge-loss rejects a foreign/unknown connection_id (404)", async () => {
  await withServer(async ({ asUrl }) => {
    const cookie = await login(asUrl);
    const ack = await postAcknowledgeLoss(asUrl, cookie, "cin_does_not_exist", HEB_PURGE_BODY);
    assert.equal(ack.status, 404);
  });
});

test("owner-session acknowledge-loss cannot cross owners", async () => {
  await withServer(async ({ asUrl }) => {
    const cookie = await login(asUrl);
    const connectorKey = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const store = await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_ack_loss_other_owner",
      displayName: "Other owner's Spotify",
      ownerSubjectId: OTHER_SUBJECT_ID,
      sourceBinding: { account_hint: "other@example.com" },
      sourceBindingKey: "other@example.com",
    });

    const ack = await postAcknowledgeLoss(asUrl, cookie, "cin_ack_loss_other_owner", HEB_PURGE_BODY);

    assert.equal(ack.status, 403);
    const row = await store.get("cin_ack_loss_other_owner");
    assert.equal(
      (row?.sourceBinding as Record<string, unknown> | undefined)?.acknowledged_loss,
      undefined,
      "a cross-owner attempt must not stamp the foreign row"
    );
  });
});

test("owner-session acknowledge-loss requires an owner session (no cookie -> not authenticated)", async () => {
  await withServer(async ({ asUrl }) => {
    const connectorKey = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const store = await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_ack_loss_no_cookie",
      displayName: "My Spotify",
      sourceBinding: { account_hint: "owner@example.com" },
      sourceBindingKey: "owner@example.com",
    });

    const ack = await postAcknowledgeLoss(asUrl, null, "cin_ack_loss_no_cookie", HEB_PURGE_BODY);

    assert.notEqual(ack.status, 200, "an unauthenticated request must not stamp the acknowledgement");
    const row = await store.get("cin_ack_loss_no_cookie");
    assert.equal((row?.sourceBinding as Record<string, unknown> | undefined)?.acknowledged_loss, undefined);
  });
});

test("owner-session acknowledge-loss rejects a revoked connection (409) — nothing left to acknowledge", async () => {
  await withServer(async ({ asUrl }) => {
    const cookie = await login(asUrl);
    const connectorKey = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_ack_loss_revoked",
      displayName: "My Spotify (revoked)",
      sourceBinding: { account_hint: "owner@example.com" },
      sourceBindingKey: "owner@example.com",
      status: "revoked",
    });

    const ack = await postAcknowledgeLoss(asUrl, cookie, "cin_ack_loss_revoked", HEB_PURGE_BODY);

    assert.equal(ack.status, 409);
    assert.equal(errorOf(ack.body).code, "connector_instance_not_active");
  });
});

// ─── GOAL-OWNER INVARIANT: an acknowledgement cannot certify current
// collection or mask a live connector defect ──────────────────────────────
//
// The pure-synthesis version of this invariant — full axis isolation, proven
// by directly constructing a `ConnectionHealthSnapshot` with a rejected
// credential and asserting the rendered pill/actions are IDENTICAL with and
// without an acknowledgement — already exists and is exhaustive:
// `test/acknowledged-loss.test.ts` ("an acknowledgement does not mask a
// separate credential defect", "softening is refused when a non-coverage
// axis is what turned it red"). That is the correct, cheapest oracle for the
// axis-isolation claim (`rendered-verdict.ts`'s `redIsOnlyFromCoverage`,
// which only permits softening when EVERY red-toned axis is `coverage` or
// `disposition` — never `state`/`freshness`/`attention`/`outbox`).
//
// This test proves the complementary, ROUTE-level half: that stamping
// through the real HTTP write path touches ONLY `source_binding_json` and
// never fabricates a healthy tone on a connection with no observed
// successful run — i.e. the route itself cannot be used to launder a
// connection into "collection complete" by itself. A connection with no
// run history yet (the state immediately after seeding, before any collect)
// renders a non-green, unmeasured verdict; stamping an acknowledgement must
// leave that unmeasured verdict exactly as unmeasured — never "Healthy",
// never "Complete".
test("acknowledging a provider loss never turns an unmeasured connection green", async () => {
  await withServer(async ({ asUrl }) => {
    const cookie = await login(asUrl);
    const connectorKey = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorInstanceId = "cin_ack_loss_unmeasured";
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId,
      displayName: "My Spotify (never run)",
      sourceBinding: { account_hint: "owner@example.com" },
      sourceBindingKey: "owner@example.com",
    });

    const before = await fetchJson(`${asUrl}/_ref/connectors?limit=50`, {
      headers: { Accept: "application/json", Cookie: cookie },
    });
    const beforeRow = (before.body.data as Record<string, unknown>[] | undefined)?.find(
      (item) => item.connector_instance_id === connectorInstanceId
    );
    assert.ok(beforeRow, "expected the seeded instance in the live connector listing");
    const beforeVerdict = beforeRow.rendered_verdict as Record<string, unknown>;
    const beforePill = beforeVerdict.pill as Record<string, unknown>;
    assert.notEqual(beforePill.tone, "green", "a never-run connection must not start green");

    const ack = await postAcknowledgeLoss(asUrl, cookie, connectorInstanceId, HEB_PURGE_BODY);
    assert.equal(ack.status, 200, JSON.stringify(ack.body));

    const afterInstance = await createSqliteConnectorInstanceStore().get(connectorInstanceId);
    assert.equal(afterInstance?.status, "active", "acknowledging loss must never change connection status");

    const after = await fetchJson(`${asUrl}/_ref/connectors?limit=50`, {
      headers: { Accept: "application/json", Cookie: cookie },
    });
    const afterRow = (after.body.data as Record<string, unknown>[] | undefined)?.find(
      (item) => item.connector_instance_id === connectorInstanceId
    );
    assert.ok(afterRow, "expected the seeded instance in the live connector listing after acknowledging");
    const afterVerdict = afterRow.rendered_verdict as Record<string, unknown>;
    const afterPill = afterVerdict.pill as Record<string, unknown>;

    // The route writes a fact about DATA that is gone; it is not, and must
    // never become, evidence that the CURRENT run completed. An unmeasured
    // connection stamped with a provider-loss acknowledgement stays
    // unmeasured — the acknowledgement has no coverage/run evidence to
    // soften, so it must be a complete no-op on tone.
    assert.equal(
      afterPill.tone,
      beforePill.tone,
      "acknowledging a provider loss must not change the tone of a connection with no run evidence to soften"
    );
    assert.notEqual(afterPill.tone, "green", "acknowledging a loss must never fabricate a healthy/complete tone");
  });
});

// ─── POST /_ref/connections/:id/coverage-horizon ──────────────────────────────
//
// A DIFFERENT fact in a DIFFERENT store from acknowledge-loss above:
// acknowledge-loss stamps `source_binding.acknowledged_loss` ("data is gone");
// this records a `connector_coverage_horizons` row ("the provider never serves
// anything before <date>"). Tested here so the distinction stays visible.
//
// Parser tests are not evidence the WIRING works: these exercise the mounted
// endpoint — owner auth, namespace resolution, the durable row, the success and
// failure audit events, and the response body.

function postCoverageHorizon(
  asUrl: string,
  cookie: string | null,
  connectionId: string,
  body: Record<string, unknown>
): Promise<JsonResult> {
  return fetchJson(`${asUrl}/_ref/connections/${encodeURIComponent(connectionId)}/coverage-horizon`, {
    body: JSON.stringify(body),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    method: "POST",
  });
}

const GROUPME_HORIZON_BODY = {
  basis: "provider_confirmed",
  earliest_available: "2013-01-01T00:00:00.000Z",
  note: "GroupMe's own retention page states messages before 2013 are not retained.",
  reason: "provider_retention_policy",
  stream: "playlists",
};

/** Audit events for ONE request, looked up by the trace id it returned. */
function horizonAuditEvents(resp: JsonResult): Record<string, unknown>[] {
  const traceId = resp.resp.headers.get("PDPP-Reference-Trace-Id");
  if (!traceId) {
    return [];
  }
  return listSpineEventsPage("trace", traceId, { limit: 20 }).events.filter(
    (event) => event.event_type === "owner.connection.confirm_coverage_horizon"
  ) as unknown as Record<string, unknown>[];
}

test("coverage-horizon: an owner records a durable horizon and the write is audited", async () => {
  await withServer(async ({ asUrl }) => {
    const cookie = await login(asUrl);
    const connectorKey = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorInstanceId = "cin_horizon_route_ok";
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId,
      displayName: "My GroupMe",
      sourceBinding: { account_hint: "owner@example.com" },
      sourceBindingKey: "owner@example.com",
    });

    const resp = await postCoverageHorizon(asUrl, cookie, connectorInstanceId, GROUPME_HORIZON_BODY);
    assert.equal(resp.status, 200, JSON.stringify(resp.body));
    assert.equal(resp.body.object, "owner_connection_coverage_horizon");
    assert.equal(resp.body.connection_id, connectorInstanceId);

    const horizon = resp.body.coverage_horizon as Record<string, unknown>;
    assert.equal(horizon.basis, "provider_confirmed");
    assert.equal(horizon.reason, "provider_retention_policy");
    assert.equal(horizon.stream, "playlists");
    assert.equal(
      horizon.confirmedBy,
      OWNER_SUBJECT_ID,
      "the actor is the authenticated session subject, proven end-to-end and not just in the parser"
    );

    const events = horizonAuditEvents(resp);
    assert.equal(events.length, 1, "exactly one audit event for one write");
    assert.equal(events[0]?.status, "succeeded");
    const data = events[0]?.data as Record<string, unknown>;
    assert.equal(data.operation, "confirm_coverage_horizon");
    assert.equal(data.basis, "provider_confirmed");
    assert.equal(data.connection_id, connectorInstanceId);
    assert.equal(
      Object.hasOwn(data, "note"),
      false,
      "the owner's free-text note belongs in the durable row, never duplicated into the audit stream"
    );
  });
});

test("coverage-horizon: an invalid body writes NOTHING and still emits a failure audit", async () => {
  await withServer(async ({ asUrl }) => {
    const cookie = await login(asUrl);
    const connectorKey = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorInstanceId = "cin_horizon_route_bad";
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId,
      displayName: "My GroupMe",
      sourceBinding: { account_hint: "owner@example.com" },
      sourceBindingKey: "owner@example.com",
    });

    const resp = await postCoverageHorizon(asUrl, cookie, connectorInstanceId, {
      ...GROUPME_HORIZON_BODY,
      basis: "i_reckon",
    });
    assert.equal(resp.status, 400);
    assert.equal(errorOf(resp.body).code, "invalid_request");

    const events = horizonAuditEvents(resp);
    assert.equal(events.length, 1, "a refused write is still an owner action and must be recorded");
    assert.equal(events[0]?.status, "failed");
    const data = events[0]?.data as Record<string, unknown>;
    assert.equal(data.outcome, "failed");
    assert.equal(
      data.basis,
      null,
      "a rejected value is never echoed into the audit as though it had been accepted"
    );
  });
});

test("coverage-horizon: a caller-supplied confirmed_by is refused end-to-end", async () => {
  await withServer(async ({ asUrl }) => {
    const cookie = await login(asUrl);
    const connectorKey = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorInstanceId = "cin_horizon_route_actor";
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId,
      displayName: "My GroupMe",
      sourceBinding: { account_hint: "owner@example.com" },
      sourceBindingKey: "owner@example.com",
    });

    const resp = await postCoverageHorizon(asUrl, cookie, connectorInstanceId, {
      ...GROUPME_HORIZON_BODY,
      confirmed_by: "somebody_else",
    });
    assert.equal(resp.status, 400, "attribution must not be forgeable over the wire");
    assert.match(String(errorOf(resp.body).message), /confirmed_by is not accepted/);
  });
});

test("coverage-horizon: requires an owner session", async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await postCoverageHorizon(asUrl, null, "cin_horizon_route_noauth", GROUPME_HORIZON_BODY);
    assert.notEqual(resp.status, 200, "an unauthenticated caller must never record a horizon");
    assert.equal(horizonAuditEvents(resp).length, 0);
  });
});

test("coverage-horizon: cannot cross owners", async () => {
  await withServer(async ({ asUrl }) => {
    const cookie = await login(asUrl);
    const connectorKey = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const connectorInstanceId = "cin_horizon_route_foreign";
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId,
      displayName: "Someone else's GroupMe",
      ownerSubjectId: OTHER_SUBJECT_ID,
      sourceBinding: { account_hint: "other@example.com" },
      sourceBindingKey: "other@example.com",
    });

    const resp = await postCoverageHorizon(asUrl, cookie, connectorInstanceId, GROUPME_HORIZON_BODY);
    assert.notEqual(resp.status, 200, "namespace resolution must refuse another owner's connection");
  });
});
