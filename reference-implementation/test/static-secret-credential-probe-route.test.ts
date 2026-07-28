// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Owner-session static-secret capture route: synchronous credential probe.
//
// Proves the owner-journey flow-design B1 validation moment end-to-end through
// the real route, with the probe INJECTED as a deterministic double
// (`opts.staticSecretCredentialProber`) so no live provider call is ever made:
//
//   - a rejected credential returns a typed validation error and stores NOTHING;
//   - a valid credential stores the secret and surfaces the account identity;
//   - a connector whose prober self-reports `skipped` keeps the first-sync path
//     (credential stored, no identity echo, validation = first_sync);
//   - the submitted secret never appears in the response, body, or audit event.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { listSpineEventsPage } from "../lib/spine.ts";
import { startServer } from "../server/index.ts";
import { createSqliteConnectorInstanceCredentialStore } from "../server/stores/connector-instance-credential-store.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from "../server/stores/credential-encryption.ts";

const REGEXP_1 = /<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/;
const REGEXP_2 = /Google rejected this app password/;

const OWNER_PASSWORD = "static-secret-probe-owner-password";
const OWNER_SUBJECT_ID = "owner_local";
const TEST_KEY = "static-secret-probe-test-key";
const GOOD_SECRET = "valid synthetic app password";
const BAD_SECRET = "rejected synthetic app password";
const GOOD_PAT = "ghp_valid_synthetic_token";
const GMAIL_ADDRESS = "the owner@example.com";

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

async function withCredentialKey<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const old = process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
  process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = value;
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

interface ProberCall {
  connectorKey: string;
  context: { setupFields?: Record<string, unknown> } | undefined;
  secret: string;
}

interface ProberResult {
  code?: string;
  detail?: unknown;
  identity?: string;
  message?: string;
  ok: boolean;
  skipped?: boolean;
}

// A deterministic prober double standing in for the live package probe + IMAP/
// GitHub transport. It records every invocation (so tests can assert the
// non-secret context the route passed) and decides accept/reject/skip purely
// from the connector key + secret value — never touching the network.
function makeProberDouble(): { calls: ProberCall[]; prober: (args: ProberCall) => Promise<ProberResult> } {
  const calls: ProberCall[] = [];
  // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
  const prober = async ({ connectorKey, context, secret }: ProberCall): Promise<ProberResult> => {
    calls.push({ connectorKey, context, secret });
    // `ynab` has no synchronous probe in this scenario: self-report skipped.
    if (connectorKey === "ynab") {
      return { ok: true, skipped: true };
    }
    if (secret === BAD_SECRET) {
      return {
        code: "gmail_credential_rejected",
        message: "Google rejected this app password for that mailbox. Create a fresh app password and try again.",
        ok: false,
      };
    }
    if (connectorKey === "gmail") {
      const address = context?.setupFields?.account_email ?? null;
      return { detail: null, identity: typeof address === "string" ? address : "unknown@example.com", ok: true };
    }
    if (connectorKey === "github") {
      return { detail: null, identity: "octocat", ok: true };
    }
    return { ok: true, skipped: true };
  };
  return { calls, prober };
}

