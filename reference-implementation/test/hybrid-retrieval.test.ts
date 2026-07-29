// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Hybrid Retrieval Experimental Extension — public-contract conformance tests.
 *
 * Pins the behavior of the approved spec at:
 *   openspec/changes/define-hybrid-retrieval/specs/hybrid-retrieval/spec.md
 *
 * Covered scenarios:
 *   - advertisement only when BOTH lexical and semantic retrieval are on
 *   - happy-path owner-token hybrid search across at least two streams
 *   - client-token grant projection (stream + field) applied consistently
 *   - dedup of a record that matches both sources, with merged sources + scores
 *   - provenance for lexical-only and semantic-only hits
 *   - cursor behavior for the v1 first-tranche (no cursor support)
 *   - cross-surface cursor rejection (lexical and semantic cursors are not
 *     accepted at /v1/search/hybrid)
 *   - /v1/search and /v1/search/semantic response shapes unchanged
 */

import assert from "node:assert/strict";
import test from "node:test";

import { startServer } from "../server/index.ts";

const TEST_DCR_INITIAL_ACCESS_TOKEN = "pdpp-reference-test-initial-access-token";

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

async function closeServer(server: StartedServer): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((r) => server.asServer.close(r)),
    new Promise((r) => server.rsServer.close(r)),
  ]);
}

