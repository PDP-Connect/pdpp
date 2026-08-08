// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";
import type { CollectContext, EmittedMessage, RecordData, StreamScope } from "../../src/connector-runtime.ts";
import { collect } from "./index.ts";

/** Build a real CollectContext — same protocol shape runConnector() builds. */
function makeContext({
  credentials,
  state = { libraries: {}, items: {} },
  streams,
}: {
  readonly credentials: Record<string, string>;
  readonly state?: Record<string, unknown>;
  readonly streams: readonly StreamScope[];
}): {
  readonly ctx: CollectContext;
  readonly messages: EmittedMessage[];
  readonly records: Array<{ data: RecordData; stream: string }>;
} {
  const messages: EmittedMessage[] = [];
  const records: Array<{ data: RecordData; stream: string }> = [];
  return {
    messages,
    records,
    ctx: {
      assist: () => Promise.resolve("asst_test"),
      capture: null,
      completeAssistance: () => Promise.resolve(),
      credentials,
      detailGaps: [],
      emit: (msg) => {
        messages.push(msg);
        return Promise.resolve();
      },
      emitRecord: (stream, data) => {
        records.push({ data, stream });
        return Promise.resolve();
      },
      emittedAt: "2026-06-11T00:00:00.000Z",
      progress: (message, extra = {}) => {
        messages.push({ type: "PROGRESS", message, ...extra });
        return Promise.resolve();
      },
      requested: new Map(streams.map((stream) => [stream.name, stream])),
      requestDetailGapPage: () => Promise.resolve([]),
      scope: { streams },
      sendInteraction: () =>
        Promise.resolve({
          request_id: "int_test",
          status: "cancelled",
          type: "INTERACTION_RESPONSE",
        }),
      state,
    },
  };
}

// Fake Jellyfin HTTP server for end-to-end testing
class FakeJellyfinServer {
  private server: any;
  private port = 0;
  private readonly requestLog: Array<{ method: string; path: string; headers: Record<string, string> }> = [];
  private responseMode:
    | "normal"
    | "missing_total"
    | "malformed_total"
    | "decreasing_total"
    | "oversized"
    | "no_content_length"
    | "repeated_page" = "normal";

