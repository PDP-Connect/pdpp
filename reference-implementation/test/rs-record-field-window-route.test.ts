// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * HTTP route coverage for the bounded field-window read:
 *   GET /v1/streams/:stream/records/:id/field-window
 *
 * This route is the HTTP surface of the MCP content-ladder substrate
 * (`getRecordFieldWindow`, proven dual-backend in
 * `record-field-window-substrate.test.js`). The substrate test proves the
 * in-process reader enforces grant scope and clamps the window; THIS test
 * proves the HTTP wiring around it: auth, scope/binding resolution, the window
 * envelope shape, default + explicit bounds, paging via `offset_chars`, and the
 * typed-error -> HTTP status mapping for a missing selector and an absent
 * field.
 *
 * It runs the owner-token read path (a real `startServer` boot), which drives
 * the exact same route handler as a scoped client token. The cross-connection
 * fan-in and the grant-withheld-field 403 are covered at the substrate layer;
 * here we assert the route faithfully exposes the substrate envelope.
 *
 * Spec: openspec/changes/add-mcp-content-ladder/specs/mcp-adapter/spec.md
 *       (#"MCP bounded field reads SHALL be served by a grant-enforced
 *        resource-server path")
 */

import assert from "node:assert/strict";
import test from "node:test";

import { startServer } from "../server/index.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../server/owner-auth.ts";
import { ingestRecord } from "../server/records.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const TEST_DCR_INITIAL_ACCESS_TOKEN = "pdpp-reference-test-initial-access-token";

// A body long enough to exceed one default 4096-char window, so paging is
// observable. The substrate default `limit_chars` is 4096.
const LONG_BODY = "The quick brown fox jumps over the lazy dog. ".repeat(300).trim();

const CONNECTOR_ID = "field_window_route_demo";
const CONNECTOR_INSTANCE_ID = "cin_field_window_route_demo";
const STREAM = "emails";

const MANIFEST = {
  connector_id: CONNECTOR_ID,
  display_name: "Field Window Route Demo",
  protocol_version: "0.1.0",
  streams: [
    {
      consent_time_field: "created_at",
      cursor_field: "created_at",
      name: STREAM,
      primary_key: ["id"],
      schema: {
        properties: {
          body: { type: "string" },
          created_at: { format: "date-time", type: "string" },
          id: { type: "string" },
          read_count: { type: "integer" },
          subject: { type: "string" },
        },
        required: ["id"],
        type: "object",
      },
      selection: { fields: true },
    },
  ],
  version: "1.0.0",
};

const SEED = [
  {
    body: LONG_BODY,
    created_at: "2026-01-01T00:00:00.000Z",
    id: "e1",
    read_count: 3,
    subject: "Hello",
  },
];

// `startServer`'s inferred asServer/rsServer type comes from a framework
// `.listen()` call whose TS overload resolves to an http2-shaped type, but at
// runtime these are plain node:http/https servers (the framework never
// negotiates ALPN in this reference stack) — so `closeAllConnections` (added
// Node 18.2+) and the single-error-arg `close` callback genuinely exist and
// are safe to declare here. Established pattern, see
// connector-gap-severity.test.ts.
type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  rsServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
};

async function closeServer(server: TestServer): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((r) => server.asServer.close(r)),
    new Promise((r) => server.rsServer.close(r)),
  ]);
}

async function fetchJson(url: string, opts: RequestInit = {}): Promise<{ body: unknown; status: number }> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body, status: resp.status };
}

interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
}

interface DeviceTokenResponse {
  access_token: string;
}

interface GrantRequestInitiateResponse {
  request_uri: string;
}

interface ApprovedGrant {
  token?: string;
}

interface FieldWindow {
  complete: boolean;
  end_chars: number;
  has_more: boolean;
  limit_chars: number;
  match_end_chars?: number;
  match_start_chars?: number;
  next_offset_chars: number | null;
  previous_offset_chars: number | null;
  start_chars: number;
  text: string;
  total_chars: number;
}

interface FieldWindowResponseBody {
  field: { path: string; type: string };
  object: string;
  record_id: string;
  stream: string;
  window: FieldWindow;
}

interface ErrorResponseBody {
  error: { code: string; param?: string };
}

interface GrantRequestParams {
  access_mode: string;
  client_id: string;
  connector_id?: string;
  purpose_code: string;
  purpose_description: string;
  source?: { id: string; kind: string };
  streams: Array<{ fields?: string[]; name: string }>;
}

