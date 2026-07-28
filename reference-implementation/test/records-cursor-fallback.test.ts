// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for the runtime in-memory pagination fallback.
 *
 * The validator rejects unsupported `cursor_field` schemas at registration
 * time, but existing databases can still hold manifests that predate the
 * guardrail. In that case the reference falls back to a JS-comparator
 * sort/seek path rather than hard-failing the read.
 *
 * These tests simulate a stale DB row by writing a manifest directly into
 * the `connectors` table and then exercising `/v1/streams/:s/records`.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";

const TEST_DCR_INITIAL_ACCESS_TOKEN = "pdpp-reference-test-initial-access-token";

// startServer is imported from checkJs:false JS; TS's structural inference
// for app.listen()'s return widens asServer/rsServer to a type missing
// closeAllConnections (a real Node http.Server method the source's own
// shutdown path uses elsewhere -- opts here never requests TLS, so at
// runtime this is always a plain http.Server). Overriding just those two
// members on the real inferred return type (rather than a wholly separate
// interface) keeps enough structural overlap for a single-hop cast.
interface CloseableServer {
  close: (callback?: (err?: Error) => void) => unknown;
  closeAllConnections: () => void;
}

type StartedServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: CloseableServer;
  rsServer: CloseableServer;
};

interface Harness {
  asUrl: string;
  rsUrl: string;
}

interface RecordListResponse {
  data: Array<{ id: string }>;
  has_more: boolean;
  next_cursor?: string | null;
  object: string;
}

interface StaleManifest {
  connector_id: string;
}

interface SeedRecord {
  id: string;
  [field: string]: unknown;
}

async function closeServer(server: StartedServer): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((r) => server.asServer.close(r)),
    new Promise((r) => server.rsServer.close(r)),
  ]);
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

async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
  const clientId = "cli_longview";
  const { body: deviceBody } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const device = deviceBody as { device_code: string; user_code: string };
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
  return (tokenBody as { access_token: string }).access_token;
}

async function withHarness(fn: (harness: Harness) => Promise<void>): Promise<void> {
  // opts here never requests TLS, so app.listen() always returns a plain
  // http.Server at runtime; checkJs:false's structural inference instead
  // widens to a union that includes the http2-secure listener variant
  // (which genuinely lacks closeAllConnections), so a same-hop cast to the
  // real observed shape is needed here rather than a suppression.
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    quiet: true,
    rsPort: 0,
  })) as StartedServer;
  try {
    await fn({
      asUrl: `http://localhost:${server.asPort}`,
      rsUrl: `http://localhost:${server.rsPort}`,
    });
  } finally {
    await closeServer(server);
  }
}

/**
 * Bypass `registerConnector` (which would run the validator) and write a
 * stale manifest directly into the connectors table.
 */
function insertStaleManifest(manifest: StaleManifest): void {
  getDb()
    .prepare(`
      INSERT INTO connectors(connector_id, manifest) VALUES(?, ?)
      ON CONFLICT(connector_id) DO UPDATE SET manifest = excluded.manifest
    `)
    .run(manifest.connector_id, JSON.stringify(manifest));
}

async function seedStream(
  rsUrl: string,
  token: string,
  connectorId: string,
  stream: string,
  records: SeedRecord[]
): Promise<void> {
  const lines = records
    .map((r) => {
      const [firstKey] = Object.keys(r);
      // biome-ignore lint/style/noNestedTernary: localized test assertion preserves its explicit contract.
      const isoFallback = typeof r._iso === "string" ? r._iso : firstKey ? r[firstKey] : undefined;
      return JSON.stringify({ data: r, emitted_at: isoFallback || new Date().toISOString(), key: r.id });
    })
    .join("\n");
  const resp = await fetch(
    `${rsUrl}/v1/ingest/${encodeURIComponent(stream)}?connector_id=${encodeURIComponent(connectorId)}`,
    {
      body: lines,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-ndjson" },
      method: "POST",
    }
  );
  if (resp.status !== 200) {
    const body = await resp.text();
    throw new Error(`ingest ${stream} failed: ${resp.status} ${body}`);
  }
}

// Mimics a pre-fix shipped manifest — cursor_field is a plain string with
// no format. Accepted by the old validator, rejected by the current one.
const STALE_MANIFEST = {
  connector_id: "https://registry.pdpp.test/connectors/stale-plain-string",
  display_name: "Stale plain-string cursor",
  protocol_version: "0.1.0",
  runtime_requirements: { bindings: { network: { required: true } } },
  streams: [
    {
      cursor_field: "title", // plain nullable string — no date format
      name: "notes",
      primary_key: ["id"],
      schema: {
        properties: {
          id: { type: "string" },
          title: { type: ["string", "null"] },
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

test("records pagination falls back to JS comparator for stale unsupported cursor_field", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    insertStaleManifest(STALE_MANIFEST);
    const token = await issueOwnerToken(asUrl);

    await seedStream(rsUrl, token, STALE_MANIFEST.connector_id, "notes", [
      { id: "n1", title: "cherry" },
      { id: "n2", title: "apple" },
      { id: "n3", title: "banana" },
      { id: "n4", title: null },
    ]);

    const { status, body: rawBody } = await fetchJson(
      `${rsUrl}/v1/streams/notes/records?connector_id=${encodeURIComponent(STALE_MANIFEST.connector_id)}&order=asc&limit=2`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const body = rawBody as RecordListResponse;

    assert.equal(status, 200, `fallback path should serve 200, got ${status}`);
    assert.equal(body.object, "list");
    // localeCompare order: apple < banana < cherry; null goes to missing bucket last.
    assert.deepEqual(
      body.data.map((r) => r.id),
      ["n2", "n3"]
    );
    assert.equal(body.has_more, true);

    const page2Raw = await fetchJson(
      `${rsUrl}/v1/streams/notes/records?connector_id=${encodeURIComponent(STALE_MANIFEST.connector_id)}&order=asc&limit=2&cursor=${encodeURIComponent(body.next_cursor ?? "")}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const page2Body = page2Raw.body as RecordListResponse;
    assert.equal(page2Raw.status, 200);
    assert.deepEqual(
      page2Body.data.map((r) => r.id),
      ["n1", "n4"]
    );
    assert.equal(page2Body.has_more, false);
  });
});
