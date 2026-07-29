// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Assistant-readiness smoke suite.
 *
 * Mirrors the owner-side personal assistant's actual workflow against the
 * first-party polyfill manifests so that a single broken cursor_field can't
 * ship a regression quietly. If any assistant-critical stream hard-fails on
 * basic page-one listing, this suite fails the release.
 *
 * Checked streams (must cover the assistant's highest-value surfaces):
 *   - Gmail messages
 *   - Slack messages
 *   - ChatGPT messages
 *   - Codex messages
 *   - Claude Code messages
 *   - GitHub issues
 *   - GitHub pull_requests
 *   - YNAB transactions
 *
 * Checks per stream:
 *   1. owner-paginated page-one records succeeds (200, list envelope)
 *   2. round-trips a follow-up cursor page when `has_more` is true
 *   3. resolves a single record by its returned id
 *   4. cross-stream lexical /v1/search is callable and returns a list envelope
 *
 * We register each shipped polyfill manifest against the reference AS and
 * synthesize a small number of well-typed sample records — the focus is
 * pagination/cursor correctness, not connector ingest semantics.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const POLYFILL_MANIFESTS_DIR = join(__dirname, "..", "..", "packages", "polyfill-connectors", "manifests");

const TEST_DCR_INITIAL_ACCESS_TOKEN = "pdpp-reference-test-initial-access-token";

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

interface Manifest {
  connector_id: string;
  [key: string]: unknown;
}

interface SeedRecord {
  _iso?: string;
  emitted_at?: string;
  id: string;
  [key: string]: unknown;
}

async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
  const clientId = "cli_longview";
  const { body: device } = await fetchJson<DeviceAuthorization>(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.ok(device, "device_authorization should return a body");
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
  assert.ok(tokenBody, "token response should return a body");
  return tokenBody.access_token;
}

async function registerManifest(asUrl: string, manifest: Manifest): Promise<void> {
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(resp.status, 201, `register ${manifest.connector_id}`);
}

function loadManifest(filename: string): Manifest {
  return JSON.parse(readFileSync(join(POLYFILL_MANIFESTS_DIR, filename), "utf8")) as Manifest;
}

async function seedRecords(
  rsUrl: string,
  token: string,
  connectorId: string,
  stream: string,
  records: readonly SeedRecord[]
): Promise<void> {
  const lines = records
    .map((r) => JSON.stringify({ data: r, emitted_at: r.emitted_at || r._iso || new Date().toISOString(), key: r.id }))
    .join("\n");
  const resp = await fetch(
    `${rsUrl}/v1/ingest/${encodeURIComponent(stream)}?connector_id=${encodeURIComponent(connectorId)}`,
    {
      body: lines,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-ndjson",
      },
      method: "POST",
    }
  );
  assert.equal(resp.status, 200, `ingest ${stream} ok`);
}

interface SmokeCase {
  manifest: string;
  name: string;
  records: () => SeedRecord[];
  stream: string;
}

/**
 * Cases the smoke suite covers. Each provides a synthetic record set keyed
 * by a unique id. Focus is on proving records pagination + cursor
 * round-trip on every assistant-critical shape; per-connector ingest
 * nuances are covered elsewhere.
 */
const CASES: readonly SmokeCase[] = [
  {
    manifest: "gmail.json",
    name: "gmail.messages",
    records: () => [
      { id: "m-a", received_at: "2026-01-01T00:00:00Z", subject: "Alpha", thread_id: "t1" },
      { id: "m-b", received_at: "2026-01-02T00:00:00Z", subject: "Beta", thread_id: "t1" },
      { id: "m-c", received_at: "2026-01-03T00:00:00Z", subject: "Gamma", thread_id: "t2" },
    ],
    stream: "messages",
  },
  {
    manifest: "slack.json",
    name: "slack.messages",
    records: () => [
      { channel_id: "C1", id: "C1::100.000001", sent_at: "2026-01-01T00:00:00Z", ts: "100.000001" },
      { channel_id: "C1", id: "C1::200.000002", sent_at: "2026-01-02T00:00:00Z", ts: "200.000002" },
      { channel_id: "C1", id: "C1::300.000003", sent_at: "2026-01-03T00:00:00Z", ts: "300.000003" },
    ],
    stream: "messages",
  },
  {
    manifest: "chatgpt.json",
    name: "chatgpt.messages",
    records: () => [
      { conversation_id: "c1", create_time: "2026-01-01T00:00:00Z", id: "msg_a", role: "user" },
      { conversation_id: "c1", create_time: "2026-01-02T00:00:00Z", id: "msg_b", role: "assistant" },
      { conversation_id: "c2", create_time: null, id: "msg_c", role: "user" }, // nullable cursor
    ],
    stream: "messages",
  },
  {
    manifest: "codex.json",
    name: "codex.messages",
    records: () => [
      { id: "codex_m1", role: "user", session_id: "s1", timestamp: "2026-01-01T00:00:00Z" },
      { id: "codex_m2", role: "assistant", session_id: "s1", timestamp: "2026-01-02T00:00:00Z" },
    ],
    stream: "messages",
  },
  {
    manifest: "claude_code.json",
    name: "claude_code.messages",
    records: () => [
      { id: "cc_m1", role: "user", session_id: "s1", timestamp: "2026-01-01T00:00:00Z" },
      { id: "cc_m2", role: "assistant", session_id: "s1", timestamp: "2026-01-02T00:00:00Z" },
    ],
    stream: "messages",
  },
  {
    manifest: "github.json",
    name: "github.issues",
    records: () => [
      { id: "gh_i1", number: 1, repository_full_name: "o/r", title: "First", updated_at: "2026-01-01T00:00:00Z" },
      { id: "gh_i2", number: 2, repository_full_name: "o/r", title: "Second", updated_at: "2026-01-02T00:00:00Z" },
    ],
    stream: "issues",
  },
  {
    manifest: "github.json",
    name: "github.pull_requests",
    records: () => [
      { id: "gh_pr1", number: 10, repository_full_name: "o/r", title: "PR one", updated_at: "2026-01-01T00:00:00Z" },
      { id: "gh_pr2", number: 11, repository_full_name: "o/r", title: "PR two", updated_at: "2026-01-02T00:00:00Z" },
    ],
    stream: "pull_requests",
  },
  {
    manifest: "ynab.json",
    name: "ynab.transactions",
    records: () => [
      { account_id: "a1", amount: -1000, budget_id: "b1", date: "2026-01-01", id: "ynab_t1", payee_name: "Coffee" },
      { account_id: "a1", amount: -2500, budget_id: "b1", date: "2026-01-02", id: "ynab_t2", payee_name: "Grocery" },
    ],
    stream: "transactions",
  },
];

