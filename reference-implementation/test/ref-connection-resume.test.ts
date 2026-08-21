// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration suite for the owner-session (cookie-authed) connection-resume
 * route (`server/routes/ref-connection-resume.ts`):
 *
 *   POST /_ref/connections/:connectorInstanceId/resume
 *
 * Like the bearer sibling (`owner-connection-resume.ts`), this route resumes
 * ANY paused row the owner owns, regardless of `source_binding.kind`; it
 * differs only in auth (session cookie) and in targeting exactly one
 * connectorInstanceId. An earlier revision additionally required
 * `source_binding.kind === 'historical_archive'`, because the recovered-archive
 * reconnect was the only shipped use of owner-session resume. Now that pause
 * is a first-class owner action, that guard would strand every deliberately
 * paused source, so it applies only to the IMPLICIT auto-resume hooks.
 *
 * Both routes share the SAME status-flip primitive (`applyResume`, exported
 * from `owner-connection-resume.ts`) — this suite proves the session route's
 * OWN behavior (auth, exact-id targeting, status gating), not a duplicate of
 * the bearer suite's status-flip assertions.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { listSpineEventsPage } from "../lib/spine.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { startServer } from "../server/index.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const OWNER_PASSWORD = "ref-connection-resume-owner-password";
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

async function seedInstance({
  connectorId,
  connectorInstanceId,
  displayName,
  ownerSubjectId = OWNER_SUBJECT_ID,
  sourceBinding,
  sourceBindingKey,
  status = "paused",
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

test("owner-session resumes an exact paused historical_archive connection (200)", async () => {
  await withServer(async ({ asUrl }) => {
    const cookie = await login(asUrl);
    const connectorKey = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const store = await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_session_resume_archive",
      displayName: "My Spotify (recovered)",
      sourceBinding: { kind: "historical_archive", original_connector_instance_id: "cin_session_resume_archive" },
      sourceBindingKey: "historical_archive_cin_session_resume_archive",
    });

    const resume = await postResume(asUrl, cookie, "cin_session_resume_archive");

    assert.equal(resume.status, 200);
    assert.equal(resume.body.object, "owner_connection_resume");
    assert.equal(resume.body.connection_id, "cin_session_resume_archive");
    assert.equal(resume.body.status, "active");

    const row = await store.get("cin_session_resume_archive");
    assert.equal(row?.status, "active", "the row must be resumed via the session route");

    const traceId = resume.resp.headers.get("PDPP-Reference-Trace-Id");
    assert.ok(traceId, "expected a trace id header");
    const events = listSpineEventsPage("trace", traceId as string, { limit: 20 }).events.filter(
      (e) => e.event_type === "owner.connection.resume"
    );
    const succeeded = events.find((e) => e.status === "succeeded");
    assert.ok(succeeded, "expected a succeeded owner.connection.resume audit event");
    assert.equal(succeeded.subject_id, OWNER_SUBJECT_ID);
    assert.equal(succeeded.object_id, "cin_session_resume_archive");
  });
});

// Pause is a first-class owner action, so an ordinarily-paused source (any
// source-binding kind, not just a recovered archive) MUST be resumable from
// the console. An earlier revision of this route required
// `historical_archive` and answered 409 here; that guard would strand every
// connection the owner paused deliberately.
test("owner-session resumes a paused row that is NOT historical_archive (200)", async () => {
  await withServer(async ({ asUrl }) => {
    const cookie = await login(asUrl);
    const connectorKey = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const store = await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_session_resume_wrong_kind",
      displayName: "My Spotify (paused for another reason)",
      sourceBinding: { account_hint: "someone@example.com" },
      sourceBindingKey: "someone@example.com",
    });

    const resume = await postResume(asUrl, cookie, "cin_session_resume_wrong_kind");

    assert.equal(resume.status, 200);
    assert.equal(resume.body.object, "owner_connection_resume");
    assert.equal(resume.body.status, "active");
    const row = await store.get("cin_session_resume_wrong_kind");
    assert.equal(row?.status, "active", "an ordinarily-paused row must be resumable by its owner");
  });
});

test("owner-session resume rejects a non-paused (active) historical_archive-labeled connection (409)", async () => {
  await withServer(async ({ asUrl }) => {
    const cookie = await login(asUrl);
    const connectorKey = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_session_resume_already_active",
      displayName: "My Spotify (already active)",
      sourceBinding: {
        kind: "historical_archive",
        original_connector_instance_id: "cin_session_resume_already_active",
      },
      sourceBindingKey: "historical_archive_already_active",
      status: "active",
    });

    const resume = await postResume(asUrl, cookie, "cin_session_resume_already_active");

    assert.equal(resume.status, 409);
    assert.equal(errorOf(resume.body).code, "connector_instance_not_paused");
  });
});

test("owner-session resume rejects a foreign/unknown connection_id (404)", async () => {
  await withServer(async ({ asUrl }) => {
    const cookie = await login(asUrl);
    const resume = await postResume(asUrl, cookie, "cin_does_not_exist");
    assert.equal(resume.status, 404);
  });
});

test("owner-session resume cannot cross owners (another owner's paused historical_archive row is not found)", async () => {
  await withServer(async ({ asUrl }) => {
    const cookie = await login(asUrl);
    const connectorKey = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    const store = await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_session_resume_other_owner",
      displayName: "Other owner's Spotify",
      ownerSubjectId: OTHER_SUBJECT_ID,
      sourceBinding: { kind: "historical_archive", original_connector_instance_id: "cin_session_resume_other_owner" },
      sourceBindingKey: "historical_archive_other_owner",
    });

    const resume = await postResume(asUrl, cookie, "cin_session_resume_other_owner");

    // The store's namespace resolver reports a cross-owner target as
    // `connector_instance_owner_mismatch` (403), not a 404 — the row exists,
    // it just isn't this owner's. Either way, resume must not proceed.
    assert.equal(resume.status, 403);
    const row = await store.get("cin_session_resume_other_owner");
    assert.equal(row?.status, "paused", "a cross-owner resume attempt must not mutate the foreign row");
  });
});

test("owner-session resume requires an owner session (no cookie -> not authenticated)", async () => {
  await withServer(async ({ asUrl }) => {
    const connectorKey = await registerConnector(asUrl, loadReferenceManifest("spotify"));
    await seedInstance({
      connectorId: connectorKey,
      connectorInstanceId: "cin_session_resume_no_cookie",
      displayName: "My Spotify (recovered)",
      sourceBinding: { kind: "historical_archive", original_connector_instance_id: "cin_session_resume_no_cookie" },
      sourceBindingKey: "historical_archive_no_cookie",
    });

    const resp = await fetch(`${asUrl}/_ref/connections/cin_session_resume_no_cookie/resume`, {
      headers: { Accept: "application/json" },
      method: "POST",
    });

    assert.notEqual(resp.status, 200, "an unauthenticated request must not resume the connection");
  });
});
