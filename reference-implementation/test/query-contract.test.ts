// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Query-contract conformance tests.
 *
 * Exercises the record-query / read surface after the W1 alignment to the
 * revised PDPP Core contract (spec-core.md §8):
 *
 *   - stream metadata capability declarations (relationships, query.range_filters,
 *     query.expand, freshness)
 *   - exact filter behavior on top-level scalar fields only
 *   - range filter behavior, valid only for declared fields
 *   - expansion and grant-safe child projection
 *   - blob fetch and grant-visible blob_ref enforcement
 *   - freshness honesty (current / stale / unknown)
 *   - loud failure for unsupported query shapes
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTraceContext, emitSpineEvent } from "../lib/spine.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../server/owner-auth.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const POLYFILL_MANIFESTS_DIR = join(REFERENCE_IMPL_DIR, "..", "packages", "polyfill-connectors", "manifests");
const TEST_DCR_INITIAL_ACCESS_TOKEN = "pdpp-reference-test-initial-access-token";
interface JsonObject {
  [key: string]: any;
}
interface TestHarness {
  asUrl: string;
  rsUrl: string;
  server: Awaited<ReturnType<typeof startServer>>;
  spotifyManifest: JsonObject;
}
interface CloseableServer {
  close: (callback?: (error?: Error) => void) => void;
  closeAllConnections: () => void;
}

function isCloseableServer(value: unknown): value is CloseableServer {
  return (
    typeof value === "object" &&
    value !== null &&
    "close" in value &&
    typeof value.close === "function" &&
    "closeAllConnections" in value &&
    typeof value.closeAllConnections === "function"
  );
}

function requireCloseableServer(value: unknown, description: string): CloseableServer {
  if (!isCloseableServer(value)) {
    throw new TypeError(`${description} must be closeable`);
  }
  return value;
}

async function closeServer(server: TestHarness["server"]): Promise<void> {
  const asServer = requireCloseableServer(server.asServer, "authorization server");
  const rsServer = requireCloseableServer(server.rsServer, "resource server");
  asServer.closeAllConnections();
  rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise<void>((resolve, reject) => asServer.close((error) => (error ? reject(error) : resolve()))),
    new Promise<void>((resolve, reject) => rsServer.close((error) => (error ? reject(error) : resolve()))),
  ]);
}

async function fetchJson(url: string, opts: RequestInit = {}): Promise<{ status: number; body: JsonObject }> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body: JsonObject = {};
  try {
    body = text ? (JSON.parse(text) as JsonObject) : {};
  } catch {
    body = { raw: text };
  }
  return { body, status: resp.status };
}

async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
  const clientId = "cli_longview";
  const { body: device } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
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
  return tokenBody.access_token;
}

async function withHarness(
  fn: (handles: TestHarness) => Promise<void>,
  options: { mutateManifest?: (manifest: JsonObject) => void } = {}
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
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "manifests/spotify.json"), "utf8")
  ) as JsonObject;
  const topArtists = spotifyManifest.streams.find((stream: JsonObject) => stream.name === "top_artists");
  topArtists.query = {
    ...(topArtists.query || {}),
    aggregations: {
      count: true,
      count_distinct: ["name"],
      group_by: ["name"],
      group_by_time: ["source_updated_at"],
      max: ["popularity", "followers", "source_updated_at"],
      min: ["popularity", "followers", "source_updated_at"],
      sum: ["popularity", "followers"],
    },
  };
  options.mutateManifest?.(spotifyManifest);
  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201, "register connector");
    await fn({ asUrl, rsUrl, server, spotifyManifest });
  } finally {
    await closeServer(server);
  }
}

// biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
async function startGrantRequest(asUrl: string, params: JsonObject) {
  return fetchJson(`${asUrl}/oauth/par`, {
    body: JSON.stringify({
      authorization_details: [
        {
          access_mode: params.access_mode,
          purpose_code: params.purpose_code,
          purpose_description: params.purpose_description,
          source: params.source || { id: params.connector_id, kind: "connector" },
          streams: params.streams,
          type: "https://pdpp.org/data-access",
        },
      ],
      client_id: params.client_id,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

// biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
async function approveGrantRequest(asUrl: string, requestUri: string, subjectId = "owner_local") {
  return fetchJson(`${asUrl}/consent/approve`, {
    body: JSON.stringify({ request_uri: requestUri, subject_id: subjectId }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

async function approveGrant(asUrl: string, subjectId: string, params: JsonObject) {
  const { body: initiate } = await startGrantRequest(asUrl, params);
  const { body: approved } = await approveGrantRequest(asUrl, initiate.request_uri, subjectId);
  return approved;
}

function cloneJson(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value));
}

// Give a cloned manifest a unique canonical connector_key so multiple
// validation-error cases register under distinct identities without colliding.
// Post-canonicalization the operational identity is connector_key (a slug);
// the legacy URL-shaped connector_id and manifest_uri provenance are dropped so
// the manifest validates and the intended stream-level validation runs.
function setUniqueConnectorKey(manifest: JsonObject, key: string): JsonObject {
  manifest.connector_key = key;
  manifest.connector_id = undefined;
  manifest.manifest_uri = undefined;
  return manifest;
}

function readGmailManifest() {
  return JSON.parse(readFileSync(join(POLYFILL_MANIFESTS_DIR, "gmail.json"), "utf8"));
}

function addTestRefreshPolicy(manifest: JsonObject, overrides: JsonObject = {}): void {
  manifest.capabilities = {
    ...(manifest.capabilities || {}),
    refresh_policy: {
      maximum_staleness_seconds: 3600,
      rationale: "Test policy for freshness derivation coverage.",
      recommended_mode: "automatic",
      ...overrides,
    },
  };
}

async function emitSyntheticRun({
  connectorId: rawConnectorId,
  runId,
  status,
  occurredAt,
}: {
  connectorId: string;
  runId: string;
  status: string;
  occurredAt: string;
}): Promise<void> {
  // The live runtime launches runs under the canonical connector key and emits
  // run.* spine events with source.id = that canonical key. Freshness and
  // connector-summary correlation query run history by the canonical key, so a
  // synthetic run must use it too or it correlates to nothing. Canonicalize the
  // (possibly URL-shaped) test connectorId here. See canonicalize-connector-keys
  // Decision 1.
  const connectorId = canonicalConnectorKey(rawConnectorId) ?? rawConnectorId;
  // Spine-layer stamping requirement (see docs/run-reconciliation-design-brief.md §3.3):
  // every run.started must carry boot_epoch+seq. Harness ran startServer
  // which initialized the singleton; read it once.
  const { getCurrentBootEpoch } = await import("../lib/spine.ts");
  const _epoch = getCurrentBootEpoch();
  const _stamp = _epoch
    ? {
        boot_epoch: _epoch.boot_epoch,
        controller_id: _epoch.controller_id,
        seq: _epoch.seq,
      }
    : { boot_epoch: "synthetic", controller_id: "synthetic", seq: 1 };
  const trace = createTraceContext({ scenarioId: `scn_${runId}` });
  await emitSpineEvent({
    actor_id: connectorId,
    actor_type: "runtime",
    data: {
      connector_instance_id: `cin_synthetic_${connectorId}`,
      scope: { streams: [{ name: "top_artists" }] },
      scope_streams: ["top_artists"],
      source: { id: connectorId, kind: "connector" },
      ..._stamp,
    },
    event_type: "run.started",
    object_id: runId,
    object_type: "run",
    occurred_at: occurredAt,
    run_id: runId,
    scenario_id: trace.scenario_id,
    source_id: connectorId,
    source_kind: "connector",
    status: "started",
    trace_id: trace.trace_id,
  });
  await emitSpineEvent({
    actor_id: connectorId,
    actor_type: "runtime",
    data: {
      records_emitted: 0,
      records_flushed: 0,
      source: { id: connectorId, kind: "connector" },
      ...(status === "failed" ? { reason: "synthetic_failure" } : {}),
    },
    event_type: status === "succeeded" ? "run.completed" : "run.failed",
    object_id: runId,
    object_type: "run",
    occurred_at: occurredAt,
    run_id: runId,
    scenario_id: trace.scenario_id,
    source_id: connectorId,
    source_kind: "connector",
    status,
    trace_id: trace.trace_id,
  });
}

// biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
async function registerConnectorManifest(asUrl: string, manifest: JsonObject) {
  return fetchJson(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

async function seedSpotifyStream(
  rsUrl: string,
  ownerToken: string,
  connectorId: string,
  stream: string,
  records: JsonObject[]
): Promise<void> {
  const lines = records
    .map((record: JsonObject) =>
      JSON.stringify({
        data: record,
        emitted_at:
          record.emitted_at ||
          record.played_at ||
          record.saved_at ||
          record.source_updated_at ||
          record.source_created_at,
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
  assert.equal(resp.status, 200, `ingest ${stream} ok`);
}

// biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
async function uploadBlob(
  rsUrl: string,
  ownerToken: string,
  params: JsonObject,
  body: string | Uint8Array,
  contentType = "application/octet-stream"
): Promise<{ status: number; body: JsonObject }> {
  const query = new URLSearchParams({
    connector_id: params.connector_id,
    record_key: params.record_key,
    stream: params.stream,
  });
  return fetchJson(`${rsUrl}/v1/blobs?${query.toString()}`, {
    body,
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      "Content-Type": contentType,
    },
    method: "POST",
  });
}

async function seedSpotifyTopArtists(
  rsUrl: string,
  ownerToken: string,
  connectorId: string,
  records: JsonObject[]
): Promise<void> {
  await seedSpotifyStream(rsUrl, ownerToken, connectorId, "top_artists", records);
}

async function materializeSpotifyConnection(connectorId: string): Promise<void> {
  const now = "2026-01-01T00:00:00.000Z";
  await createSqliteConnectorInstanceStore().upsert({
    // biome-ignore lint/style/noNonNullAssertion: the assertion follows an explicit test guard that proves fixture presence.
    connectorId: canonicalConnectorKey(connectorId)!,
    connectorInstanceId: "cin_query_contract_spotify",
    createdAt: now,
    displayName: "Spotify",
    ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    sourceBinding: { kind: "test_account", label: "query-contract-spotify" },
    sourceBindingKey: "query-contract-spotify",
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
}

async function seedGmailStream(
  rsUrl: string,
  ownerToken: string,
  connectorId: string,
  stream: string,
  records: JsonObject[]
): Promise<void> {
  const lines = records
    .map((record: JsonObject) =>
      JSON.stringify({
        data: record,
        emitted_at:
          record.emitted_at ||
          record.received_at ||
          record.message_received_at ||
          record.last_message_date ||
          "2026-04-01T00:00:00Z",
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
  assert.equal(resp.status, 200, `ingest gmail ${stream} ok`);
}

async function seedGmailExpansionFixture(rsUrl: string, ownerToken: string, connectorId: string): Promise<void> {
  await seedGmailStream(rsUrl, ownerToken, connectorId, "messages", [
    {
      bcc: [],
      cc: [],
      date: "2026-04-01T09:58:00Z",
      from_email: "rail@example.com",
      from_name: "Rail Desk",
      has_attachments: true,
      id: "msg-1",
      in_reply_to: null,
      is_answered: false,
      is_draft: false,
      is_flagged: false,
      is_seen: true,
      labels: ["inbox"],
      message_id: "<msg-1@example.com>",
      received_at: "2026-04-01T10:00:00Z",
      references: [],
      reply_to: [],
      size_bytes: 4200,
      snippet: "Your train receipt is attached.",
      subject: "Train receipt",
      thread_id: "thread-1",
      to: [],
    },
    {
      bcc: [],
      cc: [],
      has_attachments: false,
      id: "msg-2",
      is_answered: false,
      is_draft: false,
      is_flagged: false,
      is_seen: false,
      labels: [],
      received_at: "2026-04-02T10:00:00Z",
      references: [],
      reply_to: [],
      snippet: null,
      subject: "No body or attachments",
      thread_id: "thread-2",
      to: [],
    },
  ]);
  await seedGmailStream(rsUrl, ownerToken, connectorId, "message_bodies", [
    {
      body_html: "<p>Here is your train receipt for Milan.</p>",
      body_html_bytes: 45,
      body_source: "text_plain",
      body_text: "Here is your train receipt for Milan.",
      body_text_bytes: 38,
      charset: "utf-8",
      content_languages: ["en"],
      id: "body-msg-1",
      message_id: "msg-1",
    },
  ]);
  await seedGmailStream(rsUrl, ownerToken, connectorId, "attachments", [
    {
      blob_ref: null,
      content_id: null,
      content_sha256: null,
      content_type: "application/pdf",
      encoding: "base64",
      filename: "receipt.pdf",
      hydration_error: null,
      hydration_status: "deferred",
      id: "att-1",
      is_inline: false,
      message_id: "msg-1",
      message_received_at: "2026-04-01T10:00:00Z",
      part_index: "2",
      size_bytes: 1000,
    },
    {
      blob_ref: null,
      content_id: "<map>",
      content_sha256: null,
      content_type: "image/png",
      encoding: "base64",
      filename: "map.png",
      hydration_error: null,
      hydration_status: "deferred",
      id: "att-2",
      is_inline: true,
      message_id: "msg-1",
      message_received_at: "2026-04-01T10:00:00Z",
      part_index: "3",
      size_bytes: 2000,
    },
    {
      blob_ref: null,
      content_id: null,
      content_sha256: null,
      content_type: "text/plain",
      encoding: "7bit",
      filename: "terms.txt",
      hydration_error: null,
      hydration_status: "deferred",
      id: "att-3",
      is_inline: false,
      message_id: "msg-1",
      message_received_at: "2026-04-01T10:00:00Z",
      part_index: "4",
      size_bytes: 300,
    },
  ]);
}

test("connector discovery lists owner-visible polyfill connectors without connector_id", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    // Discovery output uses the canonical operational connector key, not the
    // manifest's URL-shaped connector_id (canonicalize-connector-keys
    // Decisions 1 and 2: connector_key is operational, manifest_uri is metadata).
    const canonicalConnectorId = canonicalConnectorKey(spotifyManifest.connector_id);
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(`${rsUrl}/v1/connectors`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    assert.equal(status, 200);
    assert.equal(body.object, "list");
    assert.equal(body.data.length, 1);

    // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
    const connector = body.data[0];
    assert.equal(connector.object, "connector");
    assert.equal(connector.connector_id, canonicalConnectorId);
    assert.deepEqual(connector.source, {
      id: canonicalConnectorId,
      kind: "connector",
    });
    assert.deepEqual(
      connector.streams.map((stream: JsonObject) => stream.name).sort(),
      spotifyManifest.streams.map((stream: JsonObject) => stream.name).sort()
    );

    const topArtists = connector.streams.find((stream: JsonObject) => stream.name === "top_artists");
    assert.ok(topArtists, "top_artists should be discoverable before records exist");
    assert.equal(topArtists.record_count, 0);
    assert.equal(topArtists.freshness.status, "unknown");
    assert.equal(topArtists.capabilities.stream_metadata, true);
    assert.equal(
      topArtists.capabilities.metadata_url,
      `/v1/streams/top_artists?connector_id=${
        // biome-ignore lint/style/noNonNullAssertion: the assertion follows an explicit test guard that proves fixture presence.
        encodeURIComponent(canonicalConnectorId!)
      }`
    );
    assert.equal(topArtists.capabilities.range_filters, true);
  });
});

test("connector discovery scopes client tokens to the granted source and streams", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const approved = await approveGrant(asUrl, "schema_discovery_owner", {
      access_mode: "continuous",
      client_id: "longview",
      purpose_code: "https://pdpp.org/purpose/analytics",
      purpose_description: "schema discovery test",
      source: { id: spotifyManifest.connector_id, kind: "connector" },
      streams: [{ fields: ["id", "name", "source_updated_at"], name: "top_artists" }],
    });
    assert.ok(approved.token, `expected issued grant token, got ${JSON.stringify(approved)}`);

    const { status, body } = await fetchJson(`${rsUrl}/v1/connectors`, {
      headers: { Authorization: `Bearer ${approved.token}` },
    });

    assert.equal(status, 200);
    assert.equal(body.object, "list");
    assert.equal(body.data.length, 1);

    // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
    const connector = body.data[0];
    assert.equal(connector.connector_id, canonicalConnectorKey(spotifyManifest.connector_id));
    assert.deepEqual(
      connector.streams.map((stream: JsonObject) => stream.name),
      ["top_artists"]
    );
    assert.equal(connector.stream_count, 1);
    assert.equal(connector.streams[0].capabilities.records, true);

    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes("grant_id"), false);
    assert.equal(serialized.includes("fields"), false);
    assert.equal(serialized.includes("saved_tracks"), false);
    assert.equal(serialized.includes("recently_played"), false);
  });
});

test("schema discovery enumerates owner-visible polyfill connectors with full per-stream capabilities", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const gmailManifest = readGmailManifest();
    assert.equal((await registerConnectorManifest(asUrl, gmailManifest)).status, 201);
    const ownerToken = await issueOwnerToken(asUrl, "schema_owner");
    const { status, body } = await fetchJson(`${rsUrl}/v1/schema`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    assert.equal(status, 200);
    assert.equal(body.object, "schema");
    assert.deepEqual(body.bearer, { scope: "owner", token_kind: "owner" });
    assert.equal(body.connectors.length, 2);

    // Schema discovery emits canonical operational keys, not manifest URLs.
    const canonicalSpotifyId = canonicalConnectorKey(spotifyManifest.connector_id);
    const canonicalGmailId = canonicalConnectorKey(gmailManifest.connector_id);
    const connectorIds = body.connectors.map((c: JsonObject) => c.connector_id).sort();
    assert.deepEqual(connectorIds, [canonicalSpotifyId, canonicalGmailId].sort());

    const spotify = body.connectors.find((c: JsonObject) => c.connector_id === canonicalSpotifyId);
    assert.deepEqual(spotify.source, {
      id: canonicalSpotifyId,
      kind: "connector",
    });
    assert.deepEqual(
      spotify.streams.map((s: JsonObject) => s.name).sort(),
      spotifyManifest.streams.map((s: JsonObject) => s.name).sort()
    );
    const topArtists = spotify.streams.find((s: JsonObject) => s.name === "top_artists");
    assert.equal(topArtists.object, "stream_metadata");
    assert.ok(topArtists.schema?.properties, "schema is included per stream");
    assert.ok(topArtists.field_capabilities.source_updated_at, "field_capabilities are included");
    assert.deepEqual(topArtists.field_capabilities.source_updated_at.range_filter, {
      declared: true,
      operators: ["gte", "gt", "lte", "lt"],
      usable: true,
    });
    assert.equal(topArtists.freshness.status, "unknown");
    assert.ok(Array.isArray(topArtists.expand_capabilities), "expand_capabilities is an array");

    const gmail = body.connectors.find((c: JsonObject) => c.connector_id === canonicalGmailId);
    const messages = gmail.streams.find((s: JsonObject) => s.name === "messages");
    assert.equal(messages.field_capabilities.subject.lexical_search.usable, true);
    assert.ok(messages.expand_capabilities.some((entry: JsonObject) => entry.name === "attachments"));
  });
});

test("schema discovery scopes a client token to its grant source and streams", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const gmailManifest = readGmailManifest();
    assert.equal((await registerConnectorManifest(asUrl, gmailManifest)).status, 201);
    const approved = await approveGrant(asUrl, "schema_client_owner", {
      access_mode: "continuous",
      client_id: "longview",
      purpose_code: "https://pdpp.org/purpose/analytics",
      purpose_description: "schema discovery client scope",
      source: { id: spotifyManifest.connector_id, kind: "connector" },
      streams: [{ fields: ["id", "name", "source_updated_at"], name: "top_artists" }],
    });
    assert.ok(approved.token, "expected client token");

    const { status, body } = await fetchJson(`${rsUrl}/v1/schema`, {
      headers: { Authorization: `Bearer ${approved.token}` },
    });

    assert.equal(status, 200);
    assert.equal(body.object, "schema");
    assert.equal(body.bearer.token_kind, "client");
    assert.equal(body.bearer.scope, "grant");
    assert.ok(body.bearer.grant_id, "grant_id surfaces on bearer projection");
    assert.equal(body.connectors.length, 1);
    // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
    const connector = body.connectors[0];
    assert.equal(connector.connector_id, canonicalConnectorKey(spotifyManifest.connector_id));
    assert.deepEqual(
      connector.streams.map((s: JsonObject) => s.name),
      ["top_artists"]
    );
    assert.equal(connector.stream_count, 1);

    // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
    const topArtists = connector.streams[0];
    // field-limited grant: granted fields are usable; ungranted fields are present but not usable.
    assert.equal(topArtists.field_capabilities.id.granted, true);
    assert.equal(topArtists.field_capabilities.name.granted, true);
    assert.equal(topArtists.field_capabilities.source_updated_at.granted, true);
    assert.equal(topArtists.field_capabilities.source_updated_at.range_filter.usable, true);
    assert.ok(topArtists.field_capabilities.popularity, "popularity field is enumerated");
    assert.equal(topArtists.field_capabilities.popularity.granted, false);
    assert.equal(topArtists.field_capabilities.popularity.exact_filter.usable, false);
    assert.equal(topArtists.field_capabilities.popularity.exact_filter.reason, "field_not_granted");

    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes(gmailManifest.connector_id), false, "must not leak other connectors");
    assert.equal(serialized.includes("saved_tracks"), false, "must not leak ungranted streams");
  });
});

test("schema discovery returns an empty connector array when no connectors are registered", async () => {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    quiet: true,
    rsPort: 0,
  });
  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const ownerToken = await issueOwnerToken(asUrl, "empty_owner");
    const { status, body } = await fetchJson(`${rsUrl}/v1/schema`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    assert.equal(body.object, "schema");
    assert.deepEqual(body.connectors, []);
  } finally {
    await closeServer(server);
  }
});

test("stream metadata publishes normalized field capabilities for owner tokens", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/streams/top_artists?connector_id=${encodeURIComponent(connectorId)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(status, 200);
    assert.equal(body.object, "stream_metadata");
    assert.ok(body.schema?.properties, "schema metadata should remain present");
    assert.ok(body.query, "query metadata should be present");
    assert.ok(Array.isArray(body.relationships), "relationships metadata should remain present");
    assert.deepEqual(body.query.range_filters.source_updated_at, ["gte", "gt", "lte", "lt"]);
    assert.deepEqual(body.field_capabilities.source_updated_at.range_filter, {
      declared: true,
      operators: ["gte", "gt", "lte", "lt"],
      usable: true,
    });
    assert.deepEqual(body.field_capabilities.popularity.exact_filter, {
      declared: true,
      usable: true,
    });
    assert.equal(body.field_capabilities.genres.exact_filter.declared, false);
    assert.deepEqual(body.expand_capabilities, []);
  });
});

