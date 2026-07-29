// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Postgres parity proof for `ClientEventSubscriptionStore`.
 *
 * The SQLite store is exercised everywhere else (unit + e2e). This test
 * exercises the Postgres backend end-to-end through the same operation
 * layer the production routes call: create, verification handshake,
 * test event, listing, secret rotation, grant revoke, queue claim, and
 * attempt logging.
 *
 * It is skipped unless `PDPP_TEST_POSTGRES_URL` is set so the regular
 * test runner stays portable. CI / `docker-compose` paths set the env
 * var; the closeout for `add-client-event-subscriptions` runs against
 * a live Postgres to prove the second-backend implementation works.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type BearerActor,
  executeApplyGrantRevoke,
  executeCreateSubscription,
  executeEnqueueTestEvent,
  executeListSubscriptions,
  executeUpdateSubscription,
  executeVerificationOutcome,
} from "../operations/as-client-event-subscriptions/index.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import {
  __resetClientEventSubscriptionStoreForTests,
  claimDueQueue,
  createPostgresClientEventSubscriptionStore,
  getDefaultClientEventSubscriptionStore,
  insertAttempt,
  listActiveSubscriptions,
  listAttemptsForQueue,
  updateQueueAttempt,
} from "../server/stores/client-event-subscription-store.ts";

type ClientEventSubscriptionStore = ReturnType<typeof getDefaultClientEventSubscriptionStore>;

const SHOULD_SKIP = !process.env.PDPP_TEST_POSTGRES_URL;

function postgresStorageConfig(): { backend: "postgres"; databaseUrl: string } {
  const databaseUrl = process.env.PDPP_TEST_POSTGRES_URL;
  assert.ok(databaseUrl, "Postgres test requires PDPP_TEST_POSTGRES_URL");
  return { backend: "postgres", databaseUrl };
}

async function clearTables() {
  await postgresQuery("DELETE FROM client_event_attempts");
  await postgresQuery("DELETE FROM client_event_queue");
  await postgresQuery("DELETE FROM client_event_subscriptions");
}

function makeActor(overrides: Partial<BearerActor> = {}): BearerActor {
  return {
    authorityKind: "client_grant",
    clientId: "pg_client",
    grantId: "pg_grant",
    grantScope: {
      source: { id: "spotify", kind: "connector" },
      streams: [{ name: "top_artists" }, { name: "recently_played" }],
    },
    subjectId: "pg_owner",
    ...overrides,
  };
}

function deps(store: ClientEventSubscriptionStore) {
  return { nowIso: () => new Date().toISOString(), store };
}

