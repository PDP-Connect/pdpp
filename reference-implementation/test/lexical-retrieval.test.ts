// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Lexical Retrieval Extension — public-contract conformance tests.
 *
 * Pins the behavior the approved spec promises at:
 *   openspec/changes/add-lexical-retrieval-extension/specs/lexical-retrieval/spec.md
 *
 * Coverage (cross-referenced to tasks.md §9 in
 * openspec/changes/implement-lexical-retrieval-extension/tasks.md):
 *  - 9.1  RS metadata advertisement present + complete when supported
 *  - 9.2  RS metadata advertisement omitted/false when disabled
 *  - 9.3  list envelope shape on a happy-path search
 *  - 9.4  missing q → invalid_request
 *  - 9.5  rejected v1 params (filter, rank, embedding, vector, semantic, order, connector_id)
 *  - 9.6  client-token streams[] not in grant → grant_stream_not_allowed;
 *         owner-token streams[] unknown anywhere → empty list (NOT error)
 *  - 9.7  cross_stream:false advertisement + missing streams[] → invalid_request
 *  - 9.8  result shape (required keys, typed implementation-relative score), per-mode record_url
 *  - 9.9  helper-level: results without record_url/snippet are still valid
 *  - 9.10 matched_fields ⊆ declared lexical_fields ∩ grant projection
 *  - 9.11 grant subsetting + snippet grant safety
 *  - 9.12 zero overlap → zero hits, no per-stream error
 *  - 9.13 cursor round-trip + cross-surface invalid_cursor
 *  - 9.14 /_ref/search and /v1/search are independent
 *  - 9.15 manifest validator rejects bad lexical_fields shapes
 *  - 9.16 (covered by 9.11 snippet check)
 *  - 9.17 owner-mode cross-connector fan-out
 *  - 9.18 owner-mode hydration round-trip via record_url
 *
 * Plus Reference-Implementation-Architecture spec scenarios:
 *  - "/_ref/search returns spine-shape, /v1/search returns list shape"
 *  - "advertisement is reachable without a grant"
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { closePostgresStorage } from "../server/postgres-storage.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { drainConnectorInstanceIndexWork } from "../server/records.ts";
import { buildSearchPlanForGrant, parseSearchParams } from "../server/search.ts";

// ─── harness ────────────────────────────────────────────────────────────────

const TEST_DCR_INITIAL_ACCESS_TOKEN = "pdpp-reference-test-initial-access-token";
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

// startServer is imported from checkJs:false JS; TS's structural inference
// for app.listen()'s return widens asServer/rsServer to a type missing
// closeAllConnections (a real Node http.Server method the source's own
// shutdown path uses elsewhere -- opts here never requests TLS, so at
// runtime this is always a plain http.Server). Overriding just those two
// members on the real inferred return type (rather than a wholly separate
// interface) keeps enough structural overlap for a single-hop cast. Matches
// the established pattern in records-cursor-fallback.test.ts.
interface CloseableServer {
  close: (callback?: (err?: Error) => void) => unknown;
  closeAllConnections: () => void;
}

type StartedServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: CloseableServer;
  rsServer: CloseableServer;
};

async function fetchJson<T = Record<string, unknown>>(
  url: string,
  opts: RequestInit = {}
): Promise<{ status: number; body: T | null }> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body: T | string | null = null;
  try {
    body = text ? (JSON.parse(text) as T) : null;
  } catch {
    body = text;
  }
  return { body: body as T | null, status: resp.status };
}

async function closeServer(server: StartedServer): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((r) => server.asServer.close(r)),
    new Promise((r) => server.rsServer.close(r)),
  ]);
}

// ─── response-envelope shapes (wire contract under test) ───────────────────

interface SearchScore {
  kind: string;
  order: string;
  value: number;
}

interface EvidenceExcerpt {
  field_path: string;
  preview_text: string;
}

interface SearchHitSnippet {
  field: string;
  text: string;
}

interface SearchHit {
  authored_at?: string;
  connector_id: string;
  emitted_at: string;
  evidence_excerpts?: EvidenceExcerpt[];
  matched_fields: string[];
  object: string;
  record_key: string;
  record_url: string;
  score?: SearchScore;
  snippet?: SearchHitSnippet;
  stream: string;
}

interface SearchRecallInfo {
  candidate_window_limit?: number;
  complete: boolean;
  ranked_candidate_count?: number;
  ranking_scope: string;
  truncated: boolean;
  truncated_source_count?: number;
}

interface SearchWarning {
  code: string;
  detail?: { max_limit?: number; requested_limit?: number };
  param?: string;
}

interface SearchListMeta {
  count: number;
  count_accuracy: string;
  recall: SearchRecallInfo;
  warnings?: SearchWarning[];
}

interface SearchListResponse {
  data: SearchHit[];
  has_more: boolean;
  meta?: SearchListMeta;
  next_cursor?: string;
  object: string;
}

interface RefSearchSpineResponse {
  exact?: unknown;
  grants?: unknown;
  object: string;
  runs?: unknown;
  traces?: unknown;
}

interface RecordEnvelopeResponse {
  id: string;
  object: string;
  stream: string;
}

interface LexicalRetrievalCapability {
  cross_stream: boolean;
  default_limit: number;
  endpoint: string;
  max_limit: number;
  score?: {
    kind: string;
    order: string;
    supported: boolean;
    value_semantics: string;
  };
  snippets: boolean;
  supported: boolean;
}

interface MetadataDocument {
  capabilities?: {
    lexical_retrieval?: LexicalRetrievalCapability;
  };
}

interface ErrorEnvelopeResponse {
  error: { code: string };
}

interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
}

interface TokenResponse {
  access_token: string;
}

interface ParInitiateResponse {
  request_uri: string;
}

interface ApprovedGrantResponse {
  grant?: { streams?: Array<{ fields?: string[]; name?: string }> };
  token: string;
}

function withCoreSourceDeclaration<
  T extends { connector_id: string; display_name: string; protocol_version: string; streams: unknown[] },
>(manifest: T) {
  return {
    ...manifest,
    manifest_uri: `https://implementations.example/connectors/${manifest.connector_id}`,
    source_declaration: {
      declaration_version: `${manifest.connector_id}-declaration-v1`,
      display: { name: manifest.display_name },
      protocol_version: manifest.protocol_version,
      publisher: { id: "https://pdpp.dev/reference-implementation/tests" },
      source: { id: `https://registry.pdpp.dev/connectors/${manifest.connector_id}`, kind: "connector" },
      streams: manifest.streams,
    },
  };
}

