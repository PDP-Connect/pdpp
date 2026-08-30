#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Scripted external MCP query for the Railway Core deploy gate
// (openspec/changes/add-railway-core-deploy-target task 3.2, deploy/railway/
// README.md "First-live-test gate" steps 5 and 6), split into a read-only
// production-acceptance path and a disposable-environment mutation smoke.
//
// Production acceptance (default, no flag): STRICTLY READ-ONLY. It never
// registers a manifest, never ingests, and never deletes anything — it only
// proves the hosted MCP endpoint refuses anonymous access AND completes a
// scoped tools/list + query_records that returns whatever seed-stream records
// already exist. This is the safe, repeatable mode against a real,
// persistent deployment with a real owner connection.
//
// Disposable-environment mutation smoke (--disposable-env): the only mode
// that seeds. It hand-imports a small deterministic record set (no connector
// run) WITHOUT running a browser connector, then proves the scoped MCP query
// returns it, then tombstone-deletes and re-verifies before exiting. It
// refuses to run at all unless the owner has ZERO pre-existing connections
// (see assertOwnerHasNoExistingConnections below for why this is the only
// available safety proof) — this closes the defect recorded in
// FULL-PROTOCOL-TRAIN-CUTOVER-R2-0829.md "Required follow-up", where an
// earlier unconditional-seed version mutated a pre-existing owner Spotify
// connection.
//
// It uses only the public protocol surface against ONE composed origin — the
// same surface a real MCP client and a real owner would use. It does not import
// the reference server, touch a database directly, or require any package
// install: it runs on Node's built-in fetch with zero dependencies, exactly
// like check-railway-deploy-env.ts. The pure helpers below are exercised
// offline by railway-mcp-query-smoke.test.ts; the live driver runs against a
// real stack (local composed-origin via `pnpm docker:smoke`'s images, or a live
// Railway origin) only when an --origin is given.
//
// Seed path (--disposable-env only; in-contract, owner-authenticated, no
// connector run):
//   1. POST /owner/login          → owner session cookie (when a password is set)
//   2. device flow under that session → owner access token
//   3. GET  /v1/owner/connections → MUST be empty, or abort before any mutation
//   4. POST /connectors           → register a fixture connector manifest
//   5. POST /v1/ingest/:stream    → NDJSON records (owner-gated ingest)
//
// Query path (external MCP client, scoped grant; both modes):
//   6. POST/GET /mcp (no auth)    → MUST refuse (401)
//   7. POST /oauth/register       → dynamic client
//      GET  /oauth/authorize      → consent request_uri
//      POST /consent/approve      → authorization code (under owner session)
//      POST /oauth/token          → client access token (scoped to the connector)
//      POST /mcp initialize / tools/list / tools/call query_records
//                                 → (seeded or pre-existing) record(s) returned
//
// Cleanup path (--disposable-env only; guaranteed on every post-seed failure
// point, not just the success path):
//   8. DELETE /v1/streams/:stream/records/:key (per seeded key) → 204
//   9. POST /mcp tools/call query_records → verify zero seeded keys remain live
//
// Usage:
//   node scripts/railway-mcp-query-smoke.ts --origin https://your-console-domain
//   node scripts/railway-mcp-query-smoke.ts --origin http://localhost:3002 \
//        --owner-password "$PDPP_OWNER_PASSWORD"
//   node scripts/railway-mcp-query-smoke.ts --origin <origin> --disposable-env
//   node scripts/railway-mcp-query-smoke.ts --origin <origin> --json
//
// When the deploy follows the documented security posture, PDPP_OWNER_PASSWORD
// is set; pass it via --owner-password or the env var so the client-token
// consent flow (and, under --disposable-env, the seed step) can establish an
// owner session. Against an open local-dev server (no password) the login
// step is a no-op and the device flow mints a token directly.
//
// Exit codes: 0 = the gate passed; 1 = a check, the pre-seed guard, or cleanup
// failed, or the origin was unreachable; 2 = usage error.

import crypto from "node:crypto";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  establishOwnerSessionCookie,
  extractCsrfFieldValue,
  findSetCookiePair,
  getSetCookieList,
} from "./lib/owner-session.ts";

// ---------------------------------------------------------------------------
// Deterministic seed corpus (pure data).
// ---------------------------------------------------------------------------

// A registered fixture connector manifest is required before /v1/ingest will
// accept records (the stream must be manifest-visible). `spotify` is an existing
// committed fixture manifest used across the test suite, so the seed reuses it
// rather than inventing a connector. The records are hand-built here, NOT
// produced by running the seed connector — task 3.2 is explicit that the seed is
// a hand-imported fixture with no connector run.
export const SEED_CONNECTOR_ID = "https://registry.pdpp.dev/connectors/spotify";
export const SEED_STREAM = "top_artists";

export interface SeedRecord {
  data: {
    followers: number;
    genres: string[];
    id: string;
    name: string;
    popularity: number;
    source_updated_at: string;
  };
  emitted_at: string;
  key: string;
}

