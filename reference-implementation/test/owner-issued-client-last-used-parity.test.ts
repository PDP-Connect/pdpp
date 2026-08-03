// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * EXECUTABLE cross-backend parity for `listOwnerIssuedClients`'s derived
 * `last_used_at` field.
 *
 * There is no `tokens.last_used_at` column in either backend — "last used"
 * is derived from `disclosure.served` spine events, grouped by `client_id`,
 * via `lastUsedAtByClientId()` (server/auth.ts). This file proves, against
 * REAL rows on both backends (not a mocked dependency), that:
 *
 *   - a client that served at least one `disclosure.served` event reports
 *     the correct MAX(occurred_at) as `last_used_at`, on both backends;
 *   - a client that served ZERO such events reports `last_used_at: null`
 *     (never "undefined", never a stale/wrong timestamp) — the load-bearing
 *     case, since a credential rendering blank/undefined here would hide
 *     the exact credentials most worth revoking;
 *   - the derivation is ONE grouped query per page, not one query per row:
 *     proven by wrapping the pool's real query method and asserting the
 *     call count stays at 1 regardless of how many clients are on the page.
 *
 * Gated on PDPP_TEST_POSTGRES_URL so it is a clean skip without a live PG.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { emitSpineEvent } from "../lib/spine.ts";
import { listOwnerIssuedClients, registerDynamicClient } from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  closePostgresStorage,
  getPostgresPool,
  initPostgresStorage,
  isPostgresStorageBackend,
  postgresQuery,
} from "../server/postgres-storage.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

