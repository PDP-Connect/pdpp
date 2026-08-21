// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration suite for the owner-session (cookie-authed) connection-pause
 * route (`server/routes/ref-connection-pause.ts`):
 *
 *   POST /_ref/connections/:connectorInstanceId/pause
 *
 * The exact mirror of the owner-session resume route
 * (`ref-connection-resume.test.ts`): same auth adapter, same exact-id
 * targeting, opposite direction. It pauses ANY active row the owner owns,
 * regardless of `source_binding.kind` — every pause is an explicit owner act,
 * so there is no binding-kind guard to test here.
 *
 * This route shares the SAME status-flip primitive as the bearer sibling
 * (`applyPause`, exported from `owner-connection-pause.ts`) — this suite
 * proves the session route's OWN behavior (auth, exact-id targeting, status
 * gating, zero cascade), not a duplicate of the bearer suite's assertions.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { listSpineEventsPage } from "../lib/spine.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { startServer } from "../server/index.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const OWNER_PASSWORD = "ref-connection-pause-owner-password";
const OWNER_SUBJECT_ID = "owner_local";
const OTHER_SUBJECT_ID = "owner_other";
const NOW = "2026-06-10T18:00:00.000Z";

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

function postPause(asUrl: string, cookie: string, connectionId: string): Promise<JsonResult> {
  return fetchJson(`${asUrl}/_ref/connections/${encodeURIComponent(connectionId)}/pause`, {
    headers: { Accept: "application/json", Cookie: cookie },
    method: "POST",
  });
}

function postResume(asUrl: string, cookie: string, connectionId: string): Promise<JsonResult> {
  return fetchJson(`${asUrl}/_ref/connections/${encodeURIComponent(connectionId)}/resume`, {
    headers: { Accept: "application/json", Cookie: cookie },
    method: "POST",
  });
}

interface SeedInstanceOptions {
  connectorId: string;
  connectorInstanceId: string;
  displayName: string;
  ownerSubjectId?: string;
  sourceBinding: Record<string, unknown>;
  sourceBindingKey: string;
  status?: string;
}

// Defaults to `active` (the pause-able state) — the mirror of the session
// resume suite's `paused` default.
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

test("owner-session pauses an active connection (200) and emits an audit event", async () => {
  await withServer(async ({ asUrl }) => {
    const cookie = await login(asUrl);
    const connectorKey = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const store = await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_session_pause_active",
      displayName: "My Spotify",
      sourceBinding: { account_hint: "owner@example.com" },
      sourceBindingKey: "owner@example.com",
    });

    const pause = await postPause(asUrl, cookie, "cin_session_pause_active");

    assert.equal(pause.status, 200);
    assert.equal(pause.body.object, "owner_connection_pause");
    assert.equal(pause.body.connection_id, "cin_session_pause_active");
    assert.equal(pause.body.status, "paused");
    assert.ok(typeof pause.body.paused_at === "string" && (pause.body.paused_at as string).length > 0);

    const row = await store.get("cin_session_pause_active");
    assert.equal(row?.status, "paused", "the row must be paused via the session route");
    assert.equal(row?.revokedAt, null, "pause must never set revoked_at");

    const traceId = pause.resp.headers.get("PDPP-Reference-Trace-Id");
    assert.ok(traceId, "expected a trace id header");
    const events = listSpineEventsPage("trace", traceId as string, { limit: 20 }).events.filter(
      (e) => e.event_type === "owner.connection.pause"
    );
    const succeeded = events.find((e) => e.status === "succeeded");
    assert.ok(succeeded, "expected a succeeded owner.connection.pause audit event");
    assert.equal(succeeded.subject_id, OWNER_SUBJECT_ID);
    assert.equal(succeeded.object_id, "cin_session_pause_active");
  });
});

test("owner-session pause rejects an already-paused connection (409)", async () => {
  await withServer(async ({ asUrl }) => {
    const cookie = await login(asUrl);
    const connectorKey = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const store = await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_session_pause_already",
      displayName: "My Spotify (already paused)",
      sourceBinding: { account_hint: "owner@example.com" },
      sourceBindingKey: "owner@example.com",
      status: "paused",
    });

    const pause = await postPause(asUrl, cookie, "cin_session_pause_already");

    assert.equal(pause.status, 409);
    assert.equal(errorOf(pause.body).code, "connector_instance_not_active");
    const row = await store.get("cin_session_pause_already");
    assert.equal(row?.status, "paused");
  });
});

