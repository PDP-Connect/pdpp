// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createPdppMcpServer } from "../src/server.ts";

const CONFLICTING_CONNECTION_ID_MESSAGE = /id embeds connection_id 'conn_a' but the connection_id argument is 'conn_b'/;

interface FetchCall {
  method: string;
  path: string;
  query: Record<string, string>;
}

function makeRecordingFetch() {
  const calls: FetchCall[] = [];
  // biome-ignore lint/suspicious/useAwait: async required to satisfy the Promise<Response>-returning fetch/getJson contract this fixture implements; a synchronous return type is not assignable to the caller's injected dependency.
  const fetch = async (urlInput: string | Request | URL, init: RequestInit = {}) => {
    const url = new URL(urlInput.toString());
    calls.push({
      method: init.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(new URLSearchParams(url.search).entries()),
    });

    if (url.pathname === "/v1/streams/orders/records/o1") {
      return jsonResponse({
        id: "o1",
        title: "Order o1",
        text: "Pasta maker, $89.",
        url: "https://provider.test/orders/o1",
        metadata: {
          source: "fixture",
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
  const client = new Client({ name: "fetch-id-form-contract-test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

function recordFetchCalls(calls: FetchCall[]) {
  return calls.filter((call) => call.path === "/v1/streams/orders/records/o1");
}

test("fetch id forms dispatch to the expected RS path and connection query", async () => {
  const cases = [
    {
      name: "self-contained id alone forwards embedded connection_id",
      arguments: { id: "conn_a/orders:o1" },
      query: { connection_id: "conn_a" },
    },
    {
      name: "legacy id alone keeps the RS request unscoped",
      arguments: { id: "orders:o1" },
      query: {},
    },
    {
      name: "legacy id with connection_id argument forwards the argument",
      arguments: { id: "orders:o1", connection_id: "conn_b" },
      query: { connection_id: "conn_b" },
    },
    {
      name: "self-contained id with agreeing connection_id argument is accepted",
      arguments: { id: "conn_a/orders:o1", connection_id: "conn_a" },
      query: { connection_id: "conn_a" },
    },
  ];

  for (const testCase of cases) {
    const { fetch, calls } = makeRecordingFetch();
    // biome-ignore lint/performance/noAwaitInLoops: each iteration owns an isolated MCP client/session that must fully connect, call, and close before the next case starts; Promise.all would run concurrent InMemoryTransport pairs and break per-case isolation.
    const { client, server } = await connectClient(fetch);

    const result = await client.callTool({ name: "fetch", arguments: testCase.arguments });
    assert.equal(result.isError, undefined, testCase.name);

    assert.deepEqual(recordFetchCalls(calls), [
      {
        method: "GET",
        path: "/v1/streams/orders/records/o1",
        query: testCase.query,
      },
    ]);

    await client.close();
    await server.close();
  }
});

test("fetch rejects conflicting embedded and argument connection ids before the RS call", async () => {
  const { fetch, calls } = makeRecordingFetch();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: "fetch",
    arguments: { id: "conn_a/orders:o1", connection_id: "conn_b" },
  });

  assert.equal(result.isError, true);
  const structuredContent = result.structuredContent as { error?: { code?: string; message?: string } };
  assert.match(structuredContent.error?.message ?? "", CONFLICTING_CONNECTION_ID_MESSAGE);
  assert.equal(structuredContent.error?.code, "conflicting_connection_id");
  assert.deepEqual(recordFetchCalls(calls), []);

  await client.close();
  await server.close();
});
