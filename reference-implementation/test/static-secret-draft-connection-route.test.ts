// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { listSpineEventsPage } from "../lib/spine.ts";
import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { createSqliteConnectorInstanceCredentialStore } from "../server/stores/connector-instance-credential-store.ts";
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from "../server/stores/credential-encryption.ts";

const REGEXP_1 = /<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/;

// Integration coverage for the owner-session static-secret DRAFT-connection
// route — the first-connection lifecycle that creates an invisible `draft`
// instead of a phantom active row. See
// add-static-secret-owner-session-connect-path design Decision 4.

const OWNER_PASSWORD = "static-secret-draft-owner-password";
const OWNER_SUBJECT_ID = "owner_local";
const TEST_KEY = "static-secret-draft-test-key";
const SECRET = "draft app password synthetic";

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

// Permissive deterministic prober so capturing a probe-bearing connector (gmail)
// in these draft/capture mechanics tests does not trigger a real network probe.
// Synchronous validation rejection is proven separately in
// static-secret-credential-probe-route.test.js.
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

// Owner-auth-disabled harness for the first-ingest-activation tests, which need
// an owner BEARER token (device flow) in addition to the owner-session draft
// surface. With an empty owner password the default owner session is active
// (so `/_ref/...` cookie routes need no login) and `/device/approve` issues a
// bearer token without a CSRF-gated owner session — mirroring
// owner-connection-delete.test.js. The auth-rejection cases above keep the
// password-protected harness.
async function withOpenServer(fn: (harness: { asUrl: string; rsUrl: string }) => Promise<void>): Promise<void> {
  const server = await startServer({
    asPort: 0,
    autoEnrollEligibleSchedules: false,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    ownerAuthSubjectId: OWNER_SUBJECT_ID,
    quiet: true,
    rsPort: 0,
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
    // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
    const firstPair = header.split(";")[0];
    if (firstPair?.startsWith(`${name}=`)) {
      return firstPair;
    }
  }
  return null;
}

function extractCsrfFieldValue(html: string): string | null {
  const match = html.match(REGEXP_1);
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
    body: new URLSearchParams({ _csrf: csrfField || "", password: OWNER_PASSWORD, return_to: "/" }).toString(),
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
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(loadManifest(name)),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(resp.status, 201, `register ${name} failed: ${resp.status}`);
}

async function issueOwnerToken(asUrl: string, subjectId = OWNER_SUBJECT_ID): Promise<string> {
  const clientId = "cli_longview";
  const { body: deviceBody } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: String(deviceBody.user_code) }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: String(deviceBody.device_code),
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return String(tokenBody.access_token);
}

// biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
async function ingest(
  rsUrl: string,
  ownerToken: string,
  connectorId: string,
  connectionId: string,
  stream: string,
  records: Array<{ id: string; emitted_at: string; [key: string]: unknown }>
): Promise<JsonResult> {
  const lines = records
    .map((record) => JSON.stringify({ data: record, emitted_at: record.emitted_at, key: record.id }))
    .join("\n");
  const url =
    `${rsUrl}/v1/ingest/${encodeURIComponent(stream)}` +
    `?connector_id=${encodeURIComponent(connectorId)}` +
    `&connector_instance_id=${encodeURIComponent(connectionId)}`;
  return fetchJson(url, {
    body: lines,
    headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/x-ndjson" },
    method: "POST",
  });
}

// biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
async function createDraft(
  asUrl: string,
  cookie: string,
  connectorId: string,
  setupFields: Record<string, unknown> = { account_email: "owner@example.com" },
  displayName?: string
): Promise<JsonResult> {
  return fetchJson(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/draft-connection`, {
    body: JSON.stringify({
      setup_fields: setupFields,
      ...(displayName === undefined ? {} : { display_name: displayName }),
    }),
    headers: { Accept: "application/json", "Content-Type": "application/json", Cookie: cookie },
    method: "POST",
  });
}

// biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
async function getSetup(asUrl: string, cookie: string, connectorId: string): Promise<JsonResult> {
  return fetchJson(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/static-secret-setup`, {
    headers: { Accept: "application/json", Cookie: cookie },
  });
}

// biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
async function listConnections(asUrl: string, cookie: string): Promise<JsonResult> {
  return fetchJson(`${asUrl}/_ref/connections`, {
    headers: { Accept: "application/json", Cookie: cookie },
  });
}

// The owner-facing dashboard/Sources/Syncs summary feed — deliberately
// DIFFERENT from `/_ref/connections` (see fix-pending-connection-discovery
// design): this is the one surface that includes `draft` rows, so a freshly
// created connection is discoverable before its first ingest.
// biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
async function listConnectors(asUrl: string, cookie: string): Promise<JsonResult> {
  return fetchJson(`${asUrl}/_ref/connectors?limit=100`, {
    headers: { Accept: "application/json", Cookie: cookie },
  });
}

function findDraftAudit(resp: Response, outcome: string) {
  const traceId = resp.headers.get("PDPP-Reference-Trace-Id");
  assert.ok(traceId?.startsWith("trc_"), "draft response should carry a trace id");
  assert.ok(traceId);
  const page = listSpineEventsPage("trace", traceId, { limit: 20 });
  const event = page.events.find(
    (entry) => entry.event_type === "owner.connection.static_secret_draft.create" && entry.status === outcome
  );
  assert.ok(event, `expected static-secret draft.create audit (${outcome})`);
  return event;
}

function requireString(value: unknown, label: string): string {
  assert.ok(typeof value === "string" && value.length > 0, `expected ${label} to be a non-empty string`);
  return value;
}

function errorOf(body: Record<string, unknown>): Record<string, unknown> {
  // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
  const error = body.error;
  assert.ok(typeof error === "object" && error !== null, "expected body.error to be an object");
  return error as Record<string, unknown>;
}

function dataOf(event: { data: unknown }): Record<string, unknown> {
  const { data } = event;
  assert.ok(typeof data === "object" && data !== null, "expected event.data to be an object");
  return data as Record<string, unknown>;
}

function dataArrayOf(body: Record<string, unknown>): Record<string, unknown>[] {
  const { data } = body;
  assert.ok(Array.isArray(data), "expected body.data to be an array");
  return data as Record<string, unknown>[];
}

function deploymentReadinessOf(body: Record<string, unknown>): Record<string, unknown> {
  const readiness = body.deployment_readiness;
  assert.ok(typeof readiness === "object" && readiness !== null, "expected body.deployment_readiness to be an object");
  return readiness as Record<string, unknown>;
}

function credentialCaptureOf(body: Record<string, unknown>): { fields: Record<string, unknown>[] } {
  const capture = body.credential_capture;
  assert.ok(typeof capture === "object" && capture !== null, "expected body.credential_capture to be an object");
  // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
  const fields = (capture as Record<string, unknown>).fields;
  assert.ok(Array.isArray(fields), "expected body.credential_capture.fields to be an array");
  return { fields: fields as Record<string, unknown>[] };
}

function nextStepOf(body: Record<string, unknown>): Record<string, unknown> {
  const nextStep = body.next_step;
  assert.ok(typeof nextStep === "object" && nextStep !== null, "expected body.next_step to be an object");
  return nextStep as Record<string, unknown>;
}

function ownerStateOf(row: Record<string, unknown>): Record<string, unknown> | undefined {
  const ownerState = row.owner_state;
  if (ownerState === undefined) {
    return;
  }
  assert.ok(typeof ownerState === "object" && ownerState !== null, "expected row.owner_state to be an object");
  return ownerState as Record<string, unknown>;
}

