// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operation-level tests for `rs.schema.get`.
 *
 * Exercises the operation in isolation with stub dependencies, asserting
 * that:
 *   - the response is built from the dependency's connector items verbatim;
 *   - bearer projection is operation-owned and varies by actor kind;
 *   - the source descriptor flows from the dependency to the output (and
 *     `null` is preserved verbatim — this matches the historical native
 *     behavior for the owner-with-multiple-registered-connectors branch);
 *   - `query.received`-shaped data is `query_shape: 'schema'`;
 *   - aggregate counts (`connector_count`, `stream_count`) are derived
 *     from the dependency's connector items.
 *
 * These tests are the regression baseline for the operation's behavior.
 * Host-mounted parity is covered by `query-contract.test.js` (native) and
 * the sandbox `_demo/routes.test.ts` suite.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type {
  ConnectorSchemaItem,
  SchemaGetActor,
  SchemaGetSourceDescriptor,
} from "../operations/rs-schema-get/index.ts";
import { executeSchemaGet } from "../operations/rs-schema-get/index.ts";

const ownerActor: SchemaGetActor = { kind: "owner", subject_id: "subj_1" };
const clientActor: SchemaGetActor = {
  client_id: "client_x",
  grant_id: "grant_y",
  kind: "client",
  subject_id: "subj_1",
};

function makeConnectorItem(connectorId: string, streamCount: number): ConnectorSchemaItem {
  const streams: ConnectorSchemaItem["streams"] = [];
  for (let i = 0; i < streamCount; i += 1) {
    streams.push({ name: `${connectorId}_stream_${i}`, object: "stream_metadata" });
  }
  return {
    connector_id: connectorId,
    object: "connector",
    source: { id: connectorId, kind: "connector" },
    stream_count: streams.length,
    streams,
  };
}

test("rs.schema.get returns the dependency connector items verbatim under owner", async () => {
  const items = [makeConnectorItem("acme_payroll", 2), makeConnectorItem("quill_health", 1)];
  const sourceDescriptor: SchemaGetSourceDescriptor = { id: "pdpp.local", kind: "provider_native" };

  const result = await executeSchemaGet(
    { actor: ownerActor },
    {
      getSourceDescriptor: () => sourceDescriptor,
      listConnectorItems: () => Promise.resolve(items),
    }
  );

  assert.equal(result.response.object, "schema");
  assert.deepEqual(result.response.bearer, { scope: "owner", token_kind: "owner" });
  assert.equal(result.response.connectors, items, "connector items pass through verbatim");
  assert.deepEqual(result.sourceDescriptor, sourceDescriptor);
  assert.deepEqual(result.queryData, { query_shape: "schema" });
  assert.deepEqual(result.counts, { connector_count: 2, stream_count: 3 });
});

test("rs.schema.get projects client bearer with grant_id and client_id when present", async () => {
  const result = await executeSchemaGet(
    { actor: clientActor },
    {
      getSourceDescriptor: () => ({ id: "acme_payroll", kind: "connector" }),
      listConnectorItems: () => Promise.resolve([makeConnectorItem("acme_payroll", 1)]),
    }
  );

  assert.deepEqual(result.response.bearer, {
    client_id: "client_x",
    grant_id: "grant_y",
    scope: "grant",
    token_kind: "client",
  });
});

test("rs.schema.get omits grant_id/client_id from client bearer when null", async () => {
  const result = await executeSchemaGet(
    {
      actor: {
        client_id: null,
        grant_id: null,
        kind: "client",
        subject_id: null,
      },
    },
    {
      getSourceDescriptor: () => ({ id: "acme_payroll", kind: "connector" }),
      listConnectorItems: () => Promise.resolve([]),
    }
  );

  assert.deepEqual(result.response.bearer, { scope: "grant", token_kind: "client" });
  assert.equal("grant_id" in result.response.bearer, false);
  assert.equal("client_id" in result.response.bearer, false);
});

test("rs.schema.get propagates a null source descriptor verbatim (multi-connector owner branch)", async () => {
  const result = await executeSchemaGet(
    { actor: ownerActor },
    {
      getSourceDescriptor: () => null,
      listConnectorItems: () => Promise.resolve([makeConnectorItem("a", 1), makeConnectorItem("b", 0)]),
    }
  );

  assert.equal(result.sourceDescriptor, null);
  assert.deepEqual(result.counts, { connector_count: 2, stream_count: 1 });
});

test("rs.schema.get returns empty connector array unchanged", async () => {
  const result = await executeSchemaGet(
    { actor: ownerActor },
    {
      getSourceDescriptor: () => null,
      listConnectorItems: () => Promise.resolve([]),
    }
  );

  assert.deepEqual(result.response.connectors, []);
  assert.deepEqual(result.counts, { connector_count: 0, stream_count: 0 });
});

test("rs.schema.get awaits async dependency promises", async () => {
  let resolved = false;
  const result = await executeSchemaGet(
    { actor: ownerActor },
    {
      getSourceDescriptor: () => ({ id: "c", kind: "connector" }),
      listConnectorItems: () =>
        new Promise((r) =>
          setImmediate(() => {
            resolved = true;
            r([makeConnectorItem("c", 1)]);
          })
        ),
    }
  );

  assert.equal(resolved, true);
  assert.equal(result.response.connectors.length, 1);
});

test("rs.schema.get derives stream_count from connector items, not from the response shape", async () => {
  // The aggregate stream_count must follow `stream_count` on each connector
  // item rather than `streams.length`. The two are equal in the natural
  // case, but the operation contract relies on `stream_count` because the
  // native item builder may project a `streams` array that excludes
  // ungranted streams while keeping `stream_count` honest.
  const result = await executeSchemaGet(
    { actor: ownerActor },
    {
      getSourceDescriptor: () => null,
      listConnectorItems: () =>
        Promise.resolve([
          {
            connector_id: "x",
            object: "connector",
            source: { id: "x", kind: "connector" },
            stream_count: 5,
            streams: [], // intentionally inconsistent: count is the source of truth
          },
        ]),
    }
  );

  assert.equal(result.counts.stream_count, 5);
});