// Two manifests with declared lexical_fields, designed to exercise
// cross-connector owner mode AND a stream name shared across both
// connectors. These are inline so the tests don't depend on any seed
// manifest beyond what they explicitly install.
const REDDITISH_MANIFEST_A = withCoreSourceDeclaration({
  capabilities: { human_interaction: ["credentials"] },
  connector_id: "redditish-a",
  display_name: "Redditish A",
  protocol_version: "0.1.0",
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
        search: { lexical_fields: ["title", "selftext"] },
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
        required: ["id"],
        type: "object",
      },
      selection: { fields: true, resources: false },
      semantics: "append_only",
    },
    {
      consent_time_field: "source_created_at",
      cursor_field: "source_created_at",
      name: "comments",
      primary_key: ["id"],
      query: { search: { lexical_fields: ["body"] } },
      schema: {
        properties: {
          body: { type: "string" },
          id: { type: "string" },
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
      // Non-participating stream. Proves the omit-query.search branch.
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
});

const REDDITISH_MANIFEST_B = withCoreSourceDeclaration({
  capabilities: { human_interaction: ["credentials"] },
  connector_id: "redditish-b",
  display_name: "Redditish B",
  protocol_version: "0.1.0",
  streams: [
    {
      consent_time_field: "source_created_at",
      cursor_field: "source_created_at",
      // Same stream NAME as in manifest A — exercises cross-connector
      // hits with shared stream name.
      name: "posts",
      primary_key: ["id"],
      query: {
        range_filters: {
          source_created_at: ["gte", "gt", "lte", "lt"],
        },
        search: { lexical_fields: ["title", "selftext"] },
      },
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
});

async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
  const clientId = "cli_longview";
  const { body: device } = await fetchJson<DeviceAuthorizationResponse>(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.ok(device, "device authorization response body");
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const { body: tokenBody } = await fetchJson<TokenResponse>(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.ok(tokenBody, "token response body");
  return tokenBody.access_token;
}

interface ApproveClientGrantParams {
  access_mode: string;
  client_id: string;
  purpose_code: string;
  purpose_description: string;
  source_id: string;
  streams: Array<{ fields?: string[]; name: string }>;
  subject_id?: string;
}

async function approveClientGrant(asUrl: string, params: ApproveClientGrantParams): Promise<ApprovedGrantResponse> {
  const { body: initiate, status: initiateStatus } = await fetchJson<ParInitiateResponse>(`${asUrl}/oauth/par`, {
    body: JSON.stringify({
      authorization_details: [
        {
          access_mode: params.access_mode,
          purpose_code: params.purpose_code,
          purpose_description: params.purpose_description,
          source: { id: params.source_id, kind: "connector" },
          streams: params.streams,
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: params.client_id,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(initiateStatus, 201, JSON.stringify(initiate));
  assert.ok(initiate, "PAR initiate response body");
  const subjectId = params.subject_id || "owner_local";
  const { body: review, status: reviewStatus } = await fetchJson<{ approval_review_revision?: unknown }>(
    `${asUrl}/consent/review`,
    {
      body: JSON.stringify({ request_uri: initiate.request_uri, subject_id: subjectId }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    }
  );
  assert.equal(reviewStatus, 200, JSON.stringify(review));
  assert.ok(review, "consent review response body");
  assert.equal(typeof review.approval_review_revision, "string", "consent review returns a revision");
  const { body: approved, status: approvalStatus } = await fetchJson<ApprovedGrantResponse>(
    `${asUrl}/consent/approve`,
    {
      body: JSON.stringify({
        approval_review_revision: review.approval_review_revision,
        request_uri: initiate.request_uri,
      }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    }
  );
  assert.equal(approvalStatus, 200, JSON.stringify(approved));
  assert.ok(approved, "consent approve response body");
  assert.ok(approved.token, `consent approval token: ${JSON.stringify(approved)}`);
  return approved;
}

interface IngestRecord {
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
  records: IngestRecord[]
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
    `${rsUrl}/v1/ingest/${encodeURIComponent(stream)}?connector_id=${encodeURIComponent(connectorId)}`,
    {
      body: ndjson,
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/x-ndjson" },
      method: "POST",
    }
  );
  assert.equal(resp.status, 200, `ingest ${stream} ok`);
}

interface WithHarnessOpts {
  lexicalRetrievalCapability?: Omit<LexicalRetrievalCapability, "supported"> & { supported: boolean };
  lexicalRetrievalSupported?: boolean;
}

interface HarnessContext {
  asUrl: string;
  rsUrl: string;
  server: StartedServer;
}

async function withHarness(opts: WithHarnessOpts, fn: (ctx: HarnessContext) => Promise<void>): Promise<void> {
  const startOpts = {
    asPort: 0,
    dbPath: ":memory:",
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    quiet: true,
    rsPort: 0,
    ...opts,
  };
  const server = (await startServer(startOpts)) as StartedServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    // Register both manifests so cross-connector owner search has something
    // to fan out across.
    for (const manifest of [REDDITISH_MANIFEST_A, REDDITISH_MANIFEST_B]) {
      // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
      const reg = await fetch(`${asUrl}/connectors`, {
        body: JSON.stringify(manifest),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(reg.status, 201, `register ${manifest.connector_id}`);
      await createRequestConnectorInstanceStore().ensureDefaultAccountConnection({
        connectorId: manifest.connector_id,
        displayName: `${manifest.display_name} test account`,
        now: new Date().toISOString(),
        ownerSubjectId: "owner_local",
      });
    }
    await fn({ asUrl, rsUrl, server });
  } finally {
    await closeServer(server);
  }
}

// ─── 9.1 / 9.2 — RS metadata advertisement ──────────────────────────────────

test("RS metadata advertises capabilities.lexical_retrieval with score support when supported", async () => {
  await withHarness({}, async ({ rsUrl }) => {
    // Reachable without a bearer token — onboarding requirement from the spec.
    const { status, body } = await fetchJson<MetadataDocument>(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(status, 200);
    assert.ok(body, "metadata response body");
    const cap = body.capabilities?.lexical_retrieval;
    assert.ok(cap, "capabilities.lexical_retrieval should be present");
    assert.equal(cap.supported, true);
    assert.equal(cap.endpoint, "/v1/search");
    assert.equal(cap.cross_stream, true);
    assert.equal(cap.snippets, true);
    assert.equal(cap.default_limit, 25);
    assert.equal(cap.max_limit, 100);
    assert.deepEqual(cap.score, {
      kind: "bm25",
      order: "lower_is_better",
      supported: true,
      value_semantics: "implementation_relative",
    });
  });
});

test("RS metadata omits/falses capabilities.lexical_retrieval when extension is disabled", async () => {
  await withHarness({ lexicalRetrievalSupported: false }, async ({ rsUrl }) => {
    const { status, body } = await fetchJson<MetadataDocument>(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(status, 200);
    assert.ok(body, "metadata response body");
    const cap = body.capabilities?.lexical_retrieval;
    // Either omitted entirely or explicitly { supported: false }.
    if (cap) {
      assert.equal(cap.supported, false);
    }
  });
});

// ─── 9.3 / 9.8 — happy-path shape ───────────────────────────────────────────

test("happy-path search returns list envelope with search_result entries (owner token)", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = REDDITISH_MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, "posts", [
      { id: "p1", selftext: "unexpected fee", source_created_at: "2026-04-01T00:00:00Z", title: "overdraft surprise" },
      { id: "p2", selftext: "al dente tips", source_created_at: "2026-04-02T00:00:00Z", title: "cooking pasta" },
    ]);

    const { status, body } = await fetchJson<SearchListResponse>(`${rsUrl}/v1/search?q=overdraft`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    assert.ok(body, "search response body");
    assert.equal(body.object, "list");
    assert.ok(Array.isArray(body.data));
    assert.equal(body.has_more, false);
    assert.ok(body.data.length >= 1, "should return at least one hit");
    const hit = body.data.find((r: SearchHit) => r.record_key === "p1");
    assert.ok(hit, "p1 should be in the hit list");
    assert.equal(hit.object, "search_result");
    assert.equal(hit.stream, "posts");
    assert.equal(hit.connector_id, connectorA);
    assert.ok(typeof hit.emitted_at === "string" && hit.emitted_at.length > 0);
    assert.equal(hit.authored_at, "2026-04-01T00:00:00Z");
    // Owner-mode record_url MUST include the canonical ?connector_id= query param
    assert.ok(hit.record_url.startsWith("/v1/streams/posts/records/p1?connector_id="));
    assert.ok(hit.record_url.includes(encodeURIComponent(connectorA)));
    // Required matched_fields, all from the declared lexical_fields set
    assert.ok(Array.isArray(hit.matched_fields) && hit.matched_fields.length >= 1);
    for (const f of hit.matched_fields) {
      assert.ok(["title", "selftext"].includes(f), `matched_fields ⊆ declared: got ${f}`);
    }
    assert.ok(hit.score, "hit should carry a score");
    assert.equal(hit.score.kind, "bm25");
    assert.equal(hit.score.order, "lower_is_better");
    assert.equal(typeof hit.score.value, "number");
    assert.ok(Number.isFinite(hit.score.value));
    // 'cooking pasta' must not match
    assert.equal(
      body.data.find((r: SearchHit) => r.record_key === "p2"),
      undefined
    );

    // Recall disclosure (disclose-lexical-recall-windows): a small corpus far
    // below the candidate window ranks ALL matches, so recall is complete and
    // the count is exact. The single 'overdraft' match yields count=1.
    assert.ok(body.meta, "envelope must carry meta");
    assert.equal(body.meta.count_accuracy, "exact");
    assert.equal(body.meta.count, 1);
    assert.equal(body.meta.recall.complete, true);
    assert.equal(body.meta.recall.ranking_scope, "all_matches");
    assert.equal(body.meta.recall.truncated, false);
  });
});

test("bounded candidate window: >200 matching records yields lower_bound count + candidate_window recall", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = REDDITISH_MANIFEST_A.connector_id;
    // Ingest 250 records all matching the same term so a single (stream, field)
    // FTS query fills the LIMIT 200 candidate window and reports truncation.
    // biome-ignore lint/suspicious/noEvolvingTypes: localized test assertion preserves its explicit contract.
    const records = [];
    for (let i = 0; i < 250; i += 1) {
      records.push({
        id: `w${i}`,
        selftext: "filler",
        source_created_at: "2026-04-01T00:00:00Z",
        title: `windowterm entry ${i}`,
      });
    }
    await ingest(rsUrl, ownerToken, connectorA, "posts", records);

    const { status, body } = await fetchJson<SearchListResponse>(`${rsUrl}/v1/search?q=windowterm`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    assert.ok(body, "search response body");
    assert.equal(body.object, "list");
    assert.ok(body.meta, "envelope must carry meta");
    // The window capped the candidate set, so the ranked set is not exhaustive.
    assert.equal(body.meta.count_accuracy, "lower_bound");
    assert.notEqual(body.meta.count_accuracy, "exact");
    assert.equal(body.meta.recall.complete, false);
    assert.equal(body.meta.recall.ranking_scope, "candidate_window");
    assert.equal(body.meta.recall.truncated, true);
    assert.equal(body.meta.recall.candidate_window_limit, 200);
    assert.ok(body.meta.recall.ranked_candidate_count !== undefined, "recall.ranked_candidate_count must be present");
    assert.ok(body.meta.recall.ranked_candidate_count >= 200);
    assert.ok(body.meta.recall.truncated_source_count !== undefined, "recall.truncated_source_count must be present");
    assert.ok(body.meta.recall.truncated_source_count >= 1);
    // count is a lower bound: at least what we ranked.
    assert.ok(body.meta.count >= 200);

    // Pagination is distinct from recall completeness: even after paging past
    // the first page (has_more flips on later pages), recall stays incomplete.
    const page1 = await fetchJson<SearchListResponse>(`${rsUrl}/v1/search?q=windowterm&limit=10`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.ok(page1.body, "page1 response body");
    assert.equal(page1.body.has_more, true);
    assert.ok(page1.body.meta, "page1 envelope must carry meta");
    assert.equal(page1.body.meta.recall.complete, false);
    assert.equal(page1.body.meta.recall.truncated, true);
    assert.ok(page1.body.next_cursor, "page1 must carry a next_cursor");
    // A cursor page reuses the persisted snapshot's recall facts verbatim.
    const page2 = await fetchJson<SearchListResponse>(
      `${rsUrl}/v1/search?q=windowterm&limit=10&cursor=${encodeURIComponent(page1.body.next_cursor)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.ok(page2.body, "page2 response body");
    assert.ok(page2.body.meta, "page2 envelope must carry meta");
    assert.equal(page2.body.meta.recall.complete, false);
    assert.equal(page2.body.meta.recall.ranking_scope, "candidate_window");
    assert.deepEqual(page2.body.meta.recall, page1.body.meta.recall);
  });
});

if (POSTGRES_URL) {
  test("postgres lexical recall reports effective candidate-window cap", async () => {
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `pg_lexical_recall_${suffix}`;
    const term = `pgwindowterm${suffix}`;
    const manifest = {
      capabilities: { human_interaction: ["credentials"] },
      connector_id: connectorId,
      display_name: "Postgres Lexical Recall",
      protocol_version: "0.1.0",
      streams: [
        {
          consent_time_field: "source_created_at",
          cursor_field: "source_created_at",
          name: "posts",
          primary_key: ["id"],
          query: { search: { lexical_fields: ["title"] } },
          schema: {
            properties: {
              id: { type: "string" },
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
    let server: StartedServer | null = null;
    const priorDatabaseUrl = process.env.PDPP_DATABASE_URL;
    const priorStorageBackend = process.env.PDPP_STORAGE_BACKEND;
    try {
      const databaseUrl = POSTGRES_URL;
      assert.ok(databaseUrl, "Postgres lexical window test requires PDPP_TEST_POSTGRES_URL");
      process.env.PDPP_DATABASE_URL = databaseUrl;
      process.env.PDPP_STORAGE_BACKEND = "postgres";
      server = (await startServer({
        asPort: 0,
        dbPath: ":memory:",
        dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
        quiet: true,
        reconcilePolyfillManifests: false,
        rsPort: 0,
      })) as StartedServer;
      const asUrl = `http://localhost:${server.asPort}`;
      const rsUrl = `http://localhost:${server.rsPort}`;
      const reg = await fetch(`${asUrl}/connectors`, {
        body: JSON.stringify(manifest),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(reg.status, 201, `register ${connectorId}`);
      const ownerToken = await issueOwnerToken(asUrl, `owner_pg_lexical_${suffix}`);
      const records: IngestRecord[] = [];
      for (let i = 0; i < 120; i += 1) {
        records.push({
          id: `pgw${i}`,
          source_created_at: "2026-04-01T00:00:00Z",
          title: `${term} entry ${i}`,
        });
      }
      await ingest(rsUrl, ownerToken, connectorId, "posts", records);
      // Derived-index publish is deferred/fire-and-forget (records.ts);
      // asserting on lexical content requires draining the per-connector-
      // instance index lane first, per drainConnectorInstanceIndexWork's own
      // documented contract for this exact case.
      await drainConnectorInstanceIndexWork();

      const { status, body } = await fetchJson<SearchListResponse>(
        `${rsUrl}/v1/search?q=${encodeURIComponent(term)}&limit=5`,
        { headers: { Authorization: `Bearer ${ownerToken}` } }
      );
      assert.equal(status, 200);
      assert.ok(body, "search response body");
      assert.ok(body.meta, "envelope must carry meta");
      assert.equal(body.meta.count_accuracy, "lower_bound");
      assert.equal(body.meta.count, 100);
      assert.equal(body.meta.recall.complete, false);
      assert.equal(body.meta.recall.ranking_scope, "candidate_window");
      assert.equal(body.meta.recall.truncated, true);
      assert.equal(body.meta.recall.candidate_window_limit, 100);
      assert.equal(body.meta.recall.ranked_candidate_count, 100);
      assert.equal(body.meta.recall.truncated_source_count, 1);
    } finally {
      if (server) {
        await closeServer(server);
      }
      await closePostgresStorage();
      closeDb();
      if (priorDatabaseUrl === undefined) {
        delete process.env.PDPP_DATABASE_URL;
      } else {
        process.env.PDPP_DATABASE_URL = priorDatabaseUrl;
      }
      if (priorStorageBackend === undefined) {
        delete process.env.PDPP_STORAGE_BACKEND;
      } else {
        process.env.PDPP_STORAGE_BACKEND = priorStorageBackend;
      }
    }
  });
} else {
  test("postgres lexical recall reports effective candidate-window cap (skipped: PDPP_TEST_POSTGRES_URL unset)", {
    skip: true,
    // biome-ignore lint/suspicious/noEmptyBlockStatements: localized test assertion preserves its explicit contract.
  }, () => {});
}

test("lexical search omits score when capability metadata does not advertise score support", async () => {
  await withHarness(
    {
      lexicalRetrievalCapability: {
        cross_stream: true,
        default_limit: 25,
        endpoint: "/v1/search",
        max_limit: 100,
        snippets: true,
        supported: true,
      },
    },
    async ({ asUrl, rsUrl }) => {
      const ownerToken = await issueOwnerToken(asUrl);
      const connectorA = REDDITISH_MANIFEST_A.connector_id;
      await ingest(rsUrl, ownerToken, connectorA, "posts", [
        {
          id: "p1",
          selftext: "unexpected fee",
          source_created_at: "2026-04-01T00:00:00Z",
          title: "overdraft surprise",
        },
      ]);

      const { body: metadata } = await fetchJson<MetadataDocument>(`${rsUrl}/.well-known/oauth-protected-resource`);
      assert.ok(metadata, "metadata response body");
      assert.equal(metadata.capabilities?.lexical_retrieval?.score, undefined);

      const { status, body } = await fetchJson<SearchListResponse>(`${rsUrl}/v1/search?q=overdraft`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(status, 200);
      assert.ok(body, "search response body");
      assert.equal(body.data[0]?.score, undefined);
    }
  );
});

// ─── 9.4 — missing q ────────────────────────────────────────────────────────

test("missing q returns invalid_request and identifies the missing param", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson<ErrorEnvelopeResponse>(`${rsUrl}/v1/search`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 400);
    assert.ok(body, "error response body");
    assert.equal(body.error.code, "invalid_request");
  });
});

// ─── 9.5 — disallowed v1 params ─────────────────────────────────────────────

test("disallowed v1 params are rejected with invalid_request", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const cases = [
      "filter%5Brecipient%5D=alice", // filter[recipient]=alice
      "rank=desc",
      "boost=2",
      "embedding=abc",
      "vector=xyz",
      "semantic=true",
      "order=asc",
      `connector_id=${encodeURIComponent(REDDITISH_MANIFEST_A.connector_id)}`,
    ];
    for (const param of cases) {
      // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
      const { status, body } = await fetchJson<ErrorEnvelopeResponse>(`${rsUrl}/v1/search?q=foo&${param}`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(status, 400, `expected 400 for ${param}, got ${status}`);
      // Schema-level rejection emits invalid_request from Fastify-AJV; runtime
      // rejection from search.js also emits invalid_request. Either is fine.
      assert.ok(body, `error response body for ${param}`);
      assert.equal(body.error.code, "invalid_request", `expected invalid_request for ${param}`);
    }
  });
});

test("filtered lexical search applies declared range, exact, and no-match filters", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = REDDITISH_MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, "posts", [
      {
        id: "old",
        score: 1,
        selftext: "",
        source_created_at: "2026-03-01T00:00:00Z",
        subreddit: "finance",
        title: "invoice alpha",
      },
      {
        id: "new",
        score: 5,
        selftext: "",
        source_created_at: "2026-04-10T00:00:00Z",
        subreddit: "finance",
        title: "invoice alpha",
      },
      {
        id: "other",
        score: 8,
        selftext: "",
        source_created_at: "2026-04-11T00:00:00Z",
        subreddit: "cooking",
        title: "invoice alpha",
      },
    ]);

    const range = await fetchJson<SearchListResponse>(
      `${rsUrl}/v1/search?q=invoice&streams=posts&filter[source_created_at][gte]=2026-04-01T00:00:00Z`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(range.status, 200);
    assert.ok(range.body, "range response body");
    assert.deepEqual(
      range.body.data
        .filter((r: SearchHit) => r.connector_id === connectorA)
        .map((r: SearchHit) => r.record_key)
        .sort(),
      ["new", "other"]
    );

    const exact = await fetchJson<SearchListResponse>(
      `${rsUrl}/v1/search?q=invoice&streams=posts&filter[source_created_at]=2026-04-10T00:00:00Z`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(exact.status, 200);
    assert.ok(exact.body, "exact response body");
    assert.deepEqual(
      exact.body.data
        .filter((r: SearchHit) => r.connector_id === connectorA)
        .map((r: SearchHit) => r.record_key)
        .sort(),
      ["new"]
    );

    const noMatch = await fetchJson<SearchListResponse>(
      `${rsUrl}/v1/search?q=invoice&streams=posts&filter[source_created_at]=2027-01-01T00:00:00Z`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(noMatch.status, 200);
    assert.ok(noMatch.body, "noMatch response body");
    assert.deepEqual(
      noMatch.body.data.filter((r: SearchHit) => r.connector_id === connectorA),
      []
    );
  });
});

test("filtered lexical search rejects invalid filter shapes and still-forbidden parameters", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = REDDITISH_MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, "posts", [
      {
        id: "p1",
        score: 5,
        selftext: "secret body",
        source_created_at: "2026-04-10T00:00:00Z",
        subreddit: "finance",
        title: "invoice alpha",
      },
    ]);

    const rejectedOwnerQueries = [
      "q=invoice&filter[source_created_at][gte]=2026-04-01T00:00:00Z",
      "q=invoice&streams=posts&streams=comments&filter[source_created_at][gte]=2026-04-01T00:00:00Z",
      "q=invoice&streams=posts&filter[subreddit][gte]=finance",
      "q=invoice&streams=posts&filter[source_created_at][between]=2026-04-01T00:00:00Z",
      "q=invoice&streams=posts&filter[source_created_at][gte]=not-a-date",
      "q=invoice&streams=posts&filter[source_created_at][gte]=2026-04-01T00:00:00Z&rank=recency",
      `q=invoice&streams=posts&filter[source_created_at][gte]=2026-04-01T00:00:00Z&connector_id=${encodeURIComponent(connectorA)}`,
    ];
    for (const query of rejectedOwnerQueries) {
      // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
      const { status, body } = await fetchJson<ErrorEnvelopeResponse>(`${rsUrl}/v1/search?${query}`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(status, 400, `expected 400 for ${query}`);
      assert.ok(body, `error response body for ${query}`);
      assert.equal(body.error.code, "invalid_request");
    }

    const approved = await approveClientGrant(asUrl, {
      access_mode: "continuous",
      client_id: "longview",
      purpose_code: "https://pdpp.dev/purpose/analytics",
      purpose_description: "lexical filtered retrieval test",
      source_id: REDDITISH_MANIFEST_A.source_declaration.source.id,
      streams: [{ fields: ["id", "title", "source_created_at"], name: "posts" }],
    });
    const unauthorized = await fetchJson<ErrorEnvelopeResponse>(
      `${rsUrl}/v1/search?q=invoice&streams=posts&filter[selftext]=secret`,
      { headers: { Authorization: `Bearer ${approved.token}` } }
    );
    assert.equal(unauthorized.status, 400);
    assert.ok(unauthorized.body, "unauthorized response body");
    assert.equal(unauthorized.body.error.code, "invalid_request");
  });
});

test("owner filtered lexical search fans out by stream across connectors without connector_id input", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    await ingest(rsUrl, ownerToken, REDDITISH_MANIFEST_A.connector_id, "posts", [
      {
        id: "a-filtered",
        score: 5,
        selftext: "",
        source_created_at: "2026-04-10T00:00:00Z",
        title: "sharedfilter invoice",
      },
    ]);
    await ingest(rsUrl, ownerToken, REDDITISH_MANIFEST_B.connector_id, "posts", [
      { id: "b-filtered", selftext: "", source_created_at: "2026-04-11T00:00:00Z", title: "sharedfilter invoice" },
    ]);

    const { status, body } = await fetchJson<SearchListResponse>(
      `${rsUrl}/v1/search?q=sharedfilter&streams=posts&filter[source_created_at][gte]=2026-04-01T00:00:00Z`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(status, 200);
    assert.ok(body, "search response body");
    const byConnector = new Map(body.data.map((hit: SearchHit) => [hit.connector_id, hit.record_key]));
    assert.equal(byConnector.get(REDDITISH_MANIFEST_A.connector_id), "a-filtered");
    assert.equal(byConnector.get(REDDITISH_MANIFEST_B.connector_id), "b-filtered");

    const publicConnectorParam = await fetchJson<ErrorEnvelopeResponse>(
      `${rsUrl}/v1/search?q=sharedfilter&streams=posts&filter[source_created_at][gte]=2026-04-01T00:00:00Z&connector_id=${encodeURIComponent(REDDITISH_MANIFEST_A.connector_id)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(publicConnectorParam.status, 400);
    assert.ok(publicConnectorParam.body, "publicConnectorParam response body");
    assert.equal(publicConnectorParam.body.error.code, "invalid_request");
  });
});

// ─── 9.6 — client streams[] hard error ──────────────────────────────────────

test("client-token streams[] not in grant returns grant_stream_not_allowed", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = REDDITISH_MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, "posts", [
      { id: "p1", selftext: "", source_created_at: "2026-04-01T00:00:00Z", title: "overdraft" },
    ]);

    // Use the pre-seeded `longview` client — see reference-local-defaults.js.
    // PAR requires explicit registered client_id values; longview is one of
    // the seeded launch consumers.
    const approved = await approveClientGrant(asUrl, {
      access_mode: "continuous",
      client_id: "longview",
      purpose_code: "https://pdpp.dev/purpose/analytics",
      purpose_description: "lexical retrieval test",
      source_id: REDDITISH_MANIFEST_A.source_declaration.source.id,
      streams: [{ fields: ["id", "title"], name: "posts" }], // posts only
    });

    // Asking for `comments` is NOT in the grant ⇒ hard error.
    const { status, body } = await fetchJson<ErrorEnvelopeResponse>(`${rsUrl}/v1/search?q=overdraft&streams=comments`, {
      headers: { Authorization: `Bearer ${approved.token}` },
    });
    assert.equal(status, 403);
    assert.ok(body, "error response body");
    assert.equal(body.error.code, "grant_stream_not_allowed");
  });
});

test("a current manifest without a granted stream returns typed not found on every retrieval route", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const approved = await approveClientGrant(asUrl, {
      access_mode: "continuous",
      client_id: "longview",
      purpose_code: "https://pdpp.dev/purpose/analytics",
      purpose_description: "current serving metadata regression",
      source_id: REDDITISH_MANIFEST_A.source_declaration.source.id,
      streams: [{ fields: ["id", "title"], name: "posts" }],
    });
    const currentManifest = {
      ...REDDITISH_MANIFEST_A,
      streams: REDDITISH_MANIFEST_A.streams.filter((stream) => stream.name !== "posts"),
    };
    const updated = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(currentManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(updated.status, 201, "remove the granted stream from the current manifest");

    for (const path of [
      "/v1/search?q=old&streams=posts",
      "/v1/search/semantic?q=old&streams=posts",
      "/v1/search/hybrid?q=old&streams=posts",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
      const { status, body } = await fetchJson<ErrorEnvelopeResponse>(`${rsUrl}${path}`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(status, 404, `${path}: ${JSON.stringify(body)}`);
      assert.ok(body, `error response body for ${path}`);
      assert.equal(body.error.code, "stream_not_declared", path);
    }
  });
});

// ─── 9.6 (owner half) — owner streams[] soft filter ─────────────────────────

test("owner-token streams[] unknown anywhere returns empty list (no error)", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = REDDITISH_MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, "posts", [
      { id: "p1", selftext: "", source_created_at: "2026-04-01T00:00:00Z", title: "overdraft" },
    ]);
    const { status, body } = await fetchJson<SearchListResponse>(
      `${rsUrl}/v1/search?q=overdraft&streams=nonexistent_stream_anywhere`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(status, 200);
    assert.ok(body, "search response body");
    assert.equal(body.object, "list");
    assert.deepEqual(body.data, []);
    assert.equal(body.has_more, false);
  });
});

// ─── 9.7 — cross_stream:false advertisement requires streams[] ──────────────

test("cross_stream:false advertisement requires streams[] in the request", async () => {
  await withHarness(
    {
      lexicalRetrievalCapability: {
        cross_stream: false,
        default_limit: 25,
        endpoint: "/v1/search",
        max_limit: 100,
        snippets: true,
        supported: true,
      },
    },
    async ({ asUrl, rsUrl }) => {
      const ownerToken = await issueOwnerToken(asUrl);
      const { status, body } = await fetchJson<ErrorEnvelopeResponse>(`${rsUrl}/v1/search?q=overdraft`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(status, 400);
      assert.ok(body, "error response body");
      assert.equal(body.error.code, "invalid_request");
    }
  );
});

// ─── 9.10 / 9.11 — grant subsetting + snippet grant safety (client) ─────────

test("client grant authorizing only one of two declared lexical_fields restricts matched_fields and snippet text", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = REDDITISH_MANIFEST_A.connector_id;
    // Two records: one matches only via `title`, one matches only via `selftext`.
    await ingest(rsUrl, ownerToken, connectorA, "posts", [
      {
        id: "p_title",
        selftext: "no match here",
        source_created_at: "2026-04-01T00:00:00Z",
        title: "apricot harvest notes",
      },
      {
        id: "p_self",
        selftext: "apricot tart recipe",
        source_created_at: "2026-04-02T00:00:00Z",
        title: "unrelated heading",
      },
    ]);

    // Approve a grant authorizing only `title` on posts (selftext NOT in grant).
    const approved = await approveClientGrant(asUrl, {
      access_mode: "continuous",
      client_id: "longview",
      purpose_code: "https://pdpp.dev/purpose/analytics",
      purpose_description: "lexical retrieval test",
      source_id: REDDITISH_MANIFEST_A.source_declaration.source.id,
      streams: [{ fields: ["id", "title"], name: "posts" }],
    });

    const { status, body } = await fetchJson<SearchListResponse>(`${rsUrl}/v1/search?q=apricot`, {
      headers: { Authorization: `Bearer ${approved.token}` },
    });
    assert.equal(status, 200);
    assert.ok(body, "search response body");
    // Title-matching record should appear with matched_fields = ['title']
    const titleHit = body.data.find((r: SearchHit) => r.record_key === "p_title");
    assert.ok(titleHit, "p_title should appear");
    assert.deepEqual(titleHit.matched_fields, ["title"]);
    assert.ok(titleHit.score, "titleHit should carry a score");
    assert.equal(titleHit.score.kind, "bm25");
    assert.equal(titleHit.score.order, "lower_is_better");
    assert.ok(Number.isFinite(titleHit.score.value));
    if (titleHit.snippet) {
      assert.equal(titleHit.snippet.field, "title");
      // Snippet must not quote ungranted `selftext` content. p_title's
      // selftext is "no match here" — ensure that string isn't in the snippet.
      assert.ok(
        !titleHit.snippet.text.includes("no match here"),
        `snippet should not leak ungranted selftext: got "${titleHit.snippet.text}"`
      );
    }
    // Selftext-matching record must NOT appear because its only match was
    // in an ungranted field.
    assert.equal(
      body.data.find((r: SearchHit) => r.record_key === "p_self"),
      undefined,
      "p_self must not appear because its match was in ungranted selftext"
    );
  });
});

// ─── 9.12 — zero overlap → zero hits ────────────────────────────────────────

test("lexical evidence excerpts include bounded surrounding context", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = REDDITISH_MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, "posts", [
      {
        id: "p_context",
        selftext:
          "Before the decision we compared routes carefully. Are we going to bridge using Hyperlane or LayerZero for this rollout? LayerZero for sure, but keep the fallback documented.",
        source_created_at: "2026-04-01T00:00:00Z",
        title: "bridge planning",
      },
    ]);

    const { status, body } = await fetchJson<SearchListResponse>(`${rsUrl}/v1/search?q=Hyperlane&streams=posts`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    assert.equal(status, 200);
    assert.ok(body, "search response body");
    const hit = body.data.find((r: SearchHit) => r.record_key === "p_context");
    assert.ok(hit, "context hit should appear");
    const excerpt = hit.evidence_excerpts?.find(
      (item: EvidenceExcerpt) => item.field_path === "selftext"
    )?.preview_text;
    assert.ok(excerpt, "search hit must include a selftext evidence excerpt");
    assert.notEqual(excerpt.trim(), "<mark>Hyperlane</mark>");
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(excerpt, /bridge using/);
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(excerpt, /<mark>Hyperlane<\/mark>/);
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(excerpt, /LayerZero/);
  });
});

test("grant with zero overlap on searchable fields contributes zero hits and no per-stream error", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = REDDITISH_MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, "posts", [
      { id: "p1", selftext: "apricot", source_created_at: "2026-04-01T00:00:00Z", title: "apricot" },
    ]);
    // Grant only `id` — neither title nor selftext is authorized.
    const approved = await approveClientGrant(asUrl, {
      access_mode: "continuous",
      client_id: "longview",
      purpose_code: "https://pdpp.dev/purpose/analytics",
      purpose_description: "lexical retrieval test",
      source_id: REDDITISH_MANIFEST_A.source_declaration.source.id,
      streams: [{ fields: ["id"], name: "posts" }],
    });
    assert.deepEqual(approved.grant?.streams?.[0]?.fields, ["id"], "issued grant keeps the approved field boundary");
    const { status, body } = await fetchJson<SearchListResponse>(`${rsUrl}/v1/search?q=apricot`, {
      headers: { Authorization: `Bearer ${approved.token}` },
    });
    assert.equal(status, 200);
    assert.ok(body, "search response body");
    assert.deepEqual(body.data, []);
  });
});

// ─── 9.13 — pagination round-trip + cross-surface invalid_cursor ────────────

test("pagination round-trip works and search cursors are not interchangeable with record-list cursors", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = REDDITISH_MANIFEST_A.connector_id;
    const records = Array.from({ length: 7 }, (_, i) => ({
      id: `p${i}`,
      selftext: "",
      source_created_at: `2026-04-${String(10 + i).padStart(2, "0")}T00:00:00Z`,
      title: `apricot page ${i}`,
    }));
    await ingest(rsUrl, ownerToken, connectorA, "posts", records);

    const page1 = await fetchJson<SearchListResponse>(`${rsUrl}/v1/search?q=apricot&limit=3`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(page1.status, 200);
    assert.ok(page1.body, "page1 response body");
    assert.equal(page1.body.has_more, true);
    assert.ok(typeof page1.body.next_cursor === "string" && page1.body.next_cursor.length > 0);
    assert.equal(page1.body.data.length, 3);

    const page2 = await fetchJson<SearchListResponse>(
      `${rsUrl}/v1/search?q=apricot&limit=3&cursor=${encodeURIComponent(page1.body.next_cursor)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(page2.status, 200);
    assert.ok(page2.body, "page2 response body");
    assert.equal(page2.body.data.length, 3);
    // No record_key duplicated between pages
    const firstKeys = new Set(page1.body.data.map((r: SearchHit) => r.record_key));
    for (const r of page2.body.data) {
      assert.ok(!firstKeys.has(r.record_key), `cursor should advance: ${r.record_key} dup`);
    }

    // Reusing the search cursor on /v1/streams/posts/records is rejected.
    const wrongSurface = await fetchJson<ErrorEnvelopeResponse>(
      `${rsUrl}/v1/streams/posts/records?connector_id=${encodeURIComponent(connectorA)}&cursor=${encodeURIComponent(page1.body.next_cursor)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.ok(
      wrongSurface.status === 400 || wrongSurface.status === 410,
      `record-list should reject the search cursor (got ${wrongSurface.status})`
    );
    assert.ok(wrongSurface.body, "wrongSurface response body");
    assert.equal(wrongSurface.body.error.code, "invalid_cursor");
  });
});

// ─── over-cap limit surfaces a limit_clamped warning over the wire ──────────
//
// Spec: openspec/changes/add-search-limit-clamp-warning/specs/
//       reference-implementation-architecture/spec.md
//       (#"Search-retrieval limit is clamped to the page maximum")
//
// This is the native-shell coverage that the operation-level warning tests
// cannot give: it proves the `limit_clamped` warning the operation produces is
// carried by `runLexicalSearch` through `finalizeCanonicalEnvelope` onto the
// REST response, rather than being dropped at the host boundary.

test("over-cap limit returns <=100 hits and a limit_clamped warning in meta.warnings; in-range limit does not", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = REDDITISH_MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, "posts", [
      { id: "p1", selftext: "", source_created_at: "2026-04-01T00:00:00Z", title: "durian delight" },
    ]);

    // limit=500 > 100 → clamped, warning present, page still bounded.
    const over = await fetchJson<SearchListResponse>(`${rsUrl}/v1/search?q=durian&limit=500`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(over.status, 200);
    assert.ok(over.body, "over response body");
    assert.ok(over.body.data.length <= 100, "over-cap request is still bounded to <=100 hits");
    const clamp = (over.body.meta?.warnings || []).find((w: SearchWarning) => w.code === "limit_clamped");
    assert.ok(clamp, "expected a limit_clamped warning to reach the REST response");
    assert.equal(clamp.param, "limit");
    assert.ok(clamp.detail, "clamp warning should carry detail");
    assert.equal(clamp.detail.requested_limit, 500);
    assert.equal(clamp.detail.max_limit, 100);

    // In-range limit (and exactly 100) → no limit_clamped warning.
    for (const limit of [5, 100]) {
      // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
      const ok = await fetchJson<SearchListResponse>(`${rsUrl}/v1/search?q=durian&limit=${limit}`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(ok.status, 200);
      assert.ok(ok.body, `ok response body for limit=${limit}`);
      const w = (ok.body.meta?.warnings || []).find((x: SearchWarning) => x.code === "limit_clamped");
      assert.equal(w, undefined, `limit=${limit} must not emit a limit_clamped warning`);
    }
  });
});

// ─── 9.14 — /_ref/search and /v1/search are independent ─────────────────────

test("/_ref/search returns spine shape, /v1/search returns list shape — they do not alias", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    // /_ref/search is on the AS side (control plane). /v1/search is on the RS.
    const refResp = await fetchJson<RefSearchSpineResponse>(`${asUrl}/_ref/search?q=anything`);
    assert.equal(refResp.status, 200);
    assert.ok(refResp.body, "refResp response body");
    assert.equal(refResp.body.object, "search_result");
    assert.ok(
      "exact" in refResp.body && "traces" in refResp.body && "grants" in refResp.body && "runs" in refResp.body,
      "/_ref/search returns the spine artifact-jump shape"
    );

    const v1Resp = await fetchJson<SearchListResponse>(`${rsUrl}/v1/search?q=anything`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(v1Resp.status, 200);
    assert.ok(v1Resp.body, "v1Resp response body");
    assert.equal(v1Resp.body.object, "list");
    assert.ok(Array.isArray(v1Resp.body.data), "/v1/search returns the list-of-search_result envelope");
  });
});

// ─── 9.15 — manifest validator rejects bad lexical_fields shapes ────────────

test("manifest validator rejects bad lexical_fields shapes", async () => {
  await withHarness({}, async ({ asUrl }) => {
    const baseStream = (overrides: Record<string, unknown>) => ({
      consent_time_field: null,
      cursor_field: null,
      name: "tweaked",
      primary_key: ["id"],
      schema: {
        properties: {
          id: { type: "string" },
          score: { type: "integer" },
          tags: { items: { type: "string" }, type: "array" },
          title: { type: "string" },
        },
        required: ["id"],
        type: "object",
      },
      selection: { fields: true, resources: false },
      semantics: "append_only",
      ...overrides,
    });

    const cases = [
      { label: "empty array", query: { search: { lexical_fields: [] } } },
      { label: "non-array", query: { search: { lexical_fields: "title" } } },
      { label: "nested path", query: { search: { lexical_fields: ["data.body"] } } },
      { label: "array-typed", query: { search: { lexical_fields: ["tags"] } } },
      { label: "unknown field", query: { search: { lexical_fields: ["nope"] } } },
      { label: "integer-typed", query: { search: { lexical_fields: ["score"] } } },
    ];
    for (const c of cases) {
      const manifest = {
        capabilities: { human_interaction: ["credentials"] },
        connector_id: `https://test.pdpp.dev/connectors/bad-${encodeURIComponent(c.label)}`,
        display_name: `bad-${c.label}`,
        protocol_version: "0.1.0",
        streams: [baseStream({ query: c.query })],
        version: "1.0.0",
      };
      // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
      const resp = await fetch(`${asUrl}/connectors`, {
        body: JSON.stringify(manifest),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const text = await resp.text();
      assert.ok(resp.status >= 400 && resp.status < 500, `${c.label}: expected 4xx, got ${resp.status} ${text}`);
    }
  });
});

// ─── 9.17 — cross-connector owner-mode fan-out ──────────────────────────────

test("owner-mode search fans out across connectors and attributes hits to their originating connector", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const cA = REDDITISH_MANIFEST_A.connector_id;
    const cB = REDDITISH_MANIFEST_B.connector_id;
    await ingest(rsUrl, ownerToken, cA, "posts", [
      { id: "pA1", selftext: "", source_created_at: "2026-04-01T00:00:00Z", title: "persimmon season" },
    ]);
    await ingest(rsUrl, ownerToken, cB, "posts", [
      { id: "pB1", selftext: "", source_created_at: "2026-04-02T00:00:00Z", title: "persimmon recipe" },
    ]);

    const { status, body } = await fetchJson<SearchListResponse>(`${rsUrl}/v1/search?q=persimmon`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    assert.ok(body, "search response body");
    const fromA = body.data.find((r: SearchHit) => r.record_key === "pA1");
    const fromB = body.data.find((r: SearchHit) => r.record_key === "pB1");
    assert.ok(fromA, "hit from connector A");
    assert.ok(fromB, "hit from connector B");
    assert.equal(fromA.connector_id, cA);
    assert.equal(fromB.connector_id, cB);
    assert.equal(fromA.stream, "posts");
    assert.equal(fromB.stream, "posts");
  });
});

// ─── 9.18 — owner-mode hydration round-trip ─────────────────────────────────

test("owner-mode record_url is dereference-able and returns the canonical record envelope", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const cA = REDDITISH_MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, cA, "posts", [
      { id: "p1", selftext: "", source_created_at: "2026-04-01T00:00:00Z", title: "cherimoya cultivation" },
    ]);
    const search = await fetchJson<SearchListResponse>(`${rsUrl}/v1/search?q=cherimoya`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(search.status, 200);
    assert.ok(search.body, "search response body");
    // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
    const hit = search.body.data[0];
    assert.ok(hit, "should return one hit");
    // record_url is server-relative; combine with rsUrl for the GET.
    const fetched = await fetchJson<RecordEnvelopeResponse>(`${rsUrl}${hit.record_url}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(fetched.status, 200, `hydration GET ${rsUrl}${hit.record_url} should succeed`);
    assert.ok(fetched.body, "fetched response body");
    assert.equal(fetched.body.object, "record");
    assert.equal(fetched.body.id, "p1");
    assert.equal(fetched.body.stream, "posts");
  });
});

test("lexical search treats punctuation and hyphens as user text, not FTS syntax", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = REDDITISH_MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, "posts", [
      { id: "p1", selftext: "cleanup note", source_created_at: "2026-04-01T00:00:00Z", title: "style-driven refactor" },
    ]);

    const { status, body } = await fetchJson<SearchListResponse>(
      `${rsUrl}/v1/search?q=${encodeURIComponent("style-driven")}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(status, 200);
    assert.ok(body, "search response body");
    assert.ok(
      body.data.some((r: SearchHit) => r.record_key === "p1"),
      "hyphenated query should match without SQLITE_ERROR"
    );
  });
});

// ─── 9.9 — helper-level: results without record_url/snippet are still valid ─

test("buildSearchPlanForGrant honors declared ∩ authorized; parseSearchParams enforces v1 allowlist", () => {
  const manifest = {
    streams: [
      { name: "posts", query: { search: { lexical_fields: ["title", "selftext"] } } },
      { name: "comments", query: { search: { lexical_fields: ["body"] } } },
      { name: "saved" }, // non-participating
    ],
  };
  const grantAllPosts = { streams: [{ name: "posts" }] };
  const planAll = buildSearchPlanForGrant({ grant: grantAllPosts, manifest, streamsFilter: null });
  assert.deepEqual(planAll, [{ searchableFields: ["title", "selftext"], streamName: "posts" }]);

  const grantTitleOnly = { streams: [{ fields: ["title"], name: "posts" }] };
  const planSubset = buildSearchPlanForGrant({ grant: grantTitleOnly, manifest, streamsFilter: null });
  assert.deepEqual(planSubset, [{ searchableFields: ["title"], streamName: "posts" }]);

  const grantUnrelatedFields = { streams: [{ fields: ["id"], name: "posts" }] };
  const planEmpty = buildSearchPlanForGrant({ grant: grantUnrelatedFields, manifest, streamsFilter: null });
  assert.deepEqual(planEmpty, []);

  // Streams filter narrows to a single participating stream
  const grantBoth = { streams: [{ name: "posts" }, { name: "comments" }] };
  const planFiltered = buildSearchPlanForGrant({ grant: grantBoth, manifest, streamsFilter: ["comments"] });
  assert.deepEqual(planFiltered, [{ searchableFields: ["body"], streamName: "comments" }]);

  // parseSearchParams: q required
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.throws(() => parseSearchParams({}), /q is required/);
  // parseSearchParams: connector_id rejected
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.throws(() => parseSearchParams({ connector_id: "x", q: "foo" }), /Unsupported query parameter: connector_id/);
  // parseSearchParams: filter requires exactly one stream and then passes through
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.throws(() => parseSearchParams({ filter: { title: "foo" }, q: "foo" }), /requires exactly one/);
  const filtered = parseSearchParams({ filter: { title: "foo" }, q: "foo", streams: "posts" });
  assert.deepEqual(filtered.filter, { title: "foo" });
  assert.equal(filtered.filteredStream, "posts");
  // parseSearchParams: streams[] normalized
  const ok = parseSearchParams({ q: "foo", streams: "posts" });
  assert.equal(ok.q, "foo");
  assert.deepEqual(ok.streams, ["posts"]);
  // parseSearchParams: streams as array stays an array
  const ok2 = parseSearchParams({ q: "foo", streams: ["posts", "comments"] });
  assert.deepEqual(ok2.streams, ["posts", "comments"]);
  // parseSearchParams: limit clamps and defaults
  assert.equal(parseSearchParams({ q: "foo" }).limit, 25);
  assert.equal(parseSearchParams({ limit: "500", q: "foo" }).limit, 100);
  assert.equal(parseSearchParams({ limit: "7", q: "foo" }).limit, 7);
});

// ─── startup drift-detect + rebuild ─────────────────────────────────────────

/**
 * Pre-existing records become searchable when a manifest later declares
 * lexical_fields, without requiring any record rewrite or re-ingest.
 *
 * Scenario:
 *   1. Register a connector manifest WITHOUT query.search.lexical_fields.
 *   2. Ingest records.
 *   3. Re-register the same connector with the SAME records still in the DB,
 *      but now declaring lexical_fields. This is the "operator turns the
 *      extension on for an existing stream" case.
 *   4. Issue /v1/search — the historical records must show up immediately.
 *
 * Without the registerConnector backfill hook, step (4) would return zero
 * hits because the FTS5 write-path maintenance only runs on subsequent
 * record writes, not on records that already existed.
 */
test("pre-existing records become searchable after lexical_fields are declared (no re-ingest)", async () => {
  // Bypass the standard withHarness — it pre-registers manifests with
  // lexical_fields already declared, which would skip past the case under
  // test. Run a bespoke harness that registers a non-participating manifest
  // first.
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    quiet: true,
    rsPort: 0,
  })) as StartedServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  // A v1 connector manifest WITHOUT lexical_fields. Same connector_id,
  // schema, and primary_key as the eventual v2 — only the query.search
  // block differs.
  const CONNECTOR_ID = "late-bloomer";
  const baseStream = (overrides = {}) => ({
    consent_time_field: "source_created_at",
    cursor_field: "source_created_at",
    name: "posts",
    primary_key: ["id"],
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
    ...overrides,
  });
  const manifestV1 = withCoreSourceDeclaration({
    capabilities: { human_interaction: ["credentials"] },
    connector_id: CONNECTOR_ID,
    display_name: "Late Bloomer",
    protocol_version: "0.1.0",
    streams: [baseStream()],
    version: "1.0.0",
  });
  const manifestV2 = withCoreSourceDeclaration({
    ...manifestV1,
    streams: [
      baseStream({
        query: { search: { lexical_fields: ["title", "selftext"] } },
      }),
    ],
    version: "2.0.0",
  });

  try {
    // (1) Register without lexical_fields.
    const regV1 = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifestV1),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(regV1.status, 201);

    // (2) Ingest records BEFORE the extension is enabled. These records
    // never reach lexical write-path maintenance because the manifest
    // declares no lexical_fields at the time of write.
    const ownerToken = await issueOwnerToken(asUrl);
    await ingest(rsUrl, ownerToken, CONNECTOR_ID, "posts", [
      {
        id: "h1",
        selftext: "no index yet",
        source_created_at: "2026-04-01T00:00:00Z",
        title: "pre-existing watermelon harvest",
      },
      {
        id: "h2",
        selftext: "watermelon stays crisp",
        source_created_at: "2026-04-02T00:00:00Z",
        title: "cold storage notes",
      },
      { id: "h3", selftext: "no match here", source_created_at: "2026-04-03T00:00:00Z", title: "unrelated heading" },
    ]);

    // Sanity check: the index has zero rows for this stream because the
    // manifest declared no lexical_fields when the records arrived.
    const baselineSearch = await fetchJson<SearchListResponse>(`${rsUrl}/v1/search?q=watermelon`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(baselineSearch.status, 200);
    assert.ok(baselineSearch.body, "baselineSearch response body");
    const baselineMatchedFromLateBloomer = baselineSearch.body.data.filter(
      (r: SearchHit) => r.connector_id === CONNECTOR_ID
    );
    assert.deepEqual(
      baselineMatchedFromLateBloomer,
      [],
      "before the extension is enabled, the late-bloomer connector contributes zero hits"
    );

    // (3) Re-register the SAME connector_id with lexical_fields declared.
    // No record rewrite; no re-ingest; the records table is untouched.
    const regV2 = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifestV2),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(regV2.status, 201);

    // (4) Search should now return the historical records. This proves the
    // registerConnector backfill hook in auth.js + the
    // lexicalIndexBackfillForManifest helper in search.js do the right thing.
    const afterBackfill = await fetchJson<SearchListResponse>(`${rsUrl}/v1/search?q=watermelon`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(afterBackfill.status, 200);
    assert.ok(afterBackfill.body, "afterBackfill response body");
    const matched = afterBackfill.body.data
      .filter((r: SearchHit) => r.connector_id === CONNECTOR_ID)
      .map((r: SearchHit) => r.record_key)
      .sort();
    assert.deepEqual(
      matched,
      ["h1", "h2"],
      "historical records must be searchable after lexical_fields are declared, with no re-ingest"
    );
    // h3 has no match anywhere — must NOT appear.
    assert.equal(
      afterBackfill.body.data.find((r: SearchHit) => r.record_key === "h3"),
      undefined,
      "records that do not match q must not appear, even after backfill"
    );

    // The backfill is idempotent: re-register again with the same v2
    // manifest and the result count must be unchanged.
    const regV2Again = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifestV2),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(regV2Again.status, 201);
    const afterIdempotentBackfill = await fetchJson<SearchListResponse>(`${rsUrl}/v1/search?q=watermelon`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.ok(afterIdempotentBackfill.body, "afterIdempotentBackfill response body");
    const matchedAgain = afterIdempotentBackfill.body.data
      .filter((r: SearchHit) => r.connector_id === CONNECTOR_ID)
      .map((r: SearchHit) => r.record_key)
      .sort();
    assert.deepEqual(
      matchedAgain,
      ["h1", "h2"],
      "idempotent: re-registering with the same lexical_fields does not duplicate or drop hits"
    );
  } finally {
    await closeServer(server);
  }
});

