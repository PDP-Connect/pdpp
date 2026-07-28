// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for filter validation/coercion on nullable scalar
 * schemas (`["string","null"]`, `["integer","null"]`, `["number","null"]`,
 * `["boolean","null"]`).
 *
 * Context: after the cursor-field parity fix for nullable types, the same
 * bug still lived in filter validation — `isScalarFieldSchema`,
 * `isRangeQueryableSchema`, and `coerceComparableValue` all branched on
 * `fieldSchema.type` with bare-string equality, so exact and range filters
 * were rejected on any nullable scalar even when the underlying non-null
 * type was supported.
 *
 * These tests model real manifest shapes (see
 * `packages/polyfill-connectors/manifests/*.json`) and exercise:
 *   - exact filters on nullable string / integer / boolean fields
 *   - range filters on nullable date-time and nullable integer fields
 *   - continued rejection of plain nullable strings (no date format) for
 *     range filters
 *   - null record values never satisfy range comparisons
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

interface NullableFiltersManifest {
  connector_id: string;
}

interface RecordListResponse {
  data: Array<{ id: string }>;
  error?: { code: string };
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

async function registerManifest(asUrl: string, manifest: NullableFiltersManifest): Promise<void> {
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
  emittedAtKey: string
): Promise<void> {
  const lines = records
    .map((record) =>
      JSON.stringify({
        data: record,
        emitted_at: record[emittedAtKey] || record.emitted_at || new Date().toISOString(),
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

// One manifest covers every filter case — all scalar shapes + a non-null
// cursor field so pagination itself never blocks these filter tests.
function nullableFiltersManifest() {
  return {
    connector_id: "nullable-filters",
    display_name: "Nullable Filters",
    protocol_version: "0.1.0",
    runtime_requirements: { bindings: { network: { required: true } } },
    streams: [
      {
        cursor_field: "created_at",
        name: "items",
        primary_key: ["id"],
        query: {
          range_filters: {
            rating: ["gte", "lte"],
            score: ["gte", "gt", "lte", "lt"],
            updated_at: ["gte", "lt"],
            // `label` deliberately NOT declared: confirms plain nullable
            // string range filters are rejected below.
          },
        },
        schema: {
          properties: {
            // Nullable boolean — exact only.
            archived: { type: ["boolean", "null"] },
            // Ordering basis — non-null so pagination parity is trivial.
            created_at: { format: "date-time", type: "string" },
            id: { type: "string" },
            // Nullable string — used for exact filters.
            label: { type: ["string", "null"] },
            // Nullable number — exact + range.
            rating: { type: ["number", "null"] },
            // Nullable integer — exact + range.
            score: { type: ["integer", "null"] },
            // Nullable date-time — range.
            updated_at: { format: "date-time", type: ["string", "null"] },
          },
          required: ["id", "created_at"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "1.0.0",
  };
}

async function seedItems(rsUrl: string, token: string, connectorId: string): Promise<void> {
  await seedStream(
    rsUrl,
    token,
    connectorId,
    "items",
    [
      {
        archived: false,
        created_at: "2026-01-01T00:00:00Z",
        id: "i1",
        label: "alpha",
        rating: 1.5,
        score: 1,
        updated_at: "2026-01-01T00:00:00Z",
      },
      {
        archived: true,
        created_at: "2026-02-01T00:00:00Z",
        id: "i2",
        label: "beta",
        rating: 4.2,
        score: 5,
        updated_at: "2026-02-01T00:00:00Z",
      },
      {
        archived: null,
        created_at: "2026-03-01T00:00:00Z",
        id: "i3",
        label: null,
        rating: null,
        score: null,
        updated_at: null,
      },
    ],
    "created_at"
  );
}

test("exact filter works on nullable string field", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const manifest = nullableFiltersManifest();
    await registerManifest(asUrl, manifest);
    const token = await issueOwnerToken(asUrl);
    await seedItems(rsUrl, token, manifest.connector_id);

    const { status, body: rawBody } = await fetchJson(
      `${rsUrl}/v1/streams/items/records` +
        `?connector_id=${encodeURIComponent(manifest.connector_id)}` +
        "&filter[label]=beta",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const body = rawBody as RecordListResponse;
    assert.equal(status, 200);
    assert.deepEqual(
      body.data.map((r) => r.id),
      ["i2"]
    );
  });
});

test("exact filter works on nullable integer and boolean fields", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const manifest = nullableFiltersManifest();
    await registerManifest(asUrl, manifest);
    const token = await issueOwnerToken(asUrl);
    await seedItems(rsUrl, token, manifest.connector_id);

    const intResp = await fetchJson(
      `${rsUrl}/v1/streams/items/records` +
        `?connector_id=${encodeURIComponent(manifest.connector_id)}` +
        "&filter[score]=5",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const intBody = intResp.body as RecordListResponse;
    assert.equal(intResp.status, 200);
    assert.deepEqual(
      intBody.data.map((r) => r.id),
      ["i2"]
    );

    const boolResp = await fetchJson(
      `${rsUrl}/v1/streams/items/records` +
        `?connector_id=${encodeURIComponent(manifest.connector_id)}` +
        "&filter[archived]=true",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const boolBody = boolResp.body as RecordListResponse;
    assert.equal(boolResp.status, 200);
    assert.deepEqual(
      boolBody.data.map((r) => r.id),
      ["i2"]
    );
  });
});

test("range filter works on nullable date-time field", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const manifest = nullableFiltersManifest();
    await registerManifest(asUrl, manifest);
    const token = await issueOwnerToken(asUrl);
    await seedItems(rsUrl, token, manifest.connector_id);

    const { status, body: rawBody } = await fetchJson(
      `${rsUrl}/v1/streams/items/records` +
        `?connector_id=${encodeURIComponent(manifest.connector_id)}` +
        "&filter[updated_at][gte]=2026-02-01T00:00:00Z",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const body = rawBody as RecordListResponse;
    assert.equal(status, 200);
    // i2 matches; i1 is earlier; i3 has null updated_at and must not match.
    // biome-ignore lint/suspicious/useArraySortCompare: the test relies on the platform default lexical sort behavior.
    assert.deepEqual(body.data.map((r) => r.id).sort(), ["i2"]);
  });
});

test("range filter works on nullable integer field", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const manifest = nullableFiltersManifest();
    await registerManifest(asUrl, manifest);
    const token = await issueOwnerToken(asUrl);
    await seedItems(rsUrl, token, manifest.connector_id);

    const { status, body: rawBody } = await fetchJson(
      `${rsUrl}/v1/streams/items/records` +
        `?connector_id=${encodeURIComponent(manifest.connector_id)}` +
        "&filter[score][gte]=2",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const body = rawBody as RecordListResponse;
    assert.equal(status, 200);
    // i2 (score=5) matches; i1 (score=1) excluded; i3 (null) excluded.
    // biome-ignore lint/suspicious/useArraySortCompare: the test relies on the platform default lexical sort behavior.
    assert.deepEqual(body.data.map((r) => r.id).sort(), ["i2"]);
  });
});

test("range filter on plain nullable string (no date format) is rejected", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const manifest = nullableFiltersManifest();
    await registerManifest(asUrl, manifest);
    const token = await issueOwnerToken(asUrl);
    await seedItems(rsUrl, token, manifest.connector_id);

    // `label` is `["string","null"]` with no format — range must be refused
    // even though the stream's other fields happily accept range filters.
    const { status, body: rawBody } = await fetchJson(
      `${rsUrl}/v1/streams/items/records` +
        `?connector_id=${encodeURIComponent(manifest.connector_id)}` +
        "&filter[label][gte]=alpha",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const body = rawBody as RecordListResponse;
    assert.equal(status, 400);
    assert.ok(body.error, "expected an error envelope");
    assert.equal(body.error.code, "invalid_request");
  });
});

test("null record values never satisfy range comparisons", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const manifest = nullableFiltersManifest();
    await registerManifest(asUrl, manifest);
    const token = await issueOwnerToken(asUrl);
    await seedItems(rsUrl, token, manifest.connector_id);

    // Very wide range — would sweep everything if nulls were coerced to 0 or
    // to an empty string. i3 has null `score` and must still be excluded.
    const { status, body: rawBody } = await fetchJson(
      `${rsUrl}/v1/streams/items/records` +
        `?connector_id=${encodeURIComponent(manifest.connector_id)}` +
        "&filter[score][gte]=-1000000" +
        "&filter[score][lte]=1000000",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const body = rawBody as RecordListResponse;
    assert.equal(status, 200);
    // biome-ignore lint/suspicious/useArraySortCompare: the test relies on the platform default lexical sort behavior.
    assert.deepEqual(body.data.map((r) => r.id).sort(), ["i1", "i2"]);
  });
});
