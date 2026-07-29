// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Aggregation-rows conformance harness.
 *
 * Pins the durable obligations of `listRowsForAggregation` — the internal
 * helper called by `aggregateRecords` to materialise the full row set for a
 * stream before the in-process aggregation pass. The invariants here are:
 *
 *   1. Only non-deleted rows for the requested (connectorInstanceId, stream)
 *      pair are returned.
 *   2. Rows are ordered by record_key ASC.
 *   3. record_json is a STRING on both backends (Postgres stores JSONB; the
 *      production Postgres branch stringifies with JSON.stringify before
 *      returning — this is the key invariant that lets aggregateRecords call
 *      JSON.parse unconditionally).
 *   4. The query is scoped to connector_instance_id: two different connector
 *      instances sharing the same stream name do not bleed into each other.
 *
 * Driver shape
 * ------------
 * The driver is a plain object with these async methods:
 *
 *   async setup(): void
 *     Initialise the backend (open db, run migrations, register manifest).
 *
 *   async teardown(): void
 *     Clean up all test data and close connections.
 *
 *   async seed(connectorInstanceId, stream, records): void
 *     Insert records into the backend for the given (connectorInstanceId,
 *     stream) pair. Each record is:
 *       { key: string, data: object, deleted?: boolean }
 *     When `deleted` is true the row must be inserted with deleted=true (or
 *     equivalently: upserted then soft-deleted) so that the harness can prove
 *     the deleted-exclusion invariant.
 *
 *   async listRows(connectorInstanceId, stream): Array<{record_key, record_json}>
 *     Call the REAL production `listRowsForAggregation(connectorInstanceId,
 *     stream)` function and return its output verbatim.
 *
 * Constants
 * ---------
 * CONFORMANCE_CONNECTOR_ID   — connector_id used by the harness manifest.
 * CONFORMANCE_STREAM_A       — primary stream name.
 * CONFORMANCE_STREAM_B       — secondary stream name (isolation / multi-stream).
 * CONFORMANCE_MANIFEST       — minimal manifest drivers must register.
 *
 * Spec: openspec/changes/pilot-storage-backend-interface/
 */

import assert from "node:assert/strict";

interface AggregationRecord {
  data: Record<string, unknown>;
  deleted?: boolean;
  key: string;
}

interface AggregationRow {
  record_json: string;
  record_key: string;
}

interface AggregationDriver {
  listRows: (connectorInstanceId: string, stream: string) => Promise<AggregationRow[]>;
  seed: (connectorInstanceId: string, stream: string, records: AggregationRecord[]) => Promise<void>;
  setup: () => Promise<void>;
  teardown: () => Promise<void>;
}

type TestFn = (name: string, fn: () => Promise<void>) => void;

export const CONFORMANCE_CONNECTOR_ID = "agg-rows-conformance";
export const CONFORMANCE_STREAM_A = "transactions";
export const CONFORMANCE_STREAM_B = "accounts";

/**
 * Minimal manifest. Two streams; no cursor field or query config required —
 * the harness only exercises listRowsForAggregation, not queryRecords.
 */
export const CONFORMANCE_MANIFEST = {
  connector_id: CONFORMANCE_CONNECTOR_ID,
  display_name: "Aggregation Rows Conformance",
  protocol_version: "0.1.0",
  runtime_requirements: { bindings: { network: { required: false } } },
  streams: [
    {
      name: CONFORMANCE_STREAM_A,
      primary_key: ["id"],
      schema: {
        properties: {
          amount: { type: "number" },
          id: { type: "string" },
          label: { type: ["string", "null"] },
        },
        required: ["id"],
        type: "object",
      },
      semantics: "mutable_state",
    },
    {
      name: CONFORMANCE_STREAM_B,
      primary_key: ["id"],
      schema: {
        properties: {
          id: { type: "string" },
          name: { type: "string" },
        },
        required: ["id"],
        type: "object",
      },
      semantics: "mutable_state",
    },
  ],
  version: "1.0.0",
};