test("owner creates an invisible draft, captures onto it, and it stays hidden until ingest", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "gmail");
      const cookie = await login(asUrl);

      // Create a draft.
      const created = await createDraft(asUrl, cookie, "gmail");
      assert.equal(created.status, 201);
      assert.equal(created.body.object, "static_secret_draft_connection");
      assert.equal(created.body.connector_id, "gmail");
      assert.equal(created.body.status, "draft");
      assert.equal(created.body.credential_kind, "app_password");
      assert.equal(created.body.display_name, "Gmail - owner@example.com");
      assert.equal(nextStepOf(created.body).kind, "capture_static_secret_credential");
      const connectionId = requireString(created.body.connection_id, "created.body.connection_id");

      // Audit is non-secret and owner-session.
      const audit = findDraftAudit(created.resp, "succeeded");
      assert.equal(audit.actor_type, "owner_session");
      assert.equal(dataOf(audit).connection_id, connectionId);
      assert.equal(dataOf(audit).connector_id, "gmail");

      // Invisible on the connection list.
      const list = await listConnections(asUrl, cookie);
      assert.equal(list.status, 200);
      assert.ok(
        !dataArrayOf(list.body).some(
          (c) => c.connection_id === connectionId || c.connector_instance_id === connectionId
        ),
        "draft must not appear on /_ref/connections"
      );

      // Owner-session capture seals a credential onto the draft.
      const captured = await fetchJson(
        `${asUrl}/_ref/connections/${encodeURIComponent(connectionId)}/static-secret-credential`,
        {
          body: JSON.stringify({ credential_kind: "app_password", secret: SECRET }),
          headers: { Accept: "application/json", "Content-Type": "application/json", Cookie: cookie },
          method: "POST",
        }
      );
      assert.equal(captured.status, 201, `capture onto draft should succeed: ${captured.text}`);
      assert.equal(captured.body.connection_id, connectionId);
      assert.ok(!captured.text.includes(SECRET), "capture response must not echo the secret");

      // Still invisible after capture (no ingest yet).
      const afterCapture = await listConnections(asUrl, cookie);
      assert.ok(
        !dataArrayOf(afterCapture.body).some((c) => c.connection_id === connectionId),
        "draft stays invisible until first ingest"
      );

      // The secret is recoverable only with the operator key — never on a read.
      const store = createSqliteConnectorInstanceCredentialStore({
        env: { [CREDENTIAL_ENCRYPTION_KEY_ENV]: TEST_KEY },
      });
      const recovered = await store.recoverSecret({
        connectorInstanceId: connectionId,
        ownerSubjectId: OWNER_SUBJECT_ID,
      });
      assert.equal(recovered.secret, SECRET);
    });
  });
});

test("static-secret setup descriptor is manifest-authored and readiness-gated", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "gmail");
      const cookie = await login(asUrl);
      const { status, body, text } = await getSetup(asUrl, cookie, "gmail");
      assert.equal(status, 200, text);
      assert.equal(body.object, "static_secret_setup");
      assert.equal(body.connector_id, "gmail");
      assert.equal(body.credential_kind, "app_password");
      assert.equal(deploymentReadinessOf(body).state, "ready");
      // Gmail has a synchronous credential probe, so the owner setup descriptor
      // advertises synchronous validation; the Console form reads this to render
      // the validate-then-activate flow generically.
      assert.equal(body.validation, "synchronous");
      assert.ok(
        credentialCaptureOf(body).fields.some(
          (field) => field.name === "account_email" && field.type === "email" && field.secret === false
        ),
        "Gmail manifest must declare the account email field"
      );
      assert.ok(
        credentialCaptureOf(body).fields.some(
          (field) =>
            field.name === "secret" &&
            field.secret === true &&
            field.help_url === "https://myaccount.google.com/apppasswords"
        ),
        "Gmail manifest must declare the app-password help URL"
      );
    });
  });
});

test("owner-selected display name is stored on the static-secret draft", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "gmail");
      const cookie = await login(asUrl);
      const created = await createDraft(
        asUrl,
        cookie,
        "gmail",
        { account_email: "owner@example.com" },
        "Primary account"
      );
      assert.equal(created.status, 201, created.text);
      assert.equal(created.body.display_name, "Primary account");

      const row = getDb()
        .prepare("SELECT display_name FROM connector_instances WHERE connector_instance_id = ?")
        .get(created.body.connection_id) as { display_name?: string } | undefined;
      assert.equal(row?.display_name, "Primary account");
    });
  });
});

