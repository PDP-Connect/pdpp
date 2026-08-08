// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Primary credential path: POST /Users/AuthenticateByName.
 *
 * A Jellyfin API key is admin-dashboard-only — a non-admin user cannot
 * generate one, which locks every non-admin out of their own library.
 * AuthenticateByName is available to ANY account and returns both an
 * AccessToken and User.Id in one call, so identity is never a separate
 * guess.
 *
 * SAFETY, non-negotiable: a malformed MediaBrowser Authorization header on
 * this exact endpoint wipes the server's entire Devices table
 * (jellyfin/jellyfin#11484), and that defect does not require admin rights
 * to trigger. buildMediaBrowserAuthHeader's shape is pinned directly here so
 * a future edit cannot silently drop a field.
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";
import type { CollectContext, EmittedMessage, RecordData, StreamScope } from "../../src/connector-runtime.ts";
import { buildMediaBrowserAuthHeader, collect, deriveStableDeviceId } from "./index.ts";

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

// ─── buildMediaBrowserAuthHeader: pin the header shape ─────────────────────
//
// jellyfin/jellyfin#11484: a malformed Authorization header on
// /Users/AuthenticateByName wipes the server's ENTIRE Devices table, and a
// non-admin can trigger it. These assertions exist so a future edit that
// drops or malforms a field is caught here, not live against a real server.

test("buildMediaBrowserAuthHeader produces the well-formed MediaBrowser shape", () => {
  const header = buildMediaBrowserAuthHeader("abc123deviceid");

  assert.match(header, /^MediaBrowser /, "must start with the MediaBrowser scheme");
  assert.match(header, /Client="[^"]+"/, "must carry a quoted Client field");
  assert.match(header, /Device="[^"]+"/, "must carry a quoted Device field");
  assert.match(header, /DeviceId="abc123deviceid"/, "must carry the exact DeviceId passed in");
  assert.match(header, /Version="[^"]+"/, "must carry a quoted Version field");

  // Every comma-separated key=value pair must be present — a header missing
  // any one of these four fields is the malformed shape that trips the
  // Devices-table wipe.
  for (const field of ["Client", "Device", "DeviceId", "Version"]) {
    assert.ok(header.includes(`${field}="`), `header must include ${field}=`);
  }
});

test("buildMediaBrowserAuthHeader refuses to build a header with an empty DeviceId", () => {
  assert.throws(() => buildMediaBrowserAuthHeader(""), /device_id_empty/);
});

test("deriveStableDeviceId is deterministic for the same seed and non-empty", () => {
  const a = deriveStableDeviceId("https://jellyfin.example.com alice");
  const b = deriveStableDeviceId("https://jellyfin.example.com alice");
  const c = deriveStableDeviceId("https://jellyfin.example.com bob");

  assert.equal(a, b, "same seed must yield the same device id across runs");
  assert.notEqual(a, c, "different seeds must yield different device ids");
  assert.ok(a.length > 0);
});

// ─── Fake Jellyfin server: AuthenticateByName + user-scoped endpoints ──────

class FakeJellyfinAuthServer {
  private server: any;
  private port = 0;
  private readonly requestLog: Array<{
    method: string;
    path: string;
    headers: Record<string, string>;
    body: string;
  }> = [];
  private authResponse: "success" | "unauthorized" | "no_access_token" | "no_user_id" = "success";

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

        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          this.requestLog.push({ method: req.method || "GET", path, headers, body });
          this.route(req, res, path, headers, body);
        });
      });

      this.server.listen(0, "127.0.0.1", () => {
        this.port = (this.server.address() as any).port;
        resolve(`http://127.0.0.1:${this.port}`);
      });

      this.server.on("error", reject);
    });
  }

  private route(
    _req: IncomingMessage,
    res: ServerResponse,
    path: string,
    headers: Record<string, string>,
    body: string
  ) {
    if (path === "/Users/AuthenticateByName") {
      if (_req.method !== "POST") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      // Never accept the ApiKey=/api_key= query-param form on this endpoint.
      if (path.includes("api_key=") || path.includes("ApiKey=")) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "credential must not be in query params" }));
        return;
      }
      const authHeader = headers.authorization || "";
      if (!authHeader.startsWith("MediaBrowser ")) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "malformed MediaBrowser header" }));
        return;
      }
      let parsedBody: Record<string, unknown> = {};
      try {
        parsedBody = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "invalid body" }));
        return;
      }
      if (parsedBody.Username !== "alice" || parsedBody.Pw !== "correct-password") {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "invalid credentials" }));
        return;
      }

      if (this.authResponse === "unauthorized") {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (this.authResponse === "no_access_token") {
        res.writeHead(200);
        res.end(JSON.stringify({ User: { Id: "user-alice-1" } }));
        return;
      }
      if (this.authResponse === "no_user_id") {
        res.writeHead(200);
        res.end(JSON.stringify({ AccessToken: "synthetic-access-token" }));
        return;
      }
      res.writeHead(200);
      res.end(
        JSON.stringify({
          AccessToken: "synthetic-access-token",
          User: { Id: "user-alice-1", Name: "alice" },
        })
      );
      return;
    }

    if (path === "/System/Info") {
      res.writeHead(200);
      res.end(JSON.stringify({ Id: "test-server-id", ServerName: "Test Jellyfin", Version: "10.11.11" }));
      return;
    }

    if (path === "/Users/user-alice-1/Views") {
      if (headers["x-emby-token"] !== "synthetic-access-token") {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify({ Items: [{ Id: "lib1", Name: "Movies", CollectionType: "movies" }] }));
      return;
    }

    if (path.includes("/Users/user-alice-1/Items")) {
      if (headers["x-emby-token"] !== "synthetic-access-token") {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify({ Items: [], TotalRecordCount: 0 }));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
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

  setAuthResponse(mode: typeof this.authResponse) {
    this.authResponse = mode;
  }
}

