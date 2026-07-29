// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createPdppMcpServer } from "../src/server.ts";

// Live external MCP testing exposed an agent-usability failure: MCP advertised
// `filter` as a string, so agents sent JSON or `filter[user_id]=...` strings
// that became a bare REST `filter=` param the RS silently ignored
// (query_records) or rejected (aggregate). REST itself is correct — its
// `qs.parse(filter[field][op]=value)` decodes the canonical bracket shape.
// This suite pins the MCP-layer fix: MCP accepts a JSON-native typed filter
// object, encodes it into `filter[field]=value` / `filter[field][op]=value`,
// and rejects every string filter before it can reach REST.
const FILTER = /^filter\[([^\]]+)\](?:\[([^\]]+)\])?$/;
const GTE = /gte/;
const VALIDATION_OBJECT_STRING_INVALID = /validation|object|string|invalid/i;
const VALIDATION_UNRECOGNIZED_BETWEEN_INVALID = /validation|unrecognized|between|invalid/i;
const COUNT = /count/;
const MESSAGES = /messages/;
const B_B = /\b7\b/;
const GROUP_BY = /group_by=/;
const U = /U123/;
const B_B_2 = /\b4\b/;
const RESULT_HIT = /1|result|hit/i;
const ID_MESSAGES_M = /id=messages:m1/;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type DecodedFilterValue = Record<string, string> | string;

// Decode the `filter[field]` / `filter[field][op]` bracket params the RS
// receives back into the nested object the RS's `qs.parse` would build, so the
// test asserts on the structure the resource server actually consumes.
function decodeFilterParams(searchParams: URLSearchParams): Record<string, DecodedFilterValue> {
  const filter: Record<string, DecodedFilterValue> = {};
  for (const [key, value] of searchParams.entries()) {
    const match = FILTER.exec(key);
    if (!match) {
      continue;
    }
    const [, field, op] = match;
    if (!field) {
      continue;
    }
    if (op) {
      const existing = filter[field];
      const bucket: Record<string, string> = existing && typeof existing === "object" ? existing : {};
      bucket[op] = value;
      filter[field] = bucket;
    } else {
      filter[field] = value;
    }
  }
  return filter;
}

interface FetchCall {
  filter: Record<string, DecodedFilterValue>;
  method: string;
  searchParams: URLSearchParams;
  url: string;
}

function recordingFetch() {
  const calls: FetchCall[] = [];
  // biome-ignore lint/suspicious/useAwait: async required to satisfy the Promise<Response>-returning fetch/getJson contract this fixture implements; a synchronous return type is not assignable to the caller's injected dependency.
  const fetch = async (urlInput: string | Request | URL, init: RequestInit = {}) => {
    const url = new URL(urlInput.toString());
    const filter = decodeFilterParams(url.searchParams);
    calls.push({ url: url.toString(), method: init.method ?? "GET", filter, searchParams: url.searchParams });

    if (url.pathname === "/v1/streams/messages/records") {
      // Echo a row only when the canonical user_id exact filter arrived; a
      // bare `filter=` param (the old bug) or a wrong value yields zero rows.
      const wantUser = filter.user_id;
      const rows = wantUser === "U123" ? [{ id: "m1", user_id: "U123", text: "hi" }] : [];
      return jsonResponse({ records: rows, has_more: false });
    }
    if (url.pathname === "/v1/streams/messages/aggregate") {
      const metric = url.searchParams.get("metric");
      const groupBy = url.searchParams.get("group_by");
      if (groupBy) {
        return jsonResponse({
          object: "aggregation",
          stream: "messages",
          metric,
          group_by: groupBy,
          approximate: false,
          filtered_record_count: 7,
          limit: 100,
          groups: [
            { key: "U123", count: 4 },
            { key: "U999", count: 3 },
          ],
        });
      }
      // Ungrouped scalar count, scoped by the forwarded filter.
      const value = filter.user_id === "U123" ? 4 : 7;
      return jsonResponse({
        object: "aggregation",
        stream: "messages",
        metric: metric ?? "count",
        field: url.searchParams.get("field"),
        approximate: false,
        filtered_record_count: value,
        value,
      });
    }
    if (url.pathname === "/v1/search") {
      return jsonResponse({ hits: [{ id: "messages:m1", title: "hi" }] });
    }
    return jsonResponse({ error: { type: "not_found", code: "not_found" } }, 404);
  };
  return { fetch, calls };
}

