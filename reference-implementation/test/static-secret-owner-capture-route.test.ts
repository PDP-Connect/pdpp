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

async function withServer(
  fn: (harness: { asUrl: string; rsUrl: string }) => Promise<void>,
  prober: ReturnType<typeof permissiveProber> = permissiveProber()
): Promise<void> {
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

// F4: no shipped manifest has a single-secret kind (api_key/app_password/…)
// with credential_capture.required: false — GroupMe's real, registration-
// valid manifest (access_token, one secret field) is cloned and given ONLY
// that one flag flip, so this proves the real HTTP registration + capture
// contract for the shape F4 describes, not a hand-rolled fixture that could
// silently diverge from what the route actually accepts.
async function registerOptionalSingleSecretConnector(asUrl: string, connectorKey: string): Promise<void> {
  const groupme = loadManifest("groupme");
  const manifest = structuredClone(groupme);
  // A custom (non-first-party) connector's `connector_id` must equal its
  // `connector_key` directly — the registry-URL form is reserved for
  // manifests already in the generated first-party allowlist (see
  // connector-key.ts's module doc: "a custom manifest must declare its
  // canonical key explicitly").
  manifest.connector_key = connectorKey;
  manifest.connector_id = connectorKey;
  manifest.manifest_uri = `https://registry.pdpp.dev/connectors/${connectorKey}`;
  const setup = manifest.setup as { credential_capture: { required?: boolean } };
  setup.credential_capture.required = false;
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(resp.status, 201, `register ${connectorKey} failed: ${resp.status}`);
}

async function registerRequiredOnePathBundleConnector(asUrl: string, connectorKey: string): Promise<void> {
  const manifest = structuredClone(loadManifest("jellyfin"));
  manifest.connector_key = connectorKey;
  manifest.connector_id = connectorKey;
  manifest.manifest_uri = `https://registry.pdpp.dev/connectors/${connectorKey}`;
  const setup = manifest.setup as {
    credential_capture: { fields: Array<{ name: string }>; required?: boolean };
  };
  setup.credential_capture.fields = setup.credential_capture.fields.filter(
    (field) => field.name === "base_url" || field.name === "secret"
  );
  setup.credential_capture.required = true;
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(resp.status, 201, `register ${connectorKey} failed: ${resp.status}`);
}

async function seedInstance({
  connectorInstanceId,
  connectorId,
  ownerSubjectId = OWNER_SUBJECT_ID,
  displayName,
  setupFields = {},
}: {
  connectorInstanceId: string;
  connectorId: string;
  ownerSubjectId?: string;
  displayName?: string;
  setupFields?: Record<string, string>;
}): Promise<void> {
  const store = createSqliteConnectorInstanceStore();
  await store.upsert({
    connectorId,
    connectorInstanceId,
    createdAt: NOW,
    displayName: displayName ?? connectorInstanceId,
    ownerSubjectId,
    sourceBinding: { account_hint: connectorInstanceId, kind: "static_secret", setup_fields: setupFields },
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
      await seedInstance({
        connectorId: "gmail",
        connectorInstanceId: "cin_gmail_personal",
        setupFields: { account_email: "personal@example.com" },
      });
      await seedInstance({
        connectorId: "gmail",
        connectorInstanceId: "cin_gmail_work",
        setupFields: { account_email: "work@example.com" },
      });
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

test("capture rejects an empty credential bundle for an at-least-one-path manifest instead of claiming it was captured", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "jellyfin");
      await seedInstance({ connectorId: "jellyfin", connectorInstanceId: "cin_jellyfin_personal" });
      const cookie = await login(asUrl);

      const { status, body, text, resp } = await captureCredential(
        asUrl,
        cookie,
        "cin_jellyfin_personal",
        "{}",
        "username_password"
      );
      assert.equal(status, 400);
      assert.equal(errorOf(body).code, "missing_credential");

      const audit = findCaptureAuditEvent(resp);
      assert.equal(audit.status, "failed");
      assert.equal(errorOf(dataOf(audit)).code, "missing_credential");
      assert.ok(!text.includes("captured"), "an empty bundle must never be reported as captured");

      const store = createSqliteConnectorInstanceCredentialStore({
        env: { [CREDENTIAL_ENCRYPTION_KEY_ENV]: TEST_KEY },
      });
      assert.equal(
        await store.getMetadata("cin_jellyfin_personal"),
        null,
        "nothing should be stored for an empty credential bundle"
      );
    });
  });
});

