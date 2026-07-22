#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Deterministic record-seed + scripted external MCP query for the Railway Core
// deploy gate (openspec/changes/add-railway-core-deploy-target task 3.2,
// deploy/railway/README.md "First-live-test gate" steps 5 and 6).
//
// This is the executable proxy for the two live acceptance steps that the
// offline env-contract check (scripts/check-railway-deploy-env.mjs) and the
// composed-origin smoke (scripts/docker-smoke.sh) do NOT cover:
//
//   - a small, hand-seeded record set lands WITHOUT running a browser connector;
//   - the hosted MCP endpoint refuses anonymous access AND completes a scoped
//     tools/list + query_records that returns exactly that seeded record.
//
// It uses only the public protocol surface against ONE composed origin — the
// same surface a real MCP client and a real owner would use. It does not import
// the reference server, touch a database directly, or require any package
// install: it runs on Node's built-in fetch with zero dependencies, exactly
// like check-railway-deploy-env.mjs. The pure helpers below are exercised
// offline by railway-mcp-query-smoke.test.mjs; the live driver runs against a
// real stack (local composed-origin via `pnpm docker:smoke`'s images, or a live
// Railway origin) only when an --origin is given.
//
// Seed path (in-contract, owner-authenticated, no connector run):
//   1. POST /owner/login          → owner session cookie (when a password is set)
//   2. device flow under that session → owner access token
//   3. POST /connectors           → register a fixture connector manifest
//   4. POST /v1/ingest/:stream    → NDJSON records (owner-gated ingest)
//
// Query path (external MCP client, scoped grant):
//   5. POST/GET /mcp (no auth)    → MUST refuse (401)
//   6. POST /oauth/register       → dynamic client
//      GET  /oauth/authorize      → consent request_uri
//      POST /consent/approve      → authorization code (under owner session)
//      POST /oauth/token          → client access token (scoped to the connector)
//      POST /mcp initialize / tools/list / tools/call query_records
//                                 → seeded record returned
//
// Usage:
//   node scripts/railway-mcp-query-smoke.mjs --origin https://your-console-domain
//   node scripts/railway-mcp-query-smoke.mjs --origin http://localhost:3002 \
//        --owner-password "$PDPP_OWNER_PASSWORD"
//   node scripts/railway-mcp-query-smoke.mjs --origin <origin> --json
//
// When the deploy follows the documented security posture, PDPP_OWNER_PASSWORD
// is set; pass it via --owner-password or the env var so the seed step can
// establish an owner session. Against an open local-dev server (no password)
// the login step is a no-op and the device flow mints a token directly.
//
// Exit codes: 0 = the seed + MCP query gate passed; 1 = a check failed or the
// origin was unreachable; 2 = usage error.

import crypto from "node:crypto";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  establishOwnerSessionCookie,
  extractCsrfFieldValue,
  findSetCookiePair,
  getSetCookieList,
} from "./lib/owner-session.mjs";

// Re-exported for this module's own offline unit tests
// (railway-mcp-query-smoke.test.mjs), which pin the cookie/CSRF parsing
// contract. The implementation lives in scripts/lib/owner-session.mjs —
// the one shared owner-session acquisition path — not here.
export { extractCsrfFieldValue, findSetCookiePair };

// ---------------------------------------------------------------------------
// Deterministic seed corpus (pure data).
// ---------------------------------------------------------------------------

// A registered fixture connector manifest is required before /v1/ingest will
// accept records (the stream must be manifest-visible). `spotify` is an existing
// committed fixture manifest used across the test suite, so the seed reuses it
// rather than inventing a connector. The records are hand-built here, NOT
// produced by running the seed connector — task 3.2 is explicit that the seed is
// a hand-imported fixture with no connector run.
export const SEED_CONNECTOR_ID = "https://registry.pdpp.org/connectors/spotify";
export const SEED_STREAM = "top_artists";