// Stable keys + matching data.id (ingestRecord rejects a key that disagrees with
// data.id). Deterministic timestamps keep re-runs byte-identical; the live
// smoke deliberately avoids unadvertised sort fields and only asserts presence.
export const SEED_RECORDS: SeedRecord[] = [
  {
    key: "railway-seed-artist-1",
    data: {
      id: "railway-seed-artist-1",
      name: "Deploy Test Quartet",
      genres: ["test-fixture"],
      popularity: 41,
      followers: 10,
      source_updated_at: "2026-01-01T00:00:01.000Z",
    },
    emitted_at: "2026-01-01T00:00:01.000Z",
  },
  {
    key: "railway-seed-artist-2",
    data: {
      id: "railway-seed-artist-2",
      name: "Restart Survival Band",
      genres: ["test-fixture"],
      popularity: 42,
      followers: 20,
      source_updated_at: "2026-01-01T00:00:02.000Z",
    },
    emitted_at: "2026-01-01T00:00:02.000Z",
  },
];

// Build the NDJSON body POST /v1/ingest/:stream expects: one JSON record per
// line. The operation splits on \n and JSON.parses each non-empty line.
export function buildSeedNdjson(records: SeedRecord[] = SEED_RECORDS): string {
  return records.map((record) => JSON.stringify(record)).join("\n");
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC framing (pure).
// ---------------------------------------------------------------------------

interface McpMessage {
  id: number;
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
}

export function mcpInitializeMessage(id = 1): McpMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "railway-mcp-query-smoke", version: "1" },
    },
  };
}

export function mcpToolsListMessage(id = 2): McpMessage {
  return { jsonrpc: "2.0", id, method: "tools/list", params: {} };
}

export function mcpQueryRecordsMessage(stream: string, args: Record<string, unknown> = {}, id = 3): McpMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "query_records", arguments: { stream, ...args } },
  };
}

const SSE_LINE_ENDING_PATTERN = /\r$/;

interface JsonRpcResponse {
  result?: {
    isError?: boolean;
    structuredContent?: { data?: unknown };
    tools?: { name?: string }[];
  };
}

// The hosted MCP server may answer JSON-RPC over either application/json or an
// SSE-framed text/event-stream. Normalize both to the parsed JSON-RPC object so
// the assertions do not care which transport the deploy negotiated.
export function parseMcpResponseText(contentType: string | null | undefined, text: string): JsonRpcResponse | null {
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("text/event-stream")) {
    // Concatenate the data: lines of the last event and JSON.parse them.
    const dataLines: string[] = [];
    for (const rawLine of String(text).split("\n")) {
      const line = rawLine.replace(SSE_LINE_ENDING_PATTERN, "");
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim());
      }
    }
    const payload = dataLines.join("");
    return payload ? JSON.parse(payload) : null;
  }
  return text ? JSON.parse(text) : null;
}

// query_records returns its page under result.structuredContent.data; the RS
// body is the canonical { data: [...] } (or a bare array). Pull the record list
// out without caring which envelope nesting the version uses.
export function extractRecordsFromQueryResult(rpc: JsonRpcResponse | null): unknown[] {
  const structured = rpc?.result?.structuredContent?.data;
  if (structured === null || structured === undefined) {
    return [];
  }
  // Canonical RS read body: { data: [...] } or a bare array.
  if (Array.isArray(structured)) {
    return structured;
  }
  const structuredObj = structured as { data?: unknown; records?: unknown };
  if (Array.isArray(structuredObj.data)) {
    return structuredObj.data;
  }
  if (Array.isArray(structuredObj.records)) {
    return structuredObj.records;
  }
  return [];
}

export interface SeedPresenceVerdict {
  foundKeys?: string[];
  ok: boolean;
  reason?: string;
  returnedKeys?: string[];
}

// Assert the seeded records are present in a query_records result. Returns a
// structured verdict so the caller can report which keys were found/missing.
export function assertSeedRecordsPresent(
  rpc: JsonRpcResponse | null,
  expectedRecords: SeedRecord[] = SEED_RECORDS
): SeedPresenceVerdict {
  if (rpc?.result?.isError) {
    return { ok: false, reason: `query_records returned an MCP error: ${JSON.stringify(rpc.result)}` };
  }
  const returned = extractRecordsFromQueryResult(rpc);
  const returnedKeys = new Set(
    returned
      .map((entry) => {
        const e = entry as { data?: { id?: unknown }; id?: unknown; key?: unknown };
        return e.key ?? e.id ?? e.data?.id;
      })
      .filter((k): k is string | number => k !== null && k !== undefined)
      .map(String)
  );
  const expectedKeys = expectedRecords.map((record) => record.key);
  const missing = expectedKeys.filter((key) => !returnedKeys.has(key));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `seeded record(s) missing from query result: ${missing.join(", ")}`,
      returnedKeys: [...returnedKeys],
    };
  }
  return { ok: true, foundKeys: expectedKeys };
}

export interface AnonymousMcpVerdict {
  code: string;
  refused: boolean;
}

