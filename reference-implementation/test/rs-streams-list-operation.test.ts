// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operation-level tests for `rs.streams.list`.
 *
 * Exercises the operation in isolation with stub dependencies, asserting
 * that:
 *   - the response is built from the dependency's stream summaries verbatim;
 *   - the source descriptor flows from the dependency to the output;
 *   - `query.received`-shaped data populates `query_shape: 'stream_list'`;
 *   - client actors propagate `stream_count_limit` for instrumentation;
 *   - owner actors do NOT introduce a `stream_count_limit` field.
 *
 * These tests serve as the regression baseline for the operation's
 * behavior. Host-mounted parity is covered by the existing `pdpp.test.js`
 * (native) and `apps/site/.../routes.test.ts` (sandbox) suites.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  executeStreamsList,
  type StreamSummary,
  type StreamsListSourceDescriptor,
} from "../operations/rs-streams-list/index.ts";

test("rs.streams.list returns the dependency summaries unchanged", async () => {
  const summaries: StreamSummary[] = [
    { last_updated: "2026-03-31T00:00:00Z", name: "pay_statements", object: "stream", record_count: 3 },
    { last_updated: null, name: "equity_grants", object: "stream", record_count: 0 },
  ];
  const sourceDescriptor: StreamsListSourceDescriptor = { id: "acme_payroll", kind: "connector" };

  const result = await executeStreamsList(
    { actor: { kind: "owner", subject_id: "subj_1" } },
    {
      getSourceDescriptor: () => sourceDescriptor,
      listSummaries: () => Promise.resolve(summaries),
    }
  );

  assert.deepEqual(result.streams, summaries);
  assert.deepEqual(result.sourceDescriptor, sourceDescriptor);
  assert.deepEqual(result.queryData, { query_shape: "stream_list" });
});

test("rs.streams.list propagates client stream_count_limit to queryData", async () => {
  const result = await executeStreamsList(
    {
      actor: {
        client_id: "client_x",
        grant_id: "grant_y",
        kind: "client",
        stream_count_limit: 2,
        subject_id: "subj_1",
      },
    },
    {
      getSourceDescriptor: () => ({ id: "c", kind: "connector" }),
      listSummaries: () => Promise.resolve([]),
    }
  );

  assert.equal(result.queryData.query_shape, "stream_list");
  assert.equal(result.queryData.stream_count_limit, 2);
});

test("rs.streams.list owner queryData has no stream_count_limit key", async () => {
  const result = await executeStreamsList(
    { actor: { kind: "owner", subject_id: "s" } },
    {
      getSourceDescriptor: () => ({ id: "p", kind: "provider_native" }),
      listSummaries: () => Promise.resolve([]),
    }
  );

  assert.equal("stream_count_limit" in result.queryData, false);
});

test("rs.streams.list propagates a null stream_count_limit when grant.streams is absent", async () => {
  const result = await executeStreamsList(
    {
      actor: {
        client_id: "c",
        grant_id: "g",
        kind: "client",
        stream_count_limit: null,
        subject_id: "s",
      },
    },
    {
      getSourceDescriptor: () => ({ id: "c", kind: "connector" }),
      listSummaries: () => Promise.resolve([]),
    }
  );

  assert.equal(result.queryData.stream_count_limit, null);
});

test("rs.streams.list preserves connection identity fields populated by the host adapter", async () => {
  // Multi-connection deployments emit one summary per (stream, connection_id).
  // The operation does not invent or transform identity — it just preserves
  // whatever the host adapter's listSummaries() returns, so callers can
  // attribute and disambiguate. Owned by
  //   openspec/changes/expose-connection-identity-on-public-read.
  const summaries: StreamSummary[] = [
    {
      connection_id: "cin_aaa",
      connector_instance_id: "cin_aaa",
      display_name: "laptop Amazon",
      last_updated: "2026-05-01T12:00:00Z",
      name: "orders",
      object: "stream",
      record_count: 12,
    },
    {
      connection_id: "cin_bbb",
      connector_instance_id: "cin_bbb",
      display_name: "example org Amazon",
      last_updated: "2026-05-22T08:00:00Z",
      name: "orders",
      object: "stream",
      record_count: 7,
    },
  ];

  const result = await executeStreamsList(
    { actor: { kind: "owner", subject_id: "subj_1" } },
    {
      getSourceDescriptor: () => ({ id: "amazon", kind: "connector" }),
      listSummaries: () => Promise.resolve(summaries),
    }
  );

  assert.deepEqual(result.streams, summaries);
  const labels = result.streams.map((entry) => entry.display_name);
  assert.deepEqual(labels, ["laptop Amazon", "example org Amazon"]);
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  const placeholderPattern = /^legacy$|^default_account$|legacy \(pre-header\)/;
  for (const entry of result.streams) {
    if (!entry.display_name) {
      throw new Error("expected every entry in this fixture to carry a display_name");
    }
    assert.equal(
      placeholderPattern.test(entry.display_name),
      false,
      `display_name must not be a storage placeholder, got ${entry.display_name}`
    );
  }
});

test("rs.streams.list supports owner-wide catalogs with no single source descriptor", async () => {
  const summaries: StreamSummary[] = [
    {
      connector_id: "gmail",
      last_updated: "2026-05-31T00:00:00Z",
      name: "attachments",
      object: "stream",
      record_count: 1,
      source: { id: "gmail", kind: "connector" },
    },
  ];

  const result = await executeStreamsList(
    { actor: { kind: "owner", subject_id: "owner_1" } },
    {
      getSourceDescriptor: () => null,
      listSummaries: () => Promise.resolve(summaries),
    }
  );

  assert.equal(result.sourceDescriptor, null);
  assert.deepEqual(result.streams, summaries);
});

test("rs.streams.list accepts an optional connection_id input without altering passthrough semantics", async () => {
  // The operation does not enforce the filter — that lives in the host
  // adapter's `listSummaries` wiring. But the field MUST flow through
  // without breaking existing callers that omit it.
  const captured = { passes: 0 };
  const summaries: StreamSummary[] = [
    {
      connection_id: "cin_aaa",
      display_name: "laptop Amazon",
      last_updated: null,
      name: "orders",
      object: "stream",
      record_count: 3,
    },
  ];

  const omitted = await executeStreamsList(
    { actor: { kind: "owner", subject_id: "subj_1" } },
    {
      getSourceDescriptor: () => ({ id: "amazon", kind: "connector" }),
      listSummaries: () => {
        captured.passes += 1;
        return Promise.resolve(summaries);
      },
    }
  );
  const filtered = await executeStreamsList(
    { actor: { kind: "owner", subject_id: "subj_1" }, connection_id: "cin_aaa" },
    {
      getSourceDescriptor: () => ({ id: "amazon", kind: "connector" }),
      listSummaries: () => {
        captured.passes += 1;
        return Promise.resolve(summaries);
      },
    }
  );

  assert.equal(captured.passes, 2);
  assert.deepEqual(omitted.streams, summaries);
  assert.deepEqual(filtered.streams, summaries);
});

test("rs.streams.list awaits dependency promises", async () => {
  let resolved = false;
  const result = await executeStreamsList(
    { actor: { kind: "owner", subject_id: null } },
    {
      getSourceDescriptor: () => ({ id: "x", kind: "connector" }),
      listSummaries: () =>
        new Promise((r) =>
          setImmediate(() => {
            resolved = true;
            r([]);
          })
        ),
    }
  );

  assert.equal(resolved, true);
  assert.deepEqual(result.streams, []);
});