test("e2e: username+password (primary path) authenticates via AuthenticateByName and derives userId from the response", async () => {
  const server = new FakeJellyfinAuthServer();
  const baseUrl = await server.start();

  try {
    const { ctx, records } = makeContext({
      credentials: { base_url: baseUrl, username: "alice", password: "correct-password" },
      streams: [{ name: "libraries" }],
    });

    await collect(ctx);

    const libraryRecords = records.filter((r) => r.stream === "libraries");
    assert.equal(libraryRecords.length, 1, "should collect using the userId derived from AuthenticateByName");

    const authRequest = server.getRequestLog().find((r) => r.path === "/Users/AuthenticateByName");
    assert.ok(authRequest, "must call POST /Users/AuthenticateByName");
    assert.equal(authRequest.method, "POST");

    // Never the ApiKey=/api_key= query form — header auth only.
    for (const req of server.getRequestLog()) {
      assert(!req.path.includes("api_key="), `request must not carry api_key in query: ${req.path}`);
      assert(!req.path.includes("ApiKey="), `request must not carry ApiKey in query: ${req.path}`);
      assert(!req.path.includes("correct-password"), `request path must never expose the password: ${req.path}`);
    }

    // Downstream requests use the returned AccessToken via X-Emby-Token, not
    // the raw password.
    const viewsRequest = server.getRequestLog().find((r) => r.path === "/Users/user-alice-1/Views");
    assert.ok(viewsRequest, "must fetch views for the userId returned by AuthenticateByName");
    assert.equal(viewsRequest.headers["x-emby-token"], "synthetic-access-token");
  } finally {
    await server.stop();
  }
});

