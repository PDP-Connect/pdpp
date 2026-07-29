// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createPdppMcpServer } from "../src/server.ts";

const ID_IS_EXCLUSIVE_WITH_EXPLICIT = /`id` is exclusive with explicit `connection_id`, `stream`, and `record_id`/;
const MUST_INCLUDE_CONNECTION_ID = /must include connection_id/;
const REQUIRES_EITHER_ID_FIELD_PATH =
  /requires either `id` \+ `field_path` or `connection_id` \+ `stream` \+ `record_id`/;
const CURSOR_IS_EXCLUSIVE_WITH_OFFSET = /`cursor` is exclusive with `offset_chars`/;
const Q_IS_EXCLUSIVE_WITH_CURSOR = /`q` is exclusive with `cursor` and `offset_chars`/;
const BEFORE_CHARS_AND_AFTER_CHARS = /`before_chars` and `after_chars` require `q`/;
const FIELD_WINDOW_CURSOR_MUST_BE = /field-window cursor must be a non-negative integer offset/;

interface FetchCall {
  method: string;
  url: string;
}

function makeFieldWindowFetch() {
  const calls: FetchCall[] = [];
  // biome-ignore lint/suspicious/useAwait: async required to satisfy the Promise<Response>-returning fetch/getJson contract this fixture implements; a synchronous return type is not assignable to the caller's injected dependency.
  const fetch = async (urlInput: string | Request | URL, init: RequestInit = {}) => {
    const url = new URL(urlInput.toString());
    calls.push({ url: url.toString(), method: init.method ?? "GET" });

    if (url.pathname === "/v1/streams/orders/records/o1/field-window") {
      return jsonResponse({
        object: "field_window",
        stream: "orders",
        record_id: "o1",
        connection_id: url.searchParams.get("connection_id"),
        field: { path: url.searchParams.get("field"), type: "string" },
        window: {
          text: "window text",
          start_chars: Number.parseInt(url.searchParams.get("offset_chars") ?? "0", 10),
          end_chars: 11,
          limit_chars: Number.parseInt(url.searchParams.get("limit_chars") ?? "64", 10),
          total_chars: 11,
          complete: true,
          has_more: false,
          next_offset_chars: null,
          previous_offset_chars: null,
        },
      });
    }

    return new Response(JSON.stringify({ error: { type: "not_found", code: "not_found" } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function connectClient(fakeFetch: typeof fetch) {
  const { server } = createPdppMcpServer({
    providerUrl: "https://provider.test",
    accessToken: "scoped-token",
    fetch: fakeFetch,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "read-record-field-selector-contract-test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

interface SelectorErrorResult {
  content?: readonly unknown[] | undefined;
  isError?: boolean | undefined;
  structuredContent?: { error?: { message?: string } } | undefined;
  [key: string]: unknown;
}

function assertSelectorError(result: SelectorErrorResult, expectedMessage: RegExp) {
  assert.equal(result.isError, true);
  const first = result.content?.[0] as { text?: string; type?: string } | undefined;
  assert.equal(first?.type, "text", "first content block must be text");
  const textError = JSON.parse(first?.text ?? "{}");
  assert.match(textError.message, expectedMessage);
  assert.match(result.structuredContent?.error?.message ?? "", expectedMessage);
}

test("read_record_field rejects invalid MCP-layer selectors before calling RS", async () => {
  const cases = [
    {
      name: "id plus explicit triple",
      arguments: {
        id: "conn_orders/orders:o1",
        connection_id: "conn_orders",
        stream: "orders",
        record_id: "o1",
        field_path: "text",
      },
      message: ID_IS_EXCLUSIVE_WITH_EXPLICIT,
    },
    {
      name: "legacy id without connection_id",
      arguments: { id: "orders:o1", field_path: "text" },
      message: MUST_INCLUDE_CONNECTION_ID,
    },
    {
      name: "neither id nor full triple",
      arguments: { connection_id: "conn_orders", stream: "orders", field_path: "text" },
      message: REQUIRES_EITHER_ID_FIELD_PATH,
    },
    {
      name: "cursor plus offset_chars",
      arguments: { id: "conn_orders/orders:o1", field_path: "text", cursor: "12", offset_chars: 12 },
      message: CURSOR_IS_EXCLUSIVE_WITH_OFFSET,
    },
    {
      name: "q plus offset_chars",
      arguments: { id: "conn_orders/orders:o1", field_path: "text", q: "needle", offset_chars: 12 },
      message: Q_IS_EXCLUSIVE_WITH_CURSOR,
    },
    {
      name: "before_chars without q",
      arguments: { id: "conn_orders/orders:o1", field_path: "text", before_chars: 8 },
      message: BEFORE_CHARS_AND_AFTER_CHARS,
    },
    {
      name: "non-integer cursor",
      arguments: { id: "conn_orders/orders:o1", field_path: "text", cursor: "abc" },
      message: FIELD_WINDOW_CURSOR_MUST_BE,
    },
  ];

  for (const contractCase of cases) {
    const { fetch, calls } = makeFieldWindowFetch();
    // biome-ignore lint/performance/noAwaitInLoops: each iteration owns an isolated MCP client/session that must fully connect, call, and close before the next case starts; Promise.all would run concurrent InMemoryTransport pairs and break per-case isolation.
    const { client, server } = await connectClient(fetch);
    try {
      const result = await client.callTool({ name: "read_record_field", arguments: contractCase.arguments });
      assertSelectorError(result, contractCase.message);
      assert.equal(calls.length, 0, `${contractCase.name} should not reach the RS`);
    } finally {
      await client.close();
      await server.close();
    }
  }
});

test("read_record_field accepts a valid self-contained id selector and forwards field-window query", async () => {
  const { fetch, calls } = makeFieldWindowFetch();
  const { client, server } = await connectClient(fetch);
  try {
    const result = await client.callTool({
      name: "read_record_field",
      arguments: { id: "conn_orders/orders:o1", field_path: "text", offset_chars: 4 },
    });

    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.ok(call, "field-window fetch must be recorded");
    const routeUrl = new URL(call.url);
    assert.equal(routeUrl.pathname, "/v1/streams/orders/records/o1/field-window");
    assert.equal(routeUrl.searchParams.get("connection_id"), "conn_orders");
    assert.equal(routeUrl.searchParams.get("field"), "text");
    assert.equal(routeUrl.searchParams.get("offset_chars"), "4");
  } finally {
    await client.close();
    await server.close();
  }
});
