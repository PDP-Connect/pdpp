// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operation-level behavior tests for `rs.streams.aggregate`.
 *
 * Pins the `stream_aggregate` query-shape data block construction, the
 * owner-branch manifest-not-found visibility error, the validator-before-
 * aggregate ordering, and the verbatim aggregate-result passthrough plus
 * disclosure totals derived from the result.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  executeStreamsAggregate,
  type StreamsAggregateDependencies,
  type StreamsAggregateInput,
  type StreamsAggregateSourceDescriptor,
  StreamsAggregateVisibilityError,
} from "../operations/rs-streams-aggregate/index.ts";

function ownerInput(overrides: Partial<StreamsAggregateInput> = {}): StreamsAggregateInput {
  return {
    actor: { kind: "owner", subject_id: "sub_owner" },
    requestParams: {},
    streamName: "messages",
    ...overrides,
  };
}

function clientInput(overrides: Partial<StreamsAggregateInput> = {}): StreamsAggregateInput {
  return {
    actor: {
      client_id: "cli_1",
      grant_id: "gnt_1",
      kind: "client",
      subject_id: "sub_owner",
    },
    requestParams: {},
    streamName: "messages",
    ...overrides,
  };
}

function defaultDeps(overrides: Partial<StreamsAggregateDependencies> = {}): StreamsAggregateDependencies {
  return {
    aggregate: async () => ({
      field: null,
      filtered_record_count: 0,
      group_by: null,
      groups: [],
      metric: "count",
    }),
    getSourceDescriptor: () => null,
    hasManifestStream: () => true,
    // biome-ignore lint/suspicious/noEmptyBlockStatements: localized test assertion preserves its explicit contract.
    validateRequest: () => {},
    ...overrides,
  };
}

test("rs.streams.aggregate emits the stream_aggregate query-shape data block from request params", async () => {
  const out = await executeStreamsAggregate(
    ownerInput({
      requestParams: {
        field: "amount",
        group_by: "category",
        limit: "25",
        metric: "sum",
      },
    }),
    defaultDeps()
  );
  assert.deepEqual(out.queryData, {
    field: "amount",
    granularity: null,
    group_by: "category",
    group_by_time: null,
    limit: 25,
    metric: "sum",
    query_shape: "stream_aggregate",
  });
});

test("rs.streams.aggregate carries group_by_time and granularity in the query-data block", async () => {
  const out = await executeStreamsAggregate(
    ownerInput({
      requestParams: {
        granularity: "day",
        group_by_time: "occurred_at",
        metric: "count",
      },
    }),
    defaultDeps()
  );
  assert.equal(out.queryData.query_shape, "stream_aggregate");
  assert.equal(out.queryData.group_by_time, "occurred_at");
  assert.equal(out.queryData.granularity, "day");
});

test("rs.streams.aggregate fills missing query-data fields with null", async () => {
  const out = await executeStreamsAggregate(ownerInput({ requestParams: {} }), defaultDeps());
  assert.deepEqual(out.queryData, {
    field: null,
    granularity: null,
    group_by: null,
    group_by_time: null,
    limit: null,
    metric: null,
    query_shape: "stream_aggregate",
  });
});

test("rs.streams.aggregate ignores non-string metric/field/group_by values in the query data block", async () => {
  const out = await executeStreamsAggregate(
    ownerInput({
      requestParams: {
        field: { x: 1 },
        group_by: 42,
        metric: ["sum", "avg"],
      },
    }),
    defaultDeps()
  );
  assert.equal(out.queryData.metric, null);
  assert.equal(out.queryData.field, null);
  assert.equal(out.queryData.group_by, null);
});

test("rs.streams.aggregate owner branch throws StreamsAggregateVisibilityError when manifest is missing the stream", async () => {
  await assert.rejects(
    () =>
      executeStreamsAggregate(ownerInput({ streamName: "unknown" }), defaultDeps({ hasManifestStream: () => false })),
    (err) => {
      assert.ok(err instanceof StreamsAggregateVisibilityError);
      assert.equal(err.code, "not_found");
      // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
      assert.match(err.message, /Stream 'unknown' not found/);
      return true;
    }
  );
});

test("rs.streams.aggregate client branch does not consult hasManifestStream", async () => {
  let called = false;
  await executeStreamsAggregate(
    clientInput(),
    defaultDeps({
      hasManifestStream: () => {
        called = true;
        return false;
      },
    })
  );
  assert.equal(called, false);
});

test("rs.streams.aggregate runs validator before aggregate", async () => {
  const order: string[] = [];
  await executeStreamsAggregate(
    ownerInput(),
    defaultDeps({
      // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
      aggregate: async () => {
        order.push("aggregate");
        return { filtered_record_count: 0, groups: [], metric: "count" };
      },
      validateRequest: () => {
        order.push("validate");
      },
    })
  );
  assert.deepEqual(order, ["validate", "aggregate"]);
});

test("rs.streams.aggregate propagates validator errors verbatim (no wrapping)", async () => {
  const validatorErr = new Error("bad field") as Error & { code: string };
  validatorErr.code = "invalid_request";
  await assert.rejects(
    () =>
      executeStreamsAggregate(
        ownerInput(),
        defaultDeps({
          validateRequest: () => {
            throw validatorErr;
          },
        })
      ),
    (err) => {
      assert.strictEqual(err, validatorErr);
      return true;
    }
  );
});

test("rs.streams.aggregate returns the aggregate result verbatim", async () => {
  const aggregated = {
    extra_passthrough: { ignored_by_op: true },
    field: "amount",
    filtered_record_count: 12,
    group_by: "category",
    groups: [
      { key: "a", value: 7 },
      { key: "b", value: 5 },
    ],
    metric: "sum",
  };
  const out = await executeStreamsAggregate(
    ownerInput({ requestParams: { field: "amount", group_by: "category", metric: "sum" } }),
    defaultDeps({ aggregate: async () => aggregated })
  );
  assert.strictEqual(out.result, aggregated);
});

test("rs.streams.aggregate disclosure totals derive from the aggregate result", async () => {
  const out = await executeStreamsAggregate(
    ownerInput(),
    defaultDeps({
      aggregate: async () => ({
        field: "amount",
        filtered_record_count: 12,
        group_by: "category",
        groups: [1, 2, 3, 4],
        metric: "sum",
      }),
    })
  );
  assert.deepEqual(out.disclosureTotals, {
    field: "amount",
    filtered_record_count: 12,
    group_by: "category",
    group_count: 4,
    metric: "sum",
  });
});

test("rs.streams.aggregate disclosure totals tolerate missing groups field with group_count: null", async () => {
  const out = await executeStreamsAggregate(
    ownerInput(),
    defaultDeps({
      aggregate: async () => ({
        field: null,
        filtered_record_count: 0,
        group_by: null,
        metric: "count",
      }),
    })
  );
  assert.equal(out.disclosureTotals.group_count, null);
});

test("rs.streams.aggregate propagates the dependency source descriptor", async () => {
  const source: StreamsAggregateSourceDescriptor = { id: "gmail", kind: "connector" };
  const out = await executeStreamsAggregate(ownerInput(), defaultDeps({ getSourceDescriptor: () => source }));
  assert.deepEqual(out.sourceDescriptor, source);
});
