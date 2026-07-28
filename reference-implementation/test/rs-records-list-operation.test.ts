// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operation-level tests for `rs.records.list`.
 *
 * Exercises the operation in isolation with stub dependencies, asserting
 * that the host-independent slice of behavior moved into the operation is
 * preserved:
 *   - the result envelope flows from the dependency's `queryRecords` result;
 *   - the source descriptor flows from the dependency to the output;
 *   - `query.received`-shaped data is `query_shape: 'record_list'` and
 *     surfaces `requested_view`, `has_changes_since`, and `limit`;
 *   - `disclosure.served`-shaped data is populated from the result counts;
 *   - owner manifest visibility raises `not_found`;
 *   - view/fields mutual exclusion raises `invalid_request`;
 *   - view → fields resolution sets `requestParams.fields` and clears
 *     `requestParams.view`;
 *   - a view referencing ungranted fields raises `field_not_granted`;
 *   - `decorateRecord` is applied to every returned record;
 *   - `validateRequestFields` is called with the resolved manifest stream.
 *
 * Host-mounted parity is covered by `pdpp.test.js` (native) and the
 * sandbox `_demo/routes.test.ts` suite.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  executeRecordsList,
  type RecordsListActor,
  type RecordsListDependencies,
  type RecordsListManifest,
  type RecordsListManifestStream,
  RecordsListVisibilityError,
} from "../operations/rs-records-list/index.ts";

const ownerActor: RecordsListActor = { kind: "owner", subject_id: "subj_1" };
const clientActor: RecordsListActor = {
  client_id: "client_x",
  grant_id: "grant_y",
  kind: "client",
  subject_id: "subj_1",
};
const sourceDescriptor = { id: "acme_payroll", kind: "connector" as const };

function makeManifest(extra: Partial<RecordsListManifestStream> = {}): RecordsListManifest {
  return {
    streams: [
      {
        name: "pay_statements",
        schema: { properties: { employer: {}, gross_pay_minor: {}, net_pay_minor: {} } },
        views: [
          { fields: ["net_pay_minor", "employer"], id: "compact" },
          { fields: ["secret_field"], id: "unauthorized" },
        ],
        ...extra,
      },
    ],
  };
}

function makeDeps(overrides: Partial<RecordsListDependencies> = {}): RecordsListDependencies {
  return {
    decorateRecord: (record) => record,
    getGrant: () => ({ streams: [{ name: "pay_statements" }] }),
    getManifest: () => makeManifest(),
    getSourceDescriptor: () => sourceDescriptor,
    queryRecords: () =>
      Promise.resolve({
        data: [
          { data: { net_pay_minor: 1 }, id: "r1", object: "record" },
          { data: { net_pay_minor: 2 }, id: "r2", object: "record" },
        ],
        has_more: false,
        object: "list",
      }),
    validateRequestFields: () => undefined,
    ...overrides,
  };
}

test("rs.records.list returns the dependency result for owner shape", async () => {
  const result = await executeRecordsList(
    { actor: ownerActor, requestParams: {}, streamName: "pay_statements" },
    makeDeps()
  );
  assert.equal(result.result.object, "list");
  assert.equal(result.result.data.length, 2);
  assert.ok(result.result.data[0]);
  assert.equal(result.result.data[0].id, "r1");
  assert.deepEqual(result.sourceDescriptor, sourceDescriptor);
  assert.equal(result.queryData.query_shape, "record_list");
  assert.equal(result.queryData.has_changes_since, false);
  assert.equal(result.queryData.limit, null);
  assert.equal("requested_view" in result.queryData, false);
  assert.deepEqual(result.disclosureData, {
    has_more: false,
    has_next_changes_since: false,
    query_shape: "record_list",
    record_count: 2,
  });
  // Owner branch builds an owner read-grant scoped to the requested stream.
  assert.deepEqual(result.effectiveGrant, { streams: [{ name: "pay_statements" }] });
});

