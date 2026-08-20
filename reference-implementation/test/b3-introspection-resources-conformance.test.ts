// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * B3 conformance — token introspection and resources[] doc proof.
 *
 * Verifies that the documented shapes in:
 *   - apps/site/content/docs/reference-implementation-examples.md (Examples 4 + 5)
 *   - docs/agent-skills/pdpp-data-access/references/grant-design.md
 *
 * match the actual responses returned by the reference implementation.
 *
 * Each test is self-contained: it starts a server, issues a grant, calls
 * POST /introspect, and asserts the documented field set.
 *
 * Gate: all tests green; documented JSON shapes match reality.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalConnectorKey } from "../server/connector-key.ts";
import { startServer } from "../server/index.ts";
import { basicIntrospectionAuthorization } from "../server/introspection-http.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { makeDefaultAccountConnectorInstanceId } from "../server/stores/connector-instance-store.ts";
import {
  TEST_INTROSPECTION_SERVER_OPTS,
  TEST_RS_INTROSPECTION_CREDENTIALS,
} from "./helpers/introspection-test-credentials.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const MANIFESTS_DIR = join(REFERENCE_IMPL_DIR, "fixtures", "seed-manifests");
const INTROSPECTION_AUTHORIZATION = basicIntrospectionAuthorization(TEST_RS_INTROSPECTION_CREDENTIALS);

function introspectionHeaders(contentType = "application/json"): Record<string, string> {
  return { Authorization: INTROSPECTION_AUTHORIZATION, "Content-Type": contentType };
}

// ─── shared helpers ─────────────────────────────────────────────────────────

// `startServer`'s inferred asServer/rsServer type comes from a framework
// `.listen()` call whose TS overload resolves to an http2-shaped type, but at
// runtime these are plain node:http/https servers (the framework never
// negotiates ALPN in this reference stack) — so `closeAllConnections` (added
// Node 18.2+) and the single-error-arg `close` callback genuinely exist and
// are safe to declare here. Matches the established pattern in
// connector-summary-dirty-hooks.test.ts.
type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  rsServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
};

async function closeServer(server: TestServer): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise<void>((r) => server.asServer.close(() => r())),
    new Promise<void>((r) => server.rsServer.close(() => r())),
  ]);
}

async function fetchJson<T = Record<string, unknown>>(
  url: string,
  opts: RequestInit = {}
): Promise<{ status: number; body: T | null }> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON body (e.g. a plain-text error page) — surface it as-is so
    // assertion failure messages still show the real response content.
    parsed = text;
  }
  return { body: parsed as T | null, status: resp.status };
}

interface DeviceAuthorization {
  device_code: string;
  user_code: string;
}

interface TokenResponse {
  access_token: string;
}

interface ParResponse {
  request_uri: string;
}

interface ApprovedGrantStream {
  fields?: readonly string[];
  name: string;
  resources?: readonly string[];
}

interface ApprovedGrant {
  grant: {
    access_mode: string;
    grant_id: string;
    source?: { id?: string; kind: string };
    streams: readonly ApprovedGrantStream[];
  };
  token: string;
}

interface IssueClientGrantParams {
  access_mode: string;
  client_id: string;
  connector_id: string;
  purpose_code: string;
  purpose_description: string;
  streams: readonly ApprovedGrantStream[];
}

interface IntrospectionBody {
  active: boolean;
  authorization_details?: readonly {
    access_mode?: string;
    source?: { id?: string; kind?: string };
    streams?: readonly ApprovedGrantStream[];
    type?: string;
  }[];
  client_id?: string;
  exp?: number;
  grant?: {
    access_mode?: string;
    grant_id?: string;
    source?: { id?: string; kind?: string };
    streams?: readonly ApprovedGrantStream[];
  };
  grant_id?: string;
  grant_storage_binding?: { connector_id?: string };
  inactive_reason?: string;
  pdpp?: {
    grant_id?: string;
    source?: { id?: string; kind?: string };
  };
  pdpp_token_kind?: string;
  subject_id?: string;
}

interface ErrorBody {
  error?: string | { code?: string };
}

interface RecordsListBody {
  data: readonly { id: string }[];
}

