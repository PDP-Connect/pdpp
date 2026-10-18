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
