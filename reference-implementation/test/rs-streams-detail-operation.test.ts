const TOP_LEVEL_REGEX_1 = /'no_such' not found/;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operation-level tests for `rs.streams.detail`.
 *
 * Exercises the operation in isolation with stub dependencies, asserting
 * that:
 *   - the response is built from the dependency's metadata envelope verbatim;
 *   - the source descriptor flows from the dependency to the output;
 *   - `query.received`-shaped data is `query_shape: 'stream_metadata'`;
 *   - missing manifest streams raise `not_found`;
 *   - client actors with the stream missing from grant raise
 *     `grant_stream_not_allowed`;
 *   - owner actors bypass the grant check entirely.
 *
 * These tests are the regression baseline for the operation's behavior.
 * Host-mounted parity is covered by `pdpp.test.js` (native) and the sandbox
 * `_demo/routes.test.ts` suite.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  executeStreamDetail,
  type StreamDetailActor,
  type StreamDetailDependencies,
  type StreamDetailSourceDescriptor,
  StreamDetailVisibilityError,
} from "../operations/rs-streams-detail/index.ts";

const ownerActor: StreamDetailActor = { kind: "owner", subject_id: "subj_1" };
const clientActor: StreamDetailActor = {
  client_id: "client_x",
  grant_id: "grant_y",
  kind: "client",
  subject_id: "subj_1",
};
const sourceDescriptor: StreamDetailSourceDescriptor = { id: "acme_payroll", kind: "connector" };

function makeDeps(overrides: Partial<StreamDetailDependencies> = {}): StreamDetailDependencies {
  return {
    buildStreamMetadata: (name: string) =>
      Promise.resolve({
        name,
        object: "stream_metadata",
        primary_key: ["id"],
        relationships: [],
        views: [],
      }),
    getSourceDescriptor: () => sourceDescriptor,
    hasManifestStream: () => Promise.resolve(true),
    isStreamInGrant: () => true,
    ...overrides,
  };
}

test("rs.streams.detail returns the dependency envelope verbatim for owner", async () => {
  const result = await executeStreamDetail({ actor: ownerActor, streamName: "pay_statements" }, makeDeps());
  assert.equal(result.metadata.object, "stream_metadata");
  assert.equal(result.metadata.name, "pay_statements");
  assert.deepEqual(result.sourceDescriptor, sourceDescriptor);
  assert.deepEqual(result.queryData, { query_shape: "stream_metadata" });
});

test("rs.streams.detail returns the dependency envelope for client when stream is in grant", async () => {
  const result = await executeStreamDetail({ actor: clientActor, streamName: "pay_statements" }, makeDeps());
  assert.equal(result.metadata.name, "pay_statements");
  assert.deepEqual(result.queryData, { query_shape: "stream_metadata" });
});

test("rs.streams.detail throws not_found when manifest visibility fails", async () => {
  await assert.rejects(
    () =>
      executeStreamDetail(
        { actor: ownerActor, streamName: "no_such" },
        makeDeps({ hasManifestStream: () => Promise.resolve(false) })
      ),
    (err) => {
      assert.ok(err instanceof StreamDetailVisibilityError);
      assert.equal(err.code, "not_found");
      assert.match(err.message, TOP_LEVEL_REGEX_1);
      return true;
    }
  );
});

test("rs.streams.detail throws grant_stream_not_allowed when client grant excludes the stream", async () => {
  await assert.rejects(
    () =>
      executeStreamDetail(
        { actor: clientActor, streamName: "pay_statements" },
        makeDeps({ isStreamInGrant: () => false })
      ),
    (err) => {
      assert.ok(err instanceof StreamDetailVisibilityError);
      assert.equal(err.code, "grant_stream_not_allowed");
      return true;
    }
  );
});

test("rs.streams.detail does not consult isStreamInGrant for owner actors", async () => {
  let consulted = false;
  const result = await executeStreamDetail(
    { actor: ownerActor, streamName: "pay_statements" },
    makeDeps({
      isStreamInGrant: () => {
        consulted = true;
        return false;
      },
    })
  );
  assert.equal(consulted, false);
  assert.equal(result.metadata.name, "pay_statements");
});

test("rs.streams.detail does not call buildStreamMetadata when manifest visibility fails", async () => {
  let built = false;
  await assert.rejects(() =>
    executeStreamDetail(
      { actor: ownerActor, streamName: "gone" },
      makeDeps({
        buildStreamMetadata: () => {
          built = true;
          return Promise.resolve({ name: "gone", object: "stream_metadata" });
        },
        hasManifestStream: () => Promise.resolve(false),
      })
    )
  );
  assert.equal(built, false);
});

test("rs.streams.detail does not call buildStreamMetadata when grant blocks the stream", async () => {
  let built = false;
  await assert.rejects(() =>
    executeStreamDetail(
      { actor: clientActor, streamName: "gated" },
      makeDeps({
        buildStreamMetadata: () => {
          built = true;
          return Promise.resolve({ name: "gated", object: "stream_metadata" });
        },
        isStreamInGrant: () => false,
      })
    )
  );
  assert.equal(built, false);
});

test("rs.streams.detail awaits async dependency promises", async () => {
  let resolved = false;
  const result = await executeStreamDetail(
    { actor: ownerActor, streamName: "pay_statements" },
    makeDeps({
      buildStreamMetadata: (name) =>
        new Promise((r) =>
          setImmediate(() => {
            resolved = true;
            r({ name, object: "stream_metadata" });
          })
        ),
    })
  );
  assert.equal(resolved, true);
  assert.equal(result.metadata.name, "pay_statements");
});