// Classify an anonymous /mcp probe. The hosted MCP surface must refuse a
// request with no Authorization header. 401 is the contract; we also treat 403
// as a refusal (token-kind guard) but the gate asserts 401 specifically per the
// runbook. Any 2xx is a hard failure (anonymous data access).
export function classifyAnonymousMcpStatus(status: number): AnonymousMcpVerdict {
  if (status === 401) {
    return { refused: true, code: "unauthorized" };
  }
  if (status === 403) {
    return { refused: true, code: "forbidden" };
  }
  if (status >= 200 && status < 300) {
    return { refused: false, code: "allowed" };
  }
  // Any other non-2xx still means anonymous access did not succeed.
  return { refused: true, code: `http_${status}` };
}

// PKCE S256 challenge for the client authorization-code flow.
export function pkceChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

// ---------------------------------------------------------------------------
// Live HTTP driver. Only runs when an --origin is provided.
// ---------------------------------------------------------------------------

class SmokeError extends Error {}

interface ReadBodyResult {
  json: unknown;
  text: string;
}

async function readBody(resp: Response): Promise<ReadBodyResult> {
  const text = await resp.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { text, json };
}

function reviewedConsent(body: unknown, requestUri: string): { requestUri: string; revision: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new SmokeError("consent review returned a non-object body");
  }
  const review = body as {
    approval_review?: unknown;
    approval_review_revision?: unknown;
    request_uri?: unknown;
  };
  if (!review.approval_review || typeof review.approval_review !== "object" || Array.isArray(review.approval_review)) {
    throw new SmokeError("consent review returned without the exact approval artifact");
  }
  if (typeof review.approval_review_revision !== "string" || !review.approval_review_revision) {
    throw new SmokeError("consent review returned without approval_review_revision");
  }
  if (review.request_uri !== requestUri) {
    throw new SmokeError("consent review returned a different canonical request_uri");
  }
  return { requestUri, revision: review.approval_review_revision };
}

type LogFn = (message: string) => void;

// Establish an owner session via the shared owner-session helper
// (scripts/lib/owner-session.ts — the one place that drives the
// CSRF-protected /owner/login form). When the deploy has no owner password
// (open local-dev), GET /owner/login still returns a usable form or a
// redirect and we proceed with no cookie; the device flow then mints a
// token directly.
async function establishOwnerSession(origin: string, ownerPassword: string, log: LogFn): Promise<string> {
  if (!ownerPassword) {
    log("owner-login: no --owner-password given; assuming open local-dev owner auth");
    return "";
  }
  let sessionCookie: string | undefined;
  try {
    sessionCookie = await establishOwnerSessionCookie({ origin, ownerPassword });
  } catch (err) {
    throw new SmokeError(
      `owner-login: ${err instanceof Error ? err.message : String(err)}. ` +
        "Is owner auth enabled (PDPP_OWNER_PASSWORD set) and the origin correct?",
      { cause: err }
    );
  }
  log("owner-login: owner session established");
  return sessionCookie ?? "";
}