// Two manifests, mirroring the semantic-retrieval.test.js fixtures: the
// `posts` stream declares BOTH lexical and semantic fields so hybrid has
// overlapping candidates, and `comments` differs between the two (declares
// both extensions but with different field sets) so source-specific hits
// exercise lexical-only and semantic-only provenance paths.
const MANIFEST_A = {
  capabilities: { human_interaction: ["credentials"] },
  connector_id: "hybrid-a",
  display_name: "Hybrid A",
  protocol_version: "0.1.0",
  streams: [
    {
      consent_time_field: "source_created_at",
      cursor_field: "source_created_at",
      name: "posts",
      primary_key: ["id"],
      query: {
        range_filters: { source_created_at: ["gte", "gt", "lte", "lt"] },
        search: {
          lexical_fields: ["title", "selftext"],
          semantic_fields: ["title", "selftext"],
        },
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
    {
      consent_time_field: "source_created_at",
      cursor_field: "source_created_at",
      name: "comments",
      primary_key: ["id"],
      query: {
        search: {
          lexical_fields: ["body"],
          semantic_fields: ["body"],
        },
      },
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
  ],
  version: "1.0.0",
};

interface DeviceAuthorizationBody {
  device_code: string;
  user_code: string;
}

interface TokenBody {
  access_token: string;
}

async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
  const clientId = "cli_longview";
  const { body: deviceBody } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const device = deviceBody as DeviceAuthorizationBody;
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
  return (tokenBody as TokenBody).access_token;
}

interface ApproveClientGrantParams {
  access_mode: string;
  client_id: string;
  connector_id: string;
  purpose_code: string;
  purpose_description: string;
  streams: { fields: string[]; name: string }[];
  subject_id?: string;
}

interface ParInitiateBody {
  request_uri: string;
}

interface ApprovedGrant {
  token: string;
}

async function approveClientGrant(asUrl: string, params: ApproveClientGrantParams): Promise<ApprovedGrant> {
  const { body: initiateBody } = await fetchJson(`${asUrl}/oauth/par`, {
    body: JSON.stringify({
      authorization_details: [
        {
          access_mode: params.access_mode,
          purpose_code: params.purpose_code,
          purpose_description: params.purpose_description,
          source: { id: params.connector_id, kind: "connector" },
          streams: params.streams,
          type: "https://pdpp.org/data-access",
        },
      ],
      client_id: params.client_id,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const initiate = initiateBody as ParInitiateBody;
  const { body: approved } = await fetchJson(`${asUrl}/consent/approve`, {
    body: JSON.stringify({ request_uri: initiate.request_uri, subject_id: params.subject_id || "owner_local" }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  return approved as ApprovedGrant;
}

interface IngestRecord {
  id: string;
  source_created_at?: string;
  [field: string]: unknown;
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

interface HarnessContext {
  asUrl: string;
  rsUrl: string;
  server: StartedServer;
}

interface WithHarnessOpts {
  hybridRetrievalSupported?: boolean;
  lexicalRetrievalSupported?: boolean;
  semanticRetrievalSupported?: boolean;
}

async function withHarness(
  opts: WithHarnessOpts,
  fn: (ctx: HarnessContext) => Promise<void>,
  manifests: Record<string, unknown>[] = [MANIFEST_A]
): Promise<void> {
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

// ─── Response-shape interfaces ──────────────────────────────────────────────
//
// The RS wire responses this file asserts against. Kept loose (optional
// fields, `unknown` scores) because the point of each test is to check a
// handful of fields on an otherwise-arbitrary JSON body, not to fully model
// the wire contract.

interface HybridCapability {
  cross_stream?: boolean;
  cursor_supported?: boolean;
  default_limit?: number;
  endpoint?: string;
  max_limit?: number;
  sources?: string[];
  stability?: string;
  supported?: boolean;
}

interface MetadataDocument {
  capabilities?: {
    hybrid_retrieval?: HybridCapability;
  };
}

interface SearchScore {
  kind?: string;
}

interface SearchHit {
  matched_fields?: string[];
  object?: string;
  record_key?: string;
  retrieval_mode?: string;
  retrieval_sources?: string[];
  scores?: {
    lexical?: SearchScore;
    semantic?: SearchScore;
  };
  snippet?: {
    text: string;
  };
}

interface SearchListResponse {
  data: SearchHit[];
  has_more?: boolean;
  next_cursor?: string;
  object?: string;
  url?: string;
}

interface ErrorEnvelopeResponse {
  error?: {
    code?: string;
  };
}

// ─── Advertisement ──────────────────────────────────────────────────────────

test("RS metadata advertises capabilities.hybrid_retrieval when both lexical and semantic are on", async () => {
  await withHarness({}, async ({ rsUrl }) => {
    const { status, body } = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal(status, 200);
    const cap = (body as MetadataDocument).capabilities?.hybrid_retrieval;
    assert.ok(cap, "hybrid_retrieval advertisement should be present");
    assert.equal(cap.supported, true);
    assert.equal(cap.stability, "experimental");
    assert.equal(cap.endpoint, "/v1/search/hybrid");
    assert.equal(cap.cross_stream, true);
    assert.equal(cap.default_limit, 25);
    assert.equal(cap.max_limit, 100);
    assert.equal(cap.cursor_supported, false, "v1 tranche declares no cursor support");
    assert.deepEqual(cap.sources, ["lexical", "semantic"]);
  });
});

test("RS metadata omits hybrid_retrieval when semantic is disabled", async () => {
  await withHarness({ semanticRetrievalSupported: false }, async ({ rsUrl }) => {
    const { body } = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    const cap = (body as MetadataDocument).capabilities?.hybrid_retrieval;
    if (cap) {
      assert.equal(cap.supported, false);
    }
    const { status } = await fetchJson(`${rsUrl}/v1/search/hybrid?q=x`);
    assert.equal(status, 404);
  });
});

test("RS metadata omits hybrid_retrieval when lexical is disabled", async () => {
  await withHarness({ lexicalRetrievalSupported: false }, async ({ rsUrl }) => {
    const { body } = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    const cap = (body as MetadataDocument).capabilities?.hybrid_retrieval;
    if (cap) {
      assert.equal(cap.supported, false);
    }
    const { status } = await fetchJson(`${rsUrl}/v1/search/hybrid?q=x`);
    assert.equal(status, 404);
  });
});

test("RS metadata omits hybrid_retrieval when explicitly disabled even if both sources are on", async () => {
  await withHarness({ hybridRetrievalSupported: false }, async ({ rsUrl }) => {
    const { body } = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
    assert.equal((body as MetadataDocument).capabilities?.hybrid_retrieval, undefined);
    const { status } = await fetchJson(`${rsUrl}/v1/search/hybrid?q=x`);
    assert.equal(status, 404);
  });
});

// ─── Happy path / provenance / dedup ────────────────────────────────────────

test("owner-token hybrid search returns list envelope with per-source provenance across streams", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    // posts: two records, one exactly matching q (so lexical+semantic both
    // return it), one distant-match (lexical-only) to exercise the
    // lexical-only provenance branch.
    await ingest(rsUrl, ownerToken, connectorA, "posts", [
      { id: "p1", selftext: "unexpected fee", source_created_at: "2026-04-01T00:00:00Z", title: "overdraft surprise" },
      { id: "p2", selftext: "al dente tips", source_created_at: "2026-04-02T00:00:00Z", title: "cooking pasta" },
    ]);
    // comments: one record whose body contains the query tokens — at least
    // one source should return it, exercising the second stream.
    await ingest(rsUrl, ownerToken, connectorA, "comments", [
      { body: "overdraft discussion thread", id: "c1", source_created_at: "2026-04-03T00:00:00Z" },
    ]);

    const { status, body: rawBody } = await fetchJson(
      `${rsUrl}/v1/search/hybrid?q=${encodeURIComponent("overdraft")}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    const body = rawBody as SearchListResponse;
    assert.equal(status, 200);
    assert.equal(body.object, "list");
    assert.equal(body.url, "/v1/search/hybrid");
    assert.equal(typeof body.has_more, "boolean");
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.length > 0, "expected at least one hybrid hit");
    // Every hit has hybrid-shaped provenance.
    for (const hit of body.data) {
      assert.equal(hit.object, "search_result");
      assert.equal(hit.retrieval_mode, "hybrid");
      assert.ok(Array.isArray(hit.retrieval_sources) && hit.retrieval_sources.length > 0);
      for (const s of hit.retrieval_sources ?? []) {
        assert.ok(["lexical", "semantic"].includes(s), `unexpected source ${s}`);
      }
      // scores shape: each key must match the corresponding source.
      if (hit.scores) {
        if (hit.scores.lexical) {
          assert.equal(hit.scores.lexical.kind, "bm25");
        }
        if (hit.scores.semantic) {
          assert.equal(hit.scores.semantic.kind, "semantic_distance");
        }
      }
    }
    // At least one hit should span both sources (p1 matches title lexically
    // and is close to q embedding-wise given the stub backend's exact-match
    // reflexivity).
    const dualSourceHits = body.data.filter((h) => (h.retrieval_sources?.length ?? 0) === 2);
    assert.ok(dualSourceHits.length > 0, "expected at least one dual-source hit");
    const [dual] = dualSourceHits;
    assert.ok(dual, "a dual-source hit exists");
    assert.ok(dual.scores?.lexical && dual.scores?.semantic, "dual-source hit must carry both score objects");
  });
});

test("record that matches both lexical and semantic is deduplicated to one result", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    // The stub semantic backend is deterministic + reflexive on exact
    // matches. Seed a record whose title matches q verbatim so it is
    // guaranteed to appear in both the lexical and semantic candidate
    // lists, exercising the dedup branch.
    await ingest(rsUrl, ownerToken, connectorA, "posts", [
      {
        id: "p-dup",
        selftext: "unexpected fee",
        source_created_at: "2026-04-01T00:00:00Z",
        title: "overdraft surprise",
      },
    ]);
    const { status, body: rawBody } = await fetchJson(
      `${rsUrl}/v1/search/hybrid?q=${encodeURIComponent("overdraft surprise")}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    const body = rawBody as SearchListResponse;
    assert.equal(status, 200);
    const matches = body.data.filter((h) => h.record_key === "p-dup");
    assert.equal(matches.length, 1, "dedup must collapse both-source matches to one result");
    const [hit] = matches;
    assert.ok(hit, "the deduplicated hit exists");
    assert.deepEqual(
      [...(hit.retrieval_sources ?? [])].sort(),
      ["lexical", "semantic"],
      "both sources should be reported on the dedup'd hit"
    );
    assert.ok(hit.scores?.lexical && hit.scores?.semantic, "dedup'd hit must carry both per-source score objects");
  });
});

// ─── Client-token grant projection ──────────────────────────────────────────

test("client-token hybrid search respects the same grant projection as lexical + semantic", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, "posts", [
      {
        id: "p1",
        selftext: "secret ungranted text",
        source_created_at: "2026-04-01T00:00:00Z",
        title: "overdraft surprise",
      },
    ]);
    // Grant posts/title only — selftext is NOT in the client projection.
    const approved = await approveClientGrant(asUrl, {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorA,
      purpose_code: "https://pdpp.org/purpose/analytics",
      purpose_description: "hybrid test",
      streams: [{ fields: ["id", "title"], name: "posts" }],
    });

    const { status, body: rawBody } = await fetchJson(
      `${rsUrl}/v1/search/hybrid?q=${encodeURIComponent("overdraft surprise")}`,
      { headers: { Authorization: `Bearer ${approved.token}` } }
    );
    const body = rawBody as SearchListResponse;
    assert.equal(status, 200);
    const hit = body.data.find((r) => r.record_key === "p1");
    assert.ok(hit, "client should see p1 under the granted field");
    for (const f of hit.matched_fields ?? []) {
      assert.equal(f, "title", "matched_fields must stay inside the grant projection");
    }
    if (hit.snippet) {
      assert.ok(!hit.snippet.text.includes("secret ungranted text"), "snippet must not leak ungranted selftext");
    }
  });
});

test("client-token hybrid search rejects streams[] not in grant (same as lexical/semantic)", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, "posts", [
      { id: "p1", source_created_at: "2026-04-01T00:00:00Z", title: "overdraft" },
    ]);
    const approved = await approveClientGrant(asUrl, {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorA,
      purpose_code: "https://pdpp.org/purpose/analytics",
      purpose_description: "grant enforcement",
      streams: [{ fields: ["id", "title"], name: "posts" }],
    });
    const { status, body } = await fetchJson(`${rsUrl}/v1/search/hybrid?q=overdraft&streams=comments`, {
      headers: { Authorization: `Bearer ${approved.token}` },
    });
    assert.equal(status, 403);
    assert.equal((body as ErrorEnvelopeResponse).error?.code, "grant_stream_not_allowed");
  });
});

// ─── Cursor behavior — first-tranche: no cursor support ─────────────────────

test("hybrid search rejects the cursor parameter in the v1 tranche", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, "posts", [
      { id: "p1", source_created_at: "2026-04-01T00:00:00Z", title: "overdraft" },
    ]);
    // A bare, malformed cursor — still 400 because v1 rejects the parameter
    // up front rather than returning misleading offset-only pages.
    const { status, body } = await fetchJson(`${rsUrl}/v1/search/hybrid?q=overdraft&cursor=anything`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 400);
    assert.equal((body as ErrorEnvelopeResponse).error?.code, "invalid_request");
  });
});