// Stable keys + matching data.id (ingestRecord rejects a key that disagrees with
// data.id). Deterministic timestamps keep re-runs byte-identical; the live
// smoke deliberately avoids unadvertised sort fields and only asserts presence.
export const SEED_RECORDS = [
  {
    data: {
      followers: 10,
      genres: ["test-fixture"],
      id: "railway-seed-artist-1",
      name: "Deploy Test Quartet",
      popularity: 41,
      source_updated_at: "2026-01-01T00:00:01.000Z",
    },
    emitted_at: "2026-01-01T00:00:01.000Z",
    key: "railway-seed-artist-1",
  },
  {
    data: {
      followers: 20,
      genres: ["test-fixture"],
      id: "railway-seed-artist-2",
      name: "Restart Survival Band",
      popularity: 42,
      source_updated_at: "2026-01-01T00:00:02.000Z",
    },
    emitted_at: "2026-01-01T00:00:02.000Z",
    key: "railway-seed-artist-2",
  },
];

// Build the NDJSON body POST /v1/ingest/:stream expects: one JSON record per
// line. The operation splits on \n and JSON.parses each non-empty line.
export function buildSeedNdjson(records = SEED_RECORDS) {
  return records.map((record) => JSON.stringify(record)).join("\n");
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC framing (pure).
// ---------------------------------------------------------------------------

export function mcpInitializeMessage(id = 1) {
  return {
    id,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: "railway-mcp-query-smoke", version: "1" },
      protocolVersion: "2024-11-05",
    },
  };
}

export function mcpToolsListMessage(id = 2) {
  return { id, jsonrpc: "2.0", method: "tools/list", params: {} };
}

export function mcpQueryRecordsMessage(stream, args = {}, id = 3) {
  return {
    id,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: { stream, ...args }, name: "query_records" },
  };
}