interface AggregateBody {
  filtered_record_count: number;
  value: number;
}

interface SeedRecord {
  emitted_at?: string;
  id: string;
  [key: string]: unknown;
}

interface SpotifyManifestStream {
  name: string;
  query?: Record<string, unknown>;
}

interface SpotifyManifest {
  connector_id: string;
  streams: SpotifyManifestStream[];
}

function sourceIdForConnectorId(connectorId: string): string {
  return connectorId.includes("://") ? connectorId : `https://registry.pdpp.dev/connectors/${connectorId}`;
}

async function seedDefaultGrantInstance(connectorId: string, ownerSubjectId: string): Promise<void> {
  const store = createRequestConnectorInstanceStore();
  const connectorKey = canonicalConnectorKey(connectorId) ?? connectorId;
  const connectorInstanceId = makeDefaultAccountConnectorInstanceId(ownerSubjectId, connectorKey);
  if (await store.get(connectorInstanceId)) {
    return;
  }
  const now = new Date().toISOString();
  await store.upsert({
    connectorId: connectorKey,
    connectorInstanceId,
    createdAt: now,
    displayName: "Spotify",
    ownerSubjectId,
    sourceBinding: { fixture: "b3-conformance-default-account" },
    sourceBindingKey: connectorInstanceId,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
}

/**
 * Issue an owner token via the device flow. Needed to seed records before
 * issuing a client-scoped grant.
 */
async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
  const clientId = "cli_longview";
  const { body: device } = await fetchJson<DeviceAuthorization>(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.ok(device, "device_authorization should return a body");
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({
      subject_id: subjectId,
      user_code: device.user_code,
    }).toString(),
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
  assert.ok(tokenBody, "token response should return a body");
  return tokenBody.access_token;
}

/**
 * Stage a PAR request and approve it in one call, returning the token and grant.
 */
async function issueClientGrant(
  asUrl: string,
  subjectId: string,
  params: IssueClientGrantParams
): Promise<ApprovedGrant> {
  await seedDefaultGrantInstance(params.connector_id, subjectId);
  const { body: par } = await fetchJson<ParResponse>(`${asUrl}/oauth/par`, {
    body: JSON.stringify({
      authorization_details: [
        {
          access_mode: params.access_mode,
          purpose_code: params.purpose_code,
          purpose_description: params.purpose_description,
          source: { id: sourceIdForConnectorId(params.connector_id), kind: "connector" },
          streams: params.streams,
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: params.client_id,
    }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  assert.ok(par, "PAR response should return a body");
  const { body: review, status: reviewStatus } = await fetchJson<{ approval_review_revision?: unknown }>(
    `${asUrl}/consent/review`,
    {
      body: JSON.stringify({ request_uri: par.request_uri, subject_id: subjectId }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    }
  );
  assert.equal(reviewStatus, 200, JSON.stringify(review));
  assert.ok(review, "consent review returns a body");
  assert.equal(typeof review.approval_review_revision, "string", "consent review returns a revision");
  const { body: approved } = await fetchJson<ApprovedGrant>(`${asUrl}/consent/approve`, {
    body: JSON.stringify({
      approval_review_revision: review.approval_review_revision,
      request_uri: par.request_uri,
    }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  assert.ok(approved, "consent/approve should return a body");
  return approved;
}

/**
 * Seed records into a stream via the NDJSON ingest endpoint.
 */
async function seedStream(
  rsUrl: string,
  ownerToken: string,
  connectorId: string,
  stream: string,
  records: readonly SeedRecord[]
): Promise<void> {
  const ndjson = records
    .map((r) =>
      JSON.stringify({
        data: r,
        emitted_at: r.emitted_at || "2026-01-01T00:00:00Z",
        key: r.id,
      })
    )
    .join("\n");
  const resp = await fetch(
    `${rsUrl}/v1/ingest/${encodeURIComponent(stream)}?connector_id=${encodeURIComponent(connectorId)}`,
    {
      body: ndjson,
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/x-ndjson",
      },
      method: "POST",
    }
  );
  assert.equal(resp.status, 200, `seed ${stream} ok`);
}

function readSpotifyManifest(): SpotifyManifest {
  return JSON.parse(readFileSync(join(MANIFESTS_DIR, "spotify.json"), "utf8")) as SpotifyManifest;
}

async function withHarness(
  fn: (ctx: { asUrl: string; connectorId: string; rsUrl: string }) => Promise<void>
): Promise<void> {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
    ...TEST_INTROSPECTION_SERVER_OPTS,
  })) as TestServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  // Register Spotify connector (with aggregation enabled for aggregate tests)
  const manifest = readSpotifyManifest();
  const topArtists = manifest.streams.find((s) => s.name === "top_artists");
  assert.ok(topArtists, "spotify manifest must declare a top_artists stream");
  topArtists.query = {
    ...(topArtists.query || {}),
    aggregations: {
      count: true,
      max: ["popularity", "source_updated_at"],
      min: ["popularity", "source_updated_at"],
      sum: ["popularity", "followers"],
    },
  };
  const regResp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(regResp.status, 201, "register spotify connector");

  try {
    await fn({ asUrl, connectorId: manifest.connector_id, rsUrl });
  } finally {
    await closeServer(server);
  }
}

// ─── B3.1 — active client token introspection shape ─────────────────────────

test("introspection: confidential caller credentials are mandatory (B3)", async () => {
  await withHarness(async ({ asUrl }) => {
    const authorizations = [
      undefined,
      basicIntrospectionAuthorization({
        clientId: TEST_RS_INTROSPECTION_CREDENTIALS.clientId,
        clientSecret: "wrong-secret",
      }),
    ];
    const responses = await Promise.all(
      authorizations.map((authorization) =>
        fetch(`${asUrl}/introspect`, {
          body: new URLSearchParams({ token: "not-relevant" }).toString(),
          headers: {
            ...(authorization ? { Authorization: authorization } : {}),
            "Content-Type": "application/x-www-form-urlencoded",
          },
          method: "POST",
        })
      )
    );
    const results = await Promise.all(
      responses.map(async (response) => ({
        body: (await response.json()) as ErrorBody,
        status: response.status,
        wwwAuthenticate: response.headers.get("www-authenticate"),
      }))
    );
    for (const { body, status, wwwAuthenticate } of results) {
      assert.equal(status, 401);
      assert.equal(wwwAuthenticate, 'Basic realm="introspection"');
      assert.equal(typeof body.error === "object" ? body.error?.code : body.error, "context.authentication_failed");
    }
  });
});

test("introspection: active client token returns documented fields (B3)", async () => {
  await withHarness(async ({ asUrl, rsUrl, connectorId }) => {
    const ownerToken = await issueOwnerToken(asUrl, "b3_introspect_owner");
    await seedStream(rsUrl, ownerToken, connectorId, "top_artists", [
      { id: "a1", name: "Artist One", popularity: 80, source_updated_at: "2026-01-01T00:00:00Z" },
    ]);

    const approved = await issueClientGrant(asUrl, "b3_introspect_owner", {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.dev/purpose/assist_summarize",
      purpose_description: "B3 introspection proof",
      streams: [{ fields: ["id", "name", "popularity"], name: "top_artists" }],
    });

    const { status, body } = await fetchJson<IntrospectionBody>(`${asUrl}/introspect`, {
      body: JSON.stringify({ token: approved.token }),
      headers: introspectionHeaders(),
      method: "POST",
    });

    assert.equal(status, 200, "introspect returns 200");
    assert.ok(body, "introspect should return a body");

    // Documented invariants from reference-implementation-examples.md Example 4
    assert.equal(body.active, true, "active: true for a valid token");
    assert.equal(body.pdpp_token_kind, "client", 'pdpp_token_kind: "client"');
    assert.ok(typeof body.subject_id === "string", "subject_id present");
    assert.equal(body.grant_id, approved.grant.grant_id, "grant_id matches issued grant");
    assert.equal(body.client_id, "longview", "client_id matches requester");

    // Public introspection projects the grant into RFC 9396 authorization_details
    // plus PDPP context instead of exposing the AS-internal grant object.
    assert.ok(Array.isArray(body.authorization_details), "authorization_details is an array");
    const [detail] = body.authorization_details;
    assert.ok(detail, "introspected grant has an authorization detail");
    assert.equal(detail.type, "https://pdpp.dev/data-access", "authorization detail type is PDPP data access");
    assert.equal(detail.source?.kind, "connector", "authorization detail source.kind = connector");
    assert.equal(detail.access_mode, "continuous", "authorization detail access_mode matches");
    assert.ok(Array.isArray(detail.streams), "authorization detail streams is an array");
    const firstStream = detail.streams?.[0];
    assert.ok(firstStream, "introspected authorization detail has at least one stream");
    assert.equal(firstStream.name, "top_artists", "stream name preserved");
    assert.equal(body.pdpp?.grant_id, approved.grant.grant_id, "pdpp.grant_id matches");
    assert.equal(body.pdpp?.source?.id, detail.source?.id, "pdpp.source matches authorization detail source");

    // RFC 7662 omits exp when the token has no finite expiry.
    assert.ok(body.exp === undefined || typeof body.exp === "number", "exp is omitted or a numeric Unix timestamp");

    // The confidential RS caller needs the physical binding to resolve the approved source.
    assert.equal(
      body.grant_storage_binding?.connector_id,
      canonicalConnectorKey(detail.source?.id ?? null),
      "storage binding matches approved source"
    );
  });
});

// ─── B3.2 — inactive token: grant_revoked ───────────────────────────────────

test("introspection: revoked grant returns active=false with inactive_reason (B3)", async () => {
  await withHarness(async ({ asUrl, connectorId, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl, "b3_revoke_owner");
    await seedStream(rsUrl, ownerToken, connectorId, "top_artists", [
      { id: "revoke_1", name: "Revocation fixture", source_updated_at: "2026-01-01T00:00:00Z" },
    ]);
    const approved = await issueClientGrant(asUrl, "b3_revoke_owner", {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.dev/purpose/assist_summarize",
      purpose_description: "B3 revoke proof",
      streams: [{ fields: ["id", "name"], name: "top_artists" }],
    });

    // Revoke the grant using the client token itself (a token holder may
    // revoke their own grant — no owner session needed)
    const revokeResp = await fetch(`${asUrl}/grants/${encodeURIComponent(approved.grant.grant_id)}/revoke`, {
      body: JSON.stringify({}),
      headers: {
        Authorization: `Bearer ${approved.token}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    assert.equal(revokeResp.status, 200, `revoke returned ${revokeResp.status}`);

    const { status, body } = await fetchJson<IntrospectionBody>(`${asUrl}/introspect`, {
      body: JSON.stringify({ token: approved.token }),
      headers: introspectionHeaders(),
      method: "POST",
    });

    assert.equal(status, 200, "introspect still returns 200 for inactive tokens");
    assert.ok(body, "introspect should return a body");
    assert.equal(body.active, false, "active: false after revocation");
    assert.ok(
      body.inactive_reason !== undefined && ["grant_revoked", "token_revoked"].includes(body.inactive_reason),
      `inactive_reason should be grant_revoked or token_revoked, got: ${body.inactive_reason}`
    );
    assert.equal(body.grant_id, approved.grant.grant_id, "grant_id still present for attribution");
    assert.ok(!("grant" in body), "full grant object not returned for inactive tokens");
  });
});

// ─── B3.3 — missing token returns 400 invalid_request ───────────────────────

test("introspection: missing token returns 400 invalid_request (B3)", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await fetchJson<ErrorBody>(`${asUrl}/introspect`, {
      body: JSON.stringify({}),
      headers: introspectionHeaders(),
      method: "POST",
    });

    assert.equal(status, 400, "missing token → 400");
    assert.ok(body, "error response should return a body");
    const errorCode = typeof body.error === "object" ? body.error?.code : undefined;
    assert.ok(
      body.error === "invalid_request" || errorCode === "invalid_request",
      `expect invalid_request error, got: ${JSON.stringify(body.error)}`
    );
  });
});

// ─── B3.4 — resources[] round-trip: grant scopes records, introspection reflects it ─

test("resources[] round-trip: grant contains resources, RS enforces them (B3)", async () => {
  await withHarness(async ({ asUrl, rsUrl, connectorId }) => {
    const ownerToken = await issueOwnerToken(asUrl, "b3_resources_owner");
    await seedStream(rsUrl, ownerToken, connectorId, "top_artists", [
      { id: "visible_1", name: "Artist V1", popularity: 70, source_updated_at: "2026-01-01T00:00:00Z" },
      { id: "visible_2", name: "Artist V2", popularity: 60, source_updated_at: "2026-01-02T00:00:00Z" },
      { id: "hidden_3", name: "Artist H3", popularity: 90, source_updated_at: "2026-01-03T00:00:00Z" },
    ]);

    const approved = await issueClientGrant(asUrl, "b3_resources_owner", {
      access_mode: "single_use",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.dev/purpose/assist_search",
      purpose_description: "B3 resources[] proof — two named artists",
      streams: [
        {
          fields: ["id", "name", "popularity"],
          name: "top_artists",
          resources: ["visible_1", "visible_2"],
        },
      ],
    });

    // 1. Introspection reflects resources[] in authorization_details.
    const { body: introBody } = await fetchJson<IntrospectionBody>(`${asUrl}/introspect`, {
      body: JSON.stringify({ token: approved.token }),
      headers: introspectionHeaders(),
      method: "POST",
    });
    assert.ok(introBody, "introspect should return a body");
    assert.equal(introBody.active, true, "token is active");
    const introspectedStream = introBody.authorization_details?.[0]?.streams?.[0];
    assert.ok(introspectedStream, "stream present in introspected grant");
    assert.deepEqual(
      introspectedStream.resources,
      ["visible_1", "visible_2"],
      "resources[] round-tripped through introspection"
    );

    // 2. RS enforces resources[]: only the two named records are visible
    const { status: recordsStatus, body: recordsBody } = await fetchJson<RecordsListBody>(
      `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(connectorId)}`,
      { headers: { Authorization: `Bearer ${approved.token}` } }
    );
    assert.equal(recordsStatus, 200, "records query succeeds");
    assert.ok(recordsBody, "records response should return a body");
    const ids = recordsBody.data.map((r) => r.id);
    assert.ok(ids.includes("visible_1"), "visible_1 present");
    assert.ok(ids.includes("visible_2"), "visible_2 present");
    assert.ok(!ids.includes("hidden_3"), "hidden_3 absent — resources[] enforced");
    assert.equal(recordsBody.data.length, 2, "exactly two records returned");
  });
});

// ─── B3.5 — aggregate query also honors resources[] scoping ─────────────────

test("resources[] scoping applies to aggregate queries (B3)", async () => {
  await withHarness(async ({ asUrl, rsUrl, connectorId }) => {
    const ownerToken = await issueOwnerToken(asUrl, "b3_agg_resources_owner");
    await seedStream(rsUrl, ownerToken, connectorId, "top_artists", [
      { id: "agg_in", name: "Included", popularity: 50, source_updated_at: "2026-01-01T00:00:00Z" },
      { id: "agg_out", name: "Excluded", popularity: 99, source_updated_at: "2026-01-02T00:00:00Z" },
    ]);

    const approved = await issueClientGrant(asUrl, "b3_agg_resources_owner", {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.dev/purpose/assist_summarize",
      purpose_description: "B3 aggregate resources[] proof",
      streams: [
        {
          fields: ["id", "popularity", "source_updated_at"],
          name: "top_artists",
          resources: ["agg_in"],
        },
      ],
    });

    const { status, body } = await fetchJson<AggregateBody>(
      `${rsUrl}/v1/streams/top_artists/aggregate?metric=sum&field=popularity&connector_id=${encodeURIComponent(connectorId)}`,
      { headers: { Authorization: `Bearer ${approved.token}` } }
    );
    assert.equal(status, 200, "aggregate succeeds");
    assert.ok(body, "aggregate response should return a body");
    // Only agg_in (popularity=50) is in scope; agg_out (99) must not contribute
    assert.equal(body.value, 50, "aggregate sum reflects only resources[]-scoped records");
    assert.equal(body.filtered_record_count, 1, "filtered_record_count = 1");
  });
});
