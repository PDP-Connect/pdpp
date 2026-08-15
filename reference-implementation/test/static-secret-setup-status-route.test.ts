// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { emitSpineEvent } from "../lib/spine.ts";
import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from "../server/stores/credential-encryption.ts";

// Integration coverage for the owner-session static-secret SETUP-STATUS route —
// the durable surface that makes an in-flight static-secret setup visible to the
// owner before its first ingest accepts records, so a submitted Gmail/GitHub
// account never disappears behind the invisible draft. See
// complete-self-service-connection-onboarding design Decision 12 / Phase 2.

const OWNER_PASSWORD = "static-secret-status-owner-password";
const OWNER_SUBJECT_ID = "owner_local";
const TEST_KEY = "static-secret-status-test-key";
const SECRET = "status app password synthetic";
const NO_BROWSER_CREDENTIAL_REMEDIATION = /provider credential/i;
const NO_BROWSER_REENTER_REMEDIATION = /re-enter/i;
const SECURE_BROWSER_REMEDIATION = /secure browser/i;

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

// Permissive deterministic prober so capturing gmail in these setup-status
// projection tests does not trigger a real network probe.
function permissiveProber() {
  return async ({ context }: { context?: { setupFields?: Record<string, unknown> } }) => ({
    detail: null,
    identity: context?.setupFields?.account_email ?? "synthetic@example.com",
    ok: true,
  });
}

async function withServer(
  fn: (harness: { asUrl: string; rsUrl: string; server: StartedServer }) => Promise<void>
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
    staticSecretCredentialProber: permissiveProber(),
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    await fn({ asUrl, rsUrl, server });
  } finally {
    await closeServer(server);
  }
}

