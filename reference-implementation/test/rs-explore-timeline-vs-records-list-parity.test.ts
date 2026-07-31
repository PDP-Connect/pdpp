// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-operation membership parity oracle: `rs.explore.timeline` vs
 * `rs.records.list`.
 *
 * `rs.explore.timeline` (`GET /_ref/explore/records`, owner-session gated,
 * cross-stream) and `rs.records.list` (`GET /v1/streams/:stream/records`,
 * grant/owner-token gated, single-stream) differ in scope and auth model by
 * design (see the RI-extension boundary documented in
 * `openspec/changes/document-explore-ri-extension-boundary`). A literal
 * byte-for-byte parity test is therefore not the right oracle. What both
 * operations MUST share is spec-core's per-record visibility rule: for a
 * fixed owner/backend fixture, the SET of records returned by exhaustively
 * paging the Explore timeline scoped to one `(connection, stream)` MUST equal
 * the set returned by exhaustively paging `rs.records.list` for that same
 * stream under an owner self-export token on the same connection.
 *
 * This is a MEMBERSHIP oracle only:
 *   - Ordering parity is explicitly NOT asserted (the two operations answer
 *     different chronology questions by design — semantic-time merge vs.
 *     single-stream cursor-field order).
 *   - Tombstone parity is explicitly NOT asserted (Explore's timeline is a
 *     forward point-in-time feed, not a `changes_since`-shaped incremental
 *     sync surface).
 *
 * Both routes are driven over real HTTP against a single running reference
 * server (mirrors `trusted-owner-agent-rest-boundary.test.ts`'s owner-bearer
 * harness and `owner-auth.test.ts`'s owner-session cookie login) so the
 * comparison exercises the real auth boundaries rather than bypassing them.
 * The owner-token fixture here establishes a legitimate comparison without
 * changing production auth: it registers a real connector manifest, ingests
 * records through the real owner-bearer ingest route, and reads through both
 * real routes under their real (different) auth gates.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { initiateOwnerDeviceAuthorization } from "../server/auth.ts";
import { startServer } from "../server/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");

const TEST_PASSWORD = "explore-vs-records-list-parity-owner-password";
const TEST_DCR_INITIAL_ACCESS_TOKEN = "pdpp-reference-test-initial-access-token";
const RECORD_COUNT = 9;
const PAGE_LIMIT = 3;

interface CloseableHttpServer {
  close: (callback: () => void) => unknown;
  closeAllConnections?: () => void;
}

interface TestServer {
  abortStartupBackfill?: (reason: string) => void;
  asPort: number;
  asServer: CloseableHttpServer;
  rsPort: number;
  rsServer: CloseableHttpServer;
  schedulerManager?: { stop?: () => void };
  startupBackfillDone?: Promise<unknown>;
}

async function closeServer(server: TestServer): Promise<void> {
  server.schedulerManager?.stop?.();
  server.abortStartupBackfill?.("explore-vs-records-list parity test shutdown");
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(() => resolve(undefined))),
    new Promise((resolve) => server.rsServer.close(() => resolve(undefined))),
    server.startupBackfillDone ?? Promise.resolve(),
  ]);
}

interface FetchJsonResult<T> {
  body: T;
  status: number;
}

async function fetchJson<T = Record<string, unknown>>(
  url: string,
  opts: RequestInit = {}
): Promise<FetchJsonResult<T>> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body: body as T, status: resp.status };
}

// ─── Owner session cookie (shared login the owner-bearer device flow and the
// owner-session /_ref/explore/records read both authenticate against) ───────

function getRawSetCookieList(resp: Response): string[] {
  if (typeof resp.headers.getSetCookie === "function") {
    return resp.headers.getSetCookie();
  }
  const single = resp.headers.get("set-cookie");
  return single ? [single] : [];
}

function findSetCookiePair(setCookies: readonly string[], name: string): string | null {
  for (const header of setCookies) {
    const [firstPair] = header.split(";");
    if (firstPair?.startsWith(`${name}=`)) {
      return firstPair;
    }
  }
  return null;
}

const CSRF_HIDDEN_FIELD_PATTERN = /<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/;

function extractCsrfFieldValue(html: string): string | null {
  const match = html.match(CSRF_HIDDEN_FIELD_PATTERN);
  return match?.[1] ?? null;
}

