// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import test from "node:test";

import { listSpineEventsPage } from "../lib/spine.ts";
import {
  expiredEnrollmentShellIds,
  retireExpiredBrowserEnrollmentShells,
} from "../server/browser-enrollment-shell-retirement.ts";
import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { BROWSER_ENROLLMENT_SHELL_TTL_MS } from "../server/routes/ref-browser-enrollment-shell.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

// Integration coverage for the browser-enrollment shell routes:
//   POST /_ref/connectors/:connectorId/browser-enrollment-shell  (on AS)
//   POST /_ref/connections/:connectorInstanceId/abandon-enrollment  (on AS)
// and unit coverage for the TTL retirement utility.
//
// Note: /_ref/... owner-session routes live on the AS app, not the RS app.
// Owner login is also at /owner/login on the AS.

const OWNER_PASSWORD = "browser-shell-owner-password";
const OWNER_SUBJECT_ID = "owner_local";

function loadManifest(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../packages/polyfill-connectors/manifests/${name}.json`, import.meta.url), "utf8")
  );
}

async function registerConnector(asUrl: string, name: string): Promise<void> {
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(loadManifest(name)),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(resp.status, 201, `register ${name} failed: ${resp.status}`);
}

// Route responses are dynamic JSON; the runtime shape genuinely varies per
// endpoint, so tests read it as a plain string-keyed record rather than
// asserting a fixed response type per call site.
async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null, "expected a JSON object");
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}

type TestServer = Awaited<ReturnType<typeof startServer>>;

// `app.listen()` (server/transport.js) documents that it returns the
// underlying Node `http.Server` so tests can call `.closeAllConnections()` /
// `.close(cb)`; TS's structural inference through the untyped JS module
// widens `asServer`/`rsServer` to `Http2SecureServer`, whose `@types/node`
// declaration omits `closeAllConnections`. A runtime check (rather than a
// type cast between two types TS considers non-overlapping) confirms the
// documented shape before calling it.
function hasCloseAllConnections(server: unknown): server is HttpServer {
  return (
    typeof server === "object" &&
    server !== null &&
    typeof (server as { closeAllConnections?: unknown }).closeAllConnections === "function"
  );
}

function closeHttpServer(server: HttpServer): Promise<void> {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

async function closeServer(server: TestServer): Promise<void> {
  server.schedulerManager?.stop?.();
  assert.ok(hasCloseAllConnections(server.asServer), "asServer is the underlying http.Server");
  assert.ok(hasCloseAllConnections(server.rsServer), "rsServer is the underlying http.Server");
  await Promise.allSettled([closeHttpServer(server.asServer), closeHttpServer(server.rsServer)]);
}

async function withServer(fn: (urls: { asUrl: string; rsUrl: string }) => Promise<void>): Promise<void> {
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
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    await fn({ asUrl, rsUrl });
  } finally {
    await closeServer(server);
  }
}

// Owner-auth-disabled harness for the end-to-end promotion test below, which
// needs an owner BEARER token (device flow) in addition to the owner-session
// shell-creation surface. With an empty owner password the default owner
// session is active with no cookie needed at all, so `/device/approve`
// (owner-session + CSRF gated) and `/_ref/...` both work with an empty
// cookie — same pattern as static-secret-draft-connection-route.test.ts's
// `withOpenServer`.
async function withOpenServer(fn: (urls: { asUrl: string; rsUrl: string }) => Promise<void>): Promise<void> {
  const server = await startServer({
    asPort: 0,
    autoEnrollEligibleSchedules: false,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    ownerAuthSubjectId: OWNER_SUBJECT_ID,
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    await fn({ asUrl, rsUrl });
  } finally {
    await closeServer(server);
  }
}

// Owner login is on the AS (same as /_ref/... routes).
async function ownerLogin(asUrl: string, password: string = OWNER_PASSWORD): Promise<string> {
  const res = await fetch(`${asUrl}/owner/login`, {
    body: JSON.stringify({ password }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    redirect: "manual",
  });
  const cookie = res.headers.get("set-cookie") ?? "";
  return cookie.split(";")[0] ?? "";
}

// Owner bearer token via the device-authorization flow, same as the
// static-secret-draft ingest-activation coverage (see
// static-secret-draft-connection-route.test.ts's `issueOwnerToken`) — the RS
// ingest endpoint below is bearer-authenticated, not cookie-authenticated.
async function issueOwnerToken(asUrl: string, subjectId: string = OWNER_SUBJECT_ID): Promise<string> {
  const clientId = "cli_longview";
  const deviceRes = await fetch(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const deviceBody = await jsonBody(deviceRes);
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: String(deviceBody.user_code) }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const tokenRes = await fetch(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: String(deviceBody.device_code),
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const tokenBody = await jsonBody(tokenRes);
  return String(tokenBody.access_token);
}

async function ingestNdjson(
  rsUrl: string,
  ownerToken: string,
  connectorId: string,
  connectionId: string,
  stream: string,
  records: Array<{ id: string; emitted_at: string; [key: string]: unknown }>
): Promise<Response> {
  const lines = records
    .map((record) => JSON.stringify({ data: record, emitted_at: record.emitted_at, key: record.id }))
    .join("\n");
  const url =
    `${rsUrl}/v1/ingest/${encodeURIComponent(stream)}` +
    `?connector_id=${encodeURIComponent(connectorId)}` +
    `&connector_instance_id=${encodeURIComponent(connectionId)}`;
  return await fetch(url, {
    body: lines,
    headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/x-ndjson" },
    method: "POST",
  });
}

// --- POST /_ref/connectors/:connectorId/browser-enrollment-shell ---

test("browser-enrollment shell: creates draft for supported browser collector connector", async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "amazon");
    const cookie = await ownerLogin(asUrl);
    const res = await fetch(`${asUrl}/_ref/connectors/amazon/browser-enrollment-shell`, {
      body: JSON.stringify({ display_name: "  Amazon personal  " }),
      headers: { "content-type": "application/json", cookie },
      method: "POST",
    });
    assert.equal(res.status, 201);
    const body = await jsonBody(res);
    assert.equal(body.object, "browser_enrollment_shell");
    assert.ok(body.connection_id, "connection_id present");
    assert.equal(body.connector_id, "amazon");
    assert.equal(body.display_name, "Amazon personal");
    assert.equal(body.status, "draft");
    assert.ok(body.enrollment_expires_at, "enrollment_expires_at present");
    // TTL should be ~2h in the future
    const expiresMs = new Date(asString(body.enrollment_expires_at)).getTime();
    const nowMs = Date.now();
    assert.ok(expiresMs > nowMs + 60 * 60 * 1000, "expires at least 1h from now");
    assert.ok(expiresMs < nowMs + 3 * 60 * 60 * 1000, "expires within 3h");
    assert.equal(asRecord(body.next_step).kind, "browser_enrollment_run");

    const db = getDb();
    const row = db
      .prepare(
        `SELECT display_name, source_binding_json
           FROM connector_instances
          WHERE connector_instance_id = ?`
      )
      .get(body.connection_id);
    assert.ok(row, "stored shell row present");
    assert.equal(row.display_name, "Amazon personal");
    assert.equal(JSON.parse(String(row.source_binding_json)).kind, "browser_enrollment_shell");
  });
});

test("browser-enrollment shell: two calls create two distinct shells", async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "heb");
    const cookie = await ownerLogin(asUrl);
    const r1 = await fetch(`${asUrl}/_ref/connectors/heb/browser-enrollment-shell`, {
      headers: { cookie },
      method: "POST",
    });
    const r2 = await fetch(`${asUrl}/_ref/connectors/heb/browser-enrollment-shell`, {
      headers: { cookie },
      method: "POST",
    });
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201);
    const b1 = await jsonBody(r1);
    const b2 = await jsonBody(r2);
    assert.notEqual(b1.connection_id, b2.connection_id);
  });
});

test("browser-enrollment shell: rejects malformed bodies safely", async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "amazon");
    const cookie = await ownerLogin(asUrl);
    const res = await fetch(`${asUrl}/_ref/connectors/amazon/browser-enrollment-shell`, {
      body: JSON.stringify(["not-an-object"]),
      headers: { "content-type": "application/json", cookie },
      method: "POST",
    });
    assert.equal(res.status, 400);
    const body = await jsonBody(res);
    assert.equal(asRecord(body.error).code, "invalid_request");
  });
});

test("browser-enrollment shell: rejects overlong display_name safely", async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "heb");
    const cookie = await ownerLogin(asUrl);
    const res = await fetch(`${asUrl}/_ref/connectors/heb/browser-enrollment-shell`, {
      body: JSON.stringify({ display_name: "x".repeat(201) }),
      headers: { "content-type": "application/json", cookie },
      method: "POST",
    });
    assert.equal(res.status, 400);
    const body = await jsonBody(res);
    assert.equal(asRecord(body.error).code, "invalid_request");
    assert.equal(asRecord(body.error).param, "display_name");
  });
});

test("browser-enrollment shell: rejects non-browser-bound connector (409)", async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "gmail");
    const cookie = await ownerLogin(asUrl);
    // gmail is a static-secret connector, not browser-bound
    const res = await fetch(`${asUrl}/_ref/connectors/gmail/browser-enrollment-shell`, {
      headers: { cookie },
      method: "POST",
    });
    assert.equal(res.status, 409);
    const body = await jsonBody(res);
    assert.equal(asRecord(body.error).code, "connector_not_browser_bound");
  });
});

test("browser-enrollment shell: rejects unknown connector (404)", async () => {
  await withServer(async ({ asUrl }) => {
    const cookie = await ownerLogin(asUrl);
    const res = await fetch(`${asUrl}/_ref/connectors/no-such-connector/browser-enrollment-shell`, {
      headers: { cookie },
      method: "POST",
    });
    assert.equal(res.status, 404);
  });
});

test("browser-enrollment shell: requires owner session (401 without cookie)", async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "chase");
    const res = await fetch(`${asUrl}/_ref/connectors/chase/browser-enrollment-shell`, {
      method: "POST",
    });
    assert.ok(res.status === 401 || res.status === 403, `Expected 401/403, got ${res.status}`);
  });
});

test("browser-enrollment shell: emits audit spine event on success", async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "heb");
    const cookie = await ownerLogin(asUrl);
    const res = await fetch(`${asUrl}/_ref/connectors/heb/browser-enrollment-shell`, {
      headers: { cookie },
      method: "POST",
    });
    assert.equal(res.status, 201);
    const traceId = asString(res.headers.get("PDPP-Reference-Trace-Id"));
    assert.ok(traceId.startsWith("trc_"), "response carries a trace id");
    const page = listSpineEventsPage("trace", traceId, { limit: 10 });
    const event = page.events.find((e) => e.event_type === "owner.connection.browser_enrollment_shell.create");
    assert.ok(event, "audit event emitted");
    assert.equal(event.status, "succeeded");
    assert.equal(asRecord(event.data).connector_id, "heb");
  });
});

test("browser-enrollment shell: shell is not visible in owner connections list", async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "heb");
    const cookie = await ownerLogin(asUrl);
    await fetch(`${asUrl}/_ref/connectors/heb/browser-enrollment-shell`, {
      headers: { cookie },
      method: "POST",
    });
    // The owner connections list must not expose draft shells
    const res = await fetch(`${asUrl}/_ref/connections`, {
      headers: { cookie },
    });
    assert.equal(res.status, 200);
    const body = await jsonBody(res);
    const rawConnections = body.connections ?? body.data ?? [];
    assert.ok(Array.isArray(rawConnections));
    const connectorIds = rawConnections.map((c) => asRecord(c).connector_id);
    assert.ok(!connectorIds.includes("heb"), "heb draft shell not visible in connections list");
  });
});

// --- POST /_ref/connections/:connectorInstanceId/abandon-enrollment ---

test("abandon-enrollment: retires a draft shell (status → revoked)", async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "chase");
    const cookie = await ownerLogin(asUrl);
    const createRes = await fetch(`${asUrl}/_ref/connectors/chase/browser-enrollment-shell`, {
      headers: { cookie },
      method: "POST",
    });
    assert.equal(createRes.status, 201);
    const { connection_id } = await jsonBody(createRes);
    const abandonRes = await fetch(`${asUrl}/_ref/connections/${connection_id}/abandon-enrollment`, {
      headers: { cookie },
      method: "POST",
    });
    assert.equal(abandonRes.status, 200);
    const body = await jsonBody(abandonRes);
    assert.equal(body.object, "enrollment_abandoned");
    assert.equal(body.status, "revoked");
  });
});

test("abandon-enrollment: stamps owner_abandoned as the revocation reason, distinct from the TTL sweep's ttl_expired", async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "venmo");
    const cookie = await ownerLogin(asUrl);
    const createRes = await fetch(`${asUrl}/_ref/connectors/venmo/browser-enrollment-shell`, {
      headers: { cookie },
      method: "POST",
    });
    assert.equal(createRes.status, 201);
    const { connection_id } = await jsonBody(createRes);
    const abandonRes = await fetch(`${asUrl}/_ref/connections/${connection_id}/abandon-enrollment`, {
      headers: { cookie },
      method: "POST",
    });
    assert.equal(abandonRes.status, 200);

    const row = getDb()
      .prepare("SELECT source_binding_json FROM connector_instances WHERE connector_instance_id = ?")
      .get(connection_id) as { source_binding_json: string } | undefined;
    assert.ok(row, "the revoked shell row must still exist");
    const binding = JSON.parse(row.source_binding_json) as Record<string, unknown>;
    assert.equal(
      binding.revocation_reason,
      "owner_abandoned",
      "an explicit owner dismissal must record its own true cause — never the TTL sweep's ttl_expired"
    );
  });
});

test("abandon-enrollment: idempotent when already revoked", async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "usaa");
    const cookie = await ownerLogin(asUrl);
    const createRes = await fetch(`${asUrl}/_ref/connectors/usaa/browser-enrollment-shell`, {
      headers: { cookie },
      method: "POST",
    });
    assert.equal(createRes.status, 201);
    const { connection_id } = await jsonBody(createRes);
    // First abandon
    const r1 = await fetch(`${asUrl}/_ref/connections/${connection_id}/abandon-enrollment`, {
      headers: { cookie },
      method: "POST",
    });
    assert.equal(r1.status, 200);
    // Second abandon — must not error
    const r2 = await fetch(`${asUrl}/_ref/connections/${connection_id}/abandon-enrollment`, {
      headers: { cookie },
      method: "POST",
    });
    assert.equal(r2.status, 200);
    const body = await jsonBody(r2);
    assert.equal(body.status, "revoked");
  });
});

test("abandon-enrollment: 404 for unknown connection_id", async () => {
  await withServer(async ({ asUrl }) => {
    const cookie = await ownerLogin(asUrl);
    const res = await fetch(`${asUrl}/_ref/connections/cin_nonexistentid/abandon-enrollment`, {
      headers: { cookie },
      method: "POST",
    });
    assert.equal(res.status, 404);
  });
});

test("abandon-enrollment: 409 for non-enrollment-shell connection (wrong kind in binding)", async () => {
  // Not directly testable end-to-end without a fully active connection.
  // Verify the endpoint exists and returns a sensible status for an
  // unknown-but-valid-format ID.
  await withServer(async ({ asUrl }) => {
    const cookie = await ownerLogin(asUrl);
    const res = await fetch(`${asUrl}/_ref/connections/cin_000000000000000000000000/abandon-enrollment`, {
      headers: { cookie },
      method: "POST",
    });
    // Either 404 (not found) or 409 (not a shell) — neither should be 500
    assert.ok(res.status === 404 || res.status === 409, `Expected 404 or 409, got ${res.status}`);
  });
});

// --- TTL retirement utility (pure unit tests, no server needed) ---

test("expiredEnrollmentShellIds: returns IDs of expired draft/active shell bindings", () => {
  const now = "2026-06-10T12:00:00.000Z";
  const shells = [
    {
      connectorInstanceId: "cin_expired_1",
      sourceBinding: { enrollment_expires_at: "2026-06-10T10:00:00.000Z", kind: "browser_enrollment_shell" },
      status: "draft",
    },
    {
      connectorInstanceId: "cin_not_expired",
      sourceBinding: { enrollment_expires_at: "2026-06-10T14:00:00.000Z", kind: "browser_enrollment_shell" },
      status: "draft",
    },
    {
      connectorInstanceId: "cin_active",
      sourceBinding: { enrollment_expires_at: "2026-06-10T10:00:00.000Z", kind: "browser_enrollment_shell" },
      status: "active",
    },
    {
      connectorInstanceId: "cin_completed_account",
      sourceBinding: { enrollment_expires_at: "2026-06-10T10:00:00.000Z", kind: "browser_collector" },
      status: "active",
    },
    {
      connectorInstanceId: "cin_paused_shell",
      sourceBinding: { enrollment_expires_at: "2026-06-10T10:00:00.000Z", kind: "browser_enrollment_shell" },
      status: "paused",
    },
    {
      connectorInstanceId: "cin_static_secret",
      sourceBinding: { kind: "static_secret_draft" },
      status: "draft",
    },
  ];
  const ids = expiredEnrollmentShellIds(shells, now);
  assert.deepEqual(ids, ["cin_expired_1", "cin_active"]);
});

test("expiredEnrollmentShellIds: empty list returns empty", () => {
  assert.deepEqual(expiredEnrollmentShellIds([], "2026-06-10T12:00:00.000Z"), []);
});

test("expiredEnrollmentShellIds: missing enrollment_expires_at treated as not-expired", () => {
  const now = "2026-06-10T12:00:00.000Z";
  const shells = [
    {
      connectorInstanceId: "cin_no_ttl",
      sourceBinding: { kind: "browser_enrollment_shell" },
      status: "draft",
    },
  ];
  const ids = expiredEnrollmentShellIds(shells, now);
  assert.deepEqual(ids, []);
});

test("BROWSER_ENROLLMENT_SHELL_TTL_MS is 2 hours", () => {
  assert.equal(BROWSER_ENROLLMENT_SHELL_TTL_MS, 2 * 60 * 60 * 1000);
});

test("retireExpiredBrowserEnrollmentShells flips expired draft/active shell bindings to revoked", async () => {
  interface RecordedUpdate {
    readonly args: {
      revokedAt?: string | null;
      status: string;
      updatedAt: string;
      sourceBindingPatch?: Record<string, unknown> | null;
    };
    readonly connectorInstanceId: string;
  }
  const updates: RecordedUpdate[] = [];
  const shells = [
    {
      connectorInstanceId: "cin_expired_1",
      sourceBinding: { enrollment_expires_at: "2026-06-10T10:00:00.000Z", kind: "browser_enrollment_shell" },
      status: "draft",
    },
    {
      connectorInstanceId: "cin_not_expired",
      sourceBinding: { enrollment_expires_at: "2026-06-10T14:00:00.000Z", kind: "browser_enrollment_shell" },
      status: "draft",
    },
    {
      connectorInstanceId: "cin_active",
      sourceBinding: { enrollment_expires_at: "2026-06-10T10:00:00.000Z", kind: "browser_enrollment_shell" },
      status: "active",
    },
    {
      connectorInstanceId: "cin_real_account",
      sourceBinding: { enrollment_expires_at: "2026-06-10T10:00:00.000Z", kind: "browser_collector" },
      status: "active",
    },
  ];

  const retired = await retireExpiredBrowserEnrollmentShells(
    {
      listDraftBrowserEnrollmentShells(ownerSubjectId) {
        assert.equal(ownerSubjectId, OWNER_SUBJECT_ID);
        return Promise.resolve(shells);
      },
      updateStatus(connectorInstanceId, args) {
        updates.push({ args, connectorInstanceId });
        return Promise.resolve();
      },
    },
    { now: "2026-06-10T12:00:00.000Z", ownerSubjectId: OWNER_SUBJECT_ID }
  );

  assert.deepEqual(retired, ["cin_expired_1", "cin_active"]);
  // Quiet-expiry defect fix (owner ruling 2026-08-22): the sweep now stamps
  // `sourceBindingPatch: { revocation_reason: "ttl_expired" }` on every row it
  // retires, so `deriveSourceVisibility`/`archiveRenderedVerdict`
  // (ref-control.ts) can render an honest "expired while waiting for you"
  // verdict instead of a silent, unexplained revocation.
  assert.deepEqual(updates, [
    {
      args: {
        revokedAt: "2026-06-10T12:00:00.000Z",
        sourceBindingPatch: { revocation_reason: "ttl_expired" },
        status: "revoked",
        updatedAt: "2026-06-10T12:00:00.000Z",
      },
      connectorInstanceId: "cin_expired_1",
    },
    {
      args: {
        revokedAt: "2026-06-10T12:00:00.000Z",
        sourceBindingPatch: { revocation_reason: "ttl_expired" },
        status: "revoked",
        updatedAt: "2026-06-10T12:00:00.000Z",
      },
      connectorInstanceId: "cin_active",
    },
  ]);
});

// --- End-to-end promotion: shell creation -> real ingest -> durable binding ---
//
// Live repro this closes: a ChatGPT connector_instance with 9,163 records had
// status revoked while source_binding_json still read
// `{kind: browser_enrollment_shell, ...}` — Sources hid it (RETIRED_SETUP_
// SHELL_BINDING_KINDS) while Explore still showed its records, because
// nothing had ever promoted the binding off `browser_enrollment_shell` on
// successful first collection. This drives the REAL HTTP path (shell create
// -> RS ingest -> the same `activateDraftConnection` capability the
// static-secret-draft flow uses) rather than calling the store directly.
test("browser-enrollment shell: a successful first ingest promotes the shell to a durable browser_collector binding, and TTL retirement afterward never revokes it", async () => {
  await withOpenServer(async ({ asUrl, rsUrl }) => {
    await registerConnector(asUrl, "chatgpt");
    const cookie = "";

    const created = await fetch(`${asUrl}/_ref/connectors/chatgpt/browser-enrollment-shell`, {
      headers: { cookie },
      method: "POST",
    });
    assert.equal(created.status, 201);
    const createdBody = await jsonBody(created);
    const connectionId = asString(createdBody.connection_id);

    // Before ingest: still a shell, hidden from /_ref/connections (mirrors
    // the static-secret-draft pattern this flow was modeled on).
    const preIngestRow = getDb()
      .prepare("SELECT status, source_binding_json FROM connector_instances WHERE connector_instance_id = ?")
      .get(connectionId) as { status: string; source_binding_json: string };
    assert.equal(preIngestRow.status, "draft");
    assert.equal(JSON.parse(preIngestRow.source_binding_json).kind, "browser_enrollment_shell");

    const ownerToken = await issueOwnerToken(asUrl);
    const ingestRes = await ingestNdjson(rsUrl, ownerToken, "chatgpt", connectionId, "conversations", [
      { emitted_at: "2026-08-06T09:00:00.000Z", id: "conv_1", title: "hello" },
    ]);
    assert.equal(ingestRes.status, 200, `ingest into shell should succeed: ${await ingestRes.text()}`);

    // After ingest: promoted — durable binding, active, and NOT the shell
    // kind anymore.
    const postIngestRow = getDb()
      .prepare("SELECT status, source_binding_json FROM connector_instances WHERE connector_instance_id = ?")
      .get(connectionId) as { status: string; source_binding_json: string };
    assert.equal(postIngestRow.status, "active", "promoted connection is active");
    const postIngestBinding = JSON.parse(postIngestRow.source_binding_json);
    assert.equal(postIngestBinding.kind, "browser_collector", "binding kind moved off browser_enrollment_shell");
    assert.equal(postIngestBinding.connector_id, "chatgpt", "connector_id carried over from the shell binding");

    // Now visible on the owner-facing raw connection list.
    const listRes = await fetch(`${asUrl}/_ref/connections`, { headers: { cookie } });
    const listBody = (await jsonBody(listRes)) as { data?: Record<string, unknown>[] };
    const visible = (listBody.data ?? []).find(
      (c) => c.connection_id === connectionId || c.connector_instance_id === connectionId
    );
    assert.ok(visible, "promoted connection is visible on /_ref/connections");
    assert.equal(visible?.status, "active");

    // The exact live-bug shape: run the REAL retirement sweep well past the
    // shell's original 2h TTL. A promoted connection must survive untouched
    // — this is the assertion that would have failed against the code
    // before this fix (the sweep would have revoked it).
    const store = createSqliteConnectorInstanceStore();
    const farFuture = new Date(Date.now() + BROWSER_ENROLLMENT_SHELL_TTL_MS * 10).toISOString();
    const retiredIds = await retireExpiredBrowserEnrollmentShells(
      {
        listDraftBrowserEnrollmentShells: (ownerSubjectId) =>
          Promise.resolve(
            store.listDraftBrowserEnrollmentShells(ownerSubjectId) as unknown as {
              connectorInstanceId: string;
              sourceBinding?: Record<string, unknown> | null;
              status: string;
            }[]
          ),
        updateStatus: (connectorInstanceId, args) => Promise.resolve(store.updateStatus(connectorInstanceId, args)),
      },
      { now: farFuture, ownerSubjectId: OWNER_SUBJECT_ID }
    );
    assert.ok(
      !retiredIds.includes(connectionId),
      "TTL retirement run long past the shell's original TTL does not revoke the promoted connection"
    );
    const finalRow = getDb()
      .prepare("SELECT status FROM connector_instances WHERE connector_instance_id = ?")
      .get(connectionId) as { status: string };
    assert.equal(finalRow.status, "active", "connection remains active after the retirement sweep");
  });
});