test("stream metadata advertises lexical, semantic, and expansion capabilities for owner tokens", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const gmailManifest = readGmailManifest();
    const registerResp = await registerConnectorManifest(asUrl, gmailManifest);
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl, "gmail_capability_owner");
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/streams/messages?connector_id=${encodeURIComponent(gmailManifest.connector_id)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );

    assert.equal(status, 200);
    assert.equal(body.field_capabilities.subject.lexical_search.usable, true);
    assert.equal(body.field_capabilities.subject.semantic_search.usable, true);
    assert.equal(body.field_capabilities.from_email.lexical_search.usable, true);
    assert.equal(body.field_capabilities.from_email.semantic_search.declared, false);
    assert.deepEqual(body.field_capabilities.received_at.range_filter, {
      declared: true,
      operators: ["gte", "gt", "lte", "lt"],
      usable: true,
    });
    assert.deepEqual(
      body.expand_capabilities.map((entry: JsonObject) => ({
        cardinality: entry.cardinality,
        default_limit: entry.default_limit,
        max_limit: entry.max_limit,
        name: entry.name,
        stream: entry.stream,
        usable: entry.usable,
      })),
      [
        {
          cardinality: "has_one",
          default_limit: undefined,
          max_limit: undefined,
          name: "message_bodies",
          stream: "message_bodies",
          usable: true,
        },
        {
          cardinality: "has_many",
          default_limit: 10,
          max_limit: 50,
          name: "attachments",
          stream: "attachments",
          usable: true,
        },
      ]
    );
  });
});

test("stream metadata marks grant-limited field capabilities unusable for client tokens", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const approved = await approveGrant(asUrl, "capability_limited_spotify_owner", {
      access_mode: "continuous",
      client_id: "longview",
      purpose_code: "https://pdpp.org/purpose/analytics",
      purpose_description: "schema discovery test",
      source: { id: spotifyManifest.connector_id, kind: "connector" },
      streams: [{ fields: ["id", "name", "source_updated_at"], name: "top_artists" }],
    });
    assert.ok(approved.token, `expected issued grant token, got ${JSON.stringify(approved)}`);

    const { status, body } = await fetchJson(`${rsUrl}/v1/streams/top_artists`, {
      headers: { Authorization: `Bearer ${approved.token}` },
    });

    assert.equal(status, 200);
    assert.equal(body.object, "stream_metadata");
    assert.ok(
      body.schema?.properties?.source_updated_at,
      "existing schema metadata should remain full source-level metadata"
    );
    assert.deepEqual(body.query.range_filters.source_updated_at, ["gte", "gt", "lte", "lt"]);
    assert.equal(body.field_capabilities.name.granted, true);
    assert.deepEqual(body.field_capabilities.name.exact_filter, {
      declared: true,
      usable: true,
    });
    assert.equal(body.field_capabilities.source_updated_at.granted, true);
    assert.deepEqual(body.field_capabilities.source_updated_at.range_filter, {
      declared: true,
      operators: ["gte", "gt", "lte", "lt"],
      usable: true,
    });
    assert.deepEqual(body.field_capabilities.popularity.exact_filter, {
      declared: true,
      reason: "field_not_granted",
      usable: false,
    });
    assert.deepEqual(body.field_capabilities.popularity.aggregation.sum, {
      declared: true,
      reason: "field_not_granted",
      usable: false,
    });

    const gmailManifest = readGmailManifest();
    const registerResp = await registerConnectorManifest(asUrl, gmailManifest);
    assert.equal(registerResp.status, 201);
    const gmailGrant = await approveGrant(asUrl, "capability_limited_gmail_owner", {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: gmailManifest.connector_id,
      purpose_code: "https://pdpp.org/purpose/analytics",
      purpose_description: "Plan message queries using a narrowed field set",
      streams: [{ fields: ["id", "thread_id", "received_at", "subject"], name: "messages" }],
    });
    assert.ok(gmailGrant.token, `expected issued grant token, got ${JSON.stringify(gmailGrant)}`);

    const gmailMetadata = await fetchJson(`${rsUrl}/v1/streams/messages`, {
      headers: { Authorization: `Bearer ${gmailGrant.token}` },
    });

    assert.equal(gmailMetadata.status, 200);
    assert.deepEqual(gmailMetadata.body.field_capabilities.date.range_filter, {
      declared: true,
      operators: ["gte", "gt", "lte", "lt"],
      reason: "field_not_granted",
      usable: false,
    });
    assert.deepEqual(gmailMetadata.body.field_capabilities.from_email.lexical_search, {
      declared: true,
      reason: "field_not_granted",
      usable: false,
    });
    assert.deepEqual(gmailMetadata.body.field_capabilities.snippet.semantic_search, {
      declared: true,
      reason: "field_not_granted",
      usable: false,
    });
    assert.deepEqual(
      gmailMetadata.body.expand_capabilities.map((entry: JsonObject) => ({
        name: entry.name,
        reason: entry.reason,
        usable: entry.usable,
      })),
      [
        {
          name: "message_bodies",
          reason: "related_stream_not_granted",
          usable: false,
        },
        {
          name: "attachments",
          reason: "related_stream_not_granted",
          usable: false,
        },
      ]
    );
  });
});