async function loginOwnerSession(asUrl: string, password: string): Promise<string> {
  const csrfResp = await fetch(`${asUrl}/owner/login`, {
    headers: { Accept: "text/html" },
    redirect: "manual",
  });
  const csrfCookie = findSetCookiePair(getRawSetCookieList(csrfResp), "pdpp_owner_csrf");
  const html = await csrfResp.text();
  const csrfField = extractCsrfFieldValue(html);

  const body = new URLSearchParams({ _csrf: csrfField || "", password, return_to: "/consent" });
  const loginResp = await fetch(`${asUrl}/owner/login`, {
    body: body.toString(),
    headers: {
      Accept: "text/html",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: csrfCookie || "",
    },
    method: "POST",
    redirect: "manual",
  });
  const sessionCookie = findSetCookiePair(getRawSetCookieList(loginResp), "pdpp_owner_session");
  assert.ok(sessionCookie, "owner login must issue a session cookie");
  return sessionCookie as string;
}

// ─── Owner bearer token (self-export path for rs.records.list) ──────────────
//
// With owner-auth enabled (a password configured), /device/approve requires
// an authenticated owner session plus a matching CSRF token — the same
// authenticated-approval flow proven end-to-end in owner-auth.test.ts. This
// mirrors that flow rather than the unauthenticated shortcut, so the fixture
// establishes the comparison through the real production auth gate instead
// of a path that only works when owner auth is disabled.

interface TokenBody {
  access_token: string;
}

async function issueOwnerToken(asUrl: string, sessionCookie: string): Promise<string> {
  const device = await initiateOwnerDeviceAuthorization("longview", { baseUrl: asUrl });
  const userCode = device.user_code as string;
  assert.ok(userCode, "device authorization returns a user code");

  const devicePageResp = await fetch(`${asUrl}/device?user_code=${encodeURIComponent(userCode)}`, {
    headers: { Accept: "text/html", Cookie: sessionCookie },
    redirect: "manual",
  });
  const csrfCookie = findSetCookiePair(getRawSetCookieList(devicePageResp), "pdpp_owner_csrf");
  const html = await devicePageResp.text();
  const csrfField = extractCsrfFieldValue(html);
  assert.ok(csrfField, "/device GET embeds a CSRF token");

  const approveResp = await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ _csrf: csrfField || "", user_code: userCode }).toString(),
    headers: {
      Accept: "text/html",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `${sessionCookie}; ${csrfCookie}`,
    },
    method: "POST",
    redirect: "manual",
  });
  assert.equal(approveResp.status, 200, "authenticated device approval must succeed");

  const { body: tokenBody, status: tokenStatus } = await fetchJson<TokenBody>(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: "longview",
      device_code: device.device_code as string,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(tokenStatus, 200);
  assert.ok(tokenBody.access_token, "device exchange should issue an owner token");
  return tokenBody.access_token;
}

// ─── Fixture: one connection, one stream, N records via the real ingest path ─

interface ConnectorManifest {
  connector_id: string;
  [extension: string]: unknown;
}

function loadGmailManifest(): ConnectorManifest {
  const path = join(REFERENCE_IMPL_DIR, "..", "packages", "polyfill-connectors", "manifests", "gmail.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

async function registerConnector(asUrl: string, manifest: ConnectorManifest): Promise<void> {
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(resp.status, 201);
}

function iso(day: number): string {
  return `2026-04-${String(day).padStart(2, "0")}T00:00:00.000Z`;
}

async function ingestFixtureRecords(
  rsUrl: string,
  authHeaders: Record<string, string>,
  connectorId: string
): Promise<void> {
  const ndjson = `${Array.from({ length: RECORD_COUNT }, (_, i) => {
    const key = `parity_msg_${i + 1}`;
    return JSON.stringify({
      data: {
        from_name: "Parity Fixture",
        id: key,
        received_at: iso(i + 1),
        subject: `parity message ${i + 1}`,
        thread_id: `thread_${key}`,
      },
      emitted_at: iso(i + 1),
      key,
    });
  }).join("\n")}\n`;

  const ingest = await fetchJson<{ errors?: string[]; records_accepted: number }>(
    `${rsUrl}/v1/ingest/messages?connector_id=${encodeURIComponent(connectorId)}`,
    {
      body: ndjson,
      headers: { ...authHeaders, "Content-Type": "application/x-ndjson" },
      method: "POST",
    }
  );
  assert.equal(ingest.status, 200, `fixture ingest must succeed: ${JSON.stringify(ingest.body)}`);
  assert.equal(
    ingest.body.records_accepted,
    RECORD_COUNT,
    `fixture ingest must accept every seeded record: ${JSON.stringify(ingest.body.errors)}`
  );
}

// ─── Exhaustive paging helpers ───────────────────────────────────────────────

interface RecordsListPageBody {
  data: { id: string; [extra: string]: unknown }[];
  has_more?: boolean;
  next_cursor?: string | null;
}

async function pageRecordsListToEnd(
  rsUrl: string,
  authHeaders: Record<string, string>,
  connectorId: string
): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | null = null;
  let pageCount = 0;
  for (;;) {
    const url = new URL(`${rsUrl}/v1/streams/messages/records`);
    url.searchParams.set("connector_id", connectorId);
    url.searchParams.set("limit", String(PAGE_LIMIT));
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }
    // biome-ignore lint/performance/noAwaitInLoops: Sequential exhaustive paging is the point of this helper.
    const page = await fetchJson<RecordsListPageBody>(url.toString(), { headers: authHeaders });
    assert.equal(page.status, 200, "rs.records.list page must succeed");
    for (const record of page.body.data) {
      ids.add(record.id);
    }
    pageCount += 1;
    if (!(page.body.has_more && page.body.next_cursor)) {
      break;
    }
    cursor = page.body.next_cursor;
    if (pageCount > 50) {
      throw new Error("pageRecordsListToEnd: too many pages — possible infinite loop");
    }
  }
  return ids;
}