test("owner-session pause rejects a revoked connection (409), never laundering it into paused", async () => {
  await withServer(async ({ asUrl }) => {
    const cookie = await login(asUrl);
    const connectorKey = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const store = await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_session_pause_revoked",
      displayName: "My Spotify (revoked)",
      sourceBinding: { account_hint: "owner@example.com" },
      sourceBindingKey: "owner@example.com",
      status: "revoked",
    });

    const pause = await postPause(asUrl, cookie, "cin_session_pause_revoked");

    assert.equal(pause.status, 409);
    assert.equal(errorOf(pause.body).code, "connector_instance_not_active");
    // A revoked row must never become merely paused (and therefore resumable
    // without the explicit re-initiate that revoke deliberately requires).
    const row = await store.get("cin_session_pause_revoked");
    assert.equal(row?.status, "revoked");
  });
});

test("owner-session pause rejects a foreign/unknown connection_id (404)", async () => {
  await withServer(async ({ asUrl }) => {
    const cookie = await login(asUrl);
    const pause = await postPause(asUrl, cookie, "cin_does_not_exist");
    assert.equal(pause.status, 404);
  });
});

test("owner-session pause cannot cross owners", async () => {
  await withServer(async ({ asUrl }) => {
    const cookie = await login(asUrl);
    const connectorKey = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const store = await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_session_pause_other_owner",
      displayName: "Other owner's Spotify",
      ownerSubjectId: OTHER_SUBJECT_ID,
      sourceBinding: { account_hint: "other@example.com" },
      sourceBindingKey: "other@example.com",
    });

    const pause = await postPause(asUrl, cookie, "cin_session_pause_other_owner");

    // The store's namespace resolver reports a cross-owner target as
    // `connector_instance_owner_mismatch` (403), not a 404 — the row exists,
    // it just isn't this owner's. Either way, pause must not proceed.
    assert.equal(pause.status, 403);
    const row = await store.get("cin_session_pause_other_owner");
    assert.equal(row?.status, "active", "a cross-owner pause attempt must not mutate the foreign row");
  });
});

test("owner-session pause requires an owner session (no cookie -> not authenticated)", async () => {
  await withServer(async ({ asUrl }) => {
    const connectorKey = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const store = await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_session_pause_no_cookie",
      displayName: "My Spotify",
      sourceBinding: { account_hint: "owner@example.com" },
      sourceBindingKey: "owner@example.com",
    });

    const resp = await fetch(`${asUrl}/_ref/connections/cin_session_pause_no_cookie/pause`, {
      headers: { Accept: "application/json" },
      method: "POST",
    });

    assert.notEqual(resp.status, 200, "an unauthenticated request must not pause the connection");
    const row = await store.get("cin_session_pause_no_cookie");
    assert.equal(row?.status, "active", "an unauthenticated request must not mutate the row");
  });
});

// The console drives both routes from one detail page, so prove the pair
// composes over the session surface too — not just over the bearer surface.
test("owner-session pause then resume round-trips a connection back to active", async () => {
  await withServer(async ({ asUrl }) => {
    const cookie = await login(asUrl);
    const connectorKey = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const store = await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_session_round_trip",
      displayName: "My Spotify",
      sourceBinding: { account_hint: "owner@example.com" },
      sourceBindingKey: "owner@example.com",
    });

    const pause = await postPause(asUrl, cookie, "cin_session_round_trip");
    assert.equal(pause.status, 200);
    assert.equal((await store.get("cin_session_round_trip"))?.status, "paused");

    const resume = await postResume(asUrl, cookie, "cin_session_round_trip");
    assert.equal(resume.status, 200, "a connection paused from the console must be resumable from the console");
    assert.equal(resume.body.status, "active");

    const row = await store.get("cin_session_round_trip");
    assert.equal(row?.status, "active", "the round trip must land back on active");
    assert.equal(row?.revokedAt, null, "a pause/resume cycle must never touch revoked_at");
  });
});