test("stream metadata publishes query.aggregations for declared aggregate fields", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/streams/top_artists?connector_id=${encodeURIComponent(connectorId)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(status, 200);
    assert.equal(body.query.aggregations.count, true);
    assert.deepEqual(body.query.aggregations.sum, ["popularity", "followers"]);
    assert.deepEqual(body.query.aggregations.group_by, ["name"]);
    assert.deepEqual(body.query.aggregations.group_by_time, ["source_updated_at"]);
    assert.deepEqual(body.query.aggregations.count_distinct, ["name"]);
    assert.deepEqual(body.field_capabilities.source_updated_at.aggregation.group_by_time, {
      declared: true,
      usable: true,
    });
    assert.deepEqual(body.field_capabilities.name.aggregation.count_distinct, {
      declared: true,
      usable: true,
    });
    assert.deepEqual(body.field_capabilities.popularity.aggregation.group_by_time, {
      declared: false,
      usable: false,
    });
    assert.deepEqual(body.field_capabilities.popularity.aggregation.sum, {
      declared: true,
      usable: true,
    });
    assert.deepEqual(body.field_capabilities.source_updated_at.aggregation.min, {
      declared: true,
      usable: true,
    });
    assert.deepEqual(body.field_capabilities.name.aggregation.group_by, {
      declared: true,
      usable: true,
    });
    assert.deepEqual(body.field_capabilities.genres.aggregation.group_by, {
      declared: false,
      usable: false,
    });
  });
});

test("stream aggregate computes count, sum, min/max, grouped counts, and declared filters", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { followers: 100, id: "agg_a", name: "Alpha", popularity: 10, source_updated_at: "2026-01-01T00:00:00Z" },
      { followers: 300, id: "agg_b", name: "Beta", popularity: 40, source_updated_at: "2026-02-01T00:00:00Z" },
      { followers: 500, id: "agg_c", name: "Beta", popularity: 70, source_updated_at: "2026-03-01T00:00:00Z" },
    ]);

    const base = `${rsUrl}/v1/streams/top_artists/aggregate?connector_id=${encodeURIComponent(connectorId)}`;
    const headers = { Authorization: `Bearer ${ownerToken}` };

    const count = await fetchJson(`${base}&metric=count&filter[source_updated_at][gte]=2026-02-01T00:00:00Z`, {
      headers,
    });
    assert.equal(count.status, 200);
    // Canonical aggregate envelope: `links` and `meta` are added by the
    // route adapter via `finalizeCanonicalEnvelope`. We assert the payload
    // semantics here and the envelope shape separately so the assertion
    // does not couple to changes in the count/warnings vocabulary.
    const { links, meta, ...countBody } = count.body;
    assert.deepEqual(countBody, {
      approximate: false,
      field: null,
      filtered_record_count: 2,
      granularity: null,
      group_by: null,
      // Additive time-bucket/distinct fields (null/false for a scalar count).
      group_by_time: null,
      metric: "count",
      object: "aggregation",
      stream: "top_artists",
      time_zone: null,
      value: 2,
    });
    assert.equal(typeof links?.self, "string");
    assert.equal(meta?.count?.kind, "none");
    assert.deepEqual(meta?.warnings, []);

    const sum = await fetchJson(`${base}&metric=sum&field=popularity`, { headers });
    assert.equal(sum.status, 200);
    assert.equal(sum.body.value, 120);

    const min = await fetchJson(`${base}&metric=min&field=source_updated_at`, { headers });
    assert.equal(min.status, 200);
    assert.equal(min.body.value, "2026-01-01T00:00:00Z");

    const max = await fetchJson(`${base}&metric=max&field=followers`, { headers });
    assert.equal(max.status, 200);
    assert.equal(max.body.value, 500);

    const grouped = await fetchJson(`${base}&metric=count&group_by=name&limit=2`, { headers });
    assert.equal(grouped.status, 200);
    assert.deepEqual(grouped.body.groups, [
      { count: 2, key: "Beta" },
      { count: 1, key: "Alpha" },
    ]);
  });
});

test("stream aggregate enforces grants and declared aggregate fields", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl, "aggregation_grant_owner");
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { followers: 100, id: "grant_a", name: "Alpha", popularity: 10, source_updated_at: "2026-01-01T00:00:00Z" },
    ]);
    const approved = await approveGrant(asUrl, "aggregation_grant_owner", {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.org/purpose/analytics",
      purpose_description: "aggregation grant safety test",
      streams: [{ fields: ["id", "name", "source_updated_at"], name: "top_artists" }],
    });
    assert.ok(approved.token);

    const base = `${rsUrl}/v1/streams/top_artists/aggregate`;
    const headers = { Authorization: `Bearer ${approved.token}` };

    const count = await fetchJson(`${base}?metric=count`, { headers });
    assert.equal(count.status, 200);
    assert.equal(count.body.value, 1);

    const unauthorizedField = await fetchJson(`${base}?metric=sum&field=popularity`, { headers });
    assert.equal(unauthorizedField.status, 403);
    assert.equal(unauthorizedField.body.error.code, "field_not_granted");

    const undeclaredGroup = await fetchJson(`${base}?metric=count&group_by=source_updated_at`, { headers });
    assert.equal(undeclaredGroup.status, 400);
    assert.equal(undeclaredGroup.body.error.code, "invalid_request");
  });
});

test("stream aggregate honors grant resources, time ranges, and request filters together", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl, "aggregation_scope_owner");
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { followers: 100, id: "scoped_old", name: "Alpha", popularity: 10, source_updated_at: "2026-01-01T00:00:00Z" },
      { followers: 300, id: "scoped_hit", name: "Beta", popularity: 40, source_updated_at: "2026-02-01T00:00:00Z" },
      {
        followers: 500,
        id: "scoped_resource_hidden",
        name: "Beta",
        popularity: 70,
        source_updated_at: "2026-03-01T00:00:00Z",
      },
    ]);
    const approved = await approveGrant(asUrl, "aggregation_scope_owner", {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.org/purpose/analytics",
      purpose_description: "aggregation resource and time-range safety test",
      streams: [
        {
          fields: ["id", "name", "popularity", "source_updated_at"],
          name: "top_artists",
          resources: ["scoped_old", "scoped_hit"],
          time_range: { since: "2026-01-15T00:00:00Z" },
        },
      ],
    });
    assert.ok(approved.token);

    const url =
      `${rsUrl}/v1/streams/top_artists/aggregate` +
      "?metric=sum&field=popularity&filter[source_updated_at][lte]=2026-02-15T00:00:00Z";
    const { status, body } = await fetchJson(url, {
      headers: { Authorization: `Bearer ${approved.token}` },
    });
    assert.equal(status, 200);
    assert.equal(body.filtered_record_count, 1);
    assert.equal(body.value, 40);
  });
});

test("stream metadata includes freshness when records exist", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: "a1", name: "Artist 1", source_updated_at: "2026-03-01T00:00:00Z" },
    ]);
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/streams/top_artists?connector_id=${encodeURIComponent(connectorId)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(status, 200);
    assert.ok(body.freshness, "freshness should be present");
    // Direct ingest path (no runtime run.batch_ingested event) surfaces a
    // captured_at but status: 'unknown' per spec §8 freshness honesty rules —
    // the reference doesn't claim `current` without a runtime-observed capture.
    assert.ok(["current", "unknown"].includes(body.freshness.status));
    assert.ok(body.freshness.captured_at);
  });
});

test("schema discovery and stream list derive current freshness from connector run history", async () => {
  await withHarness(
    async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl);
      const connectorId = spotifyManifest.connector_id;
      const runAt = new Date(Date.now() - 60_000).toISOString();
      await emitSyntheticRun({
        connectorId,
        occurredAt: runAt,
        runId: "run_freshness_schema_success",
        status: "succeeded",
      });
      await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
        { id: "fresh-1", name: "Fresh Artist", source_updated_at: runAt },
      ]);

      const schemaResp = await fetchJson(`${rsUrl}/v1/schema`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(schemaResp.status, 200);
      // Schema discovery emits the canonical operational key.
      const canonicalConnectorId = canonicalConnectorKey(connectorId) ?? connectorId;
      const schemaConnector = schemaResp.body.connectors.find(
        (row: JsonObject) => row.connector_id === canonicalConnectorId
      );
      const schemaStream = schemaConnector.streams.find((stream: JsonObject) => stream.name === "top_artists");
      assert.equal(schemaStream.freshness.status, "current");
      assert.equal(schemaStream.freshness.captured_at, runAt);
      assert.equal(schemaStream.freshness.last_attempted_at, runAt);

      const listResp = await fetchJson(`${rsUrl}/v1/streams?connector_id=${encodeURIComponent(connectorId)}`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(listResp.status, 200);
      const listStream = listResp.body.data.find((stream: JsonObject) => stream.name === "top_artists");
      assert.equal(listStream.freshness.status, "current");
      assert.equal(listStream.freshness.captured_at, runAt);
      assert.equal(listStream.freshness.last_attempted_at, runAt);
    },
    { mutateManifest: addTestRefreshPolicy }
  );
});