interface ExploreTimelinePageBody {
  data: { record_key: string; [extra: string]: unknown }[];
  has_more?: boolean;
  next_cursor?: string | null;
}

async function pageExploreTimelineToEnd(
  asUrl: string,
  sessionCookie: string,
  connectionId: string
): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | null = null;
  let pageCount = 0;
  for (;;) {
    const url = new URL(`${asUrl}/_ref/explore/records`);
    url.searchParams.set("connection_id", connectionId);
    url.searchParams.set("stream", "messages");
    url.searchParams.set("limit", String(PAGE_LIMIT));
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }
    // biome-ignore lint/performance/noAwaitInLoops: Sequential exhaustive paging is the point of this helper.
    const page = await fetchJson<ExploreTimelinePageBody>(url.toString(), {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(page.status, 200, "rs.explore.timeline page must succeed");
    for (const record of page.body.data) {
      ids.add(record.record_key);
    }
    pageCount += 1;
    if (!(page.body.has_more && page.body.next_cursor)) {
      break;
    }
    cursor = page.body.next_cursor;
    if (pageCount > 50) {
      throw new Error("pageExploreTimelineToEnd: too many pages — possible infinite loop");
    }
  }
  return ids;
}

interface StreamSummaryBody {
  connection_id?: string;
  name: string;
  [extension: string]: unknown;
}
interface StreamListBody {
  data: StreamSummaryBody[];
}

async function resolveConnectionId(
  rsUrl: string,
  authHeaders: Record<string, string>,
  connectorId: string
): Promise<string> {
  const streams = await fetchJson<StreamListBody>(
    `${rsUrl}/v1/streams?connector_id=${encodeURIComponent(connectorId)}`,
    { headers: authHeaders }
  );
  assert.equal(streams.status, 200);
  const messagesStream = streams.body.data.find((s) => s.name === "messages");
  assert.ok(messagesStream?.connection_id, "messages stream must expose a connection_id");
  return messagesStream.connection_id as string;
}

test("rs.explore.timeline membership matches rs.records.list membership for the same connection+stream (SQLite)", async () => {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    ownerAuthPassword: TEST_PASSWORD,
    quiet: true,
    rsPort: 0,
  })) as unknown as TestServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const manifest = loadGmailManifest();
    await registerConnector(asUrl, manifest);

    const sessionCookie = await loginOwnerSession(asUrl, TEST_PASSWORD);
    const ownerToken = await issueOwnerToken(asUrl, sessionCookie);
    const authHeaders = { Authorization: `Bearer ${ownerToken}` };
    await ingestFixtureRecords(rsUrl, authHeaders, manifest.connector_id);

    const connectionId = await resolveConnectionId(rsUrl, authHeaders, manifest.connector_id);

    const recordsListIds = await pageRecordsListToEnd(rsUrl, authHeaders, manifest.connector_id);
    const exploreTimelineIds = await pageExploreTimelineToEnd(asUrl, sessionCookie, connectionId);

    assert.equal(recordsListIds.size, RECORD_COUNT, "rs.records.list must exhaustively reach every seeded record");
    assert.deepEqual(
      [...exploreTimelineIds].sort(),
      [...recordsListIds].sort(),
      "rs.explore.timeline's membership for this connection+stream must equal rs.records.list's membership " +
        "(set equality only — ordering and tombstone parity are explicit non-goals per " +
        "openspec/changes/document-explore-ri-extension-boundary)"
    );
  } finally {
    await closeServer(server);
  }
});