async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
  const clientId = "cli_longview";
  const { body: deviceBody } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.ok(deviceBody, "expected a device_authorization response body");
  const device = deviceBody as DeviceAuthorizationResponse;
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const { body: tokenResponseBody } = await fetchJson(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.ok(tokenResponseBody, "expected an oauth/token response body");
  const tokenBody = tokenResponseBody as DeviceTokenResponse;
  return tokenBody.access_token;
}

// biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
async function startGrantRequest(asUrl: string, params: GrantRequestParams) {
  return fetchJson(`${asUrl}/oauth/par`, {
    body: JSON.stringify({
      authorization_details: [
        {
          access_mode: params.access_mode,
          purpose_code: params.purpose_code,
          purpose_description: params.purpose_description,
          source: params.source || { id: params.connector_id, kind: "connector" },
          streams: params.streams,
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: params.client_id,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

// biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
async function approveGrantRequest(asUrl: string, requestUri: string, subjectId = "owner_local") {
  return fetchJson(`${asUrl}/consent/approve`, {
    body: JSON.stringify({ request_uri: requestUri, subject_id: subjectId }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

async function approveGrant(asUrl: string, subjectId: string, params: GrantRequestParams): Promise<ApprovedGrant> {
  const { body: initiateBody } = await startGrantRequest(asUrl, params);
  assert.ok(initiateBody, "expected a PAR initiate response body");
  const initiate = initiateBody as GrantRequestInitiateResponse;
  const { body: approvedBody } = await approveGrantRequest(asUrl, initiate.request_uri, subjectId);
  assert.ok(approvedBody, "expected a consent/approve response body");
  return approvedBody as ApprovedGrant;
}

async function registerManifest(asUrl: string, manifest: typeof MANIFEST): Promise<void> {
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(resp.status, 201, `register ${manifest.connector_id}`);
}

async function seedStream(
  _rsUrl: string,
  _ownerToken: string,
  connectorId: string,
  stream: string,
  records: typeof SEED,
  ownerSubjectId = OWNER_AUTH_DEFAULT_SUBJECT_ID
): Promise<void> {
  const store = createSqliteConnectorInstanceStore();
  const now = new Date().toISOString();
  await store.upsert({
    connectorId,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    createdAt: now,
    displayName: "Field Window Route Demo",
    ownerSubjectId,
    sourceBinding: { account: "field-window-route@example.test" },
    sourceBindingKey: "field-window-route@example.test",
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
  for (const record of records) {
    // biome-ignore lint/performance/noAwaitInLoops: ordered test setup is intentionally sequential
    const outcome = await ingestRecord(
      {
        connector_id: connectorId,
        connector_instance_id: CONNECTOR_INSTANCE_ID,
      },
      {
        data: record,
        emitted_at: record.created_at,
        key: record.id,
        stream,
      }
    );
    assert.equal(outcome.changed, true, `seed ${stream}/${record.id}`);
  }
}

async function withHarness(fn: (harness: { asUrl: string; rsUrl: string; server: TestServer }) => Promise<void>) {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    quiet: true,
    rsPort: 0,
  })) as TestServer;
  try {
    await fn({
      asUrl: `http://localhost:${server.asPort}`,
      rsUrl: `http://localhost:${server.rsPort}`,
      server,
    });
  } finally {
    await closeServer(server);
  }
}

function fieldWindowUrl(rsUrl: string, stream: string, recordId: string, params: Record<string, string>): string {
  const search = new URLSearchParams({
    connector_id: CONNECTOR_ID,
    ...params,
  });
  return (
    `${rsUrl}/v1/streams/${encodeURIComponent(stream)}/records/${encodeURIComponent(recordId)}/field-window` +
    `?${search.toString()}`
  );
}

test("field-window route returns a bounded default window and pages with offset_chars", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    await registerManifest(asUrl, MANIFEST);
    await seedStream(rsUrl, ownerToken, CONNECTOR_ID, STREAM, SEED);

    const auth = { headers: { Authorization: `Bearer ${ownerToken}` } };

    // Default window: no bounds -> offset 0, default 4096-char limit. The body
    // is longer than that, so the window is incomplete and advertises a next
    // offset for paging.
    const first = await fetchJson(fieldWindowUrl(rsUrl, STREAM, "e1", { field: "body" }), auth);
    assert.equal(first.status, 200, "default window read succeeds");
    assert.ok(first.body, "expected a field-window response body");
    const firstBody = first.body as FieldWindowResponseBody;
    assert.equal(firstBody.object, "field_window");
    assert.equal(firstBody.stream, STREAM);
    assert.equal(firstBody.record_id, "e1");
    assert.equal(firstBody.field.path, "body");
    assert.equal(firstBody.field.type, "string");

    const w1 = firstBody.window;
    assert.equal(w1.start_chars, 0, "default window starts at 0");
    assert.equal(w1.limit_chars, 4096, "default limit is 4096");
    assert.equal(w1.total_chars, LONG_BODY.length, "total_chars is the full field length");
    assert.equal(w1.complete, false, "a long field is not complete in one default window");
    assert.equal(w1.has_more, true, "more remains after the first window");
    assert.equal(typeof w1.text, "string");
    assert.equal(w1.text.length, 4096, "first window is exactly the default limit");
    assert.equal(w1.text, LONG_BODY.slice(0, 4096), "first window is the leading slice");
    assert.equal(w1.next_offset_chars, w1.end_chars, "next offset continues from end of window");
    assert.equal(w1.previous_offset_chars, null, "no previous window before offset 0");

    const needle = "lazy dog";
    const matchStart = LONG_BODY.indexOf(needle);
    const qWindow = await fetchJson(
      fieldWindowUrl(rsUrl, STREAM, "e1", {
        after_chars: "7",
        before_chars: "5",
        field: "body",
        q: needle,
      }),
      auth
    );
    assert.equal(qWindow.status, 200, "q context window read succeeds");
    assert.ok(qWindow.body, "expected a field-window response body");
    const qWindowBody = qWindow.body as FieldWindowResponseBody;
    assert.equal(qWindowBody.window.start_chars, matchStart - 5, "q context starts before match");
    assert.equal(qWindowBody.window.match_start_chars, matchStart, "q match start is reported");
    assert.equal(qWindowBody.window.match_end_chars, matchStart + needle.length, "q match end is reported");
    assert.equal(
      qWindowBody.window.text,
      LONG_BODY.slice(matchStart - 5, matchStart + needle.length + 7),
      "q context window is the bounded match slice"
    );

    // Walk every adjacent window to the end via the advertised next offset.
    // The reassembled text must equal the full field exactly, each window must
    // be the contiguous next slice, and only the final window reports
    // `has_more=false` / `next_offset_chars=null`.
    let assembled = w1.text;
    let cursorOffset: number | null = w1.next_offset_chars;
    let guard = 0;
    while (cursorOffset !== null) {
      guard += 1;
      assert.ok(guard < 100, "paging terminates");
      // biome-ignore lint/performance/noAwaitInLoops: ordered test setup is intentionally sequential
      const page = await fetchJson(
        fieldWindowUrl(rsUrl, STREAM, "e1", { field: "body", offset_chars: String(cursorOffset) }),
        auth
      );
      assert.equal(page.status, 200, "each subsequent window read succeeds");
      assert.ok(page.body, "expected a field-window response body");
      const pageBody = page.body as FieldWindowResponseBody;
      const w = pageBody.window;
      assert.equal(w.start_chars, cursorOffset, "window starts where the previous ended");
      assert.equal(
        w.text,
        LONG_BODY.slice(w.start_chars, w.start_chars + w.text.length),
        "window is the contiguous next slice"
      );
      assert.ok(w.previous_offset_chars !== null, "a non-first window points back");
      assembled += w.text;
      if (w.has_more) {
        assert.notEqual(w.next_offset_chars, null, "an incomplete window advertises a next offset");
      } else {
        assert.equal(w.next_offset_chars, null, "the final window has no next offset");
        assert.equal(w.end_chars, LONG_BODY.length, "the final window reaches the end of the field");
      }
      cursorOffset = w.next_offset_chars;
    }

    assert.equal(assembled, LONG_BODY, "paged windows reconstruct the full field exactly");
  });
});

test("field-window route enforces client grant field projections", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl, "field_window_grant_owner");
    await registerManifest(asUrl, MANIFEST);
    await seedStream(rsUrl, ownerToken, CONNECTOR_ID, STREAM, SEED, "field_window_grant_owner");

    const approved = await approveGrant(asUrl, "field_window_grant_owner", {
      access_mode: "continuous",
      client_id: "longview",
      purpose_code: "https://pdpp.dev/purpose/analytics",
      purpose_description: "field window grant test",
      source: { id: CONNECTOR_ID, kind: "connector" },
      streams: [{ fields: ["id", "created_at", "body"], name: STREAM }],
    });
    assert.ok(approved.token, `expected issued grant token, got ${JSON.stringify(approved)}`);
    const auth = { headers: { Authorization: `Bearer ${approved.token}` } };

    const allowed = await fetchJson(fieldWindowUrl(rsUrl, STREAM, "e1", { field: "body", limit_chars: "32" }), auth);
    assert.equal(allowed.status, 200, "granted field can be read through the route");
    assert.ok(allowed.body, "expected a field-window response body");
    const allowedBody = allowed.body as FieldWindowResponseBody;
    assert.equal(allowedBody.window.text, LONG_BODY.slice(0, 32));

    const denied = await fetchJson(fieldWindowUrl(rsUrl, STREAM, "e1", { field: "subject" }), auth);
    assert.equal(denied.status, 403, "ungranted field is rejected through the route");
    assert.ok(denied.body, "expected an error response body");
    const deniedBody = denied.body as ErrorResponseBody;
    assert.equal(deniedBody.error.code, "field_not_granted");
  });
});

test("field-window route honors an explicit small window", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    await registerManifest(asUrl, MANIFEST);
    await seedStream(rsUrl, ownerToken, CONNECTOR_ID, STREAM, SEED);
    const auth = { headers: { Authorization: `Bearer ${ownerToken}` } };

    const res = await fetchJson(
      fieldWindowUrl(rsUrl, STREAM, "e1", { field: "body", limit_chars: "25", offset_chars: "10" }),
      auth
    );
    assert.equal(res.status, 200);
    assert.ok(res.body, "expected a field-window response body");
    const resBody = res.body as FieldWindowResponseBody;
    const w = resBody.window;
    assert.equal(w.start_chars, 10);
    assert.equal(w.text, LONG_BODY.slice(10, 35));
    assert.equal(w.text.length, 25);
    assert.equal(w.limit_chars, 25);
    assert.equal(w.has_more, true);
  });
});

