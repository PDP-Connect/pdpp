// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  type BearerActor,
  type ClientEventSubscriptionDependencies,
  ClientEventSubscriptionError,
  type ClientEventSubscriptionStore,
  executeApplyGrantRevoke,
  executeCreateSubscription,
  executeDeleteSubscription,
  executeEnqueueTestEvent,
  executeGetSubscription,
  executeListSubscriptions,
  executeRecordDeliveryFailure,
  executeUpdateSubscription,
  executeVerificationOutcome,
  hashSecret,
  type QueuedEventForEnqueue,
  type SubscriptionRow,
} from "../operations/as-client-event-subscriptions/index.ts";

const REGEXP_1 = /^[a-z0-9]+$/;
const REGEXP_2 = /not in grant/;

function makeInMemoryStore(): ClientEventSubscriptionStore & {
  __dump: () => { subs: SubscriptionRow[]; queue: QueuedEventForEnqueue[] };
} {
  const subs = new Map<string, SubscriptionRow>();
  const queue: QueuedEventForEnqueue[] = [];
  return {
    __dump: () => ({ queue: [...queue], subs: [...subs.values()] }),
    deleteSubscription(id) {
      subs.delete(id);
    },
    dropQueuedForSubscription(id) {
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        if (queue[i]?.subscriptionId === id) {
          queue.splice(i, 1);
        }
      }
    },
    enqueueEvent(event) {
      queue.push(event);
    },
    getSubscriptionById(id) {
      const row = subs.get(id);
      return row ? { ...row } : null;
    },
    insertSubscription(row) {
      subs.set(row.subscription_id, { ...row });
    },
    listSubscriptionsByClient(clientId) {
      return [...subs.values()].filter((s) => s.client_id === clientId);
    },
    listSubscriptionsByGrant(grantId) {
      return [...subs.values()].filter((s) => s.grant_id === grantId);
    },
    updateSecret(id, secretHash, secretText, updatedAt) {
      const row = subs.get(id);
      if (!row) {
        return;
      }
      subs.set(id, { ...row, secret_hash: secretHash, secret_text: secretText, updated_at: updatedAt });
    },
    updateStatus(id, status, updatedAt, disabledAt, disabledReason) {
      const row = subs.get(id);
      if (!row) {
        return;
      }
      subs.set(id, { ...row, disabled_at: disabledAt, disabled_reason: disabledReason, status, updated_at: updatedAt });
    },
  };
}

function actor(overrides: Partial<BearerActor> = {}): BearerActor {
  return {
    authorityKind: "client_grant",
    clientId: "client_alpha",
    grantId: "grant_1",
    grantScope: {
      source: { id: "gmail", kind: "connector" },
      streams: [{ name: "messages" }, { name: "contacts" }],
    },
    subjectId: "owner_local",
    ...overrides,
  };
}

function deps(store: ClientEventSubscriptionStore): ClientEventSubscriptionDependencies {
  return { nowIso: () => "2026-05-27T00:00:00.000Z", store };
}

test("create rejects non-https callback (except localhost)", async () => {
  const store = makeInMemoryStore();
  await assert.rejects(
    executeCreateSubscription({ actor: actor(), callbackUrl: "http://example.com/hook" }, deps(store)),
    ClientEventSubscriptionError
  );
  await assert.rejects(
    executeCreateSubscription({ actor: actor(), callbackUrl: `https://example.com/${"a".repeat(2048)}` }, deps(store)),
    ClientEventSubscriptionError
  );
  // Localhost permitted for dev.
  const out = await executeCreateSubscription(
    { actor: actor(), callbackUrl: "http://localhost:9999/hook" },
    deps(store)
  );
  assert.equal(out.status, "pending_verification");
});

