// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { LocalDeviceClient } from "../../packages/polyfill-connectors/src/local-device-client.ts";
import {
  buildLocalDeviceIngestBatchRequest,
  buildLocalDeviceRecordEnvelope,
} from "../../packages/polyfill-connectors/src/local-device-envelope.ts";
import { canonicalConnectorKeyFromManifest } from "../server/connector-key.ts";
import { introspectionHeaders } from "./helpers/introspection.ts";
import { TEST_RS_INTROSPECTION_CREDENTIALS } from "./helpers/introspection-test-credentials.ts";
import { startServer } from "../server/index.ts";
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from "../server/stores/credential-encryption.ts";

const OWNER_PASSWORD = "owner-source-to-mcp-closure-password";
const OWNER_SUBJECT_ID = "owner_local";
const CREDENTIAL_KEY = "owner-source-to-mcp-closure-test-key";
const STATIC_SECRET = "synthetic fixture app password";
const FIXTURE_TIME = "2026-08-06T12:00:00.000Z";
const CSRF_FIELD_RE = /<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/;
const CLOSURE_MCP_MISSING_RE = /scoped MCP must read exactly the newly accepted fixture record/;
const GMAIL_FIXTURE_PATH =
  "../../packages/polyfill-connectors/fixtures/gmail/scrubbed/pilot-real-shape/records/messages.jsonl";
const CODEX_FIXTURE_PATH =
  "../../packages/polyfill-connectors/fixtures/codex/scrubbed/pilot-real-shape/records/messages.jsonl";

type StartedServer = Awaited<ReturnType<typeof startServer>>;
type JsonRecord = Record<string, unknown>;

interface JsonResponse {
  body: unknown;
  response: Response;
  status: number;
  text: string;
}

interface ConnectorManifest extends JsonRecord {
  connector_id: string;
  streams: Array<{ name: string; [key: string]: unknown }>;
}

interface OwnerSession {
  cookie: string;
  csrfField: string;
}

interface ClosureEvidence {
  acceptedRecordReadableBeforeRevoke: boolean;
  grantActiveAfterGrantRevoke: boolean;
  grantActiveAfterSourceRevoke: boolean;
  mcpRecordIds: string[];
  mcpStatusAfterGrantRevoke: number;
  refVisibleStatuses: Record<string, string>;
  sourceRevokeStatus: string;
  stoppedIngestStatus: number;
}

function asRecord(value: unknown, description: string): JsonRecord {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), description);
  return value as JsonRecord;
}

function stringField(value: unknown, field: string): string {
  const record = asRecord(value, `expected an object containing ${field}`);
  assert.equal(typeof record[field], "string", `${field} must be a string`);
  return record[field] as string;
}

function objectField(value: unknown, field: string): JsonRecord {
  const record = asRecord(value, `expected an object containing ${field}`);
  return asRecord(record[field], `${field} must be an object`);
}

async function fetchJson(url: string | URL, init: RequestInit = {}): Promise<JsonResponse> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body, response, status: response.status, text };
}

function getSetCookies(response: Response): string[] {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }
  const single = response.headers.get("set-cookie");
  return single ? [single] : [];
}

function cookiePair(headers: readonly string[], name: string): string | null {
  for (const header of headers) {
    const [pair] = header.split(";", 1);
    if (pair?.startsWith(`${name}=`)) {
      return pair;
    }
  }
  return null;
}

function csrfFieldFromHtml(html: string): string {
  const match = html.match(CSRF_FIELD_RE);
  assert.ok(match?.[1], "owner login must render a CSRF field");
  return match[1];
}

async function login(asUrl: string): Promise<OwnerSession> {
  const loginPage = await fetch(`${asUrl}/owner/login`, { headers: { Accept: "text/html" }, redirect: "manual" });
  const csrfCookie = cookiePair(getSetCookies(loginPage), "pdpp_owner_csrf");
  const csrfField = csrfFieldFromHtml(await loginPage.text());
  assert.ok(csrfCookie, "owner login must set a CSRF cookie");

  const loginResponse = await fetch(`${asUrl}/owner/login`, {
    body: new URLSearchParams({ _csrf: csrfField, password: OWNER_PASSWORD, return_to: "/" }).toString(),
    headers: {
      Accept: "text/html",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: csrfCookie,
    },
    method: "POST",
    redirect: "manual",
  });
  const sessionCookie = cookiePair(getSetCookies(loginResponse), "pdpp_owner_session");
  assert.ok(sessionCookie, `owner login must issue a session cookie (${loginResponse.status})`);
  return { cookie: `${sessionCookie}; ${csrfCookie}`, csrfField };
}