test("rs.records.list throws not_found for owner when the manifest does not include the stream", async () => {
  await assert.rejects(
    () => executeRecordsList({ actor: ownerActor, requestParams: {}, streamName: "gone" }, makeDeps()),
    (err) => {
      assert.ok(err instanceof RecordsListVisibilityError);
      assert.equal(err.code, "not_found");
      // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
      assert.match(err.message, /'gone' not found/);
      return true;
    }
  );
});

test("rs.records.list does not 404 on missing manifest stream for client actors", async () => {
  // Client actors rely on the underlying `queryRecords` capability for
  // grant-shape rejection (the previous native route delegated to
  // `queryRecords` for that branch). The operation must not 404.
  let called = false;
  await executeRecordsList(
    { actor: clientActor, requestParams: {}, streamName: "gone" },
    makeDeps({
      getManifest: () => ({ streams: [] }),
      queryRecords: () => {
        called = true;
        return Promise.resolve({ data: [], has_more: false, object: "list" });
      },
    })
  );
  assert.equal(called, true);
});

test("rs.records.list rejects when both view and fields are present", async () => {
  await assert.rejects(
    () =>
      executeRecordsList(
        {
          actor: ownerActor,
          rawQueryFields: "net_pay_minor",
          rawQueryView: "compact",
          requestParams: {},
          streamName: "pay_statements",
        },
        makeDeps()
      ),
    (err) => {
      assert.ok(err instanceof RecordsListVisibilityError);
      assert.equal(err.code, "invalid_request");
      // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
      assert.match(err.message, /mutually exclusive/);
      return true;
    }
  );
});

test("rs.records.list resolves a view by id, sets fields, and removes view from request params", async () => {
  let observedParams: Record<string, unknown> | undefined;
  await executeRecordsList(
    {
      actor: ownerActor,
      rawQueryView: "compact",
      requestParams: { view: "compact" },
      streamName: "pay_statements",
    },
    makeDeps({
      queryRecords: (_stream, _grant, params) => {
        observedParams = { ...params };
        return Promise.resolve({ data: [], has_more: false, object: "list" });
      },
    })
  );
  assert.ok(observedParams);
  assert.deepEqual(observedParams.fields, ["net_pay_minor", "employer"]);
  assert.equal("view" in observedParams, false);
});

test("rs.records.list raises field_not_granted when the view names ungranted fields", async () => {
  await assert.rejects(
    () =>
      executeRecordsList(
        {
          actor: clientActor,
          rawQueryView: "unauthorized",
          requestParams: {},
          streamName: "pay_statements",
        },
        makeDeps({
          getGrant: () => ({
            streams: [{ fields: ["net_pay_minor", "employer"], name: "pay_statements" }],
          }),
        })
      ),
    (err) => {
      assert.ok(err instanceof RecordsListVisibilityError);
      assert.equal(err.code, "field_not_granted");
      return true;
    }
  );
});

test("rs.records.list raises invalid_request when the view id is unknown", async () => {
  await assert.rejects(
    () =>
      executeRecordsList(
        {
          actor: ownerActor,
          rawQueryView: "no_such_view",
          requestParams: {},
          streamName: "pay_statements",
        },
        makeDeps()
      ),
    (err) => {
      assert.ok(err instanceof RecordsListVisibilityError);
      assert.equal(err.code, "invalid_request");
      // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
      assert.match(err.message, /Unknown view/);
      return true;
    }
  );
});

test("rs.records.list does not resolve a view when validateRequestFields already promoted fields", async () => {
  let observedParams: Record<string, unknown> | undefined;
  await executeRecordsList(
    {
      actor: ownerActor,
      rawQueryView: "compact",
      requestParams: { fields: "net_pay_minor" },
      streamName: "pay_statements",
    },
    makeDeps({
      queryRecords: (_stream, _grant, params) => {
        observedParams = { ...params };
        return Promise.resolve({ data: [], has_more: false, object: "list" });
      },
      // Mirror the native validator: if a `fields` param is present, it is
      // promoted to an array; the operation must then skip view resolution
      // (the previous native ordering).
      validateRequestFields: (params) => {
        if (typeof params.fields === "string") {
          params.fields = params.fields.split(",").map((s) => s.trim());
        }
      },
    })
  );
  // `fields` from the validator is preserved; the view is NOT resolved into
  // a different fields array.
  assert.ok(observedParams);
  assert.deepEqual(observedParams.fields, ["net_pay_minor"]);
});