/**
 * Run the aggregation-rows conformance suite against a driver.
 *
 * @param {object} options
 * @param {string} options.label                          distinguishes the driver in test names
 * @param {(name: string, fn: () => Promise<void>) => void} options.test  node:test's `test`
 * @param {() => object} options.makeDriver               factory — called once per scenario
 * @param {string} options.connectorInstanceIdA           instance id for primary instance
 * @param {string} options.connectorInstanceIdB           second instance id for isolation scenarios
 */
export function runAggregationRowsConformance({
  label,
  test,
  makeDriver,
  connectorInstanceIdA,
  connectorInstanceIdB,
}: {
  label: string;
  test: TestFn;
  makeDriver: () => Promise<AggregationDriver> | AggregationDriver;
  connectorInstanceIdA: string;
  connectorInstanceIdB: string;
}): void {
  const t = (name: string, fn: () => Promise<void>) => test(`[conformance:${label}] ${name}`, fn);

  // ------------------------------------------------------------------ //
  // 1. Basic row retrieval: non-deleted rows returned, record_key ASC.   //
  // ------------------------------------------------------------------ //
  t("returns non-deleted rows in record_key ASC order", async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.seed(connectorInstanceIdA, CONFORMANCE_STREAM_A, [
        { data: { amount: 30, id: "tx_003", label: "gamma" }, key: "tx_003" },
        { data: { amount: 10, id: "tx_001", label: "alpha" }, key: "tx_001" },
        { data: { amount: 20, id: "tx_002", label: "beta" }, key: "tx_002" },
      ]);

      const rows = await driver.listRows(connectorInstanceIdA, CONFORMANCE_STREAM_A);

      assert.equal(rows.length, 3, "expected 3 rows");
      assert.deepEqual(
        rows.map((r) => r.record_key),
        ["tx_001", "tx_002", "tx_003"],
        "rows must be ordered by record_key ASC"
      );
    } finally {
      await driver.teardown();
    }
  });

  // ------------------------------------------------------------------ //
  // 2. Deleted rows excluded.                                            //
  // ------------------------------------------------------------------ //
  t("excludes deleted rows", async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.seed(connectorInstanceIdA, CONFORMANCE_STREAM_A, [
        { data: { amount: 1, id: "keep_a" }, key: "keep_a" },
        { data: { amount: 2, id: "gone_b" }, deleted: true, key: "gone_b" },
        { data: { amount: 3, id: "keep_c" }, key: "keep_c" },
      ]);

      const rows = await driver.listRows(connectorInstanceIdA, CONFORMANCE_STREAM_A);

      const keys = rows.map((r) => r.record_key);
      assert.ok(!keys.includes("gone_b"), "deleted row must be excluded");
      // biome-ignore lint/suspicious/useArraySortCompare: localized test assertion preserves its explicit contract.
      assert.deepEqual(keys.sort(), ["keep_a", "keep_c"], "exactly the two live rows");
    } finally {
      await driver.teardown();
    }
  });

  // ------------------------------------------------------------------ //
  // 3. record_json is a STRING — the critical cross-backend invariant.  //
  //    Postgres stores JSONB; the production branch stringifies before  //
  //    returning so that aggregateRecords can call JSON.parse blindly.  //
  // ------------------------------------------------------------------ //
  t("record_json is a string (not an object) from both backends", async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.seed(connectorInstanceIdA, CONFORMANCE_STREAM_A, [
        { data: { amount: 99, id: "str_check", label: "test" }, key: "str_check" },
      ]);

      const rows = await driver.listRows(connectorInstanceIdA, CONFORMANCE_STREAM_A);
      assert.equal(rows.length, 1, "expected 1 row");

      // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
      const row = rows[0];
      assert.ok(row);
      assert.equal(typeof row.record_json, "string", `record_json must be a string; got ${typeof row.record_json}`);

      // Verify the string is valid JSON that round-trips correctly.
      const parsed = JSON.parse(row.record_json);
      assert.equal(parsed.id, "str_check", "parsed record_json must contain the original data");
      assert.equal(parsed.amount, 99);
    } finally {
      await driver.teardown();
    }
  });

  // ------------------------------------------------------------------ //
  // 4. Non-default record key: a record whose storage key is a long     //
  //    opaque string (not a simple short id). Production ingestRecord   //
  //    validates that key parts match data primary-key fields; here     //
  //    we satisfy that by setting data.id equal to the full key string. //
  //    listRowsForAggregation must return the storage key verbatim.     //
  // ------------------------------------------------------------------ //
  t("returns a long opaque record_key verbatim from the store", async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      // The record key is a long opaque string. Because the manifest declares
      // primary_key: ['id'], ingestRecord requires data.id === key.
      const opaqueKey = "stmt:2026-01-01T00:00:00Z:acct_checking:00001";
      await driver.seed(connectorInstanceIdA, CONFORMANCE_STREAM_A, [
        { data: { amount: 42, id: opaqueKey }, key: opaqueKey },
      ]);

      const rows = await driver.listRows(connectorInstanceIdA, CONFORMANCE_STREAM_A);
      assert.equal(rows.length, 1);
      // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
      const row = rows[0];
      assert.ok(row);
      assert.equal(row.record_key, opaqueKey, "record_key must be the full opaque storage key returned verbatim");
    } finally {
      await driver.teardown();
    }
  });

  // ------------------------------------------------------------------ //
  // 5. Multi-stream isolation: results for stream A exclude stream B.   //
  // ------------------------------------------------------------------ //
  t("scopes results to the requested stream (multi-stream isolation)", async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.seed(connectorInstanceIdA, CONFORMANCE_STREAM_A, [
        { data: { amount: 100, id: "tx_only" }, key: "tx_only" },
      ]);
      await driver.seed(connectorInstanceIdA, CONFORMANCE_STREAM_B, [
        { data: { id: "acct_only", name: "Checking" }, key: "acct_only" },
      ]);

      const txRows = await driver.listRows(connectorInstanceIdA, CONFORMANCE_STREAM_A);
      assert.deepEqual(
        txRows.map((r) => r.record_key),
        ["tx_only"],
        "stream A query must not include stream B rows"
      );

      const acctRows = await driver.listRows(connectorInstanceIdA, CONFORMANCE_STREAM_B);
      assert.deepEqual(
        acctRows.map((r) => r.record_key),
        ["acct_only"],
        "stream B query must not include stream A rows"
      );
    } finally {
      await driver.teardown();
    }
  });

  // ------------------------------------------------------------------ //
  // 6. Multi-account / connector-instance scoping.                      //
  //    Two connector_instance_ids sharing the same stream name must     //
  //    not see each other's rows.                                       //
  // ------------------------------------------------------------------ //
  t("scopes results to connector_instance_id (multi-account isolation)", async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      await driver.seed(connectorInstanceIdA, CONFORMANCE_STREAM_A, [
        { data: { amount: 50, id: "alice_tx" }, key: "alice_tx" },
      ]);
      await driver.seed(connectorInstanceIdB, CONFORMANCE_STREAM_A, [
        { data: { amount: 75, id: "bob_tx" }, key: "bob_tx" },
      ]);

      const aliceRows = await driver.listRows(connectorInstanceIdA, CONFORMANCE_STREAM_A);
      assert.deepEqual(
        aliceRows.map((r) => r.record_key),
        ["alice_tx"],
        "connector instance A must not see instance B rows"
      );

      const bobRows = await driver.listRows(connectorInstanceIdB, CONFORMANCE_STREAM_A);
      assert.deepEqual(
        bobRows.map((r) => r.record_key),
        ["bob_tx"],
        "connector instance B must not see instance A rows"
      );
    } finally {
      await driver.teardown();
    }
  });

  // ------------------------------------------------------------------ //
  // 7. Empty stream returns empty array.                                //
  // ------------------------------------------------------------------ //
  t("returns empty array for a stream with no rows", async () => {
    const driver = await makeDriver();
    await driver.setup();
    try {
      const rows = await driver.listRows(connectorInstanceIdA, CONFORMANCE_STREAM_A);
      assert.deepEqual(rows, [], "empty stream must return []");
    } finally {
      await driver.teardown();
    }
  });
}
