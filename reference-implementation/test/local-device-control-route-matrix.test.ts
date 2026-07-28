// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Production control-plane regression for local-device source authority.
 *
 * This deliberately reaches every mounted mutation route under its real
 * authentication adapter. It is not a route-unit substitute: the server owns
 * both HTTP listeners, the persisted instance row, owner login, and the
 * owner-agent device-code exchange.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const INSTANCE_ID = "cin_local_device_control_matrix";
const OWNER_ID = "owner_local";
const PASSWORD = "local-device-matrix-password";
const CLIENT_ID = "cli_longview";
const NOW = "2026-07-21T12:00:00.000Z";

type StartedServer = Awaited<ReturnType<typeof startServer>>;

function hasCloseAllConnections(server: object): server is { closeAllConnections: () => void } {
  return "closeAllConnections" in server && typeof server.closeAllConnections === "function";
}

async function closeServer(server: StartedServer): Promise<void> {
  server.schedulerManager?.stop?.();
  server.abortStartupBackfill?.("test shutdown");
  // biome-ignore lint/suspicious/noEmptyBlockStatements: localized test assertion preserves its explicit contract.
  await Promise.resolve(server.startupBackfillDone).catch(() => {});
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

async function fetchJson(url: string, options: RequestInit = {}): Promise<{ body: unknown; status: number }> {
  const response = await fetch(url, options);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body, status: response.status };
}

function setCookiePair(response: Response, name: string): string | null {
  const headers =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter((value): value is string => Boolean(value));
  return (
    headers
      .map((header) => header.split(";")[0])
      .find((pair): pair is string => typeof pair === "string" && pair.startsWith(`${name}=`)) ?? null
  );
}

async function loginOwner(asUrl: string): Promise<string> {
  const loginPage = await fetch(`${asUrl}/owner/login`, { headers: { Accept: "text/html" }, redirect: "manual" });
  const csrfCookie = setCookiePair(loginPage, "pdpp_owner_csrf");
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  const csrfField = (await loginPage.text()).match(/name="_csrf" value="([^"]+)"/)?.[1];
  assert.ok(csrfCookie && csrfField, "owner login must provide the CSRF proof");
  const login = await fetch(`${asUrl}/owner/login`, {
    body: new URLSearchParams({ _csrf: csrfField, password: PASSWORD, return_to: "/" }).toString(),
    headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded", Cookie: csrfCookie },
    method: "POST",
    redirect: "manual",
  });
  const sessionCookie = setCookiePair(login, "pdpp_owner_session");
  assert.ok(sessionCookie, "owner login must issue a session cookie");
  return sessionCookie;
}

interface DeviceAuthorizationBody {
  device_code: string;
  user_code: string;
}

interface DeviceTokenBody {
  access_token: string;
}