test("stream metadata marks stale freshness when the latest connector attempt failed", async () => {
  await withHarness(
    async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl);
      const connectorId = spotifyManifest.connector_id;
      const successAt = new Date(Date.now() - 10 * 60_000).toISOString();
      const failedAt = new Date(Date.now() - 60_000).toISOString();
      await emitSyntheticRun({
        connectorId,
        occurredAt: successAt,
        runId: "run_freshness_detail_success",
        status: "succeeded",
      });
      await emitSyntheticRun({
        connectorId,
        occurredAt: failedAt,
        runId: "run_freshness_detail_failed",
        status: "failed",
      });

      const { status, body } = await fetchJson(
        `${rsUrl}/v1/streams/top_artists?connector_id=${encodeURIComponent(connectorId)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } }
      );
      assert.equal(status, 200);
      assert.equal(body.freshness.status, "stale");
      assert.equal(body.freshness.captured_at, successAt);
      assert.equal(body.freshness.last_attempted_at, failedAt);
    },
    { mutateManifest: addTestRefreshPolicy }
  );
});

test("stream list publishes freshness with unknown status when empty", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await materializeSpotifyConnection(connectorId);
    // list without any ingested records — we need owner_scope: connector
    const { status, body } = await fetchJson(`${rsUrl}/v1/streams?connector_id=${encodeURIComponent(connectorId)}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.data));
    // With no records the list is empty; add one so freshness surfaces.
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: "b1", name: "Beta", source_updated_at: "2026-03-05T00:00:00Z" },
    ]);
    const { body: body2 } = await fetchJson(`${rsUrl}/v1/streams?connector_id=${encodeURIComponent(connectorId)}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const top = body2.data.find((s: JsonObject) => s.name === "top_artists");
    assert.ok(top, "top_artists should appear after ingest");
    assert.ok(top.freshness, "stream list entries carry freshness");
    // See note in previous test: direct ingest without runtime events yields
    // status: 'unknown' with captured_at, rather than 'current'.
    assert.ok(["current", "unknown"].includes(top.freshness.status));
  });
});

test("range filter on declared field filters records", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: "a1", name: "A", source_updated_at: "2026-01-01T00:00:00Z" },
      { id: "a2", name: "B", source_updated_at: "2026-02-01T00:00:00Z" },
      { id: "a3", name: "C", source_updated_at: "2026-03-01T00:00:00Z" },
    ]);
    const url =
      `${rsUrl}/v1/streams/top_artists/records` +
      `?connector_id=${encodeURIComponent(connectorId)}` +
      "&filter[source_updated_at][gte]=2026-02-01T00:00:00Z";
    const { status, body } = await fetchJson(url, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    assert.equal(body.object, "list");
    const ids = body.data.map((r: JsonObject) => r.id).sort();
    assert.deepEqual(ids, ["a2", "a3"]);
  });
});

test("over-max limit clamps to 100 and surfaces a limit_clamped warning on the HTTP wire", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    const records = Array.from({ length: 101 }, (_, i) => ({
      id: `a${String(i).padStart(3, "0")}`,
      name: `Artist ${i}`,
      source_updated_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
    }));
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, records);
    const url = `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(connectorId)}&limit=200`;
    const { status, body } = await fetchJson(url, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    assert.equal(body.data.length, 100, "page is clamped to the max of 100");
    assert.equal(body.has_more, true, "more records remain to page");
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the runtime fixture deliberately exercises an absent or nullable boundary value.
    const warnings = body?.meta?.warnings;
    assert.ok(Array.isArray(warnings), "meta.warnings[] is present on the wire");
    const clamp = warnings.find((warning) => warning?.code === "limit_clamped");
    assert.ok(clamp, "limit_clamped warning is surfaced in the HTTP body");
    assert.equal(clamp.param, "limit");
    assert.deepEqual(clamp.detail, { max_limit: 100, requested_limit: 200 });
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(clamp.message, /200/);
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(clamp.message, /100/);
  });
});

test("range filter on undeclared field is rejected", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: "a1", name: "A", popularity: 42, source_updated_at: "2026-01-01T00:00:00Z" },
    ]);
    // popularity is not declared under query.range_filters for top_artists.
    const url =
      `${rsUrl}/v1/streams/top_artists/records` +
      `?connector_id=${encodeURIComponent(connectorId)}` +
      "&filter[popularity][gte]=1";
    const { status, body } = await fetchJson(url, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, "invalid_request");
  });
});

test("filter on unknown field is rejected with 400", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: "a1", name: "A", source_updated_at: "2026-01-01T00:00:00Z" },
    ]);
    const url =
      `${rsUrl}/v1/streams/top_artists/records` +
      `?connector_id=${encodeURIComponent(connectorId)}` +
      "&filter[nonsense]=x";
    const { status, body } = await fetchJson(url, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 400);
    // Server's pre-flight validator emits `unknown_field`; the strict resolver
    // would have emitted `invalid_request`. Both are spec-permissible signals
    // that the filter references a field outside the stream schema.
    assert.ok(
      body.error.code === "unknown_field" || body.error.code === "invalid_request",
      `expected unknown_field or invalid_request, got ${body.error.code}`
    );
  });
});

// ─── fields-projection conformance (agent-vantage read surface) ───────────
//
// The MCP `query_records` / `fetch` `fields` doc promises (verbatim):
//   "Field paths must be declared by the stream; advertised by `GET /v1/schema`
//    (`field_capabilities`). Unknown paths are rejected by the RS rather than
//    silently widened."
// These guards pin that promise on the canonical HTTP read for BOTH grant
// shapes — a full-stream grant (no field allowlist) and a restricted grant —
// so a manifest-nonexistent `fields=` entry is a loud `unknown_field` error,
// never a silent 200 with the field dropped. The restricted-grant unknown
// (`field_not_granted`) sibling is pinned in event-spine.test.js; here we pin
// the manifest-unknown path, which is independent of grant field scope.
test("fields projection on an unknown field is rejected under a full-stream grant", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    // An owner token reads with an owner read-grant that carries no field
    // allowlist — the full-stream case the static audit flagged as the one
    // where the grant-only `field_not_granted` guard would be skipped.
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: "a1", name: "A", source_updated_at: "2026-01-01T00:00:00Z" },
    ]);
    const url =
      `${rsUrl}/v1/streams/top_artists/records` +
      `?connector_id=${encodeURIComponent(connectorId)}` +
      "&fields=id,not_a_real_field";
    const { status, body } = await fetchJson(url, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 400, "unknown projection field must fail loudly, not silently narrow");
    assert.equal(body.error.code, "unknown_field");
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(body.error.message || "", /Unknown field: not_a_real_field/);
  });
});

test("record-detail fields projection on an unknown field is rejected under a full-stream grant", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: "a1", name: "A", source_updated_at: "2026-01-01T00:00:00Z" },
    ]);
    const url =
      `${rsUrl}/v1/streams/top_artists/records/a1` +
      `?connector_id=${encodeURIComponent(connectorId)}` +
      "&fields=id,not_a_real_field";
    const { status, body } = await fetchJson(url, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 400, "unknown fetch projection field must fail loudly, not return {}");
    assert.equal(body.error.code, "unknown_field");
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(body.error.message || "", /Unknown field: not_a_real_field/);
  });
});

test("fields projection on a manifest-unknown field is rejected under a restricted grant", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const connectorId = spotifyManifest.connector_id;
    const ownerToken = await issueOwnerToken(asUrl, "restricted_fields_owner");
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: "a1", name: "A", source_updated_at: "2026-01-01T00:00:00Z" },
    ]);
    // Restricted grant: only id/name/source_updated_at granted.
    const approved = await approveGrant(asUrl, "restricted_fields_owner", {
      access_mode: "continuous",
      client_id: "longview",
      purpose_code: "https://pdpp.org/purpose/analytics",
      purpose_description: "projection conformance under a narrowed field grant",
      source: { id: connectorId, kind: "connector" },
      streams: [{ fields: ["id", "name", "source_updated_at"], name: "top_artists" }],
    });
    assert.ok(approved.token, `expected grant token, got ${JSON.stringify(approved)}`);

    // `not_a_real_field` is not declared by the manifest at all — this must be
    // `unknown_field` (manifest validation), distinct from the grant-scope
    // `field_not_granted` signal for a real-but-ungranted field.
    const url = `${rsUrl}/v1/streams/top_artists/records?fields=id,not_a_real_field`;
    const { status, body } = await fetchJson(url, {
      headers: { Authorization: `Bearer ${approved.token}` },
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, "unknown_field");
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(body.error.message || "", /Unknown field: not_a_real_field/);
  });
});

test("query-time view applies a real projection (not a silent no-op)", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    // top_artists declares view `basic` -> fields [id, name, genres]. Reading
    // with `?view=basic` must project the page to exactly those fields; a
    // record's ungranted-by-view `popularity`/`followers` must be absent. This
    // pins that query-time `view` is honest — advertised, forwarded, AND
    // applied — disproving the static audit's "inert at read time" claim.
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      {
        followers: 1234,
        genres: ["rock"],
        id: "v1",
        name: "View Artist",
        popularity: 77,
        source_updated_at: "2026-01-01T00:00:00Z",
      },
    ]);
    const url = `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(connectorId)}&view=basic`;
    const { status, body } = await fetchJson(url, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    assert.equal(body.data.length, 1);
    // Record payload fields live under `record.data`; the view projects that
    // object down to exactly the declared field set.
    // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
    const data = body.data[0].data;
    assert.equal(data.id, "v1");
    assert.equal(data.name, "View Artist");
    assert.deepEqual(data.genres, ["rock"]);
    // Fields outside the `basic` view projection must not leak through.
    assert.equal("popularity" in data, false, "view=basic must project popularity out");
    assert.equal("followers" in data, false, "view=basic must project followers out");
    assert.equal("source_updated_at" in data, false, "view=basic must project source_updated_at out");
  });
});

test("query-time view and fields together are rejected as mutually exclusive", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: "a1", name: "A", source_updated_at: "2026-01-01T00:00:00Z" },
    ]);
    const url =
      `${rsUrl}/v1/streams/top_artists/records` +
      `?connector_id=${encodeURIComponent(connectorId)}` +
      "&view=basic&fields=id";
    const { status, body } = await fetchJson(url, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, "invalid_request");
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(body.error.message || "", /view and fields are mutually exclusive/);
  });
});

test("query-time view with an unknown view id is rejected", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: "a1", name: "A", source_updated_at: "2026-01-01T00:00:00Z" },
    ]);
    const url =
      `${rsUrl}/v1/streams/top_artists/records` +
      `?connector_id=${encodeURIComponent(connectorId)}` +
      "&view=not_a_real_view";
    const { status, body } = await fetchJson(url, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, "invalid_request");
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(body.error.message || "", /Unknown view/);
  });
});

test("bare since query parameter is rejected loudly", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: "a1", name: "A", source_updated_at: "2026-01-01T00:00:00Z" },
    ]);
    const url =
      `${rsUrl}/v1/streams/top_artists/records` +
      `?connector_id=${encodeURIComponent(connectorId)}` +
      "&since=2026-01-01T00:00:00Z";
    const { status, body } = await fetchJson(url, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, "invalid_request");
  });
});

test("changes_since=beginning starts incremental sync and returns a bookmark", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: "boot_a", name: "Bootstrap A", source_updated_at: "2026-01-01T00:00:00Z" },
      { id: "boot_b", name: "Bootstrap B", source_updated_at: "2026-01-02T00:00:00Z" },
    ]);
    const url =
      `${rsUrl}/v1/streams/top_artists/records` +
      `?connector_id=${encodeURIComponent(connectorId)}` +
      "&changes_since=beginning";
    const { status, body } = await fetchJson(url, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    assert.equal(body.object, "list");
    assert.equal(body.has_more, false);
    assert.deepEqual(body.data.map((r: JsonObject) => r.id).sort(), ["boot_a", "boot_b"]);
    assert.ok(typeof body.next_changes_since === "string" && body.next_changes_since.length > 0);
    assert.ok(!body.next_cursor, "terminal changes page should not expose a page cursor");
  });
});

test("changes_since=beginning paginates with next_cursor and still returns next_changes_since", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: "page_a", name: "Page A", source_updated_at: "2026-01-01T00:00:00Z" },
      { id: "page_b", name: "Page B", source_updated_at: "2026-01-02T00:00:00Z" },
      { id: "page_c", name: "Page C", source_updated_at: "2026-01-03T00:00:00Z" },
    ]);
    const firstUrl =
      `${rsUrl}/v1/streams/top_artists/records` +
      `?connector_id=${encodeURIComponent(connectorId)}` +
      "&changes_since=beginning&limit=2";
    const first = await fetchJson(firstUrl, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.has_more, true);
    assert.deepEqual(
      first.body.data.map((r: JsonObject) => r.id),
      ["page_a", "page_b"]
    );
    assert.ok(typeof first.body.next_cursor === "string" && first.body.next_cursor.length > 0);
    assert.ok(typeof first.body.next_changes_since === "string" && first.body.next_changes_since.length > 0);

    const pageCursor = JSON.parse(Buffer.from(first.body.next_cursor, "base64").toString("utf8"));
    assert.equal(pageCursor.kind, "page");
    assert.equal(pageCursor.session, "changes");

    const second = await fetchJson(
      `${rsUrl}/v1/streams/top_artists/records` +
        `?connector_id=${encodeURIComponent(connectorId)}` +
        `&cursor=${encodeURIComponent(first.body.next_cursor)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(second.status, 200);
    assert.equal(second.body.has_more, false);
    assert.deepEqual(
      second.body.data.map((r: JsonObject) => r.id),
      ["page_c"]
    );
    assert.ok(typeof second.body.next_changes_since === "string" && second.body.next_changes_since.length > 0);
    assert.equal(second.body.next_changes_since, first.body.next_changes_since);
    assert.ok(!second.body.next_cursor);
  });
});

test("raw timestamp changes_since value is rejected as an invalid cursor", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: "time_a", name: "Timestamp A", source_updated_at: "2026-01-01T00:00:00Z" },
    ]);
    const url =
      `${rsUrl}/v1/streams/top_artists/records` +
      `?connector_id=${encodeURIComponent(connectorId)}` +
      `&changes_since=${encodeURIComponent("2026-04-24T00:00:00Z")}`;
    const { status, body } = await fetchJson(url, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, "invalid_cursor");
    // The error message is self-teaching: it names the two legal forms a
    // cold caller can use to recover (the `beginning` bootstrap sentinel
    // and the `next_changes_since` cursor returned by a prior changes-feed
    // response). Avoids a closed-loop "rejection without remedy".
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(body.error.message, /\bbeginning\b/);
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(body.error.message, /\bnext_changes_since\b/);
  });
});

test("unknown query parameter is rejected (not silently ignored)", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await materializeSpotifyConnection(connectorId);
    const url =
      `${rsUrl}/v1/streams/top_artists/records` +
      `?connector_id=${encodeURIComponent(connectorId)}` +
      "&totally_made_up=true";
    const { status, body } = await fetchJson(url, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, "invalid_request");
  });
});

test("noncanonical range query parameters are rejected loudly", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: "a1", name: "A", source_updated_at: "2026-01-01T00:00:00Z" },
      { id: "a2", name: "B", source_updated_at: "2026-02-01T00:00:00Z" },
    ]);
    // biome-ignore lint/complexity/noUselessStringConcat: the expression intentionally mirrors the fixture construction used by the contract.
    const baseUrl = `${rsUrl}/v1/streams/top_artists/records` + `?connector_id=${encodeURIComponent(connectorId)}`;
    const badParams = [
      "source_updated_at.gte=2026-01-01T00%3A00%3A00Z",
      "source_updated_at_gte=2026-01-01T00%3A00%3A00Z",
      "source_updated_at=gte%3A2026-01-01T00%3A00%3A00Z",
      "min_source_updated_at=2026-01-01T00%3A00%3A00Z",
    ];

    for (const param of badParams) {
      // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
      const { status, body } = await fetchJson(`${baseUrl}&${param}`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(status, 400, `${param} must fail instead of widening the read`);
      assert.equal(body.error.code, "invalid_request");
    }
    const { status, body } = await fetchJson(`${baseUrl}&filter[source_updated_at][gte]=2026-02-01T00:00:00Z`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    assert.deepEqual(body.data.map((record: JsonObject) => record.id).sort(), ["a2"]);
  });
});

