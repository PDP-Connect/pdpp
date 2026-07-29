// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator-side oversight operations for client event subscriptions.
 *
 * Covers `ref.client-event-subscriptions.list`, `.get`, and `.disable`.
 * These tests use a plain in-memory store rather than the real SQLite /
 * Postgres backed store — the operation contract is what's normative; the
 * store-backed integration is exercised by the existing
 * `as-client-event-subscriptions-operation.test.js` and the e2e suite.
 *
 * Spec: openspec/changes/add-client-event-subscription-management/
 *       specs/reference-implementation-architecture/spec.md
 */

import assert from "node:assert/strict";
import test from "node:test";
import type {
  ClientEventSubscriptionStore,
  QueuedEventForEnqueue,
  SubscriptionRow,
  SubscriptionStatus,
} from "../operations/as-client-event-subscriptions/index.ts";
import {
  executeRefClientEventSubscriptionsDisable,
  RefClientEventSubscriptionsDisableInvalidRequestError,
  RefClientEventSubscriptionsDisableNotFoundError,
} from "../operations/ref-client-event-subscriptions-disable/index.ts";
import {
  executeRefClientEventSubscriptionsGet,
  REF_CLIENT_EVENT_SUBSCRIPTIONS_ATTEMPT_CAP,
  RefClientEventSubscriptionsNotFoundError,
} from "../operations/ref-client-event-subscriptions-get/index.ts";
import { executeRefClientEventSubscriptionsList } from "../operations/ref-client-event-subscriptions-list/index.ts";
import type {
  ListAllSubscriptionsFilters,
  SubscriptionAttemptRow,
  SubscriptionSummaryRow,
} from "../server/stores/client-event-subscription-store.ts";

/**
 * Test-only fake store. Implements `ClientEventSubscriptionStore` (the
 * client-facing contract) plus the operator-side read helpers
 * (`listAllSubscriptions`, `getSubscriptionSummary`,
 * `listAttemptsForSubscription`) that the `ref.client-event-subscriptions.*`
 * operations depend on. `_addAttempt` is a test-only seam for building
 * attempt history, not part of either real contract.
 */
interface FakeStore extends ClientEventSubscriptionStore {
  _addAttempt: (subscriptionId: string, attempt: Partial<SubscriptionAttemptRow>) => void;
  getSubscriptionSummary: (subscriptionId: string) => SubscriptionSummaryRow | null;
  listAllSubscriptions: (filters?: ListAllSubscriptionsFilters) => SubscriptionRow[];
  listAttemptsForSubscription: (subscriptionId: string, limit: number) => SubscriptionAttemptRow[];
}

interface QueuedEvent extends QueuedEventForEnqueue {
  readonly subscriptionId: string;
}

interface FakeAttemptRow extends SubscriptionAttemptRow {
  readonly _subscription_id: string;
}

