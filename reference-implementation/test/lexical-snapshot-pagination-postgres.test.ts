// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Lexical snapshot pagination: Postgres production-path coverage.
 *
 * Closes a verified seam gap: a prior migration moved lexical snapshot
 * persistence behind getSearchIndexStore() with a SQLite adapter and a
 * Postgres adapter (postgresSearchIndexStore.persistSnapshot /
 * loadSnapshotRow, table lexical_search_snapshots in server/search.js). The
 * meta/index seams of that store are exercised by the existing PG lexical
 * test, but the two SNAPSHOT seams were not: breaking the snapshot SELECT
 * left every existing PG test green.
 *
 * Snapshots are exercised by lexical-search pagination on the real HTTP path.
 * Per operations/rs-search-lexical/index.ts: a fresh /v1/search request always
 * builds and persists a snapshot (page 1); a &cursor= request always loads
 * that persisted snapshot by id (page 2). So a paginated lexical search in
 * Postgres mode drives persistSnapshot (page 1) + loadSnapshot (page 2)
 * through the migrated PG adapter.
 *
 * This mirrors the SQLite pagination round-trip at
 * test/lexical-retrieval.test.js (the "pagination round-trip works" test) and
 * the Postgres harness setup of the PG lexical-recall test in that same file.
 *
 * Gated on PDPP_TEST_POSTGRES_URL so it is a clean skip without a live PG.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { closeDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { closePostgresStorage } from "../server/postgres-storage.ts";

const TEST_DCR_INITIAL_ACCESS_TOKEN = "pdpp-reference-test-initial-access-token";
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

type StartedServer = Awaited<ReturnType<typeof startServer>>;

interface DeviceAuthorizationBody {
  device_code: string;
  user_code: string;
}

interface DeviceTokenBody {
  access_token: string;
}

interface LexicalRecord {
  emitted_at?: string;
  id: string;
  source_created_at: string;
  title: string;
}

interface SearchHit {
  record_key?: string;
}

interface SearchListResponse {
  data: SearchHit[];
  has_more?: boolean;
  meta?: {
    recall?: unknown;
  };
  next_cursor?: string;
  object?: string;
}

async function waitForIndexedPage(
  url: string,
  ownerToken: string,
  timeoutMs = 10_000
): Promise<{ body: SearchListResponse; status: number }> {
  const deadline = Date.now() + timeoutMs;
  let latest: { body: SearchListResponse; status: number } | null = null;
  while (Date.now() < deadline) {
    const response = await fetchJson(url, { headers: { Authorization: `Bearer ${ownerToken}` } });
    latest = { body: response.body as SearchListResponse, status: response.status };
    if (latest.status === 200 && latest.body.data.length === 3 && latest.body.has_more === true) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`lexical index did not converge before pagination assertion: ${JSON.stringify(latest)}`);
}

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
  const deviceBody = device as DeviceAuthorizationBody;
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: deviceBody.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: deviceBody.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return (tokenBody as DeviceTokenBody).access_token;
}

