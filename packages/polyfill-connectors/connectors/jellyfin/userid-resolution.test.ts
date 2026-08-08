// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for user-ID resolution.
 *
 * P0 correctness bug (still guarded here): an unresolvable user ID must FAIL
 * the run carrying the real error, never proceed with a fabricated
 * placeholder user ID. A fabricated ID ("00000000000000000000000000000000")
 * makes every downstream Users/{id}/Views and Users/{id}/Items call 400,
 * which surfaces a generic "Error processing request" that hides the real
 * failure (auth shape, unsupported endpoint, malformed response).
 *
 * Resolution order, most helpful first:
 *   (a) owner-supplied user id or username (the jellyfin_user_id setup
 *       field), matched against GET /Users
 *   (b) GET /Users/Me, if it returns a concrete user — a dashboard-issued
 *       API key has no "current user" context and 400s here even though the
 *       same key authenticates fine against /System/Info and /Users
 *       (confirmed against jellyfin/jellyfin#14559), but a user-scoped
 *       token might succeed
 *   (c) GET /Users (list), if it has exactly one user — unambiguous
 *   (d) otherwise fail honestly, naming a bounded sample of usernames and
 *       the setup field to configure
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

/** Fake server whose /Users response is fully controlled by the test. */
function startServer(usersHandler: (res: ServerResponse) => void): Promise<{
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

      if (path === "/Users") {
        usersHandler(res);
        return;
      }

      // Any Users/{id}/... request means resolveUserId proceeded past a bad
      // Users response — exactly the fabrication bug under test.
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

/**
 * Fake server with full route control: /System/Info always succeeds,
 * /Users and /Users/Me are handled by the given handlers, and
 * /Users/{id}/Views resolves with a single library so the resolution
 * outcome (which user id was actually used) is directly observable via the
 * emitted library record.
 */
function startResolutionServer({
  usersHandler,
  usersMeHandler,
}: {
  usersHandler: (res: ServerResponse) => void;
  usersMeHandler?: (res: ServerResponse) => void;
}): Promise<{
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
        if (usersMeHandler) {
          usersMeHandler(res);
        } else {
          res.writeHead(400);
          res.end(JSON.stringify({ Message: "no current user for this key" }));
        }
        return;
      }

      if (path === "/Users") {
        usersHandler(res);
        return;
      }

      const viewsMatch = path.match(/^\/Users\/([^/]+)\/Views$/);
      if (viewsMatch) {
        res.writeHead(200);
        res.end(JSON.stringify({ Items: [{ Id: `lib-for-${viewsMatch[1]}`, Name: "Lib" }] }));
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

  return Promise.resolve({
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err: any) => (err ? reject(err) : resolve()));
      }),
    url: urlPromise,
  });
}

test("regression: Users 401 must fail the run with the real auth error, not a placeholder user id", async () => {
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

    assert.ok(threwError, "Must fail the run when Users fails, not silently substitute a fallback user id");
    assert.ok(
      errorMsg.includes("jellyfin_auth_failed"),
      `Error must carry the real Users failure reason, got: ${errorMsg}`
    );
  } finally {
    await server.stop();
  }
});