/**
 * Regression: same-cardinality field-set change must trigger backfill.
 *
 * The earlier drift detector treated indexCount > 0 && indexCount within
 * the [1, recordCount * declaredFields.length] band as "in sync" — but
 * that band is satisfied by stale rows from the previous declaration when
 * the field count is unchanged. Owner reproduced the failure on this
 * branch with ['title'] -> ['selftext']: re-registering with the new
 * field set returned zero hits for selftext-only matches.
 *
 * The fix is a per-(connector, stream) fingerprint of the declared
 * lexical_fields persisted in lexical_search_meta. A fingerprint
 * mismatch forces rebuild even when the row count is plausible.
 */
test("manifest update that swaps lexical_fields (same cardinality) rebuilds the index", async () => {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    quiet: true,
    rsPort: 0,
  })) as StartedServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  const CONNECTOR_ID = "field-swap";
  const baseStream = (overrides = {}) => ({
    consent_time_field: "source_created_at",
    cursor_field: "source_created_at",
    name: "posts",
    primary_key: ["id"],
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
    ...overrides,
  });

  // v1: lexical_fields = ['title']. v2: lexical_fields = ['selftext'].
  // Same cardinality (1) — defeats the row-count heuristic on its own.
  const manifestV1 = withCoreSourceDeclaration({
    capabilities: { human_interaction: ["credentials"] },
    connector_id: CONNECTOR_ID,
    display_name: "Field Swap",
    protocol_version: "0.1.0",
    streams: [baseStream({ query: { search: { lexical_fields: ["title"] } } })],
    version: "1.0.0",
  });
  const manifestV2 = withCoreSourceDeclaration({
    ...manifestV1,
    streams: [baseStream({ query: { search: { lexical_fields: ["selftext"] } } })],
    version: "2.0.0",
  });

  try {
    // Register v1 (title-searchable).
    let reg = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifestV1),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(reg.status, 201);

    const ownerToken = await issueOwnerToken(asUrl);
    // Records whose target term ('blueberry') lives ONLY in selftext, not
    // in title. Under v1 these contribute zero hits; under v2 they should
    // appear after the field-set swap.
    await ingest(rsUrl, ownerToken, CONNECTOR_ID, "posts", [
      {
        id: "s1",
        selftext: "blueberry preserves recipe",
        source_created_at: "2026-04-01T00:00:00Z",
        title: "first heading",
      },
      {
        id: "s2",
        selftext: "farmers market blueberry haul",
        source_created_at: "2026-04-02T00:00:00Z",
        title: "second heading",
      },
      { id: "s3", selftext: "no match here", source_created_at: "2026-04-03T00:00:00Z", title: "third heading" },
    ]);

    // To make the drift detector's row-count heuristic legitimately think
    // the index is "in sync" after the v2 swap, we need it to actually
    // have plausible content under v1. Ingest a record whose 'blueberry'
    // term DOES appear in title under v1 — and a few other title-only
    // records — so the index has rows when v2 arrives.
    await ingest(rsUrl, ownerToken, CONNECTOR_ID, "posts", [
      {
        id: "t1",
        selftext: "unrelated body",
        source_created_at: "2026-04-04T00:00:00Z",
        title: "blueberry season opens",
      },
      {
        id: "t2",
        selftext: "unrelated body",
        source_created_at: "2026-04-05T00:00:00Z",
        title: "spring planting notes",
      },
      {
        id: "t3",
        selftext: "unrelated body",
        source_created_at: "2026-04-06T00:00:00Z",
        title: "autumn pruning notes",
      },
    ]);

    // Sanity: under v1, only the title-match record should appear.
    const v1Search = await fetchJson<SearchListResponse>(`${rsUrl}/v1/search?q=blueberry`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(v1Search.status, 200);
    assert.ok(v1Search.body, "v1Search response body");
    const v1Matched = v1Search.body.data
      .filter((r: SearchHit) => r.connector_id === CONNECTOR_ID)
      .map((r: SearchHit) => r.record_key)
      .sort();
    assert.deepEqual(
      v1Matched,
      ["t1"],
      'under v1 (lexical_fields=["title"]), only the title-match record should appear'
    );

    // Re-register v2: same connector_id, same streams, lexical_fields
    // changed from ['title'] to ['selftext']. Same cardinality.
    reg = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifestV2),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(reg.status, 201);

    // Under v2, the selftext-match records (s1, s2) MUST appear, and the
    // v1-only title-match (t1) MUST disappear because 'blueberry' is no
    // longer in any indexed field for that record.
    const v2Search = await fetchJson<SearchListResponse>(`${rsUrl}/v1/search?q=blueberry`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(v2Search.status, 200);
    assert.ok(v2Search.body, "v2Search response body");
    const v2Matched = v2Search.body.data
      .filter((r: SearchHit) => r.connector_id === CONNECTOR_ID)
      .map((r: SearchHit) => r.record_key)
      .sort();
    assert.deepEqual(
      v2Matched,
      ["s1", "s2"],
      'after swapping lexical_fields from ["title"] to ["selftext"] (same cardinality), ' +
        "historical selftext-only matches must appear and stale title-only matches must not"
    );

    // matched_fields on the v2 hits must reflect the new declaration.
    for (const hit of v2Search.body.data.filter((r: SearchHit) => r.connector_id === CONNECTOR_ID)) {
      assert.deepEqual(
        hit.matched_fields,
        ["selftext"],
        `hit ${hit.record_key} should have matched_fields=['selftext'] under v2, got ${JSON.stringify(hit.matched_fields)}`
      );
    }

    // Round-trip back to v1 to confirm the fingerprint check works in both
    // directions: re-registering v1 must restore title-only matching.
    reg = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifestV1),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(reg.status, 201);
    const v1Again = await fetchJson<SearchListResponse>(`${rsUrl}/v1/search?q=blueberry`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.ok(v1Again.body, "v1Again response body");
    const v1AgainMatched = v1Again.body.data
      .filter((r: SearchHit) => r.connector_id === CONNECTOR_ID)
      .map((r: SearchHit) => r.record_key)
      .sort();
    assert.deepEqual(
      v1AgainMatched,
      ["t1"],
      'reverting lexical_fields from ["selftext"] back to ["title"] must restore title-only matching'
    );
  } finally {
    await closeServer(server);
  }
});