async function ingest(
  rsUrl: string,
  ownerToken: string,
  connectorId: string,
  stream: string,
  records: LexicalRecord[]
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

if (POSTGRES_URL) {
  test("postgres lexical snapshot pagination persists on page 1 and loads on page 2", async () => {
    // Unique connector_id + search term per run so the test is isolated even on
    // a re-used database, matching the existing PG lexical test convention.
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `pg_snap_pagination_${suffix}`;
    const term = `pgsnapterm${suffix}`;
    const manifest = {
      capabilities: { human_interaction: ["credentials"] },
      connector_id: connectorId,
      display_name: "Postgres Snapshot Pagination",
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
    const previousDatabaseUrl = process.env.PDPP_DATABASE_URL;
    assert.ok(POSTGRES_URL, "Postgres URL is configured when this test runs");
    process.env.PDPP_DATABASE_URL = POSTGRES_URL;
    try {
      server = await startServer({
        asPort: 0,
        dbPath: ":memory:",
        dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
        quiet: true,
        reconcilePolyfillManifests: false,
        rsPort: 0,
      });
      const asUrl = `http://localhost:${server.asPort}`;
      const rsUrl = `http://localhost:${server.rsPort}`;

      const reg = await fetch(`${asUrl}/connectors`, {
        body: JSON.stringify(manifest),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(reg.status, 201, `register ${connectorId}`);

      const ownerToken = await issueOwnerToken(asUrl, `owner_pg_snap_${suffix}`);

      // Seven matching records with limit=3 forces pagination: page 1 returns 3
      // hits with a non-empty next_cursor (snapshot persisted), and page 2 loads
      // the persisted snapshot to return the next slice.
      const records = Array.from({ length: 7 }, (_, i) => ({
        id: `pgp${i}`,
        source_created_at: `2026-04-${String(10 + i).padStart(2, "0")}T00:00:00Z`,
        title: `${term} page ${i}`,
      }));
      await ingest(rsUrl, ownerToken, connectorId, "posts", records);

      // ── Page 1: fresh request → buildSnapshot + persistSnapshot (PG adapter).
      // Ingest acknowledges durable records before derived indexes finish.
      // Poll fresh searches until the public result shape proves enough of the
      // index has converged to exercise pagination; the snapshot under test is
      // the final response returned here, not an earlier partial snapshot.
      const page1 = await waitForIndexedPage(`${rsUrl}/v1/search?q=${encodeURIComponent(term)}&limit=3`, ownerToken);
      assert.equal(page1.status, 200);
      const page1Body = page1.body as SearchListResponse;
      assert.equal(page1Body.object, "list");
      assert.equal(page1Body.data.length, 3, "page 1 returns the limit");
      assert.equal(page1Body.has_more, true, "more pages remain after page 1");
      assert.ok(
        typeof page1Body.next_cursor === "string" && page1Body.next_cursor.length > 0,
        "page 1 emits a next_cursor (snapshot was persisted)"
      );
      const page1Keys = page1Body.data.map((r) => r.record_key);
      assert.equal(new Set(page1Keys).size, 3, "page 1 keys are distinct");
      assert.ok(page1Body.next_cursor, "page 1 next_cursor must be present to request page 2");

      // ── Page 2: cursor request → loadSnapshot (PG adapter). If the snapshot
      //    did NOT load, the operation throws invalid_cursor (status 400) and
      //    these assertions fail. So a successful, key-advancing page 2 proves
      //    the persisted snapshot loaded correctly.
      const page2 = await fetchJson(
        `${rsUrl}/v1/search?q=${encodeURIComponent(term)}&limit=3&cursor=${encodeURIComponent(page1Body.next_cursor)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } }
      );
      assert.equal(page2.status, 200, "page 2 succeeds (snapshot loaded, not invalid_cursor)");
      const page2Body = page2.body as SearchListResponse;
      assert.equal(page2Body.object, "list");
      assert.equal(page2Body.data.length, 3, "page 2 returns the next slice");

      // The cursor advanced: page 2 keys must not duplicate page 1 keys.
      const firstKeys = new Set(page1Keys);
      for (const r of page2Body.data) {
        assert.ok(!firstKeys.has(r.record_key), `cursor should advance: ${r.record_key} duplicated from page 1`);
      }

      // Recall facts are a property of the whole ranked snapshot, so a correctly
      // loaded page-2 snapshot reproduces page 1's recall facts verbatim. This
      // depends on loadSnapshot returning the persisted row, not a rebuild.
      assert.deepEqual(
        page2Body.meta?.recall,
        page1Body.meta?.recall,
        "page 2 reuses the persisted snapshot recall facts"
      );
    } finally {
      if (server) {
        await closeServer(server);
      }
      await closePostgresStorage();
      closeDb();
      if (previousDatabaseUrl === undefined) {
        delete process.env.PDPP_DATABASE_URL;
      } else {
        process.env.PDPP_DATABASE_URL = previousDatabaseUrl;
      }
    }
  });
} else {
  test("postgres lexical snapshot pagination round-trip (skipped: PDPP_TEST_POSTGRES_URL unset)", {
    skip: true,
    // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
  }, () => {});
}
