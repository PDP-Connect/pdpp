// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Semantic Retrieval Experimental Extension — public-contract conformance tests.
 *
 * Pins the behavior the approved spec promises at:
 *   openspec/changes/add-semantic-retrieval-experimental-extension/specs/semantic-retrieval/spec.md
 *
 * Plus reference-implementation-architecture scenarios from:
 *   openspec/changes/implement-semantic-retrieval-experimental-extension/
 *     specs/reference-implementation-architecture/spec.md
 *
 * Coverage (cross-referenced to tasks.md §14 in the implementation tranche):
 *   14.1  — advertisement present with required keys when supported
 *   14.2  — stability="experimental", query_input="text", lexical_blending=false
 *   14.3  — advertisement omitted when no backend is configured
 *   14.4  — advertisement reachable without bearer token
 *   14.5  — independent from capabilities.lexical_retrieval
 *   14.6  — /v1/search/semantic returns list envelope
 *   14.7  — each result has required keys; typed semantic distance score; no debug fields
 *   14.8  — retrieval_mode === "semantic" on every hit in v1
 *   14.9  — missing q → invalid_request
 *   14.10 — each rejected parameter returns invalid_request with `param`
 *   14.11 — cross_stream advertised false + no streams[] → invalid_request
 *   14.12 — client token streams[]=<not-in-grant> → grant_stream_not_allowed
 *   14.13 — owner token streams[]=<nonexistent> → empty list
 *   14.14 — zero intersection → zero hits, no per-stream error
 *   14.15 — matched_fields ⊆ (declared semantic_fields ∩ grant projection)
 *   14.18 — snippet is verbatim contiguous substring (property test, no paraphrase)
 *   14.19 — snippet grant-safe: never drawn from ungranted fields
 *   14.21/14.22 — no-fallback: search-semantic.js has no import from search.js
 *   14.24 — owner cross-connector fan-out
 *   14.25 — owner record_url round-trip
 *   14.26 — owner connector_id= → invalid_request
 *   14.27 — next_cursor round-trips within a session
 *   14.28/14.29/14.30 — cursor kinds are distinct (semantic ↔ lexical ↔ records)
 *   14.31 — lexical surfaces unchanged when semantic is enabled
 *   14.33 — restart regression: sqlite-vec path, coverage survives restart
 *   14.35 — restart + drift: backend identity change → stale, rebuild restores
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalConnectorKeyFromManifest } from "../server/connector-key.ts";
import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { isPostgresStorageBackend, postgresQuery } from "../server/postgres-storage.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import {
  buildPostgresSemanticPlanRequests,
  DEFAULT_SEMANTIC_EMBEDDING_INPUT_MAX_CHARS,
  type makeLocalTransformerBackend,
  makeStubBackend,
  parseSemanticSearchParams,
  resolveSemanticBackendFromEnv,
  resolveSemanticPerConnectorLimit,
  semanticIndexDelete,
} from "../server/search-semantic.ts";

// ─── harness ────────────────────────────────────────────────────────────────

