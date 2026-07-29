// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { listSpineEventsPage } from "../lib/spine.ts";
import { startServer } from "../server/index.ts";
import { createSqliteConnectorInstanceCredentialStore } from "../server/stores/connector-instance-credential-store.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from "../server/stores/credential-encryption.ts";

const OWNER_PASSWORD = "static-secret-capture-owner-password";
const OWNER_SUBJECT_ID = "owner_local";
const NOW = "2026-06-01T12:00:00.000Z";
const TEST_KEY = "static-secret-owner-capture-test-key";
const PERSONAL_SECRET = "personal app password synthetic";
const WORK_SECRET = "work app password synthetic";
const ROTATED_SECRET = "rotated app password synthetic";

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

async function withCredentialKey<T>(value: string | null, fn: () => Promise<T>): Promise<T> {
  const old = process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
  if (value === null) {
    delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
  } else {
    process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = value;
  }
  try {
    return await fn();
  } finally {
    if (old === undefined) {
      delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
    } else {
      process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = old;
    }
  }
}

// This suite exercises credential-capture MECHANICS (sealing, rotation, kind
// mismatch, fail-closed) — not the synchronous validation moment. Inject a
// permissive deterministic prober so a probe-bearing connector (gmail) does not
// trigger a real network probe; every synthetic secret validates. The dedicated
// probe-rejection behavior is proven in static-secret-credential-probe-route.test.js.
function permissiveProber() {
  return async ({ context }: { context?: { setupFields?: Record<string, unknown> } }) => ({
    detail: null,
    identity: context?.setupFields?.account_email ?? "synthetic@example.com",
    ok: true,
  });
}