test("create persists subscription and enqueues verify event exactly once", async () => {
  const store = makeInMemoryStore();
  const out = await executeCreateSubscription({ actor: actor(), callbackUrl: "https://example.com/hook" }, deps(store));
  assert.ok(out.secret.startsWith("whsec_"));
  assert.ok(out.subscriptionId.startsWith("sub_"));
  const dump = store.__dump();
  assert.equal(dump.subs.length, 1);
  // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
  const sub = dump.subs[0];
  // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
  const queuedEvent = dump.queue[0];
  assert.ok(sub, "expected the created subscription row");
  assert.ok(queuedEvent, "expected the verify event to be queued");
  assert.equal(sub.status, "pending_verification");
  assert.equal(dump.queue.length, 1);
  assert.equal(queuedEvent.eventType, "pdpp.subscription.verify");
  const payload = JSON.parse(queuedEvent.payloadJson);
  assert.equal(payload.type, "pdpp.subscription.verify");
  assert.equal(payload.specversion, "1.0", "CloudEvents 1.0 specversion");
  assert.equal(payload.pdppversion, "1", "PDPP profile version travels as extension attribute");
  assert.ok(typeof payload.data.challenge === "string" && payload.data.challenge.length > 0);
  // Canonical source path: /v1/event-subscriptions/<id>
  assert.equal(payload.source, `/v1/event-subscriptions/${out.subscriptionId}`);
  // CloudEvents §required-attributes: occurrence time travels as standard `time`.
  assert.equal(typeof payload.time, "string");
  assert.ok(!Number.isNaN(Date.parse(payload.time)), "`time` is an RFC 3339 timestamp");
  assert.equal(payload.occurred_at, undefined, "legacy occurred_at must not appear at top level");
  // CloudEvents §context-attribute-naming: attribute names are lowercase alphanumeric.
  // PDPP fields that would contain an underscore live inside `data`.
  assert.equal(payload.subscription_id, undefined, "subscription_id must not appear at top level");
  assert.equal(payload.data.subscription_id, out.subscriptionId, "subscription_id travels as data.subscription_id");
  for (const key of Object.keys(payload)) {
    assert.ok(
      REGEXP_1.test(key),
      `top-level CloudEvents attribute ${JSON.stringify(key)} must be lowercase alphanumeric (no underscores)`
    );
  }
});

test("create narrows scope when filters subset of grant", async () => {
  const store = makeInMemoryStore();
  await executeCreateSubscription(
    {
      actor: actor(),
      callbackUrl: "https://example.com/hook",
      filters: { streams: ["messages"] },
    },
    deps(store)
  );
  const dump = store.__dump();
  // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
  const sub = dump.subs[0];
  assert.ok(sub, "expected the created subscription row");
  const scope = JSON.parse(sub.scope_json);
  assert.deepEqual(scope.filters.streams, ["messages"]);
});

test("create refuses filters outside grant", async () => {
  const store = makeInMemoryStore();
  await assert.rejects(
    executeCreateSubscription(
      {
        actor: actor(),
        callbackUrl: "https://example.com/hook",
        filters: { streams: ["labels"] },
      },
      deps(store)
    ),
    REGEXP_2
  );
});

test("get refuses cross-client and cross-grant access", async () => {
  const store = makeInMemoryStore();
  const created = await executeCreateSubscription(
    { actor: actor(), callbackUrl: "https://example.com/hook" },
    deps(store)
  );
  // Different client_id
  await assert.rejects(executeGetSubscription(actor({ clientId: "other" }), created.subscriptionId, deps(store)));
  // Different grant_id
  await assert.rejects(executeGetSubscription(actor({ grantId: "other_grant" }), created.subscriptionId, deps(store)));
  // Same actor succeeds
  const fetched = await executeGetSubscription(actor(), created.subscriptionId, deps(store));
  assert.equal(fetched.subscription_id, created.subscriptionId);
});

test("list returns only matching client+grant", async () => {
  const store = makeInMemoryStore();
  await executeCreateSubscription({ actor: actor(), callbackUrl: "https://a.example/h" }, deps(store));
  await executeCreateSubscription(
    { actor: actor({ clientId: "other" }), callbackUrl: "https://b.example/h" },
    deps(store)
  );
  const out = await executeListSubscriptions(actor(), deps(store));
  assert.equal(out.data.length, 1);
});

test("verification handshake transitions pending_verification → active", async () => {
  const store = makeInMemoryStore();
  const created = await executeCreateSubscription(
    { actor: actor(), callbackUrl: "https://example.com/hook" },
    deps(store)
  );
  await executeVerificationOutcome(created.subscriptionId, "verified", deps(store));
  const row = await store.getSubscriptionById(created.subscriptionId);
  assert.ok(row, "expected the subscription row to exist");
  assert.equal(row.status, "active");
});