async function withServer(fn: (harness: { asUrl: string; proberCalls: ProberCall[] }) => Promise<void>): Promise<void> {
  const { calls, prober } = makeProberDouble();
  const server = await startServer({
    asPort: 0,
    autoEnrollEligibleSchedules: false,
    dbPath: ":memory:",
    ownerAuthPassword: OWNER_PASSWORD,
    ownerAuthSubjectId: OWNER_SUBJECT_ID,
    quiet: true,
    rsPort: 0,
    staticSecretAutoResume: false,
    staticSecretCredentialProber: prober,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await fn({ asUrl, proberCalls: calls });
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
  connector_key: string;
  [key: string]: unknown;
}

function loadManifest(name: string): ConnectorManifest {
  return JSON.parse(
    readFileSync(new URL(`../../packages/polyfill-connectors/manifests/${name}.json`, import.meta.url), "utf8")
  ) as ConnectorManifest;
}

async function registerManifest(asUrl: string, manifest: ConnectorManifest): Promise<void> {
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(resp.status, 201, `register ${manifest.connector_key} failed: ${resp.status}`);
}

async function registerConnector(asUrl: string, name: string): Promise<void> {
  await registerManifest(asUrl, loadManifest(name));
}

function requireString(value: unknown, label: string): string {
  assert.ok(typeof value === "string" && value.length > 0, `expected ${label} to be a non-empty string`);
  return value;
}

function errorOf(body: Record<string, unknown>): { code: unknown; message: unknown } {
  // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
  const error = body.error;
  assert.ok(typeof error === "object" && error !== null, "expected body.error to be an object");
  return error as { code: unknown; message: unknown };
}

function identityOf(body: Record<string, unknown>): { account_identity: unknown } {
  // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
  const identity = body.identity;
  assert.ok(typeof identity === "object" && identity !== null, "expected body.identity to be an object");
  return identity as { account_identity: unknown };
}

function credentialOf(body: Record<string, unknown>): { present: unknown } {
  // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
  const credential = body.credential;
  assert.ok(typeof credential === "object" && credential !== null, "expected body.credential to be an object");
  return credential as { present: unknown };
}

// A synthetic static-secret manifest for a connector with NO synchronous probe.
// Reuses ynab's identity (the real ynab manifest has no setup block, so it never
// collides) to exercise the first-sync path at the route level: the prober
// self-reports `skipped`, so the credential is stored without an identity echo.
function syntheticNoProbeStaticSecretManifest() {
  return {
    capabilities: { public_listing: { listed: true, status: "proven" } },
    connector_id: "https://registry.pdpp.org/connectors/ynab",
    connector_key: "ynab",
    display_name: "YNAB",
    manifest_uri: "https://registry.pdpp.org/connectors/ynab",
    protocol_version: "0.1.0",
    runtime_requirements: { bindings: { network: { required: true } } },
    setup: {
      credential_capture: {
        fields: [{ label: "YNAB token", name: "secret", required: true, secret: true, type: "password" }],
        kind: "personal_access_token",
        label: "YNAB personal access token",
      },
      modality: "static_secret",
    },
    streams: [
      {
        incremental: false,
        name: "accounts",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "0.0.1-test",
  };
}

// biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
async function createDraft(
  asUrl: string,
  cookie: string,
  connectorId: string,
  setupFields: Record<string, unknown> = {}
): Promise<JsonResult> {
  return fetchJson(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/draft-connection`, {
    body: JSON.stringify({ setup_fields: setupFields }),
    headers: { Accept: "application/json", "Content-Type": "application/json", Cookie: cookie },
    method: "POST",
  });
}

// biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
async function capture(
  asUrl: string,
  cookie: string,
  connectionId: string,
  secret: string,
  credentialKind: string
): Promise<JsonResult> {
  return fetchJson(`${asUrl}/_ref/connections/${encodeURIComponent(connectionId)}/static-secret-credential`, {
    body: JSON.stringify({ credential_kind: credentialKind, secret }),
    headers: { Accept: "application/json", "Content-Type": "application/json", Cookie: cookie },
    method: "POST",
  });
}

// biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
async function seedActiveStaticSecretConnection({
  connectorId,
  connectorInstanceId,
  displayName,
}: {
  connectorId: string;
  connectorInstanceId: string;
  displayName: string;
}) {
  const store = createSqliteConnectorInstanceStore();
  const now = "2026-06-10T18:00:00.000Z";
  return store.upsert({
    connectorId,
    connectorInstanceId,
    createdAt: now,
    displayName,
    ownerSubjectId: OWNER_SUBJECT_ID,
    sourceBinding: { account_hint: displayName },
    sourceBindingKey: connectorInstanceId,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
}

function captureAuditEvents(resp: Response) {
  const traceId = resp.headers.get("PDPP-Reference-Trace-Id");
  assert.ok(traceId?.startsWith("trc_"), "capture response should carry a trace id");
  assert.ok(traceId);
  return listSpineEventsPage("trace", traceId, { limit: 20 }).events.filter(
    (e) => e.event_type === "owner.connection.static_secret_credential.capture"
  );
}

test("a rejected probe returns a typed validation error and stores no credential", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl, proberCalls }) => {
      await registerConnector(asUrl, "gmail");
      const cookie = await login(asUrl);
      const draft = await createDraft(asUrl, cookie, "gmail", { account_email: GMAIL_ADDRESS });
      assert.equal(draft.status, 201);
      const connectionId = requireString(draft.body.connection_id, "draft.body.connection_id");

      const { status, body, resp, text } = await capture(asUrl, cookie, connectionId, BAD_SECRET, "app_password");

      // The route rejects with a generic typed code; the message is the
      // provider-named, owner-causal reason from the probe.
      assert.equal(status, 400);
      assert.equal(errorOf(body).code, "static_secret_credential_rejected");
      assert.match(String(errorOf(body).message), REGEXP_2);
      // The submitted secret never appears anywhere in the response.
      assert.ok(!text.includes(BAD_SECRET), "response must not echo the secret");

      // NOTHING was stored: the credential store has no metadata for this draft.
      const store = createSqliteConnectorInstanceCredentialStore();
      const meta = await store.getMetadata(connectionId);
      assert.equal(meta, null, "a rejected credential must not be stored");
      const instanceStore = createSqliteConnectorInstanceStore();
      const instance = await instanceStore.get(connectionId);
      assert.ok(instance, "expected a connector instance for the draft");
      assert.equal(instance.status, "revoked", "a rejected first-time draft must be retired");
      assert.ok(instance.revokedAt, "retired draft should carry revokedAt");

      // The probe was given the non-secret mailbox context, never echoed back.
      assert.equal(proberCalls.length, 1);
      // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
      const firstCall = proberCalls[0];
      assert.ok(firstCall, "expected a prober call");
      assert.equal(firstCall.connectorKey, "gmail");
      assert.equal(firstCall.context?.setupFields?.account_email, GMAIL_ADDRESS);

      // The audit event records the typed rejection code only — no secret.
      const events = captureAuditEvents(resp);
      const failed = events.find((e) => e.status === "failed");
      assert.ok(failed, "expected a failed capture audit event");
      const failedData = failed.data as { error?: { code?: unknown } } | undefined;
      assert.equal(failedData?.error?.code, "gmail_credential_rejected");
      assert.ok(!JSON.stringify(failed).includes(BAD_SECRET), "audit must not contain the secret");
    });
  });
});

test("a valid probe stores the credential and surfaces the account identity", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl, proberCalls }) => {
      await registerConnector(asUrl, "gmail");
      const cookie = await login(asUrl);
      const draft = await createDraft(asUrl, cookie, "gmail", { account_email: GMAIL_ADDRESS });
      const connectionId = requireString(draft.body.connection_id, "draft.body.connection_id");

      const { status, body, text } = await capture(asUrl, cookie, connectionId, GOOD_SECRET, "app_password");

      assert.equal(status, 201);
      assert.equal(body.object, "static_secret_credential_capture");
      assert.equal(body.validation, "synchronous");
      // The non-secret account identity is echoed; the secret is not.
      assert.equal(identityOf(body).account_identity, GMAIL_ADDRESS);
      assert.equal(credentialOf(body).present, true);
      assert.ok(!text.includes(GOOD_SECRET), "response must not echo the secret");

      // The credential WAS stored this time.
      const store = createSqliteConnectorInstanceCredentialStore();
      const meta = await store.getMetadata(connectionId);
      assert.ok(meta, "a valid credential must be stored");
      assert.equal(meta.credentialKind, "app_password");
      assert.equal(proberCalls.length, 1);
    });
  });
});

test("github: a valid token stores the credential and echoes the login identity", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "github");
      const cookie = await login(asUrl);
      const draft = await createDraft(asUrl, cookie, "github", {});
      const connectionId = requireString(draft.body.connection_id, "draft.body.connection_id");

      const { status, body } = await capture(asUrl, cookie, connectionId, GOOD_PAT, "personal_access_token");

      assert.equal(status, 201);
      assert.equal(body.validation, "synchronous");
      assert.equal(identityOf(body).account_identity, "octocat");
      const store = createSqliteConnectorInstanceCredentialStore();
      assert.ok(await store.getMetadata(connectionId), "a valid github token must be stored");
    });
  });
});

test("github: a rejected token is refused and stores nothing", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "github");
      const cookie = await login(asUrl);
      const draft = await createDraft(asUrl, cookie, "github", {});
      const connectionId = requireString(draft.body.connection_id, "draft.body.connection_id");

      const { status, body } = await capture(asUrl, cookie, connectionId, BAD_SECRET, "personal_access_token");

      assert.equal(status, 400);
      assert.equal(errorOf(body).code, "static_secret_credential_rejected");
      const store = createSqliteConnectorInstanceCredentialStore();
      assert.equal(await store.getMetadata(connectionId), null, "a rejected github token must not be stored");
      const instanceStore = createSqliteConnectorInstanceStore();
      const instance = await instanceStore.get(connectionId);
      assert.ok(instance, "expected a connector instance for the draft");
      assert.equal(instance.status, "revoked", "a rejected github draft must be retired");
    });
  });
});

test("a rejected rotation probe leaves an active connection active", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      const gmail = loadManifest("gmail");
      await registerManifest(asUrl, gmail);
      const cookie = await login(asUrl);
      const connectionId = "cin_active_probe_rotation";
      await seedActiveStaticSecretConnection({
        connectorId: gmail.connector_key,
        connectorInstanceId: connectionId,
        displayName: "Gmail - existing@example.com",
      });

      const { status, body } = await capture(asUrl, cookie, connectionId, BAD_SECRET, "app_password");

      assert.equal(status, 400);
      assert.equal(errorOf(body).code, "static_secret_credential_rejected");
      const credentialStore = createSqliteConnectorInstanceCredentialStore();
      assert.equal(
        await credentialStore.getMetadata(connectionId),
        null,
        "a rejected rotation must not store a credential"
      );
      const instanceStore = createSqliteConnectorInstanceStore();
      const instance = await instanceStore.get(connectionId);
      assert.ok(instance, "expected a connector instance for the seeded connection");
      assert.equal(instance.status, "active", "a rejected rotation must not revoke the active connection");
      assert.equal(instance.revokedAt, null);
    });
  });
});

test("a connector with no probe keeps the first-sync path (stores, no identity echo)", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl, proberCalls }) => {
      await registerManifest(asUrl, syntheticNoProbeStaticSecretManifest());
      const cookie = await login(asUrl);
      const draft = await createDraft(asUrl, cookie, "ynab", {});
      const connectionId = requireString(draft.body.connection_id, "draft.body.connection_id");

      // Even the "bad" secret stores: a no-probe connector cannot reject
      // synchronously — validation happens at first sync.
      const { status, body } = await capture(asUrl, cookie, connectionId, BAD_SECRET, "personal_access_token");

      assert.equal(status, 201);
      assert.equal(body.validation, "first_sync");
      assert.equal(body.identity, null, "no-probe connector echoes no identity");
      const store = createSqliteConnectorInstanceCredentialStore();
      assert.ok(await store.getMetadata(connectionId), "a no-probe credential is stored for first sync");
      // The prober was still consulted; it self-reported skipped.
      assert.equal(proberCalls.at(-1)?.connectorKey, "ynab");
    });
  });
});