async function withCredentialKey<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
  process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = CREDENTIAL_KEY;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
    } else {
      process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = previous;
    }
  }
}

function permissiveCredentialProber() {
  return async ({ context }: { context?: { setupFields?: JsonRecord } }) => ({
    detail: null,
    identity: context?.setupFields?.account_email ?? "fixture@example.com",
    ok: true,
  });
}

async function closeServer(server: StartedServer): Promise<void> {
  server.schedulerManager?.stop?.();
  (server.asServer as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  (server.rsServer as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  await Promise.allSettled([
    new Promise<void>((resolve) => server.asServer.close(() => resolve())),
    new Promise<void>((resolve) => server.rsServer.close(() => resolve())),
  ]);
}

function startClosureServer(): Promise<StartedServer> {
  return startServer({
    asPort: 0,
    autoEnrollEligibleSchedules: false,
    dbPath: ":memory:",
    introspectionCallerCredentials: TEST_RS_INTROSPECTION_CREDENTIALS,
    ownerAuthPassword: OWNER_PASSWORD,
    ownerAuthSubjectId: OWNER_SUBJECT_ID,
    quiet: true,
    rsIntrospectionCredentials: TEST_RS_INTROSPECTION_CREDENTIALS,
    rsPort: 0,
    staticSecretAutoResume: false,
    staticSecretCredentialProber: permissiveCredentialProber(),
  });
}

function loadManifest(name: string): ConnectorManifest {
  const raw = JSON.parse(
    readFileSync(new URL(`../../packages/polyfill-connectors/manifests/${name}.json`, import.meta.url), "utf8")
  ) as ConnectorManifest;
  const canonical = canonicalConnectorKeyFromManifest(raw);
  assert.ok(canonical, `${name} manifest must have a canonical connector key`);
  return { ...raw, connector_id: canonical };
}

async function registerConnector(asUrl: string, session: OwnerSession, name: string): Promise<ConnectorManifest> {
  const manifest = loadManifest(name);
  const registered = await fetchJson(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json", Cookie: session.cookie },
    method: "POST",
  });
  assert.equal(registered.status, 201, `register ${name}: ${registered.text}`);
  return manifest;
}

async function createStaticDraft(asUrl: string, session: OwnerSession): Promise<string> {
  const created = await fetchJson(`${asUrl}/_ref/connectors/gmail/draft-connection`, {
    body: JSON.stringify({ setup_fields: { account_email: "fixture-owner@example.com" } }),
    headers: { "Content-Type": "application/json", Cookie: session.cookie },
    method: "POST",
  });
  assert.equal(created.status, 201, created.text);
  return stringField(created.body, "connection_id");
}

async function captureStaticCredential(
  asUrl: string,
  session: OwnerSession,
  sourceConnectionId: string
): Promise<void> {
  const captured = await fetchJson(
    `${asUrl}/_ref/connections/${encodeURIComponent(sourceConnectionId)}/static-secret-credential`,
    {
      body: JSON.stringify({ credential_kind: "app_password", secret: STATIC_SECRET }),
      headers: { "Content-Type": "application/json", Cookie: session.cookie },
      method: "POST",
    }
  );
  assert.ok(captured.status === 200 || captured.status === 201, captured.text);
}

async function createManualDraft(asUrl: string, session: OwnerSession): Promise<string> {
  const url = new URL(`${asUrl}/_ref/connectors/google-maps/manual-upload-draft-connection`);
  url.searchParams.set("file_name", "Timeline.json");
  const created = await fetchJson(url, {
    body: JSON.stringify({
      locations: [{ latitudeE7: 377_749_000, longitudeE7: -1_224_194_000, timestampMs: "1717595122000" }],
    }),
    headers: { "Content-Type": "application/vnd.pdpp.manual-upload", Cookie: session.cookie },
    method: "POST",
  });
  assert.equal(created.status, 201, created.text);
  return stringField(created.body, "connection_id");
}

async function issueOwnerToken(asUrl: string, session: OwnerSession): Promise<string> {
  const device = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: "cli_longview" }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(device.status, 200, device.text);
  const approved = await fetchJson(`${asUrl}/device/approve`, {
    body: new URLSearchParams({
      _csrf: session.csrfField,
      subject_id: OWNER_SUBJECT_ID,
      user_code: stringField(device.body, "user_code"),
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: session.cookie },
    method: "POST",
  });
  assert.equal(approved.status, 200, approved.text);
  const token = await fetchJson(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: "cli_longview",
      device_code: stringField(device.body, "device_code"),
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(token.status, 200, token.text);
  return stringField(token.body, "access_token");
}

function fixtureRecord(relativePath: string): JsonRecord {
  const line = readFileSync(new URL(relativePath, import.meta.url), "utf8")
    .split("\n")
    .find((candidate) => candidate.trim());
  assert.ok(line, `fixture ${relativePath} must contain a record`);
  return JSON.parse(line) as JsonRecord;
}

function ingestNdjson(
  rsUrl: string,
  ownerToken: string,
  connectorId: string,
  sourceConnectionId: string,
  stream: string,
  data: JsonRecord,
  emittedAt = FIXTURE_TIME
): Promise<JsonResponse> {
  const recordKey = stringField(data, "id");
  return fetchJson(
    `${rsUrl}/v1/ingest/${encodeURIComponent(stream)}?connector_id=${encodeURIComponent(connectorId)}&connector_instance_id=${encodeURIComponent(sourceConnectionId)}`,
    {
      body: JSON.stringify({ data, emitted_at: emittedAt, key: recordKey }),
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/x-ndjson" },
      method: "POST",
    }
  );
}

interface EnrolledLocalDevice {
  connector_id: string;
  device_id: string;
  device_token: string;
  source_instance_id: string;
}

async function enrollLocalDevice(
  asUrl: string,
  session: OwnerSession,
  client: LocalDeviceClient
): Promise<EnrolledLocalDevice> {
  const code = await fetchJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
    body: JSON.stringify({ connector_id: "codex", local_binding_name: "closure-codex-laptop" }),
    headers: { "Content-Type": "application/json", Cookie: session.cookie },
    method: "POST",
  });
  assert.equal(code.status, 201, code.text);
  const enrolled = await client.exchangeEnrollment({
    device_label: "closure fixture device",
    enrollment_code: stringField(code.body, "enrollment_code"),
  });
  return enrolled as EnrolledLocalDevice;
}