// Mint an owner access token via the device flow. /device/approve is owner-
// session gated when a password is set, so we carry the session cookie.
export async function mintOwnerToken(
  origin: string,
  sessionCookie: string,
  subjectId: string,
  log: LogFn
): Promise<string> {
  const clientId = "pdpp-polyfill-owner-bootstrap";
  const deviceResp = await fetch(`${origin}/oauth/device_authorization`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId }),
  });
  if (deviceResp.status !== 200) {
    const { text } = await readBody(deviceResp);
    throw new SmokeError(`device_authorization failed ${deviceResp.status}: ${text}`);
  }
  const device = (await readBody(deviceResp)).json as { device_code: string; user_code: string };

  const approveResp = await fetch(`${origin}/device/approve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
    },
    body: JSON.stringify({ user_code: device.user_code, subject_id: subjectId }),
  });
  if (approveResp.status !== 200) {
    const { text } = await readBody(approveResp);
    throw new SmokeError(
      `device/approve failed ${approveResp.status}: ${text}. ` +
        "If owner auth is enabled, pass --owner-password so the session can approve."
    );
  }

  const tokenResp = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: device.device_code,
      client_id: clientId,
    }),
  });
  if (tokenResp.status !== 200) {
    const { text } = await readBody(tokenResp);
    throw new SmokeError(`/oauth/token (device_code) failed ${tokenResp.status}: ${text}`);
  }
  log("owner-token: minted owner access token");
  return ((await readBody(tokenResp)).json as { access_token: string }).access_token;
}

async function registerSeedManifest(
  origin: string,
  sessionCookie: string,
  log: LogFn
): Promise<Record<string, unknown>> {
  // The manifest body is small; fetch it from the running AS would be circular,
  // so we register the same connector_id/streams the committed spotify fixture
  // declares. Re-register is idempotent (409 on unchanged version is fine).
  const manifest = {
    connector_id: SEED_CONNECTOR_ID,
    protocol_version: "0.1.0",
    display_name: "Spotify (Railway seed fixture)",
    name: "Spotify (Railway seed fixture)",
    version: "1.0.0",
    streams: [
      {
        name: SEED_STREAM,
        description: "Railway Core smoke fixture artists",
        semantics: "mutable_state",
        schema: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            genres: { type: "array", items: { type: "string" } },
            popularity: { type: "integer" },
            followers: { type: "integer" },
            source_updated_at: { type: "string", format: "date-time" },
          },
          required: ["id", "name"],
        },
        primary_key: ["id"],
        cursor_field: "source_updated_at",
        consent_time_field: "source_updated_at",
        selection: { fields: true, resources: true },
      },
    ],
  };
  const resp = await fetch(`${origin}/connectors`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
    },
    body: JSON.stringify(manifest),
  });
  if (![200, 201, 409].includes(resp.status)) {
    const { text } = await readBody(resp);
    throw new SmokeError(`register manifest failed ${resp.status}: ${text}`);
  }
  log(`manifest: ${SEED_CONNECTOR_ID} registered (status ${resp.status})`);
  return manifest;
}

// Fail-closed pre-mutation gate for the disposable-environment mutation smoke
// (--disposable-env). The only way this codebase can produce a genuinely
// disposable connector instance over the public bearer-token HTTP API is to
// let ingest materialize the deterministic default-account connection for
// SEED_CONNECTOR_ID (see resolveOwnerConnectorInstanceNamespace /
// materializeDefaultAccount in reference-implementation/server/stores/
// connector-instance-store.ts) — and that connection can NEVER be deleted
// through the public API once created (assertDeletableConnection refuses
// default-account bindings unconditionally, by design, not as a bug). So the
// only way to avoid ever mutating a pre-existing owner connection is to prove,
// immediately before seeding, that the owner has ZERO connections at all: if
// this is true, the default-account connection ingest is about to create is
// provably NEW, not a pre-existing one. A non-empty list means this is not a
// disposable/fresh environment, and the smoke must abort before any mutation.
async function assertOwnerHasNoExistingConnections(origin: string, ownerToken: string, log: LogFn): Promise<void> {
  const resp = await fetch(`${origin}/v1/owner/connections`, {
    method: "GET",
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  const { text, json } = await readBody(resp);
  if (resp.status !== 200) {
    throw new SmokeError(`pre-seed connection listing failed ${resp.status}: ${text}`);
  }
  const listing = json as { data?: unknown[] } | null;
  const existing = Array.isArray(listing?.data) ? listing.data : null;
  if (existing === null) {
    throw new SmokeError(`pre-seed connection listing returned an unexpected body: ${text}`);
  }
  if (existing.length > 0) {
    const ids = existing
      .map((entry) => (entry as { connection_id?: unknown }).connection_id)
      .filter((id): id is string => typeof id === "string");
    throw new SmokeError(
      `refusing to seed: this owner already has ${existing.length} connection(s) (${ids.join(", ") || "unknown ids"}). ` +
        "--disposable-env only runs against an owner with zero pre-existing connections, so seeding can never bind to " +
        "a pre-existing default connection. Use the default read-only mode against a production/persistent deploy instead."
    );
  }
  log("pre-seed guard: owner has zero pre-existing connections; safe to seed a fresh default-account connection");
}

async function seedRecords(origin: string, ownerToken: string, log: LogFn): Promise<void> {
  const url = `${origin}/v1/ingest/${encodeURIComponent(SEED_STREAM)}?connector_id=${encodeURIComponent(SEED_CONNECTOR_ID)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      "Content-Type": "application/x-ndjson",
    },
    body: buildSeedNdjson(),
  });
  const { text, json } = await readBody(resp);
  if (resp.status !== 200) {
    throw new SmokeError(`ingest failed ${resp.status}: ${text}`);
  }
  const ingestResult = json as { errors?: unknown; records_accepted?: number; records_rejected?: number } | null;
  if (!ingestResult || ingestResult.records_accepted !== SEED_RECORDS.length) {
    throw new SmokeError(
      `ingest accepted ${ingestResult?.records_accepted} of ${SEED_RECORDS.length} records; rejected ${ingestResult?.records_rejected}. errors=${JSON.stringify(ingestResult?.errors)}`
    );
  }
  log(`seed: ingested ${ingestResult.records_accepted} record(s) into ${SEED_STREAM}`);
}

export interface CleanupResult {
  deletedKeys: string[];
  errors: string[];
  ok: boolean;
  residualKeys: string[];
}

