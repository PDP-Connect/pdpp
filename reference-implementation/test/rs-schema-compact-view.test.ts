// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /v1/schema?view=compact` token-efficiency + projection conformance.
 *
 * Owned by `openspec/changes/add-compact-rs-schema-view`. The REST follow-up to
 * the MCP `schema` compaction (`packages/mcp-server/test/schema-token-budget.test.js`):
 * an additive compact REST schema view for owner-agent REST clients.
 *
 * These tests register a deliberately large connector (many streams, many
 * fields, each field carrying a verbose per-field JSON Schema blob), then drive
 * the real `/v1/schema` route over HTTP and assert:
 *
 *   - the DEFAULT (`view` omitted) body stays full / current-compatible — no
 *     fields are dropped, the raw per-field JSON Schema survives;
 *   - `view=compact` stays under a documented byte budget and is dramatically
 *     smaller than the full body;
 *   - the compact body preserves stream identity, connection identity
 *     (`granted_connections[].{connection_id, display_name}`), field names,
 *     declared types, and terse capability flags;
 *   - the compact body drops the raw per-field/per-stream JSON Schema blobs;
 *   - `view=compact&stream=<name>` scopes the document to one stream and stays
 *     under a tight per-stream budget;
 *   - the compact per-field cost stays bounded as field count grows.
 *
 * No live external data is required: the body is produced by the reference
 * server from a registered manifest seeded with one connection.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorSchemaItem } from "../operations/rs-schema-get/index.ts";
import { startServer } from "../server/index.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../server/owner-auth.ts";
import { ingestRecord } from "../server/records.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

// Documented byte budgets for the compact REST schema view. These are the
// regression guards: if a future change re-introduces verbatim-by-default on
// the compact path or stops dropping the per-field JSON Schema blobs, these
// fail locally. Deliberately generous relative to the compact projection's real
// size so legitimate growth does not flap the test, while still being many
// times smaller than the full body for this fixture.
const COMPACT_SCHEMA_BYTE_BUDGET = 60_000; // full grant, all streams, compact view
const STREAM_COMPACT_SCHEMA_BYTE_BUDGET = 6000; // one stream, compact view (single connection)

// Real-scale budget for a many-connection grant. live-smoked in review the deployed
// owner grant (2026-06-01) and measured `view=compact` at 93,785 bytes and
// `view=compact&stream=messages` at 7,626 bytes — both over the budgets above.
// The root cause was per-stream duplication of `granted_connections`: the RS
// attaches the SAME connection list to every stream of a connector, so a
// 19-connection grant repeated its ~2 KB connection list once per stream. The
// compact projection now lifts that shared list to the connector level, so the
// all-stream view scales with connection count, not connection count times
// stream count.
//
// The single-stream budget is necessarily larger than the single-connection
// 6 KB above: a 19-connection grant carries ~2 KB of irreducible per-connection
// identity (a `connection_id` + `display_name` per connection) that an agent
// needs to address reads against a specific connection. That identity cost is
// the same whether the agent reads one stream or all of them, so the
// single-stream multi-connection budget is set against the connection list plus
// one wide stream's flags rather than the single-connection baseline.
const COMPACT_SCHEMA_MULTI_CONNECTION_BUDGET = 60_000; // 19 connections, all streams
const STREAM_COMPACT_MULTI_CONNECTION_BUDGET = 6000; // 19 connections, one wide stream

// Real-scale fixture shape: enough connections + streams + fields to model the
// live owner-grant miss and prove the de-dup, not just the single-connection
// fixture above.
const REAL_SCALE_CONNECTION_COUNT = 19;

// Size of the verbose per-field JSON Schema blob attached to every field — the
// dominant size driver the compact projection drops.
const FIELD_SCHEMA_BLOB_PADDING = 1200;

const CONNECTOR_ID = "compact-schema-fixture";
const TEST_DCR_INITIAL_ACCESS_TOKEN = "pdpp-reference-test-initial-access-token";

// Loose wire-shape types for this file's HTTP fixtures/assertions. The route
// under test emits dynamic, field-name-keyed JSON (manifest-driven schema +
// capability flags), so these carry index signatures rather than pinning
// every key — the test's own assertions are what pin the real contract.
interface JsonSchemaConnection {
  connection_id?: string;
  display_name?: string;
  [extra: string]: unknown;
}

interface JsonSchemaStream {
  field_capabilities?: Record<string, unknown>;
  granted_connections?: JsonSchemaConnection[];
  name: string;
  schema?: unknown;
  stream_count?: number;
  [extra: string]: unknown;
}

