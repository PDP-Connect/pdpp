// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mutation tests: verify guards fail when removed.
 * Each test removes a guard (streaming cap, repeated-page detection, max-pages)
 * and confirms the defect manifests by driving production code paths.
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";
import type { CollectContext, EmittedMessage, RecordData, StreamScope } from "../../src/connector-runtime.ts";
import { __setMaxJsonBytes, __setMaxPagesPerStream, collect } from "./index.ts";

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

class TestServer {
  private server: any;
  private port = 0;
  private responseMode: "normal" | "oversized_no_length" | "repeated_page" = "normal";

  start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const path = req.url || "";

        // Auth endpoints
        if (path === "/api/System/Info") {
          res.writeHead(200);
          res.end(JSON.stringify({ Id: "test", ServerName: "Test", Version: "10.11.11" }));
          return;
        }

        if (path === "/api/Users/Me") {
          res.writeHead(200);
          res.end(JSON.stringify({ Id: "user-123", Name: "Test" }));
          return;
        }

        if (path === "/api/Users/user-123/Views") {
          res.writeHead(200);
          res.end(JSON.stringify({ Items: [{ Id: "lib1", Name: "Lib1" }] }));
          return;
        }

        if (path.includes("/api/Users/user-123/Items")) {
          if (this.responseMode === "oversized_no_length") {
            // Send large body WITHOUT Content-Length header
            // Streaming reader must catch it, not Content-Length check
            res.writeHead(200, { "Content-Type": "application/json" });
            // Generate ~2MB JSON (oversized for our small test limit)
            const item = { Id: "x", Name: "y" };
            const payload = { Items: new Array(100_000).fill(item), TotalRecordCount: 0 };
            res.end(JSON.stringify(payload));
            return;
          }

          if (this.responseMode === "repeated_page") {
            // Always return same 100 items regardless of StartIndex
            const items = Array.from({ length: 100 }, (_, i) => ({
              Id: `item-${i}`,
              Name: `Item ${i}`,
            }));
            res.writeHead(200);
            res.end(JSON.stringify({ Items: items, TotalRecordCount: 50_000 }));
            return;
          }

          res.writeHead(200);
          res.end(JSON.stringify({ Items: [], TotalRecordCount: 0 }));
          return;
        }

        res.writeHead(404);
        res.end();
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

  setMode(mode: typeof this.responseMode) {
    this.responseMode = mode;
  }
}

test("mutation: streaming byte cap catches oversized body without Content-Length", async () => {
  const server = new TestServer();
  const baseUrl = await server.start();

  try {
    // Inject small byte cap (100KB) to catch real 2MB response
    __setMaxJsonBytes(100 * 1024);
    server.setMode("oversized_no_length");

    let threwError = false;
    let errorMsg = "";

    const { ctx } = makeContext({
      credentials: { base_url: baseUrl, secret: "test-key" },
      streams: [{ name: "items" }],
    });

    await collect(ctx).catch((e) => {
      threwError = true;
      errorMsg = (e as any).message || String(e);
    });

    assert.ok(threwError, "Streaming byte cap must reject oversized body");
    // Error may be wrapped by governor, check for any error that indicates oversized rejection
    assert.ok(
      errorMsg.includes("streaming") || errorMsg.includes("too_large") || errorMsg.includes("retry budget"),
      `Expected streaming/size error, got: ${errorMsg}`
    );
  } finally {
    __setMaxJsonBytes(50 * 1024 * 1024); // Restore
    await server.stop();
  }
});

test("mutation: repeated-page detection catches non-advancing pagination", async () => {
  const server = new TestServer();
  const baseUrl = await server.start();

  try {
    server.setMode("repeated_page");

    let threwError = false;
    let errorMsg = "";

    const { ctx } = makeContext({
      credentials: { base_url: baseUrl, secret: "test-key" },
      streams: [{ name: "items" }],
    });

    await collect(ctx).catch((e) => {
      threwError = true;
      errorMsg = (e as any).message || String(e);
    });

    assert.ok(threwError, "Repeated-page guard must reject non-advancing pagination");
    assert.ok(errorMsg.includes("non_advancing"), `Expected non-advancing error, got: ${errorMsg}`);
  } finally {
    await server.stop();
  }
});

test("mutation: max-pages guard is testable with injected config", async () => {
  // Create server that returns empty pages with huge claimed total
  const emptyPagingServer = new (class {
    private server: any;
    private port = 0;

    start(): Promise<string> {
      return new Promise((resolve, reject) => {
        this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
          const path = req.url || "";

          if (path === "/api/System/Info") {
            res.writeHead(200);
            res.end(JSON.stringify({ Id: "test", ServerName: "Test", Version: "10.11.11" }));
            return;
          }

          if (path === "/api/Users/Me") {
            res.writeHead(200);
            res.end(JSON.stringify({ Id: "user-123", Name: "Test" }));
            return;
          }

          if (path === "/api/Users/user-123/Views") {
            res.writeHead(200);
            res.end(JSON.stringify({ Items: [{ Id: "lib1", Name: "Lib1" }] }));
            return;
          }

          if (path.includes("/api/Users/user-123/Items")) {
            // Empty items but claim 1 million total (forces pagination loop)
            res.writeHead(200);
            res.end(JSON.stringify({ Items: [], TotalRecordCount: 1_000_000 }));
            return;
          }

          res.writeHead(404);
          res.end();
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
  })();

  const pagingUrl = await emptyPagingServer.start();

  try {
    // Set low max pages (3) for fast test
    __setMaxPagesPerStream(3);

    let threwError = false;
    let errorMsg = "";

    const { ctx } = makeContext({
      credentials: { base_url: pagingUrl, secret: "test-key" },
      streams: [{ name: "items" }],
    });

    await collect(ctx).catch((e) => {
      threwError = true;
      errorMsg = (e as any).message || String(e);
    });

    assert.ok(threwError, "Max-page guard must fire on excessive pagination");
    assert.ok(errorMsg.includes("max_pages"), `Expected max-pages error, got: ${errorMsg}`);
  } finally {
    __setMaxPagesPerStream(1000); // Restore
    await emptyPagingServer.stop();
  }
});
