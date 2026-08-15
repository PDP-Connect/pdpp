// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for P0 correctness bug: repeated-page guard must detect
 * identity-based repetition (the full ordered page of item IDs), not just
 * equal counts and not just the first item's identity.
 *
 * Normal pagination: 500 items on page 1, 500 different items on page 2 MUST succeed.
 * Repeated page: same items returned twice (pagination doesn't advance) MUST fail,
 * including when only the tail repeats but the first item differs.
 */

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

/** Minimal Jellyfin-shaped fake server: System/Info, Users, one library's Views, and a
 *  paginated Items endpoint driven by an injected page-producing function. */
function startPagedServer(
  pageForStartIndex: (startIndex: number) => { items: { Id: string; Name: string }[]; total: number }
): Promise<{ stop: () => Promise<void>; url: Promise<string> }> {
  let server: any;
  let port = 0;

  const urlPromise = new Promise<string>((resolve, reject) => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const path = req.url || "";

      if (path === "/System/Info") {
        res.writeHead(200);
        res.end(JSON.stringify({ Id: "test", ServerName: "Test", Version: "10.11.11" }));
        return;
      }

      if (path === "/Users") {
        res.writeHead(200);
        res.end(JSON.stringify([{ Id: "user-123", Name: "Test" }]));
        return;
      }

      if (path === "/Users/user-123/Views") {
        res.writeHead(200);
        res.end(JSON.stringify({ Items: [{ Id: "lib1", Name: "Lib1" }] }));
        return;
      }

      if (path.includes("/Users/user-123/Items")) {
        const url = new URL(path, `http://localhost:${port}`);
        const startIndex = Number.parseInt(url.searchParams.get("StartIndex") || "0", 10);
        const { items, total } = pageForStartIndex(startIndex);
        res.writeHead(200);
        res.end(JSON.stringify({ Items: items, TotalRecordCount: total }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.listen(0, "127.0.0.1", () => {
      ({ port } = server.address() as { port: number });
      resolve(`http://127.0.0.1:${port}`);
    });

    server.on("error", reject);
  });

  return Promise.resolve({
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err: any) => (err ? reject(err) : resolve()));
      }),
    url: urlPromise,
  });
}

test("regression: two distinct full pages of equal size must succeed (normal pagination)", async () => {
  const server = await startPagedServer((startIndex) => {
    if (startIndex === 0) {
      return {
        items: Array.from({ length: 500 }, (_, i) => ({ Id: `item-${i}`, Name: `Item ${i}` })),
        total: 1000,
      };
    }
    if (startIndex === 500) {
      return {
        items: Array.from({ length: 500 }, (_, i) => ({ Id: `item-${500 + i}`, Name: `Item ${500 + i}` })),
        total: 1000,
      };
    }
    return { items: [], total: 1000 };
  });
  const baseUrl = await server.url;

  try {
    let threwError = false;
    let errorMsg = "";

    const { ctx, records } = makeContext({
      credentials: { base_url: baseUrl, secret: "test-key" },
      streams: [{ name: "items" }],
    });

    await collect(ctx).catch((e) => {
      threwError = true;
      errorMsg = (e as any).message || String(e);
    });

    assert.ok(!threwError, `Should succeed with two distinct equal-sized pages, got error: ${errorMsg}`);
    const itemRecords = records.filter((r) => r.stream === "items");
    assert.equal(
      itemRecords.length,
      1000,
      `Should emit all 1000 items from two distinct pages, got ${itemRecords.length}`
    );
  } finally {
    await server.stop();
  }
});

test("regression: repeated identical page must fail (pagination doesn't advance)", async () => {
  const server = await startPagedServer(() => ({
    // Always return the SAME 100 items regardless of StartIndex; claims a huge total.
    items: Array.from({ length: 100 }, (_, i) => ({ Id: `item-${i}`, Name: `Item ${i}` })),
    total: 50_000,
  }));
  const baseUrl = await server.url;

  try {
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

    assert.ok(threwError, "Must fail when pagination returns identical pages");
    assert.ok(errorMsg.includes("non_advancing"), `Expected non-advancing error, got: ${errorMsg}`);
  } finally {
    await server.stop();
  }
});

test("regression: distinct pages that happen to share a first item ID must still succeed", async () => {
  // Page 1 = [shared, page1-0, page1-1, ..., page1-498] (500 distinct items)
  // Page 2 = [shared, page2-0, page2-1, ..., page2-498] (shares only the first item's
  //           ID — 499/500 items are genuinely different). A first-item-only guard
  //           would wrongly reject this page as non-advancing since it compares only
  //           the shared first item. A full ordered-ID fingerprint correctly accepts
  //           it, since the full sequences differ. This is the discriminating case:
  //           it is the one place first-item-only and full-sequence-fingerprint
  //           genuinely disagree — see index.ts's `pageFingerprint`.
  const server = await startPagedServer((startIndex) => {
    if (startIndex === 0) {
      return {
        items: [
          { Id: "shared-first", Name: "Shared" },
          ...Array.from({ length: 499 }, (_, i) => ({ Id: `page1-${i}`, Name: `P1 ${i}` })),
        ],
        total: 1000,
      };
    }
    if (startIndex === 500) {
      return {
        items: [
          { Id: "shared-first", Name: "Shared" },
          ...Array.from({ length: 499 }, (_, i) => ({ Id: `page2-${i}`, Name: `P2 ${i}` })),
        ],
        total: 1000,
      };
    }
    return { items: [], total: 1000 };
  });
  const baseUrl = await server.url;

  try {
    let threwError = false;
    let errorMsg = "";

    const { ctx, records } = makeContext({
      credentials: { base_url: baseUrl, secret: "test-key" },
      streams: [{ name: "items" }],
    });

    await collect(ctx).catch((e) => {
      threwError = true;
      errorMsg = (e as any).message || String(e);
    });

    assert.ok(
      !threwError,
      `Pages that differ in 499/500 items must not be flagged as repeated, got error: ${errorMsg}`
    );
    const itemRecords = records.filter((r) => r.stream === "items");
    assert.equal(itemRecords.length, 1000, `Should emit all 1000 items, got ${itemRecords.length}`);
  } finally {
    await server.stop();
  }
});