interface JsonSchemaConnector {
  connector_key?: string;
  granted_connections?: JsonSchemaConnection[];
  stream_count?: number;
  streams: JsonSchemaStream[];
  [extra: string]: unknown;
}

interface SchemaHttpBody {
  connectors?: JsonSchemaConnector[];
  detail?: string;
  error?: { code?: string; retry_with?: string; available_connections?: JsonSchemaConnection[]; param?: string };
  object?: string;
  [extra: string]: unknown;
}

// Local structural stand-in for the module-private `SchemaResponse` type in
// `compact-view.ts` (not exported; the frozen boundary rule means it must be
// reconstructed here). `object: "schema"` plus `ConnectorSchemaItem[]`
// connectors is exactly what `projectSchemaCompactView` requires.
interface PureSchemaResponse {
  bearer: unknown;
  connectors: ConnectorSchemaItem[];
  object: "schema";
  [extra: string]: unknown;
}

interface ManifestFieldSchema {
  description: string;
  examples: string[];
  type: string;
}

type ManifestProperties = Record<string, { type: string } | { format: string; type: string } | ManifestFieldSchema>;

// The DEFAULT (non-compact) `field_capabilities[field]` entry is a verbose
// object carrying the raw declared JSON Schema at `.schema`; the COMPACT
// entry is a terse flag string instead (see formatFieldCapabilityFlags).
// This guard narrows the `unknown` value read off the dynamic body so tests
// can inspect `.schema.description` without an unsafe cast.
function isVerboseFieldCapability(value: unknown): value is { schema: { description: string } } {
  return (
    typeof value === "object" &&
    value !== null &&
    "schema" in value &&
    typeof (value as { schema: unknown }).schema === "object" &&
    (value as { schema: unknown }).schema !== null &&
    "description" in (value as { schema: { description: unknown } }).schema
  );
}

function makeLargeManifest({ streamCount = 6, fieldsPerStream = 30 } = {}) {
  return {
    capabilities: { human_interaction: [] },
    connector_id: CONNECTOR_ID,
    display_name: "Compact Schema Fixture Connector",
    manifest_uri: `https://sources.example/${CONNECTOR_ID}`,
    protocol_version: "0.1.0",
    streams: Array.from({ length: streamCount }, (_, s) => {
      const properties: ManifestProperties = {
        id: { type: "string" },
        received_at: { format: "date-time", type: "string" },
      };
      const rangeFilters = { received_at: ["gte", "lte"] };
      for (let f = 0; f < fieldsPerStream; f += 1) {
        // A verbose per-field JSON Schema: the size driver. A real RS attaches
        // the full declared JSON Schema (descriptions, enums, examples).
        properties[`field_${f}`] = {
          description: "x".repeat(FIELD_SCHEMA_BLOB_PADDING),
          // biome-ignore lint/suspicious/noShadow: the nested fixture scope intentionally uses the domain term from its enclosing scenario.
          examples: Array.from({ length: 4 }, (_, e) => `example-${f}-${e}`.repeat(8)),
          type: "string",
        };
      }
      return {
        consent_time_field: "received_at",
        cursor_field: "received_at",
        name: `stream_${s}`,
        primary_key: ["id"],
        query: { range_filters: rangeFilters },
        schema: { properties, required: ["id", "received_at"], type: "object" },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      };
    }),
    version: "1.0.0",
  };
}

async function fetchJson(url: string, opts: RequestInit = {}): Promise<{ body: SchemaHttpBody; status: number }> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body: SchemaHttpBody = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { body, status: resp.status };
}

type StartedServer = Awaited<ReturnType<typeof startServer>>;

// `server/index.js` is untyped JS, so TS infers `asServer`/`rsServer` as a
// generic `http2` server type lacking `closeAllConnections` (a real
// `net.Server` method present at runtime). Matches the guarded pattern used
// elsewhere in this suite (e.g. manifest-runtime-requirements.test.ts).
function hasCloseAllConnections(server: object): server is { closeAllConnections: () => void } {
  return "closeAllConnections" in server && typeof server.closeAllConnections === "function";
}

async function closeServer(server: StartedServer): Promise<void> {
  if (hasCloseAllConnections(server.asServer)) {
    server.asServer.closeAllConnections();
  }
  if (hasCloseAllConnections(server.rsServer)) {
    server.rsServer.closeAllConnections();
  }
  await Promise.allSettled([
    new Promise((r) => server.asServer.close(r)),
    new Promise((r) => server.rsServer.close(r)),
  ]);
}

