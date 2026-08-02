// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { proxyReferenceCatchAll, proxyReferenceRequest } from "./reference-proxy.ts";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_RS_URL = process.env.PDPP_RS_URL;

function restoreProxyGlobals(): void {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_RS_URL === undefined) {
    delete process.env.PDPP_RS_URL;
  } else {
    process.env.PDPP_RS_URL = ORIGINAL_RS_URL;
  }
}

test("HEAD preserves representation headers while stripping hop-by-hop headers", async () => {
  const request = new Request("https://console.example/v1/blobs/blob-1", { method: "HEAD" });
  const upstreamHeaders = new Headers({
    connection: "keep-alive",
    "content-encoding": "gzip",
    "content-length": "42",
    "x-upstream": "preserved",
  });

  globalThis.fetch = async () => new Response(null, { headers: upstreamHeaders });

  try {
    const response = await proxyReferenceRequest(request, "rs", ["v1", "blobs", "blob-1"]);

    assert.equal(response.headers.get("content-length"), "42");
    assert.equal(response.headers.get("content-encoding"), "gzip");
    assert.equal(response.headers.get("connection"), null);
    assert.equal(response.headers.get("x-upstream"), "preserved");
    assert.equal(response.body, null);
  } finally {
    restoreProxyGlobals();
  }
});

test("GET strips potentially stale length and encoding from body-bearing responses", async () => {
  const request = new Request("https://console.example/v1/blobs/blob-1", { method: "GET" });
  const upstreamHeaders = new Headers({
    "content-encoding": "gzip",
    "content-length": "42",
    "x-upstream": "preserved",
  });

  globalThis.fetch = async () => new Response("decoded body", { headers: upstreamHeaders });

  try {
    const response = await proxyReferenceRequest(request, "rs", ["v1", "blobs", "blob-1"]);

    assert.equal(response.headers.get("content-length"), null);
    assert.equal(response.headers.get("content-encoding"), null);
    assert.equal(response.headers.get("x-upstream"), "preserved");
    assert.equal(await response.text(), "decoded body");
  } finally {
    restoreProxyGlobals();
  }
});

test("catch-all routes preserve the encoded path and query when forwarding", async () => {
  process.env.PDPP_RS_URL = "http://reference-server.example:7663";
  let forwardedUrl = "";

  globalThis.fetch = (input, init) => {
    forwardedUrl = String(input);
    assert.equal(init?.method, "GET");
    return Promise.resolve(new Response("ok", { status: 200 }));
  };

  try {
    const response = await proxyReferenceCatchAll(new Request("https://console.example/v1?cursor=next"), "rs", ["v1"], {
      params: Promise.resolve({ path: ["blobs", "space/value"] }),
    });

    assert.equal(response.status, 200);
    assert.equal(forwardedUrl, "http://reference-server.example:7663/v1/blobs/space%2Fvalue?cursor=next");
  } finally {
    restoreProxyGlobals();
  }
});