test("capture accepts an at-least-one-path manifest when exactly one credential path is fully present", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "jellyfin");
      await seedInstance({ connectorId: "jellyfin", connectorInstanceId: "cin_jellyfin_apikey" });
      const cookie = await login(asUrl);

      const { status, body } = await captureCredential(
        asUrl,
        cookie,
        "cin_jellyfin_apikey",
        JSON.stringify({ secret: "real-jellyfin-api-key" }),
        "username_password"
      );
      assert.equal(status, 201);
      assert.equal(credentialOf(body).present, true);

      const store = createSqliteConnectorInstanceCredentialStore({
        env: { [CREDENTIAL_ENCRYPTION_KEY_ENV]: TEST_KEY },
      });
      const recovered = await store.recoverSecret({
        connectorInstanceId: "cin_jellyfin_apikey",
        ownerSubjectId: OWNER_SUBJECT_ID,
      });
      assert.equal(recovered.secret, JSON.stringify({ secret: "real-jellyfin-api-key" }));
    });
  });
});

// Venmo's manifest declares the BLOCK-level credential_capture.required as
// false, while username/password stay required:true at the FIELD level
// (BOTH-OR-NONE) — Venmo authenticates through an owner-driven browser
// session that works with zero saved credentials. validateBundledSecret's
// `contract.required === false` branch (not isAtLeastOnePathContract, which
// only ever applies to a REQUIRED capture like Jellyfin's) is what
// classifies this shape; a fully blank submission is the correct, honest
// "sign in by hand every time" choice, not an error.
// F1 ruling: a blank submission on an optional capture means "proceed with
// manual browser sign-in", NOT "store an empty credential". Nothing is
// written to the credential store, the response is 200 (not 201 — nothing
// was created), and `credential.present` is honestly `false`.
test("capture accepts a fully empty credential bundle for an all-optional, no-fallback-required manifest (Venmo) WITHOUT storing anything", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "venmo");
      await seedInstance({ connectorId: "venmo", connectorInstanceId: "cin_venmo_personal" });
      const cookie = await login(asUrl);

      const { status, body } = await captureCredential(asUrl, cookie, "cin_venmo_personal", "{}", "username_password");
      assert.equal(status, 200, "a blank optional submission is a valid choice, but creates nothing (200, not 201)");
      assert.equal(credentialOf(body).present, false, "an empty bundle must never project as a present credential");
      assert.equal(
        nextStepOf(body).kind,
        "run_connection",
        "the owner can still run the connection via manual sign-in"
      );

      const store = createSqliteConnectorInstanceCredentialStore({
        env: { [CREDENTIAL_ENCRYPTION_KEY_ENV]: TEST_KEY },
      });
      assert.equal(
        await store.getMetadata("cin_venmo_personal"),
        null,
        "no credential row must exist after a blank optional submission"
      );
    });
  });
});

// F1 ruling, second half: a blank re-submission must never silently clear an
// EXISTING stored credential. Capture a real credential first, then submit
// blank again — the original credential must survive untouched.
test("capture on an existing Venmo credential followed by a blank re-submission never clears the stored credential", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "venmo");
      await seedInstance({ connectorId: "venmo", connectorInstanceId: "cin_venmo_preserved" });
      const cookie = await login(asUrl);

      const complete = JSON.stringify({ password: "synthetic-password", username: "owner@example.com" });
      const first = await captureCredential(asUrl, cookie, "cin_venmo_preserved", complete, "username_password");
      assert.equal(first.status, 201);
      assert.equal(credentialOf(first.body).present, true);

      const second = await captureCredential(asUrl, cookie, "cin_venmo_preserved", "{}", "username_password");
      assert.equal(second.status, 200, "a blank re-submission is accepted as a no-op, not a rejection");
      assert.equal(
        credentialOf(second.body).present,
        false,
        "the blank RESPONSE projects present:false — it does not echo the untouched stored row"
      );

      const store = createSqliteConnectorInstanceCredentialStore({
        env: { [CREDENTIAL_ENCRYPTION_KEY_ENV]: TEST_KEY },
      });
      const recovered = await store.recoverSecret({
        connectorInstanceId: "cin_venmo_preserved",
        ownerSubjectId: OWNER_SUBJECT_ID,
      });
      assert.equal(recovered.secret, complete, "the ORIGINAL stored credential must survive a later blank submission");
    });
  });
});

