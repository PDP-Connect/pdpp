const TOP_LEVEL_REGEX_1 = /cursor_field/i;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for records pagination with nullable cursor_field
 * schemas (e.g. `type: ["string", "null"]` with `format: date-time`, or
 * `type: ["integer", "null"]`).
 *
 * Context: the SQL-layer pagination rewrite (fix-rs-query-memory-pressure)
 * asserted exact parity against the JS comparator by rejecting any
 * cursor_field whose schema wasn't numeric or ISO date/date-time. That
 * rejected the nullable variants used across the polyfill-connectors corpus
 * (gmail threads, ynab budgets, slack channels, etc.), causing /records to
 * return 500s for those streams.
 *
 * These tests model the real manifest shapes and exercise:
 *   - nullable date/date-time cursors with all-present values
 *   - nullable date/date-time cursors with some null values (missing bucket)
 *   - nullable integer cursors
 *   - cursor round-trip across pages
 *   - continued rejection of plain string cursors with no date format
 */

import assert from "node:assert/strict";
import test from "node:test";

import { startServer } from "../server/index.ts";

const TEST_DCR_INITIAL_ACCESS_TOKEN = "pdpp-reference-test-initial-access-token";

// startServer is imported from checkJs:false JS; TS infers its return's
// asServer/rsServer structurally to a union including an http2-secure
// listener variant genuinely missing closeAllConnections, even though
// these opts never request TLS. Overriding just those two members on the
// real inferred return type keeps enough structural overlap for a legal
// single-hop cast.
interface CloseableServer {
  close: (callback?: (err?: Error) => void) => unknown;
  closeAllConnections: () => void;
}

type StartedServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: CloseableServer;
  rsServer: CloseableServer;
};

interface Harness {
  asUrl: string;
  rsUrl: string;
  server: StartedServer;
}

interface CursorManifest {
  connector_id: string;
}

interface RecordListResponse {
  data: Array<{ id: string }>;
  error?: { message?: string };
  has_more: boolean;
  next_cursor?: string | null;
  object: string;
}

async function closeServer(server: StartedServer): Promise<void> {
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

async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
  const clientId = "cli_longview";
  const { body: deviceBody } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const device = deviceBody as { device_code: string; user_code: string };
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return (tokenBody as { access_token: string }).access_token;
}

async function registerManifest(asUrl: string, manifest: CursorManifest): Promise<void> {
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(resp.status, 201, `register ${manifest.connector_id}`);
}

async function seedStream(
  rsUrl: string,
  ownerToken: string,
  connectorId: string,
  stream: string,
  records: Record<string, unknown>[],
  cursorKey: string
): Promise<void> {
  const lines = records
    .map((record) =>
      JSON.stringify({
        data: record,
        emitted_at: record[cursorKey] || record.emitted_at || new Date().toISOString(),
        key: record.id,
      })
    )
    .join("\n");
  const resp = await fetch(
    `${rsUrl}/v1/ingest/${encodeURIComponent(stream)}?connector_id=${encodeURIComponent(connectorId)}`,
    {
      body: lines,
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/x-ndjson",
      },
      method: "POST",
    }
  );
  assert.equal(resp.status, 200, `ingest ${stream}`);
}

async function withHarness(fn: (harness: Harness) => Promise<void>): Promise<void> {
  // opts here never requests TLS, so app.listen() always returns a plain
  // http.Server at runtime; see the StartedServer comment above.
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    quiet: true,
    rsPort: 0,
  })) as StartedServer;
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