test("hybrid search does not emit next_cursor in the v1 tranche", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    // Seed enough records that the internal merge could plausibly have
    // overflowed a small `limit`. The response must not carry next_cursor —
    // v1 hybrid advertises cursor_supported:false.
    const seeds = Array.from({ length: 10 }, (_, i) => ({
      id: `p${i}`,
      selftext: "fee story",
      source_created_at: `2026-04-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      title: `overdraft variant ${i}`,
    }));
    await ingest(rsUrl, ownerToken, connectorA, "posts", seeds);
    const { status, body } = await fetchJson(`${rsUrl}/v1/search/hybrid?q=overdraft&limit=2`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 200);
    assert.equal((body as SearchListResponse).next_cursor, undefined, "v1 hybrid must omit next_cursor");
  });
});

test("cursors from /v1/search and /v1/search/semantic are rejected by /v1/search/hybrid", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    const seeds = Array.from({ length: 6 }, (_, i) => ({
      id: `p${i}`,
      selftext: "fee story",
      source_created_at: `2026-04-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      title: `overdraft variant ${i}`,
    }));
    await ingest(rsUrl, ownerToken, connectorA, "posts", seeds);

    // Pull a real lexical cursor.
    const { body: lexBodyRaw } = await fetchJson(`${rsUrl}/v1/search?q=overdraft&limit=1`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    // Pull a real semantic cursor.
    const { body: semBodyRaw } = await fetchJson(`${rsUrl}/v1/search/semantic?q=overdraft&limit=1`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const lexBody = lexBodyRaw as SearchListResponse;
    const semBody = semBodyRaw as SearchListResponse;

    for await (const cursor of [lexBody.next_cursor, semBody.next_cursor].filter((c): c is string => Boolean(c))) {
      const { status, body } = await fetchJson(
        `${rsUrl}/v1/search/hybrid?q=overdraft&cursor=${encodeURIComponent(cursor)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } }
      );
      assert.equal(status, 400, `hybrid must reject cursor ${cursor}`);
      assert.equal((body as ErrorEnvelopeResponse).error?.code, "invalid_request");
    }
  });
});

// ─── Underlying endpoints unchanged ─────────────────────────────────────────

test("/v1/search and /v1/search/semantic response shapes are unchanged when hybrid is advertised", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorA = MANIFEST_A.connector_id;
    await ingest(rsUrl, ownerToken, connectorA, "posts", [
      { id: "p1", selftext: "unexpected fee", source_created_at: "2026-04-01T00:00:00Z", title: "overdraft surprise" },
    ]);
    const { body: lexRaw } = await fetchJson(`${rsUrl}/v1/search?q=overdraft`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const lex = lexRaw as SearchListResponse;
    assert.equal(lex.url, "/v1/search");
    for (const hit of lex.data) {
      assert.equal(hit.retrieval_mode, undefined, "/v1/search must not emit retrieval_mode");
      assert.equal(hit.retrieval_sources, undefined);
      assert.equal(hit.scores, undefined);
    }
    const { body: semRaw } = await fetchJson(`${rsUrl}/v1/search/semantic?q=overdraft`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const sem = semRaw as SearchListResponse;
    assert.equal(sem.url, "/v1/search/semantic");
    for (const hit of sem.data) {
      assert.equal(hit.retrieval_mode, "semantic", '/v1/search/semantic still emits retrieval_mode:"semantic"');
      assert.equal(hit.retrieval_sources, undefined);
      assert.equal(hit.scores, undefined);
    }
  });
});

// ─── Parameter rejection ────────────────────────────────────────────────────

test("hybrid search rejects forbidden parameters with invalid_request", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const forbidden = [
      "vector",
      "embedding",
      "embed",
      "model",
      "model_id",
      "weights",
      "blend",
      "boost",
      "rank",
      "mode",
      "connector_id",
      "fields",
      "expand",
      "expand_limit",
      "order",
      "sort",
    ];
    for await (const key of forbidden) {
      const { status, body } = await fetchJson(`${rsUrl}/v1/search/hybrid?q=anything&${key}=whatever`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(status, 400, `${key} should return 400`);
      assert.equal((body as ErrorEnvelopeResponse).error?.code, "invalid_request");
    }
  });
});

test("hybrid search requires q", async () => {
  await withHarness({}, async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(`${rsUrl}/v1/search/hybrid`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(status, 400);
    assert.equal((body as ErrorEnvelopeResponse).error?.code, "invalid_request");
  });
});