test("records are sorted by (cursor_field, primary_key) and cursor tokens are logical", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: "art_c", name: "C", source_updated_at: "2026-03-01T00:00:00Z" },
      { id: "art_a", name: "A", source_updated_at: "2026-01-01T00:00:00Z" },
      { id: "art_b", name: "B", source_updated_at: "2026-02-01T00:00:00Z" },
    ]);
    const listUrl =
      `${rsUrl}/v1/streams/top_artists/records` +
      `?connector_id=${encodeURIComponent(connectorId)}` +
      "&order=asc&limit=2";
    const { status, body } = await fetchJson(listUrl, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    assert.equal(body.object, "list");
    assert.equal(body.has_more, true);
    // Ordering is by (source_updated_at asc, id asc): a(Jan), b(Feb), c(Mar).
    assert.deepEqual(
      body.data.map((r: JsonObject) => r.id),
      ["art_a", "art_b"]
    );
    assert.ok(body.next_cursor, "next_cursor should be present");

    // We don't assert on the cursor's internal shape — clients must treat it as
    // opaque. We do verify the token is not a bare row-id (no numeric `id`).
    const decoded = JSON.parse(Buffer.from(body.next_cursor, "base64").toString("utf8"));
    assert.equal(decoded.kind, "page");
    assert.equal(decoded.session, "records");
    assert.ok(!Number.isInteger(decoded.id), "cursor must not encode a raw row id");

    // The real correctness check: feeding the cursor back returns the
    // remaining records in the same logical order.
    const pageTwo = await fetchJson(`${listUrl}&cursor=${encodeURIComponent(body.next_cursor)}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(pageTwo.status, 200);
    assert.deepEqual(
      pageTwo.body.data.map((r: JsonObject) => r.id),
      ["art_c"]
    );
    assert.equal(pageTwo.body.has_more, false);
  });
});

test("records list invalid_sort returns a request-error envelope", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: "sort_a", name: "A", source_updated_at: "2026-01-01T00:00:00Z" },
    ]);
    const url = `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(connectorId)}&sort=name`;
    const { status, body } = await fetchJson(url, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 400);
    assert.equal(body.error.type, "invalid_request_error");
    assert.equal(body.error.code, "invalid_sort");
    assert.equal(body.error.param, "sort");
  });
});

test("exact filter on declared scalar field works", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyTopArtists(rsUrl, ownerToken, connectorId, [
      { id: "a1", name: "Alice", source_updated_at: "2026-01-01T00:00:00Z" },
      { id: "a2", name: "Bob", source_updated_at: "2026-01-02T00:00:00Z" },
    ]);
    const url =
      `${rsUrl}/v1/streams/top_artists/records` +
      `?connector_id=${encodeURIComponent(connectorId)}` +
      "&filter[name]=Alice";
    const { status, body } = await fetchJson(url, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].id, "a1");
  });
});

test("expand hydrates declared has_many relations and respects child grant projection", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl, "expand_owner");
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyStream(rsUrl, ownerToken, connectorId, "saved_tracks", [
      {
        artist_names: ["Artist 1"],
        id: "track_1",
        name: "Track 1",
        saved_at: "2026-02-01T00:00:00Z",
        source_created_at: "2026-02-01T00:00:00Z",
      },
    ]);
    await seedSpotifyStream(rsUrl, ownerToken, connectorId, "recently_played", [
      {
        id: "play_2",
        played_at: "2026-02-03T00:00:00Z",
        track_id: "track_1",
        track_name: "Track 1",
      },
      {
        id: "play_1",
        played_at: "2026-02-02T00:00:00Z",
        track_id: "track_1",
        track_name: "Track 1",
      },
    ]);

    const approved = await approveGrant(asUrl, "expand_owner", {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.org/purpose/personalization",
      purpose_description: "Read saved tracks with recent listening context",
      streams: [
        { fields: ["id", "name", "saved_at"], name: "saved_tracks" },
        { fields: ["id", "track_id", "played_at"], name: "recently_played" },
      ],
    });

    const { status, body } = await fetchJson(
      `${rsUrl}/v1/streams/saved_tracks/records?expand=recently_played&expand_limit[recently_played]=1`,
      { headers: { Authorization: `Bearer ${approved.token}` } }
    );
    assert.equal(status, 200);
    const record = body.data?.[0];
    assert.ok(record, "expected one saved track");
    assert.ok(record.expanded?.recently_played, "expanded relation should be present");
    assert.equal(record.expanded.recently_played.object, "list");
    assert.equal(record.expanded.recently_played.has_more, true);
    assert.equal(record.expanded.recently_played.data.length, 1);
    // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
    const child = record.expanded.recently_played.data[0];
    assert.deepEqual(Object.keys(child.data || {}).sort(), ["id", "played_at", "track_id"]);
    assert.ok(!("track_name" in (child.data || {})));
    assert.equal(child.id, "play_1");
  });
});

test("single-record fetch honors declared expand and expand_limit", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl, "record_expand_owner");
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyStream(rsUrl, ownerToken, connectorId, "saved_tracks", [
      {
        artist_names: ["Artist 1"],
        id: "track_1",
        name: "Track 1",
        saved_at: "2026-02-01T00:00:00Z",
        source_created_at: "2026-02-01T00:00:00Z",
      },
    ]);
    await seedSpotifyStream(rsUrl, ownerToken, connectorId, "recently_played", [
      {
        id: "play_2",
        played_at: "2026-02-03T00:00:00Z",
        track_id: "track_1",
        track_name: "Track 1",
      },
      {
        id: "play_1",
        played_at: "2026-02-02T00:00:00Z",
        track_id: "track_1",
        track_name: "Track 1",
      },
    ]);

    const approved = await approveGrant(asUrl, "record_expand_owner", {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.org/purpose/personalization",
      purpose_description: "Read one saved track with recent listening context",
      streams: [
        { fields: ["id", "name", "saved_at"], name: "saved_tracks" },
        { fields: ["id", "track_id", "played_at"], name: "recently_played" },
      ],
    });

    const { status, body } = await fetchJson(
      `${rsUrl}/v1/streams/saved_tracks/records/track_1?expand=recently_played&expand_limit[recently_played]=1`,
      { headers: { Authorization: `Bearer ${approved.token}` } }
    );
    assert.equal(status, 200);
    assert.equal(body.connector_key, "spotify", "record detail carries canonical source connector identity");
    assert.ok(body.expanded?.recently_played, "expanded relation should be present on record detail");
    assert.equal(body.expanded.recently_played.object, "list");
    assert.equal(body.expanded.recently_played.has_more, true);
    assert.equal(body.expanded.recently_played.data.length, 1);
    assert.equal(body.expanded.recently_played.data[0].id, "play_1");
  });
});

test("expand fails with insufficient_scope when the related stream is outside the grant", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl, "expand_scope_owner");
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyStream(rsUrl, ownerToken, connectorId, "saved_tracks", [
      {
        id: "track_1",
        name: "Track 1",
        saved_at: "2026-02-01T00:00:00Z",
        source_created_at: "2026-02-01T00:00:00Z",
      },
    ]);
    await seedSpotifyStream(rsUrl, ownerToken, connectorId, "recently_played", [
      {
        id: "play_1",
        played_at: "2026-02-02T00:00:00Z",
        track_id: "track_1",
        track_name: "Track 1",
      },
    ]);

    const approved = await approveGrant(asUrl, "expand_scope_owner", {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.org/purpose/personalization",
      purpose_description: "Read saved tracks only",
      streams: [{ fields: ["id", "name", "saved_at"], name: "saved_tracks" }],
    });

    const { status, body } = await fetchJson(`${rsUrl}/v1/streams/saved_tracks/records?expand=recently_played`, {
      headers: { Authorization: `Bearer ${approved.token}` },
    });
    assert.equal(status, 403);
    assert.equal(body.error.code, "insufficient_scope");
  });
});

test("gmail messages expand message_bodies on list and detail reads with child projection", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl, "gmail_expand_body_owner");
    const gmailManifest = readGmailManifest();
    const connectorId = gmailManifest.connector_id;
    const reg = await registerConnectorManifest(asUrl, gmailManifest);
    assert.equal(reg.status, 201, "register gmail manifest");
    await seedGmailExpansionFixture(rsUrl, ownerToken, connectorId);

    const metadata = await fetchJson(`${rsUrl}/v1/streams/messages?connector_id=${encodeURIComponent(connectorId)}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(metadata.status, 200);
    assert.deepEqual(metadata.body.query.expand.map((entry: JsonObject) => entry.name).sort(), [
      "attachments",
      "message_bodies",
    ]);

    const approved = await approveGrant(asUrl, "gmail_expand_body_owner", {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.org/purpose/personalization",
      purpose_description: "Read Gmail messages with body context",
      streams: [
        { fields: ["id", "thread_id", "subject", "received_at"], name: "messages" },
        { fields: ["id", "message_id", "body_text"], name: "message_bodies" },
      ],
    });

    const list = await fetchJson(
      `${rsUrl}/v1/streams/messages/records?connector_id=${encodeURIComponent(connectorId)}&order=asc&expand=message_bodies`,
      { headers: { Authorization: `Bearer ${approved.token}` } }
    );
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 2);

    const messageWithBody = list.body.data.find((record: JsonObject) => record.id === "msg-1");
    assert.ok(messageWithBody?.expanded?.message_bodies, "msg-1 should include body expansion");
    assert.equal(messageWithBody.expanded.message_bodies.stream, "message_bodies");
    assert.deepEqual(Object.keys(messageWithBody.expanded.message_bodies.data || {}).sort(), [
      "body_source",
      "body_text",
      "id",
      "message_id",
    ]);
    assert.equal(messageWithBody.expanded.message_bodies.data.body_text, "Here is your train receipt for Milan.");
    assert.ok(!("body_html" in messageWithBody.expanded.message_bodies.data));

    const messageWithoutBody = list.body.data.find((record: JsonObject) => record.id === "msg-2");
    assert.equal(messageWithoutBody?.expanded?.message_bodies, null);

    const detail = await fetchJson(
      `${rsUrl}/v1/streams/messages/records/msg-1?connector_id=${encodeURIComponent(connectorId)}&expand=message_bodies`,
      { headers: { Authorization: `Bearer ${approved.token}` } }
    );
    assert.equal(detail.status, 200);
    assert.equal(detail.body.expanded.message_bodies.id, "body-msg-1");
    assert.equal(detail.body.expanded.message_bodies.data.body_text, "Here is your train receipt for Milan.");
  });
});

test("gmail messages expand attachment metadata with limits and missing-child parity", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl, "gmail_expand_attachment_owner");
    const gmailManifest = readGmailManifest();
    const connectorId = gmailManifest.connector_id;
    const reg = await registerConnectorManifest(asUrl, gmailManifest);
    assert.equal(reg.status, 201, "register gmail manifest");
    await seedGmailExpansionFixture(rsUrl, ownerToken, connectorId);

    const approved = await approveGrant(asUrl, "gmail_expand_attachment_owner", {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.org/purpose/personalization",
      purpose_description: "Read Gmail messages with attachment metadata",
      streams: [
        { fields: ["id", "thread_id", "subject", "received_at", "has_attachments"], name: "messages" },
        {
          fields: ["id", "message_id", "filename", "content_type", "part_index", "message_received_at"],
          name: "attachments",
        },
      ],
    });

    const { status, body } = await fetchJson(
      `${rsUrl}/v1/streams/messages/records?connector_id=${encodeURIComponent(connectorId)}&order=asc&expand=attachments&expand_limit[attachments]=2`,
      { headers: { Authorization: `Bearer ${approved.token}` } }
    );
    assert.equal(status, 200);

    const messageWithAttachments = body.data.find((record: JsonObject) => record.id === "msg-1");
    assert.ok(messageWithAttachments?.expanded?.attachments, "msg-1 should include attachment expansion");
    assert.equal(messageWithAttachments.expanded.attachments.object, "list");
    assert.equal(messageWithAttachments.expanded.attachments.has_more, true);
    assert.deepEqual(
      messageWithAttachments.expanded.attachments.data.map((record: JsonObject) => record.id),
      ["att-1", "att-2"]
    );
    assert.deepEqual(Object.keys(messageWithAttachments.expanded.attachments.data[0].data || {}).sort(), [
      "content_type",
      "filename",
      "hydration_status",
      "id",
      "message_id",
      "message_received_at",
      "part_index",
    ]);
    assert.equal(
      JSON.stringify(messageWithAttachments.expanded.attachments).includes("blob_ref"),
      false,
      "attachment expansion must not expose blob_ref unless the child grant includes it"
    );

    const messageWithoutAttachments = body.data.find((record: JsonObject) => record.id === "msg-2");
    assert.equal(messageWithoutAttachments.expanded.attachments.object, "list");
    assert.equal(messageWithoutAttachments.expanded.attachments.has_more, false);
    assert.deepEqual(messageWithoutAttachments.expanded.attachments.data, []);
  });
});

test("gmail messages expand hydrated attachments with grant-visible blob_ref fetch_url", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl, "gmail_expand_attachment_blob_owner");
    const gmailManifest = readGmailManifest();
    const connectorId = gmailManifest.connector_id;
    const reg = await registerConnectorManifest(asUrl, gmailManifest);
    assert.equal(reg.status, 201, "register gmail manifest");

    const bytes = Buffer.from("invoice attachment bytes");
    const blob = await uploadBlob(
      rsUrl,
      ownerToken,
      { connector_id: connectorId, record_key: "msg-blob:2", stream: "attachments" },
      bytes,
      "application/pdf"
    );
    assert.equal(blob.status, 200);

    await seedGmailStream(rsUrl, ownerToken, connectorId, "messages", [
      {
        bcc: [],
        cc: [],
        has_attachments: true,
        id: "msg-blob",
        is_answered: false,
        is_draft: false,
        is_flagged: false,
        is_seen: true,
        labels: [],
        received_at: "2026-04-03T10:00:00Z",
        references: [],
        reply_to: [],
        snippet: "Invoice attached.",
        subject: "Blob invoice",
        thread_id: "thread-blob",
        to: [],
      },
    ]);
    await seedGmailStream(rsUrl, ownerToken, connectorId, "attachments", [
      {
        blob_ref: {
          blob_id: blob.body.blob_id,
          mime_type: blob.body.mime_type,
          sha256: blob.body.sha256,
          size_bytes: blob.body.size_bytes,
        },
        content_id: null,
        content_sha256: blob.body.sha256,
        content_type: "application/pdf",
        encoding: "base64",
        filename: "invoice.pdf",
        hydration_error: null,
        hydration_status: "hydrated",
        id: "msg-blob:2",
        is_inline: false,
        message_id: "msg-blob",
        message_received_at: "2026-04-03T10:00:00Z",
        part_index: "2",
        size_bytes: blob.body.size_bytes,
      },
    ]);

    const approved = await approveGrant(asUrl, "gmail_expand_attachment_blob_owner", {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.org/purpose/personalization",
      purpose_description: "Read Gmail messages with attachment blobs",
      streams: [
        { fields: ["id", "thread_id", "subject", "received_at", "has_attachments"], name: "messages" },
        {
          fields: [
            "id",
            "message_id",
            "filename",
            "content_type",
            "size_bytes",
            "part_index",
            "message_received_at",
            "blob_ref",
            "content_sha256",
            "hydration_status",
          ],
          name: "attachments",
        },
      ],
    });

    const expanded = await fetchJson(
      `${rsUrl}/v1/streams/messages/records?connector_id=${encodeURIComponent(connectorId)}&expand=attachments`,
      { headers: { Authorization: `Bearer ${approved.token}` } }
    );
    assert.equal(expanded.status, 200);
    const message = expanded.body.data.find((record: JsonObject) => record.id === "msg-blob");
    const attachment = message?.expanded?.attachments?.data?.[0];
    assert.ok(attachment, "expanded attachment should be present");
    assert.equal(attachment.data.blob_ref.fetch_url, `/v1/blobs/${blob.body.blob_id}`);
    assert.equal(attachment.data.content_sha256, blob.body.sha256);
    assert.equal(attachment.data.hydration_status, "hydrated");

    const blobResp = await fetch(`${rsUrl}/v1/blobs/${blob.body.blob_id}`, {
      headers: { Authorization: `Bearer ${approved.token}` },
    });
    assert.equal(blobResp.status, 200);
    assert.deepEqual(Buffer.from(await blobResp.arrayBuffer()), bytes);
  });
});