// Best-effort-but-verified teardown for the disposable-environment mutation
// smoke. The default-account connection created by seedRecords can never be
// deleted through the public API (assertDeletableConnection refuses
// default-account bindings unconditionally — see
// reference-implementation/server/stores/connector-instance-store.ts), so
// exact cleanup here means record-level tombstone delete of precisely the
// seeded keys, verified by re-querying afterward. It does not touch any other
// record, stream, or connection. Every attempted deletion and the final
// verification query are recorded so a residual record surfaces as a named,
// non-green failure rather than a silent gap.
export async function cleanupSeedRecords(
  origin: string,
  ownerToken: string,
  clientToken: string,
  log: LogFn,
  records: SeedRecord[] = SEED_RECORDS
): Promise<CleanupResult> {
  const deletedKeys: string[] = [];
  const errors: string[] = [];
  for (const record of records) {
    const url =
      `${origin}/v1/streams/${encodeURIComponent(SEED_STREAM)}/records/${encodeURIComponent(record.key)}` +
      `?connector_id=${encodeURIComponent(SEED_CONNECTOR_ID)}`;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: sequential by design — the seed corpus is a fixed, tiny (2-record) list, and deleting one key at a time keeps each attempt's log line and error message unambiguously ordered/attributed for the cleanup receipt.
      const resp = await fetch(url, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      if (resp.status === 204) {
        deletedKeys.push(record.key);
        log(`cleanup: deleted seeded record ${record.key}`);
      } else {
        const { text } = await readBody(resp);
        errors.push(`delete ${record.key} failed ${resp.status}: ${text}`);
      }
    } catch (err) {
      errors.push(`delete ${record.key} threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Verify exactly: re-query and confirm none of the seeded keys are still
  // live. A record surviving tombstone delete is residue, not a clean run.
  let residualKeys: string[] = [];
  try {
    const query = await mcpPost(origin, clientToken, mcpQueryRecordsMessage(SEED_STREAM, { limit: 50 }));
    if (query.status === 200) {
      const returned = extractRecordsFromQueryResult(query.rpc);
      const returnedKeys = new Set(
        returned
          .map((entry) => {
            const e = entry as { data?: { id?: unknown }; id?: unknown; key?: unknown };
            return e.key ?? e.id ?? e.data?.id;
          })
          .filter((k): k is string | number => k !== null && k !== undefined)
          .map(String)
      );
      residualKeys = records.map((r) => r.key).filter((key) => returnedKeys.has(key));
    } else {
      errors.push(`post-cleanup verification query failed ${query.status}: ${query.text}`);
    }
  } catch (err) {
    errors.push(`post-cleanup verification query threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  const ok = errors.length === 0 && residualKeys.length === 0;
  if (ok) {
    log(`cleanup: verified zero live seeded records remain (${deletedKeys.length} tombstoned)`);
  } else {
    log(`cleanup: FAILED — residual keys [${residualKeys.join(", ")}], errors [${errors.join(" | ")}]`);
  }
  return { deletedKeys, errors, ok, residualKeys };
}

async function assertAnonymousMcpRefused(origin: string, log: LogFn): Promise<number> {
  const resp = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify(mcpInitializeMessage()),
  });
  const verdict = classifyAnonymousMcpStatus(resp.status);
  if (!verdict.refused) {
    throw new SmokeError(
      `anonymous /mcp was NOT refused (status ${resp.status}). A public origin must not serve MCP anonymously.`
    );
  }
  if (resp.status === 401) {
    log("anonymous /mcp refused with 401");
  } else {
    log(`anonymous /mcp refused with ${resp.status} (${verdict.code}); runbook expects 401`);
  }
  return resp.status;
}

// Mint a client access token scoped to the seeded connector via the OAuth
// authorization-code flow with consent approval under the owner session.
async function mintClientToken(origin: string, sessionCookie: string, log: LogFn): Promise<string> {
  const registerResp = await fetch(`${origin}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Railway MCP query smoke client",
      redirect_uris: ["https://client.example/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      application_type: "web",
      token_endpoint_auth_method: "none",
    }),
  });
  if (registerResp.status !== 201) {
    const { text } = await readBody(registerResp);
    throw new SmokeError(`oauth/register failed ${registerResp.status}: ${text}`);
  }
  const client = (await readBody(registerResp)).json as { client_id: string };

  const verifier = crypto.randomBytes(32).toString("base64url");
  const authorizationDetails = [
    {
      type: "https://pdpp.dev/data-access",
      source: { kind: "connector", id: SEED_CONNECTOR_ID },
      purpose_code: "https://pdpp.dev/purpose/personal_ai_assistant",
      purpose_description: "Railway MCP query smoke",
      access_mode: "continuous",
      streams: [{ name: "*" }],
    },
  ];
  const authorizeUrl = new URL(`${origin}/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", client.client_id);
  authorizeUrl.searchParams.set("redirect_uri", "https://client.example/callback");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", "railway-smoke");
  authorizeUrl.searchParams.set("code_challenge", pkceChallenge(verifier));
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("authorization_details", JSON.stringify(authorizationDetails));

  const authorizeResp = await fetch(authorizeUrl, {
    redirect: "manual",
    headers: sessionCookie ? { Cookie: sessionCookie } : {},
  });
  if (authorizeResp.status !== 302) {
    const { text } = await readBody(authorizeResp);
    throw new SmokeError(`oauth/authorize expected 302, got ${authorizeResp.status}: ${text}`);
  }
  const authorizeLocation = authorizeResp.headers.get("location");
  if (!authorizeLocation) {
    throw new SmokeError("oauth/authorize returned 302 with no Location header");
  }
  const consentUrl = new URL(authorizeLocation, origin);
  const requestUri = consentUrl.searchParams.get("request_uri");
  if (!requestUri) {
    throw new SmokeError("oauth/authorize did not return a consent request_uri");
  }

  // Consent approval is owner-session + CSRF gated. Read the consent CSRF from
  // the consent page rendered for this request_uri, then approve.
  const consentPageResp = await fetch(consentUrl, {
    headers: { Accept: "text/html", ...(sessionCookie ? { Cookie: sessionCookie } : {}) },
    redirect: "manual",
  });
  const consentCsrfCookie = findSetCookiePair(getSetCookieList(consentPageResp), "pdpp_owner_csrf");
  const consentCsrfField = extractCsrfFieldValue(await consentPageResp.text());

  const reviewResp = await fetch(`${origin}/consent/review`, {
    body: JSON.stringify({ request_uri: requestUri }),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
    },
    method: "POST",
  });
  const reviewResult = await readBody(reviewResp);
  if (!reviewResp.ok) {
    throw new SmokeError(`consent/review failed ${reviewResp.status}: ${reviewResult.text}`);
  }
  const review = reviewedConsent(reviewResult.json, requestUri);

  const approveHeaders: Record<string, string> = {
    Accept: "text/html",
    "Content-Type": "application/x-www-form-urlencoded",
  };
  const cookieParts = [sessionCookie, consentCsrfCookie].filter(Boolean);
  if (cookieParts.length > 0) {
    approveHeaders.Cookie = cookieParts.join("; ");
  }
  const approveBody: Record<string, string> = {
    approval_review_revision: review.revision,
    request_uri: review.requestUri,
  };
  if (consentCsrfField) {
    approveBody._csrf = consentCsrfField;
  }

  const approveResp = await fetch(`${origin}/consent/approve`, {
    method: "POST",
    redirect: "manual",
    headers: approveHeaders,
    body: new URLSearchParams(approveBody).toString(),
  });
  if (approveResp.status !== 302) {
    const { text } = await readBody(approveResp);
    throw new SmokeError(`consent/approve expected 302, got ${approveResp.status}: ${text}`);
  }
  const approveLocation = approveResp.headers.get("location");
  if (!approveLocation) {
    throw new SmokeError("consent/approve returned 302 with no Location header");
  }
  const callback = new URL(approveLocation);
  const code = callback.searchParams.get("code");
  if (!code) {
    throw new SmokeError("consent/approve did not return an authorization code");
  }

  const tokenResp = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: "https://client.example/callback",
      code_verifier: verifier,
    }).toString(),
  });
  if (tokenResp.status !== 200) {
    const { text } = await readBody(tokenResp);
    throw new SmokeError(`oauth/token (authorization_code) failed ${tokenResp.status}: ${text}`);
  }
  log("client-token: minted scoped client access token");
  return ((await readBody(tokenResp)).json as { access_token: string }).access_token;
}