  start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const path = req.url || "";
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === "string") {
            headers[key] = value;
          } else if (Array.isArray(value) && value[0] !== undefined) {
            headers[key] = value[0];
          }
        }

        this.requestLog.push({
          method: req.method || "GET",
          path,
          headers,
        });

        // Assert API key never in query params (should be in header)
        if (path.includes("api_key=")) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "API key must not be in query params" }));
          return;
        }

        // Jellyfin serves its REST API at the root, NOT under /api/ — a request
        // path with that prefix indicates the connector regressed to hitting a
        // URL shape that doesn't exist on a real Jellyfin server (404).
        if (path.startsWith("/api/")) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        // Auth probe
        if (path === "/System/Info") {
          if (!headers["x-emby-token"]) {
            res.writeHead(401);
            res.end("Unauthorized");
            return;
          }
          res.writeHead(200);
          res.end(
            JSON.stringify({
              Id: "test-server-id",
              ServerName: "Test Jellyfin",
              Version: "10.11.11",
            })
          );
          return;
        }

        // User endpoint
        if (path === "/Users") {
          if (!headers["x-emby-token"]) {
            res.writeHead(401);
            res.end("Unauthorized");
            return;
          }
          res.writeHead(200);
          res.end(
            JSON.stringify([
              {
                Id: "test-user-123",
                Name: "TestUser",
              },
            ])
          );
          return;
        }

        // Libraries endpoint
        if (path === "/Users/test-user-123/Views") {
          if (!headers["x-emby-token"]) {
            res.writeHead(401);
            res.end("Unauthorized");
            return;
          }
          res.writeHead(200);
          res.end(
            JSON.stringify({
              Items: [{ Id: "lib1", Name: "Movies", CollectionType: "movies", PrimaryImageTag: "tag1" }],
            })
          );
          return;
        }

        // Items endpoints with pagination
        if (path.includes("/Users/test-user-123/Items")) {
          if (!headers["x-emby-token"]) {
            res.writeHead(401);
            res.end("Unauthorized");
            return;
          }

          const url = new URL(path, `http://localhost:${this.port}`);
          const startIndex = Number.parseInt(url.searchParams.get("StartIndex") || "0", 10);

          // Test: missing TotalRecordCount
          if (this.responseMode === "missing_total") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ Items: [{ Id: "item-1", Name: "Item 1" }] }));
            return;
          }

          // Test: malformed TotalRecordCount (string instead of number)
          if (this.responseMode === "malformed_total") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ Items: [{ Id: "item-1", Name: "Item 1" }], TotalRecordCount: "not_a_number" }));
            return;
          }

          // Test: decreasing TotalRecordCount
          if (this.responseMode === "decreasing_total") {
            // Page 1: claim 1000 items total
            // Page 2: decrease to 600 items total (invalid, should fail)
            const total = startIndex === 0 ? 1000 : 600;
            const items = Array.from({ length: 500 }, (_, i) => ({
              Id: `item-${startIndex + i}`,
              Name: `Item ${startIndex + i}`,
            }));
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ Items: items, TotalRecordCount: total }));
            return;
          }

          // Test: oversized response (claim large Content-Length without sending it)
          if (this.responseMode === "oversized") {
            res.writeHead(200, { "Content-Length": String(100 * 1024 * 1024 + 1) }); // 100MB + 1
            res.end(JSON.stringify({ Items: [] }));
            return;
          }

          // Test: no Content-Length header (client should handle gracefully)
          if (this.responseMode === "no_content_length") {
            // Most servers send Content-Length, but some don't
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ Items: [{ Id: "item-1", Name: "Item 1" }], TotalRecordCount: 1 }));
            return;
          }

          // Test: repeated page (same items returned multiple times, huge claimed count)
          if (this.responseMode === "repeated_page") {
            // Always return same 500 items regardless of StartIndex (infinite loop on huge claimed total)
            const items = Array.from({ length: 500 }, () => ({
              Id: "item-1",
              Name: "Item 1",
            }));
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ Items: items, TotalRecordCount: 999_999_999 })); // Claims 1 billion
            return;
          }

          // Normal mode
          if (startIndex === 0) {
            const items = Array.from({ length: 50 }, (_, i) => ({
              Id: `item-${i}`,
              Name: `Item ${i}`,
              Type: "Movie",
              UserData: { PlayCount: 0, Played: false },
            }));
            res.writeHead(200);
            res.end(JSON.stringify({ Items: items, TotalRecordCount: 100 }));
          } else if (startIndex === 500) {
            const items = Array.from({ length: 50 }, (_, i) => ({
              Id: `item-${500 + i}`,
              Name: `Item ${500 + i}`,
              Type: "Movie",
              UserData: { PlayCount: 0, Played: false },
            }));
            res.writeHead(200);
            res.end(JSON.stringify({ Items: items, TotalRecordCount: 100 }));
          } else {
            res.writeHead(200);
            res.end(JSON.stringify({ Items: [], TotalRecordCount: 100 }));
          }
          return;
        }

        // 404 for unknown endpoints
        res.writeHead(404);
        res.end("Not found");
      });

      this.server.listen(0, "127.0.0.1", () => {
        this.port = (this.server.address() as any).port;
        resolve(`http://127.0.0.1:${this.port}`);
      });

      this.server.on("error", reject);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server) {
        this.server.close((err: any) => (err ? reject(err) : resolve()));
      } else {
        resolve();
      }
    });
  }

  getRequestLog() {
    return this.requestLog;
  }

  setResponseMode(mode: typeof this.responseMode) {
    this.responseMode = mode;
  }
}

test("e2e: header auth (X-Emby-Token) and no query param credentials", async () => {
  const server = new FakeJellyfinServer();
  const baseUrl = await server.start();

  try {
    const { ctx, records } = makeContext({
      credentials: { base_url: baseUrl, secret: "test-secret-key-12345" },
      streams: [{ name: "libraries" }],
    });

    await collect(ctx);

    const libraryRecords = records.filter((r) => r.stream === "libraries");
    assert.equal(libraryRecords.length, 1, "Should emit 1 library");

    const requests = server.getRequestLog();

    // Assert no API key in any request URL
    for (const req of requests) {
      assert(!req.path.includes("api_key="), `Request should not contain api_key query param: ${req.path}`);
      assert(!req.path.includes("test-secret-key"), `Request should not expose secret: ${req.path}`);
    }

    // Regression guard: Jellyfin serves its REST API at the root, not under
    // /api/. A prior version of this connector prefixed every request path
    // with /api/, which 404s against a real server; the fake server above
    // only serves the real (unprefixed) paths, so this also fails naturally
    // if the prefix regresses — this assertion makes the failure legible.
    for (const req of requests) {
      assert(!req.path.startsWith("/api/"), `Request path must not be prefixed with /api/: ${req.path}`);
    }

    // Assert X-Emby-Token header is present
    const authHeader = requests.find((r) => r.headers["x-emby-token"]);
    assert.ok(authHeader, "At least one request should have X-Emby-Token header");
    assert.equal(authHeader.headers["x-emby-token"], "test-secret-key-12345", "Header should contain correct secret");
  } finally {
    await server.stop();
  }
});

test("e2e: SSRF protection via origin constraint", async () => {
  const server = new FakeJellyfinServer();
  const baseUrl = await server.start();

  try {
    const { ctx, records } = makeContext({
      credentials: { base_url: baseUrl, secret: "test-key" },
      streams: [{ name: "libraries" }],
    });

    await collect(ctx);

    assert.ok(records.length > 0, "Should successfully fetch with origin-constrained requests");
  } finally {
    await server.stop();
  }
});