test("gmail message expansion rejects missing child grant and reverse thread relation", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl, "gmail_expand_reject_owner");
    const gmailManifest = readGmailManifest();
    const connectorId = gmailManifest.connector_id;
    const reg = await registerConnectorManifest(asUrl, gmailManifest);
    assert.equal(reg.status, 201, "register gmail manifest");
    await seedGmailExpansionFixture(rsUrl, ownerToken, connectorId);

    const approved = await approveGrant(asUrl, "gmail_expand_reject_owner", {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.org/purpose/personalization",
      purpose_description: "Read Gmail messages only",
      streams: [{ fields: ["id", "thread_id", "subject", "received_at"], name: "messages" }],
    });

    const missingChildGrant = await fetchJson(
      `${rsUrl}/v1/streams/messages/records?connector_id=${encodeURIComponent(connectorId)}&expand=message_bodies`,
      { headers: { Authorization: `Bearer ${approved.token}` } }
    );
    assert.equal(missingChildGrant.status, 403);
    assert.equal(missingChildGrant.body.error.code, "insufficient_scope");

    const reverseThread = await fetchJson(
      `${rsUrl}/v1/streams/messages/records?connector_id=${encodeURIComponent(connectorId)}&expand=thread`,
      { headers: { Authorization: `Bearer ${approved.token}` } }
    );
    assert.equal(reverseThread.status, 400);
    assert.equal(reverseThread.body.error.code, "invalid_expand");
  });
});

function readSlackManifest() {
  return JSON.parse(readFileSync(join(POLYFILL_MANIFESTS_DIR, "slack.json"), "utf8"));
}

async function seedSlackStream(
  rsUrl: string,
  ownerToken: string,
  connectorId: string,
  stream: string,
  records: JsonObject[]
): Promise<void> {
  const lines = records
    .map((record: JsonObject) =>
      JSON.stringify({
        data: record,
        emitted_at: record.emitted_at || record.sent_at || "2026-04-01T00:00:00Z",
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
  assert.equal(resp.status, 200, `ingest slack ${stream} ok`);
}

async function seedSlackExpansionFixture(rsUrl: string, ownerToken: string, connectorId: string): Promise<void> {
  await seedSlackStream(rsUrl, ownerToken, connectorId, "messages", [
    {
      attachment_count: 2,
      channel_id: "C1",
      has_attachments: true,
      id: "C1:1700000001.000100",
      is_thread_parent: false,
      is_tombstone: false,
      latest_reply: null,
      reaction_count: 3,
      reply_count: 0,
      sent_at: "2026-04-01T10:00:00Z",
      subtype: null,
      text: "Have you seen this article?",
      thread_ts: null,
      ts: "1700000001.000100",
      user_id: "U1",
    },
    {
      attachment_count: 0,
      channel_id: "C1",
      has_attachments: false,
      id: "C1:1700000002.000200",
      is_thread_parent: false,
      is_tombstone: false,
      reaction_count: 0,
      reply_count: 0,
      sent_at: "2026-04-02T10:00:00Z",
      subtype: null,
      text: "No attachments here",
      thread_ts: null,
      ts: "1700000002.000200",
      user_id: "U2",
    },
  ]);
  await seedSlackStream(rsUrl, ownerToken, connectorId, "message_attachments", [
    {
      channel_id: "C1",
      fallback: "Example dot com",
      from_url: "https://example.com/post",
      id: "C1:1700000001.000100:0",
      index: 0,
      message_id: "C1:1700000001.000100",
      service_name: "example.com",
      text: "Lede paragraph",
      title: "Example article",
      title_link: "https://example.com/post",
    },
    {
      channel_id: "C1",
      fallback: "Doc preview",
      id: "C1:1700000001.000100:1",
      index: 1,
      message_id: "C1:1700000001.000100",
      service_name: "docs.example.com",
      title: "Internal doc",
      title_link: "https://docs.example.com/d/abc",
    },
    {
      channel_id: "C1",
      fallback: "Third unfurl",
      id: "C1:1700000001.000100:2",
      index: 2,
      message_id: "C1:1700000001.000100",
      service_name: "third.example.com",
      title: "Third unfurl",
    },
  ]);
  await seedSlackStream(rsUrl, ownerToken, connectorId, "reactions", [
    {
      channel_id: "C1",
      emoji: "tada",
      id: "C1:1700000001.000100:tada:U1",
      message_id: "C1:1700000001.000100",
      user_id: "U1",
    },
    {
      channel_id: "C1",
      emoji: "tada",
      id: "C1:1700000001.000100:tada:U2",
      message_id: "C1:1700000001.000100",
      user_id: "U2",
    },
    {
      channel_id: "C1",
      emoji: "eyes",
      id: "C1:1700000001.000100:eyes:U2",
      message_id: "C1:1700000001.000100",
      user_id: "U2",
    },
  ]);
}

test("first-party manifests declare only parent-to-child query.expand entries with FK on child", () => {
  const manifests = readdirSync(POLYFILL_MANIFESTS_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((filename) => ({
      manifest: JSON.parse(readFileSync(join(POLYFILL_MANIFESTS_DIR, filename), "utf8")),
      // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
      manifestName: filename.replace(/\.json$/, ""),
    }))
    .filter(({ manifest }) => manifest.streams.some((stream: JsonObject) => Array.isArray(stream.query?.expand)));

  assert.ok(
    manifests.some(({ manifestName }) => manifestName === "gmail"),
    "gmail should keep its existing expand declarations"
  );
  assert.ok(
    manifests.some(({ manifestName }) => manifestName === "slack"),
    "slack should declare the newly enabled expand relations"
  );

  for (const { manifestName, manifest } of manifests) {
    const streamsByName = new Map(manifest.streams.map((stream: JsonObject) => [stream.name, stream]));
    for (const stream of manifest.streams) {
      const declared = stream.query?.expand || [];
      for (const capability of declared) {
        const relationship = (stream.relationships || []).find((entry: JsonObject) => entry.name === capability.name);
        assert.ok(
          relationship,
          `${manifestName}.${stream.name} expand '${capability.name}' must match a same-stream relationship`
        );
        const child = streamsByName.get(relationship.stream) as JsonObject | undefined;
        assert.ok(child, `${manifestName}.${stream.name} expand '${capability.name}' targets unknown stream`);
        assert.ok(
          Object.hasOwn(child.schema?.properties || {}, relationship.foreign_key),
          `${manifestName}.${stream.name} expand '${capability.name}' fk must be top-level on child`
        );
        assert.ok(
          (child.schema?.required || []).includes(relationship.foreign_key),
          `${manifestName}.${stream.name} expand '${capability.name}' fk should be required on child to avoid silent drops`
        );
        assert.ok(
          ["has_one", "has_many"].includes(relationship.cardinality),
          `${manifestName}.${stream.name} expand '${capability.name}' must declare has_one or has_many cardinality`
        );
        if (relationship.cardinality === "has_many") {
          assert.ok(
            Number.isInteger(capability.default_limit) && capability.default_limit > 0,
            `${manifestName}.${stream.name} expand '${capability.name}' has_many requires a positive default_limit`
          );
          assert.ok(
            Number.isInteger(capability.max_limit) && capability.max_limit >= capability.default_limit,
            `${manifestName}.${stream.name} expand '${capability.name}' has_many requires max_limit >= default_limit`
          );
        }
      }
    }
  }
});

// ─── GitHub user → user_stats first-party relationship ──────────────────────
//
// The GitHub manifest declares one safe parent-to-child join in this tranche:
// `user → user_stats` (has_many, foreign_key=user_id). `user_id` is a required
// top-level property of the `user_stats` child schema, so it satisfies the
// existing "fk must be required on child" rule (proven by the first-party
// manifest test above). See
//   openspec/changes/add-record-relationship-navigation/.

function readGithubManifest() {
  return JSON.parse(readFileSync(join(POLYFILL_MANIFESTS_DIR, "github.json"), "utf8"));
}

async function seedGithubStream(
  rsUrl: string,
  ownerToken: string,
  connectorId: string,
  stream: string,
  records: JsonObject[]
): Promise<void> {
  const lines = records
    .map((record: JsonObject) =>
      JSON.stringify({
        data: record,
        emitted_at: record.emitted_at || record.observed_on || record.updated_at || "2026-04-01T00:00:00Z",
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
  assert.equal(resp.status, 200, `ingest github ${stream} ok`);
}

// Two users, each with daily user_stats samples keyed by `{user_id}:{date}`.
// `user_stats.user_id` holds the parent user's record key (`id`), not the
// child's own key — the child key is `id` ("{user_id}:{YYYY-MM-DD}").
async function seedGithubExpansionFixture(rsUrl: string, ownerToken: string, connectorId: string): Promise<void> {
  await seedGithubStream(rsUrl, ownerToken, connectorId, "user", [
    { id: "101", login: "octocat", name: "The Octocat", updated_at: "2026-04-01T10:00:00Z" },
    { id: "202", login: "hubot", name: "Hubot", updated_at: "2026-04-02T10:00:00Z" },
  ]);
  await seedGithubStream(rsUrl, ownerToken, connectorId, "user_stats", [
    {
      followers: 10,
      following: 5,
      id: "101:2026-04-01",
      observed_on: "2026-04-01",
      public_gists: 1,
      public_repos: 3,
      user_id: "101",
    },
    {
      followers: 12,
      following: 5,
      id: "101:2026-04-02",
      observed_on: "2026-04-02",
      public_gists: 1,
      public_repos: 3,
      user_id: "101",
    },
    {
      followers: 14,
      following: 6,
      id: "101:2026-04-03",
      observed_on: "2026-04-03",
      public_gists: 1,
      public_repos: 4,
      user_id: "101",
    },
    {
      followers: 99,
      following: 0,
      id: "202:2026-04-02",
      observed_on: "2026-04-02",
      public_gists: 0,
      public_repos: 8,
      user_id: "202",
    },
  ]);
}

test("github manifest declares no relationship pointing at a commits stream", () => {
  const manifest = readGithubManifest();
  for (const stream of manifest.streams) {
    for (const relationship of stream.relationships || []) {
      assert.notEqual(
        relationship.stream,
        "commits",
        `github.${stream.name} must not declare a relationship pointing at commits`
      );
    }
  }
  // commits is not even a declared stream, so nothing can point at it.
  assert.ok(
    !manifest.streams.some((stream: JsonObject) => stream.name === "commits"),
    "github manifest must not declare a commits stream"
  );
});

test("github manifest declares no reverse expansion from user_stats/issues/pull_requests", () => {
  const manifest = readGithubManifest();
  const byName = new Map(manifest.streams.map((stream: JsonObject) => [stream.name, stream]));
  for (const childName of ["user_stats", "issues", "pull_requests"]) {
    const child = byName.get(childName) as JsonObject | undefined;
    assert.ok(child, `github manifest must declare ${childName}`);
    assert.deepEqual(
      (child.query?.expand || []).map((entry: JsonObject) => entry.name),
      [],
      `github.${childName} must not declare reverse query.expand entries`
    );
  }
});

// The first-party manifest gate (the "FK on child must be required" test above)
// is what keeps `repositories → issues` / `repositories → pull_requests`
// deferred: their foreign_key (`repository_id`) is present on the child schema
// but NOT in the child's `required[]`. The runtime registration validator only
// enforces that the FK is a top-level child property, so this requiredness rule
// is enforced at the manifest-test layer. This regression pins both halves:
// (a) the deferred shape would pass the runtime validator's top-level check, and
// (b) it fails the first-party manifest gate's requiredness predicate — which is
// exactly why declaring it now would break that gate.
test("repositories → issues shape fails the first-party manifest requiredness gate (deferral pin)", () => {
  const manifest = readGithubManifest();
  const issues = manifest.streams.find((stream: JsonObject) => stream.name === "issues");
  assert.ok(issues, "github manifest must declare issues");

  const childProperties = issues.schema?.properties || {};
  const childRequired = issues.schema?.required || [];

  // (a) `repository_id` is a top-level property — the runtime validator's
  // `hasOwnProperty` check would accept it.
  assert.ok(Object.hasOwn(childProperties, "repository_id"), "repository_id must be a top-level property on issues");
  // (b) but it is NOT required — the first-party manifest gate's
  // `required.includes(foreign_key)` predicate rejects it, which is the
  // concrete reason `repositories → issues` is deferred to a follow-up slice
  // that first makes the child key required (or adds a null-keyed-child policy).
  assert.ok(
    !childRequired.includes("repository_id"),
    "repository_id must remain non-required on issues until the deferred slice makes it required"
  );

  // And the manifest does NOT declare the deferred join today.
  const repositories = manifest.streams.find((stream: JsonObject) => stream.name === "repositories");
  assert.deepEqual(
    (repositories.query?.expand || []).map((entry: JsonObject) => entry.name),
    [],
    "repositories must not declare any query.expand entries in this change"
  );
});

test("github user expands user_stats filtered by user_id under a both-granted token", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl, "github_expand_owner");
    const githubManifest = readGithubManifest();
    const connectorId = githubManifest.connector_id;
    const reg = await registerConnectorManifest(asUrl, githubManifest);
    assert.equal(reg.status, 201, "register github manifest");
    await seedGithubExpansionFixture(rsUrl, ownerToken, connectorId);

    const approved = await approveGrant(asUrl, "github_expand_owner", {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.org/purpose/personalization",
      purpose_description: "Read GitHub profile with daily stats",
      streams: [
        { fields: ["id", "login", "name", "updated_at"], name: "user" },
        { fields: ["id", "user_id", "observed_on", "followers"], name: "user_stats" },
      ],
    });

    const list = await fetchJson(
      `${rsUrl}/v1/streams/user/records?connector_id=${encodeURIComponent(connectorId)}&order=asc&expand=user_stats`,
      { headers: { Authorization: `Bearer ${approved.token}` } }
    );
    assert.equal(list.status, 200);

    const octocat = list.body.data.find((record: JsonObject) => record.id === "101");
    assert.ok(octocat?.expanded?.user_stats, "octocat carries hydrated user_stats");
    assert.equal(octocat.expanded.user_stats.object, "list");
    // Every hydrated child carries user_id === the parent user's record key,
    // and its own record key is its `id` (NOT user_id).
    for (const child of octocat.expanded.user_stats.data) {
      assert.equal(child.data.user_id, "101", "child user_id equals parent user key");
      assert.notEqual(child.id, "101", "child record key is its own id, not the parent key");
      assert.equal(child.id, `101:${child.data.observed_on}`, "child id is the user_stats primary key");
    }

    // The other user's children are not mixed in.
    const hubot = list.body.data.find((record: JsonObject) => record.id === "202");
    assert.equal(hubot.expanded.user_stats.data.length, 1);
    assert.equal(hubot.expanded.user_stats.data[0].data.user_id, "202");
  });
});

test("github user_stats expand_limit caps the child fan-out and reports has_more", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl, "github_expand_limit_owner");
    const githubManifest = readGithubManifest();
    const connectorId = githubManifest.connector_id;
    const reg = await registerConnectorManifest(asUrl, githubManifest);
    assert.equal(reg.status, 201, "register github manifest");
    await seedGithubExpansionFixture(rsUrl, ownerToken, connectorId);

    const approved = await approveGrant(asUrl, "github_expand_limit_owner", {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.org/purpose/personalization",
      purpose_description: "Read GitHub profile with capped daily stats",
      streams: [
        { fields: ["id", "login"], name: "user" },
        { fields: ["id", "user_id", "observed_on"], name: "user_stats" },
      ],
    });

    const detail = await fetchJson(
      `${rsUrl}/v1/streams/user/records/101?connector_id=${encodeURIComponent(connectorId)}&expand=user_stats&expand_limit[user_stats]=2`,
      { headers: { Authorization: `Bearer ${approved.token}` } }
    );
    assert.equal(detail.status, 200);
    assert.equal(detail.body.expanded.user_stats.data.length, 2);
    assert.equal(detail.body.expanded.user_stats.has_more, true, "octocat has 3 stats rows, capped at 2");
  });
});

