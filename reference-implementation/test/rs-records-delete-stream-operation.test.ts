const TOP_LEVEL_REGEX_1 = /connector_id must be a single non-empty string/;
const TOP_LEVEL_REGEX_2 = /Stream 'unknown' not found for connector gmail/;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operation-level behavior tests for `rs.records.delete_stream`.
 *
 * Pins:
 *   - invalid_request when connector_id is null/whitespace.
 *   - not_found when the manifest does not declare the stream.
 *   - host capability invocation order (manifest before delete).
 *   - the deletedRecordCount passthrough used by the host's
 *     `mutation.completed` event.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  executeRecordsDeleteStream,
  RecordsDeleteStreamInvalidRequestError,
  RecordsDeleteStreamNotFoundError,
} from "../operations/rs-records-delete-stream/index.ts";

function defaultDeps(overrides = {}) {
  return {
    deleteAllRecords: () => 0,
    hasManifestStream: () => true,
    ...overrides,
  };
}

test("rs.records.delete_stream rejects null connector_id with invalid_request", async () => {
  await assert.rejects(
    () => executeRecordsDeleteStream({ connectorId: null, streamName: "messages" }, defaultDeps()),
    (err) => {
      assert.ok(err instanceof RecordsDeleteStreamInvalidRequestError);
      assert.equal(err.code, "invalid_request");
      assert.match(err.message, TOP_LEVEL_REGEX_1);
      return true;
    }
  );
});

test("rs.records.delete_stream rejects empty string connector_id with invalid_request", async () => {
  await assert.rejects(
    () => executeRecordsDeleteStream({ connectorId: "", streamName: "messages" }, defaultDeps()),
    (err) => {
      assert.ok(err instanceof RecordsDeleteStreamInvalidRequestError);
      assert.equal(err.code, "invalid_request");
      return true;
    }
  );
});

test("rs.records.delete_stream raises not_found when manifest is missing the stream", async () => {
  await assert.rejects(
    () =>
      executeRecordsDeleteStream(
        { connectorId: "gmail", streamName: "unknown" },
        defaultDeps({ hasManifestStream: () => false })
      ),
    (err) => {
      assert.ok(err instanceof RecordsDeleteStreamNotFoundError);
      assert.equal(err.code, "not_found");
      assert.match(err.message, TOP_LEVEL_REGEX_2);
      return true;
    }
  );
});

test("rs.records.delete_stream runs manifest check before invoking deleteAllRecords", async () => {
  let deleteCalls = 0;
  await assert.rejects(
    () =>
      executeRecordsDeleteStream(
        { connectorId: "gmail", streamName: "unknown" },
        defaultDeps({
          deleteAllRecords: () => {
            deleteCalls += 1;
            return 0;
          },
          hasManifestStream: () => false,
        })
      ),
    (err) => {
      assert.ok(err instanceof RecordsDeleteStreamNotFoundError);
      return true;
    }
  );
  assert.equal(deleteCalls, 0);
});

test("rs.records.delete_stream returns the deletedRecordCount from the dependency", async () => {
  const out = await executeRecordsDeleteStream(
    { connectorId: "gmail", streamName: "messages" },
    defaultDeps({ deleteAllRecords: () => 17 })
  );
  assert.equal(out.deletedRecordCount, 17);
});

test("rs.records.delete_stream propagates dependency errors verbatim", async () => {
  const dbErr: Error & { code: string } = Object.assign(new Error("disk failure"), {
    code: "api_error",
  });
  await assert.rejects(
    () =>
      executeRecordsDeleteStream(
        { connectorId: "gmail", streamName: "messages" },
        defaultDeps({
          deleteAllRecords: () => {
            throw dbErr;
          },
        })
      ),
    (err) => {
      assert.strictEqual(err, dbErr);
      return true;
    }
  );
});