interface McpPostResult {
  rpc: JsonRpcResponse | null;
  status: number;
  text: string;
}

async function mcpPost(origin: string, token: string, message: McpMessage): Promise<McpPostResult> {
  const resp = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
  });
  const text = await resp.text();
  const rpc = parseMcpResponseText(resp.headers.get("content-type"), text);
  return { status: resp.status, rpc, text };
}

async function runScopedMcpQuery(origin: string, clientToken: string, log: LogFn): Promise<void> {
  const init = await mcpPost(origin, clientToken, mcpInitializeMessage());
  if (init.status !== 200) {
    throw new SmokeError(`MCP initialize failed ${init.status}: ${init.text}`);
  }

  const list = await mcpPost(origin, clientToken, mcpToolsListMessage());
  if (list.status !== 200) {
    throw new SmokeError(`MCP tools/list failed ${list.status}: ${list.text}`);
  }
  const tools = list.rpc?.result?.tools ?? [];
  const hasQuery = tools.some((t) => t?.name === "query_records");
  if (!hasQuery) {
    throw new SmokeError(
      `tools/list did not advertise query_records (got ${tools.map((t) => t?.name).join(", ") || "none"})`
    );
  }
  log(`tools/list: ${tools.length} tool(s); query_records present`);

  const query = await mcpPost(origin, clientToken, mcpQueryRecordsMessage(SEED_STREAM, { limit: 10 }));
  if (query.status !== 200) {
    throw new SmokeError(`query_records failed ${query.status}: ${query.text}`);
  }
  const verdict = assertSeedRecordsPresent(query.rpc);
  if (!verdict.ok) {
    throw new SmokeError(`query_records: ${verdict.reason}`);
  }
  log(`query_records: seeded record(s) returned (${verdict.foundKeys?.join(", ")})`);
}

export interface SeedDisposableEnvOptions {
  logger?: LogFn;
  origin: string;
  ownerPassword: string;
  subjectId: string;
}