async function ownerConnections(rsUrl: string, ownerToken: string): Promise<JsonRecord[]> {
  const listed = await fetchJson(`${rsUrl}/v1/owner/connections`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(listed.status, 200, listed.text);
  const { data } = asRecord(listed.body, "owner connections response");
  assert.ok(Array.isArray(data), "owner connections response must contain data[]");
  return data as JsonRecord[];
}

function connectionIdFromRow(row: JsonRecord): string {
  return String(row.connection_id ?? row.connector_instance_id ?? "");
}

function assertClosureEvidence(evidence: ClosureEvidence, expectedMcpId: string): void {
  assert.deepEqual(
    Object.values(evidence.refVisibleStatuses).sort(),
    ["active", "active", "active"],
    "all three accepted sources must be visible and active before revoke"
  );
  assert.deepEqual(
    evidence.mcpRecordIds,
    [expectedMcpId],
    "scoped MCP must read exactly the newly accepted fixture record"
  );
  assert.equal(evidence.sourceRevokeStatus, "revoked");
  assert.ok(evidence.stoppedIngestStatus >= 400, "source revoke must reject a new collection attempt");
  assert.equal(
    evidence.acceptedRecordReadableBeforeRevoke,
    true,
    "the accepted record must be readable before source revoke"
  );
  assert.equal(evidence.grantActiveAfterSourceRevoke, true, "source revoke must not revoke the app grant");
  assert.equal(evidence.grantActiveAfterGrantRevoke, false, "grant revoke must deactivate the app token");
  assert.notEqual(evidence.mcpStatusAfterGrantRevoke, 200, "grant revoke must stop the MCP token");
}

function mcpRecordIds(responseBody: unknown): string[] {
  const result = objectField(responseBody, "result");
  const structured = objectField(result, "structuredContent");
  const { data } = structured;
  if (Array.isArray(data)) {
    return data.map((candidate) => stringField(candidate, "id"));
  }
  const dataRecord = data && typeof data === "object" && !Array.isArray(data) ? (data as JsonRecord) : {};
  for (const key of ["records", "items", "data"]) {
    const candidates = dataRecord[key];
    if (Array.isArray(candidates)) {
      return candidates.map((candidate) => stringField(candidate, "id"));
    }
  }
  return [];
}

async function registerAuthCodeClient(asUrl: string, session: OwnerSession): Promise<string> {
  const registered = await fetchJson(`${asUrl}/oauth/register`, {
    body: JSON.stringify({
      application_type: "web",
      client_name: "owner closure fixture client",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: ["https://client.example/callback"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    headers: { "Content-Type": "application/json", Cookie: session.cookie },
    method: "POST",
  });
  assert.equal(registered.status, 201, registered.text);
  return stringField(registered.body, "client_id");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function completeScopedMcpFlow(
  asUrl: string,
  session: OwnerSession,
  connectorId: string
): Promise<{ accessToken: string; grantId: string }> {
  const clientId = await registerAuthCodeClient(asUrl, session);
  const verifier = randomBytes(32).toString("base64url");
  const authorizationDetails = [
    {
      access_mode: "continuous",
      purpose_code: "https://pdpp.dev/purpose/personal_ai_assistant",
      purpose_description: "Read the fixture mailbox through hosted MCP.",
      source: { id: `https://registry.pdpp.dev/connectors/${connectorId}`, kind: "connector" },
      streams: [{ fields: ["id", "subject"], name: "messages" }],
      type: "https://pdpp.dev/data-access",
    },
  ];
  const authorizeUrl = new URL(`${asUrl}/oauth/authorize`);
  authorizeUrl.searchParams.set("authorization_details", JSON.stringify(authorizationDetails));
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("code_challenge", pkceChallenge(verifier));
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("redirect_uri", "https://client.example/callback");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", "owner-closure-state");

  const authorized = await fetch(authorizeUrl, {
    headers: { Cookie: session.cookie },
    redirect: "manual",
  });
  assert.equal(authorized.status, 302, await authorized.text());
  const consent = new URL(String(authorized.headers.get("location")), asUrl);
  const requestUri = consent.searchParams.get("request_uri");
  assert.ok(requestUri, "OAuth authorize must redirect to consent");

  const review = await fetchJson(`${asUrl}/consent/review`, {
    body: JSON.stringify({ request_uri: requestUri, subject_id: OWNER_SUBJECT_ID }),
    headers: { Accept: "application/json", "Content-Type": "application/json", Cookie: session.cookie },
    method: "POST",
  });
  assert.equal(review.status, 200, review.text);
  const approvalReviewRevision = stringField(review.body, "approval_review_revision");

  const approved = await fetch(`${asUrl}/consent/approve`, {
    body: new URLSearchParams({
      _csrf: session.csrfField,
      approval_review_revision: approvalReviewRevision,
      request_uri: requestUri,
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: session.cookie },
    method: "POST",
    redirect: "manual",
  });
  assert.equal(approved.status, 302, await approved.text());
  const callback = new URL(String(approved.headers.get("location")), asUrl);
  const code = callback.searchParams.get("code");
  assert.ok(code, "consent approval must return an authorization code");

  const token = await fetchJson(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: "https://client.example/callback",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(token.status, 200, token.text);
  return { accessToken: stringField(token.body, "access_token"), grantId: stringField(token.body, "grant_id") };
}

function postMcp(rsUrl: string, accessToken: string, id: number, method: string, params: JsonRecord) {
  return fetchJson(`${rsUrl}/mcp`, {
    body: JSON.stringify({ id, jsonrpc: "2.0", method, params }),
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
}

function introspectionActive(body: unknown): boolean {
  return asRecord(body, "introspection response").active === true;
}

test("owner-source-to-mcp-closure", async () => {
  await withCredentialKey(async () => {
    const server = await startClosureServer();
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;

    try {
      // 1. Owner sign-in is real: all subsequent setup and source visibility
      // calls use the session produced by /owner/login.
      const session = await login(asUrl);
      const gmail = await registerConnector(asUrl, session, "gmail");
      await registerConnector(asUrl, session, "google_maps");
      const codex = await registerConnector(asUrl, session, "codex");
      const ownerToken = await issueOwnerToken(asUrl, session);

      // 2. Static-secret journey: draft -> credential capture -> accepted
      // parser-derived fixture record. The injected prober is deterministic
      // and cannot contact Gmail.
      const gmailConnectionId = await createStaticDraft(asUrl, session);
      await captureStaticCredential(asUrl, session, gmailConnectionId);
      const gmailFixture = fixtureRecord(GMAIL_FIXTURE_PATH);
      const gmailIngest = await ingestNdjson(
        rsUrl,
        ownerToken,
        gmail.connector_id,
        gmailConnectionId,
        "messages",
        gmailFixture
      );
      assert.equal(gmailIngest.status, 200, gmailIngest.text);

      // 3. Manual/upload journey: Timeline.json validation -> accepted point
      // record. The body is the existing synthetic Timeline fixture shape.
      const mapsConnectionId = await createManualDraft(asUrl, session);
      const mapsFixture = {
        id: "closure-timeline-point-1",
        latitude: 37.7749,
        longitude: -122.4194,
        source_format: "legacy_records",
        source_kind: "raw_location",
        timestamp: "2024-06-05T13:45:22.000Z",
      };
      const mapsIngest = await ingestNdjson(
        rsUrl,
        ownerToken,
        "google-maps",
        mapsConnectionId,
        "timeline_points",
        mapsFixture,
        "2024-06-05T13:45:22.000Z"
      );
      assert.equal(mapsIngest.status, 200, mapsIngest.text);

      // 4. Local-device journey: owner creates an enrollment code, the
      // shipped LocalDeviceClient exchanges it, and the shipped durable
      // envelope helper sends a scrubbed Codex fixture record.
      const enrollmentClient = new LocalDeviceClient({ baseUrl: asUrl, requestTimeoutMs: 5000 });
      const localDevice = await enrollLocalDevice(asUrl, session, enrollmentClient);
      const localClient = new LocalDeviceClient({
        baseUrl: asUrl,
        deviceId: localDevice.device_id,
        deviceToken: localDevice.device_token,
        requestTimeoutMs: 5000,
      });
      const codexFixture = fixtureRecord(CODEX_FIXTURE_PATH);
      const localEnvelope = buildLocalDeviceRecordEnvelope({
        batchId: "closure-codex-batch-1",
        batchSeq: 1,
        connectorId: localDevice.connector_id,
        deviceId: localDevice.device_id,
        record: {
          data: codexFixture,
          emitted_at: FIXTURE_TIME,
          key: stringField(codexFixture, "id"),
          stream: "messages",
          type: "RECORD",
        },
        sourceInstanceId: localDevice.source_instance_id,
      });
      const localAccepted = await localClient.ingestBatch(
        buildLocalDeviceIngestBatchRequest({
          batchId: "closure-codex-batch-1",
          batchSeq: 1,
          connectorId: localDevice.connector_id,
          deviceId: localDevice.device_id,
          records: [localEnvelope],
          sourceInstanceId: localDevice.source_instance_id,
        })
      );
      assert.ok(localAccepted, "local-device ingest must return an acceptance response");

      // 5. Source visibility is checked through both owner surfaces after
      // accepted records have activated every source.
      const refVisible = await fetchJson(`${asUrl}/_ref/connectors?limit=100`, {
        headers: { Cookie: session.cookie },
      });
      assert.equal(refVisible.status, 200, refVisible.text);
      const refData = asRecord(refVisible.body, "ref connector list").data;
      assert.ok(Array.isArray(refData), "ref connector list must contain data[]");
      const refRows = refData as JsonRecord[];
      const refVisibleStatuses: Record<string, string> = {};
      for (const id of [gmailConnectionId, mapsConnectionId]) {
        const row = refRows.find((candidate) => connectionIdFromRow(candidate) === id);
        assert.ok(row, `owner-session source list must show ${id}`);
        refVisibleStatuses[id] = String(row.status);
      }
      const localOwnerRows = await ownerConnections(rsUrl, ownerToken);
      const localRow = localOwnerRows.find(
        (candidate) => candidate.connector_key === codex.connector_id && candidate.source_kind === "local_device"
      );
      assert.ok(localRow, "owner-agent source list must show the enrolled Codex local source");
      const localConnectionId = connectionIdFromRow(localRow);
      assert.ok(localConnectionId, "local source list row must expose connection_id");
      const localFixtureRead = await fetchJson(
        `${rsUrl}/v1/streams/messages/records?connector_id=${encodeURIComponent(codex.connector_id)}&connection_id=${encodeURIComponent(localConnectionId)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } }
      );
      assert.equal(localFixtureRead.status, 200, localFixtureRead.text);
      assert.ok(
        localFixtureRead.text.includes(stringField(codexFixture, "id")),
        "local fixture record must be publicly readable"
      );
      refVisibleStatuses[localConnectionId] = String(localRow.status);
      assert.equal(localConnectionId.length > 0, true);
      assert.equal(Object.keys(refVisibleStatuses).length, 3);

      // 6–7. The app receives only the Gmail/messages connection and stream;
      // read the accepted fixture through the live scoped MCP route.
      const oauth = await completeScopedMcpFlow(asUrl, session, gmail.connector_id);
      const initialized = await postMcp(rsUrl, oauth.accessToken, 1, "initialize", {
        capabilities: {},
        clientInfo: { name: "owner-closure-fixture-client", version: "0.0.0" },
        protocolVersion: "2025-06-18",
      });
      assert.equal(initialized.status, 200, initialized.text);
      const queried = await postMcp(rsUrl, oauth.accessToken, 2, "tools/call", {
        arguments: { connection_id: gmailConnectionId, limit: 10, stream: "messages" },
        name: "query_records",
      });
      assert.equal(queried.status, 200, queried.text);
      assert.equal(objectField(queried.body, "result").isError, undefined);
      const gmailFixtureId = stringField(gmailFixture, "id");

      // 8. Revoke the source through the public owner-agent route. A new
      // collection attempt is rejected; the accepted record was already
      // proven readable through the scoped MCP path above.
      const sourceRevoke = await fetchJson(
        `${rsUrl}/v1/owner/connections/${encodeURIComponent(gmailConnectionId)}/revoke`,
        {
          headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
          method: "POST",
        }
      );
      assert.equal(sourceRevoke.status, 200, sourceRevoke.text);
      const sourceRevokeStatus = stringField(sourceRevoke.body, "status");
      const stoppedIngest = await ingestNdjson(rsUrl, ownerToken, gmail.connector_id, gmailConnectionId, "messages", {
        ...gmailFixture,
        id: `${gmailFixtureId}-after-revoke`,
      });
      assert.ok(stoppedIngest.status >= 400, stoppedIngest.text);
      // Source revoke leaves the app grant active. Grant revoke then stops
      // the same MCP token independently.
      const afterSourceRevoke = await fetchJson(`${asUrl}/introspect`, {
        body: new URLSearchParams({ token: oauth.accessToken }).toString(),
        headers: introspectionHeaders("application/x-www-form-urlencoded"),
        method: "POST",
      });
      assert.equal(afterSourceRevoke.status, 200, afterSourceRevoke.text);
      const grantActiveAfterSourceRevoke = introspectionActive(afterSourceRevoke.body);

      const grantRevoke = await fetchJson(`${asUrl}/grants/${encodeURIComponent(oauth.grantId)}/revoke`, {
        headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(grantRevoke.status, 200, grantRevoke.text);
      const afterGrantRevoke = await fetchJson(`${asUrl}/introspect`, {
        body: new URLSearchParams({ token: oauth.accessToken }).toString(),
        headers: introspectionHeaders("application/x-www-form-urlencoded"),
        method: "POST",
      });
      assert.equal(afterGrantRevoke.status, 200, afterGrantRevoke.text);
      const stoppedMcp = await postMcp(rsUrl, oauth.accessToken, 3, "tools/list", {});

      const afterOwnerRows = await ownerConnections(rsUrl, ownerToken);
      const revokedRow = afterOwnerRows.find((candidate) => connectionIdFromRow(candidate) === gmailConnectionId);
      assert.equal(revokedRow?.status, "revoked");

      const evidence: ClosureEvidence = {
        acceptedRecordReadableBeforeRevoke: mcpRecordIds(queried.body).includes(gmailFixtureId),
        grantActiveAfterGrantRevoke: introspectionActive(afterGrantRevoke.body),
        grantActiveAfterSourceRevoke,
        mcpRecordIds: mcpRecordIds(queried.body),
        mcpStatusAfterGrantRevoke: stoppedMcp.status,
        refVisibleStatuses,
        sourceRevokeStatus,
        stoppedIngestStatus: stoppedIngest.status,
      };
      assertClosureEvidence(evidence, gmailFixtureId);

      // Controlled mutation: the oracle must fail when the public read loses
      // the accepted fixture, proving this is a discriminator rather than a
      // journey-only smoke test.
      assert.throws(
        () => assertClosureEvidence({ ...evidence, mcpRecordIds: [] }, gmailFixtureId),
        CLOSURE_MCP_MISSING_RE
      );
    } finally {
      await closeServer(server);
    }
  });
});
