// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression: the owner-facing `/_ref/{traces,grants,runs}` list endpoints
 * must canonicalize the `connector_id` query filter before pushing it down
 * as the spine `source_id` equality filter.
 *
 * Spine events bind their source under the canonical connector key (e.g.
 * `spotify`), never the URL-shaped registry id. An owner who filters with a
 * URL-shaped value
 * (`?connector_id=https://registry.pdpp.dev/connectors/spotify`) must see the
 * same canonically-keyed correlations as `?connector_id=spotify`, mirroring
 * the already-fixed `/_ref/connections` boundary
 * (`server/routes/ref-connectors.ts`). Without canonicalization in
 * `parseListFilters` the URL-shaped filter becomes `source_id = <URL>`, which
 * never equals the stored `spotify` and returns zero rows.
 *
 * These run at the HTTP level against a real server (open mode, in-memory db)
 * and seed spine correlations directly via `emitSpineEvent` so the source is
 * stamped deterministically under the canonical key.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { emitSpineEvent } from "../lib/spine.ts";
import { startServer } from "../server/index.ts";

type TestServer = Awaited<ReturnType<typeof startServer>>;
type JsonObject = Record<string, unknown>;

const CANONICAL_KEY = "spotify";
const URL_ID = "https://registry.pdpp.dev/connectors/spotify";

async function closeServer(server: TestServer): Promise<void> {
  server.schedulerManager?.stop?.();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

async function fetchJson(url: string): Promise<{ status: number; body: JsonObject }> {
  const resp = await fetch(url);
  const text = await resp.text();
  let body: JsonObject = {};
  try {
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as JsonObject;
    }
  } catch {
    body = { raw: text };
  }
  return { body, status: resp.status };
}

async function withServer(fn: (input: { asUrl: string }) => Promise<void>): Promise<void> {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await fn({ asUrl });
  } finally {
    await closeServer(server);
  }
}

// Seed one correlation per kind, all sourced from the canonical `spotify`
// key. Uses benign terminal event types (not `run.started`, which requires
// boot-epoch stamping) so the seed stays narrow and deterministic.
async function seedSpotifyCorrelations() {
  await emitSpineEvent({
    actor_id: CANONICAL_KEY,
    actor_type: "runtime",
    event_type: "run.succeeded",
    run_id: "run_spotify_seed",
    source_id: CANONICAL_KEY,
    source_kind: "connector",
  });
  await emitSpineEvent({
    actor_id: "pdpp_reference",
    actor_type: "system",
    event_type: "grant.issued",
    grant_id: "grant_spotify_seed",
    source_id: CANONICAL_KEY,
    source_kind: "connector",
  });
  await emitSpineEvent({
    actor_id: "pdpp_reference",
    actor_type: "system",
    event_type: "trace.recorded",
    request_id: "req_spotify_seed",
    source_id: CANONICAL_KEY,
    source_kind: "connector",
    trace_id: "trc_spotify_seed",
  });
}

const KINDS = [
  { idField: "run_id", path: "_ref/runs", seedId: "run_spotify_seed" },
  { idField: "grant_id", path: "_ref/grants", seedId: "grant_spotify_seed" },
  { idField: "trace_id", path: "_ref/traces", seedId: "trc_spotify_seed" },
] as const;

for (const { path, idField, seedId } of KINDS) {
  test(`GET /${path} canonical connector_id filter matches the seeded correlation`, async () => {
    await withServer(async ({ asUrl }) => {
      await seedSpotifyCorrelations();
      const { status, body } = await fetchJson(`${asUrl}/${path}?connector_id=${encodeURIComponent(CANONICAL_KEY)}`);
      assert.equal(status, 200);
      assert.equal(body.object, "list");
      assert.ok(Array.isArray(body.data));
      const row = body.data.find((r): boolean => !!r && typeof r === "object" && (r as JsonObject)[idField] === seedId);
      assert.ok(row, `canonical filter must surface the seeded ${idField}=${seedId}`);
    });
  });

  test(`GET /${path} URL-shaped connector_id filter matches the canonically-keyed correlation`, async () => {
    await withServer(async ({ asUrl }) => {
      await seedSpotifyCorrelations();
      const canonical = await fetchJson(`${asUrl}/${path}?connector_id=${encodeURIComponent(CANONICAL_KEY)}`);
      const urlShaped = await fetchJson(`${asUrl}/${path}?connector_id=${encodeURIComponent(URL_ID)}`);
      assert.equal(urlShaped.status, 200);

      // The URL-shaped filter must canonicalize to `spotify` and return the
      // same correlation as the canonical filter — not an empty page.
      assert.ok(Array.isArray(urlShaped.body.data) && Array.isArray(canonical.body.data));
      const urlRow = urlShaped.body.data.find(
        (r): boolean => !!r && typeof r === "object" && (r as JsonObject)[idField] === seedId
      );
      assert.ok(urlRow, `URL-shaped connector_id filter must surface the canonically-keyed ${idField}=${seedId}`);
      assert.equal(
        urlShaped.body.data.length,
        canonical.body.data.length,
        "URL-shaped filter must return the same row count as the canonical filter"
      );
    });
  });
}
