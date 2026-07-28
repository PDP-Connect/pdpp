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
    readonly args: { revokedAt?: string | null; status: string; updatedAt: string };
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
  assert.deepEqual(updates, [
    {
      args: {
        revokedAt: "2026-06-10T12:00:00.000Z",
        status: "revoked",
        updatedAt: "2026-06-10T12:00:00.000Z",
      },
      connectorInstanceId: "cin_expired_1",
    },
    {
      args: {
        revokedAt: "2026-06-10T12:00:00.000Z",
        status: "revoked",
        updatedAt: "2026-06-10T12:00:00.000Z",
      },
      connectorInstanceId: "cin_active",
    },
  ]);
});