// Modeled after packages/polyfill-connectors/manifests/ynab.json's `budgets`
// stream — `cursor_field` is a nullable date-time string.
function nullableDateTimeManifest() {
  return {
    connector_id: "nullable-datetime",
    display_name: "Nullable DateTime Cursor",
    manifest_uri: "https://sources.example/nullable-datetime",
    protocol_version: "0.1.0",
    runtime_requirements: { bindings: { network: { required: true } } },
    streams: [
      {
        cursor_field: "last_modified_on",
        description: "Budgets, modeled after ynab.budgets",
        name: "budgets",
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            last_modified_on: {
              format: "date-time",
              type: ["string", "null"],
            },
            name: { type: "string" },
          },
          required: ["id", "name"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "1.0.0",
  };
}

// Modeled after packages/polyfill-connectors/manifests/slack.json's
// `channels` stream — `cursor_field` is a nullable integer epoch.
function nullableIntegerManifest() {
  return {
    connector_id: "nullable-integer",
    display_name: "Nullable Integer Cursor",
    manifest_uri: "https://sources.example/nullable-integer",
    protocol_version: "0.1.0",
    runtime_requirements: { bindings: { network: { required: true } } },
    streams: [
      {
        cursor_field: "created",
        description: "Channels, modeled after slack.channels",
        name: "channels",
        primary_key: ["id"],
        schema: {
          properties: {
            created: { type: ["integer", "null"] },
            id: { type: "string" },
            name: { type: "string" },
          },
          required: ["id", "name"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "1.0.0",
  };
}

// A plain-string cursor with no date format — this must still be rejected,
// because SQLite's BINARY collation on TEXT does not match JS localeCompare.
function unsupportedPlainStringManifest() {
  return {
    connector_id: "plain-string-cursor",
    display_name: "Plain String Cursor",
    manifest_uri: "https://sources.example/plain-string-cursor",
    protocol_version: "0.1.0",
    runtime_requirements: { bindings: { network: { required: true } } },
    streams: [
      {
        cursor_field: "title",
        description: "Notes keyed by arbitrary string — not a date",
        name: "notes",
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            title: { type: ["string", "null"] },
          },
          required: ["id"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "1.0.0",
  };
}

test("records paginate with nullable date-time cursor_field (all present)", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const manifest = nullableDateTimeManifest();
    await registerManifest(asUrl, manifest);
    const ownerToken = await issueOwnerToken(asUrl);
    await seedStream(
      rsUrl,
      ownerToken,
      manifest.connector_id,
      "budgets",
      [
        { id: "b_a", last_modified_on: "2026-01-01T00:00:00Z", name: "A" },
        { id: "b_b", last_modified_on: "2026-02-01T00:00:00Z", name: "B" },
        { id: "b_c", last_modified_on: "2026-03-01T00:00:00Z", name: "C" },
      ],
      "last_modified_on"
    );

    const listUrl =
      `${rsUrl}/v1/streams/budgets/records` +
      `?connector_id=${encodeURIComponent(manifest.connector_id)}` +
      "&order=asc&limit=2";
    const { status, body: rawBody } = await fetchJson(listUrl, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const body = rawBody as RecordListResponse;

    assert.equal(status, 200, "first page succeeds");
    assert.equal(body.object, "list");
    assert.equal(body.has_more, true);
    assert.deepEqual(
      body.data.map((r) => r.id),
      ["b_a", "b_b"]
    );
    assert.ok(body.next_cursor, "next_cursor should be present");

    const page2Raw = await fetchJson(`${listUrl}&cursor=${encodeURIComponent(body.next_cursor)}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const page2Body = page2Raw.body as RecordListResponse;
    assert.equal(page2Raw.status, 200);
    assert.deepEqual(
      page2Body.data.map((r) => r.id),
      ["b_c"]
    );
    assert.equal(page2Body.has_more, false);
  });
});

test("records paginate with nullable date-time cursor_field (some null values)", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const manifest = nullableDateTimeManifest();
    await registerManifest(asUrl, manifest);
    const ownerToken = await issueOwnerToken(asUrl);
    // Two null-cursor rows sit in the missing bucket — in ASC they must come
    // AFTER all present-cursor rows, in bucketed pk order.
    await seedStream(
      rsUrl,
      ownerToken,
      manifest.connector_id,
      "budgets",
      [
        { id: "b_a", last_modified_on: "2026-01-01T00:00:00Z", name: "A" },
        { id: "b_b", last_modified_on: "2026-02-01T00:00:00Z", name: "B" },
        { id: "b_null1", last_modified_on: null, name: "N1" },
        { id: "b_null2", last_modified_on: null, name: "N2" },
      ],
      "last_modified_on"
    );

    const listUrl =
      `${rsUrl}/v1/streams/budgets/records` +
      `?connector_id=${encodeURIComponent(manifest.connector_id)}` +
      "&order=asc&limit=10";
    const { status, body: rawBody } = await fetchJson(listUrl, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const body = rawBody as RecordListResponse;

    assert.equal(status, 200, "nullable-with-nulls page succeeds");
    // Present rows first (ASC cursor order), then missing bucket (pk-ordered).
    assert.deepEqual(
      body.data.map((r) => r.id),
      ["b_a", "b_b", "b_null1", "b_null2"]
    );
    assert.equal(body.has_more, false);
  });
});

test("records paginate with nullable integer cursor_field", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const manifest = nullableIntegerManifest();
    await registerManifest(asUrl, manifest);
    const ownerToken = await issueOwnerToken(asUrl);
    await seedStream(
      rsUrl,
      ownerToken,
      manifest.connector_id,
      "channels",
      [
        { created: 1000, id: "c_a", name: "A" },
        { created: 2000, id: "c_b", name: "B" },
        { created: 3000, id: "c_c", name: "C" },
        { created: null, id: "c_null", name: "N" },
      ],
      "created"
    );

    const listUrl =
      `${rsUrl}/v1/streams/channels/records` +
      `?connector_id=${encodeURIComponent(manifest.connector_id)}` +
      "&order=asc&limit=2";
    const { status, body: rawBody } = await fetchJson(listUrl, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const body = rawBody as RecordListResponse;

    assert.equal(status, 200, "first page succeeds for nullable integer cursor");
    assert.deepEqual(
      body.data.map((r) => r.id),
      ["c_a", "c_b"]
    );
    assert.equal(body.has_more, true);
    assert.ok(body.next_cursor, "next_cursor should be present");

    const page2Raw = await fetchJson(`${listUrl}&cursor=${encodeURIComponent(body.next_cursor)}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const page2Body = page2Raw.body as RecordListResponse;
    assert.equal(page2Raw.status, 200);
    // c_c (created=3000), then null row in missing bucket.
    assert.deepEqual(
      page2Body.data.map((r) => r.id),
      ["c_c", "c_null"]
    );
    assert.equal(page2Body.has_more, false);
  });
});

test("plain nullable string cursor_field with no date format is rejected at registration", async () => {
  await withHarness(async ({ asUrl }) => {
    const manifest = unsupportedPlainStringManifest();
    const resp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    // The manifest validator catches unsupported cursor_field shapes up-front
    // so the same bug class (500s on /records) cannot recur for freshly
    // registered connectors. Stale DB manifests that predate this guardrail
    // are handled by the runtime in-memory fallback path instead.
    assert.equal(resp.status, 400, "unsupported cursor_field rejected at registration");
    const body = (await resp.json()) as RecordListResponse;
    assert.ok(TOP_LEVEL_REGEX_1.test(body.error?.message ?? ""));
  });
});