async function withServer(fn: (harness: { asUrl: string; rsUrl: string }) => Promise<void>): Promise<void> {
  const server = await startServer({
    asPort: 0,
    autoEnrollEligibleSchedules: false,
    dbPath: ":memory:",
    ownerAuthPassword: OWNER_PASSWORD,
    ownerAuthSubjectId: OWNER_SUBJECT_ID,
    quiet: true,
    rsPort: 0,
    staticSecretAutoResume: false,
    staticSecretCredentialProber: permissiveProber(),
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    await fn({ asUrl, rsUrl });
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
    // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
    const firstPair = header.split(";")[0];
    if (firstPair?.startsWith(`${name}=`)) {
      return firstPair;
    }
  }
  return null;
}

function extractCsrfFieldValue(html: string): string | null {
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  const match = html.match(/<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/);
  return match ? (match[1] ?? null) : null;
}

async function login(asUrl: string): Promise<string> {
  const getLogin = await fetch(`${asUrl}/owner/login`, {
    headers: { Accept: "text/html" },
    redirect: "manual",
  });
  const csrfCookie = findSetCookiePair(getRawSetCookieList(getLogin), "pdpp_owner_csrf");
  const csrfField = extractCsrfFieldValue(await getLogin.text());
  const resp = await fetch(`${asUrl}/owner/login`, {
    body: new URLSearchParams({
      _csrf: csrfField || "",
      password: OWNER_PASSWORD,
      return_to: "/",
    }).toString(),
    headers: {
      Accept: "text/html",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: csrfCookie || "",
    },
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
  text: string;
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
  return { body: body as Record<string, unknown>, resp, status: resp.status, text };
}

interface ConnectorManifest {
  connector_id: string;
  connector_key?: string;
  [key: string]: unknown;
}

function loadManifest(name: string): ConnectorManifest {
  return JSON.parse(
    readFileSync(new URL(`../../packages/polyfill-connectors/manifests/${name}.json`, import.meta.url), "utf8")
  ) as ConnectorManifest;
}

async function registerConnector(asUrl: string, name: string): Promise<void> {
  const manifest = loadManifest(name);
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(resp.status, 201, `register ${name} failed: ${resp.status}`);
}

async function seedInstance({
  connectorInstanceId,
  connectorId,
  ownerSubjectId = OWNER_SUBJECT_ID,
  displayName,
}: {
  connectorInstanceId: string;
  connectorId: string;
  ownerSubjectId?: string;
  displayName?: string;
}): Promise<void> {
  const store = createSqliteConnectorInstanceStore();
  await store.upsert({
    connectorId,
    connectorInstanceId,
    createdAt: NOW,
    displayName: displayName ?? connectorInstanceId,
    ownerSubjectId,
    sourceBinding: { account_hint: connectorInstanceId },
    sourceBindingKey: connectorInstanceId,
    sourceKind: "account",
    status: "active",
    updatedAt: NOW,
  });
}

// biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
async function captureCredential(
  asUrl: string,
  sessionCookie: string,
  connectionId: string,
  secret: string,
  credentialKind = "app_password"
): Promise<JsonResult> {
  return fetchJson(`${asUrl}/_ref/connections/${encodeURIComponent(connectionId)}/static-secret-credential`, {
    body: JSON.stringify({ credential_kind: credentialKind, secret }),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    method: "POST",
  });
}

function findCaptureAuditEvent(resp: Response) {
  const traceId = resp.headers.get("PDPP-Reference-Trace-Id");
  assert.ok(traceId?.startsWith("trc_"), "capture response should carry a trace id");
  assert.ok(traceId);
  const page = listSpineEventsPage("trace", traceId, { limit: 20 });
  const event = page.events.find((entry) => entry.event_type === "owner.connection.static_secret_credential.capture");
  assert.ok(event, "expected static-secret capture audit event");
  assert.equal(event.request_id, resp.headers.get("Request-Id"));
  return event;
}

function credentialOf(body: Record<string, unknown>): Record<string, unknown> {
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const credential = body.credential;
  assert.ok(typeof credential === "object" && credential !== null, "expected body.credential to be an object");
  return credential as Record<string, unknown>;
}

function nextStepOf(body: Record<string, unknown>): Record<string, unknown> {
  const nextStep = body.next_step;
  assert.ok(typeof nextStep === "object" && nextStep !== null, "expected body.next_step to be an object");
  return nextStep as Record<string, unknown>;
}

function errorOf(body: Record<string, unknown>): Record<string, unknown> {
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
  const error = body.error;
  assert.ok(typeof error === "object" && error !== null, "expected body.error to be an object");
  return error as Record<string, unknown>;
}

function dataOf(event: { data: unknown }): Record<string, unknown> {
  const { data } = event;
  assert.ok(typeof data === "object" && data !== null, "expected event.data to be an object");
  return data as Record<string, unknown>;
}

test("owner-session route seals a static secret and returns only non-secret metadata", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "gmail");
      await seedInstance({ connectorId: "gmail", connectorInstanceId: "cin_gmail_personal" });
      const cookie = await login(asUrl);

      const { status, body, resp, text } = await captureCredential(
        asUrl,
        cookie,
        "cin_gmail_personal",
        PERSONAL_SECRET
      );
      assert.equal(status, 201);
      assert.equal(body.object, "static_secret_credential_capture");
      assert.equal(body.connection_id, "cin_gmail_personal");
      assert.equal(body.connector_id, "gmail");
      assert.equal(credentialOf(body).credential_kind, "app_password");
      assert.equal(credentialOf(body).status, "active");
      assert.equal(credentialOf(body).present, true);
      assert.ok(credentialOf(body).fingerprint, "response may expose a non-secret fingerprint");
      assert.equal(nextStepOf(body).kind, "run_connection");
      assert.ok(!text.includes(PERSONAL_SECRET), "response must not contain the submitted secret");

      const audit = findCaptureAuditEvent(resp);
      assert.equal(audit.actor_type, "owner_session");
      assert.equal(audit.status, "succeeded");
      assert.equal(dataOf(audit).connection_id, "cin_gmail_personal");
      assert.equal(dataOf(audit).credential_kind, "app_password");
      assert.ok(!JSON.stringify(audit).includes(PERSONAL_SECRET), "audit must not contain the secret");

      const store = createSqliteConnectorInstanceCredentialStore({
        env: { [CREDENTIAL_ENCRYPTION_KEY_ENV]: TEST_KEY },
      });
      const recovered = await store.recoverSecret({
        connectorInstanceId: "cin_gmail_personal",
        ownerSubjectId: OWNER_SUBJECT_ID,
      });
      assert.equal(recovered.secret, PERSONAL_SECRET);
    });
  });
});