function makeStore(): FakeStore {
  const subs = new Map<string, SubscriptionRow>();
  const queue: QueuedEvent[] = [];
  const attempts: FakeAttemptRow[] = [];
  let attemptSeq = 0;
  return {
    // test helpers:
    _addAttempt(subscriptionId: string, attempt: Partial<SubscriptionAttemptRow>) {
      attemptSeq += 1;
      attempts.push({
        _subscription_id: subscriptionId,
        attempt_id: attemptSeq,
        attempted_at: "",
        error: null,
        event_id: `evt_${attemptSeq}`,
        event_type: "pdpp.records.changed",
        latency_ms: null,
        ok: 0,
        queue_id: 1,
        response_snippet: null,
        status_code: null,
        ...attempt,
      });
    },
    deleteSubscription(id: string) {
      subs.delete(id);
    },
    dropQueuedForSubscription(id: string) {
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        const queued = queue[i];
        if (queued && queued.subscriptionId === id) {
          queue.splice(i, 1);
        }
      }
    },
    enqueueEvent(event: QueuedEventForEnqueue) {
      queue.push({ ...event });
    },
    getSubscriptionById(id: string) {
      const row = subs.get(id);
      return row ? { ...row } : null;
    },
    getSubscriptionSummary(id: string) {
      const row = subs.get(id);
      if (!row || row.status === "deleted") {
        return null;
      }
      const pending = queue.filter((q) => q.subscriptionId === id).length;
      const subscriptionAttempts = attempts.filter((a) => a._subscription_id === id);
      const last = subscriptionAttempts.at(-1) ?? null;
      return {
        authority_kind: row.authority_kind,
        callback_url: row.callback_url,
        client_id: row.client_id,
        created_at: row.created_at,
        disabled_at: row.disabled_at,
        disabled_reason: row.disabled_reason,
        final_failure_count: 0,
        grant_id: row.grant_id,
        // biome-ignore lint/style/noNestedTernary: localized test assertion preserves its explicit contract.
        last_attempt_ok: last ? (last.ok ? 1 : 0) : null,
        last_attempt_status_code: last?.status_code ?? null,
        last_attempted_at: last?.attempted_at ?? null,
        pending_queue_count: pending,
        scope_json: row.scope_json,
        status: row.status,
        subject_id: row.subject_id,
        subscription_id: row.subscription_id,
        updated_at: row.updated_at,
      };
    },
    insertSubscription(row: SubscriptionRow) {
      subs.set(row.subscription_id, { ...row });
    },
    // helpers for the operator-side helpers:
    listAllSubscriptions({ clientId, grantId, status }: ListAllSubscriptionsFilters = {}) {
      return [...subs.values()].filter((s) => {
        if (s.status === "deleted") {
          return false;
        }
        if (clientId && s.client_id !== clientId) {
          return false;
        }
        if (grantId && s.grant_id !== grantId) {
          return false;
        }
        if (status && s.status !== status) {
          return false;
        }
        return true;
      });
    },
    listAttemptsForSubscription(id: string, limit: number) {
      return attempts
        .filter((a) => a._subscription_id === id)
        .slice(-limit)
        .reverse()
        .map(({ _subscription_id, ...rest }) => rest);
    },
    listSubscriptionsByClient(clientId: string) {
      return [...subs.values()].filter((s) => s.client_id === clientId);
    },
    listSubscriptionsByGrant(grantId: string) {
      return [...subs.values()].filter((s) => s.grant_id === grantId);
    },
    updateSecret() {
      /* unused */
    },
    updateStatus(
      id: string,
      status: SubscriptionStatus,
      updatedAt: string,
      disabledAt: string | null,
      disabledReason: string | null
    ) {
      const row = subs.get(id);
      if (!row) {
        return;
      }
      subs.set(id, {
        ...row,
        disabled_at: disabledAt,
        disabled_reason: disabledReason,
        status,
        updated_at: updatedAt,
      });
    },
  };
}