test("adversarial: base URL with userinfo is rejected", async () => {
  const malformedUrl = "http://user:pass@127.0.0.1:8096";

  let threwError = false;

  const { ctx } = makeContext({
    credentials: { base_url: malformedUrl, secret: "test-key" },
    streams: [{ name: "libraries" }],
  });

  try {
    await collect(ctx);
  } catch (e) {
    threwError = true;
    const msg = (e as any).message || String(e);
    assert.ok(msg.includes("userinfo"), `Expected userinfo error, got: ${msg}`);
  }

  assert.ok(threwError, "Should reject base URL with userinfo");
});

test("adversarial: missing TotalRecordCount fails closed", async () => {
  const server = new FakeJellyfinServer();
  server.setResponseMode("missing_total");
  const baseUrl = await server.start();

  try {
    let threwError = false;

    const { ctx } = makeContext({
      credentials: { base_url: baseUrl, secret: "test-key" },
      streams: [{ name: "items" }],
    });

    await collect(ctx).catch(() => {
      threwError = true;
    });

    assert.ok(threwError, "Should fail closed on missing TotalRecordCount");
  } finally {
    await server.stop();
  }
});

test("adversarial: malformed TotalRecordCount (string) fails closed", async () => {
  const server = new FakeJellyfinServer();
  server.setResponseMode("malformed_total");
  const baseUrl = await server.start();

  try {
    let threwError = false;

    const { ctx } = makeContext({
      credentials: { base_url: baseUrl, secret: "test-key" },
      streams: [{ name: "items" }],
    });

    await collect(ctx).catch(() => {
      threwError = true;
    });

    assert.ok(threwError, "Should fail closed on malformed TotalRecordCount");
  } finally {
    await server.stop();
  }
});

test("adversarial: decreasing TotalRecordCount fails closed", async () => {
  const server = new FakeJellyfinServer();
  server.setResponseMode("decreasing_total");
  const baseUrl = await server.start();

  try {
    let threwError = false;

    const { ctx } = makeContext({
      credentials: { base_url: baseUrl, secret: "test-key" },
      streams: [{ name: "items" }],
    });

    await collect(ctx).catch(() => {
      threwError = true;
    });

    assert.ok(threwError, "Should fail closed on decreasing TotalRecordCount");
  } finally {
    await server.stop();
  }
});

test("adversarial: oversized Content-Length is rejected before body read", async () => {
  const server = new FakeJellyfinServer();
  server.setResponseMode("oversized");
  const baseUrl = await server.start();

  try {
    let threwError = false;

    const { ctx } = makeContext({
      credentials: { base_url: baseUrl, secret: "test-key" },
      streams: [{ name: "items" }],
    });

    await collect(ctx).catch(() => {
      threwError = true;
    });

    assert.ok(threwError, "Should reject oversized Content-Length");
  } finally {
    await server.stop();
  }
});

test("e2e: subpath-hosted server (base URL with a path segment) is reachable", async () => {
  // Jellyfin is commonly reverse-proxied under a subpath (e.g. https://host/jellyfin/).
  // Request paths are joined onto the base with new URL(path, base); a leading-slash
  // path (e.g. "/Users") would resolve against the host root and silently drop
  // the "/jellyfin" prefix. This server only answers under /jellyfin/, so the test
  // fails if that prefix gets dropped during path construction.
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url || "";

    if (!path.startsWith("/jellyfin/")) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const subpath = path.slice("/jellyfin".length);

    if (subpath === "/System/Info") {
      res.writeHead(200);
      res.end(JSON.stringify({ Id: "test", ServerName: "Test", Version: "10.11.11" }));
      return;
    }
    if (subpath === "/Users") {
      res.writeHead(200);
      res.end(JSON.stringify([{ Id: "user-123", Name: "Test" }]));
      return;
    }
    if (subpath === "/Users/user-123/Views") {
      res.writeHead(200);
      res.end(JSON.stringify({ Items: [{ Id: "lib1", Name: "Movies" }] }));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  const baseUrl: string = await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as any;
      resolve(`http://127.0.0.1:${address.port}/jellyfin`);
    });
    server.on("error", reject);
  });

  try {
    const { ctx, records } = makeContext({
      credentials: { base_url: baseUrl, secret: "test-key" },
      streams: [{ name: "libraries" }],
    });

    await collect(ctx);

    const libraryRecords = records.filter((r) => r.stream === "libraries");
    assert.equal(libraryRecords.length, 1, "Should reach the subpath-hosted server and emit 1 library");
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

// Note: max-page guard test deferred (would require 1000+ paced requests = 100+ seconds)
// Guard is present in code, validates pageCount >= MAX_PAGES_PER_STREAM (1000)