test("Postgres ClientEventSubscriptionStore round-trips a full lifecycle", {
  skip: SHOULD_SKIP,
}, async () => {
  await initPostgresStorage(postgresStorageConfig());
  __resetClientEventSubscriptionStoreForTests();

  try {
    await clearTables();

    // The default resolver must hand out the Postgres store when the
    // backend has been switched.
    const store = getDefaultClientEventSubscriptionStore();
    assert.ok(store);

    // Create a subscription via the operation layer (this writes the
    // subscription row AND enqueues the `subscription.verify` event in
    // a single sequence).
    const actor = makeActor();
    const created = await executeCreateSubscription({ actor, callbackUrl: "https://example.com/hook" }, deps(store));
    assert.ok(created.subscriptionId.startsWith("sub_"));
    assert.equal(created.status, "pending_verification");

    // Verification handshake transitions to active.
    await executeVerificationOutcome(created.subscriptionId, "verified", deps(store));

    // Read-back path exercised by the route handler.
    const list = await executeListSubscriptions(actor, deps(store));
    assert.equal(list.data.length, 1);
    const [firstListed] = list.data;
    assert.ok(firstListed);
    assert.equal(firstListed.status, "active");
    assert.equal(firstListed.subscription_id, created.subscriptionId);

    // Rotate the secret.
    const rotated = await executeUpdateSubscription(actor, created.subscriptionId, { rotateSecret: true }, deps(store));
    assert.ok(rotated.secret && rotated.secret !== created.secret);

    // Enqueue a test event and confirm the worker-facing claim path
    // surfaces it joined to the subscription's secret + status.
    await executeEnqueueTestEvent(actor, created.subscriptionId, deps(store));
    const due = await claimDueQueue(new Date(Date.now() + 60_000).toISOString());
    assert.ok(due.length >= 1, "expected at least the verify + test events to be due");
    const testRow = due.find((r) => r.event_type === "pdpp.subscription.test");
    assert.ok(testRow, "pdpp.subscription.test must be claimable");
    assert.equal(testRow.callback_url, "https://example.com/hook");
    assert.equal(testRow.subscription_status, "active");
    assert.equal(typeof testRow.secret_text, "string");
    assert.ok(testRow.secret_text.length > 0);

    // Attempt log path (worker behavior).
    const now = new Date().toISOString();
    await insertAttempt(testRow.queue_id, now, 200, true, 12, null, "ok");
    await updateQueueAttempt(testRow.queue_id, 1, now, "delivered", null);
    const attempts = await listAttemptsForQueue(testRow.queue_id);
    assert.equal(attempts.length, 1);
    const [firstAttempt] = attempts;
    assert.ok(firstAttempt);
    assert.equal(firstAttempt.status_code, 200);
    assert.equal(firstAttempt.ok, 1);

    // listActiveSubscriptions returns the row (used by the post-commit
    // enqueue hook to decide which subscriptions might match).
    const active = await listActiveSubscriptions();
    assert.equal(active.length, 1);
    const [firstActive] = active;
    assert.ok(firstActive);
    assert.equal(firstActive.subscription_id, created.subscriptionId);

    // Grant revoke side-effect: subscription marked disabled_revoked
    // and a `pdpp.grant.revoked` event enqueued.
    assert.ok(actor.grantId);
    const revoke = await executeApplyGrantRevoke(actor.grantId, deps(store));
    assert.equal(revoke.affected, 1);
    assert.equal(revoke.notified, 1);

    const dueAfter = await claimDueQueue(new Date(Date.now() + 60_000).toISOString());
    const revokedEvent = dueAfter.find((r) => r.event_type === "pdpp.grant.revoked");
    assert.ok(revokedEvent, "grant.revoked envelope must be queued");
    assert.equal(revokedEvent.subscription_status, "disabled_revoked");
  } finally {
    await clearTables();
    __resetClientEventSubscriptionStoreForTests();
    await closePostgresStorage();
  }
});

test("Postgres store factory is consistent with the resolver", {
  skip: SHOULD_SKIP,
}, async () => {
  await initPostgresStorage(postgresStorageConfig());
  __resetClientEventSubscriptionStoreForTests();
  try {
    const direct = createPostgresClientEventSubscriptionStore();
    const resolved = getDefaultClientEventSubscriptionStore();
    // Same method surface; both Promise-returning.
    assert.equal(typeof direct.insertSubscription, "function");
    assert.equal(typeof resolved.insertSubscription, "function");
    // The Postgres store's insertSubscription is genuinely async (unlike the
    // SQLite store's synchronous variant sharing this interface); await it
    // for real rather than only checking it returns something thenable, so
    // the row is actually written before the cleanup DELETE below runs.
    await direct.insertSubscription({
      authority_kind: "client_grant",
      callback_url: "https://example.com/hook",
      client_id: "c1",
      created_at: new Date().toISOString(),
      disabled_at: null,
      disabled_reason: null,
      grant_id: "g1",
      scope_json: JSON.stringify({ source: { id: "spotify", kind: "connector" }, streams: [] }),
      secret_hash: "h",
      secret_text: "t",
      status: "pending_verification",
      subject_id: "s1",
      subscription_id: "sub_pg_smoke",
      updated_at: new Date().toISOString(),
      verification_challenge: "chal",
    });
    await postgresQuery("DELETE FROM client_event_subscriptions WHERE subscription_id = $1", ["sub_pg_smoke"]);
  } finally {
    __resetClientEventSubscriptionStoreForTests();
    await closePostgresStorage();
  }
});