test("field-window route rejects non-integer numeric selectors with 400", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    await registerManifest(asUrl, MANIFEST);
    await seedStream(rsUrl, ownerToken, CONNECTOR_ID, STREAM, SEED);
    const auth = { headers: { Authorization: `Bearer ${ownerToken}` } };

    const res = await fetchJson(fieldWindowUrl(rsUrl, STREAM, "e1", { field: "body", offset_chars: "1.5" }), auth);
    assert.equal(res.status, 400, "non-integer offset is a malformed window selector");
    assert.ok(res.body, "expected an error response body");
    const resBody = res.body as ErrorResponseBody;
    assert.equal(resBody.error.code, "invalid_window");
    assert.equal(resBody.error.param, "offset_chars");
  });
});

test("field-window route rejects a missing field selector with 400", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    await registerManifest(asUrl, MANIFEST);
    await seedStream(rsUrl, ownerToken, CONNECTOR_ID, STREAM, SEED);
    const auth = { headers: { Authorization: `Bearer ${ownerToken}` } };

    const res = await fetchJson(
      `${rsUrl}/v1/streams/${STREAM}/records/e1/field-window?connector_id=${CONNECTOR_ID}`,
      auth
    );
    assert.equal(res.status, 400, "missing field is a 400");
    assert.ok(res.body, "expected an error response body");
    const resBody = res.body as ErrorResponseBody;
    assert.equal(resBody.error.code, "invalid_field_path");
  });
});