// BOTH-OR-NONE: Venmo's fields are individually required:true, so a
// PARTIAL bundle is rejected at capture time exactly like a required
// capture would reject it — only a fully blank OR fully complete bundle is
// valid. This is the counterpart to the "fully empty" test above.
test("capture rejects a Venmo credential bundle with only one of username/password filled (BOTH-OR-NONE)", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "venmo");
      await seedInstance({ connectorId: "venmo", connectorInstanceId: "cin_venmo_partial" });
      const cookie = await login(asUrl);

      const { status, body } = await captureCredential(
        asUrl,
        cookie,
        "cin_venmo_partial",
        JSON.stringify({ username: "owner@example.com" }),
        "username_password"
      );
      assert.equal(status, 400);
      assert.equal(errorOf(body).code, "missing_credential");

      const store = createSqliteConnectorInstanceCredentialStore({
        env: { [CREDENTIAL_ENCRYPTION_KEY_ENV]: TEST_KEY },
      });
      assert.equal(
        await store.getMetadata("cin_venmo_partial"),
        null,
        "nothing should be stored for a partial (neither blank nor complete) credential bundle"
      );
    });
  });
});

test("capture accepts a fully complete Venmo credential bundle (both username and password)", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "venmo");
      await seedInstance({ connectorId: "venmo", connectorInstanceId: "cin_venmo_complete" });
      const cookie = await login(asUrl);

      const { status, body } = await captureCredential(
        asUrl,
        cookie,
        "cin_venmo_complete",
        JSON.stringify({ password: "synthetic-password", username: "owner@example.com" }),
        "username_password"
      );
      assert.equal(status, 201);
      assert.equal(credentialOf(body).present, true);

      const store = createSqliteConnectorInstanceCredentialStore({
        env: { [CREDENTIAL_ENCRYPTION_KEY_ENV]: TEST_KEY },
      });
      const recovered = await store.recoverSecret({
        connectorInstanceId: "cin_venmo_complete",
        ownerSubjectId: OWNER_SUBJECT_ID,
      });
      assert.equal(recovered.secret, JSON.stringify({ password: "synthetic-password", username: "owner@example.com" }));
    });
  });
});

// Counts probe invocations so a rejection test can prove the manifest
// contract fired BEFORE the synchronous credential probe, not after it.
function countingProber(): { calls: () => number; prober: ReturnType<typeof permissiveProber> } {
  let count = 0;
  const inner = permissiveProber();
  return {
    calls: () => count,
    prober: (input) => {
      count += 1;
      return inner(input);
    },
  };
}

// The manifest contract enforced ONCE at capture: a REQUIRED bundled capture
// (usaa's real, unmutated manifest — block-level credential_capture.required
// defaults true, username and password each required:true at the field
// level) must reject a PARTIAL bundle before the credential probe, the
// replacement guard, and the store. Without the per-field rule the route
// probed and stored the partial bundle, and the miss surfaced only later at
// injection time (recovered_secret_bundle_field_missing).
test("capture rejects a partial bundle for a REQUIRED username/password capture before any probe or store", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    const probe = countingProber();
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "usaa");
      await seedInstance({ connectorId: "usaa", connectorInstanceId: "cin_usaa_partial" });
      const cookie = await login(asUrl);

      const { status, body, resp } = await captureCredential(
        asUrl,
        cookie,
        "cin_usaa_partial",
        JSON.stringify({ username: "owner@example.com" }),
        "username_password"
      );
      assert.equal(status, 400);
      assert.equal(errorOf(body).code, "missing_credential");
      assert.equal(errorOf(body).message, "USAA password is required.");
      assert.equal(probe.calls(), 0, "a partial required bundle must be rejected BEFORE the credential probe runs");

      const audit = findCaptureAuditEvent(resp);
      assert.equal(audit.status, "failed");
      assert.equal(errorOf(dataOf(audit)).code, "missing_credential");

      const store = createSqliteConnectorInstanceCredentialStore({
        env: { [CREDENTIAL_ENCRYPTION_KEY_ENV]: TEST_KEY },
      });
      assert.equal(
        await store.getMetadata("cin_usaa_partial"),
        null,
        "nothing should be stored for a partial required credential bundle"
      );
    }, probe.prober);
  });
});

