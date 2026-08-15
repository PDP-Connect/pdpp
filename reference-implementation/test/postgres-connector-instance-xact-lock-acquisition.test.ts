// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Red-team follow-up (2026-08-10, harden-connector-instance-write-fence-
 * transaction-native REVISE): the prior dedicated-lock-pool architecture had
 * a deterministic, default-CI test proving exactly-once advisory-lock
 * acquisition against a fake Postgres pool/client
 * (connector-instance-write-coordinator.test.ts's "a late lock-query result
 * cannot release its client twice or strand local capacity", using
 * `__setConnectorInstancePostgresLockPoolForTest`). That whole seam and the
 * dedicated pool it exercised were removed when advisory-lock acquisition
 * moved to a per-transaction `pg_advisory_xact_lock` inside
 * `withPostgresTransaction` (see `acquireConnectorInstanceXactLock`,
 * postgres-storage.ts) — leaving no default-CI coverage of the CURRENT
 * acquisition sequence at all; only the dedicated-Postgres-gated tests in
 * connector-instance-write-coordinator.test.ts exercise it, and those are
 * skipped unless PDPP_TEST_POSTGRES_URL targets the dedicated test listener.
 *
 * This drives `acquireConnectorInstanceXactLock` directly (via the
 * `__acquireConnectorInstanceXactLockForTest` seam) against a fake
 * `PoolClient`-shaped object that records every query — no real Postgres
 * connection, no dedicated pool, runs in default CI. It proves the
 * TRANSACTION-NATIVE design specifically (one lock statement per call, not
 * once per batch/session; a `55P03` lock-timeout failure translates to the
 * typed `ConnectorInstanceAdmissionError`/`connector_instance_busy` contract
 * every caller already depends on) rather than resurrecting anything from
 * the obsolete session-lock architecture.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  ConnectorInstanceAdmissionError,
  connectorInstanceAdvisoryLockKey,
} from "../server/connector-instance-write-coordinator.ts";
import { __acquireConnectorInstanceXactLockForTest } from "../server/postgres-storage.ts";

const SET_LOCAL_LOCK_TIMEOUT_PATTERN = /^SET LOCAL lock_timeout = '\d+ms'$/;

interface RecordedQuery {
  readonly params: readonly unknown[] | undefined;
  readonly sql: string;
}

/**
 * Minimal fake matching the ONLY `PoolClient` surface
 * `acquireConnectorInstanceXactLock` actually calls: `.query(sql, params?)`.
 * `respond` lets each test script exactly what the fake Postgres server
 * "returns" for each successive statement, including throwing a
 * SQLSTATE-bearing error to simulate `lock_timeout` expiring.
 */
function fakePoolClient(respond: (query: RecordedQuery, callIndex: number) => unknown) {
  const calls: RecordedQuery[] = [];
  const client = {
    // biome-ignore lint/suspicious/useAwait: matches the real PoolClient.query's Promise-returning contract; nothing here needs to await.
    query: async (sql: string, params?: readonly unknown[]) => {
      const recorded: RecordedQuery = { params, sql };
      calls.push(recorded);
      const result = respond(recorded, calls.length - 1);
      if (result instanceof Error) {
        throw result;
      }
      return result ?? { rows: [] };
    },
  };
  return { calls, client };
}

test("acquireConnectorInstanceXactLock issues exactly one SET LOCAL lock_timeout then one pg_advisory_xact_lock call, keyed by the derived bigint", async () => {
  const connectorInstanceId = "cin_xact_lock_probe";
  const { calls, client } = fakePoolClient(() => ({ rows: [] }));

  await __acquireConnectorInstanceXactLockForTest(client as any, connectorInstanceId);

  assert.equal(calls.length, 2, "exactly two statements: SET LOCAL then the advisory lock — never zero, never a retry");
  const [setLocalCall, lockCall] = calls;
  assert.ok(setLocalCall && lockCall, "both recorded calls exist");
  assert.match(setLocalCall.sql, SET_LOCAL_LOCK_TIMEOUT_PATTERN);
  assert.equal(lockCall.sql, "SELECT pg_advisory_xact_lock($1::bigint)");
  assert.deepEqual(
    lockCall.params,
    [connectorInstanceAdvisoryLockKey(connectorInstanceId)],
    "the lock statement must use the SAME derived key connectorInstanceAdvisoryLockKey produces — a mismatch would silently stop this identity's writers from serializing against each other"
  );
});

test("acquireConnectorInstanceXactLock translates a lock_timeout SQLSTATE (55P03) into the typed ConnectorInstanceAdmissionError contract", async () => {
  const { client } = fakePoolClient((_query, callIndex) => {
    if (callIndex === 1) {
      const err = new Error("canceling statement due to lock timeout") as Error & { code?: string };
      err.code = "55P03";
      return err;
    }
    return { rows: [] };
  });

  await assert.rejects(
    () => __acquireConnectorInstanceXactLockForTest(client as any, "cin_xact_lock_timeout"),
    (error: unknown) =>
      error instanceof ConnectorInstanceAdmissionError &&
      error.code === "connector_instance_busy" &&
      // Mutation-discriminating: a version that forgot to catch/translate at
      // all, or that translated every error (not just 55P03) into this same
      // typed error, both need a distinguishable failure mode from THIS one.
      error.message === "connector-instance writer admission is saturated"
  );
});

test("acquireConnectorInstanceXactLock re-throws a non-lock_timeout error unmodified (does not misclassify an unrelated failure as busy)", async () => {
  const originalError = new Error("connection terminated unexpectedly") as Error & { code?: string };
  originalError.code = "57P01";
  const { client } = fakePoolClient((_query, callIndex) => (callIndex === 1 ? originalError : { rows: [] }));

  await assert.rejects(
    () => __acquireConnectorInstanceXactLockForTest(client as any, "cin_xact_lock_other_error"),
    (error: unknown) => error === originalError,
    "a non-55P03 failure must propagate as-is, not be silently reclassified as connector_instance_busy — collapsing every driver error into admission-saturated would hide a genuine connection/server failure behind a misleading retryable-busy signal"
  );
});

test("acquireConnectorInstanceXactLock issues the lock_timeout SET before the lock acquisition attempt, not after", async () => {
  const order: string[] = [];
  const { client } = fakePoolClient((query) => {
    order.push(query.sql.startsWith("SET LOCAL") ? "set_local" : "advisory_lock");
    return { rows: [] };
  });

  await __acquireConnectorInstanceXactLockForTest(client as any, "cin_xact_lock_ordering");

  assert.deepEqual(
    order,
    ["set_local", "advisory_lock"],
    "the bounded-wait timeout must be in effect BEFORE the blocking lock call, or a caller could queue indefinitely at the Postgres lock manager instead of failing fast with connector_instance_busy"
  );
});