/**
 * Regression: restarting on an existing polyfill DB must backfill lexical
 * search for already-registered connectors, without requiring a fresh
 * POST /connectors call.
 *
 * This simulates the real failure mode on localhost:
 *   1. A DB already contains connector manifests + records.
 *   2. The lexical FTS tables are empty (e.g. DB created before the
 *      lexical retrieval tranche landed).
 *   3. Server restarts in polyfill mode.
 *   4. /v1/search must return historical hits immediately.
 */
test("startup backfills existing polyfill connectors without re-registration", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pdpp-lexical-restart-"));
  const dbPath = join(tempDir, "pdpp.sqlite");

  const bootServer = async (): Promise<StartedServer> =>
    (await startServer({
      asPort: 0,
      dbPath,
      dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
      quiet: true,
      rsPort: 0,
    })) as StartedServer;

  let server = await bootServer();
  let asUrl = `http://localhost:${server.asPort}`;
  let rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const reg = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(REDDITISH_MANIFEST_A),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(reg.status, 201, "register connector");

    const ownerToken = await issueOwnerToken(asUrl);
    await ingest(rsUrl, ownerToken, REDDITISH_MANIFEST_A.connector_id, "posts", [
      {
        id: "restart-p1",
        selftext: "historical lexical hit",
        source_created_at: "2026-04-01T00:00:00Z",
        title: "the owner orchard notes",
      },
    ]);

    const beforeRestart = await fetchJson<SearchListResponse>(`${rsUrl}/v1/search?q=the owner`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(beforeRestart.status, 200);
    assert.ok(beforeRestart.body, "beforeRestart response body");
    assert.ok(
      beforeRestart.body.data.some((r: SearchHit) => r.record_key === "restart-p1"),
      "sanity: record is searchable before restart"
    );

    await closeServer(server);
    closeDb();

    await initDb(dbPath);
    const db = getDb();
    db.prepare("DELETE FROM lexical_search_index").run();
    db.prepare("DELETE FROM lexical_search_meta").run();
    closeDb();

    server = await bootServer();
    await server.startupBackfillDone;
    asUrl = `http://localhost:${server.asPort}`;
    rsUrl = `http://localhost:${server.rsPort}`;

    const ownerTokenAfterRestart = await issueOwnerToken(asUrl);
    const afterRestart = await fetchJson<SearchListResponse>(`${rsUrl}/v1/search?q=the owner`, {
      headers: { Authorization: `Bearer ${ownerTokenAfterRestart}` },
    });
    assert.equal(afterRestart.status, 200);
    assert.ok(afterRestart.body, "afterRestart response body");
    assert.ok(
      afterRestart.body.data.some((r: SearchHit) => r.record_key === "restart-p1"),
      "startup backfill should restore historical hits without re-registration"
    );
  } finally {
    // biome-ignore lint/suspicious/noEmptyBlockStatements: localized test assertion preserves its explicit contract.
    await closeServer(server).catch(() => {});
    closeDb();
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("startup backfill treats records with only empty lexical field values as in sync", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pdpp-lexical-empty-restart-"));
  const dbPath = join(tempDir, "pdpp.sqlite");

  const bootServer = async (): Promise<StartedServer> =>
    (await startServer({
      asPort: 0,
      dbPath,
      dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
      quiet: true,
      rsPort: 0,
    })) as StartedServer;

  let server = await bootServer();
  // biome-ignore lint/suspicious/noEvolvingTypes: localized test assertion preserves its explicit contract.
  let originalMetaUpdatedAt = null;
  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const reg = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(REDDITISH_MANIFEST_A),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(reg.status, 201, "register connector");

    const ownerToken = await issueOwnerToken(asUrl);
    await ingest(rsUrl, ownerToken, REDDITISH_MANIFEST_A.connector_id, "posts", [
      {
        id: "empty-lexical-1",
        selftext: "",
        source_created_at: "2026-04-01T00:00:00Z",
        title: "",
      },
    ]);

    const db = getDb();
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS n FROM lexical_search_index WHERE connector_id = ? AND stream = ?")
        .get(REDDITISH_MANIFEST_A.connector_id, "posts")?.n,
      0,
      "empty lexical fields should not write FTS rows"
    );
    originalMetaUpdatedAt =
      db
        .prepare(`
      SELECT updated_at
      FROM lexical_search_meta
      WHERE connector_id = ? AND stream = ?
    `)
        .get(REDDITISH_MANIFEST_A.connector_id, "posts")?.updated_at ?? null;
    assert.ok(originalMetaUpdatedAt, "registration backfill should write lexical meta");

    await closeServer(server);
    closeDb();
    await new Promise((resolve) => setTimeout(resolve, 5));

    server = await bootServer();
    await server.startupBackfillDone;

    const restartedDb = getDb();
    assert.equal(
      restartedDb
        .prepare("SELECT COUNT(*) AS n FROM lexical_search_index WHERE connector_id = ? AND stream = ?")
        .get(REDDITISH_MANIFEST_A.connector_id, "posts")?.n,
      0,
      "restart should not fabricate FTS rows for empty fields"
    );
    const restartedMetaUpdatedAt =
      restartedDb
        .prepare(`
      SELECT updated_at
      FROM lexical_search_meta
      WHERE connector_id = ? AND stream = ?
    `)
        .get(REDDITISH_MANIFEST_A.connector_id, "posts")?.updated_at ?? null;
    assert.equal(
      restartedMetaUpdatedAt,
      originalMetaUpdatedAt,
      "startup backfill should not rewrite meta when zero indexable lexical values are already in sync"
    );
  } finally {
    // biome-ignore lint/suspicious/noEmptyBlockStatements: localized test assertion preserves its explicit contract.
    await closeServer(server).catch(() => {});
    closeDb();
    await rm(tempDir, { force: true, recursive: true });
  }
});