async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
  const clientId = "cli_longview";
  const { body: device } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(typeof device.user_code, "string", "device_authorization must return a user_code");
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: device.user_code as string }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code as string,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(typeof tokenBody.access_token, "string", "token endpoint must return an access_token");
  return tokenBody.access_token as string;
}

async function withHttpHarness(
  fn: (ctx: { asUrl: string; ownerToken: string; rsUrl: string }) => Promise<void>,
  { manifest = makeLargeManifest() }: { manifest?: ReturnType<typeof makeLargeManifest> } = {}
): Promise<void> {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201, "register connector");
    const ownerToken = await issueOwnerToken(asUrl);
    await fn({ asUrl, ownerToken, rsUrl });
  } finally {
    await closeServer(server);
  }
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function schemaUrl(rsUrl: string, params: Record<string, string> = {}): string {
  const search = new URLSearchParams({ connector_id: CONNECTOR_ID, ...params }).toString();
  return `${rsUrl}/v1/schema?${search}`;
}

function allStreams(body: SchemaHttpBody): JsonSchemaStream[] {
  return (body.connectors || []).flatMap((connector) => (Array.isArray(connector.streams) ? connector.streams : []));
}

// Resolve the connection set an agent sees for a stream: the per-stream
// `granted_connections` override when the stream carries one, else the
// connector-level set the compact projection lifts the shared list to. Mirrors
// how a client reconstructs connection identity from the compact body.
function effectiveGrantedConnections(body: SchemaHttpBody, streamName: string): JsonSchemaConnection[] {
  for (const connector of body.connectors || []) {
    const stream = (connector.streams || []).find((s) => s.name === streamName);
    if (!stream) {
      continue;
    }
    if (Array.isArray(stream.granted_connections)) {
      return stream.granted_connections;
    }
    if (Array.isArray(connector.granted_connections)) {
      return connector.granted_connections;
    }
    return [];
  }
  return [];
}