test("github user expansion rejects requests missing the user_stats grant", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl, "github_expand_reject_owner");
    const githubManifest = readGithubManifest();
    const connectorId = githubManifest.connector_id;
    const reg = await registerConnectorManifest(asUrl, githubManifest);
    assert.equal(reg.status, 201, "register github manifest");
    await seedGithubExpansionFixture(rsUrl, ownerToken, connectorId);

    // user-only grant: expanding the ungranted child fails with insufficient_scope.
    const userOnly = await approveGrant(asUrl, "github_expand_reject_owner", {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.org/purpose/personalization",
      purpose_description: "Read GitHub profile only",
      streams: [{ fields: ["id", "login"], name: "user" }],
    });

    const missingStats = await fetchJson(
      `${rsUrl}/v1/streams/user/records?connector_id=${encodeURIComponent(connectorId)}&expand=user_stats`,
      { headers: { Authorization: `Bearer ${userOnly.token}` } }
    );
    assert.equal(missingStats.status, 403);
    assert.equal(missingStats.body.error.code, "insufficient_scope");

    // Reverse expansion is not declared on the manifest. Grant user_stats so the
    // request reaches expand-validation (not the grant gate) and the rejection is
    // genuinely about the undeclared reverse relation, not a missing scope.
    const bothGranted = await approveGrant(asUrl, "github_expand_reject_owner", {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.org/purpose/personalization",
      purpose_description: "Read GitHub profile + stats",
      streams: [
        { fields: ["id", "login"], name: "user" },
        { fields: ["id", "user_id", "observed_on"], name: "user_stats" },
      ],
    });
    const reverse = await fetchJson(
      `${rsUrl}/v1/streams/user_stats/records?connector_id=${encodeURIComponent(connectorId)}&expand=user`,
      { headers: { Authorization: `Bearer ${bothGranted.token}` } }
    );
    assert.equal(reverse.status, 400);
    assert.equal(reverse.body.error.code, "invalid_expand");
  });
});

test("github repositories → issues expansion is not declared in this change", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl, "github_repo_issues_owner");
    const githubManifest = readGithubManifest();
    const connectorId = githubManifest.connector_id;
    const reg = await registerConnectorManifest(asUrl, githubManifest);
    assert.equal(reg.status, 201, "register github manifest");
    await seedGithubStream(rsUrl, ownerToken, connectorId, "repositories", [
      { full_name: "octocat/hello-world", id: "r1", updated_at: "2026-04-01T10:00:00Z" },
    ]);

    const approved = await approveGrant(asUrl, "github_repo_issues_owner", {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.org/purpose/personalization",
      purpose_description: "Read GitHub repositories only",
      streams: [{ fields: ["id", "full_name"], name: "repositories" }],
    });

    const resp = await fetchJson(
      `${rsUrl}/v1/streams/repositories/records?connector_id=${encodeURIComponent(connectorId)}&expand=issues`,
      { headers: { Authorization: `Bearer ${approved.token}` } }
    );
    assert.equal(resp.status, 400);
    assert.equal(resp.body.error.code, "invalid_expand");
  });
});

test("github user stream metadata surfaces the user_stats expand capability with target naming", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl, "github_metadata_owner");
    const githubManifest = readGithubManifest();
    const connectorId = githubManifest.connector_id;
    const reg = await registerConnectorManifest(asUrl, githubManifest);
    assert.equal(reg.status, 201, "register github manifest");
    await seedGithubExpansionFixture(rsUrl, ownerToken, connectorId);

    // Both streams granted → usable: true with full target naming.
    const both = await approveGrant(asUrl, "github_metadata_owner", {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.org/purpose/personalization",
      purpose_description: "Read GitHub profile + stats",
      streams: [
        { fields: ["id", "login"], name: "user" },
        { fields: ["id", "user_id", "observed_on"], name: "user_stats" },
      ],
    });
    const bothMeta = await fetchJson(`${rsUrl}/v1/streams/user?connector_id=${encodeURIComponent(connectorId)}`, {
      headers: { Authorization: `Bearer ${both.token}` },
    });
    assert.equal(bothMeta.status, 200);
    const usableEntry = bothMeta.body.expand_capabilities.find((entry: JsonObject) => entry.name === "user_stats");
    assert.ok(usableEntry, "user_stats expand capability is present");
    assert.equal(usableEntry.target_stream, "user_stats");
    assert.equal(usableEntry.child_parent_key_field, "user_id");
    assert.equal(usableEntry.foreign_key, "user_id");
    assert.equal(usableEntry.cardinality, "has_many");
    assert.equal(usableEntry.usable, true);
    assert.equal(usableEntry.granted, true);

    // user-only grant → entry still present, inert, with the not-granted reason.
    const userOnly = await approveGrant(asUrl, "github_metadata_owner", {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.org/purpose/personalization",
      purpose_description: "Read GitHub profile only",
      streams: [{ fields: ["id", "login"], name: "user" }],
    });
    const userOnlyMeta = await fetchJson(`${rsUrl}/v1/streams/user?connector_id=${encodeURIComponent(connectorId)}`, {
      headers: { Authorization: `Bearer ${userOnly.token}` },
    });
    assert.equal(userOnlyMeta.status, 200);
    const inertEntry = userOnlyMeta.body.expand_capabilities.find((entry: JsonObject) => entry.name === "user_stats");
    assert.ok(inertEntry, "declared relation stays visible even when not readable");
    assert.equal(inertEntry.target_stream, "user_stats");
    assert.equal(inertEntry.child_parent_key_field, "user_id");
    assert.equal(inertEntry.usable, false);
    assert.equal(inertEntry.granted, false);
    assert.equal(inertEntry.reason, "related_stream_not_granted");
  });
});