test("capture rejects a literal {} bundle for a REQUIRED username/password capture before any probe or store", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    const probe = countingProber();
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "usaa");
      await seedInstance({ connectorId: "usaa", connectorInstanceId: "cin_usaa_empty" });
      const cookie = await login(asUrl);

      const { status, body } = await captureCredential(asUrl, cookie, "cin_usaa_empty", "{}", "username_password");
      assert.equal(status, 400);
      assert.equal(errorOf(body).code, "missing_credential");
      assert.equal(errorOf(body).message, "USAA online ID, USAA password is required.");
      assert.equal(probe.calls(), 0, "an empty required bundle must be rejected BEFORE the credential probe runs");

      const store = createSqliteConnectorInstanceCredentialStore({
        env: { [CREDENTIAL_ENCRYPTION_KEY_ENV]: TEST_KEY },
      });
      assert.equal(
        await store.getMetadata("cin_usaa_empty"),
        null,
        "nothing should be stored for an empty required credential bundle"
      );
    }, probe.prober);
  });
});

test("capture accepts a complete REQUIRED username/password bundle, probing exactly once before storing", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    const probe = countingProber();
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "usaa");
      await seedInstance({ connectorId: "usaa", connectorInstanceId: "cin_usaa_complete" });
      const cookie = await login(asUrl);

      const complete = JSON.stringify({ password: "synthetic-password", username: "owner@example.com" });
      const { status, body } = await captureCredential(
        asUrl,
        cookie,
        "cin_usaa_complete",
        complete,
        "username_password"
      );
      assert.equal(status, 201);
      assert.equal(credentialOf(body).present, true);
      assert.equal(probe.calls(), 1, "a complete required bundle reaches the synchronous probe exactly once");

      const store = createSqliteConnectorInstanceCredentialStore({
        env: { [CREDENTIAL_ENCRYPTION_KEY_ENV]: TEST_KEY },
      });
      const recovered = await store.recoverSecret({
        connectorInstanceId: "cin_usaa_complete",
        ownerSubjectId: OWNER_SUBJECT_ID,
      });
      assert.equal(recovered.secret, complete);
    }, probe.prober);
  });
});

test("capture rejects a required fully bundled credential missing a required non-secret field", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    const probe = countingProber();
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "slack");
      await seedInstance({ connectorId: "slack", connectorInstanceId: "cin_slack_partial" });
      const cookie = await login(asUrl);
      const partial = JSON.stringify({ slack_cookie: "synthetic-cookie", slack_token: "synthetic-token" });

      const { body, status } = await captureCredential(asUrl, cookie, "cin_slack_partial", partial, "secret_bundle");
      assert.equal(status, 400);
      assert.equal(errorOf(body).code, "missing_credential");
      assert.equal(probe.calls(), 0, "a partial fully bundled credential must fail before its probe");
      const store = createSqliteConnectorInstanceCredentialStore({
        env: { [CREDENTIAL_ENCRYPTION_KEY_ENV]: TEST_KEY },
      });
      assert.equal(await store.getMetadata("cin_slack_partial"), null);
    }, probe.prober);
  });
});

test("capture accepts a complete required fully bundled credential", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    const probe = countingProber();
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "slack");
      await seedInstance({ connectorId: "slack", connectorInstanceId: "cin_slack_complete" });
      const cookie = await login(asUrl);
      const complete = JSON.stringify({
        slack_cookie: "synthetic-cookie",
        slack_token: "synthetic-token",
        slack_workspace: "example",
      });

      const { body, status } = await captureCredential(asUrl, cookie, "cin_slack_complete", complete, "secret_bundle");
      assert.equal(status, 201);
      assert.equal(credentialOf(body).present, true);
      assert.equal(probe.calls(), 1);
    }, probe.prober);
  });
});