test("field-window route reports an absent field as 404", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    await registerManifest(asUrl, MANIFEST);
    await seedStream(rsUrl, ownerToken, CONNECTOR_ID, STREAM, SEED);
    const auth = { headers: { Authorization: `Bearer ${ownerToken}` } };

    const res = await fetchJson(fieldWindowUrl(rsUrl, STREAM, "e1", { field: "subject_does_not_exist" }), auth);
    assert.equal(res.status, 404, "absent field is a 404");
    assert.ok(res.body, "expected an error response body");
    const resBody = res.body as ErrorResponseBody;
    assert.equal(resBody.error.code, "field_not_found");
  });
});

test("field-window route reports a non-text field as 422", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    await registerManifest(asUrl, MANIFEST);
    await seedStream(rsUrl, ownerToken, CONNECTOR_ID, STREAM, SEED);
    const auth = { headers: { Authorization: `Bearer ${ownerToken}` } };

    // `read_count` is an integer field — well-formed request, but it cannot be
    // served as a readable text window.
    const res = await fetchJson(fieldWindowUrl(rsUrl, STREAM, "e1", { field: "read_count" }), auth);
    assert.equal(res.status, 422, "non-text field is a 422");
    assert.ok(res.body, "expected an error response body");
    const resBody = res.body as ErrorResponseBody;
    assert.equal(resBody.error.code, "field_not_text");
  });
});
