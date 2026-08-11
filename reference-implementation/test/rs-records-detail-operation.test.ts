const TOP_LEVEL_REGEX_1 = /'missing'/;
const TOP_LEVEL_REGEX_2 = /'pay_statements'/;
const TOP_LEVEL_REGEX_3 = /definitely_not_a_field/;
const TOP_LEVEL_REGEX_4 = /Stream 'gone' not in grant/;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operation-level tests for `rs.records.get`.
 *
 * Exercises the operation in isolation with stub dependencies, asserting
 * that:
 *   - the dependency record flows through `decorateRecord` to the output;
 *   - the source descriptor flows from the dependency to the output;
 *   - `query.received`-shaped data is `query_shape: 'record_detail'` with
 *     the requested record id and fixed `has_changes_since: false` /
 *     `limit: null`;
 *   - `disclosure.served`-shaped data is populated with `record_count: 1`
 *     and `requested_record_id`;
 *   - owner actors receive an owner read-grant scoped to the stream;
 *   - `getRecord` is called with the resolved manifest and grant;
 *   - a null `getRecord` result raises `not_found`.
 *
 * Host-mounted parity is covered by `pdpp.test.js` (native) and the
 * sandbox `_demo/routes.test.ts` suite.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  executeRecordDetail,
  type RecordDetailActor,
  type RecordDetailDependencies,
  type RecordDetailExpandOptions,
  type RecordDetailGrant,
  type RecordDetailManifest,
  type RecordDetailManifestStream,
  type RecordDetailSourceDescriptor,
  RecordDetailVisibilityError,
} from "../operations/rs-records-detail/index.ts";

const ownerActor: RecordDetailActor = { kind: "owner", subject_id: "subj_1" };
const clientActor: RecordDetailActor = {
  client_id: "client_x",
  grant_id: "grant_y",
  kind: "client",
  subject_id: "subj_1",
};
const sourceDescriptor: RecordDetailSourceDescriptor = { id: "acme_payroll", kind: "connector" };

function makeDeps(overrides: Partial<RecordDetailDependencies> = {}): RecordDetailDependencies {
  return {
    decorateRecord: (record) => record,
    getGrant: () => ({ streams: [{ name: "pay_statements" }] }),
    getManifest: () => ({
      streams: [
        {
          name: "pay_statements",
          schema: {
            properties: {
              employer: {},
              id: {},
              net_pay_minor: {},
              sent_at: {},
            },
          },
        },
      ],
    }),
    getRecord: (stream, recordId) => Promise.resolve({ id: recordId, object: "record", stream }),
    getSourceDescriptor: () => sourceDescriptor,
    validateRequestFields: () => undefined,
    ...overrides,
  };
}

test("rs.records.get returns the dependency record for owner shape", async () => {
  const result = await executeRecordDetail(
    {
      actor: ownerActor,
      recordId: "rec_1",
      streamName: "pay_statements",
    },
    makeDeps()
  );
  assert.equal(result.record.object, "record");
  assert.equal(result.record.id, "rec_1");
  assert.equal(result.record.stream, "pay_statements");
  assert.deepEqual(result.sourceDescriptor, sourceDescriptor);
  assert.deepEqual(result.queryData, {
    has_changes_since: false,
    limit: null,
    query_shape: "record_detail",
    requested_record_id: "rec_1",
  });
  assert.deepEqual(result.disclosureData, {
    has_more: false,
    has_next_changes_since: false,
    query_shape: "record_detail",
    record_count: 1,
    requested_record_id: "rec_1",
  });
  // Owner branch builds an owner read-grant scoped to the requested stream.
  assert.deepEqual(result.effectiveGrant, { streams: [{ name: "pay_statements" }] });
});

test("rs.records.get throws not_found when the dependency returns null", async () => {
  await assert.rejects(
    () =>
      executeRecordDetail(
        {
          actor: ownerActor,
          recordId: "missing",
          streamName: "pay_statements",
        },
        makeDeps({ getRecord: () => Promise.resolve(null) })
      ),
    (err) => {
      assert.ok(err instanceof RecordDetailVisibilityError);
      assert.equal(err.code, "not_found");
      assert.match(err.message, TOP_LEVEL_REGEX_1);
      assert.match(err.message, TOP_LEVEL_REGEX_2);
      return true;
    }
  );
});

test("rs.records.get does not call decorateRecord when the dependency returns null", async () => {
  let decorated = false;
  await assert.rejects(() =>
    executeRecordDetail(
      { actor: ownerActor, recordId: "missing", streamName: "pay_statements" },
      makeDeps({
        decorateRecord: (record) => {
          decorated = true;
          return record;
        },
        getRecord: () => Promise.resolve(null),
      })
    )
  );
  assert.equal(decorated, false);
});

test("rs.records.get applies decorateRecord to the returned record", async () => {
  const result = await executeRecordDetail(
    { actor: ownerActor, recordId: "rec_1", streamName: "pay_statements" },
    makeDeps({
      decorateRecord: (record) => ({ ...record, decorated: true }),
    })
  );
  assert.equal(result.record.decorated, true);
});

