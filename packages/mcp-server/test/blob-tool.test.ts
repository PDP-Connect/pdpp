// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createPdppMcpServer } from "../src/server.ts";

const BLOB_ID = "blob_sha256_attachment_fixture";
const CONNECTION_ID = "conn_gmail_fixture";
const BYTES = Buffer.from([0, 255, 17, 128, 42, 9]);
const SCOPED_BEARER_PATTERN = /same scoped bearer|scoped/i;
const METADATA_ONLY_PATTERN = /metadata alone is not access/i;

interface FetchCall {
  authorization: string | undefined;
  range: string | undefined;
  url: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function connect(fetch: typeof globalThis.fetch) {
  const { server } = createPdppMcpServer({
    providerUrl: "https://pdpp.test",
    accessToken: "scoped-client-token",
    fetch,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "blob-tool-test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

test("fetch_blob discovers the canonical tool and returns authorized range bytes, not metadata", async () => {
  const calls: FetchCall[] = [];
  // biome-ignore lint/suspicious/useAwait: this deterministic fetch double implements the global fetch signature.
  const fetch = async (input: string | Request | URL, init: RequestInit = {}) => {
    const url = new URL(input.toString());
    const headers = init.headers as Record<string, string> | undefined;
    calls.push({
      authorization: headers?.Authorization,
      range: headers?.Range,
      url: url.toString(),
    });

    if (url.pathname === "/v1/streams/attachments/records") {
      return jsonResponse({
        records: [
          {
            id: "message-1:attachment-1",
            data: {
              blob_ref: {
                blob_id: BLOB_ID,
                fetch_url: `/v1/blobs/${BLOB_ID}`,
                mime_type: "application/octet-stream",
                sha256: "fixture-sha256",
                size_bytes: BYTES.length,
              },
              filename: "fixture.bin",
              hydration_status: "hydrated",
            },
            connection_id: CONNECTION_ID,
          },
        ],
        has_more: false,
      });
    }

    if (url.pathname === `/v1/blobs/${BLOB_ID}`) {
      assert.equal(init.method, "GET");
      assert.equal(headers?.Authorization, "Bearer scoped-client-token");
      assert.equal(headers?.Range, "bytes=1-3");
      const selected = BYTES.subarray(1, 4);
      return new Response(selected, {
        status: 206,
        headers: {
          "accept-ranges": "bytes",
          "content-length": String(selected.length),
          "content-range": `bytes 1-3/${BYTES.length}`,
          "content-type": "application/octet-stream",
          "cache-control": "private, no-store",
        },
      });
    }

    return jsonResponse({ error: { code: "not_found", message: "unexpected fixture path" } }, 404);
  };

  const { client, server } = await connect(fetch);
  try {
    const tools = await client.listTools();
    const blobTool = tools.tools.find((tool) => tool.name === "fetch_blob");
    assert.ok(blobTool, "fetch_blob must be discoverable on the normal read surface");
    assert.ok(blobTool.inputSchema.properties?.blob_id, "fetch_blob must require blob_id");
    assert.ok(blobTool.inputSchema.properties?.range, "fetch_blob must expose the bounded range primitive");
    assert.match(blobTool.description ?? "", SCOPED_BEARER_PATTERN);
    assert.match(blobTool.description ?? "", METADATA_ONLY_PATTERN);

    const records = await client.callTool({
      name: "query_records",
      arguments: { stream: "attachments", connection_id: CONNECTION_ID },
    });
    const recordData = (records.structuredContent as { data?: { records?: Array<{ data?: Record<string, unknown> }> } })
      .data?.records?.[0]?.data;
    assert.equal(recordData?.blob_ref && typeof recordData.blob_ref, "object");
    const blobRef = recordData?.blob_ref as Record<string, unknown>;
    assert.equal(blobRef.bytes, undefined);

    const result = await client.callTool({
      name: "fetch_blob",
      arguments: { blob_id: BLOB_ID, connection_id: CONNECTION_ID, range: "bytes=1-3" },
    });
    assert.equal(result.isError, undefined);
    const output = result.structuredContent as {
      bytes_base64: string;
      mime_type: string;
      size: number;
    };
    assert.equal(output.bytes_base64, BYTES.subarray(1, 4).toString("base64"));
    assert.equal(output.mime_type, "application/octet-stream");
    assert.equal(output.size, 3);
    assert.equal(calls.length, 2, "record discovery and byte retrieval each make one RS call");
    assert.ok(calls.every((call) => call.authorization === "Bearer scoped-client-token"));
    assert.equal(calls[1]?.range, "bytes=1-3");
  } finally {
    await client.close();
    await server.close();
  }
});

test("deferred attachment metadata stays deferred and blob_not_found stays an error", async () => {
  let blobFetches = 0;
  // biome-ignore lint/suspicious/useAwait: this deterministic fetch double implements the global fetch signature.
  const fetch = async (input: string | Request | URL) => {
    const url = new URL(input.toString());
    if (url.pathname === "/v1/streams/attachments/records") {
      return jsonResponse({
        records: [
          {
            id: "message-2:attachment-1",
            data: { blob_ref: null, hydration_status: "deferred", hydration_error: null },
          },
        ],
        has_more: false,
      });
    }
    if (url.pathname.startsWith("/v1/blobs/")) {
      blobFetches += 1;
      return jsonResponse({ error: { code: "blob_not_found", message: "Blob not found" } }, 404);
    }
    return jsonResponse({ error: { code: "not_found" } }, 404);
  };

  const { client, server } = await connect(fetch);
  try {
    const result = await client.callTool({ name: "query_records", arguments: { stream: "attachments" } });
    const record = (result.structuredContent as { data?: { records?: Array<{ data?: Record<string, unknown> }> } }).data
      ?.records?.[0]?.data;
    assert.equal(record?.blob_ref, null);
    assert.equal(record?.hydration_status, "deferred");
    assert.equal(blobFetches, 0, "metadata-only/deferred records do not trigger an invented byte fetch");

    const missing = await client.callTool({ name: "fetch_blob", arguments: { blob_id: BLOB_ID } });
    assert.equal(missing.isError, true);
    assert.equal((missing.structuredContent as { error?: { code?: string } }).error?.code, "blob_not_found");
  } finally {
    await client.close();
    await server.close();
  }
});
