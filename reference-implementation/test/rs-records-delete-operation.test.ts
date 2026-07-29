// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operation-level behavior tests for `rs.records.delete`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  executeRecordsDelete,
  RecordsDeleteInvalidRequestError,
  RecordsDeleteNotFoundError,
} from "../operations/rs-records-delete/index.ts";

function defaultDeps(overrides = {}) {
  return {
    deleteRecord: () => 1,
    hasManifestStream: () => true,
    ...overrides,
  };
}

test("rs.records.delete rejects null connector_id with invalid_request", async () => {
  await assert.rejects(
    () => executeRecordsDelete({ connectorId: null, recordId: "r1", streamName: "messages" }, defaultDeps()),
    (err) => {
      assert.ok(err instanceof RecordsDeleteInvalidRequestError);
      assert.equal(err.code, "invalid_request");
      return true;
    }
  );
});

test("rs.records.delete raises not_found when manifest is missing the stream", async () => {
  await assert.rejects(
    () =>
      executeRecordsDelete(
        { connectorId: "gmail", recordId: "r1", streamName: "unknown" },
        defaultDeps({ hasManifestStream: () => false })
      ),
    (err) => {
      assert.ok(err instanceof RecordsDeleteNotFoundError);
      assert.equal(err.code, "not_found");
      return true;
    }
  );
});

test("rs.records.delete forwards stream and recordId to deleteRecord", async () => {
  // biome-ignore lint/suspicious/noEvolvingTypes: Accumulator evolves through deliberately heterogeneous fixture data.
  // biome-ignore lint/suspicious/noImplicitAnyLet: Fixture accumulator is intentionally inferred from runtime test data.
  let captured;
  await executeRecordsDelete(
    { connectorId: "gmail", recordId: "r1", streamName: "messages" },
    defaultDeps({
      deleteRecord: (cid: string, stream: string, recordId: string) => {
        captured = { cid, recordId, stream };
        return 1;
      },
    })
  );
  assert.deepEqual(captured, { cid: "gmail", recordId: "r1", stream: "messages" });
});

test("rs.records.delete returns the dependency-provided deletedRecordCount", async () => {
  const out = await executeRecordsDelete(
    { connectorId: "gmail", recordId: "r1", streamName: "messages" },
    defaultDeps({ deleteRecord: () => 0 })
  );
  assert.equal(out.deletedRecordCount, 0);
});

test("rs.records.delete runs manifest check before invoking deleteRecord", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      executeRecordsDelete(
        { connectorId: "gmail", recordId: "r1", streamName: "unknown" },
        defaultDeps({
          deleteRecord: () => {
            calls += 1;
            return 1;
          },
          hasManifestStream: () => false,
        })
      ),
    () => true
  );
  assert.equal(calls, 0);
});