test("capture rejects an empty required bundle with one optional credential path", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    const probe = countingProber();
    await withServer(async ({ asUrl }) => {
      const connectorId = "required_one_path_bundle";
      await registerRequiredOnePathBundleConnector(asUrl, connectorId);
      await seedInstance({ connectorId, connectorInstanceId: "cin_required_one_path" });
      const cookie = await login(asUrl);

      const { body, status } = await captureCredential(
        asUrl,
        cookie,
        "cin_required_one_path",
        "{}",
        "username_password"
      );
      assert.equal(status, 400, JSON.stringify(body));
      assert.equal(errorOf(body).code, "missing_credential");
      assert.equal(probe.calls(), 0);
      const store = createSqliteConnectorInstanceCredentialStore({
        env: { [CREDENTIAL_ENCRYPTION_KEY_ENV]: TEST_KEY },
      });
      assert.equal(await store.getMetadata("cin_required_one_path"), null);
    }, probe.prober);
  });
});

// F4: a single-secret kind's `secret` is a bare provider string, never a
// JSON bundle — validateBundledSecret must route it through
// validateSingleSecret (never parseSecretBundle, which would silently treat
// any non-JSON string as an empty bundle). No shipped manifest has this
// shape today (every required:false manifest is username_password), so this
// registers a real, valid manifest (GroupMe's, access_token/single-secret)
// with ONLY credential_capture.required flipped to false, through the
// actual HTTP registration route.
test("capture accepts the blank-optional sentinel for a single-secret kind with credential_capture.required: false, storing nothing", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerOptionalSingleSecretConnector(asUrl, "f4_optional_single_secret");
      await seedInstance({
        connectorId: "f4_optional_single_secret",
        connectorInstanceId: "cin_f4_optional_single_secret",
      });
      const cookie = await login(asUrl);

      const { status, body } = await captureCredential(
        asUrl,
        cookie,
        "cin_f4_optional_single_secret",
        "{}",
        "access_token"
      );
      assert.equal(status, 200, "a blank optional single-secret submission is a valid choice, but creates nothing");
      assert.equal(credentialOf(body).present, false);

      const store = createSqliteConnectorInstanceCredentialStore({
        env: { [CREDENTIAL_ENCRYPTION_KEY_ENV]: TEST_KEY },
      });
      assert.equal(
        await store.getMetadata("cin_f4_optional_single_secret"),
        null,
        "no credential row must exist after a blank optional single-secret submission"
      );
    });
  });
});

test("capture stores a REAL single secret unchanged even when credential_capture.required is false", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerOptionalSingleSecretConnector(asUrl, "f4_optional_single_secret_real");
      await seedInstance({
        connectorId: "f4_optional_single_secret_real",
        connectorInstanceId: "cin_f4_optional_single_secret_real",
      });
      const cookie = await login(asUrl);

      const { status, body } = await captureCredential(
        asUrl,
        cookie,
        "cin_f4_optional_single_secret_real",
        "real-groupme-access-token",
        "access_token"
      );
      assert.equal(status, 201, "a real, non-blank secret is stored normally even on an optional capture");
      assert.equal(credentialOf(body).present, true);

      const store = createSqliteConnectorInstanceCredentialStore({
        env: { [CREDENTIAL_ENCRYPTION_KEY_ENV]: TEST_KEY },
      });
      const recovered = await store.recoverSecret({
        connectorInstanceId: "cin_f4_optional_single_secret_real",
        ownerSubjectId: OWNER_SUBJECT_ID,
      });
      assert.equal(recovered.secret, "real-groupme-access-token");
    });
  });
});

// Counterweight: the SAME blank-sentinel submission against a manifest that
// has NOT opted into credential_capture.required: false (GroupMe's real,
// unmutated manifest) must still be rejected — proving the optionality
// branch is genuinely gated on the manifest fact, not always-on for every
// single-secret kind.
test("F4 counterweight: capture rejects a blank single-secret submission when credential_capture.required stays true (default)", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "groupme");
      await seedInstance({ connectorId: "groupme", connectorInstanceId: "cin_groupme_blank" });
      const cookie = await login(asUrl);

      const { status, body } = await captureCredential(asUrl, cookie, "cin_groupme_blank", "{}", "access_token");
      assert.equal(status, 400);
      assert.equal(errorOf(body).code, "missing_credential");

      const store = createSqliteConnectorInstanceCredentialStore({
        env: { [CREDENTIAL_ENCRYPTION_KEY_ENV]: TEST_KEY },
      });
      assert.equal(await store.getMetadata("cin_groupme_blank"), null);
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