test("capture is per-connection and rotation preserves the connection id", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "gmail");
      await seedInstance({ connectorId: "gmail", connectorInstanceId: "cin_gmail_personal" });
      await seedInstance({ connectorId: "gmail", connectorInstanceId: "cin_gmail_work" });
      const cookie = await login(asUrl);

      const first = await captureCredential(asUrl, cookie, "cin_gmail_personal", PERSONAL_SECRET);
      const work = await captureCredential(asUrl, cookie, "cin_gmail_work", WORK_SECRET);
      const rotated = await captureCredential(asUrl, cookie, "cin_gmail_personal", ROTATED_SECRET);
      assert.equal(first.status, 201);
      assert.equal(work.status, 201);
      assert.equal(rotated.status, 200);
      assert.equal(rotated.body.connection_id, "cin_gmail_personal");
      assert.ok(credentialOf(rotated.body).rotated_at, "rotation should stamp rotated_at");
      assert.notEqual(
        credentialOf(rotated.body).fingerprint,
        credentialOf(first.body).fingerprint,
        "rotation changes only the captured credential metadata"
      );

      const store = createSqliteConnectorInstanceCredentialStore({
        env: { [CREDENTIAL_ENCRYPTION_KEY_ENV]: TEST_KEY },
      });
      const personal = await store.recoverSecret({
        connectorInstanceId: "cin_gmail_personal",
        ownerSubjectId: OWNER_SUBJECT_ID,
      });
      const workRecovered = await store.recoverSecret({
        connectorInstanceId: "cin_gmail_work",
        ownerSubjectId: OWNER_SUBJECT_ID,
      });
      assert.equal(personal.secret, ROTATED_SECRET);
      assert.equal(workRecovered.secret, WORK_SECRET);
      assert.notEqual(personal.secret, workRecovered.secret);
    });
  });
});

test("owner-agent bearer without an owner session cannot use the capture route", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "gmail");
      await seedInstance({ connectorId: "gmail", connectorInstanceId: "cin_gmail_personal" });

      const { status, body, text } = await fetchJson(
        `${asUrl}/_ref/connections/cin_gmail_personal/static-secret-credential`,
        {
          body: JSON.stringify({ credential_kind: "app_password", secret: PERSONAL_SECRET }),
          headers: {
            Accept: "application/json",
            Authorization: "Bearer owner-agent-token-that-is-not-a-cookie",
            "Content-Type": "application/json",
          },
          method: "POST",
        }
      );
      assert.equal(status, 401);
      assert.equal(errorOf(body).code, "owner_session_required");
      assert.ok(!text.includes(PERSONAL_SECRET), "auth failure must not echo the secret");

      const store = createSqliteConnectorInstanceCredentialStore({
        env: { [CREDENTIAL_ENCRYPTION_KEY_ENV]: TEST_KEY },
      });
      assert.equal(await store.getMetadata("cin_gmail_personal"), null);
    });
  });
});