test("draft create blocks before row creation when credential key provider is missing", async () => {
  await withCredentialKey(null, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "gmail");
      const cookie = await login(asUrl);
      const { status, body, text, resp } = await createDraft(asUrl, cookie, "gmail");
      assert.equal(status, 503, text);
      assert.equal(errorOf(body).code, "credential_encryption_key_missing");
      const audit = findDraftAudit(resp, "failed");
      assert.equal(errorOf(dataOf(audit)).code, "credential_encryption_key_missing");

      const list = await listConnections(asUrl, cookie);
      assert.equal(list.status, 200);
      assert.equal(dataArrayOf(list.body).length, 0, "missing key provider must not create a draft");
      const rowCountRow = getDb().prepare("SELECT COUNT(*) AS count FROM connector_instances").get() as
        | { count: number }
        | undefined;
      assert.ok(rowCountRow, "expected a row count");
      assert.equal(rowCountRow.count, 0, "missing key provider must not write a connector_instances row");
    });
  });
});

test("draft create validates manifest-declared non-secret setup fields", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "gmail");
      const cookie = await login(asUrl);

      const missing = await createDraft(asUrl, cookie, "gmail", {});
      assert.equal(missing.status, 400);
      assert.equal(errorOf(missing.body).code, "missing_setup_field");

      const unknown = await createDraft(asUrl, cookie, "gmail", {
        account_email: "owner@example.com",
        unexpected: "value",
      });
      assert.equal(unknown.status, 400);
      assert.equal(errorOf(unknown.body).code, "unknown_setup_field");

      const overlongName = await createDraft(
        asUrl,
        cookie,
        "gmail",
        { account_email: "owner@example.com" },
        "x".repeat(201)
      );
      assert.equal(overlongName.status, 400);
      assert.equal(errorOf(overlongName.body).code, "invalid_request");
      assert.equal(errorOf(overlongName.body).param, "display_name");

      const list = await listConnections(asUrl, cookie);
      assert.equal(dataArrayOf(list.body).length, 0, "invalid setup fields must not create a draft");
    });
  });
});

test("two drafts for one connector are two distinct connection_ids", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "gmail");
      const cookie = await login(asUrl);
      const a = await createDraft(asUrl, cookie, "gmail", { account_email: "personal@example.com" });
      const b = await createDraft(asUrl, cookie, "gmail", { account_email: "work@example.com" });
      assert.equal(a.status, 201);
      assert.equal(b.status, 201);
      assert.notEqual(a.body.connection_id, b.body.connection_id);
      // Both invisible.
      const list = await listConnections(asUrl, cookie);
      assert.equal(dataArrayOf(list.body).length, 0, "both drafts are hidden from the listing");
    });
  });
});

test("draft create is rejected for a non-static-secret connector", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "whatsapp");
      const cookie = await login(asUrl);
      const { status, body, resp } = await createDraft(asUrl, cookie, "whatsapp");
      assert.equal(status, 409);
      assert.equal(errorOf(body).code, "static_secret_credential_unsupported");
      const audit = findDraftAudit(resp, "failed");
      assert.equal(errorOf(dataOf(audit)).code, "static_secret_credential_unsupported");
    });
  });
});

test("owner-agent bearer without an owner session cannot create a draft", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "gmail");
      const { status, body } = await fetchJson(`${asUrl}/_ref/connectors/gmail/draft-connection`, {
        headers: {
          Accept: "application/json",
          Authorization: "Bearer owner-agent-token-that-is-not-a-cookie",
        },
        method: "POST",
      });
      assert.equal(status, 401);
      assert.equal(errorOf(body).code, "owner_session_required");
    });
  });
});