async function connectClient(fakeFetch: typeof fetch) {
  const { server } = createPdppMcpServer({
    providerUrl: "https://provider.test",
    accessToken: "scoped-token",
    fetch: fakeFetch,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "typed-filter-test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

function resultText(result: { [key: string]: unknown; content?: readonly unknown[] }): string {
  const content = (result.content ?? []) as Array<{ text?: string }>;
  return content.map((c) => c.text ?? "").join("\n");
}

test("tools/list advertises filter as a typed object record on query_records, aggregate, and search", async () => {
  const { fetch } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const { tools } = await client.listTools();
  for (const name of ["query_records", "aggregate", "search"]) {
    const tool = tools.find((entry) => entry.name === name);
    assert.ok(tool, `${name} tool must be registered`);
    const filterSchema = tool.inputSchema.properties?.filter as
      | { additionalProperties?: unknown; anyOf?: unknown; oneOf?: unknown; type?: string }
      | undefined;
    assert.ok(filterSchema, `${name} must have a filter property`);
    assert.equal(filterSchema.type, "object", `${name}.filter must advertise an object, not only a string`);
    assert.ok(filterSchema.additionalProperties, `${name}.filter must advertise record values`);
    assert.equal(filterSchema.anyOf, undefined, `${name}.filter must not be a top-level object/string union`);
    assert.equal(filterSchema.oneOf, undefined, `${name}.filter must not be a top-level object/string union`);
    assert.match(
      JSON.stringify(filterSchema.additionalProperties),
      GTE,
      `${name}.filter record values must include range operator objects`
    );
  }

  await client.close();
  await server.close();
});

test("query_records typed exact filter forwards as filter[field]=value and narrows results", async () => {
  const { fetch, calls } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: "query_records",
    arguments: { stream: "messages", filter: { user_id: "U123" } },
  });
  assert.equal(result.isError, undefined);

  const call = calls.find((c) => c.url.includes("/v1/streams/messages/records"));
  assert.ok(call, "expected a matching call to RS");
  assert.equal(call.searchParams.get("filter[user_id]"), "U123", "must forward bracketed exact filter");
  assert.equal(call.searchParams.get("filter"), null, "must NOT forward a bare filter= param");
  assert.deepEqual(call.filter, { user_id: "U123" });
  const structuredContent = result.structuredContent as { data: { records: unknown[] } };
  assert.equal(structuredContent.data.records.length, 1, "narrowed to the matching row");

  await client.close();
  await server.close();
});

test("query_records typed range filter forwards as filter[field][op]=value", async () => {
  const { fetch, calls } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  await client.callTool({
    name: "query_records",
    arguments: {
      stream: "messages",
      filter: { created_at: { gte: "2026-01-01T00:00:00Z", lt: "2026-02-01T00:00:00Z" } },
    },
  });

  const call = calls.find((c) => c.url.includes("/v1/streams/messages/records"));
  assert.ok(call, "expected a matching call to RS");
  assert.equal(call.searchParams.get("filter[created_at][gte]"), "2026-01-01T00:00:00Z");
  assert.equal(call.searchParams.get("filter[created_at][lt]"), "2026-02-01T00:00:00Z");
  assert.deepEqual(call.filter, {
    created_at: { gte: "2026-01-01T00:00:00Z", lt: "2026-02-01T00:00:00Z" },
  });

  await client.close();
  await server.close();
});

test("query_records rejects string filters at MCP validation and never reaches REST", async () => {
  const { fetch, calls } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  for (const filter of ["filter[user_id]=U123", "user_id=U123", "amount>100", '{"user_id":"U123"}', ""]) {
    // biome-ignore lint/performance/noAwaitInLoops: calls share one already-connected client/fake-RS across cases and must run in order to keep the stateful fixture's call recording and assertions deterministic; Promise.all would race the shared state.
    const result = await client.callTool({
      name: "query_records",
      arguments: { stream: "messages", filter },
    });
    assert.equal(result.isError, true, `string filter ${JSON.stringify(filter)} must be rejected`);
    assert.match(resultText(result), VALIDATION_OBJECT_STRING_INVALID);
  }
  assert.equal(calls.length, 0, "string filters must be rejected before any REST request");

  await client.close();
  await server.close();
});

test("aggregate and search reject string filters at MCP validation and never reach REST", async () => {
  const { fetch, calls } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const aggregate = await client.callTool({
    name: "aggregate",
    arguments: { stream: "messages", metric: "count", filter: "filter[user_id]=U123" },
  });
  assert.equal(aggregate.isError, true);
  assert.match(resultText(aggregate), VALIDATION_OBJECT_STRING_INVALID);

  const search = await client.callTool({
    name: "search",
    arguments: { q: "hi", filter: "filter[user_id]=U123" },
  });
  assert.equal(search.isError, true);
  assert.match(resultText(search), VALIDATION_OBJECT_STRING_INVALID);
  assert.equal(calls.length, 0, "string filters must be rejected before any REST request");

  await client.close();
  await server.close();
});

test("query_records rejects empty/no-op filter shapes instead of silently dropping them", async () => {
  const { fetch, calls } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  for (const filter of ["", "   ", {}, { "filter[user_id]": "U123" }]) {
    // biome-ignore lint/performance/noAwaitInLoops: calls share one already-connected client/fake-RS across cases and must run in order to keep the stateful fixture's call recording and assertions deterministic; Promise.all would race the shared state.
    const result = await client.callTool({
      name: "query_records",
      arguments: { stream: "messages", filter },
    });
    assert.equal(result.isError, true, `filter ${JSON.stringify(filter)} must be rejected, not silently ignored`);
  }

  assert.equal(
    calls.some((c) => c.searchParams.get("filter") !== null || c.searchParams.get("filter[user_id]") !== null),
    false,
    "empty or pre-encoded typed filters must not reach the RS as query params"
  );

  await client.close();
  await server.close();
});

test("query_records rejects an unsupported range operator with an actionable error", async () => {
  const { fetch } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: "query_records",
    arguments: { stream: "messages", filter: { amount: { between: 5 } } },
  });
  assert.equal(result.isError, true);
  // `between` is not a key of the strict typed range object, so the MCP SDK
  // rejects it at the input boundary before the handler runs (an input-
  // validation error result, not a handler `structuredContent.error`). Either
  // way the agent gets a typed, actionable rejection rather than a silent
  // forward of an unsupported operator.
  assert.match(
    resultText(result),
    VALIDATION_UNRECOGNIZED_BETWEEN_INVALID,
    "must surface an input-validation rejection"
  );

  await client.close();
  await server.close();
});