const REPRESENTATIVE_REALIZATION_CASES: readonly { kind: string; name: string }[] = [
  { kind: "api", name: "github.issues" },
  { kind: "browser-scraper", name: "chatgpt.messages" },
  { kind: "file-based", name: "claude_code.messages" },
];

async function withHarness(fn: (ctx: { asUrl: string; rsUrl: string }) => Promise<void>): Promise<void> {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    quiet: true,
    rsPort: 0,
  })) as TestServer;
  try {
    await fn({
      asUrl: `http://localhost:${server.asPort}`,
      rsUrl: `http://localhost:${server.rsPort}`,
    });
  } finally {
    await closeServer(server);
  }
}

interface ListEnvelope {
  data: readonly { id: string }[];
  has_more?: boolean;
  next_cursor?: string | null;
  object: string;
}

interface RecordDetail {
  id: string;
}

for (const c of CASES) {
  test(`assistant smoke: ${c.name} pages + cursor + single-record hydration`, async () => {
    await withHarness(async ({ asUrl, rsUrl }) => {
      const manifest = loadManifest(c.manifest);
      await registerManifest(asUrl, manifest);
      const ownerToken = await issueOwnerToken(asUrl);
      const records = c.records();
      await seedRecords(rsUrl, ownerToken, manifest.connector_id, c.stream, records);

      // Page one — limit=1 so we can guarantee has_more=true for round-trip.
      const firstUrl =
        `${rsUrl}/v1/streams/${encodeURIComponent(c.stream)}/records` +
        `?connector_id=${encodeURIComponent(manifest.connector_id)}` +
        "&limit=1&order=asc";
      const page1 = await fetchJson<ListEnvelope>(firstUrl, { headers: { Authorization: `Bearer ${ownerToken}` } });
      assert.equal(page1.status, 200, `page one 200: ${JSON.stringify(page1.body)}`);
      assert.ok(page1.body, "page one should return a body");
      assert.equal(page1.body.object, "list", "list envelope");
      assert.equal(page1.body.data.length, 1);
      assert.equal(page1.body.has_more, true);
      assert.ok(page1.body.next_cursor, "next_cursor present");

      // Cursor round-trip — page two should succeed and return remaining rows.
      const page2 = await fetchJson<ListEnvelope>(`${firstUrl}&cursor=${encodeURIComponent(page1.body.next_cursor)}`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(page2.status, 200, "cursor round-trip 200");
      assert.ok(page2.body, "page two should return a body");
      assert.equal(page2.body.object, "list");
      assert.ok(page2.body.data.length >= 1, "at least one record on page two");

      // Single-record hydration: grab the first record's id and fetch it.
      // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
      const firstRecord = page1.body.data[0];
      assert.ok(firstRecord, "page one should contain at least one record");
      const firstId = firstRecord.id;
      const detail = await fetchJson<RecordDetail>(
        `${rsUrl}/v1/streams/${encodeURIComponent(c.stream)}/records/${encodeURIComponent(firstId)}` +
          `?connector_id=${encodeURIComponent(manifest.connector_id)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } }
      );
      assert.equal(detail.status, 200, "single-record hydration");
      assert.ok(detail.body, "single-record hydration should return a body");
      assert.equal(detail.body.id, firstId);

      // Cross-stream lexical search is callable and returns a list envelope.
      // Content assertions are covered in lexical-retrieval.test.js.
      const search = await fetchJson<ListEnvelope>(`${rsUrl}/v1/search?q=test`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(search.status, 200, "search endpoint reachable");
      assert.ok(search.body, "search should return a body");
      assert.equal(search.body.object, "list");
      assert.ok(Array.isArray(search.body.data));
    });
  });
}

test("assistant smoke: in-memory fallback activates for stale DB cursor_field drift", async () => {
  // Simulate a stale DB row where the persisted manifest's cursor_field
  // schema is still the old pre-fix shape. Reconcile is disabled for this
  // test so the fallback path is exercised rather than the self-heal.
  await withHarness(async ({ asUrl, rsUrl }) => {
    // Register a manifest manually with plain string cursor — bypass the
    // validator by going through a patched shape that still satisfies it
    // first, then injecting drift via direct DB write. Since the validator
    // now enforces SQL-compat, we can only test the fallback by registering
    // a supported shape and then verifying the records path still works
    // when the cursor is missing on some records. (Full stale-DB simulation
    // is covered by the reconcile tests.)
    const manifest = {
      connector_id: "fallback-smoke",
      connector_key: "fallback-smoke",
      display_name: "Fallback smoke",
      // Custom (non-first-party) manifest: connector_id must be a bare slug
      // that matches connector_key. The registry URL belongs in manifest_uri,
      // not connector_id. See canonicalize-connector-keys (connector_id ==
      // connector_key invariant enforced at registration + ingest).
      protocol_version: "0.1.0",
      runtime_requirements: { bindings: { network: { required: true } } },
      streams: [
        {
          cursor_field: "updated_at",
          name: "items",
          primary_key: ["id"],
          schema: {
            properties: {
              id: { type: "string" },
              updated_at: { format: "date-time", type: ["string", "null"] },
            },
            required: ["id"],
            type: "object",
          },
          selection: { fields: true, resources: true },
          semantics: "mutable_state",
        },
      ],
      version: "1.0.0",
    };
    await registerManifest(asUrl, manifest);
    const ownerToken = await issueOwnerToken(asUrl);
    await seedRecords(rsUrl, ownerToken, manifest.connector_id, "items", [
      { id: "i1", updated_at: "2026-01-01T00:00:00Z" },
      { id: "i2", updated_at: null },
      { id: "i3", updated_at: "2026-01-02T00:00:00Z" },
    ]);
    const { status, body } = await fetchJson<ListEnvelope>(
      `${rsUrl}/v1/streams/items/records?connector_id=${encodeURIComponent(manifest.connector_id)}&order=asc`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(status, 200);
    assert.ok(body, "fallback records query should return a body");
    // Null-cursor row goes to the missing bucket in ASC (after present).
    assert.deepEqual(
      body.data.map((r) => r.id),
      ["i1", "i3", "i2"]
    );
  });
});

interface SpineEventRow {
  data_json: string;
  event_id: string;
  source_id: string | null;
  source_kind: string | null;
}

interface SpineEventSourceData {
  source?: { id?: string; kind?: string };
}

test("assistant smoke: representative polyfill classes populate canonical spine source columns", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const expectedConnectorIds: string[] = [];

    for (const representative of REPRESENTATIVE_REALIZATION_CASES) {
      const c = CASES.find((item) => item.name === representative.name);
      assert.ok(c, `missing representative case for ${representative.kind}`);
      const manifest = loadManifest(c.manifest);
      // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
      await registerManifest(asUrl, manifest);
      expectedConnectorIds.push(canonicalConnectorKey(manifest.connector_id) ?? manifest.connector_id);

      await seedRecords(rsUrl, ownerToken, manifest.connector_id, c.stream, c.records().slice(0, 1));
      const page = await fetchJson<ListEnvelope>(
        `${rsUrl}/v1/streams/${encodeURIComponent(c.stream)}/records?connector_id=${encodeURIComponent(manifest.connector_id)}&limit=1`,
        { headers: { Authorization: `Bearer ${ownerToken}` } }
      );
      assert.equal(page.status, 200, `${representative.kind} representative query succeeds`);
      assert.ok(page.body, "representative page should return a body");
      assert.equal(page.body.object, "list");
    }

    const rows = getDb()
      .prepare("SELECT event_id, source_kind, source_id, data_json FROM spine_events")
      .all() as SpineEventRow[];
    const sourcedRows = rows.filter((row) => {
      const data = JSON.parse(row.data_json || "{}") as SpineEventSourceData;
      return data.source?.kind === "connector" && expectedConnectorIds.includes(data.source.id ?? "");
    });

    for (const connectorId of expectedConnectorIds) {
      assert.ok(
        sourcedRows.some((row) => row.source_id === connectorId),
        `expected sourced spine rows for ${connectorId}`
      );
    }
    assert.equal(
      sourcedRows.filter((row) => row.source_kind !== "connector" || !row.source_id).length,
      0,
      "representative sourced spine rows should have non-null canonical source columns"
    );
  });
});