test("regression: Users 400 with a body must fail the run carrying that body, not a fabricated 400 from a fake user id", async () => {
  // 400 is non-retryable (unlike 5xx/429/408), so this exercises resolveUserId's
  // own error-propagation directly rather than the http governor's retry/backoff path.
  const server = await startServer((res) => {
    res.writeHead(400);
    res.end(JSON.stringify({ Message: "Error processing request for Users" }));
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

    assert.ok(threwError, "Must fail the run when Users fails");
    assert.ok(
      errorMsg.includes("jellyfin_http_400") && errorMsg.includes("Error processing request for Users"),
      `Error must carry Users' real status and body, got: ${errorMsg}`
    );
  } finally {
    await server.stop();
  }
});

test("regression: Users success with no users must fail the run, not substitute a placeholder user id", async () => {
  const server = await startServer((res) => {
    res.writeHead(200);
    res.end(JSON.stringify([]));
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

    assert.ok(threwError, "Must fail the run when Users returns no users, not fabricate one");
    assert.ok(errorMsg.includes("jellyfin_no_users"), `Error must name the no-users condition, got: ${errorMsg}`);
  } finally {
    await server.stop();
  }
});

test("regression: Users success with more than one user must fail the run, not guess which one to collect as", async () => {
  const server = await startServer((res) => {
    res.writeHead(200);
    res.end(
      JSON.stringify([
        { Id: "user-a", Name: "A" },
        { Id: "user-b", Name: "B" },
      ])
    );
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

    assert.ok(threwError, "Must fail the run when multiple users exist, not guess one");
    assert.ok(
      errorMsg.includes("jellyfin_ambiguous_user"),
      `Error must name the ambiguous-user condition, got: ${errorMsg}`
    );
  } finally {
    await server.stop();
  }
});

test("regression: Users success with a user entry missing Id must fail the run, not substitute a placeholder user id", async () => {
  const server = await startServer((res) => {
    res.writeHead(200);
    // Malformed/unexpected shape: 200 OK, one user, but no Id field.
    res.end(JSON.stringify([{ Name: "Someone" }]));
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

    assert.ok(threwError, "Must fail the run when the sole user has no Id, not fabricate one");
    assert.ok(
      errorMsg.includes("jellyfin_user_id_missing"),
      `Error must name the missing-Id condition, got: ${errorMsg}`
    );
  } finally {
    await server.stop();
  }
});

test("regression: Users success with a non-array body must fail the run, not substitute a placeholder user id", async () => {
  const server = await startServer((res) => {
    res.writeHead(200);
    res.end(JSON.stringify({ not: "an array" }));
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

    assert.ok(threwError, "Must fail the run when Users response is not an array");
    assert.ok(
      errorMsg.includes("jellyfin_users_response_malformed"),
      `Error must name the malformed-response condition, got: ${errorMsg}`
    );
  } finally {
    await server.stop();
  }
});

test("regression: successful single-user Users response must still work end-to-end", async () => {
  let server: any;
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
        res.end(JSON.stringify([{ Id: "real-user-id", Name: "Test" }]));
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

// ─── Resolution order: owner-supplied id/username, Users/Me, single-user, ambiguous ──

test("resolution: owner-supplied user id (matched against Users by Id) is used even with multiple users on the server", async () => {
  const server = await startResolutionServer({
    usersHandler: (res) => {
      res.writeHead(200);
      res.end(
        JSON.stringify([
          { Id: "user-a", Name: "Alice" },
          { Id: "user-b", Name: "Bob" },
        ])
      );
    },
  });
  const baseUrl = await server.url;

  try {
    const { ctx, records } = makeContext({
      credentials: { base_url: baseUrl, secret: "test-key", jellyfin_user_id: "user-b" },
      streams: [{ name: "libraries" }],
    });

    await collect(ctx);

    const libraryRecords = records.filter((r) => r.stream === "libraries");
    assert.equal(libraryRecords.length, 1);
    assert.equal(libraryRecords[0]?.data.id, "lib-for-user-b", "Must collect as the owner-specified user id");
  } finally {
    await server.stop();
  }
});

test("resolution: owner-supplied username (matched against Users by Name, case-insensitive) is used", async () => {
  const server = await startResolutionServer({
    usersHandler: (res) => {
      res.writeHead(200);
      res.end(
        JSON.stringify([
          { Id: "user-a", Name: "Alice" },
          { Id: "user-b", Name: "Bob" },
        ])
      );
    },
  });
  const baseUrl = await server.url;

  try {
    const { ctx, records } = makeContext({
      credentials: { base_url: baseUrl, secret: "test-key", jellyfin_user_id: "bob" },
      streams: [{ name: "libraries" }],
    });

    await collect(ctx);

    const libraryRecords = records.filter((r) => r.stream === "libraries");
    assert.equal(libraryRecords[0]?.data.id, "lib-for-user-b", "Must resolve the username to user-b's id");
  } finally {
    await server.stop();
  }
});

test("resolution: owner-supplied identifier that matches no user must fail the run, not fall through to guessing", async () => {
  const server = await startResolutionServer({
    usersHandler: (res) => {
      res.writeHead(200);
      res.end(
        JSON.stringify([
          { Id: "user-a", Name: "Alice" },
          { Id: "user-b", Name: "Bob" },
        ])
      );
    },
  });
  const baseUrl = await server.url;

  try {
    let threwError = false;
    let errorMsg = "";

    const { ctx } = makeContext({
      credentials: { base_url: baseUrl, secret: "test-key", jellyfin_user_id: "nonexistent-user" },
      streams: [{ name: "libraries" }],
    });

    await collect(ctx).catch((e) => {
      threwError = true;
      errorMsg = (e as any).message || String(e);
    });

    assert.ok(threwError, "Must fail when the configured user id/username matches no user");
    assert.ok(
      errorMsg.includes("jellyfin_configured_user_not_found"),
      `Error must name the not-found condition, got: ${errorMsg}`
    );
  } finally {
    await server.stop();
  }
});

test("resolution: Users/Me returning a concrete user is used when no owner-supplied id is set", async () => {
  const server = await startResolutionServer({
    usersHandler: (res) => {
      res.writeHead(200);
      res.end(
        JSON.stringify([
          { Id: "user-a", Name: "Alice" },
          { Id: "user-b", Name: "Bob" },
        ])
      );
    },
    usersMeHandler: (res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ Id: "user-a", Name: "Alice" }));
    },
  });
  const baseUrl = await server.url;

  try {
    const { ctx, records } = makeContext({
      credentials: { base_url: baseUrl, secret: "test-key" },
      streams: [{ name: "libraries" }],
    });

    await collect(ctx);

    const libraryRecords = records.filter((r) => r.stream === "libraries");
    assert.equal(libraryRecords[0]?.data.id, "lib-for-user-a", "Must collect as the Users/Me-resolved user");
  } finally {
    await server.stop();
  }
});

test("resolution: owner-supplied id takes priority over Users/Me even when Users/Me resolves a different user", async () => {
  const server = await startResolutionServer({
    usersHandler: (res) => {
      res.writeHead(200);
      res.end(
        JSON.stringify([
          { Id: "user-a", Name: "Alice" },
          { Id: "user-b", Name: "Bob" },
        ])
      );
    },
    usersMeHandler: (res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ Id: "user-a", Name: "Alice" }));
    },
  });
  const baseUrl = await server.url;

  try {
    const { ctx, records } = makeContext({
      credentials: { base_url: baseUrl, secret: "test-key", jellyfin_user_id: "user-b" },
      streams: [{ name: "libraries" }],
    });

    await collect(ctx);

    const libraryRecords = records.filter((r) => r.stream === "libraries");
    assert.equal(
      libraryRecords[0]?.data.id,
      "lib-for-user-b",
      "Owner-supplied user id must win over Users/Me's answer"
    );
  } finally {
    await server.stop();
  }
});

test("resolution: Users/Me 400 (dashboard API key, no current-user context) falls through to the exactly-one-user case", async () => {
  const server = await startResolutionServer({
    usersHandler: (res) => {
      res.writeHead(200);
      res.end(JSON.stringify([{ Id: "only-user", Name: "Solo" }]));
    },
    // default usersMeHandler is a 400, matching a real dashboard-issued API key
  });
  const baseUrl = await server.url;

  try {
    const { ctx, records } = makeContext({
      credentials: { base_url: baseUrl, secret: "test-key" },
      streams: [{ name: "libraries" }],
    });

    await collect(ctx);

    const libraryRecords = records.filter((r) => r.stream === "libraries");
    assert.equal(libraryRecords[0]?.data.id, "lib-for-only-user");
  } finally {
    await server.stop();
  }
});

test("resolution: ambiguous-user error names a bounded sample of usernames and the setup field, never user ids", async () => {
  const manyUsers = Array.from({ length: 28 }, (_, i) => ({ Id: `user-id-${i}`, Name: `User${i}` }));
  const server = await startResolutionServer({
    usersHandler: (res) => {
      res.writeHead(200);
      res.end(JSON.stringify(manyUsers));
    },
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

    assert.ok(threwError, "Must fail with 28 users and no owner-supplied disambiguation");
    assert.ok(errorMsg.includes("jellyfin_ambiguous_user"));
    assert.ok(errorMsg.includes("28 users"), `Error must state the count, got: ${errorMsg}`);
    assert.ok(
      errorMsg.includes("Jellyfin User ID or Username"),
      `Error must name the manifest field to set, got: ${errorMsg}`
    );
    assert.ok(errorMsg.includes("User0"), `Error must include a sample username, got: ${errorMsg}`);
    // Bounded sample, not the full 28-user roster.
    assert.ok(!errorMsg.includes("User27"), `Error must not dump the full user roster, got: ${errorMsg}`);
    // Never leak user ids in the ambiguous-user error — only display names and a count.
    assert.ok(!errorMsg.includes("user-id-0"), `Error must not include user ids, got: ${errorMsg}`);
  } finally {
    await server.stop();
  }
});

test("resolution: confirm the exactly-one-user guard is load-bearing — Users/Me disabled AND no owner id must still fail on 2+ users", async () => {
  // This is the same server shape as "ambiguous-user error names..." above but
  // asserts specifically that removing the len>1 guard would let this proceed:
  // pickUserId's `users.length > 1` branch is the only thing standing between
  // a 2-user server and silently collecting as users[0] via naive array indexing.
  const server = await startResolutionServer({
    usersHandler: (res) => {
      res.writeHead(200);
      res.end(
        JSON.stringify([
          { Id: "user-a", Name: "Alice" },
          { Id: "user-b", Name: "Bob" },
        ])
      );
    },
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

    assert.ok(threwError, "A 2-user server with no disambiguation must never silently pick one");
    assert.ok(errorMsg.includes("jellyfin_ambiguous_user"));
  } finally {
    await server.stop();
  }
});