test("update toggles enabled/disabled and rotates secret", async () => {
  const store = makeInMemoryStore();
  const created = await executeCreateSubscription(
    { actor: actor(), callbackUrl: "https://example.com/hook" },
    deps(store)
  );
  await executeVerificationOutcome(created.subscriptionId, "verified", deps(store));

  // disable
  let out = await executeUpdateSubscription(actor(), created.subscriptionId, { enabled: false }, deps(store));
  assert.equal(out.subscription.status, "disabled");

  // re-enable
  out = await executeUpdateSubscription(actor(), created.subscriptionId, { enabled: true }, deps(store));
  assert.equal(out.subscription.status, "active");

  // rotate
  out = await executeUpdateSubscription(actor(), created.subscriptionId, { rotateSecret: true }, deps(store));
  assert.ok(out.secret);
  const row = await store.getSubscriptionById(created.subscriptionId);
  assert.ok(row, "expected the subscription row to exist");
  assert.equal(row.secret_hash, hashSecret(out.secret));
});

test("test-event enqueues a subscription.test envelope", async () => {
  const store = makeInMemoryStore();
  const created = await executeCreateSubscription(
    { actor: actor(), callbackUrl: "https://example.com/hook" },
    deps(store)
  );
  await executeVerificationOutcome(created.subscriptionId, "verified", deps(store));
  const out = await executeEnqueueTestEvent(actor(), created.subscriptionId, deps(store));
  const queued = store.__dump().queue.find((q) => q.eventId === out.eventId);
  assert.ok(queued, "expected the test event to be queued");
  const payload = JSON.parse(queued.payloadJson);
  assert.equal(payload.type, "pdpp.subscription.test");
  assert.equal(payload.source, `/v1/event-subscriptions/${created.subscriptionId}`);
});

test("delete is grant-scoped and drops queued events", async () => {
  const store = makeInMemoryStore();
  const created = await executeCreateSubscription(
    { actor: actor(), callbackUrl: "https://example.com/hook" },
    deps(store)
  );
  // queue is non-empty from the verify enqueue
  assert.equal(store.__dump().queue.length, 1);
  await executeDeleteSubscription(actor(), created.subscriptionId, deps(store));
  assert.equal(
    store
      .__dump()
      .queue.filter((q) => q.subscriptionId === created.subscriptionId && q.eventType !== "pdpp.subscription.test")
      .length,
    0
  );
});

test("grant revoke emits at most one grant.revoked, drops queued, marks disabled_revoked", async () => {
  const store = makeInMemoryStore();
  const created = await executeCreateSubscription(
    { actor: actor(), callbackUrl: "https://example.com/hook" },
    deps(store)
  );
  await executeVerificationOutcome(created.subscriptionId, "verified", deps(store));

  const out = await executeApplyGrantRevoke("grant_1", deps(store));
  assert.equal(out.affected, 1);
  assert.equal(out.notified, 1);
  const row = await store.getSubscriptionById(created.subscriptionId);
  assert.ok(row, "expected the subscription row to exist");
  assert.equal(row.status, "disabled_revoked");

  const remaining = store.__dump().queue.filter((q) => q.subscriptionId === created.subscriptionId);
  assert.equal(remaining.length, 1); // just the new grant.revoked envelope
  // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
  const remainingEvent = remaining[0];
  assert.ok(remainingEvent, "expected the grant.revoked event");
  const payload = JSON.parse(remainingEvent.payloadJson);
  assert.equal(payload.type, "pdpp.grant.revoked");
  assert.equal(payload.source, `/v1/event-subscriptions/${created.subscriptionId}`);
});

test("record delivery failure marks subscription disabled_failure once", async () => {
  const store = makeInMemoryStore();
  const created = await executeCreateSubscription(
    { actor: actor(), callbackUrl: "https://example.com/hook" },
    deps(store)
  );
  await executeVerificationOutcome(created.subscriptionId, "verified", deps(store));
  await executeRecordDeliveryFailure(created.subscriptionId, deps(store));
  const row = await store.getSubscriptionById(created.subscriptionId);
  assert.ok(row, "expected the subscription row to exist");
  assert.equal(row.status, "disabled_failure");
});