test("e2e: AuthenticateByName request body never carries the api_key form and the auth header is well-formed MediaBrowser", async () => {
  const server = new FakeJellyfinAuthServer();
  const baseUrl = await server.start();

  try {
    const { ctx } = makeContext({
      credentials: { base_url: baseUrl, username: "alice", password: "correct-password" },
      streams: [{ name: "libraries" }],
    });

    await collect(ctx);

    const authRequest = server.getRequestLog().find((r) => r.path === "/Users/AuthenticateByName");
    assert.ok(authRequest);
    assert.match(authRequest.headers.authorization ?? "", /^MediaBrowser Client="[^"]+", Device="[^"]+"/);
    assert.match(authRequest.headers.authorization ?? "", /DeviceId="[^"]+"/);
    assert.match(authRequest.headers.authorization ?? "", /Version="[^"]+"/);

    const parsedBody = JSON.parse(authRequest.body);
    assert.equal(parsedBody.Username, "alice");
    assert.equal(parsedBody.Pw, "correct-password");
  } finally {
    await server.stop();
  }
});

test("e2e: failed AuthenticateByName surfaces the real 401, never a fabricated identity", async () => {
  const server = new FakeJellyfinAuthServer();
  const baseUrl = await server.start();
  server.setAuthResponse("unauthorized");

  try {
    const { ctx } = makeContext({
      credentials: { base_url: baseUrl, username: "alice", password: "wrong-password" },
      streams: [{ name: "libraries" }],
    });

    await assert.rejects(() => collect(ctx), /jellyfin_auth_failed/);
  } finally {
    await server.stop();
  }
});

test("e2e: AuthenticateByName response missing AccessToken fails the run rather than proceeding without a credential", async () => {
  const server = new FakeJellyfinAuthServer();
  const baseUrl = await server.start();
  server.setAuthResponse("no_access_token");

  try {
    const { ctx } = makeContext({
      credentials: { base_url: baseUrl, username: "alice", password: "correct-password" },
      streams: [{ name: "libraries" }],
    });

    await assert.rejects(() => collect(ctx), /jellyfin_authenticate_by_name_no_access_token/);
  } finally {
    await server.stop();
  }
});

test("e2e: AuthenticateByName response missing User.Id fails the run rather than fabricating an identity", async () => {
  const server = new FakeJellyfinAuthServer();
  const baseUrl = await server.start();
  server.setAuthResponse("no_user_id");

  try {
    const { ctx } = makeContext({
      credentials: { base_url: baseUrl, username: "alice", password: "correct-password" },
      streams: [{ name: "libraries" }],
    });

    await assert.rejects(() => collect(ctx), /jellyfin_authenticate_by_name_no_user_id/);
  } finally {
    await server.stop();
  }
});

test("primary path takes precedence: username+password present alongside an api_key still authenticates via AuthenticateByName", async () => {
  const server = new FakeJellyfinAuthServer();
  const baseUrl = await server.start();

  try {
    const { ctx, records } = makeContext({
      credentials: {
        base_url: baseUrl,
        username: "alice",
        password: "correct-password",
        secret: "some-admin-api-key",
      },
      streams: [{ name: "libraries" }],
    });

    await collect(ctx);

    const authRequest = server.getRequestLog().find((r) => r.path === "/Users/AuthenticateByName");
    assert.ok(authRequest, "primary path must be used even when an api_key is also present");
    assert.ok(records.some((r) => r.stream === "libraries"));
  } finally {
    await server.stop();
  }
});

test("only one of username/password present is treated as the primary path being absent (never a partial credential)", async () => {
  const server = new FakeJellyfinAuthServer();
  const baseUrl = await server.start();

  try {
    const { ctx } = makeContext({
      credentials: { base_url: baseUrl, username: "alice" },
      streams: [{ name: "libraries" }],
    });

    await assert.rejects(() => collect(ctx), /jellyfin_missing_credentials/);

    const authRequests = server.getRequestLog().filter((r) => r.path === "/Users/AuthenticateByName");
    assert.equal(authRequests.length, 0, "must not call AuthenticateByName with only half the credential");
  } finally {
    await server.stop();
  }
});

test("missing credentials entirely (no username/password, no api_key) fails fast with jellyfin_missing_credentials", async () => {
  const { ctx } = makeContext({
    credentials: { base_url: "https://jellyfin.example.com" },
    streams: [{ name: "libraries" }],
  });

  await assert.rejects(() => collect(ctx), /jellyfin_missing_credentials/);
});