if (POSTGRES_URL) {
  const RUN_TAG = `lastused${process.pid}${Date.now().toString(36)}`;
  const OWNER_SUBJECT = `owner_${RUN_TAG}`;

  async function registerOwnerClient(label: string, ownerSubject: string, tag: string): Promise<string> {
    const dcr = await registerDynamicClient(
      { client_name: `${label} ${tag}`, redirect_uris: ["https://lastused.example/cb"] },
      { issuer_subject_id: ownerSubject }
    );
    const clientId = dcr.client_id;
    assert.ok(typeof clientId === "string" && clientId, `${label} registered with a client_id`);
    return clientId as string;
  }

  /**
   * Two clients: one served a disclosure (must report last_used_at), one
   * never did (must report null, not undefined, not the raw-total leak of
   * some unrelated client's timestamp).
   */
  async function seedAndObserve(): Promise<{
    neverUsedEntry: Record<string, unknown> | undefined;
    usedEntry: Record<string, unknown> | undefined;
    usedLastEventAt: string;
  }> {
    const usedClientId = await registerOwnerClient("used-client", OWNER_SUBJECT, RUN_TAG);
    const neverUsedClientId = await registerOwnerClient("never-used-client", OWNER_SUBJECT, RUN_TAG);

    const firstEventAt = "2031-01-10T00:00:00.000Z";
    const usedLastEventAt = "2031-03-10T00:00:00.000Z";

    // Two disclosure.served events for the "used" client, out of chronological
    // insert order, so a naive "last inserted row" read (instead of a real
    // MAX(occurred_at)) would report the wrong timestamp.
    await emitSpineEvent({
      actor_id: usedClientId,
      actor_type: "client",
      client_id: usedClientId,
      event_type: "disclosure.served",
      grant_id: `grt_${RUN_TAG}_a`,
      object_id: "q1",
      object_type: "query",
      occurred_at: usedLastEventAt,
      source_id: "connectors/amazon",
      source_kind: "connector",
      status: "succeeded",
    });
    await emitSpineEvent({
      actor_id: usedClientId,
      actor_type: "client",
      client_id: usedClientId,
      event_type: "disclosure.served",
      grant_id: `grt_${RUN_TAG}_b`,
      object_id: "q1",
      object_type: "query",
      occurred_at: firstEventAt,
      source_id: "connectors/amazon",
      source_kind: "connector",
      status: "succeeded",
    });

    // A different, non-disclosure event type for the "never used" client. Its
    // presence proves the query filters on event_type = 'disclosure.served'
    // rather than reporting the last ANY-event timestamp for that client.
    await emitSpineEvent({
      actor_id: neverUsedClientId,
      actor_type: "client",
      client_id: neverUsedClientId,
      event_type: "query.received",
      grant_id: `grt_${RUN_TAG}_c`,
      object_id: "q2",
      object_type: "query",
      occurred_at: "2031-02-01T00:00:00.000Z",
      source_id: "connectors/gmail",
      source_kind: "connector",
      status: "succeeded",
    });

    const clients = await listOwnerIssuedClients(OWNER_SUBJECT);
    const usedEntry = clients.find((c) => c.client_id === usedClientId);
    const neverUsedEntry = clients.find((c) => c.client_id === neverUsedClientId);
    return { neverUsedEntry, usedEntry, usedLastEventAt };
  }

  test("listOwnerIssuedClients derives last_used_at from disclosure.served spine events (SQLite + Postgres parity)", async (t) => {
    // --- SQLite leg (in-memory; no file, no shared state) ---
    process.env.PDPP_STORAGE_BACKEND = "sqlite";
    delete process.env.PDPP_DATABASE_URL;
    initDb(":memory:");
    assert.ok(getDb(), "sqlite db failed to initialize");

    const sqliteResult = await seedAndObserve();
    assert.ok(sqliteResult.usedEntry, "sqlite: used client appears in owner listing");
    assert.equal(
      sqliteResult.usedEntry?.last_used_at,
      sqliteResult.usedLastEventAt,
      "sqlite: last_used_at is the MAX(occurred_at) across disclosure.served events, not the last-inserted row"
    );
    assert.ok(sqliteResult.neverUsedEntry, "sqlite: never-used client appears in owner listing");
    assert.equal(
      sqliteResult.neverUsedEntry?.last_used_at,
      null,
      "sqlite: a client with zero disclosure.served events reports last_used_at: null, not undefined or a stale timestamp"
    );
    closeDb();

    // --- Postgres leg ---
    process.env.PDPP_STORAGE_BACKEND = "postgres";
    process.env.PDPP_DATABASE_URL = POSTGRES_URL;
    if (!isPostgresStorageBackend()) {
      await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    }
    t.after(async () => {
      await postgresQuery("DELETE FROM spine_events WHERE grant_id LIKE $1", [`grt_${RUN_TAG}%`]).catch(() => {});
      await postgresQuery("DELETE FROM oauth_clients WHERE metadata_json->>'issuer_subject_id' = $1", [
        OWNER_SUBJECT,
      ]).catch(() => {});
      await closePostgresStorage();
    });

    const postgresResult = await seedAndObserve();
    assert.ok(postgresResult.usedEntry, "postgres: used client appears in owner listing");
    assert.equal(
      postgresResult.usedEntry?.last_used_at,
      postgresResult.usedLastEventAt,
      "postgres: last_used_at is the MAX(occurred_at) across disclosure.served events, not the last-inserted row"
    );
    assert.ok(postgresResult.neverUsedEntry, "postgres: never-used client appears in owner listing");
    assert.equal(
      postgresResult.neverUsedEntry?.last_used_at,
      null,
      "postgres: a client with zero disclosure.served events reports last_used_at: null, not undefined or a stale timestamp"
    );
  });

  test("lastUsedAtByClientId issues ONE grouped query per page, not one per client (Postgres)", async (t) => {
    process.env.PDPP_STORAGE_BACKEND = "postgres";
    process.env.PDPP_DATABASE_URL = POSTGRES_URL;
    if (!isPostgresStorageBackend()) {
      await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    }
    const countTag = `${RUN_TAG}_count`;
    const ownerSubject = `owner_${countTag}`;
    t.after(async () => {
      await postgresQuery("DELETE FROM spine_events WHERE grant_id LIKE $1", [`grt_${countTag}%`]).catch(() => {});
      await postgresQuery("DELETE FROM oauth_clients WHERE metadata_json->>'issuer_subject_id' = $1", [
        ownerSubject,
      ]).catch(() => {});
    });

    // Five clients on one page, each with its own disclosure event, so a
    // per-row query implementation (an N+1 regression) would issue 5 separate
    // grouped SELECTs against spine_events instead of one.
    const clientIds: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential to keep event/client identities deterministic.
      const clientId = await registerOwnerClient(`page client ${i}`, ownerSubject, countTag);
      clientIds.push(clientId);
      // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential to keep event/client identities deterministic.
      await emitSpineEvent({
        actor_id: clientId,
        actor_type: "client",
        client_id: clientId,
        event_type: "disclosure.served",
        grant_id: `grt_${countTag}_${i}`,
        object_id: "q1",
        object_type: "query",
        occurred_at: `2031-0${(i % 9) + 1}-01T00:00:00.000Z`,
        source_id: "connectors/amazon",
        source_kind: "connector",
        status: "succeeded",
      });
    }

    let spineEventsSelectCount = 0;
    const pool = getPostgresPool();
    const nativeQuery = pool.query.bind(pool);
    // Wrap the real pool's query method (a plain object property, not a
    // frozen ESM export) to count SELECTs against spine_events specifically,
    // without altering behavior: every call still delegates to the real,
    // unmodified driver method.
    pool.query = ((text: unknown, ...rest: unknown[]) => {
      if (typeof text === "string" && text.includes("FROM spine_events") && text.includes("disclosure.served")) {
        spineEventsSelectCount += 1;
      }
      return (nativeQuery as (...args: unknown[]) => unknown)(text, ...rest);
    }) as typeof pool.query;
    t.after(() => {
      pool.query = nativeQuery;
    });

    const clients = await listOwnerIssuedClients(ownerSubject);
    assert.equal(clients.length, 5, "all five registered clients are returned on one page");
    for (const clientId of clientIds) {
      const entry = clients.find((c) => c.client_id === clientId);
      assert.ok(entry, `client ${clientId} present in the page`);
      assert.ok(typeof entry?.last_used_at === "string", `client ${clientId} has a derived last_used_at`);
    }
    assert.equal(
      spineEventsSelectCount,
      1,
      `expected exactly ONE grouped disclosure.served SELECT for the whole 5-client page, got ${spineEventsSelectCount} (N+1 regression)`
    );
  });
} else {
  test("owner-issued-client last_used_at parity (skipped: PDPP_TEST_POSTGRES_URL unset)", { skip: true }, () => {});
}