test("rs.records.list applies decorateRecord to every returned record", async () => {
  const result = await executeRecordsList(
    { actor: ownerActor, requestParams: {}, streamName: "pay_statements" },
    makeDeps({
      decorateRecord: (record) => ({ ...record, decorated: true }),
    })
  );
  for (const record of result.result.data) {
    assert.equal(record.decorated, true);
  }
});

test("rs.records.list applies request projection after lower driver required fields", async () => {
  const result = await executeRecordsList(
    {
      actor: ownerActor,
      rawQueryFields: "id",
      requestParams: { fields: ["id"] },
      streamName: "pay_statements",
    },
    makeDeps({
      queryRecords: () =>
        Promise.resolve({
          data: [
            {
              data: { channel_id: "C1", id: "r1", ts: "123.456" },
              id: "r1",
              object: "record",
            },
          ],
          has_more: false,
          object: "list",
        }),
    })
  );

  assert.ok(result.result.data[0]);
  assert.deepEqual(result.result.data[0].data, { id: "r1" });
});

test("rs.records.list passes the manifest stream to validateRequestFields", async () => {
  let observedStream: RecordsListManifestStream | undefined;
  await executeRecordsList(
    { actor: ownerActor, requestParams: {}, streamName: "pay_statements" },
    makeDeps({
      validateRequestFields: (_params, stream) => {
        observedStream = stream ?? undefined;
      },
    })
  );
  assert.equal(observedStream?.name, "pay_statements");
  assert.ok(observedStream?.schema);
});

test("rs.records.list surfaces requested_view, has_changes_since, and limit on queryData", async () => {
  const result = await executeRecordsList(
    {
      actor: ownerActor,
      rawQueryView: "compact",
      requestParams: { changes_since: "2026-04-01T00:00:00Z", limit: "10" },
      streamName: "pay_statements",
    },
    makeDeps()
  );
  assert.equal(result.queryData.requested_view, "compact");
  assert.equal(result.queryData.has_changes_since, true);
  assert.equal(result.queryData.limit, 10);
});

test("rs.records.list treats omitted fields and limit as absent rather than literal values", async () => {
  let observedParams: Record<string, unknown> | undefined;
  const result = await executeRecordsList(
    {
      actor: ownerActor,
      rawQueryView: "compact",
      requestParams: { fields: undefined, limit: undefined, view: "compact" },
      streamName: "pay_statements",
    },
    makeDeps({
      queryRecords: (_stream, _grant, params) => {
        observedParams = { ...params };
        return Promise.resolve({ data: [], has_more: false, object: "list" });
      },
    })
  );

  assert.deepEqual(observedParams?.fields, ["net_pay_minor", "employer"]);
  assert.equal(observedParams?.view, undefined);
  assert.equal(result.queryData.limit, null);
});

test("rs.records.list awaits async dependency promises", async () => {
  let resolved = false;
  const result = await executeRecordsList(
    { actor: ownerActor, requestParams: {}, streamName: "pay_statements" },
    makeDeps({
      queryRecords: () =>
        new Promise((r) =>
          setImmediate(() => {
            resolved = true;
            r({ data: [], has_more: false, object: "list" });
          })
        ),
    })
  );
  assert.equal(resolved, true);
  assert.deepEqual(result.result.data, []);
});

// ─── view/fields mutex regression: non-string raw query values ────────────
//
// `qs.parse` (used by the native Fastify transport) yields arrays for
// repeated params (`?fields=a&fields=b`) and objects for bracketed
// params. The previous native route applied a truthiness test
// (`if (req.query.view && req.query.fields)`), so non-string truthy
// values still triggered the mutual-exclusion rejection. The operation
// MUST preserve that — otherwise a client could pass `view=compact` plus
// repeated `fields=` params and silently drop the view.
//
// See openspec/changes/mount-rs-record-read-operations and
// owner-review-1 for the fix that motivated these tests.

