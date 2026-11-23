// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  executeRecordsList,
  type RecordsListDependencies,
  type RecordsListInput,
  RecordsListVisibilityError,
} from "./index.ts";

const manifest = {
  streams: [
    { name: "A", schema: { properties: { title: { type: "string" } } } },
    { name: "B", schema: { properties: { title: { type: "string" } } } },
  ],
};
const clientGrant = { streams: [{ name: "A", fields: ["title"] }] };

function makeInput(overrides: Partial<RecordsListInput> = {}): RecordsListInput {
  return {
    actor: { kind: "client", subject_id: "owner-1", client_id: "client-1", grant_id: "grant-1" },
    requestParams: { fields: ["title"], limit: 10 },
    streamName: "A",
    ...overrides,
  };
}

function makeDependencies(overrides: Partial<RecordsListDependencies> = {}): RecordsListDependencies {
  return {
    decorateRecord: (record) => record,
    getGrant: () => clientGrant,
    getManifest: () => manifest,
    getSourceDescriptor: () => ({ id: "source-1", kind: "connector" }),
    queryRecords: async () => ({ data: [{ title: "allowed" }] }),
    validateRequestFields: () => {
      // This fixture does not add request-level validation cases.
    },
    ...overrides,
  };
}

test("client stream outside the grant is rejected before storage or decoration", async () => {
  let queryCalls = 0;
  let decorateCalls = 0;
  const dependencies = makeDependencies({
    decorateRecord: () => {
      decorateCalls += 1;
      throw new Error("decorateRecord must not run for a rejected stream");
    },
    queryRecords: () => {
      queryCalls += 1;
      return Promise.reject(new Error("queryRecords must not run for a rejected stream"));
    },
  });

  await assert.rejects(
    executeRecordsList(makeInput({ streamName: "B" }), dependencies),
    (error: unknown) => error instanceof RecordsListVisibilityError && error.code === "grant_stream_not_allowed"
  );
  assert.equal(queryCalls, 0);
  assert.equal(decorateCalls, 0);
});

test("client view selection is invalid before storage or decoration", async () => {
  let queryCalls = 0;
  let decorateCalls = 0;
  const dependencies = makeDependencies({
    decorateRecord: () => {
      decorateCalls += 1;
      throw new Error("decorateRecord must not run for a rejected view");
    },
    queryRecords: () => {
      queryCalls += 1;
      return Promise.reject(new Error("queryRecords must not run for a rejected view"));
    },
  });

  await assert.rejects(
    executeRecordsList(makeInput({ rawQueryView: "compact" }), dependencies),
    (error: unknown) => error instanceof RecordsListVisibilityError && error.code === "invalid_request"
  );
  assert.equal(queryCalls, 0);
  assert.equal(decorateCalls, 0);
});

test("owner record-list telemetry describes an incremental page and its continuation", async () => {
  const result = await executeRecordsList(
    makeInput({
      actor: { kind: "owner", subject_id: "synthetic" },
      requestParams: { fields: ["title"], limit: "2", changes_since: "previous-marker" },
    }),
    makeDependencies({
      queryRecords: async () => ({
        data: [{ title: "first" }, { title: "second" }],
        has_more: true,
        next_changes_since: "next-marker",
      }),
    })
  );

  assert.deepEqual(result.queryData, { has_changes_since: true, limit: 2, query_shape: "record_list" });
  assert.deepEqual(result.disclosureData, {
    has_more: true,
    has_next_changes_since: true,
    query_shape: "record_list",
    record_count: 2,
  });
  assert.equal(result.result.next_changes_since, "next-marker");
});

test("owner record-list telemetry keeps an unknown limit separate from an observed empty page", async () => {
  const result = await executeRecordsList(
    makeInput({ actor: { kind: "owner", subject_id: "synthetic" }, requestParams: { limit: "" } }),
    makeDependencies({ queryRecords: async () => ({ data: [] }) })
  );

  assert.deepEqual(result.queryData, { has_changes_since: false, limit: null, query_shape: "record_list" });
  assert.deepEqual(result.disclosureData, {
    has_more: false,
    has_next_changes_since: false,
    query_shape: "record_list",
    record_count: 0,
  });
  assert.deepEqual(result.result.data, []);
});

test("owner and granted client reads of stream A succeed", async () => {
  let queryCalls = 0;
  let decorateCalls = 0;
  const dependencies = makeDependencies({
    decorateRecord: (record) => {
      decorateCalls += 1;
      return record;
    },
    queryRecords: (stream) => {
      queryCalls += 1;
      assert.equal(stream, "A");
      return Promise.resolve({ data: [{ title: "allowed" }] });
    },
  });

  const client = await executeRecordsList(makeInput(), dependencies);
  const owner = await executeRecordsList(makeInput({ actor: { kind: "owner", subject_id: "owner-1" } }), dependencies);

  assert.deepEqual(client.result.data, [{ title: "allowed" }]);
  assert.deepEqual(owner.result.data, [{ title: "allowed" }]);
  assert.equal(queryCalls, 2);
  assert.equal(decorateCalls, 2);
});

test("owner view selects fields within a decorated record envelope", async () => {
  const requestParams = { view: "compact" };
  const input = makeInput({
    actor: { kind: "owner", subject_id: "owner-1" },
    rawQueryView: "compact",
    requestParams,
  });
  const result = await executeRecordsList(
    input,
    makeDependencies({
      getManifest: () => ({
        streams: [{ ...manifest.streams[0], name: "A", views: [{ id: "compact", fields: ["title"] }] }],
      }),
      queryRecords: async (_stream, _grant, params) => {
        assert.deepEqual(params, { fields: ["title"] });
        return { data: [{ id: "row-1", data: { title: "Draft", subtitle: "Long title" } }] };
      },
      decorateRecord: (record) => ({ ...record, display: "Preview" }),
    })
  );
  assert.deepEqual(result.result.data, [{ id: "row-1", display: "Preview", data: { title: "Draft" } }]);
  assert.equal(result.queryData.requested_view, "compact");
});

test("an empty records page preserves its continuation and reports zero returned rows", async () => {
  const page = { data: [], has_more: true, next_cursor: "page-2", next_changes_since: "2026-01-01T00:00:00Z" };
  const result = await executeRecordsList(
    makeInput({ requestParams: { fields: ["title"], limit: "8", changes_since: "2025-12-31T00:00:00Z" } }),
    makeDependencies({ queryRecords: async () => page })
  );
  assert.deepEqual(result.result, page);
  assert.deepEqual(result.disclosureData, {
    has_more: true,
    has_next_changes_since: true,
    query_shape: "record_list",
    record_count: 0,
  });
  assert.deepEqual(result.queryData, { has_changes_since: true, limit: 8, query_shape: "record_list" });
});