function seedSubscription(store: FakeStore, overrides: Partial<SubscriptionRow> = {}): string {
  const id = overrides.subscription_id ?? `sub_${Math.random().toString(36).slice(2, 10)}`;
  store.insertSubscription({
    authority_kind: "client_grant",
    callback_url: "https://client.example/hook",
    client_id: "client_alpha",
    created_at: "2026-05-27T00:00:00.000Z",
    disabled_at: null,
    disabled_reason: null,
    grant_id: "grant_1",
    scope_json: JSON.stringify({ streams: [{ name: "messages" }] }),
    secret_hash: "h",
    secret_text: "pess_secret",
    status: "active",
    subject_id: "owner_local",
    subscription_id: id,
    updated_at: "2026-05-27T00:00:00.000Z",
    verification_challenge: null,
    ...overrides,
  });
  return id;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

test("list returns operator projection without secret material", async () => {
  const store = makeStore();
  const id = seedSubscription(store);
  const env = await executeRefClientEventSubscriptionsList({}, store);
  assert.equal(env.object, "list");
  assert.equal(env.data.length, 1);
  const [row] = env.data;
  assert.ok(row);
  assert.equal(row.subscription_id, id);
  assert.equal(row.callback_host, "client.example");
  // Defensive: projection must not include secret fields.
  for (const banned of ["secret", "secret_hash", "secret_text"]) {
    assert.equal(banned in row, false, `${banned} leaked into operator projection`);
  }
});

test("list filters by client, grant, and status combined", async () => {
  const store = makeStore();
  seedSubscription(store, { client_id: "client_alpha", grant_id: "g_a", status: "active", subscription_id: "sub_a" });
  seedSubscription(store, {
    client_id: "client_beta",
    disabled_reason: "client_disabled",
    grant_id: "g_b",
    status: "disabled",
    subscription_id: "sub_b",
  });
  seedSubscription(store, {
    client_id: "client_alpha",
    disabled_reason: "operator_disabled",
    grant_id: "g_a",
    status: "disabled",
    subscription_id: "sub_c",
  });

  const onlyAlpha = await executeRefClientEventSubscriptionsList({ clientId: "client_alpha" }, store);
  // biome-ignore lint/suspicious/useArraySortCompare: localized test assertion preserves its explicit contract.
  assert.deepEqual(onlyAlpha.data.map((r) => r.subscription_id).sort(), ["sub_a", "sub_c"]);

  const onlyDisabled = await executeRefClientEventSubscriptionsList({ status: "disabled" }, store);
  // biome-ignore lint/suspicious/useArraySortCompare: localized test assertion preserves its explicit contract.
  assert.deepEqual(onlyDisabled.data.map((r) => r.subscription_id).sort(), ["sub_b", "sub_c"]);

  const combined = await executeRefClientEventSubscriptionsList(
    { clientId: "client_alpha", grantId: "g_a", status: "disabled" },
    store
  );
  assert.deepEqual(
    combined.data.map((r) => r.subscription_id),
    ["sub_c"]
  );
});

test("list ignores deleted subscriptions", async () => {
  const store = makeStore();
  seedSubscription(store, { status: "active", subscription_id: "sub_live" });
  seedSubscription(store, { status: "deleted", subscription_id: "sub_dead" });
  const env = await executeRefClientEventSubscriptionsList({}, store);
  assert.deepEqual(
    env.data.map((r) => r.subscription_id),
    ["sub_live"]
  );
});

test("list with unknown status returns empty list (not 4xx)", async () => {
  const store = makeStore();
  seedSubscription(store);
  const env = await executeRefClientEventSubscriptionsList({ status: "gibberish" }, store);
  assert.equal(env.data.length, 0);
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

test("get returns detail with bounded attempt list and no secrets", async () => {
  const store = makeStore();
  const id = seedSubscription(store);
  for (let i = 0; i < 30; i += 1) {
    store._addAttempt(id, {
      attempted_at: `2026-05-27T00:00:${String(i).padStart(2, "0")}.000Z`,
      error: null,
      latency_ms: 12,
      ok: 1,
      response_snippet: null,
      status_code: 200,
    });
  }
  const detail = await executeRefClientEventSubscriptionsGet(id, store);
  assert.equal(detail.subscription_id, id);
  assert.equal(detail.callback_url, "https://client.example/hook");
  assert.equal(detail.callback_host, "client.example");
  assert.equal(detail.recent_attempts.length, REF_CLIENT_EVENT_SUBSCRIPTIONS_ATTEMPT_CAP);
  for (const banned of ["secret", "secret_hash", "secret_text"]) {
    assert.equal(banned in detail, false);
  }
  assert.equal(detail.last_attempt_ok, true);
});

test("get on unknown subscription throws not_found", async () => {
  const store = makeStore();
  await assert.rejects(
    () => executeRefClientEventSubscriptionsGet("sub_missing", store),
    RefClientEventSubscriptionsNotFoundError
  );
});

test("get on deleted subscription throws not_found", async () => {
  const store = makeStore();
  seedSubscription(store, { status: "deleted", subscription_id: "sub_x" });
  await assert.rejects(
    () => executeRefClientEventSubscriptionsGet("sub_x", store),
    RefClientEventSubscriptionsNotFoundError
  );
});

// ---------------------------------------------------------------------------
// disable
// ---------------------------------------------------------------------------

function disableDeps(store: FakeStore, now = "2026-05-27T01:00:00.000Z") {
  return { nowIso: () => now, store };
}

test("disable transitions active to disabled with default reason and drops queue", async () => {
  const store = makeStore();
  const id = seedSubscription(store);
  store.enqueueEvent({
    enqueuedAt: "",
    eventId: "evt_x",
    eventType: "pdpp.records.changed",
    nextAttemptAt: "",
    payloadJson: "{}",
    subscriptionId: id,
  });
  const out = await executeRefClientEventSubscriptionsDisable({ subscriptionId: id }, disableDeps(store));
  assert.equal(out.status, "disabled");
  assert.equal(out.disabledReason, "operator_disabled");
  assert.equal(out.wasAlreadyDisabled, false);
  const summary = store.getSubscriptionSummary(id);
  assert.ok(summary);
  assert.equal(summary.pending_queue_count, 0);
});

test("disable uses operator-supplied reason when provided", async () => {
  const store = makeStore();
  const id = seedSubscription(store);
  const out = await executeRefClientEventSubscriptionsDisable(
    { reason: "loop_suspected", subscriptionId: id },
    disableDeps(store)
  );
  assert.equal(out.disabledReason, "loop_suspected");
});

test("disable is idempotent on already-disabled subscriptions", async () => {
  const store = makeStore();
  const id = seedSubscription(store, {
    disabled_at: "2026-05-26T00:00:00.000Z",
    disabled_reason: "client_disabled",
    status: "disabled",
  });
  const out = await executeRefClientEventSubscriptionsDisable(
    { reason: "should_be_ignored", subscriptionId: id },
    disableDeps(store)
  );
  assert.equal(out.wasAlreadyDisabled, true);
  assert.equal(out.disabledReason, "client_disabled", "reason must not be overwritten on already-disabled rows");
});

test("disable is idempotent on disabled_failure and disabled_revoked", async () => {
  const store = makeStore();
  const fid = seedSubscription(store, {
    disabled_reason: "delivery_failed",
    status: "disabled_failure",
    subscription_id: "sub_f",
  });
  const rid = seedSubscription(store, {
    disabled_reason: "grant_revoked",
    status: "disabled_revoked",
    subscription_id: "sub_r",
  });
  const out1 = await executeRefClientEventSubscriptionsDisable({ subscriptionId: fid }, disableDeps(store));
  const out2 = await executeRefClientEventSubscriptionsDisable({ subscriptionId: rid }, disableDeps(store));
  assert.equal(out1.wasAlreadyDisabled, true);
  assert.equal(out1.status, "disabled_failure");
  assert.equal(out2.wasAlreadyDisabled, true);
  assert.equal(out2.status, "disabled_revoked");
});

test("disable rejects deleted and missing subscriptions", async () => {
  const store = makeStore();
  seedSubscription(store, { status: "deleted", subscription_id: "sub_dead" });
  await assert.rejects(
    () => executeRefClientEventSubscriptionsDisable({ subscriptionId: "sub_dead" }, disableDeps(store)),
    RefClientEventSubscriptionsDisableNotFoundError
  );
  await assert.rejects(
    () => executeRefClientEventSubscriptionsDisable({ subscriptionId: "sub_missing" }, disableDeps(store)),
    RefClientEventSubscriptionsDisableNotFoundError
  );
});

test("disable rejects oversize reason", async () => {
  const store = makeStore();
  const id = seedSubscription(store);
  await assert.rejects(
    () =>
      executeRefClientEventSubscriptionsDisable({ reason: "x".repeat(300), subscriptionId: id }, disableDeps(store)),
    RefClientEventSubscriptionsDisableInvalidRequestError
  );
});

test("disable from pending_verification also transitions to disabled", async () => {
  const store = makeStore();
  const id = seedSubscription(store, { status: "pending_verification" });
  const out = await executeRefClientEventSubscriptionsDisable({ subscriptionId: id }, disableDeps(store));
  assert.equal(out.status, "disabled");
});
