// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for P0 correctness bug: an unresolvable user ID (Users/Me
 * fails, or succeeds with no Id field) must FAIL the run carrying the real
 * Users/Me error, never proceed with a fabricated placeholder user ID.
 *
 * A fabricated ID ("00000000000000000000000000000000") makes every
 * downstream Users/{id}/Views and Users/{id}/Items call 400, which surfaces
 * a generic "Error processing request" that hides the real Users/Me failure
 * (auth shape, unsupported endpoint, malformed response).
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

/** Fake server whose /Users/Me response is fully controlled by the test. */
function startServer(usersMeHandler: (res: ServerResponse) => void): Promise<{
  stop: () => Promise<void>;
  url: Promise<string>;
}> {
  let server: any;

  const urlPromise = new Promise<string>((resolve, reject) => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const path = req.url || "";

      if (path === "/System/Info") {
        res.writeHead(200);
        res.end(JSON.stringify({ Id: "test", ServerName: "Test", Version: "10.11.11" }));
        return;
      }

      if (path === "/Users/Me") {
        usersMeHandler(res);
        return;
      }

      // Any Users/{id}/... request means resolveUserId proceeded past a bad
      // Users/Me response — exactly the fabrication bug under test.
      res.writeHead(404);
      res.end();
    });

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
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

test("regression: Users/Me 401 must fail the run with the real auth error, not a placeholder user id", async () => {
  const server = await startServer((res) => {
    res.writeHead(401);
    res.end(JSON.stringify({ Message: "Unauthenticated" }));
  });
  const baseUrl = await server.url;

  try {
    let threwError = false;
    let errorMsg = "";

    const { ctx } = makeContext({
      credentials: { base_url: baseUrl, secret: "test-key" },
      streams: [{ name: "libraries" }],
    });

    await collect(ctx).catch((e) => {
      threwError = true;
      errorMsg = (e as any).message || String(e);
    });

    assert.ok(threwError, "Must fail the run when Users/Me fails, not silently substitute a fallback user id");
    assert.ok(
      errorMsg.includes("jellyfin_auth_failed"),
      `Error must carry the real Users/Me failure reason, got: ${errorMsg}`
    );
  } finally {
    await server.stop();
  }
});

test("regression: Users/Me 400 with a body must fail the run carrying that body, not a fabricated 400 from a fake user id", async () => {
  // 400 is non-retryable (unlike 5xx/429/408), so this exercises resolveUserId's
  // own error-propagation directly rather than the http governor's retry/backoff path.
  const server = await startServer((res) => {
    res.writeHead(400);
    res.end(JSON.stringify({ Message: "Error processing request for Users/Me" }));
  });
  const baseUrl = await server.url;

  try {
    let threwError = false;
    let errorMsg = "";

    const { ctx } = makeContext({
      credentials: { base_url: baseUrl, secret: "test-key" },
      streams: [{ name: "libraries" }],
    });

    await collect(ctx).catch((e) => {
      threwError = true;
      errorMsg = (e as any).message || String(e);
    });

    assert.ok(threwError, "Must fail the run when Users/Me fails");
    assert.ok(
      errorMsg.includes("jellyfin_http_400") && errorMsg.includes("Error processing request for Users/Me"),
      `Error must carry Users/Me's real status and body, got: ${errorMsg}`
    );
  } finally {
    await server.stop();
  }
});

test("regression: Users/Me success with no Id field must fail the run, not substitute a placeholder user id", async () => {
  const server = await startServer((res) => {
    res.writeHead(200);
    // Malformed/unexpected shape: 200 OK but no Id field.
    res.end(JSON.stringify({ Name: "Someone" }));
  });
  const baseUrl = await server.url;

  try {
    let threwError = false;
    let errorMsg = "";

    const { ctx } = makeContext({
      credentials: { base_url: baseUrl, secret: "test-key" },
      streams: [{ name: "libraries" }],
    });

    await collect(ctx).catch((e) => {
      threwError = true;
      errorMsg = (e as any).message || String(e);
    });

    assert.ok(threwError, "Must fail the run when Users/Me returns no Id, not fabricate one");
    assert.ok(
      errorMsg.includes("jellyfin_user_id_missing"),
      `Error must name the missing-Id condition, got: ${errorMsg}`
    );
  } finally {
    await server.stop();
  }
});

test("regression: successful Users/Me with a real Id must still work end-to-end", async () => {
  let server: any;
  const urlPromise = new Promise<string>((resolve, reject) => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const path = req.url || "";
      if (path === "/System/Info") {
        res.writeHead(200);
        res.end(JSON.stringify({ Id: "test", ServerName: "Test", Version: "10.11.11" }));
        return;
      }
      if (path === "/Users/Me") {
        res.writeHead(200);
        res.end(JSON.stringify({ Id: "real-user-id", Name: "Test" }));
        return;
      }
      if (path === "/Users/real-user-id/Views") {
        res.writeHead(200);
        res.end(JSON.stringify({ Items: [{ Id: "lib1", Name: "Lib1" }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve(`http://127.0.0.1:${port}`);
    });
    server.on("error", reject);
  });
  const baseUrl = await urlPromise;

  try {
    const { ctx, records } = makeContext({
      credentials: { base_url: baseUrl, secret: "test-key" },
      streams: [{ name: "libraries" }],
    });

    await collect(ctx);

    const libraryRecords = records.filter((r) => r.stream === "libraries");
    assert.equal(libraryRecords.length, 1, "Should fetch libraries using the real resolved user id");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err: any) => (err ? reject(err) : resolve()));
    });
  }
});