test("first ingest with records flips the draft to active and makes it visible", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withOpenServer(async ({ asUrl, rsUrl }) => {
      await registerConnector(asUrl, "gmail");
      const cookie = "";
      const created = await createDraft(asUrl, cookie, "gmail");
      assert.equal(created.status, 201, `draft create: ${created.text}`);
      const connectionId = requireString(created.body.connection_id, "created.body.connection_id");

      const preIngestRow = getDb()
        .prepare("SELECT source_binding_json FROM connector_instances WHERE connector_instance_id = ?")
        .get(connectionId) as { source_binding_json: string };
      assert.equal(JSON.parse(preIngestRow.source_binding_json).kind, "static_secret_draft");

      const ownerToken = await issueOwnerToken(asUrl);
      const ingested = await ingest(rsUrl, ownerToken, "gmail", connectionId, "messages", [
        { emitted_at: "2026-06-02T12:00:00.000Z", id: "m1", subject: "hello" },
      ]);
      assert.equal(ingested.status, 200, `ingest into draft should succeed: ${ingested.text}`);
      assert.equal(ingested.body.records_accepted, 1);

      // The draft is now active and visible.
      const list = await listConnections(asUrl, cookie);
      const visible = dataArrayOf(list.body).find(
        (c) => c.connection_id === connectionId || c.connector_instance_id === connectionId
      );
      assert.ok(visible, "connection is visible after first ingest");
      assert.equal(visible.status, "active");

      // Regression coverage for the setup-shell promotion gap: first
      // successful ingest must promote the binding off `static_secret_draft`
      // to the durable `static_secret` kind, preserving `setup_fields` —
      // not just flip status. Otherwise a LATER revoke of this real,
      // fully-collected connection would wrongly hide it from Sources
      // (RETIRED_SETUP_SHELL_BINDING_KINDS), exactly like the browser
      // enrollment shell bug this mirrors.
      const postIngestRow = getDb()
        .prepare("SELECT source_binding_json FROM connector_instances WHERE connector_instance_id = ?")
        .get(connectionId) as { source_binding_json: string };
      const postIngestBinding = JSON.parse(postIngestRow.source_binding_json);
      assert.equal(postIngestBinding.kind, "static_secret", "binding kind moved off static_secret_draft");
      assert.deepEqual(
        postIngestBinding.setup_fields,
        { account_email: "owner@example.com" },
        "setup_fields survive promotion — read on every credential probe/run, not just at setup"
      );

      // Revoking this now-real, fully-collected connection must NOT hide it
      // from Sources — it is an ordinary revoked connection, not retired
      // setup residue.
      const revoked = await fetch(`${rsUrl}/v1/owner/connections/${encodeURIComponent(connectionId)}/revoke`, {
        headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(revoked.status, 200, `revoke should succeed: ${await revoked.text()}`);

      const listAfterRevoke = await listConnections(asUrl, cookie);
      const visibleAfterRevoke = dataArrayOf(listAfterRevoke.body).find(
        (c) => c.connection_id === connectionId || c.connector_instance_id === connectionId
      );
      assert.ok(visibleAfterRevoke, "revoked-after-promotion connection stays visible on /_ref/connections");
      assert.equal(visibleAfterRevoke.status, "revoked");
    });
  });
});

test("zero-record ingest leaves the draft invisible (no phantom active connection)", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withOpenServer(async ({ asUrl, rsUrl }) => {
      await registerConnector(asUrl, "gmail");
      const cookie = "";
      const created = await createDraft(asUrl, cookie, "gmail");
      assert.equal(created.status, 201, `draft create: ${created.text}`);
      const connectionId = requireString(created.body.connection_id, "created.body.connection_id");

      const ownerToken = await issueOwnerToken(asUrl);
      // Empty body → zero records accepted.
      const ingested = await ingest(rsUrl, ownerToken, "gmail", connectionId, "messages", []);
      assert.equal(ingested.status, 200);
      assert.equal(ingested.body.records_accepted, 0);

      // Still invisible; no active row.
      const list = await listConnections(asUrl, cookie);
      assert.ok(
        !dataArrayOf(list.body).some(
          (c) => c.connection_id === connectionId || c.connector_instance_id === connectionId
        ),
        "a zero-record ingest must not activate or reveal the draft"
      );
    });
  });
});