test("the fixture is large enough to model the verbose-schema problem", async () => {
  await withHttpHarness(async ({ rsUrl, ownerToken }) => {
    const { status, body } = await fetchJson(schemaUrl(rsUrl), {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    const fullBytes = byteLength(body);
    assert.ok(fullBytes > 200_000, `full schema body should be large to model the problem (got ${fullBytes} bytes)`);
  });
});

test("default (view omitted) /v1/schema stays full and current-compatible", async () => {
  await withHttpHarness(async ({ rsUrl, ownerToken }) => {
    const { status, body } = await fetchJson(schemaUrl(rsUrl), {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    assert.equal(body.object, "schema");
    // No compact marker on the default path.
    assert.equal(body.detail, undefined, "default body must not be marked compact");
    const stream = allStreams(body).find((s) => s.name === "stream_0");
    assert.ok(stream, "stream_0 present");
    // Full per-field JSON Schema survives on the default path.
    assert.ok(stream.field_capabilities, "default body keeps field_capabilities");
    const field = stream.field_capabilities.field_0;
    assert.equal(typeof field, "object", "default field capability is the verbose object");
    const fieldSchema = isVerboseFieldCapability(field) ? field.schema : undefined;
    assert.ok(fieldSchema, "field capability must carry a verbose schema block");
    assert.equal(
      fieldSchema.description.length,
      FIELD_SCHEMA_BLOB_PADDING,
      "default body keeps the full per-field JSON Schema blob"
    );
  });
});

test("default (view omitted) /v1/schema?stream=<name> scopes the full body without compacting", async () => {
  await withHttpHarness(async ({ rsUrl, ownerToken }) => {
    const full = await fetchJson(schemaUrl(rsUrl), {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const scoped = await fetchJson(schemaUrl(rsUrl, { stream: "stream_2" }), {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(scoped.status, 200);
    assert.equal(scoped.body.object, "schema");
    assert.equal(scoped.body.detail, undefined, "full stream scope must not be marked compact");

    const streams = allStreams(scoped.body);
    assert.equal(streams.length, 1, "full stream scope keeps exactly one stream");
    // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
    const scopedStream = streams[0];
    assert.ok(scopedStream, "expected the scoped stream");
    assert.equal(scopedStream.name, "stream_2");
    assert.ok(scoped.body.connectors, "scoped body must carry connectors");
    for (const connector of scoped.body.connectors) {
      assert.equal(connector.stream_count, connector.streams.length);
    }

    assert.ok(scopedStream.field_capabilities, "scoped stream keeps field_capabilities");
    const field = scopedStream.field_capabilities.field_0;
    assert.equal(typeof field, "object", "full stream scope keeps verbose field capabilities");
    const fieldSchema = isVerboseFieldCapability(field) ? field.schema : undefined;
    assert.ok(fieldSchema, "field capability must carry a verbose schema block");
    assert.equal(
      fieldSchema.description.length,
      FIELD_SCHEMA_BLOB_PADDING,
      "full stream scope keeps the per-field JSON Schema blob for the requested stream"
    );
    assert.ok(
      byteLength(scoped.body) < byteLength(full.body) / 2,
      "full stream scope must be materially smaller than the all-stream full schema"
    );
  });
});

test("view=compact stays under the documented package byte budget and is far smaller", async () => {
  await withHttpHarness(async ({ rsUrl, ownerToken }) => {
    const full = await fetchJson(schemaUrl(rsUrl), {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const compact = await fetchJson(schemaUrl(rsUrl, { view: "compact" }), {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(compact.status, 200);
    assert.equal(compact.body.detail, "compact", "compact body carries the detail marker");

    const fullBytes = byteLength(full.body);
    const compactBytes = byteLength(compact.body);

    assert.ok(
      compactBytes < COMPACT_SCHEMA_BYTE_BUDGET,
      `compact schema must stay under ${COMPACT_SCHEMA_BYTE_BUDGET} bytes (got ${compactBytes}; full was ${fullBytes})`
    );
    assert.ok(
      compactBytes < fullBytes / 5,
      `compact schema must be far smaller than full (got ${compactBytes} vs full ${fullBytes})`
    );
  });
});

test("view=compact drops per-field JSON Schema but keeps flags + connection identity", async () => {
  await withHttpHarness(async ({ rsUrl, ownerToken }) => {
    const { body } = await fetchJson(schemaUrl(rsUrl, { view: "compact" }), {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const stream = allStreams(body).find((s) => s.name === "stream_0");
    assert.ok(stream, "stream_0 present");
    assert.ok(body.connectors, "compact body must carry connectors");
    // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
    const connector = body.connectors[0];
    assert.ok(connector, "expected a connector");
    assert.ok(stream.field_capabilities, "compact stream keeps field_capabilities");
    const field = stream.field_capabilities.field_0;

    // Compact grade: each field is a terse flag string, not the verbose object.
    assert.equal(typeof field, "string", "compact field must be a terse flag string");
    assert.ok(typeof field === "string");
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.doesNotMatch(field, /description/, "compact must drop per-field JSON Schema blob");
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(field, /t=string/, "compact flag string must keep declared type");
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.doesNotMatch(field, /granted=true/, "compact omits default granted=true noise");
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.doesNotMatch(field, /g=false/, "compact only carries grant flags for ungranted fields");
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(field, /(^|,)eq(,|$)/, "compact flag string must keep usable capability flags");

    // received_at advertises a usable range filter (manifest range_filters).
    const receivedAtFlags = stream.field_capabilities.received_at;
    assert.equal(typeof receivedAtFlags, "string");
    assert.ok(typeof receivedAtFlags === "string");
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(receivedAtFlags, /r=/, "compact flag string must keep usable range operators");

    // The heavy per-stream JSON Schema blob is gone on the compact path.
    assert.equal(stream.schema, undefined, "compact stream must drop the raw JSON Schema");
    // Stream identity survives.
    assert.equal(stream.name, "stream_0");
    // Connector identity survives in the canonical key form agents carry into
    // reads after discovery.
    assert.equal(connector.connector_key, CONNECTOR_ID);
    // Connection identity survives.
    assert.ok(Array.isArray(stream.granted_connections), "compact keeps granted_connections");
    for (const entry of stream.granted_connections ?? []) {
      assert.equal(typeof entry.connection_id, "string");
      assert.ok("display_name" in entry);
    }
  });
});

test("view=compact&stream=<name> scopes to one stream under a tight budget", async () => {
  await withHttpHarness(async ({ rsUrl, ownerToken }) => {
    const { status, body } = await fetchJson(schemaUrl(rsUrl, { stream: "stream_2", view: "compact" }), {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    assert.equal(body.detail, "compact");

    const streams = allStreams(body);
    assert.equal(streams.length, 1, "per-stream scope keeps exactly one stream");
    // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
    const stream2 = streams[0];
    assert.ok(stream2, "expected the scoped stream");
    assert.equal(stream2.name, "stream_2");
    // Each surviving connector reports the scoped stream_count.
    assert.ok(body.connectors, "compact body must carry connectors");
    for (const connector of body.connectors) {
      assert.equal(connector.stream_count, connector.streams.length);
    }
    // Still usable: capability flags survive on the scoped stream.
    assert.ok(stream2.field_capabilities, "scoped stream keeps field_capabilities");
    const stream2Field0 = stream2.field_capabilities.field_0;
    assert.equal(typeof stream2Field0, "string");
    assert.ok(typeof stream2Field0 === "string");
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(stream2Field0, /t=string/);

    const bytes = byteLength(body);
    assert.ok(
      bytes < STREAM_COMPACT_SCHEMA_BYTE_BUDGET,
      `per-stream compact schema must stay under ${STREAM_COMPACT_SCHEMA_BYTE_BUDGET} bytes (got ${bytes})`
    );
  });
});

test("an unknown stream scope yields an empty connector set, not an error", async () => {
  await withHttpHarness(async ({ rsUrl, ownerToken }) => {
    const { status, body } = await fetchJson(schemaUrl(rsUrl, { stream: "does_not_exist", view: "compact" }), {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    assert.equal(body.detail, "compact");
    assert.deepEqual(body.connectors, [], "no connector contributes the missing stream");
  });
});

async function seedConnection(instanceId: string, displayName: string, account: string): Promise<void> {
  const store = createSqliteConnectorInstanceStore();
  const now = new Date().toISOString();
  await store.upsert({
    connectorId: CONNECTOR_ID,
    connectorInstanceId: instanceId,
    createdAt: now,
    displayName,
    ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    sourceBinding: { account },
    sourceBindingKey: account,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
  await ingestRecord(
    { connector_id: CONNECTOR_ID, connector_instance_id: instanceId },
    {
      data: { id: `${instanceId}-1`, received_at: "2026-05-25T12:00:00.000Z" },
      emitted_at: "2026-05-25T12:00:00.000Z",
      key: `${instanceId}-1`,
      stream: "stream_0",
    }
  );
}

test("view=compact preserves multi-connection identity on granted_connections", async () => {
  await withHttpHarness(
    async ({ rsUrl, ownerToken }) => {
      await seedConnection("cin_compact_a", "Account A", "a@example.com");
      await seedConnection("cin_compact_b", "Account B", "b@example.com");

      const { status, body } = await fetchJson(schemaUrl(rsUrl, { stream: "stream_0", view: "compact" }), {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(status, 200);
      assert.equal(body.detail, "compact");

      const stream = allStreams(body).find((s) => s.name === "stream_0");
      // Identity is lifted to the connector level when the stream carries the
      // shared connection set; an agent resolves it via the connector-level
      // array (or a per-stream override when one is present).
      const granted = effectiveGrantedConnections(body, "stream_0");
      assert.ok(Array.isArray(granted), "granted_connections survives compaction");
      assert.equal(granted.length, 2, "both connections enumerated");
      // biome-ignore lint/suspicious/useArraySortCompare: the test relies on the platform default lexical sort behavior.
      const ids = granted.map((g) => g.connection_id).sort();
      assert.deepEqual(ids, ["cin_compact_a", "cin_compact_b"]);
      // biome-ignore lint/suspicious/useArraySortCompare: the test relies on the platform default lexical sort behavior.
      const labels = granted.map((g) => g.display_name).sort();
      assert.deepEqual(labels, ["Account A", "Account B"]);
      // Compaction still dropped the heavy per-field JSON Schema.
      assert.ok(stream, "expected stream_0");
      assert.ok(stream.field_capabilities, "compact stream keeps field_capabilities");
      assert.equal(typeof stream.field_capabilities.field_0, "string");
    },
    { manifest: makeLargeManifest({ fieldsPerStream: 4, streamCount: 1 }) }
  );
});

test("/v1/schema scopes stream discovery by connection_id without MCP adapter logic", async () => {
  await withHttpHarness(
    async ({ rsUrl, ownerToken }) => {
      await seedConnection("cin_scope_a", "Account A", "a@example.com");
      await seedConnection("cin_scope_b", "Account B", "b@example.com");

      const compact = await fetchJson(
        schemaUrl(rsUrl, { connection_id: "cin_scope_a", stream: "stream_0", view: "compact" }),
        { headers: { Authorization: `Bearer ${ownerToken}` } }
      );
      assert.equal(compact.status, 200);
      assert.equal(compact.body.detail, "compact");
      const compactStreams = allStreams(compact.body);
      assert.equal(compactStreams.length, 1);
      // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
      const compactStream0 = compactStreams[0];
      assert.ok(compactStream0, "expected the scoped stream");
      assert.equal(compactStream0.name, "stream_0");
      assert.deepEqual(
        effectiveGrantedConnections(compact.body, "stream_0").map((entry) => entry.connection_id),
        ["cin_scope_a"]
      );

      const full = await fetchJson(schemaUrl(rsUrl, { connection_id: "cin_scope_b", stream: "stream_0" }), {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(full.status, 200);
      assert.equal(full.body.detail, undefined, "source-scoped full schema keeps full detail");
      assert.equal(allStreams(full.body).length, 1);
      assert.deepEqual(
        effectiveGrantedConnections(full.body, "stream_0").map((entry) => entry.connection_id),
        ["cin_scope_b"]
      );
    },
    { manifest: makeLargeManifest({ fieldsPerStream: 4, streamCount: 2 }) }
  );
});

test("/v1/schema?detail=full rejects ambiguous stream detail before dumping multiple sources", async () => {
  await withHttpHarness(
    async ({ rsUrl, ownerToken }) => {
      await seedConnection("cin_detail_a", "Account A", "a@example.com");
      await seedConnection("cin_detail_b", "Account B", "b@example.com");

      const ambiguous = await fetchJson(schemaUrl(rsUrl, { detail: "full", stream: "stream_0" }), {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(ambiguous.status, 409);
      assert.equal(ambiguous.body.error?.code, "ambiguous_schema_detail");
      assert.equal(ambiguous.body.error?.retry_with, "connection_id");
      assert.ok(ambiguous.body.error?.available_connections, "expected available_connections on the error");
      assert.deepEqual(
        ambiguous.body.error.available_connections
          .map((entry) => entry.connection_id)
          .sort((a, b) => (a ?? "").localeCompare(b ?? "")),
        ["cin_detail_a", "cin_detail_b"]
      );

      const unscoped = await fetchJson(schemaUrl(rsUrl, { detail: "full" }), {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(unscoped.status, 400);
      assert.equal(unscoped.body.error?.code, "invalid_request");
      assert.equal(unscoped.body.error?.param, "detail");

      const scoped = await fetchJson(
        schemaUrl(rsUrl, { connection_id: "cin_detail_a", detail: "full", stream: "stream_0" }),
        { headers: { Authorization: `Bearer ${ownerToken}` } }
      );
      assert.equal(scoped.status, 200);
      assert.equal(scoped.body.detail, undefined, "explicit scoped full schema keeps full detail");
      assert.equal(allStreams(scoped.body).length, 1);
      assert.deepEqual(
        effectiveGrantedConnections(scoped.body, "stream_0").map((entry) => entry.connection_id),
        ["cin_detail_a"]
      );
    },
    { manifest: makeLargeManifest({ fieldsPerStream: 4, streamCount: 2 }) }
  );
});

test("compact projection scales: doubling field count does not blow the budget", async () => {
  let bytes15 = 0;
  let bytes30 = 0;
  await withHttpHarness(
    async ({ rsUrl, ownerToken }) => {
      const { body } = await fetchJson(schemaUrl(rsUrl, { view: "compact" }), {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      bytes15 = byteLength(body);
    },
    { manifest: makeLargeManifest({ fieldsPerStream: 15 }) }
  );
  await withHttpHarness(
    async ({ rsUrl, ownerToken }) => {
      const { body } = await fetchJson(schemaUrl(rsUrl, { view: "compact" }), {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      bytes30 = byteLength(body);
    },
    { manifest: makeLargeManifest({ fieldsPerStream: 30 }) }
  );

  assert.ok(
    bytes30 < COMPACT_SCHEMA_BYTE_BUDGET,
    `compact schema must stay under budget even at 30 fields/stream (got ${bytes30})`
  );
  // 15 added fields across 6 streams. The compact per-field cost must stay
  // small (nowhere near the verbatim ~1.2 KB/field blob).
  const perFieldGrowth = (bytes30 - bytes15) / (15 * 6);
  assert.ok(
    perFieldGrowth < 200,
    `compact per-field cost must stay small (got ~${Math.round(perFieldGrowth)} bytes/field)`
  );
});

// Seed N connections under the fixture connector so the owner schema advertises
// a many-connection grant — the live shape that blew the budget. Each
// connection carries a realistic-length display name (the per-connection
// identity cost an agent needs to address reads).
async function seedManyConnections(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const id = `cin_acct_${String(i).padStart(2, "0")}`;
    // A label as long as a real account display name ("work — alex@example.com").
    // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
    await seedConnection(id, `Account ${i} — alex.example.user.${i}@example.com`, `user${i}@example.com`);
  }
}

// Recompute what the pre-fix body would have weighed: re-attach the lifted
// connector-level `granted_connections` onto every stream that inherits it.
// This is the duplication the connector-level lift removes; the test uses it to
// prove the saving is real (non-vacuous) rather than measuring an already-small
// body and calling the budget met.
function bytesWithPerStreamDuplication(body: SchemaHttpBody): number {
  const reduplicated = {
    ...body,
    connectors: (body.connectors || []).map((connector) => {
      const shared = Array.isArray(connector.granted_connections) ? connector.granted_connections : null;
      const { granted_connections: _lifted, ...connectorRest } = connector;
      return {
        ...connectorRest,
        streams: (connector.streams || []).map((stream) => {
          if (Array.isArray(stream.granted_connections)) {
            return stream;
          }
          return shared ? { ...stream, granted_connections: shared } : stream;
        }),
      };
    }),
  };
  return byteLength(reduplicated);
}

test("view=compact de-dups granted_connections to the connector level at 19-connection scale", async () => {
  await withHttpHarness(
    async ({ rsUrl, ownerToken }) => {
      await seedManyConnections(REAL_SCALE_CONNECTION_COUNT);

      const { status, body } = await fetchJson(schemaUrl(rsUrl, { view: "compact" }), {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(status, 200);
      assert.equal(body.detail, "compact");

      assert.ok(body.connectors, "compact body must carry connectors");
      // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
      const connector = body.connectors[0];
      assert.ok(connector, "expected a connector");
      // The shared connection list is lifted ONCE to the connector level...
      assert.ok(Array.isArray(connector.granted_connections), "connector-level granted_connections is present");
      const connectorGranted = connector.granted_connections;
      assert.ok(connectorGranted, "expected connector-level granted_connections");
      assert.equal(
        connectorGranted.length,
        REAL_SCALE_CONNECTION_COUNT,
        "connector-level list enumerates every connection"
      );
      // ...and the per-stream copies are gone (every stream inherits it).
      // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
      const streams = connector.streams;
      assert.ok(streams.length >= 6, "fixture has multiple streams");
      for (const stream of streams) {
        assert.equal(
          stream.granted_connections,
          undefined,
          `stream ${stream.name} must not repeat the shared connection list`
        );
      }

      // The all-stream compact body stays under budget at real scale.
      const compactBytes = byteLength(body);
      assert.ok(
        compactBytes < COMPACT_SCHEMA_MULTI_CONNECTION_BUDGET,
        `19-connection compact schema must stay under ${COMPACT_SCHEMA_MULTI_CONNECTION_BUDGET} bytes (got ${compactBytes})`
      );

      // Non-vacuous: the body WITHOUT the lift (per-stream duplication, the
      // pre-fix shape live-smoked in review at 93,785 bytes) must be materially
      // larger — proving the saving is real and that a regression which
      // re-duplicates the list would blow the budget.
      const duplicatedBytes = bytesWithPerStreamDuplication(body);
      assert.ok(
        duplicatedBytes > compactBytes + 10_000,
        `per-stream duplication must cost far more (dedup ${compactBytes} vs duplicated ${duplicatedBytes})`
      );

      // Identity is fully reconstructable per stream from the lifted set.
      // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
      const firstStream = streams[0];
      assert.ok(firstStream, "expected a stream");
      const granted = effectiveGrantedConnections(body, firstStream.name);
      assert.equal(granted.length, REAL_SCALE_CONNECTION_COUNT, "every connection resolvable per stream");
      for (const entry of granted) {
        assert.equal(typeof entry.connection_id, "string");
        assert.ok(entry.connection_id && entry.connection_id.length > 0);
        assert.ok("display_name" in entry);
      }
    },
    { manifest: makeLargeManifest({ fieldsPerStream: 30, streamCount: 12 }) }
  );
});

test("view=compact&stream=<name> stays under budget at 19-connection scale", async () => {
  await withHttpHarness(
    async ({ rsUrl, ownerToken }) => {
      await seedManyConnections(REAL_SCALE_CONNECTION_COUNT);

      const { status, body } = await fetchJson(schemaUrl(rsUrl, { stream: "stream_0", view: "compact" }), {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(status, 200);
      assert.equal(body.detail, "compact");

      const streams = allStreams(body);
      assert.equal(streams.length, 1, "scope keeps exactly one stream");
      // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
      const scopedStream0 = streams[0];
      assert.ok(scopedStream0, "expected the scoped stream");
      assert.equal(scopedStream0.name, "stream_0");

      // Even scoped to one stream, the 19-connection identity is carried once at
      // the connector level (not inline on the stream).
      assert.equal(
        scopedStream0.granted_connections,
        undefined,
        "scoped stream does not inline the shared connection list"
      );
      const granted = effectiveGrantedConnections(body, "stream_0");
      assert.equal(granted.length, REAL_SCALE_CONNECTION_COUNT, "all connections resolvable on the scoped stream");

      const bytes = byteLength(body);
      assert.ok(
        bytes < STREAM_COMPACT_MULTI_CONNECTION_BUDGET,
        `19-connection per-stream compact must stay under ${STREAM_COMPACT_MULTI_CONNECTION_BUDGET} bytes (got ${bytes})`
      );
    },
    { manifest: makeLargeManifest({ fieldsPerStream: 30, streamCount: 12 }) }
  );
});

test("view=compact keeps a divergent per-stream connection subset (pinned grant)", async () => {
  // When a stream's connection set differs from the connector-shared set, the
  // compact projection must NOT drop it — the per-stream override survives so an
  // agent still sees the pinned subset for that stream. Modeled here by injecting
  // a divergent stream into the projection input directly (the route's grant
  // pinning produces the same shape).
  const { projectSchemaCompactView } = await import("../operations/rs-schema-get/compact-view.ts");
  const shared = [
    { connection_id: "cin_a", display_name: "A" },
    { connection_id: "cin_b", display_name: "B" },
  ];
  const response: PureSchemaResponse = {
    bearer: { scope: "owner", token_kind: "owner" },
    connectors: [
      {
        connector_id: "fixture",
        object: "connector",
        source: { id: "fixture", kind: "connector" },
        stream_count: 2,
        streams: [
          { field_capabilities: {}, granted_connections: shared, name: "shared_stream", object: "stream_metadata" },
          {
            field_capabilities: {},
            granted_connections: [{ connection_id: "cin_a", display_name: "A" }],
            name: "pinned_stream",
            object: "stream_metadata",
          },
        ],
      },
    ],
    object: "schema",
  };
  const projected = projectSchemaCompactView(response);
  // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
  const connector = projected.connectors[0];
  assert.ok(connector, "expected a connector");
  assert.deepEqual(connector.granted_connections, shared, "shared set lifted to connector level");
  const sharedStream = connector.streams.find((s) => s.name === "shared_stream");
  const pinnedStream = connector.streams.find((s) => s.name === "pinned_stream");
  assert.ok(sharedStream, "expected the shared stream");
  assert.ok(pinnedStream, "expected the pinned stream");
  assert.equal(sharedStream.granted_connections, undefined, "shared stream inherits connector-level set");
  assert.deepEqual(
    pinnedStream.granted_connections,
    [{ connection_id: "cin_a", display_name: "A" }],
    "divergent (pinned) stream keeps its own subset"
  );
});

test("compact field flags use aliases and keep only non-default grant state", async () => {
  const { formatFieldCapabilityFlags } = await import("../operations/rs-schema-get/compact-view.ts");
  assert.equal(
    formatFieldCapabilityFlags({
      aggregation: {
        count: { declared: true, usable: true },
        sum: { declared: true, reason: "not_numeric", usable: false },
      },
      exact_filter: { declared: true, usable: true },
      granted: true,
      lexical_search: { declared: true, usable: true },
      range_filter: { declared: true, operators: ["gte", "lt"], usable: true },
      role: "primary-title",
      semantic_search: { declared: true, usable: true },
      type: "string",
    }),
    "t=string,role=primary-title,eq,r=gte|lt,lex,sem,a=count"
  );
  assert.equal(
    formatFieldCapabilityFlags({
      exact_filter: { declared: true, reason: "not_granted", usable: false },
      granted: false,
      type: "string",
    }),
    "t=string,g=false,eq=unusable:not_granted"
  );
});