// The hosted MCP server may answer JSON-RPC over either application/json or an
// SSE-framed text/event-stream. Normalize both to the parsed JSON-RPC object so
// the assertions do not care which transport the deploy negotiated.
export function parseMcpResponseText(contentType, text) {
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("text/event-stream")) {
    // Concatenate the data: lines of the last event and JSON.parse them.
    const dataLines = [];
    for (const rawLine of String(text).split("\n")) {
      const line = rawLine.replace(/\r$/, "");
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
export function extractRecordsFromQueryResult(rpc) {
  const structured = rpc?.result?.structuredContent?.data;
  if (structured == null) {
    return [];
  }
  // Canonical RS read body: { data: [...] } or a bare array.
  if (Array.isArray(structured)) {
    return structured;
  }
  if (Array.isArray(structured.data)) {
    return structured.data;
  }
  if (Array.isArray(structured.records)) {
    return structured.records;
  }
  return [];
}

// Assert the seeded records are present in a query_records result. Returns a
// structured verdict so the caller can report which keys were found/missing.
export function assertSeedRecordsPresent(rpc, expectedRecords = SEED_RECORDS) {
  if (rpc?.result?.isError) {
    return { ok: false, reason: `query_records returned an MCP error: ${JSON.stringify(rpc.result)}` };
  }
  const returned = extractRecordsFromQueryResult(rpc);
  const returnedKeys = new Set(
    returned.map((entry) => entry?.key ?? entry?.id ?? entry?.data?.id).filter((k) => k != null)
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
  return { foundKeys: expectedKeys, ok: true };
}

// Classify an anonymous /mcp probe. The hosted MCP surface must refuse a
// request with no Authorization header. 401 is the contract; we also treat 403
// as a refusal (token-kind guard) but the gate asserts 401 specifically per the
// runbook. Any 2xx is a hard failure (anonymous data access).
export function classifyAnonymousMcpStatus(status) {
  if (status === 401) {
    return { code: "unauthorized", refused: true };
  }
  if (status === 403) {
    return { code: "forbidden", refused: true };
  }
  if (status >= 200 && status < 300) {
    return { code: "allowed", refused: false };
  }
  // Any other non-2xx still means anonymous access did not succeed.
  return { code: `http_${status}`, refused: true };
}

// PKCE S256 challenge for the client authorization-code flow.
export function pkceChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

// ---------------------------------------------------------------------------
// Live HTTP driver. Only runs when an --origin is provided.
// ---------------------------------------------------------------------------

class SmokeError extends Error {}

async function readBody(resp) {
  const text = await resp.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { json, text };
}

// Establish an owner session via the shared owner-session helper
// (scripts/lib/owner-session.mjs — the one place that drives the
// CSRF-protected /owner/login form). When the deploy has no owner password
// (open local-dev), GET /owner/login still returns a usable form or a
// redirect and we proceed with no cookie; the device flow then mints a
// token directly.
async function establishOwnerSession(origin, ownerPassword, log) {
  if (!ownerPassword) {
    log("owner-login: no --owner-password given; assuming open local-dev owner auth");
    return "";
  }
  let sessionCookie;
  try {
    sessionCookie = await establishOwnerSessionCookie({ origin, ownerPassword });
  } catch (err) {
    throw new SmokeError(
      `owner-login: ${err instanceof Error ? err.message : String(err)}. ` +
        "Is owner auth enabled (PDPP_OWNER_PASSWORD set) and the origin correct?"
    );
  }
  log("owner-login: owner session established");
  return sessionCookie;
}

// Mint an owner access token via the device flow. /device/approve is owner-
// session gated when a password is set, so we carry the session cookie.
async function mintOwnerToken(origin, sessionCookie, subjectId, log) {
  const clientId = "pdpp-polyfill-owner-bootstrap";
  const deviceResp = await fetch(`${origin}/oauth/device_authorization`, {
    body: JSON.stringify({ client_id: clientId }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (deviceResp.status !== 200) {
    const { text } = await readBody(deviceResp);
    throw new SmokeError(`device_authorization failed ${deviceResp.status}: ${text}`);
  }
  const device = (await readBody(deviceResp)).json;

  const approveResp = await fetch(`${origin}/device/approve`, {
    body: JSON.stringify({ subject_id: subjectId, user_code: device.user_code }),
    headers: {
      "Content-Type": "application/json",
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
    },
    method: "POST",
  });
  if (approveResp.status !== 200) {
    const { text } = await readBody(approveResp);
    throw new SmokeError(
      `device/approve failed ${approveResp.status}: ${text}. ` +
        "If owner auth is enabled, pass --owner-password so the session can approve."
    );
  }

  const tokenResp = await fetch(`${origin}/oauth/token`, {
    body: JSON.stringify({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (tokenResp.status !== 200) {
    const { text } = await readBody(tokenResp);
    throw new SmokeError(`/oauth/token (device_code) failed ${tokenResp.status}: ${text}`);
  }
  log("owner-token: minted owner access token");
  return (await readBody(tokenResp)).json.access_token;
}

async function registerSeedManifest(origin, log) {
  // The manifest body is small; fetch it from the running AS would be circular,
  // so we register the same connector_id/streams the committed spotify fixture
  // declares. Re-register is idempotent (409 on unchanged version is fine).
  const manifest = {
    connector_id: SEED_CONNECTOR_ID,
    name: "Spotify (Railway seed fixture)",
    streams: [
      {
        consent_time_field: "source_updated_at",
        cursor_field: "source_updated_at",
        description: "Railway Core smoke fixture artists",
        name: SEED_STREAM,
        primary_key: ["id"],
        schema: {
          properties: {
            followers: { type: "integer" },
            genres: { items: { type: "string" }, type: "array" },
            id: { type: "string" },
            name: { type: "string" },
            popularity: { type: "integer" },
            source_updated_at: { format: "date-time", type: "string" },
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
  const resp = await fetch(`${origin}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (![200, 201, 409].includes(resp.status)) {
    const { text } = await readBody(resp);
    throw new SmokeError(`register manifest failed ${resp.status}: ${text}`);
  }
  log(`manifest: ${SEED_CONNECTOR_ID} registered (status ${resp.status})`);
  return manifest;
}

async function seedRecords(origin, ownerToken, log) {
  const url = `${origin}/v1/ingest/${encodeURIComponent(SEED_STREAM)}?connector_id=${encodeURIComponent(SEED_CONNECTOR_ID)}`;
  const resp = await fetch(url, {
    body: buildSeedNdjson(),
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      "Content-Type": "application/x-ndjson",
    },
    method: "POST",
  });
  const { text, json } = await readBody(resp);
  if (resp.status !== 200) {
    throw new SmokeError(`ingest failed ${resp.status}: ${text}`);
  }
  if (!json || json.records_accepted !== SEED_RECORDS.length) {
    throw new SmokeError(
      `ingest accepted ${json?.records_accepted} of ${SEED_RECORDS.length} records; rejected ${json?.records_rejected}. errors=${JSON.stringify(json?.errors)}`
    );
  }
  log(`seed: ingested ${json.records_accepted} record(s) into ${SEED_STREAM}`);
}

async function assertAnonymousMcpRefused(origin, log) {
  const resp = await fetch(`${origin}/mcp`, {
    body: JSON.stringify(mcpInitializeMessage()),
    headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    method: "POST",
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
async function mintClientToken(origin, sessionCookie, log) {
  const registerResp = await fetch(`${origin}/oauth/register`, {
    body: JSON.stringify({
      application_type: "web",
      client_name: "Railway MCP query smoke client",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: ["https://client.example/callback"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (registerResp.status !== 201) {
    const { text } = await readBody(registerResp);
    throw new SmokeError(`oauth/register failed ${registerResp.status}: ${text}`);
  }
  const client = (await readBody(registerResp)).json;

  const verifier = crypto.randomBytes(32).toString("base64url");
  const authorizationDetails = [
    {
      access_mode: "continuous",
      purpose_code: "https://pdpp.org/purpose/personal_ai_assistant",
      purpose_description: "Railway MCP query smoke",
      source: { id: SEED_CONNECTOR_ID, kind: "connector" },
      streams: [{ name: "*" }],
      type: "https://pdpp.org/data-access",
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
    headers: sessionCookie ? { Cookie: sessionCookie } : {},
    redirect: "manual",
  });
  if (authorizeResp.status !== 302) {
    const { text } = await readBody(authorizeResp);
    throw new SmokeError(`oauth/authorize expected 302, got ${authorizeResp.status}: ${text}`);
  }
  const consentUrl = new URL(authorizeResp.headers.get("location"), origin);
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

  const approveHeaders = { "Content-Type": "application/x-www-form-urlencoded" };
  const cookieParts = [sessionCookie, consentCsrfCookie].filter(Boolean);
  if (cookieParts.length > 0) {
    approveHeaders.Cookie = cookieParts.join("; ");
  }
  const approveBody = { request_uri: requestUri, subject_id: "owner_railway_smoke" };
  if (consentCsrfField) {
    approveBody._csrf = consentCsrfField;
  }

  const approveResp = await fetch(`${origin}/consent/approve`, {
    body: new URLSearchParams(approveBody).toString(),
    headers: approveHeaders,
    method: "POST",
    redirect: "manual",
  });
  if (approveResp.status !== 302) {
    const { text } = await readBody(approveResp);
    throw new SmokeError(`consent/approve expected 302, got ${approveResp.status}: ${text}`);
  }
  const callback = new URL(approveResp.headers.get("location"));
  const code = callback.searchParams.get("code");
  if (!code) {
    throw new SmokeError("consent/approve did not return an authorization code");
  }

  const tokenResp = await fetch(`${origin}/oauth/token`, {
    body: new URLSearchParams({
      client_id: client.client_id,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: "https://client.example/callback",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  if (tokenResp.status !== 200) {
    const { text } = await readBody(tokenResp);
    throw new SmokeError(`oauth/token (authorization_code) failed ${tokenResp.status}: ${text}`);
  }
  log("client-token: minted scoped client access token");
  return (await readBody(tokenResp)).json.access_token;
}

async function mcpPost(origin, token, message) {
  const resp = await fetch(`${origin}/mcp`, {
    body: JSON.stringify(message),
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  const text = await resp.text();
  const rpc = parseMcpResponseText(resp.headers.get("content-type"), text);
  return { rpc, status: resp.status, text };
}

async function runScopedMcpQuery(origin, clientToken, log) {
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
  log(`query_records: seeded record(s) returned (${verdict.foundKeys.join(", ")})`);
}

export async function runLiveSmoke(options) {
  const { origin, ownerPassword, subjectId, logger, seed = true } = options;
  const log = logger ?? (() => {});
  // An owner session is needed either way: the seed ingest is owner-gated, and
  // the client-token consent approval is owner-gated. In --no-seed mode we skip
  // the manifest/owner-token/ingest steps and only re-query — used by the
  // restart-survival smoke to prove records persisted WITHOUT re-writing them.
  const sessionCookie = await establishOwnerSession(origin, ownerPassword, log);
  if (seed) {
    const ownerToken = await mintOwnerToken(origin, sessionCookie, subjectId, log);
    await registerSeedManifest(origin, log);
    await seedRecords(origin, ownerToken, log);
  } else {
    log("seed: skipped (--no-seed); querying existing records only");
  }
  await assertAnonymousMcpRefused(origin, log);
  const clientToken = await mintClientToken(origin, sessionCookie, log);
  await runScopedMcpQuery(origin, clientToken, log);
}

// ---------------------------------------------------------------------------
// CLI entry.
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { json: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") {
      out.json = true;
    } else if (arg === "--no-seed") {
      out.noSeed = true;
    } else if (arg === "--origin") {
      out.origin = args[++i];
    } else if (arg === "--owner-password") {
      out.ownerPassword = args[++i];
    } else if (arg === "--subject") {
      out.subjectId = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    }
  }
  return out;
}

const USAGE = `Usage: node scripts/railway-mcp-query-smoke.mjs --origin <https-origin> [options]

Options:
  --origin <url>            Composed-origin base URL (required for the live run).
  --owner-password <secret> Owner password (or set PDPP_OWNER_PASSWORD). Needed
                            when the deploy has owner auth enabled (it should).
  --subject <id>            Owner subject id (default: PDPP_OWNER_SUBJECT_ID or owner_local).
  --no-seed                 Skip seeding; only re-query existing records. Used by
                            the restart-survival smoke to prove persistence
                            without re-writing the records.
  --json                    Emit a JSON result object.
  -h, --help                Show this help.

Seeds a deterministic record set (no connector run) and proves the hosted MCP
endpoint refuses anonymous access and returns those records for a scoped grant.`;

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  if (!opts.origin) {
    process.stderr.write(`--origin is required.\n\n${USAGE}\n`);
    process.exit(2);
  }
  const origin = opts.origin.replace(/\/$/, "");
  const ownerPassword = opts.ownerPassword ?? process.env.PDPP_OWNER_PASSWORD ?? "";
  const subjectId = opts.subjectId ?? process.env.PDPP_OWNER_SUBJECT_ID ?? "owner_local";

  const steps = [];
  const log = (message) => {
    steps.push(message);
    if (!opts.json) {
      process.stdout.write(`  ${message}\n`);
    }
  };

  if (!opts.json) {
    process.stdout.write(`Railway MCP query smoke against ${origin}\n`);
  }
  try {
    await runLiveSmoke({ logger: log, origin, ownerPassword, seed: !opts.noSeed, subjectId });
  } catch (error) {
    const message = error?.message ?? String(error);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ error: message, ok: false, origin, steps }, null, 2)}\n`);
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