// ─── fix-pending-connection-discovery regression coverage ──────────────────
//
// Root cause: a freshly created draft connection was invisible on every
// owner-navigable list (Sources, Syncs, source-detail-by-id) until its first
// successful ingest, discoverable only via a push notification's run-scoped
// deep link. The fix keeps `/_ref/connections` (raw connection listing)
// hiding drafts exactly as before, but makes `/_ref/connectors` (the
// dashboard/Sources/Syncs summary feed) include them as an explicit
// `setup_in_progress` owner state — never healthy, never silently absent.
//
// These tests pin the pre-first-record (draft, just created) and the
// waiting-owner-action (draft, credential captured, no ingest yet) states on
// the real summary feed. The active-run / failed-run / success-promotion
// states for an ACTIVATED connection are covered by the owner-state.test.js
// exhaustive cross-product (collecting / system_degraded / needs_owner /
// healthy resolvers) and by this file's existing
// 'first ingest ... flips the draft to active and makes it visible' test —
// this file adds the piece that was missing: the draft itself must be
// discoverable, distinctly labeled, and never counted healthy.

test("pre-first-record: a freshly created draft is discoverable on /_ref/connectors as setup_in_progress, still hidden from /_ref/connections", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "gmail");
      const cookie = await login(asUrl);

      const created = await createDraft(asUrl, cookie, "gmail");
      assert.equal(created.status, 201, `draft create: ${created.text}`);
      const connectionId = requireString(created.body.connection_id, "created.body.connection_id");

      // Still hidden from the raw connection list (unchanged contract).
      const connections = await listConnections(asUrl, cookie);
      assert.ok(
        !dataArrayOf(connections.body).some((c) => c.connection_id === connectionId),
        "draft must still be hidden from /_ref/connections"
      );

      // Discoverable on the dashboard/Sources/Syncs summary feed.
      const connectors = await listConnectors(asUrl, cookie);
      assert.equal(connectors.status, 200);
      const row = dataArrayOf(connectors.body).find(
        (c) => c.connection_id === connectionId || c.connector_instance_id === connectionId
      );
      assert.ok(row, "draft connection must be discoverable on /_ref/connectors before its first record");
      assert.equal(row.status, "draft");
      assert.equal(ownerStateOf(row)?.resolver, "setup_in_progress");
      assert.equal(ownerStateOf(row)?.owner_of_state, "owner");
      // Never healthy, never a fabricated defect tone — the owner state is
      // the honest signal; the legacy verdict pill is not asserted here
      // (it may still read grey/unmeasured), only that owner_state is correct.
      assert.notEqual(ownerStateOf(row)?.resolver, "healthy");
    });
  });
});

test("setup-status resolves a draft by its exact connection_id, not by connector-key fallback", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "gmail");
      const cookie = await login(asUrl);

      const created = await createDraft(asUrl, cookie, "gmail");
      assert.equal(created.status, 201, `draft create: ${created.text}`);
      const connectionId = requireString(created.body.connection_id, "created.body.connection_id");
      assert.notEqual(
        connectionId,
        "gmail",
        "the durable connection_id must differ from the bare connector key for this regression to be meaningful"
      );

      // The exact durable connection_id (what every in-app affordance links
      // with — Sources row, next-action, passport, Syncs card) resolves.
      const byExactId = await fetchJson(`${asUrl}/_ref/connections/${encodeURIComponent(connectionId)}/setup-status`, {
        headers: { Accept: "application/json", Cookie: cookie },
      });
      assert.equal(byExactId.status, 200, `exact connection_id must resolve: ${byExactId.text}`);
      assert.equal(byExactId.body.connection_id, connectionId);

      // The bare connector-key (a route selector some other route resolves via
      // connector-key fallback, e.g. the `/sources/:connector` records route)
      // is NOT a valid setup-status selector: this route only accepts an
      // explicit connector_instance_id, so it must 404 rather than silently
      // resolving against the wrong resource or a different draft. Any
      // in-app redirect into this route must therefore always carry the
      // resolved durable connection_id, never a raw connector-key route
      // segment (fix-pending-connection-discovery revision, Finding #1).
      const byConnectorKey = await fetchJson(`${asUrl}/_ref/connections/gmail/setup-status`, {
        headers: { Accept: "application/json", Cookie: cookie },
      });
      assert.equal(
        byConnectorKey.status,
        404,
        `bare connector-key must not resolve setup-status: ${byConnectorKey.text}`
      );
      assert.equal(errorOf(byConnectorKey.body).code, "connector_instance_not_found");
    });
  });
});