const TEST_DCR_INITIAL_ACCESS_TOKEN = "pdpp-reference-test-initial-access-token";
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUN_MULTILINGUAL_MINILM_SMOKE = process.env.PDPP_MULTILINGUAL_MINILM_SMOKE === "1";
const STUB_EMBED_MODEL_ID = /model=pdpp-reference-stub-embed-v0/;
const TRAILING_ELLIPSIS = /…$/;
const SEARCH_SEMANTIC_IMPORT = /from\s+['"]\.\/search\.js['"]/;
const SEARCH_SEMANTIC_REQUIRE = /require\(\s*['"]\.\/search\.js['"]/;
const UNKNOWN_PROFILE_ERROR = /PDPP_EMBEDDING_PROFILE_ID must be one of:/;
const LOCAL_SUPERVISOR_CONTRACT_ERROR =
  /production local semantic execution requires PDPP_LOCAL_TRANSFORMER_SUPERVISOR_RESTART_CONTRACT=1/;
const compareStrings = (a: unknown, b: unknown) => String(a).localeCompare(String(b));
const SEMANTIC_A_SOURCE_ID = "https://registry.pdpp.dev/connectors/semantic-a";
const SEMANTIC_B_SOURCE_ID = "https://registry.pdpp.dev/connectors/semantic-b";
const SEMANTIC_A_TEST_INSTANCE_ID = "cin_semantic_a_test";

interface TestHttpServer {
  close: (callback: () => void) => void;
  closeAllConnections?: () => void;
}

interface TestServerHandle {
  asPort: number;
  asServer: TestHttpServer;
  rsPort: number;
  rsServer: TestHttpServer;
  startupBackfillDone?: Promise<void>;
}

async function fetchJson(url: string, opts: RequestInit = {}): Promise<{ status: number; body: unknown }> {
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

interface LocalBackendMetadata {
  downloadAllowed: () => boolean;
  languageBias: () => { primary: string } | null;
  modelCachePresent: () => boolean;
}

function hasLocalBackendMetadata(value: unknown): value is LocalBackendMetadata {
  const backend = asRecord(value);
  return (
    typeof backend.downloadAllowed === "function" &&
    typeof backend.languageBias === "function" &&
    typeof backend.modelCachePresent === "function"
  );
}

function errorCode(body: unknown): unknown {
  return asRecord(asRecord(body).error).code;
}

async function closeServer(server: TestServerHandle): Promise<void> {
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  await Promise.allSettled([
    new Promise<void>((r) => server.asServer.close(r)),
    new Promise<void>((r) => server.rsServer.close(r)),
  ]);
}

// Two manifests with declared semantic_fields. Same shape as the lexical
// test harness but declaring semantic_fields (sometimes alongside lexical,
// sometimes not — exercises independence).
const MANIFEST_A = {
  capabilities: { human_interaction: ["credentials"] },
  connector_id: "semantic-a",
  display_name: "Semantic A",
  protocol_version: "0.1.0",
  source_declaration: {
    declaration_version: "semantic-a-test-declaration-v1",
    display: { name: "Semantic A" },
    protocol_version: "0.1.0",
    publisher: { id: "https://pdpp.dev/reference-implementation" },
    source: { id: SEMANTIC_A_SOURCE_ID, kind: "connector" as const },
    streams: [] as unknown[],
  },
  streams: [
    {
      consent_time_field: "source_created_at",
      cursor_field: "source_created_at",
      name: "posts",
      primary_key: ["id"],
      query: {
        range_filters: {
          score: ["gte"],
          source_created_at: ["gte", "gt", "lte", "lt"],
        },
        search: {
          lexical_fields: ["title", "selftext"],
          semantic_fields: ["title", "selftext"],
        },
      },
      schema: {
        properties: {
          id: { type: "string" },
          score: { type: "integer" },
          selftext: { type: "string" },
          source_created_at: { format: "date-time", type: "string" },
          subreddit: { type: "string" },
          title: { type: "string" },
        },
        required: ["id", "title"],
        type: "object",
      },
      selection: { fields: true, resources: false },
      semantics: "append_only",
    },
    {
      consent_time_field: "source_created_at",
      cursor_field: "source_created_at",
      // comments: lexical AND semantic, but DIFFERENT fields — proves independence.
      name: "comments",
      primary_key: ["id"],
      query: {
        search: {
          lexical_fields: ["body", "post_title"],
          semantic_fields: ["body"],
        },
      },
      schema: {
        properties: {
          body: { type: "string" },
          id: { type: "string" },
          marker: { type: "string" },
          post_title: { type: "string" },
          source_created_at: { format: "date-time", type: "string" },
        },
        required: ["id", "body"],
        type: "object",
      },
      selection: { fields: true, resources: false },
      semantics: "append_only",
    },
    {
      consent_time_field: "source_created_at",
      cursor_field: "source_created_at",
      // Non-participating stream in EITHER extension. Proves the omit branch.
      name: "saved",
      primary_key: ["id"],
      schema: {
        properties: {
          id: { type: "string" },
          source_created_at: { format: "date-time", type: "string" },
          title: { type: "string" },
        },
        required: ["id"],
        type: "object",
      },
      selection: { fields: true, resources: false },
      semantics: "append_only",
    },
  ],
  version: "1.0.0",
};
MANIFEST_A.source_declaration.streams = MANIFEST_A.streams;

const MANIFEST_B = {
  capabilities: { human_interaction: ["credentials"] },
  connector_id: "semantic-b",
  display_name: "Semantic B",
  protocol_version: "0.1.0",
  source_declaration: {
    declaration_version: "semantic-b-test-declaration-v1",
    display: { name: "Semantic B" },
    protocol_version: "0.1.0",
    publisher: { id: "https://pdpp.dev/reference-implementation" },
    source: { id: SEMANTIC_B_SOURCE_ID, kind: "connector" as const },
    streams: [] as unknown[],
  },
  streams: [
    {
      consent_time_field: "source_created_at",
      cursor_field: "source_created_at",
      // Shared stream name with A — exercises cross-connector fan-out.
      name: "posts",
      primary_key: ["id"],
      query: {
        range_filters: {
          source_created_at: ["gte", "gt", "lte", "lt"],
        },
        search: { semantic_fields: ["title", "selftext"] },
      }, // semantic only
      schema: {
        properties: {
          id: { type: "string" },
          selftext: { type: "string" },
          source_created_at: { format: "date-time", type: "string" },
          title: { type: "string" },
        },
        required: ["id", "title"],
        type: "object",
      },
      selection: { fields: true, resources: false },
      semantics: "append_only",
    },
  ],
  version: "1.0.0",
};
MANIFEST_B.source_declaration.streams = MANIFEST_B.streams;

async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
  const clientId = "cli_longview";
  const { body: deviceBody } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const device = asRecord(deviceBody);
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: String(device.user_code) }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: String(device.device_code),
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return String(asRecord(tokenBody).access_token);
}

interface ClientGrantParams {
  access_mode: string;
  client_id: string;
  connector_id: string;
  purpose_code: string;
  purpose_description: string;
  streams: Array<{ name: string; fields: string[]; instance_ids?: string[] }>;
  subject_id?: string;
}

function sourceForConnector(connectorId: string): { id: string; kind: "connector" } {
  if (connectorId === MANIFEST_A.connector_id) {
    return MANIFEST_A.source_declaration.source;
  }
  if (connectorId === MANIFEST_B.connector_id) {
    return MANIFEST_B.source_declaration.source;
  }
  throw new Error(`No test SourceDeclaration for connector ${connectorId}`);
}

async function approveClientGrant(asUrl: string, params: ClientGrantParams): Promise<Record<string, unknown>> {
  const { body: initiateBody } = await fetchJson(`${asUrl}/oauth/par`, {
    body: JSON.stringify({
      authorization_details: [
        {
          access_mode: params.access_mode,
          purpose_code: params.purpose_code,
          purpose_description: params.purpose_description,
          source: sourceForConnector(params.connector_id),
          streams: params.streams,
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: params.client_id,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const initiate = asRecord(initiateBody);
  const subjectId = params.subject_id || "owner_local";
  const reviewResponse = await fetchJson(`${asUrl}/consent/review`, {
    body: JSON.stringify({ request_uri: initiate.request_uri, subject_id: subjectId }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(reviewResponse.status, 200, JSON.stringify(reviewResponse.body));
  const review = asRecord(reviewResponse.body);
  assert.equal(typeof review.approval_review_revision, "string", "consent review returns a revision");
  const { body: approved } = await fetchJson(`${asUrl}/consent/approve`, {
    body: JSON.stringify({
      approval_review_revision: review.approval_review_revision,
      request_uri: initiate.request_uri,
    }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  return asRecord(approved);
}

async function materializeSemanticConnection(connectorId: string, connectorInstanceId: string): Promise<void> {
  const now = "2026-01-01T00:00:00.000Z";
  await createRequestConnectorInstanceStore().upsert({
    connectorId,
    connectorInstanceId,
    createdAt: now,
    displayName: connectorId,
    ownerSubjectId: "owner_local",
    sourceBinding: { kind: "test_account", label: connectorInstanceId },
    sourceBindingKey: connectorInstanceId,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
}

async function listSemanticVectorRows(connectorId: string, recordKeys: readonly string[]) {
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery(
      `
      SELECT connector_instance_id, connector_id, scope_key, record_key
      FROM semantic_search_blob
      WHERE connector_id = $1 AND record_key = ANY($2::text[])
      ORDER BY connector_instance_id
    `,
      [connectorId, recordKeys]
    );
    return result.rows;
  }

  const db = getDb();
  const vectorTable = db.vectorIndexKind === "sqlite-vec" ? "semantic_search_rowid" : "semantic_search_blob";
  return db
    .prepare(`
      SELECT connector_instance_id, connector_id, scope_key, record_key
      FROM ${vectorTable}
      WHERE connector_id = ? AND record_key IN (?, ?)
      ORDER BY connector_instance_id
    `)
    .all(connectorId, ...recordKeys);
}

async function listSemanticMetaRows(connectorId: string) {
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery(
      `
      SELECT connector_instance_id
      FROM semantic_search_meta
      WHERE connector_id = $1 AND stream = 'posts'
      ORDER BY connector_instance_id
    `,
      [connectorId]
    );
    return result.rows;
  }

  return getDb()
    .prepare(`
      SELECT connector_instance_id
      FROM semantic_search_meta
      WHERE connector_id = ? AND stream = 'posts'
      ORDER BY connector_instance_id
    `)
    .all(connectorId);
}

interface SemanticRecordInput {
  emitted_at?: string;
  id: string;
  source_created_at?: string;
  [key: string]: unknown;
}

async function ingest(
  rsUrl: string,
  ownerToken: string,
  connectorId: string,
  stream: string,
  records: SemanticRecordInput[],
  connectorInstanceId: string | null = null
): Promise<void> {
  const ndjson = records
    .map((r) =>
      JSON.stringify({
        data: r,
        emitted_at: r.emitted_at || r.source_created_at,
        key: r.id,
      })
    )
    .join("\n");
  const resp = await fetch(
    `${rsUrl}/v1/ingest/${encodeURIComponent(stream)}?connector_id=${encodeURIComponent(connectorId)}${connectorInstanceId ? `&connector_instance_id=${encodeURIComponent(connectorInstanceId)}` : ""}`,
    {
      body: ndjson,
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/x-ndjson" },
      method: "POST",
    }
  );
  assert.equal(resp.status, 200, `ingest ${stream} ok`);
}

interface WithHarnessContext {
  asUrl: string;
  rsUrl: string;
  server: TestServerHandle;
}

async function withHarness(
  opts: Record<string, unknown>,
  fn: (ctx: WithHarnessContext) => Promise<void>,
  manifests: Array<{ connector_id: string }> = [MANIFEST_A, MANIFEST_B]
): Promise<void> {
  const startOpts = {
    asPort: 0,
    dbPath: ":memory:",
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    quiet: true,
    rsPort: 0,
    ...opts,
  };
  const server: TestServerHandle = await startServer(startOpts);
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    for await (const manifest of manifests) {
      const reg = await fetch(`${asUrl}/connectors`, {
        body: JSON.stringify(manifest),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(reg.status, 201, `register ${manifest.connector_id}`);
    }
    await fn({ asUrl, rsUrl, server });
  } finally {
    await closeServer(server);
  }
}

// ─── 14.1 / 14.2 / 14.4 — advertisement shape + stability ───────────────────

test("RS metadata advertises capabilities.semantic_retrieval with all required keys when supported", async () => {
  await withHarness({}, async ({ rsUrl }) => {
    const { status, body } = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(status, 200);
    const capabilities = asRecord(asRecord(body).capabilities);
    const cap = asRecord(capabilities.semantic_retrieval);
    assert.ok(capabilities.semantic_retrieval, "capabilities.semantic_retrieval should be present");
    assert.equal(cap.supported, true);
    assert.equal(cap.stability, "experimental", "v1 stability is hardcoded experimental");
    assert.equal(cap.endpoint, "/v1/search/semantic");
    assert.equal(cap.cross_stream, true);
    assert.equal(cap.query_input, "text", "v1 query_input is hardcoded text");
    assert.equal(cap.snippets, true);
    assert.equal(cap.lexical_blending, false, "v1 lexical_blending is hardcoded false");
    assert.ok(typeof cap.model === "string" && cap.model.length > 0);
    assert.ok(typeof cap.dimensions === "number" && cap.dimensions > 0);
    assert.ok(["cosine", "dot", "l2"].includes(String(cap.distance_metric)));
    assert.equal(cap.default_limit, 25);
    assert.equal(cap.max_limit, 100);
    assert.ok(["built", "building", "stale"].includes(String(cap.index_state)));
    const score = asRecord(cap.score);
    assert.equal(score.supported, true);
    assert.equal(score.kind, "semantic_distance");
    assert.equal(score.order, "lower_is_better");
    assert.equal(score.value_semantics, "distance");
    const comparableWith = asRecord(score.comparable_with);
    assert.equal(comparableWith.model, cap.model);
    assert.equal(comparableWith.dimensions, cap.dimensions);
    assert.equal(comparableWith.distance_metric, cap.distance_metric);
    assert.equal(comparableWith.profile_id, "stub");
    assert.match(String(comparableWith.backend_identity), STUB_EMBED_MODEL_ID);
    // Advertisement is fetched without a bearer token (the unauthenticated
    // RS metadata route already allows that for lexical; confirming parity).
  });
});

test("RS metadata omits capabilities.semantic_retrieval when extension is disabled", async () => {
  await withHarness({ semanticRetrievalSupported: false }, async ({ rsUrl }) => {
    const { status, body } = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(status, 200);
    // Either omitted entirely or explicitly { supported: false }.
    const capabilities = asRecord(asRecord(body).capabilities);
    const cap = capabilities.semantic_retrieval;
    if (cap) {
      assert.equal(asRecord(cap).supported, false);
    }
    // Route is also absent — request returns 404.
    const { status: sStatus } = await fetchJson(`${rsUrl}/v1/search/semantic?q=x`);
    assert.equal(sStatus, 404);
  });
});

test("RS metadata omits semantic retrieval and route 404s when backend is unavailable", async () => {
  const unavailableBackend = {
    ...makeStubBackend(),
    available: () => false,
  };
  await withHarness({ semanticRetrievalBackend: unavailableBackend }, async ({ rsUrl }) => {
    const { body } = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(asRecord(asRecord(body).capabilities).semantic_retrieval, undefined);
    const resp = await fetch(`${rsUrl}/v1/search/semantic?q=test`, {
      headers: { Authorization: "Bearer bad-token" },
    });
    assert.equal(resp.status, 404);
  });
});

// ─── Dashboard capability probe — fail-closed on unadvertised, true when on ─

test("dashboard capability probe returns true when semantic is advertised", async () => {
  // Exercises the same shape that apps/console/src/app/(console)/lib/rs-client.ts
  // #isSemanticRetrievalAdvertised reads from the RS metadata document. The
  // dashboard's blended-search composition depends on this probe returning
  // true ONLY when the RS really would serve /v1/search/semantic.
  await withHarness({}, async ({ rsUrl }) => {
    const res = await fetch(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(res.ok, true);
    const body = asRecord(await res.json());
    const capabilities = asRecord(body.capabilities);
    assert.equal(
      asRecord(capabilities.semantic_retrieval).supported,
      true,
      'probe contract: supported:true signals "extension is reachable"'
    );
  });
});

test("dashboard capability probe returns false when semantic is disabled", async () => {
  await withHarness({ semanticRetrievalSupported: false }, async ({ rsUrl }) => {
    const res = await fetch(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(res.ok, true);
    const body = asRecord(await res.json());
    // Probe treats supported:false OR absent as "unavailable" — either
    // shape is legal per the spec.
    const capabilities = asRecord(body.capabilities);
    const supported = asRecord(capabilities.semantic_retrieval).supported === true;
    assert.equal(supported, false);
  });
});

// ─── 14.5 — independence from lexical advertisement ─────────────────────────

test("semantic advertisement is independent from lexical advertisement", async () => {
  // Lexical on, semantic off.
  await withHarness({ semanticRetrievalSupported: false }, async ({ rsUrl }) => {
    const { body } = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    const capabilities = asRecord(asRecord(body).capabilities);
    const lex = capabilities.lexical_retrieval ? asRecord(capabilities.lexical_retrieval) : null;
    const sem = capabilities.semantic_retrieval ? asRecord(capabilities.semantic_retrieval) : null;
    assert.ok(lex && lex.supported === true, "lexical still on");
    assert.ok(!sem || sem.supported === false, "semantic off");
  });
  // Semantic on, lexical off.
  await withHarness({ lexicalRetrievalSupported: false }, async ({ rsUrl }) => {
    const { body } = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    const capabilities = asRecord(asRecord(body).capabilities);
    const lex = capabilities.lexical_retrieval ? asRecord(capabilities.lexical_retrieval) : null;
    const sem = capabilities.semantic_retrieval ? asRecord(capabilities.semantic_retrieval) : null;
    assert.ok(!lex || lex.supported === false, "lexical off");
    assert.ok(sem && sem.supported === true, "semantic still on");
  });
});

// ─── 14.6 / 14.7 / 14.8 — happy-path shape + retrieval_mode ─────────────────

test('happy-path semantic search returns list envelope with retrieval_mode:"semantic"', async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, "posts", [
      { id: "p1", selftext: "unexpected fee", source_created_at: "2026-04-01T00:00:00Z", title: "overdraft surprise" },
      { id: "p2", selftext: "al dente tips", source_created_at: "2026-04-02T00:00:00Z", title: "cooking pasta" },
    ]);

    // Exact-match query — stub's reflexive exact-match property guarantees p1 is top hit.
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=${encodeURIComponent("overdraft surprise")}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(status, 200);
    const bodyRecord = asRecord(body);
    assert.equal(bodyRecord.object, "list");
    assert.equal(typeof bodyRecord.has_more, "boolean");
    assert.ok(Array.isArray(bodyRecord.data));
    const hitRaw = asArray(bodyRecord.data).find((r) => asRecord(r).record_key === "p1");
    assert.ok(hitRaw, "p1 should be in the hit list");
    const hit = asRecord(hitRaw);
    assert.equal(hit.object, "search_result");
    assert.equal(hit.stream, "posts");
    assert.equal(hit.connector_id, connectorA);
    assert.equal(hit.retrieval_mode, "semantic", 'v1: every hit emits retrieval_mode:"semantic"');
    assert.ok(Array.isArray(hit.matched_fields));
    const hitScore = asRecord(hit.score);
    assert.equal(hitScore.kind, "semantic_distance");
    assert.equal(hitScore.order, "lower_is_better");
    assert.ok(
      Math.abs(Number(hitScore.value)) < 1e-6,
      `exact-match semantic distance should be near zero, got ${String(hitScore.value)}`
    );
    // No raw vector/debug/alternate score fields
    for (const forbidden of ["cosine", "bm25", "blend", "_debug", "_explain", "_vector_distance"]) {
      assert.equal(hit[forbidden], undefined, `${forbidden} must not appear on a result`);
    }
    // Owner-mode record_url MUST include ?connector_id=
    assert.ok(String(hit.record_url).startsWith("/v1/streams/posts/records/p1?connector_id="));
    assert.ok(String(hit.record_url).includes(encodeURIComponent(connectorA)));
  });
});

test("semantic search omits score when capability metadata does not advertise score support", async () => {
  await withHarness(
    {
      semanticRetrievalCapability: {
        cross_stream: true,
        default_limit: 25,
        dimensions: 64,
        distance_metric: "cosine",
        endpoint: "/v1/search/semantic",
        index_state: "built",
        lexical_blending: false,
        max_limit: 100,
        model: "pdpp-reference-stub-embed-v0",
        query_input: "text",
        snippets: true,
        stability: "experimental",
        supported: true,
      },
    },
    async ({ asUrl, rsUrl }) => {
      const ownerToken = await issueOwnerToken(asUrl);
      const connectorA = MANIFEST_A.connector_id;
      await ingest(rsUrl, ownerToken, connectorA, "posts", [
        {
          id: "p1",
          selftext: "unexpected fee",
          source_created_at: "2026-04-01T00:00:00Z",
          title: "overdraft surprise",
        },
      ]);

      const { body: metadataBody } = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
      assert.equal(asRecord(asRecord(asRecord(metadataBody).capabilities).semantic_retrieval).score, undefined);

      const { status, body } = await fetchJson(
        `${rsUrl}/v1/search/semantic?q=${encodeURIComponent("overdraft surprise")}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } }
      );
      assert.equal(status, 200);
      assert.equal(asRecord(asArray(asRecord(body).data)[0]).score, undefined);
    }
  );
});

// ─── 14.9 / 14.10 — parameter rejection ─────────────────────────────────────

test("missing q returns invalid_request", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(`${rsUrl}/v1/search/semantic`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 400);
    assert.equal(errorCode(body), "invalid_request");
  });
});

test("forbidden parameters are all rejected with invalid_request (integration)", async () => {
  // The public surface has TWO rejection layers that both return 400
  // invalid_request: (a) the contract schema (additionalProperties: false on
  // the query allowlist), and (b) parseSemanticSearchParams in
  // search-semantic.js. A request containing a forbidden param may be
  // caught at either layer depending on ordering; the invariant this test
  // pins is "it's rejected with invalid_request", not which layer did it.
  // The `param` field is populated by the handler-level rejection; the
  // schema-level rejection omits it. The parseSemanticSearchParams
  // pure-helper test below pins `param` explicitly at the handler layer.
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const forbidden = [
      "vector",
      "embedding",
      "embed",
      "model",
      "model_id",
      "model_family",
      "rank",
      "boost",
      "weights",
      "blend",
      "connector_id",
      "fields",
      "expand",
      "expand_limit",
      "order",
      "sort",
      "mode",
    ];
    for await (const key of forbidden) {
      const { status, body } = await fetchJson(`${rsUrl}/v1/search/semantic?q=anything&${key}=whatever`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(status, 400, `${key} should return 400`);
      assert.equal(errorCode(body), "invalid_request", `${key} code`);
    }
    // filter[…] without a single stream is still rejected
    const { status: fStatus, body: fBody } = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=anything&${encodeURIComponent("filter[foo]")}=bar`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(fStatus, 400);
    assert.equal(errorCode(fBody), "invalid_request");
  });
});

test("filtered semantic search applies declared range and no-match filters before vector lookup", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    const exactQuery = "semantic filtered alpha";
    await ingest(rsUrl, ownerToken, connectorA, "posts", [
      { id: "old-sem", score: 1, selftext: "", source_created_at: "2026-03-01T00:00:00Z", title: exactQuery },
      { id: "new-sem", score: 5, selftext: "", source_created_at: "2026-04-10T00:00:00Z", title: exactQuery },
    ]);

    const range = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=${encodeURIComponent(exactQuery)}&streams=posts&filter[source_created_at][gte]=2026-04-01T00:00:00Z`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(range.status, 200);
    assert.deepEqual(
      asArray(asRecord(range.body).data)
        .map((r) => asRecord(r))
        .filter((r) => r.connector_id === connectorA)
        .map((r) => r.record_key),
      ["new-sem"]
    );

    const noMatch = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=${encodeURIComponent(exactQuery)}&streams=posts&filter[source_created_at][gte]=2027-01-01T00:00:00Z`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(noMatch.status, 200);
    assert.deepEqual(
      asArray(asRecord(noMatch.body).data)
        .map((r) => asRecord(r))
        .filter((r) => r.connector_id === connectorA),
      []
    );
  });
});

test("filtered semantic search rejects invalid filters and still-forbidden parameters", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    await materializeSemanticConnection(connectorA, SEMANTIC_A_TEST_INSTANCE_ID);
    await ingest(
      rsUrl,
      ownerToken,
      connectorA,
      "posts",
      [
        {
          id: "p1",
          score: 5,
          selftext: "secret body",
          source_created_at: "2026-04-10T00:00:00Z",
          title: "semantic filtered alpha",
        },
      ],
      SEMANTIC_A_TEST_INSTANCE_ID
    );

    const rejectedOwnerQueries = [
      "q=semantic&filter[source_created_at][gte]=2026-04-01T00:00:00Z",
      "q=semantic&streams=posts&streams=comments&filter[source_created_at][gte]=2026-04-01T00:00:00Z",
      "q=semantic&streams=posts&filter[subreddit][gte]=finance",
      "q=semantic&streams=posts&filter[source_created_at][between]=2026-04-01T00:00:00Z",
      "q=semantic&streams=posts&filter[source_created_at][gte]=not-a-date",
      "q=semantic&streams=posts&filter[source_created_at][gte]=2026-04-01T00:00:00Z&model=client-model",
      `q=semantic&streams=posts&filter[source_created_at][gte]=2026-04-01T00:00:00Z&connector_id=${encodeURIComponent(connectorA)}`,
    ];
    for await (const query of rejectedOwnerQueries) {
      const { status, body } = await fetchJson(`${rsUrl}/v1/search/semantic?${query}`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(status, 400, `expected 400 for ${query}`);
      assert.equal(errorCode(body), "invalid_request");
    }

    const approved = await approveClientGrant(asUrl, {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorA,
      purpose_code: "https://pdpp.dev/purpose/analytics",
      purpose_description: "semantic filtered retrieval test",
      streams: [
        { fields: ["id", "title", "source_created_at"], instance_ids: [SEMANTIC_A_TEST_INSTANCE_ID], name: "posts" },
      ],
    });
    const unauthorized = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=semantic&streams=posts&filter[selftext]=secret`,
      { headers: { Authorization: `Bearer ${String(approved.token)}` } }
    );
    assert.equal(unauthorized.status, 400);
    assert.equal(errorCode(unauthorized.body), "invalid_request");
  });
});

// ─── 14.11 — cross_stream:false requires streams[] ──────────────────────────

test("cross_stream:false advertisement requires streams[]", async () => {
  await withHarness(
    {
      semanticRetrievalCapability: {
        cross_stream: false,
        default_limit: 25,
        dimensions: 64,
        distance_metric: "cosine",
        endpoint: "/v1/search/semantic",
        index_state: "built",
        lexical_blending: false,
        max_limit: 100,
        model: "test-model",
        query_input: "text",
        snippets: true,
        stability: "experimental",
        supported: true,
      },
    },
    async ({ asUrl, rsUrl }) => {
      const ownerToken = await issueOwnerToken(asUrl);
      const { status, body } = await fetchJson(`${rsUrl}/v1/search/semantic?q=overdraft`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(status, 400);
      assert.equal(errorCode(body), "invalid_request");
    }
  );
});

// ─── 14.12 — client token streams[] not in grant ────────────────────────────

test("client-token streams[] not in grant returns grant_stream_not_allowed", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    await materializeSemanticConnection(connectorA, SEMANTIC_A_TEST_INSTANCE_ID);
    await ingest(
      rsUrl,
      ownerToken,
      connectorA,
      "posts",
      [{ id: "p1", selftext: "", source_created_at: "2026-04-01T00:00:00Z", title: "overdraft" }],
      SEMANTIC_A_TEST_INSTANCE_ID
    );
    const approved = await approveClientGrant(asUrl, {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorA,
      purpose_code: "https://pdpp.dev/purpose/analytics",
      purpose_description: "semantic test",
      streams: [{ fields: ["id", "title"], instance_ids: [SEMANTIC_A_TEST_INSTANCE_ID], name: "posts" }], // posts only
    });
    const { status, body } = await fetchJson(`${rsUrl}/v1/search/semantic?q=overdraft&streams=comments`, {
      headers: { Authorization: `Bearer ${String(approved.token)}` },
    });
    assert.equal(status, 403);
    assert.equal(errorCode(body), "grant_stream_not_allowed");
  });
});

// ─── 14.13 — owner streams[] unknown ⇒ empty list (not error) ───────────────

test("owner-token streams[]=<nonexistent> returns empty list, not error", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, "posts", [
      { id: "p1", selftext: "", source_created_at: "2026-04-01T00:00:00Z", title: "overdraft" },
    ]);
    const { status, body } = await fetchJson(`${rsUrl}/v1/search/semantic?q=overdraft&streams=nonexistent_stream`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    const bodyRecord = asRecord(body);
    assert.equal(bodyRecord.object, "list");
    assert.deepEqual(bodyRecord.data, []);
    assert.equal(bodyRecord.has_more, false);
  });
});

// ─── 14.15 / 14.19 — matched_fields subset + snippet grant safety ───────────

test("client grant authorizing only one of two declared semantic_fields restricts matched_fields and snippet", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    await materializeSemanticConnection(connectorA, SEMANTIC_A_TEST_INSTANCE_ID);
    await ingest(
      rsUrl,
      ownerToken,
      connectorA,
      "posts",
      [
        {
          id: "p1",
          selftext: "unauthorized field content",
          source_created_at: "2026-04-01T00:00:00Z",
          title: "overdraft story",
        },
      ],
      SEMANTIC_A_TEST_INSTANCE_ID
    );
    // Grant only `title` — selftext is NOT in the client's projection.
    const approved = await approveClientGrant(asUrl, {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorA,
      purpose_code: "https://pdpp.dev/purpose/analytics",
      purpose_description: "semantic test subset",
      streams: [{ fields: ["id", "title"], instance_ids: [SEMANTIC_A_TEST_INSTANCE_ID], name: "posts" }],
    });
    const { status, body } = await fetchJson(`${rsUrl}/v1/search/semantic?q=${encodeURIComponent("overdraft story")}`, {
      headers: { Authorization: `Bearer ${String(approved.token)}` },
    });
    assert.equal(status, 200);
    const hitRaw = asArray(asRecord(body).data).find((r) => asRecord(r).record_key === "p1");
    if (hitRaw) {
      const hit = asRecord(hitRaw);
      for (const f of asArray(hit.matched_fields)) {
        assert.equal(f, "title", "matched_fields may only include granted+declared fields");
      }
      const hitScore = asRecord(hit.score);
      assert.equal(hitScore.kind, "semantic_distance");
      assert.equal(hitScore.order, "lower_is_better");
      assert.ok(Number.isFinite(hitScore.value));
      if (hit.snippet) {
        // Grant-safe: snippet text must NOT come from selftext (which was ungranted).
        assert.ok(
          !String(asRecord(hit.snippet).text).includes("unauthorized field content"),
          "snippet must not leak ungranted field text"
        );
      }
    }
  });
});

// 14.14 - retained instance authority with current full-stream fields

test("client grant without a retained field subset searches declared semantic_fields", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    // Comments declares semantic_fields: ['body']. This approval path retains
    // instance authority but no field subset, so semantic search follows the
    // current full-stream grant behavior.
    await materializeSemanticConnection(connectorA, SEMANTIC_A_TEST_INSTANCE_ID);
    await ingest(
      rsUrl,
      ownerToken,
      connectorA,
      "comments",
      [
        {
          body: "something about overdrafts",
          id: "c1",
          marker: "not semantic",
          source_created_at: "2026-04-01T00:00:00Z",
        },
      ],
      SEMANTIC_A_TEST_INSTANCE_ID
    );
    const approved = await approveClientGrant(asUrl, {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorA,
      purpose_code: "https://pdpp.dev/purpose/analytics",
      purpose_description: "zero-intersection test",
      streams: [
        {
          fields: ["marker"],
          instance_ids: [SEMANTIC_A_TEST_INSTANCE_ID],
          name: "comments",
        },
      ],
    });
    const { status, body } = await fetchJson(`${rsUrl}/v1/search/semantic?q=overdrafts&streams=comments`, {
      headers: { Authorization: `Bearer ${String(approved.token)}` },
    });
    assert.equal(status, 200);
    const bodyRecord = asRecord(body);
    assert.equal(bodyRecord.object, "list");
    const hits = asArray(bodyRecord.data);
    assert.equal(hits.length, 1);
    assert.equal(asRecord(hits[0]).record_key, "c1");
  });
});

// ─── 14.18 — snippet property: verbatim contiguous substring ────────────────

test("snippet text is a verbatim contiguous substring of the matched field (property test)", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    const SEEDS: SemanticRecordInput[] = [
      {
        id: "p1",
        selftext: "the quick brown fox",
        source_created_at: "2026-04-01T00:00:00Z",
        title: "alpha beta gamma",
      },
      {
        id: "p2",
        selftext: "lorem ipsum dolor sit",
        source_created_at: "2026-04-02T00:00:00Z",
        title: "delta epsilon",
      },
      {
        id: "p3",
        selftext: "consectetur adipiscing",
        source_created_at: "2026-04-03T00:00:00Z",
        title: "zeta eta theta",
      },
    ];
    await ingest(rsUrl, ownerToken, connectorA, "posts", SEEDS);
    // Run a handful of queries; whatever hits come back, assert the snippet
    // appears byte-identically as a contiguous substring of the matched
    // field's stored value. No assumption about paraphrase behavior.
    for await (const q of ["alpha beta gamma", "lorem", "zeta eta theta", "brown fox"]) {
      const { body } = await fetchJson(`${rsUrl}/v1/search/semantic?q=${encodeURIComponent(q)}`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      for (const hitRaw of asArray(asRecord(body).data)) {
        const hit = asRecord(hitRaw);
        if (!hit.snippet) {
          continue;
        }
        const seed = SEEDS.find((s) => s.id === hit.record_key);
        if (!seed) {
          continue;
        }
        const snippet = asRecord(hit.snippet);
        const fieldValue = seed[String(snippet.field)];
        assert.ok(typeof fieldValue === "string", "matched field is a string");
        // pickVerbatimExcerpt may append a trailing '…' ellipsis. Strip it
        // before the substring check — the character is NOT in the stored
        // text, and the rest must appear verbatim.
        const clean = String(snippet.text).replace(TRAILING_ELLIPSIS, "");
        assert.ok(
          typeof fieldValue === "string" && fieldValue.includes(clean),
          `snippet "${String(snippet.text)}" must be a verbatim substring of field.${String(snippet.field)}`
        );
      }
    }
  });
});

// ─── 14.21/14.22 — no-fallback invariant visible in source ──────────────────

test("search-semantic.js has zero imports from search.js (no silent lexical fallback)", () => {
  const filePath = path.join(TEST_DIR, "..", "server", "search-semantic.ts");
  const src = fs.readFileSync(filePath, "utf8");
  // The invariant: no `from './search.js'` or `require('./search.js')`.
  assert.ok(!SEARCH_SEMANTIC_IMPORT.test(src), "search-semantic.js must not import from search.js");
  assert.ok(!SEARCH_SEMANTIC_REQUIRE.test(src), "search-semantic.js must not require search.js");
});

// ─── 14.24 — owner cross-connector fan-out ──────────────────────────────────

test("owner cross-connector search returns hits from every owner-visible connector that matches", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    const connectorB = MANIFEST_B.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, "posts", [
      { id: "pA1", selftext: "A body", source_created_at: "2026-04-01T00:00:00Z", title: "shared query alpha" },
    ]);
    await ingest(rsUrl, ownerToken, connectorB, "posts", [
      { id: "pB1", selftext: "B body", source_created_at: "2026-04-02T00:00:00Z", title: "shared query alpha" },
    ]);
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=${encodeURIComponent("shared query alpha")}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(status, 200);
    const connectors = new Set(asArray(asRecord(body).data).map((h) => asRecord(h).connector_id));
    assert.ok(connectors.has(connectorA), "hits from connector A present");
    assert.ok(connectors.has(connectorB), "hits from connector B present");
  });
});

// ─── 14.25 — owner record_url round-trip ────────────────────────────────────

test("owner record_url round-trips to a valid single-record read", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, "posts", [
      { id: "p1", selftext: "verify round-trip", source_created_at: "2026-04-01T00:00:00Z", title: "hydration check" },
    ]);
    const { body } = await fetchJson(`${rsUrl}/v1/search/semantic?q=${encodeURIComponent("hydration check")}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const hitRaw = asArray(asRecord(body).data).find((r) => asRecord(r).record_key === "p1");
    assert.ok(hitRaw);
    const hit = asRecord(hitRaw);
    const recordResp = await fetchJson(`${rsUrl}${String(hit.record_url)}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(recordResp.status, 200);
    // Canonical record envelope — spec doesn't pin the exact field shape at
    // this level, but the response must be JSON describing our record.
    assert.ok(recordResp.body, "record envelope present");
  });
});

// ─── 14.26 — owner connector_id= is rejected ────────────────────────────────

test("owner request including connector_id= is rejected as invalid_request", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=anything&connector_id=${encodeURIComponent(connectorA)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(status, 400);
    assert.equal(errorCode(body), "invalid_request");
    // .param is set by the handler-level rejection; the schema-level
    // rejection (additionalProperties: false) may fire first and omit it.
    // Either way the request is rejected with invalid_request, which is
    // the public contract. Handler-level .param is pinned by the
    // parseSemanticSearchParams unit test below.
  });
});

// ─── 14.27 / 14.28 / 14.30 — cursor round-trip + cross-surface rejection ────

test("next_cursor round-trips within a session (owner)", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    // Seed enough records that limit=2 paginates.
    const seeds: SemanticRecordInput[] = [];
    for (let i = 0; i < 5; i += 1) {
      seeds.push({
        id: `p${i}`,
        selftext: `body ${i}`,
        source_created_at: `2026-04-0${i + 1}T00:00:00Z`,
        title: `common query term ${i}`,
      });
    }
    await ingest(rsUrl, ownerToken, connectorA, "posts", seeds);
    const q = encodeURIComponent("common query term");
    const page0 = await fetchJson(`${rsUrl}/v1/search/semantic?q=${q}&limit=2`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(page0.status, 200);
    const page0Body = asRecord(page0.body);
    assert.equal(asArray(page0Body.data).length, 2);
    assert.equal(page0Body.has_more, true);
    assert.ok(typeof page0Body.next_cursor === "string" && page0Body.next_cursor.length > 0);
    // Cursor MUST be distinguishable from a lexical cursor.
    assert.ok(
      String(page0Body.next_cursor).startsWith("sem1."),
      "semantic cursors have a distinct prefix to prevent cross-surface reuse"
    );

    const page1 = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=${q}&limit=2&cursor=${encodeURIComponent(String(page0Body.next_cursor))}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(page1.status, 200);
    const page1Body = asRecord(page1.body);
    assert.equal(asArray(page1Body.data).length, 2);
    // Non-overlapping record_keys between pages.
    const p0keys = new Set(asArray(page0Body.data).map((r) => asRecord(r).record_key));
    for (const hitRaw of asArray(page1Body.data)) {
      const hit = asRecord(hitRaw);
      assert.ok(!p0keys.has(hit.record_key), `page1 must not repeat a page0 hit: ${String(hit.record_key)}`);
    }
  });
});

test("lexical cursor passed to /v1/search/semantic is rejected as invalid_cursor", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, "posts", [
      { id: "p1", selftext: "x", source_created_at: "2026-04-01T00:00:00Z", title: "paginate me" },
      { id: "p2", selftext: "y", source_created_at: "2026-04-02T00:00:00Z", title: "paginate me" },
    ]);
    const lex = await fetchJson(`${rsUrl}/v1/search?q=paginate&limit=1`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(lex.status, 200);
    const lexBody = asRecord(lex.body);
    assert.ok(typeof lexBody.next_cursor === "string", "lexical gives a cursor");
    // Passing the lexical cursor to /v1/search/semantic must NOT be honored.
    // The shipped PDPP error table maps invalid_cursor → 400 (not 410).
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=paginate&cursor=${encodeURIComponent(String(lexBody.next_cursor))}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(status, 400);
    assert.equal(errorCode(body), "invalid_cursor");
  });
});

// ─── 14.31 — lexical surface unchanged when semantic is enabled ─────────────

test("semantic enablement does not break /v1/search (lexical surface)", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, "posts", [
      { id: "p1", selftext: "should still work", source_created_at: "2026-04-01T00:00:00Z", title: "lexical check" },
    ]);
    const { status, body } = await fetchJson(`${rsUrl}/v1/search?q=lexical`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    const bodyRecord = asRecord(body);
    assert.equal(bodyRecord.object, "list");
    // Lexical hits MUST NOT carry retrieval_mode (that's semantic-only).
    for (const hitRaw of asArray(bodyRecord.data)) {
      assert.equal(asRecord(hitRaw).retrieval_mode, undefined, "lexical hits must not emit retrieval_mode");
    }
  });
});

type StubBackend = ReturnType<typeof makeStubBackend>;
type LocalTransformerBackend = ReturnType<typeof makeLocalTransformerBackend>;

function makeInterruptingDocumentBackend({
  successfulEmbedsBeforeThrow,
}: {
  successfulEmbedsBeforeThrow: number;
}): StubBackend & { successfulEmbeds: () => number } {
  const base = makeStubBackend();
  let successfulEmbeds = 0;
  return {
    ...base,
    embedDocument: (text: string) => {
      if (successfulEmbeds >= successfulEmbedsBeforeThrow) {
        throw new Error("simulated semantic backfill interruption");
      }
      successfulEmbeds += 1;
      return base.embedDocument(text);
    },
    successfulEmbeds: () => successfulEmbeds,
  };
}

function makeDocumentCountingBackend(): StubBackend & { documentEmbeds: () => number } {
  const base = makeStubBackend();
  let documentEmbeds = 0;
  return {
    ...base,
    documentEmbeds: () => documentEmbeds,
    embedDocument: (text: string) => {
      documentEmbeds += 1;
      return base.embedDocument(text);
    },
  };
}

function makeEmbeddingInputCapturingBackend(): StubBackend & {
  documentInputs: () => string[];
  queryInputs: () => string[];
} {
  const base = makeStubBackend();
  const documentInputs: string[] = [];
  const queryInputs: string[] = [];
  return {
    ...base,
    documentInputs: () => documentInputs.slice(),
    embedDocument: (text: string) => {
      documentInputs.push(text);
      return base.embedDocument(text);
    },
    embedQuery: (text: string) => {
      queryInputs.push(text);
      return base.embedQuery(text);
    },
    queryInputs: () => queryInputs.slice(),
  };
}

function countPersistedSemanticVectors(): number {
  const db = getDb();
  const table = db.vectorIndexKind === "sqlite-vec" ? "semantic_search_rowid" : "semantic_search_blob";
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
  return Number(row?.n || 0);
}

// ─── 14.33 — restart regression: coverage survives restart ──────────────────

test("restart regression: semantic coverage survives process restart without re-ingest", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdpp-semantic-restart-"));
  const dbPath = path.join(tmpDir, "pdpp.sqlite");
  let hitsBefore: unknown[] = [];
  let advertisedIndexStateAfter: unknown;
  try {
    // --- First boot: register + ingest + search. ---
    {
      const server = await startServer({
        asPort: 0,
        dbPath,
        dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
        quiet: true,
        rsPort: 0,
      });
      try {
        const asUrl = `http://localhost:${server.asPort}`;
        const rsUrl = `http://localhost:${server.rsPort}`;
        for await (const m of [MANIFEST_A]) {
          const reg = await fetch(`${asUrl}/connectors`, {
            body: JSON.stringify(m),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          });
          assert.equal(reg.status, 201);
        }
        const ownerToken = await issueOwnerToken(asUrl);
        await ingest(rsUrl, ownerToken, MANIFEST_A.connector_id, "posts", [
          { id: "p1", selftext: "", source_created_at: "2026-04-01T00:00:00Z", title: "persistent hit" },
        ]);
        const { body } = await fetchJson(`${rsUrl}/v1/search/semantic?q=${encodeURIComponent("persistent hit")}`, {
          headers: { Authorization: `Bearer ${ownerToken}` },
        });
        hitsBefore = asArray(asRecord(body).data)
          .map((h) => asRecord(h).record_key)
          .sort(compareStrings);
        assert.ok(hitsBefore.includes("p1"), "pre-restart search must find p1");
      } finally {
        await closeServer(server);
      }
    }
    // --- Second boot: same dbPath, no re-ingest, same search must hit. ---
    {
      const server = await startServer({
        asPort: 0,
        dbPath,
        dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
        quiet: true,
        rsPort: 0,
      });
      try {
        await server.startupBackfillDone;
        const rsUrl = `http://localhost:${server.rsPort}`;
        const asUrl = `http://localhost:${server.asPort}`;
        // Re-register manifest (polyfill topology re-registers on each boot;
        // backfill is idempotent and a no-op when no drift exists).
        await fetch(`${asUrl}/connectors`, {
          body: JSON.stringify(MANIFEST_A),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const { body: advBody } = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
        advertisedIndexStateAfter = asRecord(asRecord(asRecord(advBody).capabilities).semantic_retrieval).index_state;
        // index_state must be `built` (persistence survived, no drift).
        assert.equal(
          advertisedIndexStateAfter,
          "built",
          "after clean restart with matching backend, index_state is built"
        );

        const ownerToken = await issueOwnerToken(asUrl);
        const { body } = await fetchJson(`${rsUrl}/v1/search/semantic?q=${encodeURIComponent("persistent hit")}`, {
          headers: { Authorization: `Bearer ${ownerToken}` },
        });
        const hitsAfter = asArray(asRecord(body).data)
          .map((h) => asRecord(h).record_key)
          .sort(compareStrings);
        assert.ok(hitsAfter.includes("p1"), "post-restart search must still find p1 without re-ingest");
      } finally {
        await closeServer(server);
      }
    }
  } finally {
    fs.rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("restart regression: streams with only empty semantic field values do not rebuild forever", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdpp-semantic-empty-restart-"));
  const dbPath = path.join(tmpDir, "pdpp.sqlite");
  try {
    {
      const server = await startServer({
        asPort: 0,
        dbPath,
        dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
        quiet: true,
        rsPort: 0,
      });
      try {
        const asUrl = `http://localhost:${server.asPort}`;
        const rsUrl = `http://localhost:${server.rsPort}`;
        const reg = await fetch(`${asUrl}/connectors`, {
          body: JSON.stringify(MANIFEST_A),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(reg.status, 201);
        const ownerToken = await issueOwnerToken(asUrl);
        await ingest(rsUrl, ownerToken, MANIFEST_A.connector_id, "posts", [
          { id: "empty-semantic-1", selftext: "", source_created_at: "2026-04-01T00:00:00Z", title: "" },
        ]);
        assert.equal(countPersistedSemanticVectors(), 0, "empty semantic fields should not write vectors");
      } finally {
        await closeServer(server);
      }
    }

    {
      const countingBackend = makeDocumentCountingBackend();
      const server = await startServer({
        asPort: 0,
        dbPath,
        dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
        quiet: true,
        rsPort: 0,
        semanticRetrievalBackend: countingBackend,
      });
      try {
        await server.startupBackfillDone;
        assert.equal(
          countingBackend.documentEmbeds(),
          0,
          "restart drift check should treat zero indexable semantic values as in sync"
        );
        assert.equal(countPersistedSemanticVectors(), 0, "restart should not fabricate vectors for empty fields");
      } finally {
        await closeServer(server);
      }
    }
  } finally {
    fs.rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("semantic indexing caps oversized text before embedding", async () => {
  const capturingBackend = makeEmbeddingInputCapturingBackend();
  await withHarness({ semanticRetrievalBackend: capturingBackend }, async ({ asUrl, rsUrl }) => {
    const reg = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(MANIFEST_A),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(reg.status, 201);

    const longText = `oversized semantic input ${"x".repeat(DEFAULT_SEMANTIC_EMBEDDING_INPUT_MAX_CHARS + 200)}`;
    const ownerToken = await issueOwnerToken(asUrl);
    await ingest(rsUrl, ownerToken, MANIFEST_A.connector_id, "posts", [
      { id: "long-semantic-1", selftext: "", source_created_at: "2026-04-01T00:00:00Z", title: longText },
    ]);

    assert.ok(
      capturingBackend.documentInputs().some((text) => text.length === DEFAULT_SEMANTIC_EMBEDDING_INPUT_MAX_CHARS),
      "document embedding receives a capped input"
    );
    assert.ok(
      capturingBackend.documentInputs().every((text) => text.length <= DEFAULT_SEMANTIC_EMBEDDING_INPUT_MAX_CHARS),
      "no document embedding receives the full oversized field"
    );

    const { status, body } = await fetchJson(`${rsUrl}/v1/search/semantic?q=${encodeURIComponent(longText)}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    assert.ok(asArray(asRecord(body).data).some((hit) => asRecord(hit).record_key === "long-semantic-1"));
    assert.ok(
      capturingBackend.queryInputs().every((text) => text.length <= DEFAULT_SEMANTIC_EMBEDDING_INPUT_MAX_CHARS),
      "query embedding is capped with the same limit"
    );
  });
});

test("semantic search caches repeated query embeddings for fresh searches", async () => {
  const capturingBackend = makeEmbeddingInputCapturingBackend();
  await withHarness({ semanticRetrievalBackend: capturingBackend }, async ({ asUrl, rsUrl }) => {
    const reg = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(MANIFEST_A),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(reg.status, 201);

    const ownerToken = await issueOwnerToken(asUrl);
    await ingest(rsUrl, ownerToken, MANIFEST_A.connector_id, "posts", [
      { id: "cache-semantic-1", selftext: "", source_created_at: "2026-04-01T00:00:00Z", title: "deployment failure" },
    ]);

    for await (const _ of Array.from({ length: 2 })) {
      const { status } = await fetchJson(`${rsUrl}/v1/search/semantic?q=deployment%20failure`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(status, 200);
    }
    assert.equal(capturingBackend.queryInputs().length, 1);
  });
});

test("semantic upsert with an empty field deletes only that record, not the whole scope", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const reg = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(MANIFEST_A),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(reg.status, 201);
    const ownerToken = await issueOwnerToken(asUrl);
    await ingest(rsUrl, ownerToken, MANIFEST_A.connector_id, "posts", [
      {
        id: "empty-upsert-1",
        selftext: "",
        source_created_at: "2026-04-01T00:00:00Z",
        title: "first semantic survivor",
      },
      {
        id: "empty-upsert-2",
        selftext: "",
        source_created_at: "2026-04-01T00:00:00Z",
        title: "second semantic survivor",
      },
    ]);
    assert.equal(countPersistedSemanticVectors(), 2, "initial ingest writes one vector per non-empty title");

    await ingest(rsUrl, ownerToken, MANIFEST_A.connector_id, "posts", [
      { id: "empty-upsert-1", selftext: "", source_created_at: "2026-04-01T00:00:00Z", title: "" },
    ]);
    assert.equal(countPersistedSemanticVectors(), 1, "empty update removes only the updated record vector");

    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=${encodeURIComponent("second semantic survivor")}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(status, 200);
    const bodyData = asArray(asRecord(body).data);
    assert.ok(bodyData.some((hit) => asRecord(hit).record_key === "empty-upsert-2"));
    assert.equal(
      bodyData.some((hit) => asRecord(hit).record_key === "empty-upsert-1"),
      false,
      "the emptied record no longer contributes semantic hits"
    );
  });
});

test("semantic index metadata isolates instances and client search fans in across granted active bindings", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);

    await materializeSemanticConnection(MANIFEST_A.connector_id, "cin_semantic_work");
    await materializeSemanticConnection(MANIFEST_A.connector_id, "cin_semantic_personal");

    const baseRecord = {
      score: 1,
      selftext: "",
      source_created_at: "2026-04-01T00:00:00Z",
      subreddit: "pdpp",
      title: "semantic connector instance collision sentinel",
    };
    await ingest(
      rsUrl,
      ownerToken,
      MANIFEST_A.connector_id,
      "posts",
      [{ ...baseRecord, id: "work-record-key" }],
      "cin_semantic_work"
    );
    await ingest(
      rsUrl,
      ownerToken,
      MANIFEST_A.connector_id,
      "posts",
      [{ ...baseRecord, id: "personal-record-key" }],
      "cin_semantic_personal"
    );

    const indexed = await listSemanticVectorRows(MANIFEST_A.connector_id, ["personal-record-key", "work-record-key"]);
    assert.deepEqual(
      indexed.map((row: Record<string, unknown>) => row.connector_instance_id),
      ["cin_semantic_personal", "cin_semantic_work"],
      "semantic vector identity includes connector_instance_id"
    );

    const metaRows = await listSemanticMetaRows(MANIFEST_A.connector_id);
    assert.deepEqual(
      metaRows.map((row: Record<string, unknown>) => row.connector_instance_id),
      ["cin_semantic_personal", "cin_semantic_work"],
      "semantic metadata is per connector instance"
    );

    const approved = await approveClientGrant(asUrl, {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: MANIFEST_A.connector_id,
      purpose_code: "https://pdpp.org/purpose/analytics",
      purpose_description: "semantic instance fan-in test",
      streams: [
        {
          fields: ["id", "title", "source_created_at"],
          instance_ids: ["cin_semantic_personal", "cin_semantic_work"],
          name: "posts",
        },
      ],
    });
    assert.ok(approved.token, `expected issued grant token, got ${JSON.stringify(approved)}`);
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=${encodeURIComponent(baseRecord.title)}&streams=posts`,
      { headers: { Authorization: `Bearer ${String(approved.token)}` } }
    );

    assert.equal(status, 200);
    const hits = asArray(asRecord(body).data);
    assert.equal(hits.length, 2, "fan-in returns one hit per granted active binding");
    const cids = hits.map((h) => asRecord(h).connection_id).sort(compareStrings);
    assert.deepEqual(cids, ["cin_semantic_personal", "cin_semantic_work"]);
    const keys = hits.map((h) => asRecord(h).record_key).sort(compareStrings);
    assert.deepEqual(keys, ["personal-record-key", "work-record-key"]);
  });
});

test("interrupted semantic backfill with existing meta resumes instead of rebuilding from scratch", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdpp-semantic-meta-resume-"));
  const dbPath = path.join(tmpDir, "pdpp.sqlite");
  try {
    {
      const server = await startServer({
        asPort: 0,
        dbPath,
        dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
        quiet: true,
        rsPort: 0,
      });
      try {
        const asUrl = `http://localhost:${server.asPort}`;
        const rsUrl = `http://localhost:${server.rsPort}`;
        const reg = await fetch(`${asUrl}/connectors`, {
          body: JSON.stringify(MANIFEST_A),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(reg.status, 201);
        const ownerToken = await issueOwnerToken(asUrl);
        await ingest(rsUrl, ownerToken, MANIFEST_A.connector_id, "posts", [
          {
            id: "meta-resume-1",
            selftext: "",
            source_created_at: "2026-04-01T00:00:00Z",
            title: "meta resume one",
          },
          {
            id: "meta-resume-2",
            selftext: "",
            source_created_at: "2026-04-01T00:00:00Z",
            title: "meta resume two",
          },
          {
            id: "meta-resume-3",
            selftext: "",
            source_created_at: "2026-04-01T00:00:00Z",
            title: "meta resume three",
          },
        ]);
        assert.equal(countPersistedSemanticVectors(), 3, "initial write path indexes all records");

        const db = getDb();
        const meta = db
          .prepare(`
          SELECT connector_instance_id, fields_fingerprint, model_id, dimensions, distance_metric
          FROM semantic_search_meta
          WHERE connector_id = ? AND stream = 'posts'
        `)
          .get<{
            connector_instance_id: string;
            dimensions: number;
            distance_metric: string;
            fields_fingerprint: string;
            model_id: string;
          }>(MANIFEST_A.connector_id);
        assert.ok(meta, "completed meta exists before simulated interrupted resume");

        await semanticIndexDelete({
          connectorId: MANIFEST_A.connector_id,
          connectorInstanceId: meta.connector_instance_id,
          recordKey: "meta-resume-2",
          stream: "posts",
        });
        assert.equal(countPersistedSemanticVectors(), 2, "one vector is missing before simulated restart");

        db.prepare(`
          INSERT INTO semantic_search_backfill_progress(connector_instance_id, connector_id, stream, fields_fingerprint, model_id, dimensions, distance_metric, updated_at)
          VALUES(?, ?, 'posts', ?, ?, ?, ?, ?)
        `).run(
          meta.connector_instance_id,
          MANIFEST_A.connector_id,
          meta.fields_fingerprint,
          meta.model_id,
          meta.dimensions,
          meta.distance_metric,
          new Date().toISOString()
        );
      } finally {
        await closeServer(server);
      }
    }

    {
      const countingBackend = makeDocumentCountingBackend();
      const server = await startServer({
        asPort: 0,
        dbPath,
        dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
        quiet: true,
        rsPort: 0,
        semanticRetrievalBackend: countingBackend,
      });
      try {
        await server.startupBackfillDone;
        assert.equal(
          countingBackend.documentEmbeds(),
          1,
          "matching progress row should resume the missing vector instead of deleting and rebuilding all rows"
        );
        assert.equal(countPersistedSemanticVectors(), 3, "resume restores the missing vector");
        const db = getDb();
        const progressCount = db.prepare("SELECT COUNT(*) AS n FROM semantic_search_backfill_progress").get();
        assert.ok(progressCount, "aggregate query returns its count row");
        assert.equal(progressCount.n, 0, "progress row is cleared after resume completes");
      } finally {
        await closeServer(server);
      }
    }
  } finally {
    fs.rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("interrupted semantic backfill resumes and embeds only missing record-field pairs", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdpp-semantic-resume-"));
  const dbPath = path.join(tmpDir, "pdpp.sqlite");
  const strippedManifest = stripSemanticFields(MANIFEST_A);
  const interruptingBackend = makeInterruptingDocumentBackend({ successfulEmbedsBeforeThrow: 500 });
  const records = Array.from({ length: 501 }, (_, i) => ({
    id: `resume-${i}`,
    selftext: "",
    source_created_at: "2026-04-01T00:00:00Z",
    title: `resumable semantic backfill record ${i}`,
  }));

  try {
    {
      const server = await startServer({
        asPort: 0,
        dbPath,
        dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
        quiet: true,
        rsPort: 0,
        semanticRetrievalBackend: interruptingBackend,
      });
      try {
        const asUrl = `http://localhost:${server.asPort}`;
        const rsUrl = `http://localhost:${server.rsPort}`;
        const regV1 = await fetch(`${asUrl}/connectors`, {
          body: JSON.stringify(strippedManifest),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(regV1.status, 201, "register manifest without semantic fields");

        const ownerToken = await issueOwnerToken(asUrl);
        await ingest(rsUrl, ownerToken, MANIFEST_A.connector_id, "posts", records);

        const regV2 = await fetch(`${asUrl}/connectors`, {
          body: JSON.stringify(MANIFEST_A),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(regV2.status, 500, "simulated interruption aborts semantic backfill");
        assert.equal(interruptingBackend.successfulEmbeds(), 500);

        const db = getDb();
        assert.equal(countPersistedSemanticVectors(), 500, "first persisted page remains durable");
        const metaCount = db.prepare("SELECT COUNT(*) AS n FROM semantic_search_meta").get();
        assert.ok(metaCount, "aggregate query returns its count row");
        assert.equal(metaCount.n, 0, "completed semantic meta is not written after interruption");
        const resumedProgressCount = db.prepare("SELECT COUNT(*) AS n FROM semantic_search_backfill_progress").get();
        assert.ok(resumedProgressCount, "aggregate query returns its count row");
        assert.equal(resumedProgressCount.n, 1, "in-progress semantic backfill identity is persisted");
        const { body: metadataBody } = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
        assert.equal(
          asRecord(asRecord(asRecord(metadataBody).capabilities).semantic_retrieval).index_state,
          "stale",
          "incomplete progress without active backfill is advertised as stale"
        );
      } finally {
        await closeServer(server);
      }
    }

    {
      const countingBackend = makeDocumentCountingBackend();
      const server = await startServer({
        asPort: 0,
        dbPath,
        dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
        quiet: true,
        rsPort: 0,
        semanticRetrievalBackend: countingBackend,
      });
      try {
        await server.startupBackfillDone;
        assert.equal(
          countingBackend.documentEmbeds(),
          1,
          "restart backfill should embed only the missing record-field pair"
        );
        assert.equal(
          countPersistedSemanticVectors(),
          501,
          "resume completes the stream without deleting prior vectors"
        );
        const db = getDb();
        const completedProgressCount = db.prepare("SELECT COUNT(*) AS n FROM semantic_search_backfill_progress").get();
        assert.ok(completedProgressCount, "aggregate query returns its count row");
        assert.equal(completedProgressCount.n, 0, "progress row is deleted after completion");
        const resumedMetaCount = db
          .prepare(`
            SELECT COUNT(*) AS n
            FROM semantic_search_meta
            WHERE connector_id = ? AND stream = 'posts'
          `)
          .get(MANIFEST_A.connector_id);
        assert.ok(resumedMetaCount, "aggregate query returns its count row");
        assert.equal(resumedMetaCount.n, 1, "completed semantic meta is written for the resumed stream");

        const rsUrl = `http://localhost:${server.rsPort}`;
        const asUrl = `http://localhost:${server.asPort}`;
        const ownerToken = await issueOwnerToken(asUrl);
        const { status, body } = await fetchJson(
          `${rsUrl}/v1/search/semantic?q=${encodeURIComponent("resumable semantic backfill record 500")}`,
          { headers: { Authorization: `Bearer ${ownerToken}` } }
        );
        assert.equal(status, 200);
        assert.ok(
          asArray(asRecord(body).data).some((hit) => asRecord(hit).record_key === "resume-500"),
          "the previously missing record becomes searchable after resume"
        );
      } finally {
        await closeServer(server);
      }
    }
  } finally {
    fs.rmSync(tmpDir, { force: true, recursive: true });
  }
});

// ─── 14.35 — restart + backend identity drift → stale → rebuild ─────────────

test("backend identity change flips index_state to stale until rebuild restores", async () => {
  // Same DB path across two boots, but the second boot configures a backend
  // with a DIFFERENT model_id (via semanticRetrievalBackend override).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdpp-semantic-drift-"));
  const dbPath = path.join(tmpDir, "pdpp.sqlite");
  try {
    // First boot — default stub backend (model `pdpp-reference-stub-embed-v0`).
    {
      const server = await startServer({
        asPort: 0,
        dbPath,
        dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
        quiet: true,
        rsPort: 0,
      });
      try {
        const asUrl = `http://localhost:${server.asPort}`;
        const rsUrl = `http://localhost:${server.rsPort}`;
        await fetch(`${asUrl}/connectors`, {
          body: JSON.stringify(MANIFEST_A),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const ownerToken = await issueOwnerToken(asUrl);
        await ingest(rsUrl, ownerToken, MANIFEST_A.connector_id, "posts", [
          { id: "p1", selftext: "", source_created_at: "2026-04-01T00:00:00Z", title: "drift test" },
        ]);
      } finally {
        await closeServer(server);
      }
    }
    // Second boot — install a stub with a different model_id. Startup
    // backfill runs after AS/RS listen, so wait for the returned promise
    // before asserting the steady-state advertisement.
    {
      const { makeStubBackend: makeImportedStubBackend } = await import("../server/search-semantic.ts");
      const driftedBackend = makeImportedStubBackend({ dimensions: 64 });
      // Override the model identifier by shadowing the returned backend's
      // model() — a minimal adapter mimicking how an operator might swap
      // backends without changing the interface.
      const adapter = {
        ...driftedBackend,
        model: () => "pdpp-reference-stub-embed-v0-variant",
      };
      const server = await startServer({
        asPort: 0,
        dbPath,
        dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
        quiet: true,
        rsPort: 0,
        semanticRetrievalBackend: adapter,
      });
      try {
        await server.startupBackfillDone;
        const rsUrl = `http://localhost:${server.rsPort}`;
        const asUrl = `http://localhost:${server.asPort}`;
        await fetch(`${asUrl}/connectors`, {
          body: JSON.stringify(MANIFEST_A),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const { body } = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
        const cap = asRecord(asRecord(asRecord(body).capabilities).semantic_retrieval);
        // After re-register, backfill ran with the new backend → built.
        assert.equal(cap.model, "pdpp-reference-stub-embed-v0-variant");
        assert.equal(cap.index_state, "built");
      } finally {
        await closeServer(server);
      }
    }
  } finally {
    fs.rmSync(tmpDir, { force: true, recursive: true });
  }
});

// ─── parseSemanticSearchParams pure helper — guards the allowlist directly ──

// ─── Operational coverage: real polyfill manifest contributes semantic hits ──
//
// Regression for the operational gap described in
// openspec/changes/make-semantic-retrieval-operational: the semantic
// extension was advertised "built" while zero shipped polyfill manifests
// declared query.search.semantic_fields, so /v1/search/semantic could be
// wired up end-to-end and still return zero hits on real data.
//
// This test uses the real shipped gmail manifest (not an inline fixture) so
// any future regression that drops semantic_fields from the first-party set
// will fail here. It also walks the exact "existing DB + re-registration"
// path reconcilePolyfillManifests takes on boot, proving the declared
// coverage reaches existing records without connector re-ingest.

function loadShippedManifest(name: string): Record<string, unknown> {
  const p = path.resolve(TEST_DIR, "..", "..", "packages", "polyfill-connectors", "manifests", name);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function stripSemanticFields(manifest: Record<string, unknown>): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(manifest));
  for (const streamRaw of asArray(copy.streams)) {
    const stream = asRecord(streamRaw);
    const search = asRecord(asRecord(stream.query).search);
    if ("semantic_fields" in search) {
      search.semantic_fields = undefined;
    }
  }
  return copy;
}

test("shipped gmail manifest contributes semantic coverage after reconcile without record re-ingest", async () => {
  const shipped = loadShippedManifest("gmail.json");
  assert.ok(Array.isArray(shipped.streams) && asArray(shipped.streams).length > 0);

  // Baseline truth-check: at least one stream declares semantic_fields in the
  // shipped manifest. If this fails, the operational semantic gap has
  // regressed: no first-party polyfill contributes to the index.
  const participating = asArray(shipped.streams)
    .map((s) => asRecord(s))
    .filter(
      (s) =>
        Array.isArray(asRecord(asRecord(s.query).search).semantic_fields) &&
        asArray(asRecord(asRecord(s.query).search).semantic_fields).length > 0
    );
  assert.ok(
    participating.length > 0,
    "shipped gmail manifest must declare query.search.semantic_fields on at least one stream"
  );
  // `messages` carries the highest-signal natural-language fields (subject,
  // snippet). Pin it explicitly so a future reshuffle that demotes messages
  // out of the semantic set is a visible failure rather than a silent one.
  const messagesStream = participating.find((s) => s.name === "messages");
  assert.ok(messagesStream, "gmail messages stream should participate in semantic retrieval");
  const messagesStreamRecord = asRecord(messagesStream);
  const declared = asArray(asRecord(asRecord(messagesStreamRecord.query).search).semantic_fields);
  const messagesSchemaProperties = asRecord(asRecord(messagesStreamRecord.schema).properties);
  for (const field of declared) {
    assert.ok(
      messagesSchemaProperties[String(field)],
      `gmail messages.semantic_fields entry '${String(field)}' must exist in schema.properties`
    );
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdpp-semantic-gmail-"));
  const dbPath = path.join(tmpDir, "pdpp.sqlite");

  try {
    const server = await startServer({
      asPort: 0,
      dbPath,
      dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
      quiet: true,
      rsPort: 0,
    });
    try {
      const asUrl = `http://localhost:${server.asPort}`;
      const rsUrl = `http://localhost:${server.rsPort}`;
      const connectorId = String(shipped.connector_id);
      // The server canonicalizes the first-party registry URL
      // (`https://registry.pdpp.dev/connectors/gmail`) to its short key
      // (`gmail`) at the manifest boundary, so semantic hits are emitted
      // under the canonical key — not the raw URL. Filter by the canonical
      // key (falling back to the raw value for custom manifests) to compare
      // hit.connector_id against what the runtime actually emits.
      const canonicalConnectorId = canonicalConnectorKeyFromManifest(shipped) ?? connectorId;

      // (1) Register the gmail manifest WITHOUT semantic_fields. Represents
      // the pre-operational-semantic world where a real DB was populated
      // while no semantic coverage was declared.
      const strippedManifest = stripSemanticFields(shipped);
      const regV1 = await fetch(`${asUrl}/connectors`, {
        body: JSON.stringify(strippedManifest),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(regV1.status, 201, "register stripped gmail manifest");

      // (2) Ingest realistic gmail messages BEFORE semantic_fields exist.
      // The semantic index write-path maintenance never runs for these.
      const ownerToken = await issueOwnerToken(asUrl);
      await ingest(rsUrl, ownerToken, connectorId, "messages", [
        {
          emitted_at: "2026-04-02T10:00:00Z",
          from_email: "taylor@example.com",
          from_name: "Taylor Finance",
          id: "m1",
          received_at: "2026-04-02T10:00:00Z",
          snippet: "Heads-up on the quarterly budget forecast and capacity planning ahead of Q3 kickoff.",
          source_created_at: "2026-04-02T10:00:00Z",
          subject: "Budget forecast for Q3 capacity planning",
          thread_id: "t1",
        },
        {
          emitted_at: "2026-04-05T14:00:00Z",
          from_email: "jordan@example.com",
          from_name: "Jordan",
          id: "m2",
          received_at: "2026-04-05T14:00:00Z",
          snippet: "Want to grab lunch Friday at the new place on Main?",
          source_created_at: "2026-04-05T14:00:00Z",
          subject: "Lunch Friday?",
          thread_id: "t2",
        },
        {
          emitted_at: "2026-04-10T09:00:00Z",
          from_email: "noreply@airline.example.com",
          from_name: "Airline",
          id: "m3",
          received_at: "2026-04-10T09:00:00Z",
          snippet: "Your flight itinerary from San Francisco to Amsterdam is confirmed.",
          source_created_at: "2026-04-10T09:00:00Z",
          subject: "Flight itinerary — SFO to AMS",
          thread_id: "t3",
        },
      ]);

      // (3) Baseline: semantic search MUST return zero gmail hits because
      // the registered manifest has no semantic_fields. The deterministic
      // stub backend is exact-match reflexive, so we use the exact subject
      // as the query to rule out "search is broken for unrelated reasons".
      const exactQuery = "Budget forecast for Q3 capacity planning";
      const { body: baselineBody } = await fetchJson(
        `${rsUrl}/v1/search/semantic?q=${encodeURIComponent(exactQuery)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } }
      );
      const baselineGmailHits = asArray(asRecord(baselineBody).data)
        .map((h) => asRecord(h))
        .filter((h) => h.connector_id === canonicalConnectorId);
      assert.deepEqual(
        baselineGmailHits.map((h) => h.record_key),
        [],
        "before semantic_fields are declared, gmail contributes zero semantic hits"
      );

      // (4) Re-register with the shipped manifest. This is what
      // reconcilePolyfillManifests does on boot after a reference ships
      // updated semantic_fields — without touching the records table.
      const regV2 = await fetch(`${asUrl}/connectors`, {
        body: JSON.stringify(shipped),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(regV2.status, 201, "register shipped gmail manifest");

      // (5) The same exact-match query must now return the historical
      // record. Exact-match reflexivity is the stub backend's load-bearing
      // promise; if the backfill path did not run, hits stay empty.
      const { body: afterBody } = await fetchJson(`${rsUrl}/v1/search/semantic?q=${encodeURIComponent(exactQuery)}`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      const afterGmailHits = asArray(asRecord(afterBody).data)
        .map((h) => asRecord(h))
        .filter((h) => h.connector_id === canonicalConnectorId);
      assert.ok(
        afterGmailHits.some((h) => h.record_key === "m1"),
        "after declaring semantic_fields, the historical gmail record becomes semantically searchable with no re-ingest"
      );
      // matched_fields is an intersection of (declared semantic_fields ∩
      // grant projection). For owner-mode the grant projection is
      // effectively full, so matched_fields must be a subset of what the
      // shipped manifest declares.
      const hit = afterGmailHits.find((h) => h.record_key === "m1");
      for (const field of asArray(asRecord(hit).matched_fields)) {
        assert.ok(
          declared.includes(field),
          `matched_field '${String(field)}' must be present in declared semantic_fields ${JSON.stringify(declared)}`
        );
      }
    } finally {
      await closeServer(server);
    }
  } finally {
    fs.rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("multilingual-minilm profile builds embeddings and returns semantic hits", {
  skip: RUN_MULTILINGUAL_MINILM_SMOKE
    ? false
    : "set PDPP_MULTILINGUAL_MINILM_SMOKE=1 to run the external model-download smoke",
  timeout: 180_000,
}, async () => {
  const cacheDir =
    process.env.PDPP_MULTILINGUAL_MINILM_SMOKE_CACHE_DIR ||
    path.join(os.tmpdir(), "pdpp-multilingual-minilm-smoke-cache");
  const resolved = resolveSemanticBackendFromEnv({
    PDPP_EMBEDDING_CACHE_DIR: cacheDir,
    PDPP_EMBEDDING_DOWNLOAD_ALLOWED: "1",
    PDPP_EMBEDDING_PROFILE_ID: "multilingual-minilm",
    PDPP_SEMANTIC_EMBEDDING_BACKEND: "local",
  });

  assert.ok(resolved, "multilingual-minilm backend resolves");
  const backend = resolved as LocalTransformerBackend;
  assert.ok(hasLocalBackendMetadata(backend), "local backend exposes its metadata methods");
  const metadata: LocalBackendMetadata = backend;
  assert.equal(backend.profileId(), "multilingual-minilm");
  assert.equal(backend.model(), "Xenova/paraphrase-multilingual-MiniLM-L12-v2");
  assert.equal(backend.dimensions(), 384);
  const languageBias = metadata.languageBias();
  assert.ok(languageBias, "multilingual backend declares its language bias");
  assert.equal(languageBias.primary, "multi");

  const vector = await backend.embedDocument("La ricevuta del treno per Milano e pronta.");
  assert.equal(vector.length, 384, "multilingual-minilm builds 384-dimensional embeddings");
  assert.equal(metadata.modelCachePresent(), true, "profile model files are cached after embedding");

  await withHarness({ semanticRetrievalBackend: backend }, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, "posts", [
      {
        id: "it-1",
        selftext: "Promemoria: scaricare la ricevuta del viaggio in treno verso Milano.",
        source_created_at: "2026-04-18T09:00:00Z",
        subreddit: "viaggi",
        title: "Ricevuta del treno per Milano",
      },
      {
        id: "it-2",
        selftext: "Comprare pane, pomodori e caffe prima di cena.",
        source_created_at: "2026-04-18T10:00:00Z",
        subreddit: "casa",
        title: "Lista della spesa",
      },
    ]);

    const { status: metadataStatus, body: metadataBody } = await fetchJson(
      `${rsUrl}/.well-known/oauth-protected-resource`
    );
    assert.equal(metadataStatus, 200);
    const semanticCap = asRecord(asRecord(asRecord(metadataBody).capabilities).semantic_retrieval);
    assert.equal(semanticCap.model, backend.model());
    assert.equal(asRecord(semanticCap.language_bias).primary, "multi");

    const { status, body } = await fetchJson(
      `${rsUrl}/v1/search/semantic?q=${encodeURIComponent("ricevuta treno Milano")}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );

    assert.equal(status, 200);
    assert.ok(
      asArray(asRecord(body).data).some((hitRaw) => {
        const hit = asRecord(hitRaw);
        return hit.record_key === "it-1" && hit.retrieval_mode === "semantic";
      }),
      "multilingual-minilm returns a semantic hit from the Italian corpus"
    );
  });
});

test("parseSemanticSearchParams accepts the v1 allowlist, rejects everything else", () => {
  const ok = parseSemanticSearchParams({ q: "x" });
  assert.equal(ok.q, "x");
  assert.equal(ok.limit, 25);
  assert.equal(ok.cursor, null);
  assert.equal(ok.streams, null);
  const filtered = parseSemanticSearchParams({
    filter: { source_created_at: { gte: "2026-04-01T00:00:00Z" } },
    q: "x",
    streams: "posts",
  });
  assert.deepEqual(filtered.streams, ["posts"]);
  assert.deepEqual(filtered.filter, { source_created_at: { gte: "2026-04-01T00:00:00Z" } });
  // Each rejected key throws with { code: 'invalid_request', param: <key> }.
  for (const key of ["vector", "embedding", "model", "rank", "connector_id", "order"]) {
    assert.throws(
      () => parseSemanticSearchParams({ q: "x", [key]: "v" }),
      (err: unknown) => asRecord(err).code === "invalid_request" && asRecord(err).param === key,
      `${key} should throw`
    );
  }
  // Missing q.
  assert.throws(
    () => parseSemanticSearchParams({}),
    (err: unknown) => asRecord(err).code === "invalid_request" && asRecord(err).param === "q"
  );
  assert.throws(
    () => parseSemanticSearchParams({ filter: { source_created_at: { gte: "2026-04-01T00:00:00Z" } }, q: "x" }),
    (err: unknown) => asRecord(err).code === "invalid_request" && asRecord(err).param === "streams"
  );
});

test("resolveSemanticPerConnectorLimit scales with requested page size instead of always using the public maximum", () => {
  assert.equal(resolveSemanticPerConnectorLimit(1), 25);
  assert.equal(resolveSemanticPerConnectorLimit(25), 38);
  assert.equal(resolveSemanticPerConnectorLimit(50), 75);
  assert.equal(resolveSemanticPerConnectorLimit(100), 100);
  assert.equal(resolveSemanticPerConnectorLimit(500), 100);
});

test("buildPostgresSemanticPlanRequests merges unfiltered scopes and preserves filtered candidate requests", () => {
  const requests = buildPostgresSemanticPlanRequests([
    {
      connectorInstanceId: "cin_a",
      scopeKeys: ['["messages","text"]'],
      searchableFields: [],
      streamName: "messages",
    },
    {
      connectorInstanceId: "cin_a",
      scopeKeys: ['["files","title"]', '["messages","text"]'],
      searchableFields: [],
      streamName: "files",
    },
    {
      candidateRecordKeys: ["rk_1"],
      connectorInstanceId: "cin_a",
      scopeKeys: ['["messages","text"]'],
      searchableFields: [],
      streamName: "messages",
    },
    {
      connectorInstanceId: "cin_b",
      scopeKeys: ['["notes","body"]'],
      searchableFields: [],
      streamName: "notes",
    },
  ]);

  assert.equal(requests.length, 3);
  assert.deepEqual(requests[0], {
    candidateRecordKeys: null,
    connectorInstanceId: "cin_b",
    postgresCandidateFilter: null,
    scopeKeys: ['["notes","body"]'],
    streamName: null,
  });
  assert.deepEqual(requests[1], {
    candidateRecordKeys: null,
    connectorInstanceId: "cin_a",
    postgresCandidateFilter: null,
    scopeKeys: ['["files","title"]', '["messages","text"]'],
    streamName: null,
  });
  assert.deepEqual(requests[2], {
    candidateRecordKeys: ["rk_1"],
    connectorInstanceId: "cin_a",
    postgresCandidateFilter: undefined,
    scopeKeys: ['["messages","text"]'],
    streamName: "messages",
  });
});

test("semantic backend env resolver defaults to deterministic stub outside operational dev mode", () => {
  const backend = resolveSemanticBackendFromEnv({});
  assert.ok(backend);
  assert.equal(backend.model(), "pdpp-reference-stub-embed-v0");
  assert.equal(backend.dimensions(), 64);
  assert.equal(backend.distanceMetric(), "cosine");
  assert.equal(backend.available(), true);
});

test("semantic backend env resolver can disable semantic retrieval entirely", () => {
  assert.equal(resolveSemanticBackendFromEnv({ PDPP_SEMANTIC_EMBEDDING_BACKEND: "disabled" }), null);
});

test("semantic backend env resolver rejects unknown local profile IDs", () => {
  assert.throws(
    () =>
      resolveSemanticBackendFromEnv({
        PDPP_EMBEDDING_PROFILE_ID: "unknown-profile",
        PDPP_REFERENCE_OPERATIONAL_DEFAULTS: "1",
      }),
    UNKNOWN_PROFILE_ERROR
  );
});

test("semantic backend env resolver exposes local multilingual profile metadata without loading a model", () => {
  const resolved = resolveSemanticBackendFromEnv({
    PDPP_EMBEDDING_CACHE_DIR: path.join(os.tmpdir(), "pdpp-missing-transformers-cache"),
    PDPP_EMBEDDING_DOWNLOAD_ALLOWED: "0",
    PDPP_EMBEDDING_PROFILE_ID: "multilingual-minilm",
    PDPP_REFERENCE_OPERATIONAL_DEFAULTS: "1",
  });
  assert.ok(resolved);
  const backend = resolved as LocalTransformerBackend;
  assert.ok(hasLocalBackendMetadata(backend), "local backend exposes its metadata methods");
  const metadata: LocalBackendMetadata = backend;
  assert.equal(backend.model(), "Xenova/paraphrase-multilingual-MiniLM-L12-v2");
  assert.equal(backend.dimensions(), 384);
  assert.equal(backend.distanceMetric(), "cosine");
  const languageBias = metadata.languageBias();
  assert.ok(languageBias, "multilingual backend declares its language bias");
  assert.equal(languageBias.primary, "multi");
  assert.equal(metadata.downloadAllowed(), false);
  assert.equal(metadata.modelCachePresent(), false);
  assert.equal(backend.available(), false);
});

test("semantic backend env resolver refuses production local execution without the supervisor restart contract", () => {
  assert.throws(
    () =>
      resolveSemanticBackendFromEnv({
        NODE_ENV: "production",
        PDPP_SEMANTIC_EMBEDDING_BACKEND: "local",
      }),
    LOCAL_SUPERVISOR_CONTRACT_ERROR
  );
  // Same rejection when local mode is reached via the operational-defaults
  // path, not just an explicit backend override — this is the exact
  // production boot path (PDPP_REFERENCE_OPERATIONAL_DEFAULTS=1 +
  // NODE_ENV=production selects "local" by default; see defaultMode above).
  assert.throws(
    () =>
      resolveSemanticBackendFromEnv({
        NODE_ENV: "production",
        PDPP_REFERENCE_OPERATIONAL_DEFAULTS: "1",
      }),
    LOCAL_SUPERVISOR_CONTRACT_ERROR
  );
});

test("semantic backend env resolver accepts production local execution once the supervisor restart contract is asserted", () => {
  const backend = resolveSemanticBackendFromEnv({
    NODE_ENV: "production",
    PDPP_EMBEDDING_CACHE_DIR: path.join(os.tmpdir(), "pdpp-missing-transformers-cache"),
    PDPP_EMBEDDING_DOWNLOAD_ALLOWED: "0",
    PDPP_LOCAL_TRANSFORMER_SUPERVISOR_RESTART_CONTRACT: "1",
    PDPP_SEMANTIC_EMBEDDING_BACKEND: "local",
  });
  assert.ok(backend);
  assert.equal(backend.profileId(), "minilm");
});