// Seed-only entry point for a caller that IS itself a whole-environment
// disposable harness with its own guaranteed teardown (a fresh Docker Compose
// project + ephemeral volume torn down by a `trap ... EXIT`, e.g.
// railway-sqlite-restart-smoke.sh). That harness needs the seeded records to
// remain live across an intermediate step (a container restart) before its
// OWN trap destroys the entire environment (database included) — a
// per-record tombstone-delete here would erase the very records the restart
// step must prove survived, and would be redundant anyway since the whole
// database is about to be destroyed regardless.
//
// This is deliberately NOT a general escape hatch on runLiveSmoke: it does
// not accept a --skip-cleanup style flag, is not reachable from the CLI, and
// still runs the exact same fail-closed assertOwnerHasNoExistingConnections
// gate — it only omits the tombstone-delete step because the caller's own
// environment-teardown trap is the cleanup. Any caller reaching for this
// function must own a real whole-environment teardown; a caller that does
// not must use runLiveSmoke's --disposable-env mode instead, which always
// self-cleans.
export async function seedDisposableEnv(options: SeedDisposableEnvOptions): Promise<void> {
  const { origin, ownerPassword, subjectId, logger } = options;
  const log = logger ?? (() => undefined);
  const sessionCookie = await establishOwnerSession(origin, ownerPassword, log);
  const ownerToken = await mintOwnerToken(origin, sessionCookie, subjectId, log);
  await assertOwnerHasNoExistingConnections(origin, ownerToken, log);
  await registerSeedManifest(origin, sessionCookie, log);
  await seedRecords(origin, ownerToken, log);
  await assertAnonymousMcpRefused(origin, log);
  const clientToken = await mintClientToken(origin, sessionCookie, log);
  await runScopedMcpQuery(origin, clientToken, log);
}

export interface RunLiveSmokeOptions {
  disposableEnv?: boolean;
  logger?: LogFn;
  origin: string;
  ownerPassword: string;
  subjectId: string;
}

// Production acceptance path (default, no flag): strictly read-only. It never
// registers a manifest, never ingests, and never deletes anything — it only
// proves the hosted MCP endpoint refuses anonymous access and returns
// whatever records already exist for the seed stream. Safe to run repeatedly
// against a real, persistent deployment with a real owner connection.
//
// Disposable-environment mutation smoke (--disposable-env): the ONLY mode
// that seeds. It is gated by assertOwnerHasNoExistingConnections, which
// refuses to run unless the owner has zero pre-existing connections —
// proving the default-account connection ingest is about to materialize is
// new, not a pre-existing owner connection (see that function's comment for
// why this is the only available proof: the public API has no route to
// create a non-default disposable instance, and the default-account
// connection this creates can never itself be deleted). Cleanup of the
// seeded records is guaranteed on every failure point after seeding —
// including a thrown assertion from the anonymous-mcp check, client-token
// minting, or the scoped query itself — by capturing that failure instead of
// letting it escape immediately, always running cleanup exactly once
// afterward, then re-throwing. A cleanup failure or residual record throws,
// so the run cannot report success while leaving the fixture behind.
export async function runLiveSmoke(options: RunLiveSmokeOptions): Promise<void> {
  const { origin, ownerPassword, subjectId, logger, disposableEnv = false } = options;
  const log = logger ?? (() => undefined);
  // An owner session is needed either way: the client-token consent approval
  // is owner-gated, and (in --disposable-env mode) so is the seed ingest.
  const sessionCookie = await establishOwnerSession(origin, ownerPassword, log);

  if (!disposableEnv) {
    log("mode: production acceptance (read-only); querying existing records only");
    await assertAnonymousMcpRefused(origin, log);
    const clientToken = await mintClientToken(origin, sessionCookie, log);
    await runScopedMcpQuery(origin, clientToken, log);
    return;
  }

  log("mode: disposable-environment mutation smoke (--disposable-env)");
  const ownerToken = await mintOwnerToken(origin, sessionCookie, subjectId, log);
  await assertOwnerHasNoExistingConnections(origin, ownerToken, log);
  await registerSeedManifest(origin, sessionCookie, log);

  // Guaranteed cleanup from the seed ingest call onward: `primaryError`
  // captures a failing seedRecords, assertAnonymousMcpRefused, client-token
  // mint, or scoped query without letting it escape yet, so cleanup always
  // gets a chance to mint its own client token (if the failure happened
  // before one existed) and run exactly once — never skipped, never retried
  // a second time. seedRecords is deliberately INSIDE this boundary (not
  // called before it): its ingest HTTP call can itself return 200 with a
  // PARTIAL accept count and then throw on that mismatch — that throw is a
  // failure point AFTER a real mutation already happened, so it must still
  // reach cleanup. Cleanup's per-key DELETE is safe to run even when
  // seedRecords never ingested a given key at all (a total ingest failure):
  // the RS delete route returns 204 whether the deleted count was 0 or 1
  // (reference-implementation/operations/rs-records-delete/index.ts), so a
  // record that was never created still tombstones as a clean no-op rather
  // than surfacing as cleanup residue. Any cleanup-stage failure (minting or
  // the delete/verify itself) is thrown with the prior primaryError (if any)
  // attached as `cause`, so a doubly-failed run reports both instead of
  // masking one.
  let primaryError: unknown;
  let clientToken: string | undefined;
  try {
    await seedRecords(origin, ownerToken, log);
    await assertAnonymousMcpRefused(origin, log);
    clientToken = await mintClientToken(origin, sessionCookie, log);
    await runScopedMcpQuery(origin, clientToken, log);
  } catch (err) {
    primaryError = err;
  }

  const withPrimaryCause = (message: string): SmokeError =>
    new SmokeError(
      primaryError
        ? `${message} (run also failed: ${primaryError instanceof Error ? primaryError.message : String(primaryError)})`
        : message,
      primaryError ? { cause: primaryError } : undefined
    );

  let cleanupClientToken: string;
  try {
    cleanupClientToken = clientToken ?? (await mintClientToken(origin, sessionCookie, log));
  } catch (mintErr) {
    throw withPrimaryCause(
      `cleanup could not mint a client token to verify teardown (${mintErr instanceof Error ? mintErr.message : String(mintErr)}); ` +
        `seeded records for keys [${SEED_RECORDS.map((r) => r.key).join(", ")}] may still be live`
    );
  }
  const cleanup = await cleanupSeedRecords(origin, ownerToken, cleanupClientToken, log);
  if (!cleanup.ok) {
    throw withPrimaryCause(
      `cleanup did not converge: residual keys [${cleanup.residualKeys.join(", ")}], errors [${cleanup.errors.join(" | ")}]`
    );
  }
  if (primaryError) {
    throw primaryError;
  }
}