test("aggregate typed filter forwards as bracket params and scopes the count", async () => {
  const { fetch, calls } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: "aggregate",
    arguments: { stream: "messages", metric: "count", filter: { user_id: "U123" } },
  });
  assert.equal(result.isError, undefined);

  const call = calls.find((c) => c.url.includes("/v1/streams/messages/aggregate"));
  assert.ok(call, "expected a matching call to RS");
  assert.equal(call.searchParams.get("filter[user_id]"), "U123");
  assert.equal(call.searchParams.get("filter"), null);
  const structuredContent = result.structuredContent as { data: { value: number } };
  assert.equal(structuredContent.data.value, 4, "count scoped by the forwarded filter");

  await client.close();
  await server.close();
});

test("aggregate text content includes the metric, stream, and numeric result (not only structuredContent)", async () => {
  const { fetch } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: "aggregate",
    arguments: { stream: "messages", metric: "count" },
  });
  assert.equal(result.isError, undefined);
  const text = resultText(result);
  assert.match(text, COUNT, "text must name the metric");
  assert.match(text, MESSAGES, "text must name the stream");
  assert.match(text, B_B, "text must include the numeric aggregate result");
  // Compact, not a full JSON dump.
  assert.ok(text.length < 400, `aggregate text must stay compact, got ${text.length} chars`);
  // Canonical envelope still validates and carries the value.
  const structuredContent = result.structuredContent as { data: { value: number } };
  assert.equal(structuredContent.data.value, 7);

  await client.close();
  await server.close();
});

test("aggregate grouped result previews buckets with counts in text", async () => {
  const { fetch } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: "aggregate",
    arguments: { stream: "messages", metric: "count", group_by: "user_id" },
  });
  assert.equal(result.isError, undefined);
  const text = resultText(result);
  assert.match(text, GROUP_BY, "text must name the grouping dimension");
  assert.match(text, U, "text must preview a bucket key");
  assert.match(text, B_B_2, "text must preview a bucket count");
  const structuredContent = result.structuredContent as { data: { groups: unknown[] } };
  assert.equal(structuredContent.data.groups.length, 2);

  await client.close();
  await server.close();
});

test("search typed filter forwards as bracket params (same fix as query_records)", async () => {
  const { fetch, calls } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: "search",
    arguments: { q: "hi", filter: { user_id: "U123" } },
  });
  assert.equal(result.isError, undefined);

  const call = calls.find((c) => c.url.includes("/v1/search"));
  assert.ok(call, "expected a matching call to RS");
  assert.equal(call.searchParams.get("q"), "hi", "search must forward q");
  assert.equal(call.searchParams.get("filter[user_id]"), "U123");
  assert.equal(call.searchParams.get("filter"), null);

  await client.close();
  await server.close();
});

test("search surfaces readable hit handles in content text", async () => {
  const { fetch } = recordingFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({ name: "search", arguments: { q: "hi" } });
  assert.equal(result.isError, undefined);
  const text = resultText(result);
  assert.match(text, RESULT_HIT, "search text must surface a usable result summary");
  assert.match(text, ID_MESSAGES_M, "search text must include a fetchable result id");
  const structuredContent = result.structuredContent as { results: unknown[] };
  assert.equal(structuredContent.results.length, 1, "flattened results must be populated");

  await client.close();
  await server.close();
});