test("capture fails closed when the operator encryption key is missing", async () => {
  await withCredentialKey(null, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "gmail");
      await seedInstance({ connectorId: "gmail", connectorInstanceId: "cin_gmail_personal" });
      const cookie = await login(asUrl);

      const { status, body, text, resp } = await captureCredential(
        asUrl,
        cookie,
        "cin_gmail_personal",
        PERSONAL_SECRET
      );
      assert.equal(status, 503);
      assert.equal(errorOf(body).code, "credential_encryption_key_missing");
      assert.ok(!text.includes(PERSONAL_SECRET), "error response must not contain the submitted secret");
      const audit = findCaptureAuditEvent(resp);
      assert.equal(audit.status, "failed");
      assert.equal(errorOf(dataOf(audit)).code, "credential_encryption_key_missing");
      assert.ok(!JSON.stringify(audit).includes(PERSONAL_SECRET), "failure audit must not contain the secret");

      const row = await createSqliteConnectorInstanceCredentialStore({
        env: { [CREDENTIAL_ENCRYPTION_KEY_ENV]: TEST_KEY },
      }).getMetadata("cin_gmail_personal");
      assert.equal(row, null, "no credential row should be written without an encryption key");
    });
  });
});

test("capture rejects foreign and non-static-secret connections without storing credentials", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "gmail");
      await registerConnector(asUrl, "anthropic");
      await seedInstance({
        connectorId: "gmail",
        connectorInstanceId: "cin_gmail_foreign",
        ownerSubjectId: "owner_other",
      });
      await seedInstance({ connectorId: "anthropic", connectorInstanceId: "cin_anthropic_personal" });
      const cookie = await login(asUrl);

      const foreign = await captureCredential(asUrl, cookie, "cin_gmail_foreign", PERSONAL_SECRET);
      assert.equal(foreign.status, 403);
      assert.equal(errorOf(foreign.body).code, "connector_instance_owner_mismatch");
      assert.ok(!foreign.text.includes(PERSONAL_SECRET));

      const nonStatic = await captureCredential(asUrl, cookie, "cin_anthropic_personal", PERSONAL_SECRET);
      assert.equal(nonStatic.status, 409);
      assert.equal(errorOf(nonStatic.body).code, "static_secret_credential_unsupported");
      assert.ok(!nonStatic.text.includes(PERSONAL_SECRET));
      const nonStaticAudit = findCaptureAuditEvent(nonStatic.resp);
      assert.equal(nonStaticAudit.status, "failed");
      assert.equal(errorOf(dataOf(nonStaticAudit)).code, "static_secret_credential_unsupported");
      assert.ok(!JSON.stringify(nonStaticAudit).includes(PERSONAL_SECRET));

      const store = createSqliteConnectorInstanceCredentialStore({
        env: { [CREDENTIAL_ENCRYPTION_KEY_ENV]: TEST_KEY },
      });
      assert.equal(await store.getMetadata("cin_gmail_foreign"), null);
      assert.equal(await store.getMetadata("cin_anthropic_personal"), null);
    });
  });
});

test("capture rejects wrong credential kind with a non-secret audit event", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "gmail");
      await seedInstance({ connectorId: "gmail", connectorInstanceId: "cin_gmail_personal" });
      const cookie = await login(asUrl);

      const { status, body, text, resp } = await captureCredential(
        asUrl,
        cookie,
        "cin_gmail_personal",
        PERSONAL_SECRET,
        "personal_access_token"
      );
      assert.equal(status, 400);
      assert.equal(errorOf(body).code, "credential_kind_mismatch");
      assert.ok(!text.includes(PERSONAL_SECRET), "credential-kind failure must not echo the secret");

      const audit = findCaptureAuditEvent(resp);
      assert.equal(audit.status, "failed");
      assert.equal(dataOf(audit).credential_kind, "personal_access_token");
      assert.equal(errorOf(dataOf(audit)).code, "credential_kind_mismatch");
      assert.ok(!JSON.stringify(audit).includes(PERSONAL_SECRET), "audit must not contain the secret");

      const store = createSqliteConnectorInstanceCredentialStore({
        env: { [CREDENTIAL_ENCRYPTION_KEY_ENV]: TEST_KEY },
      });
      assert.equal(await store.getMetadata("cin_gmail_personal"), null);
    });
  });
});