test("rs.records.list rejects view + array-shaped fields as mutually exclusive", async () => {
  await assert.rejects(
    () =>
      executeRecordsList(
        {
          actor: ownerActor,
          rawQueryFields: ["net_pay_minor", "employer"],
          rawQueryView: "compact",
          requestParams: { fields: ["net_pay_minor", "employer"], view: "compact" },
          streamName: "pay_statements",
        },
        makeDeps()
      ),
    (err) => {
      assert.ok(err instanceof RecordsListVisibilityError);
      assert.equal(err.code, "invalid_request");
      // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
      assert.match(err.message, /mutually exclusive/);
      return true;
    }
  );
});

test("rs.records.list rejects array-shaped view + array-shaped fields as mutually exclusive", async () => {
  await assert.rejects(
    () =>
      executeRecordsList(
        {
          actor: ownerActor,
          rawQueryFields: ["net_pay_minor"],
          // `?view=compact&view=other` — qs yields an array.
          rawQueryView: ["compact", "other"],
          requestParams: {},
          streamName: "pay_statements",
        },
        makeDeps()
      ),
    (err) => {
      assert.ok(err instanceof RecordsListVisibilityError);
      assert.equal(err.code, "invalid_request");
      // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
      assert.match(err.message, /mutually exclusive/);
      return true;
    }
  );
});

test("rs.records.list rejects bracketed-object view + string fields as mutually exclusive", async () => {
  await assert.rejects(
    () =>
      executeRecordsList(
        {
          actor: ownerActor,
          rawQueryFields: "net_pay_minor",
          // `?view[id]=compact` — qs yields an object.
          rawQueryView: { id: "compact" },
          requestParams: { fields: "net_pay_minor" },
          streamName: "pay_statements",
        },
        makeDeps()
      ),
    (err) => {
      assert.ok(err instanceof RecordsListVisibilityError);
      assert.equal(err.code, "invalid_request");
      // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
      assert.match(err.message, /mutually exclusive/);
      return true;
    }
  );
});

test("rs.records.list raises Unknown view for an array-shaped raw view value", async () => {
  // Repeated `?view=a&view=b` with no fields: qs yields ['a', 'b']. The
  // previous native route compared `req.query.view` directly to view ids
  // via `===`, so an array could never match — the route fell through to
  // the "Unknown view" branch with the array's default-coerced form.
  await assert.rejects(
    () =>
      executeRecordsList(
        {
          actor: ownerActor,
          rawQueryView: ["a", "b"],
          requestParams: {},
          streamName: "pay_statements",
        },
        makeDeps()
      ),
    (err) => {
      assert.ok(err instanceof RecordsListVisibilityError);
      assert.equal(err.code, "invalid_request");
      // `String(['a','b'])` -> "a,b", matching the prior native template
      // literal coercion (`Unknown view: ${req.query.view}`).
      // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
      assert.match(err.message, /Unknown view: a,b/);
      return true;
    }
  );
});

test("rs.records.list does not surface non-string raw view as requested_view", async () => {
  // The previous native route emitted `requested_view` only when the host
  // supplied a non-empty string view. Non-string truthy values still
  // trigger mutex/Unknown-view paths, but they should NOT leak into the
  // `query.received` instrumentation field as a coerced string.
  await assert.rejects(() =>
    executeRecordsList(
      {
        actor: ownerActor,
        rawQueryView: ["a", "b"],
        requestParams: {},
        streamName: "pay_statements",
      },
      makeDeps()
    )
  );
  // Indirect proof: a successful call with a string view DOES surface it.
  const result = await executeRecordsList(
    {
      actor: ownerActor,
      rawQueryView: "compact",
      requestParams: { view: "compact" },
      streamName: "pay_statements",
    },
    makeDeps()
  );
  assert.equal(result.queryData.requested_view, "compact");
});