test("credential captured with first sync active reads collecting on /_ref/connectors, not healthy or degraded", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "gmail");
      const cookie = await login(asUrl);

      const created = await createDraft(asUrl, cookie, "gmail");
      const connectionId = requireString(created.body.connection_id, "created.body.connection_id");

      const captured = await fetchJson(
        `${asUrl}/_ref/connections/${encodeURIComponent(connectionId)}/static-secret-credential`,
        {
          body: JSON.stringify({ credential_kind: "app_password", secret: SECRET }),
          headers: { Accept: "application/json", "Content-Type": "application/json", Cookie: cookie },
          method: "POST",
        }
      );
      assert.equal(captured.status, 201, `capture onto draft should succeed: ${captured.text}`);

      const connectors = await listConnectors(asUrl, cookie);
      const row = dataArrayOf(connectors.body).find(
        (c) => c.connection_id === connectionId || c.connector_instance_id === connectionId
      );
      assert.ok(row, "draft with a captured credential but no run yet must still be discoverable");
      assert.equal(row.status, "draft");
      assert.equal(ownerStateOf(row)?.resolver, "collecting");
      assert.notEqual(ownerStateOf(row)?.resolver, "healthy");
      assert.notEqual(ownerStateOf(row)?.resolver, "system_degraded");
    });
  });
});

test("success promotion: first successful ingest flips owner_state from setup_in_progress to a real health resolver, and the connection stays visible", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withOpenServer(async ({ asUrl, rsUrl }) => {
      await registerConnector(asUrl, "gmail");
      const cookie = "";
      const created = await createDraft(asUrl, cookie, "gmail");
      const connectionId = requireString(created.body.connection_id, "created.body.connection_id");

      // Before ingest: setup_in_progress on the summary feed.
      const before = await listConnectors(asUrl, cookie);
      const beforeRow = dataArrayOf(before.body).find((c) => c.connection_id === connectionId);
      assert.equal((beforeRow && ownerStateOf(beforeRow))?.resolver, "setup_in_progress");

      const ownerToken = await issueOwnerToken(asUrl);
      const ingested = await ingest(rsUrl, ownerToken, "gmail", connectionId, "messages", [
        { emitted_at: "2026-06-02T12:00:00.000Z", id: "m1", subject: "hello" },
      ]);
      assert.equal(ingested.status, 200, `ingest into draft should succeed: ${ingested.text}`);
      assert.equal(ingested.body.records_accepted, 1, `expected 1 record accepted: ${ingested.text}`);

      // No manual cache surgery: `maybeActivateDraftAfterIngest`
      // (rs-mutation.ts) invalidates the dashboard/Sources/Syncs summary
      // cache itself as part of the real first-ingest activation path (same
      // invalidation every other connection-mutating route performs), so the
      // very next `/_ref/connectors` read below observes `active` immediately
      // — this proves that production invalidation, not a test workaround.

      // After ingest: active, visible on BOTH feeds, and owner_state has moved
      // off setup_in_progress (the connection now has real health evidence).
      const connections = await listConnections(asUrl, cookie);
      const connectionsRow = dataArrayOf(connections.body).find(
        (c) => c.connection_id === connectionId || c.connector_instance_id === connectionId
      );
      assert.ok(
        connectionsRow,
        `activated connection must be visible on /_ref/connections: ${JSON.stringify(connections.body)}`
      );
      assert.equal(connectionsRow.status, "active");

      const after = await listConnectors(asUrl, cookie);
      const afterRow = dataArrayOf(after.body).find((c) => c.connection_id === connectionId);
      assert.ok(afterRow, "activated connection must still be visible on /_ref/connectors");
      assert.equal(afterRow.status, "active");
      assert.notEqual(ownerStateOf(afterRow)?.resolver, "setup_in_progress");
    });
  });
});