test("slack messages expand message_attachments and reactions on list and detail reads", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl, "slack_expand_owner");
    const slackManifest = readSlackManifest();
    const connectorId = slackManifest.connector_id;
    const reg = await registerConnectorManifest(asUrl, slackManifest);
    assert.equal(reg.status, 201, "register slack manifest");
    await seedSlackExpansionFixture(rsUrl, ownerToken, connectorId);

    const metadata = await fetchJson(`${rsUrl}/v1/streams/messages?connector_id=${encodeURIComponent(connectorId)}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(metadata.status, 200);
    assert.deepEqual(metadata.body.query.expand.map((entry: JsonObject) => entry.name).sort(), [
      "message_attachments",
      "reactions",
    ]);

    const approved = await approveGrant(asUrl, "slack_expand_owner", {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.org/purpose/personalization",
      purpose_description: "Read Slack messages with link previews and reactions",
      streams: [
        { fields: ["id", "channel_id", "sent_at", "text"], name: "messages" },
        { fields: ["id", "message_id", "service_name", "title"], name: "message_attachments" },
        { fields: ["id", "message_id", "emoji", "user_id"], name: "reactions" },
      ],
    });

    const list = await fetchJson(
      `${rsUrl}/v1/streams/messages/records?connector_id=${encodeURIComponent(connectorId)}&order=asc&expand=message_attachments&expand=reactions`,
      { headers: { Authorization: `Bearer ${approved.token}` } }
    );
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 2);

    const messageWithChildren = list.body.data.find((record: JsonObject) => record.id === "C1:1700000001.000100");
    assert.ok(messageWithChildren?.expanded?.message_attachments);
    assert.equal(messageWithChildren.expanded.message_attachments.object, "list");
    assert.equal(messageWithChildren.expanded.message_attachments.has_more, false);
    assert.deepEqual(
      messageWithChildren.expanded.message_attachments.data.map((entry: JsonObject) => entry.id).sort(),
      ["C1:1700000001.000100:0", "C1:1700000001.000100:1", "C1:1700000001.000100:2"]
    );
    assert.deepEqual(Object.keys(messageWithChildren.expanded.message_attachments.data[0].data || {}).sort(), [
      "channel_id",
      "id",
      "index",
      "message_id",
      "service_name",
      "title",
    ]);

    assert.ok(messageWithChildren.expanded.reactions);
    assert.equal(messageWithChildren.expanded.reactions.object, "list");
    assert.equal(messageWithChildren.expanded.reactions.data.length, 3);
    assert.deepEqual(Object.keys(messageWithChildren.expanded.reactions.data[0].data || {}).sort(), [
      "channel_id",
      "emoji",
      "id",
      "message_id",
      "user_id",
    ]);

    const messageWithoutChildren = list.body.data.find((record: JsonObject) => record.id === "C1:1700000002.000200");
    assert.deepEqual(messageWithoutChildren.expanded.message_attachments.data, []);
    assert.deepEqual(messageWithoutChildren.expanded.reactions.data, []);

    const detail = await fetchJson(
      `${rsUrl}/v1/streams/messages/records/${encodeURIComponent("C1:1700000001.000100")}?connector_id=${encodeURIComponent(connectorId)}&expand=message_attachments`,
      { headers: { Authorization: `Bearer ${approved.token}` } }
    );
    assert.equal(detail.status, 200);
    assert.equal(detail.body.expanded.message_attachments.data.length, 3);
  });
});

test("slack messages expand_limit caps message_attachments and reactions independently", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl, "slack_expand_limit_owner");
    const slackManifest = readSlackManifest();
    const connectorId = slackManifest.connector_id;
    const reg = await registerConnectorManifest(asUrl, slackManifest);
    assert.equal(reg.status, 201, "register slack manifest");
    await seedSlackExpansionFixture(rsUrl, ownerToken, connectorId);

    const approved = await approveGrant(asUrl, "slack_expand_limit_owner", {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.org/purpose/personalization",
      purpose_description: "Read Slack messages with capped child fan-out",
      streams: [
        { fields: ["id", "channel_id", "sent_at"], name: "messages" },
        { fields: ["id", "message_id", "title"], name: "message_attachments" },
        { fields: ["id", "message_id", "emoji"], name: "reactions" },
      ],
    });

    const { status, body } = await fetchJson(
      `${rsUrl}/v1/streams/messages/records?connector_id=${encodeURIComponent(connectorId)}&order=asc&expand=message_attachments&expand=reactions&expand_limit[message_attachments]=2&expand_limit[reactions]=1`,
      { headers: { Authorization: `Bearer ${approved.token}` } }
    );
    assert.equal(status, 200);
    const message = body.data.find((record: JsonObject) => record.id === "C1:1700000001.000100");
    assert.equal(message.expanded.message_attachments.has_more, true);
    assert.equal(message.expanded.message_attachments.data.length, 2);
    assert.equal(message.expanded.reactions.has_more, true);
    assert.equal(message.expanded.reactions.data.length, 1);

    const overMax = await fetchJson(
      `${rsUrl}/v1/streams/messages/records?connector_id=${encodeURIComponent(connectorId)}&expand=reactions&expand_limit[reactions]=999`,
      { headers: { Authorization: `Bearer ${approved.token}` } }
    );
    assert.equal(overMax.status, 400);
    assert.equal(overMax.body.error.code, "invalid_expand");
  });
});

test("slack message expansion rejects requests missing the child grant", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl, "slack_expand_reject_owner");
    const slackManifest = readSlackManifest();
    const connectorId = slackManifest.connector_id;
    const reg = await registerConnectorManifest(asUrl, slackManifest);
    assert.equal(reg.status, 201, "register slack manifest");
    await seedSlackExpansionFixture(rsUrl, ownerToken, connectorId);

    const approved = await approveGrant(asUrl, "slack_expand_reject_owner", {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.org/purpose/personalization",
      purpose_description: "Read Slack messages only",
      streams: [{ fields: ["id", "channel_id", "sent_at"], name: "messages" }],
    });

    const missingAttachments = await fetchJson(
      `${rsUrl}/v1/streams/messages/records?connector_id=${encodeURIComponent(connectorId)}&expand=message_attachments`,
      { headers: { Authorization: `Bearer ${approved.token}` } }
    );
    assert.equal(missingAttachments.status, 403);
    assert.equal(missingAttachments.body.error.code, "insufficient_scope");

    const reverseChannel = await fetchJson(
      `${rsUrl}/v1/streams/messages/records?connector_id=${encodeURIComponent(connectorId)}&expand=channel`,
      { headers: { Authorization: `Bearer ${approved.token}` } }
    );
    assert.equal(reverseChannel.status, 400);
    assert.equal(reverseChannel.body.error.code, "invalid_expand");
  });
});

test("connector manifest validation rejects unsafe query.expand declarations", async () => {
  await withHarness(async ({ asUrl, spotifyManifest }) => {
    const missingRelationship = cloneJson(spotifyManifest);
    // Give each case a unique canonical connector_key (not a URL#suffix) so the
    // manifest is uniquely identified AND passes connector-key validation,
    // letting the intended query.expand validation run. See canonicalize-connector-keys.
    setUniqueConnectorKey(missingRelationship, "spotify-missing-expand-relation");
    missingRelationship.streams.find((stream: JsonObject) => stream.name === "saved_tracks").query.expand = [
      { default_limit: 1, max_limit: 2, name: "missing_relation" },
    ];

    const missingRelationshipResp = await registerConnectorManifest(asUrl, missingRelationship);
    assert.equal(missingRelationshipResp.status, 400);
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(missingRelationshipResp.body.error.message, /query\.expand entry 'missing_relation' must match/);

    const missingForeignKey = cloneJson(spotifyManifest);
    setUniqueConnectorKey(missingForeignKey, "spotify-missing-child-foreign-key");
    missingForeignKey.streams.find(
      (stream: JsonObject) => stream.name === "saved_tracks"
    ).relationships[0].foreign_key = "missing_track_id";

    const missingForeignKeyResp = await registerConnectorManifest(asUrl, missingForeignKey);
    assert.equal(missingForeignKeyResp.status, 400);
    assert.match(
      missingForeignKeyResp.body.error.message,
      // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
      /foreign_key 'missing_track_id' must be a top-level property/
    );

    const invalidLimits = cloneJson(spotifyManifest);
    setUniqueConnectorKey(invalidLimits, "spotify-invalid-expand-limit");
    invalidLimits.streams.find((stream: JsonObject) => stream.name === "saved_tracks").query.expand[0].default_limit =
      5;
    invalidLimits.streams.find((stream: JsonObject) => stream.name === "saved_tracks").query.expand[0].max_limit = 2;

    const invalidLimitsResp = await registerConnectorManifest(asUrl, invalidLimits);
    assert.equal(invalidLimitsResp.status, 400);
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(invalidLimitsResp.body.error.message, /default_limit must be less than or equal to max_limit/);
  });
});

test("connector manifest validation accepts gmail attachment blob_ref and rejects malformed declarations", async () => {
  await withHarness(async ({ asUrl }) => {
    const gmailManifest = readGmailManifest();
    setUniqueConnectorKey(gmailManifest, "gmail-blob-ref-valid");
    const valid = await registerConnectorManifest(asUrl, gmailManifest);
    assert.equal(valid.status, 201);

    const missingBlobId = cloneJson(gmailManifest);
    setUniqueConnectorKey(missingBlobId, "gmail-missing-blob-id");
    const attachmentStream = missingBlobId.streams.find((stream: JsonObject) => stream.name === "attachments");
    attachmentStream.schema.properties.blob_ref.properties.blob_id = undefined;

    const missingBlobIdResp = await registerConnectorManifest(asUrl, missingBlobId);
    assert.equal(missingBlobIdResp.status, 400);
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(missingBlobIdResp.body.error.message, /blob_ref\.blob_id must be type string/);

    const notObject = cloneJson(gmailManifest);
    setUniqueConnectorKey(notObject, "gmail-blob-ref-not-object");
    const notObjectAttachmentStream = notObject.streams.find((stream: JsonObject) => stream.name === "attachments");
    notObjectAttachmentStream.schema.properties.blob_ref = { type: "string" };

    const notObjectResp = await registerConnectorManifest(asUrl, notObject);
    assert.equal(notObjectResp.status, 400);
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    assert.match(notObjectResp.body.error.message, /blob_ref must be an object or nullable object/);
  });
});

test("blob upload requires owner authority and validates binding inputs", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl, "blob_upload_validation_owner");
    const connectorId = spotifyManifest.connector_id;
    const grant = await approveGrant(asUrl, "blob_upload_validation_owner", {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.org/purpose/personalization",
      purpose_description: "Read saved tracks only",
      streams: [{ fields: ["id", "name", "saved_at"], name: "saved_tracks" }],
    });

    const clientUpload = await uploadBlob(
      rsUrl,
      grant.token,
      { connector_id: connectorId, record_key: "track_blob_upload", stream: "saved_tracks" },
      Buffer.from("client cannot upload"),
      "text/plain"
    );
    assert.equal(clientUpload.status, 403);
    assert.equal(clientUpload.body.error.code, "permission_error");

    const missingConnector = await fetchJson(`${rsUrl}/v1/blobs?stream=saved_tracks&record_key=track_blob_upload`, {
      body: "missing connector",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "text/plain",
      },
      method: "POST",
    });
    assert.equal(missingConnector.status, 400);
    assert.equal(missingConnector.body.error.code, "invalid_request");

    const unknownStream = await uploadBlob(
      rsUrl,
      ownerToken,
      { connector_id: connectorId, record_key: "track_blob_upload", stream: "missing_stream" },
      Buffer.from("unknown stream"),
      "text/plain"
    );
    assert.equal(unknownStream.status, 404);
    assert.equal(unknownStream.body.error.code, "not_found");
  });
});

test("blob upload is content-addressed, idempotent, and fetch-safe through visible blob_ref", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl, "blob_upload_owner");
    const connectorId = spotifyManifest.connector_id;
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x0a, 0xff]);
    const expectedSha = createHash("sha256").update(bytes).digest("hex");

    const first = await uploadBlob(
      rsUrl,
      ownerToken,
      { connector_id: connectorId, record_key: "track_blob_upload", stream: "saved_tracks" },
      bytes,
      "application/pdf"
    );
    assert.equal(first.status, 200);
    assert.equal(first.body.object, "blob");
    assert.equal(first.body.sha256, expectedSha);
    assert.equal(first.body.blob_id, `blob_sha256_${expectedSha}`);
    assert.equal(first.body.size_bytes, bytes.length);
    assert.equal(first.body.mime_type, "application/pdf");

    const duplicate = await uploadBlob(
      rsUrl,
      ownerToken,
      { connector_id: connectorId, record_key: "track_blob_upload", stream: "saved_tracks" },
      bytes,
      "application/pdf"
    );
    assert.equal(duplicate.status, 200);
    assert.deepEqual(duplicate.body, first.body);

    const secondBinding = await uploadBlob(
      rsUrl,
      ownerToken,
      { connector_id: connectorId, record_key: "track_blob_upload_copy", stream: "saved_tracks" },
      bytes,
      "application/pdf"
    );
    assert.equal(secondBinding.status, 200);
    assert.equal(secondBinding.body.blob_id, first.body.blob_id);

    const blobCount = getDb()
      .prepare("SELECT COUNT(*) AS n FROM blobs WHERE sha256 = ?")
      .get<{ n: number }>(expectedSha);
    assert.ok(blobCount, "blob count query returns a row");
    assert.equal(blobCount.n, 1, "duplicate uploads should not duplicate stored bytes");
    const bindingCount = getDb()
      .prepare("SELECT COUNT(*) AS n FROM blob_bindings WHERE blob_id = ?")
      .get<{ n: number }>(first.body.blob_id);
    assert.ok(bindingCount, "blob binding count query returns a row");
    assert.equal(bindingCount.n, 2, "same content can be bound idempotently to multiple records");

    await seedSpotifyStream(rsUrl, ownerToken, connectorId, "saved_tracks", [
      {
        blob_ref: {
          blob_id: first.body.blob_id,
          mime_type: first.body.mime_type,
          sha256: first.body.sha256,
          size_bytes: first.body.size_bytes,
        },
        id: "track_blob_upload",
        name: "Track Blob Upload",
        saved_at: "2026-02-01T00:00:00Z",
        source_created_at: "2026-02-01T00:00:00Z",
      },
    ]);

    const visibleGrant = await approveGrant(asUrl, "blob_upload_owner", {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.org/purpose/personalization",
      purpose_description: "Read saved tracks with uploaded blob access",
      streams: [{ fields: ["id", "name", "saved_at", "blob_ref"], name: "saved_tracks" }],
    });

    const recordResp = await fetchJson(`${rsUrl}/v1/streams/saved_tracks/records`, {
      headers: { Authorization: `Bearer ${visibleGrant.token}` },
    });
    assert.equal(recordResp.status, 200);
    assert.equal(recordResp.body.data?.[0]?.data?.blob_ref?.fetch_url, `/v1/blobs/${first.body.blob_id}`);

    const blobResp = await fetch(`${rsUrl}/v1/blobs/${first.body.blob_id}`, {
      headers: { Authorization: `Bearer ${visibleGrant.token}` },
    });
    assert.equal(blobResp.status, 200);
    assert.equal(blobResp.headers.get("content-type"), "application/pdf");
    assert.equal(blobResp.headers.get("content-length"), String(bytes.length));
    assert.deepEqual(Buffer.from(await blobResp.arrayBuffer()), bytes);
  });
});

test("blob fetch injects fetch_url and requires blob_ref visibility under the grant", async () => {
  await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
    const ownerToken = await issueOwnerToken(asUrl, "blob_owner");
    const connectorId = spotifyManifest.connector_id;
    await seedSpotifyStream(rsUrl, ownerToken, connectorId, "saved_tracks", [
      {
        blob_ref: {
          blob_id: "blob_track_art",
          mime_type: "text/plain",
          sha256: "sha256_blob_track_art",
          size_bytes: 11,
        },
        id: "track_blob",
        name: "Track Blob",
        saved_at: "2026-02-01T00:00:00Z",
        source_created_at: "2026-02-01T00:00:00Z",
      },
    ]);
    // Records and blobs are stored under the canonical connector key (the
    // ingest path canonicalizes the URL-shaped manifest connector_id). Seed
    // this raw-SQL blob row — and resolve its connector_instance_id subquery —
    // under that same canonical key, or the records subquery returns no row
    // and connector_instance_id is NULL. See canonicalize-connector-keys
    // Decision 1: blob bindings key by connector_key.
    const canonicalId = canonicalConnectorKey(connectorId) ?? connectorId;
    getDb()
      .prepare(`
      INSERT INTO blobs(blob_id, connector_id, connector_instance_id, stream, record_key, mime_type, size_bytes, sha256, data)
      VALUES(?, ?, (SELECT connector_instance_id FROM records WHERE connector_id = ? AND stream = ? AND record_key = ?), ?, ?, ?, ?, ?, ?)
    `)
      .run(
        "blob_track_art",
        canonicalId,
        canonicalId,
        "saved_tracks",
        "track_blob",
        "saved_tracks",
        "track_blob",
        "text/plain",
        11,
        "sha256_blob_track_art",
        Buffer.from("hello world")
      );

    const visibleGrant = await approveGrant(asUrl, "blob_owner", {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.org/purpose/personalization",
      purpose_description: "Read saved tracks with blob access",
      streams: [{ fields: ["id", "name", "saved_at", "blob_ref"], name: "saved_tracks" }],
    });

    const recordResp = await fetchJson(`${rsUrl}/v1/streams/saved_tracks/records`, {
      headers: { Authorization: `Bearer ${visibleGrant.token}` },
    });
    assert.equal(recordResp.status, 200);
    const blobRef = recordResp.body.data?.[0]?.data?.blob_ref;
    assert.ok(blobRef?.fetch_url, "blob_ref should gain a fetch_url at read time");
    assert.equal(blobRef.fetch_url, "/v1/blobs/blob_track_art");

    const blobResp = await fetch(`${rsUrl}/v1/blobs/blob_track_art`, {
      headers: { Authorization: `Bearer ${visibleGrant.token}` },
    });
    assert.equal(blobResp.status, 200);
    assert.equal(blobResp.headers.get("content-type"), "text/plain");
    assert.equal(await blobResp.text(), "hello world");

    const hiddenGrant = await approveGrant(asUrl, "blob_owner", {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.org/purpose/personalization",
      purpose_description: "Read saved tracks without blob access",
      streams: [{ fields: ["id", "name", "saved_at"], name: "saved_tracks" }],
    });

    const hiddenBlobResp = await fetchJson(`${rsUrl}/v1/blobs/blob_track_art`, {
      headers: { Authorization: `Bearer ${hiddenGrant.token}` },
    });
    assert.equal(hiddenBlobResp.status, 404);
    assert.equal(hiddenBlobResp.body.error.code, "blob_not_found");
  });
});