test("rs.records.get applies request projection after lower driver returns full payload", async () => {
  const result = await executeRecordDetail(
    {
      actor: ownerActor,
      expandOptions: { fields: ["id"] },
      recordId: "rec_1",
      streamName: "pay_statements",
    },
    makeDeps({
      getRecord: () =>
        Promise.resolve({
          data: {
            channel_id: "C1",
            id: "rec_1",
            text: "unrequested",
            ts: "123.456",
          },
          id: "rec_1",
          object: "record",
        }),
    })
  );

  assert.deepEqual(result.record.data, { id: "rec_1" });
});

class UnknownFieldError extends Error {
  code: string;
  constructor(message: string) {
    super(message);
    this.code = "unknown_field";
  }
}

test("rs.records.get validates requested fields before fetching the record", async () => {
  let observedParams: Record<string, unknown> | undefined;
  let observedStream: RecordDetailManifestStream | null | undefined;
  let fetched = false;

  await assert.rejects(
    () =>
      executeRecordDetail(
        {
          actor: ownerActor,
          expandOptions: { fields: ["definitely_not_a_field"] },
          recordId: "rec_1",
          streamName: "pay_statements",
        },
        makeDeps({
          getRecord: () => {
            fetched = true;
            return Promise.resolve({ id: "rec_1", object: "record" });
          },
          validateRequestFields: (params, stream) => {
            observedParams = params;
            observedStream = stream;
            throw new UnknownFieldError("Unknown field: definitely_not_a_field");
          },
        })
      ),
    (err) => {
      assert.ok(err instanceof UnknownFieldError);
      assert.equal(err.code, "unknown_field");
      assert.match(err.message, TOP_LEVEL_REGEX_3);
      return true;
    }
  );

  assert.ok(observedParams);
  assert.deepEqual(observedParams.fields, ["definitely_not_a_field"]);
  assert.equal(observedStream?.name, "pay_statements");
  assert.equal(fetched, false);
});

test("rs.records.get forwards expand options to the dependency", async () => {
  let observed: RecordDetailExpandOptions | undefined;
  await executeRecordDetail(
    {
      actor: ownerActor,
      expandOptions: { expand: "related_grants", expand_limit: "10" },
      recordId: "rec_1",
      streamName: "pay_statements",
    },
    makeDeps({
      getRecord: (_stream, _id, _grant, _manifest, options) => {
        observed = options;
        return Promise.resolve({ id: "rec_1", object: "record" });
      },
    })
  );
  assert.equal(observed?.expand, "related_grants");
  assert.equal(observed?.expand_limit, "10");
});

test("rs.records.get passes the manifest and grant to the dependency", async () => {
  const manifest = { streams: [{ extra: "value", name: "pay_statements" }] };
  let observedManifest: RecordDetailManifest | null = null;
  let observedGrant: RecordDetailGrant | null = null;
  await executeRecordDetail(
    { actor: clientActor, recordId: "rec_1", streamName: "pay_statements" },
    makeDeps({
      getGrant: () => ({ streams: [{ fields: ["id"], name: "pay_statements" }] }),
      getManifest: () => manifest,
      getRecord: (_stream, _id, grant, m) => {
        observedManifest = m;
        observedGrant = grant;
        return Promise.resolve({ id: "rec_1", object: "record" });
      },
    })
  );
  assert.deepEqual(observedManifest, manifest);
  assert.deepEqual(observedGrant, { streams: [{ fields: ["id"], name: "pay_statements" }] });
});

test("rs.records.get does not overwrite the grant for client actors", async () => {
  const result = await executeRecordDetail(
    { actor: clientActor, recordId: "rec_1", streamName: "pay_statements" },
    makeDeps({
      getGrant: () => ({ streams: [{ fields: ["employer"], name: "pay_statements" }] }),
    })
  );
  assert.deepEqual(result.effectiveGrant, {
    streams: [{ fields: ["employer"], name: "pay_statements" }],
  });
});

test("rs.records.get rejects client streams that are absent from the grant before fetching records", async () => {
  let fetched = false;
  await assert.rejects(
    () =>
      executeRecordDetail(
        { actor: clientActor, recordId: "rec_1", streamName: "gone" },
        makeDeps({
          getRecord: () => {
            fetched = true;
            return Promise.resolve({ id: "rec_1", object: "record" });
          },
        })
      ),
    (err) => {
      assert.ok(err instanceof RecordDetailVisibilityError);
      assert.equal(err.code, "grant_stream_not_allowed");
      assert.match(err.message, TOP_LEVEL_REGEX_4);
      return true;
    }
  );
  assert.equal(fetched, false);
});

test("rs.records.get awaits async dependency promises", async () => {
  let resolved = false;
  const result = await executeRecordDetail(
    { actor: ownerActor, recordId: "rec_1", streamName: "pay_statements" },
    makeDeps({
      getRecord: (stream, recordId) =>
        new Promise((r) =>
          setImmediate(() => {
            resolved = true;
            r({ id: recordId, object: "record", stream });
          })
        ),
    })
  );
  assert.equal(resolved, true);
  assert.equal(result.record.id, "rec_1");
});