async function issueOwnerAgentToken(asUrl: string, sessionCookie: string): Promise<string> {
  const device = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    body: JSON.stringify({ client_id: CLIENT_ID }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(device.status, 200);
  const deviceBody = device.body as DeviceAuthorizationBody;
  const approved = await fetch(`${asUrl}/device/approve`, {
    body: JSON.stringify({ subject_id: OWNER_ID, user_code: deviceBody.user_code }),
    headers: { "Content-Type": "application/json", Cookie: sessionCookie },
    method: "POST",
  });
  assert.equal(approved.status, 200);
  const token = await fetchJson(`${asUrl}/oauth/token`, {
    body: JSON.stringify({
      client_id: CLIENT_ID,
      device_code: deviceBody.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(token.status, 200);
  const tokenBody = token.body as Partial<DeviceTokenBody> | null;
  assert.ok(tokenBody?.access_token, "device code must issue an owner-agent bearer");
  return tokenBody.access_token;
}

interface ScheduleBody {
  interval_seconds: number;
}

interface ErrorEnvelope {
  error: { code: string };
}

interface Mutation {
  method: string;
  options: RequestInit;
  path: string;
}

function mutation(method: string, path: string, auth: Record<string, string>, body?: ScheduleBody): Mutation {
  return {
    method,
    options: {
      headers: {
        ...auth,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    path,
  };
}

interface SchedulerSideEffects {
  activeRuns: number;
  schedules: number;
}

function schedulerSideEffects(): SchedulerSideEffects {
  const activeRunsRow = getDb().prepare("SELECT COUNT(*) AS count FROM controller_active_runs").get() as {
    count: number;
  };
  const schedulesRow = getDb().prepare("SELECT COUNT(*) AS count FROM connector_schedules").get() as { count: number };
  return {
    activeRuns: activeRunsRow.count,
    schedules: schedulesRow.count,
  };
}

test("all 18 cookie and owner-agent local-device control selectors fail closed without scheduler side effects", async () => {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: PASSWORD,
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    const manifest = JSON.parse(readFileSync(new URL("../manifests/spotify.json", import.meta.url), "utf8"));
    const registered = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registered.status, 201);
    const connectorId = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorId);
    await createSqliteConnectorInstanceStore().upsert({
      connectorId,
      connectorInstanceId: INSTANCE_ID,
      createdAt: NOW,
      displayName: "Local Spotify export",
      ownerSubjectId: OWNER_ID,
      sourceBinding: { device: "laptop", kind: "local_device" },
      sourceBindingKey: "local-device-matrix",
      sourceKind: "local_device",
      status: "active",
      updatedAt: NOW,
    });

    const cookie = await loginOwner(asUrl);
    const ownerToken = await issueOwnerAgentToken(asUrl, cookie);
    const cookieAuth = { Cookie: cookie };
    const bearerAuth = { Authorization: `Bearer ${ownerToken}` };
    const connectionSchedule = `/_ref/connections/${encodeURIComponent(INSTANCE_ID)}/schedule`;
    const connectorSchedule = `/_ref/connectors/${encodeURIComponent(connectorId)}/schedule`;
    const ownerConnectionSchedule = `/v1/owner/connections/${encodeURIComponent(INSTANCE_ID)}/schedule`;
    const ownerConnectorSchedule = `/v1/owner/connectors/${encodeURIComponent(connectorId)}/schedule`;
    const scheduleBody = { interval_seconds: 900 };

    const requests = [
      // Cookie/session surface: both selector shapes × every mutation.
      mutation("POST", `/_ref/connections/${encodeURIComponent(INSTANCE_ID)}/run`, cookieAuth),
      mutation("PUT", connectionSchedule, cookieAuth, scheduleBody),
      mutation("POST", `${connectionSchedule}/pause`, cookieAuth),
      mutation("POST", `${connectionSchedule}/resume`, cookieAuth),
      mutation("DELETE", connectionSchedule, cookieAuth),
      mutation("POST", `/_ref/connectors/${encodeURIComponent(connectorId)}/run`, cookieAuth),
      mutation("PUT", connectorSchedule, cookieAuth, scheduleBody),
      mutation("POST", `${connectorSchedule}/pause`, cookieAuth),
      mutation("POST", `${connectorSchedule}/resume`, cookieAuth),
      mutation("DELETE", connectorSchedule, cookieAuth),
      // Owner-agent surface exposes run/toggle/delete (schedule PUT remains
      // owner-session-only by contract): both selector shapes × all eight routes.
      mutation("POST", `/v1/owner/connections/${encodeURIComponent(INSTANCE_ID)}/run`, bearerAuth),
      mutation("POST", `${ownerConnectionSchedule}/pause`, bearerAuth),
      mutation("POST", `${ownerConnectionSchedule}/resume`, bearerAuth),
      mutation("DELETE", ownerConnectionSchedule, bearerAuth),
      mutation("POST", `/v1/owner/connectors/${encodeURIComponent(connectorId)}/run`, bearerAuth),
      mutation("POST", `${ownerConnectorSchedule}/pause`, bearerAuth),
      mutation("POST", `${ownerConnectorSchedule}/resume`, bearerAuth),
      mutation("DELETE", ownerConnectorSchedule, bearerAuth),
    ];
    assert.equal(requests.length, 18, "matrix must cover every independently mounted local-device control route");

    const initialSideEffects = schedulerSideEffects();
    assert.deepEqual(initialSideEffects, { activeRuns: 0, schedules: 0 });
    for (const request of requests) {
      const baseUrl = request.path.startsWith("/v1/") ? rsUrl : asUrl;
      // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
      const response = await fetchJson(`${baseUrl}${request.path}`, request.options);
      assert.equal(response.status, 409, `${request.method} ${request.path} must reject local-device control`);
      const responseBody = response.body as Partial<ErrorEnvelope> | null;
      assert.equal(responseBody?.error?.code, "local_device_control_unsupported", `${request.method} ${request.path}`);
      assert.deepEqual(
        schedulerSideEffects(),
        initialSideEffects,
        `${request.method} ${request.path} must be side-effect free`
      );
    }
  } finally {
    await closeServer(server);
  }
});