// ---------------------------------------------------------------------------
// CLI entry.
// ---------------------------------------------------------------------------

interface ParsedArgs {
  disposableEnv?: boolean;
  help?: boolean;
  json: boolean;
  origin?: string | undefined;
  ownerPassword?: string | undefined;
  subjectId?: string | undefined;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const out: ParsedArgs = { json: false };
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--json") {
      out.json = true;
    } else if (arg === "--disposable-env") {
      out.disposableEnv = true;
    } else if (arg === "--origin") {
      i += 1;
      out.origin = args[i];
    } else if (arg === "--owner-password") {
      i += 1;
      out.ownerPassword = args[i];
    } else if (arg === "--subject") {
      i += 1;
      out.subjectId = args[i];
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    }
    i += 1;
  }
  return out;
}

const USAGE = `Usage: node scripts/railway-mcp-query-smoke.ts --origin <https-origin> [options]

Options:
  --origin <url>            Composed-origin base URL (required for the live run).
  --owner-password <secret> Owner password (or set PDPP_OWNER_PASSWORD). Needed
                            when the deploy has owner auth enabled (it should).
  --subject <id>            Owner subject id (default: PDPP_OWNER_SUBJECT_ID or owner_local).
  --disposable-env          Seed a deterministic record set and clean it up before
                            exiting. REFUSES to run unless the owner has ZERO
                            pre-existing connections (see the runbook) — never use
                            against a persistent/production deploy with a real
                            owner connection. Without this flag the run is strictly
                            read-only: it only proves the hosted MCP endpoint
                            refuses anonymous access and returns whatever records
                            already exist for the seed stream. This is the safe
                            default for production acceptance and for the
                            restart-survival check (persistence without
                            re-writing records).
  --json                    Emit a JSON result object.
  -h, --help                Show this help.

Default (read-only): proves the hosted MCP endpoint refuses anonymous access and
returns existing seed-stream records for a scoped grant. Safe against production.

--disposable-env: additionally seeds a deterministic record set (no connector
run) into a fresh environment, then tombstone-deletes and verifies it before
exiting — refuses to run at all if the owner already has any connection.`;

const TRAILING_SLASH_PATTERN = /\/$/;

async function main(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  if (!opts.origin) {
    process.stderr.write(`--origin is required.\n\n${USAGE}\n`);
    process.exit(2);
  }
  const origin = opts.origin.replace(TRAILING_SLASH_PATTERN, "");
  const ownerPassword = opts.ownerPassword ?? process.env.PDPP_OWNER_PASSWORD ?? "";
  const subjectId = opts.subjectId ?? process.env.PDPP_OWNER_SUBJECT_ID ?? "owner_local";

  const steps: string[] = [];
  const log: LogFn = (message) => {
    steps.push(message);
    if (!opts.json) {
      process.stdout.write(`  ${message}\n`);
    }
  };

  if (!opts.json) {
    process.stdout.write(`Railway MCP query smoke against ${origin}\n`);
  }
  try {
    await runLiveSmoke({ origin, ownerPassword, subjectId, logger: log, disposableEnv: Boolean(opts.disposableEnv) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, origin, steps, error: message }, null, 2)}\n`);
    } else {
      process.stderr.write(`\nRailway MCP query smoke FAILED: ${message}\n`);
    }
    process.exit(1);
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, origin, steps }, null, 2)}\n`);
  } else {
    process.stdout.write(`\nRailway MCP query smoke passed for ${origin}\n`);
  }
  process.exit(0);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main(process.argv);
}