// Owner-auth-disabled harness for the activation test, which needs an owner
// BEARER token (device flow) to ingest. With an empty owner password the default
// owner session is active (so `/_ref/...` cookie routes need no login) and
// `/device/approve` issues a bearer token without a CSRF-gated owner session.
// Mirrors static-secret-draft-connection-route.test.js.
async function withOpenServer(
  fn: (harness: { asUrl: string; rsUrl: string; server: StartedServer }) => Promise<void>
): Promise<void> {
  const server = await startServer({
    asPort: 0,
    autoEnrollEligibleSchedules: false,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    ownerAuthSubjectId: OWNER_SUBJECT_ID,
    quiet: true,
    rsPort: 0,
    staticSecretAutoResume: false,
    staticSecretCredentialProber: permissiveProber(),
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    await fn({ asUrl, rsUrl, server });
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
    // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
    const firstPair = header.split(";")[0];
    if (firstPair?.startsWith(`${name}=`)) {
      return firstPair;
    }
  }
  return null;
}

function extractCsrfFieldValue(html: string): string | null {
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
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

async function fetchJson(url: string | URL, opts: RequestInit = {}): Promise<JsonResult> {
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

function verifiedEmptyCollectionFacts(connectorName: string): Record<string, unknown> {
  const manifest = loadManifest(connectorName);
  const streams = Array.isArray(manifest.streams)
    ? (manifest.streams as Array<{ name?: unknown; required?: unknown }>)
        .filter((stream) => typeof stream.name === "string" && stream.name.length > 0)
        .map((stream) => ({
          checkpoint: "committed",
          collected: 0,
          considered: 0,
          covered: 0,
          pending_detail_gaps: 0,
          skipped: null,
          stream: stream.name,
        }))
    : [];
  return { collection_facts: { streams } };
}

const VALID_TIMELINE_BODY = JSON.stringify({
  locations: [
    {
      latitudeE7: 377_749_000,
      longitudeE7: -1_224_194_000,
      timestampMs: "1717595122000",
    },
  ],
});

async function registerConnector(asUrl: string, name: string): Promise<void> {
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(loadManifest(name)),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(resp.status, 201, `register ${name} failed: ${resp.status}`);
}

// biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
async function createDraft(
  asUrl: string,
  cookie: string,
  connectorId: string,
  setupFields: Record<string, unknown> = { account_email: "owner@example.com" }
): Promise<JsonResult> {
  return fetchJson(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/draft-connection`, {
    body: JSON.stringify({ setup_fields: setupFields }),
    headers: { Accept: "application/json", "Content-Type": "application/json", Cookie: cookie },
    method: "POST",
  });
}

// biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
async function createBrowserEnrollmentShell(asUrl: string, cookie: string, connectorId: string): Promise<JsonResult> {
  return fetchJson(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/browser-enrollment-shell`, {
    body: JSON.stringify({}),
    headers: { Accept: "application/json", "Content-Type": "application/json", Cookie: cookie },
    method: "POST",
  });
}

// biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
async function createManualUploadDraft(asUrl: string, cookie: string, connectorId: string): Promise<JsonResult> {
  const url = new URL(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/manual-upload-draft-connection`);
  url.searchParams.set("file_name", "Timeline.json");
  return fetchJson(url, {
    body: VALID_TIMELINE_BODY,
    headers: { Accept: "application/json", "Content-Type": "application/vnd.pdpp.manual-upload", Cookie: cookie },
    method: "POST",
  });
}

// biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
async function capture(asUrl: string, cookie: string, connectionId: string): Promise<JsonResult> {
  return fetchJson(`${asUrl}/_ref/connections/${encodeURIComponent(connectionId)}/static-secret-credential`, {
    body: JSON.stringify({ credential_kind: "app_password", secret: SECRET }),
    headers: { Accept: "application/json", "Content-Type": "application/json", Cookie: cookie },
    method: "POST",
  });
}

// biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
async function getStatus(
  asUrl: string,
  cookie: string,
  connectionId: string,
  runId: string | null = null
): Promise<JsonResult> {
  const suffix = runId ? `?run_id=${encodeURIComponent(runId)}` : "";
  return fetchJson(`${asUrl}/_ref/connections/${encodeURIComponent(connectionId)}/setup-status${suffix}`, {
    headers: { Accept: "application/json", Cookie: cookie },
  });
}

// biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
async function listRefConnectors(asUrl: string, cookie: string): Promise<JsonResult> {
  return fetchJson(`${asUrl}/_ref/connectors?limit=100`, {
    headers: { Accept: "application/json", Cookie: cookie },
  });
}

// biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
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

// Seed a controller_active_runs row directly: the setup-status route reads this
// table (keyed on connector_instance_id) to report an in-flight first sync. In a
// live deployment the controller writes it on run start; the harness has no
// real collector, so we seed it deterministically.
function seedActiveRun(connectorInstanceId: string, connectorId: string, runId: string): void {
  getDb()
    .prepare(
      `INSERT INTO controller_active_runs(connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at)
       VALUES(?, ?, ?, 'trc_status', 'default', '2026-06-10T00:00:00.000Z')`
    )
    .run(connectorInstanceId, connectorId, runId);
}

function clearActiveRun(connectorInstanceId: string): void {
  getDb().prepare("DELETE FROM controller_active_runs WHERE connector_instance_id = ?").run(connectorInstanceId);
}

async function emitTerminalRunEvent(
  connectorId: string,
  runId: string,
  status: string,
  data: Readonly<Record<string, unknown>> = {},
  connectorInstanceId = `cin_${connectorId}`
): Promise<void> {
  await emitSpineEvent({
    actor_id: connectorId,
    actor_type: "runtime",
    data: { connector_instance_id: connectorInstanceId, source: { id: connectorId, kind: "connector" }, ...data },
    event_type: status === "failed" ? "run.failed" : "run.completed",
    object_id: runId,
    object_type: "run",
    run_id: runId,
    scenario_id: "default",
    source_id: connectorId,
    source_kind: "connector",
    status: status === "failed" ? "failed" : "succeeded",
    trace_id: "trc_status_terminal",
  });
}

async function emitStartedRunEvent(
  connectorId: string,
  runId: string,
  occurredAt = "2026-06-10T00:02:00.000Z",
  connectorInstanceId = `cin_${connectorId}`
): Promise<void> {
  await emitSpineEvent({
    actor_id: connectorId,
    actor_type: "runtime",
    data: {
      boot_epoch: "11111111-1111-4111-8111-111111111111",
      connector_instance_id: connectorInstanceId,
      seq: 1,
      source: { id: connectorId, kind: "connector" },
    },
    event_type: "run.started",
    object_id: runId,
    object_type: "run",
    occurred_at: occurredAt,
    run_id: runId,
    scenario_id: "default",
    source_id: connectorId,
    source_kind: "connector",
    status: "started",
    trace_id: "trc_status_started",
  });
}

function requireString(value: unknown, label: string): string {
  assert.ok(typeof value === "string" && value.length > 0, `expected ${label} to be a non-empty string`);
  return value;
}

function subObject(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = body[key];
  assert.ok(typeof value === "object" && value !== null, `expected body.${key} to be an object`);
  return value as Record<string, unknown>;
}

function nestedSubObject(body: Record<string, unknown>, outerKey: string, innerKey: string): Record<string, unknown> {
  return subObject(subObject(body, outerKey), innerKey);
}

function dataArrayOf(body: Record<string, unknown>): Record<string, unknown>[] {
  const { data } = body;
  assert.ok(Array.isArray(data), "expected body.data to be an array");
  return data as Record<string, unknown>[];
}

test("pending static-secret setup is visible before any records are accepted", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "gmail");
      const cookie = await login(asUrl);

      const created = await createDraft(asUrl, cookie, "gmail", { account_email: "pending@example.com" });
      assert.equal(created.status, 201);
      const connectionId = requireString(created.body.connection_id, "created.body.connection_id");

      // Immediately after draft creation (no credential, no run): visible,
      // pending, awaiting credential, account identity surfaced.
      const awaiting = await getStatus(asUrl, cookie, connectionId);
      assert.equal(awaiting.status, 200, awaiting.text);
      assert.equal(awaiting.body.object, "connection_setup_status");
      assert.equal(awaiting.body.connection_id, connectionId);
      assert.equal(awaiting.body.connector_id, "gmail");
      assert.equal(awaiting.body.status, "draft");
      assert.equal(awaiting.body.setup_kind, "static_secret");
      assert.equal(subObject(awaiting.body, "setup_material").label, "Provider credential");
      assert.equal(subObject(awaiting.body, "setup_material").present, false);
      assert.equal(awaiting.body.setup_state, "awaiting_credential");
      assert.equal(awaiting.body.health_state, "idle");
      assert.equal(awaiting.body.pending, true);
      assert.equal(awaiting.body.running, false);
      assert.equal(awaiting.body.account_identity, "pending@example.com");
      assert.equal(subObject(awaiting.body, "credential").present, false);

      // After capture but before ingest: still pending; first sync pending.
      const captured = await capture(asUrl, cookie, connectionId);
      assert.equal(captured.status, 201, captured.text);
      const afterCapture = await getStatus(asUrl, cookie, connectionId);
      assert.equal(subObject(afterCapture.body, "credential").present, true);
      assert.equal(subObject(afterCapture.body, "setup_material").present, true);
      assert.equal(subObject(afterCapture.body, "credential").credential_kind, "app_password");
      assert.equal(afterCapture.body.setup_state, "first_sync_pending");
      assert.equal(afterCapture.body.pending, true);

      // With an in-flight run row: running is visible, run id surfaced.
      seedActiveRun(connectionId, "gmail", "run_status_inflight");
      const running = await getStatus(asUrl, cookie, connectionId);
      assert.equal(running.body.setup_state, "first_sync_running");
      assert.equal(running.body.running, true);
      assert.equal(subObject(running.body, "run").run_id, "run_status_inflight");
      assert.equal(subObject(running.body, "run").status, "in_progress");

      // No secret ever appears in any status response.
      assert.ok(!running.text.includes(SECRET), "status must not echo the secret");
      assert.ok(!afterCapture.text.includes(SECRET), "status must not echo the secret");
      clearActiveRun(connectionId);

      await emitTerminalRunEvent(
        "gmail",
        "run_status_zero_yield",
        "succeeded",
        {
          records_emitted: 0,
          reported_records_emitted: 0,
        },
        connectionId
      );
      const zeroYield = await getStatus(asUrl, cookie, connectionId, "run_status_zero_yield");
      assert.equal(zeroYield.status, 200, zeroYield.text);
      assert.equal(zeroYield.body.setup_state, "first_sync_unverified_zero");
      assert.equal(zeroYield.body.health_state, "needs_attention");
      assert.equal(zeroYield.body.pending, false);
      assert.equal(zeroYield.body.terminal_setup_disposition, "unverified_zero");
      assert.equal(subObject(zeroYield.body, "run").records_emitted, 0);
      assert.equal(subObject(zeroYield.body, "run").reported_records_emitted, 0);
      assert.equal(
        getDb().prepare("SELECT 1 FROM connector_schedules WHERE connector_instance_id = ?").get(connectionId),
        undefined,
        "zero-yield draft must remain unscheduled"
      );

      // Revisit without a run_id resolves the latest terminal row through the
      // connection-scoped run-history reader, rather than falling back to an
      // unscoped spine lookup or returning to first_sync_pending.
      const revisited = await getStatus(asUrl, cookie, connectionId);
      assert.equal(revisited.body.setup_state, "first_sync_unverified_zero");
      assert.equal(revisited.body.terminal_setup_disposition, "unverified_zero");

      const summaries = await listRefConnectors(asUrl, cookie);
      assert.equal(summaries.status, 200, summaries.text);
      const summary = dataArrayOf(summaries.body).find((item) => item.connection_id === connectionId);
      assert.ok(summary, "draft terminal setup should remain owner-visible in connector summaries");
      assert.equal(summary.terminal_setup_disposition, "unverified_zero");
    });
  });
});

// fr-setup-status-lifecycle-0806: Slack/YNAB setup read "First sync pending"
// and never advanced without a manual "Refresh Status" click. Root cause: the
// route discarded run-history evidence outright whenever it read status
// `"running"` and no `controller_active_runs` row existed yet for the
// connection — a real, reachable window between `run.started` writing the
// `run_history` row (`status: 'running'`) and the controller's active-run
// table row landing (or after it clears, before the terminal write commits).
// Every subsequent poll re-derived the same stale `first_sync_pending`
// forever, because the discarded evidence meant there was nothing to
// converge on until the run went fully terminal.
test("first sync in-flight evidence from run_history alone (no active-run row yet) reads first_sync_running, not stuck first_sync_pending", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "gmail");
      const cookie = await login(asUrl);

      const created = await createDraft(asUrl, cookie, "gmail", { account_email: "inflight@example.com" });
      assert.equal(created.status, 201);
      const connectionId = requireString(created.body.connection_id, "created.body.connection_id");

      const captured = await capture(asUrl, cookie, connectionId);
      assert.equal(captured.status, 201, captured.text);

      // `run.started` writes a `run_history` row with status "running" —
      // deliberately WITHOUT seeding `controller_active_runs`, modeling the
      // window where the active-run table has no row for this connection yet
      // (or no longer does) while the history row still legitimately reads
      // "running".
      await emitStartedRunEvent("gmail", "run_status_inflight_no_active_row", undefined, connectionId);

      const status = await getStatus(asUrl, cookie, connectionId);
      assert.equal(status.status, 200, status.text);
      assert.notEqual(
        status.body.setup_state,
        "first_sync_pending",
        "an in-flight run must never read as a stuck first_sync_pending"
      );
      assert.equal(status.body.setup_state, "first_sync_running");
      assert.equal(status.body.running, true);
      assert.equal(status.body.pending, true);
      assert.equal(subObject(status.body, "run").run_id, "run_status_inflight_no_active_row");
      assert.equal(subObject(status.body, "run").status, "running");

      // Revisiting (the poller's own re-derivation, not a manual refresh
      // click) must keep reading the same correct running state — never
      // regress to first_sync_pending on a later read of the same evidence.
      const revisited = await getStatus(asUrl, cookie, connectionId);
      assert.equal(revisited.body.setup_state, "first_sync_running");
      assert.equal(revisited.body.running, true);
    });
  });
});

test("pending manual/upload setup is visible without credential semantics", async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "google_maps");
    const cookie = await login(asUrl);

    const created = await createManualUploadDraft(asUrl, cookie, "google-maps");
    assert.equal(created.status, 201, created.text);
    const connectionId = requireString(created.body.connection_id, "created.body.connection_id");

    const pending = await getStatus(asUrl, cookie, connectionId);
    assert.equal(pending.status, 200, pending.text);
    assert.equal(pending.body.object, "connection_setup_status");
    assert.equal(pending.body.connector_id, "google-maps");
    assert.equal(pending.body.status, "draft");
    assert.equal(pending.body.setup_kind, "manual_upload");
    assert.equal(pending.body.setup_state, "first_sync_pending");
    assert.equal(subObject(pending.body, "setup_material").label, "Import file (Timeline.json)");
    assert.equal(subObject(pending.body, "setup_material").present, true);
    assert.equal(subObject(pending.body, "credential").present, false);
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(String(subObject(pending.body, "import_receipt").batch_id), /^ab_/);
    assert.equal(subObject(pending.body, "import_receipt").status, "validated");
    assert.equal(subObject(pending.body, "import_receipt").detected_format, "legacy_records");
    assert.equal(subObject(pending.body, "import_receipt").parsed_count, 1);
    assert.equal(subObject(pending.body, "import_receipt").accepted_count, 0);
    assert.equal(subObject(pending.body, "import_receipt").duplicate_count, 0);
    assert.equal(subObject(pending.body, "import_receipt").skipped_count, 0);
    assert.equal(subObject(pending.body, "import_receipt").failed_count, 0);
    assert.equal(subObject(pending.body, "import_receipt").estimated_points, 1);
    assert.equal(subObject(pending.body, "import_receipt").estimated_segments, 0);
    assert.equal(nestedSubObject(pending.body, "import_receipt", "date_range").start, "2024-06-05T13:45:22.000Z");
    assert.equal(nestedSubObject(pending.body, "import_receipt", "date_range").end, "2024-06-05T13:45:22.000Z");
    assert.equal(subObject(pending.body, "import_receipt").uploaded_file_name, "Timeline.json");
    assert.equal(subObject(pending.body, "import_receipt").acquisition_method, "owner_artifact");
    assert.ok(!pending.text.includes("locations"), "status must not echo uploaded file contents");
    assert.ok(!pending.text.includes("import_dir"), "status must not leak import_dir");
    assert.ok(!pending.text.includes("GOOGLE_MAPS_TIMELINE_DIR"), "status must not expose env-var plumbing");
    assert.ok(!pending.text.includes("file_sha256"), "status must not expose artifact hashes");
  });
});

test("terminal setup evidence is composite connection/run scoped and survives revisit without run_id", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "gmail");
      const cookie = await login(asUrl);
      const first = await createDraft(asUrl, cookie, "gmail", { account_email: "first@example.com" });
      const second = await createDraft(asUrl, cookie, "gmail", { account_email: "second@example.com" });
      const third = await createDraft(asUrl, cookie, "gmail", { account_email: "third@example.com" });
      const firstConnectionId = requireString(first.body.connection_id, "first.body.connection_id");
      const secondConnectionId = requireString(second.body.connection_id, "second.body.connection_id");
      const thirdConnectionId = requireString(third.body.connection_id, "third.body.connection_id");
      await capture(asUrl, cookie, firstConnectionId);
      await capture(asUrl, cookie, secondConnectionId);
      await capture(asUrl, cookie, thirdConnectionId);

      const duplicateRunId = "run_duplicate_connection_scope";
      await emitTerminalRunEvent(
        "gmail",
        duplicateRunId,
        "succeeded",
        { records_emitted: 0, reported_records_emitted: 0 },
        firstConnectionId
      );
      await emitTerminalRunEvent(
        "gmail",
        duplicateRunId,
        "succeeded",
        { ...verifiedEmptyCollectionFacts("gmail"), records_emitted: 0, reported_records_emitted: 0 },
        secondConnectionId
      );
      await emitTerminalRunEvent("gmail", duplicateRunId, "succeeded", {}, thirdConnectionId);

      const firstRevisit = await getStatus(asUrl, cookie, firstConnectionId);
      const secondRevisit = await getStatus(asUrl, cookie, secondConnectionId);
      const thirdRevisit = await getStatus(asUrl, cookie, thirdConnectionId);
      assert.equal(firstRevisit.body.terminal_setup_disposition, "unverified_zero");
      assert.equal(firstRevisit.body.setup_state, "first_sync_unverified_zero");
      assert.equal(secondRevisit.body.terminal_setup_disposition, "verified_empty");
      assert.equal(secondRevisit.body.setup_state, "first_sync_verified_empty");
      assert.equal(thirdRevisit.body.terminal_setup_disposition, "unverified_missing_counts");
      assert.equal(thirdRevisit.body.setup_state, "first_sync_unverified_missing_counts");

      // The explicit run_id override remains fenced by the addressed
      // connector_instance_id even when both connections share the run id.
      const firstExact = await getStatus(asUrl, cookie, firstConnectionId, duplicateRunId);
      const secondExact = await getStatus(asUrl, cookie, secondConnectionId, duplicateRunId);
      const thirdExact = await getStatus(asUrl, cookie, thirdConnectionId, duplicateRunId);
      assert.equal(firstExact.body.terminal_setup_disposition, "unverified_zero");
      assert.equal(secondExact.body.terminal_setup_disposition, "verified_empty");
      assert.equal(thirdExact.body.terminal_setup_disposition, "unverified_missing_counts");

      const summaries = await listRefConnectors(asUrl, cookie);
      assert.equal(summaries.status, 200, summaries.text);
      const firstSummary = dataArrayOf(summaries.body).find((item) => item.connection_id === firstConnectionId);
      const secondSummary = dataArrayOf(summaries.body).find((item) => item.connection_id === secondConnectionId);
      const thirdSummary = dataArrayOf(summaries.body).find((item) => item.connection_id === thirdConnectionId);
      assert.equal(firstSummary?.terminal_setup_disposition, "unverified_zero");
      assert.equal(secondSummary?.terminal_setup_disposition, "verified_empty");
      assert.equal(thirdSummary?.terminal_setup_disposition, "unverified_missing_counts");
    });
  });
});

test("a failed first sync is visible with an actionable error and no secret leak", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "gmail");
      const cookie = await login(asUrl);

      const created = await createDraft(asUrl, cookie, "gmail");
      const connectionId = requireString(created.body.connection_id, "created.body.connection_id");
      await capture(asUrl, cookie, connectionId);

      // The run terminated as failed (no active-run row remains). The owner
      // surface holds the run id; the route resolves its terminal status.
      const runId = "run_status_failed";
      await emitTerminalRunEvent("gmail", runId, "failed", {}, connectionId);

      const failed = await getStatus(asUrl, cookie, connectionId, runId);
      assert.equal(failed.status, 200, failed.text);
      assert.equal(failed.body.status, "draft");
      assert.equal(failed.body.setup_state, "first_sync_failed");
      assert.equal(failed.body.health_state, "needs_attention");
      assert.equal(failed.body.pending, false);
      assert.equal(failed.body.running, false);
      assert.ok(failed.body.last_error, "failed first sync must carry last_error");
      assert.equal(typeof subObject(failed.body, "last_error").reason, "string");
      assert.equal(typeof subObject(failed.body, "last_error").remediation, "string");
      assert.ok(
        String(subObject(failed.body, "last_error").remediation).length > 0,
        "remediation copy must be present"
      );
      assert.ok(!failed.text.includes(SECRET), "failure status must not echo the secret");
    });
  });
});

test("setup status flips to active once first ingest accepts records", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withOpenServer(async ({ asUrl, rsUrl, server }) => {
      await registerConnector(asUrl, "gmail");
      const cookie = "";
      const ownerToken = await issueOwnerToken(asUrl);

      const created = await createDraft(asUrl, cookie, "gmail");
      const connectionId = requireString(created.body.connection_id, "created.body.connection_id");
      await capture(asUrl, cookie, connectionId);

      // First ingest with records flips the draft to active.
      const ingested = await ingest(rsUrl, ownerToken, "gmail", connectionId, "messages", [
        { emitted_at: "2026-06-10T00:00:00.000Z", id: "m1", subject: "hello" },
      ]);
      assert.equal(ingested.status, 200, ingested.text);

      const active = await getStatus(asUrl, cookie, connectionId);
      assert.equal(active.status, 200, active.text);
      assert.equal(active.body.status, "active");
      assert.equal(active.body.setup_state, "active");
      assert.equal(active.body.health_state, "healthy");
      assert.equal(active.body.pending, false);
      // Promotion (server/index.ts SETUP_BINDING_PROMOTIONS) moved the
      // binding from static_secret_draft to static_secret on this same
      // ingest; setup_kind must resolve from the promoted binding, not
      // fall through to the manifest-only legacy classifier.
      assert.equal(active.body.setup_kind, "static_secret");

      const rotated = await capture(asUrl, cookie, connectionId);
      assert.equal(rotated.status, 200, rotated.text);
      assert.equal(typeof subObject(rotated.body, "credential").rotated_at, "string");
      assert.notEqual(subObject(rotated.body, "credential").rotated_at, null);
      seedActiveRun(connectionId, "gmail", "run_status_credential_rotation");
      const verifying = await getStatus(asUrl, cookie, connectionId, "run_status_credential_rotation");
      assert.equal(verifying.status, 200, verifying.text);
      assert.equal(verifying.body.status, "active");
      assert.equal(verifying.body.setup_state, "active");
      assert.equal(verifying.body.running, true);
      assert.equal(subObject(verifying.body, "run").run_id, "run_status_credential_rotation");
      assert.equal(
        subObject(verifying.body, "credential").captured_at,
        subObject(active.body, "credential").captured_at
      );
      assert.equal(
        subObject(verifying.body, "credential").rotated_at,
        subObject(rotated.body, "credential").rotated_at
      );
      assert.equal(
        subObject(verifying.body, "setup_material").captured_at,
        subObject(rotated.body, "credential").rotated_at
      );
      clearActiveRun(connectionId);

      const failedRunId = "run_status_credential_rotation_failed";
      await emitStartedRunEvent("gmail", failedRunId, "9999-01-01T00:00:00.000Z", connectionId);
      await emitTerminalRunEvent("gmail", failedRunId, "failed", {}, connectionId);
      const failedVerification = await getStatus(asUrl, cookie, connectionId, failedRunId);
      assert.equal(failedVerification.status, 200, failedVerification.text);
      assert.equal(failedVerification.body.status, "active");
      assert.equal(failedVerification.body.setup_state, "active");
      assert.equal(failedVerification.body.running, false);
      assert.equal(subObject(failedVerification.body, "run").run_id, failedRunId);
      assert.equal(subObject(failedVerification.body, "run").status, "failed");
      assert.equal(subObject(failedVerification.body, "run").started_at, "9999-01-01T00:00:00.000Z");
      assert.ok(
        Date.parse(String(subObject(failedVerification.body, "run").started_at)) >
          Date.parse(String(subObject(rotated.body, "credential").rotated_at))
      );
      assert.equal(
        subObject(failedVerification.body, "credential").rotated_at,
        subObject(rotated.body, "credential").rotated_at
      );

      const schedule = await server.controller.getSchedule("gmail", {
        connectorInstanceId: connectionId,
      });
      assert.ok(schedule, "automatic static-secret activation must attach a schedule");
      assert.equal(schedule.connector_instance_id, connectionId);
      assert.equal(schedule.interval_seconds, 900);
      assert.equal(schedule.enabled, true);
    });
  });
});

test("active static-secret source without draft binding still surfaces credential repair state", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withOpenServer(async ({ asUrl, rsUrl }) => {
      await registerConnector(asUrl, "gmail");
      const cookie = "";
      const ownerToken = await issueOwnerToken(asUrl);

      const created = await createDraft(asUrl, cookie, "gmail");
      const connectionId = requireString(created.body.connection_id, "created.body.connection_id");
      await capture(asUrl, cookie, connectionId);

      const ingested = await ingest(rsUrl, ownerToken, "gmail", connectionId, "messages", [
        { emitted_at: "2026-06-10T00:00:00.000Z", id: "m1", subject: "hello" },
      ]);
      assert.equal(ingested.status, 200, ingested.text);

      getDb()
        .prepare(`UPDATE connector_instances SET source_binding_json = '{}' WHERE connector_instance_id = ?`)
        .run(connectionId);

      const rotated = await capture(asUrl, cookie, connectionId);
      assert.equal(rotated.status, 200, rotated.text);
      seedActiveRun(connectionId, "gmail", "run_status_legacy_rotation");

      const status = await getStatus(asUrl, cookie, connectionId, "run_status_legacy_rotation");
      assert.equal(status.status, 200, status.text);
      assert.equal(status.body.status, "active");
      assert.equal(status.body.setup_kind, "static_secret");
      assert.equal(status.body.setup_state, "active");
      assert.equal(status.body.running, true);
      assert.equal(subObject(status.body, "credential").present, true);
      assert.equal(subObject(status.body, "credential").rotated_at, subObject(rotated.body, "credential").rotated_at);
      assert.equal(subObject(status.body, "setup_material").kind, "static_secret");
      assert.equal(subObject(status.body, "setup_material").present, true);
      assert.equal(
        subObject(status.body, "setup_material").captured_at,
        subObject(rotated.body, "credential").rotated_at
      );
      clearActiveRun(connectionId);
    });
  });
});

test("manual/upload setup status shows committed acquisition-batch counts after ingest", async () => {
  await withOpenServer(async ({ asUrl, rsUrl }) => {
    await registerConnector(asUrl, "google_maps");
    const cookie = "";
    const ownerToken = await issueOwnerToken(asUrl);

    const created = await createManualUploadDraft(asUrl, cookie, "google-maps");
    assert.equal(created.status, 201, created.text);
    const connectionId = requireString(created.body.connection_id, "created.body.connection_id");

    const ingested = await ingest(rsUrl, ownerToken, "google-maps", connectionId, "timeline_points", [
      {
        emitted_at: "2024-06-05T13:45:22.000Z",
        id: "point_1",
        latitude: 37.7749,
        longitude: -122.4194,
        source_format: "legacy_records",
        source_kind: "raw_location",
        timestamp: "2024-06-05T13:45:22.000Z",
      },
    ]);
    assert.equal(ingested.status, 200, ingested.text);

    const active = await getStatus(asUrl, cookie, connectionId);
    assert.equal(active.status, 200, active.text);
    assert.equal(active.body.status, "active");
    assert.equal(active.body.setup_state, "active");
    // Promotion moved the binding from manual_upload_draft to manual_upload
    // on this ingest; setup_kind must resolve from the promoted binding.
    assert.equal(active.body.setup_kind, "manual_upload");
    assert.equal(subObject(active.body, "import_receipt").status, "committed");
    assert.equal(subObject(active.body, "import_receipt").parsed_count, 1);
    assert.equal(subObject(active.body, "import_receipt").accepted_count, 1);
    assert.equal(subObject(active.body, "import_receipt").duplicate_count, 0);
    assert.equal(subObject(active.body, "import_receipt").failed_count, 0);
    assert.equal(subObject(active.body, "import_receipt").acquisition_method, "owner_artifact");

    const summaries = await listRefConnectors(asUrl, cookie);
    assert.equal(summaries.status, 200, summaries.text);
    const summary = dataArrayOf(summaries.body).find((item) => item.connection_id === connectionId);
    assert.ok(summary, "manual upload connection summary should be visible after ingest");
    const latestBatch = nestedSubObject(summary, "acquisition_coverage", "latest_batch");
    assert.equal(latestBatch.status, "committed");
    assert.equal(latestBatch.acquisition_method, "owner_artifact");
    assert.equal(latestBatch.accepted_count, 1);
    assert.equal(latestBatch.detected_format, "legacy_records");
    assert.equal(latestBatch.uploaded_file_name, "Timeline.json");
    assert.equal(Object.hasOwn(latestBatch, "artifact_sha256"), false);

    const provenance = getDb()
      .prepare(
        `SELECT batch_id, acquisition_method, connector_instance_id, stream, record_key
           FROM record_acquisition_provenance
          WHERE connector_instance_id = ?
            AND stream = 'timeline_points'
            AND record_key = 'point_1'`
      )
      .get(connectionId);
    assert.ok(provenance, "accepted artifact record has acquisition provenance");
    assert.equal(provenance.batch_id, subObject(active.body, "import_receipt").batch_id);
    assert.equal(provenance.acquisition_method, "owner_artifact");
    assert.equal(provenance.connector_instance_id, connectionId);

    const publicRead = await fetch(
      `${rsUrl}/v1/streams/timeline_points/records?connector_id=${encodeURIComponent("google-maps")}&connection_id=${encodeURIComponent(connectionId)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    const publicReadText = await publicRead.text();
    assert.equal(publicRead.status, 200, publicReadText);
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(publicReadText, /"point_1"/, "public read should still expose the accepted record");
    for (const forbidden of ["acquisition_coverage", "import_receipt", "artifact_sha256", "media_coverage"]) {
      assert.ok(!publicReadText.includes(forbidden), `${forbidden} must not leak onto public /v1 records reads`);
    }

    const providerBatchId = "ab_provider_api_same_stream";
    getDb()
      .prepare(
        `INSERT INTO acquisition_batches(
           batch_id, owner_subject_id, connector_id, connector_instance_id,
           acquisition_method, source_format, parser_version, artifact_sha256,
           uploaded_file_name, status, event_time_start, event_time_end,
           parsed_count, accepted_count, duplicate_count, skipped_count, failed_count,
           media_coverage_json, warnings_json, receipt_json, created_at, updated_at
         )
         VALUES(?, ?, ?, ?, 'provider_api', 'data_portability', 'test-provider-v1', NULL,
           NULL, 'validated', '2024-06-05T13:45:22.000Z', '2024-06-06T00:00:00.000Z',
           1, 0, 0, 0, 0, NULL, '[]', NULL, '9999-01-01T00:00:00.000Z', '9999-01-01T00:00:00.000Z')`
      )
      .run(providerBatchId, OWNER_SUBJECT_ID, "google-maps", connectionId);

    const apiIngest = await ingest(rsUrl, ownerToken, "google-maps", connectionId, "timeline_points", [
      {
        emitted_at: "2024-06-05T13:45:22.000Z",
        id: "point_1",
        latitude: 37.7749,
        longitude: -122.4194,
        source_format: "data_portability",
        source_kind: "raw_location",
        timestamp: "2024-06-05T13:45:22.000Z",
      },
    ]);
    assert.equal(apiIngest.status, 200, apiIngest.text);

    const provenanceMethods = (
      getDb()
        .prepare(
          `SELECT acquisition_method
           FROM record_acquisition_provenance
          WHERE connector_instance_id = ?
            AND stream = 'timeline_points'
            AND record_key = 'point_1'
          ORDER BY acquisition_method`
        )
        .all(connectionId) as Array<{ acquisition_method: string }>
    ).map((row) => row.acquisition_method);
    assert.deepEqual(provenanceMethods, ["owner_artifact", "provider_api"]);

    const batchCounts = getDb()
      .prepare(
        `SELECT batch_id, accepted_count
           FROM acquisition_batches
          WHERE connector_instance_id = ?
          ORDER BY created_at ASC, batch_id ASC`
      )
      .all(connectionId) as Array<{ batch_id: string; accepted_count: number }>;
    assert.deepEqual(
      batchCounts.map((row) => [row.batch_id, row.accepted_count]),
      [
        [subObject(active.body, "import_receipt").batch_id, 1],
        [providerBatchId, 1],
      ]
    );
  });
});

test("ChatGPT browser-enrollment-shell draft is classified browser_session, not static_secret, despite its credential-capture manifest", async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, "chatgpt");
    const cookie = await login(asUrl);

    const created = await createBrowserEnrollmentShell(asUrl, cookie, "chatgpt");
    assert.equal(created.status, 201, created.text);
    assert.equal(created.body.object, "browser_enrollment_shell");
    const connectionId = requireString(created.body.connection_id, "created.body.connection_id");

    // Binding-first classification: ChatGPT's manifest declares an optional
    // static_secret credential_capture block, but the connection is bound as
    // a browser-enrollment shell, so it must classify as browser_session and
    // never fall back to the manifest's static-secret capability.
    const awaiting = await getStatus(asUrl, cookie, connectionId);
    assert.equal(awaiting.status, 200, awaiting.text);
    assert.equal(awaiting.body.status, "draft");
    assert.equal(awaiting.body.setup_kind, "browser_session");
    assert.notEqual(awaiting.body.setup_kind, "static_secret");
    assert.equal(awaiting.body.setup_state, "awaiting_browser_login");
    assert.notEqual(awaiting.body.setup_state, "awaiting_credential");
    assert.equal(subObject(awaiting.body, "setup_material").kind, "browser_session");
    assert.equal(subObject(awaiting.body, "setup_material").label, "Browser login");
    assert.equal(subObject(awaiting.body, "setup_material").present, false);
    assert.equal(subObject(awaiting.body, "credential").present, false);
    assert.equal(awaiting.body.pending, true);
    assert.equal(awaiting.body.running, false);

    // An active run is real login/setup progress for a browser-session
    // connection even though no credential was ever captured.
    seedActiveRun(connectionId, "chatgpt", "run_browser_status_inflight");
    const running = await getStatus(asUrl, cookie, connectionId);
    assert.equal(running.body.setup_kind, "browser_session");
    assert.equal(running.body.setup_state, "first_sync_running");
    assert.equal(running.body.running, true);
    assert.equal(subObject(running.body, "credential").present, false);
    clearActiveRun(connectionId);

    // A failed first sync on a browser-session connection gets a browser-safe
    // remediation, never "re-enter the provider credential".
    const runId = "run_browser_status_failed";
    await emitTerminalRunEvent("chatgpt", runId, "failed", {}, connectionId);
    const failed = await getStatus(asUrl, cookie, connectionId, runId);
    assert.equal(failed.status, 200, failed.text);
    assert.equal(failed.body.setup_kind, "browser_session");
    assert.equal(failed.body.setup_state, "first_sync_failed");
    assert.equal(failed.body.pending, false);
    assert.ok(failed.body.last_error, "failed first sync must carry last_error");
    const remediation = String(subObject(failed.body, "last_error").remediation);
    assert.doesNotMatch(remediation, NO_BROWSER_CREDENTIAL_REMEDIATION);
    assert.doesNotMatch(remediation, NO_BROWSER_REENTER_REMEDIATION);
    assert.match(remediation, SECURE_BROWSER_REMEDIATION);
  });
});

test("setup status requires an owner session and 404s an unknown connection", async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, "gmail");
      const cookie = await login(asUrl);

      // Unauthenticated read is rejected (no owner session cookie).
      const anon = await getStatus(asUrl, "", "cin_does_not_exist");
      assert.ok(anon.status === 401 || anon.status === 403, `expected auth rejection, got ${anon.status}`);

      // Unknown connection id is a clean 404, not a fabricated status.
      const missing = await getStatus(asUrl, cookie, "cin_does_not_exist");
      assert.equal(missing.status, 404, missing.text);
    });
  });
});
