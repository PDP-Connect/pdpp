// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Root cause (independent red-team reproduction against local/uat-candidate-0810
 * HEAD 439072a41, 2026-08-11): the single-repair self-heal introduced by
 * `late-auth-self-heal.test.ts` re-authenticates unconditionally on every
 * 401/403 — there is no run-scoped budget. Against a server that revokes the
 * token again shortly after each self-heal (not just once), every single
 * request across every library/page independently triggers its own
 * `AuthenticateByName` call: for 3 libraries x 4 pages, that is up to 12
 * automated login attempts in one run, scaling with `libraries * pages`. The
 * run's own coverage machinery has no visibility into how many logins were
 * attempted, so a run that eventually recovers on every individual retry
 * still reports full GREEN coverage — the defect is invisible from the
 * run's own reported result.
 *
 * Fix: a single `createRepairBudget()` instance (the shared provider-neutral
 * primitive in `src/repair-budget.ts`), constructed once in `collect()`
 * before either stream runs and threaded through `resolveConnection` into
 * the `conn.reauth` closure — the sole spender. Once any call this run has
 * attempted a self-heal login, every subsequent 401/403 gets `undefined`
 * back immediately (identical to "no self-heal available"), so
 * `jellyfinRequest` throws the same terminal `jellyfin_auth_failed` a real
 * bad password would produce. That failure propagates out of
 * `collectItemsForLibrary`/`collectItems` to `collect()`'s catch, which
 * emits `SKIP_RESULT` for both streams INSTEAD OF a coverage message — so a
 * run that exhausts the budget cannot read green, and whatever records were
 * already emitted before the failure are preserved (this connector has no
 * rollback-on-error).
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";
import type { CollectContext, EmittedMessage, RecordData, StreamScope } from "../../src/connector-runtime.ts";
import { collect } from "./index.ts";

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

/**
 * Fake server that models a session which is revoked again shortly after
 * EVERY self-heal — not just once. `AuthenticateByName` always succeeds and
 * always mints a genuinely fresh token (so `jellyfinRequest`'s
 * `freshToken !== apiKey` retry gate always passes and the retried request
 * always succeeds), but the very next request presented with that token also
 * 401s, forcing another self-heal. Without a run-scoped budget this drives
 * one automated login per request that would otherwise 401 — for
 * `libraryCount` libraries each paginated across `pagesPerLibrary` pages,
 * that is up to `libraryCount * pagesPerLibrary` logins in a single run.
 *
 * Each of the first `libraryCount` requests to a library's page succeeds
 * once with a fresh token, then that token is immediately revoked before the
 * next request (whether the next page of the same library or the first page
 * of the next library) — so every page boundary is a fresh 401.
 */
class FakeJellyfinRepeatedRevocationServer {
  private server: any;
  private port = 0;
  private tokenCounter = 0;
  private currentToken = "";
  private revoked = false;
  private readonly libraryCount: number;
  private readonly pagesPerLibrary: number;
  private readonly itemsPerPage = 10;
  readonly authCalls: string[] = [];
  readonly itemsRequestOutcomes: Array<{ path: string; status: number }> = [];

  constructor(libraryCount: number, pagesPerLibrary: number) {
    this.libraryCount = libraryCount;
    this.pagesPerLibrary = pagesPerLibrary;
  }

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
          this.route(res, path, headers);
        });
      });
      this.server.listen(0, "127.0.0.1", () => {
        this.port = (this.server.address() as any).port;
        resolve(`http://127.0.0.1:${this.port}`);
      });
      this.server.on("error", reject);
    });
  }

  private route(res: ServerResponse, path: string, headers: Record<string, string>) {
    if (path === "/Users/AuthenticateByName") {
      this.tokenCounter += 1;
      this.currentToken = `token-${this.tokenCounter}`;
      this.revoked = false;
      this.authCalls.push(this.currentToken);
      res.writeHead(200);
      res.end(JSON.stringify({ AccessToken: this.currentToken, User: { Id: "user-alice-1", Name: "alice" } }));
      return;
    }

    if (path === "/Users/user-alice-1/Views") {
      const presented = headers["x-emby-token"] ?? "";
      if (presented !== this.currentToken || this.revoked) {
        this.itemsRequestOutcomes.push({ path, status: 401 });
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }
      this.itemsRequestOutcomes.push({ path, status: 200 });
      // Revoke immediately after serving Views, so the first Items request
      // (of library 1's first page) also finds a dead token.
      this.revoked = true;
      const items = Array.from({ length: this.libraryCount }, (_, i) => ({
        CollectionType: "movies",
        Id: `lib${i + 1}`,
        Name: `Library ${i + 1}`,
      }));
      res.writeHead(200);
      res.end(JSON.stringify({ Items: items }));
      return;
    }

    if (path.includes("/Users/user-alice-1/Items")) {
      const presented = headers["x-emby-token"] ?? "";

      if (presented !== this.currentToken || this.revoked) {
        this.itemsRequestOutcomes.push({ path, status: 401 });
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }

      this.itemsRequestOutcomes.push({ path, status: 200 });
      // Revoke immediately after serving this page, so the very next request
      // (next page, or next library's Items) also 401s. This models a
      // session that dies again after every single self-heal, not just once.
      this.revoked = true;

      const url = new URL(path, `http://localhost:${this.port}`);
      const startIndex = Number.parseInt(url.searchParams.get("StartIndex") || "0", 10);
      const totalCount = this.itemsPerPage * this.pagesPerLibrary;
      const items = Array.from({ length: Math.min(this.itemsPerPage, totalCount - startIndex) }, (_, i) => ({
        Id: `${path.split("ParentId=")[1]?.split("&")[0]}-item-${startIndex + i}`,
        Name: `Item ${startIndex + i}`,
        Type: "Movie",
        UserData: { PlayCount: 0, Played: false },
      }));
      res.writeHead(200);
      res.end(JSON.stringify({ Items: items, TotalRecordCount: totalCount }));
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
}

test("discriminating oracle: repeated revocation across 3 libraries x 4 pages triggers AT MOST ONE automated login per run (not 12), and the run does not report green", async () => {
  // Item page size is fixed at 500 in the real connector (collectItemsForLibrary),
  // so a fake server can't cheaply force 4 real pages per library without huge
  // fixtures. This oracle instead proves the budget directly against the shape
  // that matters: N distinct 401 boundaries (3 libraries here) each of which
  // would, pre-fix, independently spend its own login. A itemsPerPage=10 with
  // small TotalRecordCount already produces the multi-boundary shape (library's
  // Views fetch + each library's first Items page = library boundaries); the
  // discriminating assertion is the login COUNT, not the literal page count.
  const server = new FakeJellyfinRepeatedRevocationServer(3, 1);
  const baseUrl = await server.start();

  try {
    const { ctx, messages } = makeContext({
      credentials: { base_url: baseUrl, username: "alice", password: "correct-password" },
      streams: [{ name: "libraries" }, { name: "items" }],
    });

    await assert.rejects(() => collect(ctx), /jellyfin_auth_failed/);

    // Pre-fix, this exact scenario (a fresh 401 boundary after every serve)
    // would have produced one AuthenticateByName call per boundary hit: the
    // initial sign-in, plus one per subsequent 401 encountered before the
    // fix's absent budget was introduced. The discriminating assertion: no
    // matter how many boundaries the run encounters, at most ONE of them
    // (the very first) may trigger a self-heal login. Sign-in (1) + at most
    // one mid-run self-heal (1) = 2, never 12.
    assert.ok(
      server.authCalls.length <= 2,
      `run-scoped budget must cap logins at sign-in + one self-heal (<=2), got ${server.authCalls.length}`
    );

    // The run must not report a coverage message for `items` — a genuine
    // failure that exhausts the budget must produce SKIP_RESULT, not a
    // DETAIL_COVERAGE that would let the run read green despite dropped data.
    const itemsCoverage = messages.find(
      (m) => m.type === "DETAIL_COVERAGE" && (m as { stream?: string }).stream === "items"
    );
    assert.equal(itemsCoverage, undefined, "a budget-exhausted run must not emit items coverage (cannot read green)");

    const itemsSkip = messages.find((m) => m.type === "SKIP_RESULT" && (m as { stream?: string }).stream === "items");
    assert.notEqual(itemsSkip, undefined, "a budget-exhausted run must emit an honest SKIP_RESULT for items");
  } finally {
    await server.stop();
  }
});

test("cross-stream budget: a self-heal spent during the libraries stream is not available again during the items stream", async () => {
  // libraryCount=1, pagesPerLibrary=1: Views 401s once (spending the budget's
  // one self-heal), succeeds on retry with the fresh token, then that fresh
  // token is immediately revoked. The items stream's own fetchLibraries call
  // (a second Views request) and its item page request both hit that same
  // revoked token — with a per-call (not run-scoped) budget, each of those
  // would independently re-authenticate. With the shared budget, they must
  // not: they exhaust it and fail.
  const server = new FakeJellyfinRepeatedRevocationServer(1, 1);
  const baseUrl = await server.start();

  try {
    const { ctx } = makeContext({
      credentials: { base_url: baseUrl, username: "alice", password: "correct-password" },
      // Request both streams in one collect() call, so both are subject to
      // the SAME runState instance constructed once in collect().
      streams: [{ name: "libraries" }, { name: "items" }],
    });

    await assert.rejects(() => collect(ctx));

    // Sign-in (1) + the single self-heal the shared budget allows (1) = 2.
    // If the budget were per-stream or per-call instead of run-scoped, the
    // items stream's independent fetchLibraries + item-page 401s would each
    // spend their own self-heal, driving this well past 2.
    assert.ok(
      server.authCalls.length <= 2,
      `budget must be shared across streams, not reset per stream (<=2 total logins), got ${server.authCalls.length}`
    );
  } finally {
    await server.stop();
  }
});

test("counterweight: a run with exactly one revocation (not repeated) still self-heals and completes with full coverage", async () => {
  // pagesPerLibrary large enough that only the FIRST page-boundary 401s and
  // every later request succeeds without further revocation — i.e. the
  // ORIGINAL single-repair defect this connector already fixed (commit
  // 439072a41) must still work under the new run-scoped budget. This is the
  // mutation-killing counterweight: a mutant that always refuses reauth
  // (e.g. `if (true) return`) would fail this test, proving the budget still
  // permits the one legitimate self-heal it's meant to allow.
  class FakeSingleRevocationServer {
    private server: any;
    private port = 0;
    private tokenCounter = 0;
    private currentToken = "";
    private revokedOnce = false;
    private servedItemsPages = 0;
    readonly authCalls: string[] = [];

    start(): Promise<string> {
      return new Promise((resolve, reject) => {
        this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
          const path = req.url || "";
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(req.headers)) {
            if (typeof value === "string") {
              headers[key] = value;
            }
          }
          const chunks: Buffer[] = [];
          req.on("data", (chunk) => chunks.push(chunk));
          req.on("end", () => this.route(res, path, headers));
        });
        this.server.listen(0, "127.0.0.1", () => {
          this.port = (this.server.address() as any).port;
          resolve(`http://127.0.0.1:${this.port}`);
        });
        this.server.on("error", reject);
      });
    }

    private route(res: ServerResponse, path: string, headers: Record<string, string>) {
      if (path === "/Users/AuthenticateByName") {
        this.tokenCounter += 1;
        this.currentToken = `token-${this.tokenCounter}`;
        this.authCalls.push(this.currentToken);
        res.writeHead(200);
        res.end(JSON.stringify({ AccessToken: this.currentToken, User: { Id: "user-alice-1", Name: "alice" } }));
        return;
      }
      if (path === "/Users/user-alice-1/Views") {
        if (headers["x-emby-token"] !== this.currentToken) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify({ Items: [{ Id: "lib1", Name: "Movies", CollectionType: "movies" }] }));
        return;
      }
      if (path.includes("/Users/user-alice-1/Items")) {
        const presented = headers["x-emby-token"] ?? "";
        const shouldReject = presented !== this.currentToken || (!this.revokedOnce && this.servedItemsPages === 0);
        if (!this.revokedOnce && presented === this.currentToken && this.servedItemsPages === 0) {
          // First-ever items request with a valid token: simulate the one
          // stale-token blip (revoke it instead of serving), exactly once.
          this.revokedOnce = true;
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        if (shouldReject) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        this.servedItemsPages += 1;
        const url = new URL(path, `http://localhost:${this.port}`);
        const startIndex = Number.parseInt(url.searchParams.get("StartIndex") || "0", 10);
        const totalCount = 5;
        const items = Array.from({ length: Math.min(500, totalCount - startIndex) }, (_, i) => ({
          Id: `item-${startIndex + i}`,
          Name: `Item ${startIndex + i}`,
          Type: "Movie",
          UserData: { PlayCount: 0, Played: false },
        }));
        res.writeHead(200);
        res.end(JSON.stringify({ Items: items, TotalRecordCount: totalCount }));
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
  }

  const server = new FakeSingleRevocationServer();
  const baseUrl = await server.start();

  try {
    const { ctx, records, messages } = makeContext({
      credentials: { base_url: baseUrl, username: "alice", password: "correct-password" },
      streams: [{ name: "libraries" }, { name: "items" }],
    });

    await collect(ctx);

    const itemRecords = records.filter((r) => r.stream === "items");
    assert.equal(itemRecords.length, 5, "the single stale-token blip must self-heal and still collect every item");

    assert.equal(server.authCalls.length, 2, "sign-in plus exactly one self-heal login, no more");

    const itemsCoverage = messages.find(
      (m) => m.type === "DETAIL_COVERAGE" && (m as { stream?: string }).stream === "items"
    ) as { considered?: number; covered?: number } | undefined;
    assert.notEqual(itemsCoverage, undefined, "a fully-recovered run must still emit items coverage (reads green)");
    assert.equal(itemsCoverage?.considered, 5);
    assert.equal(itemsCoverage?.covered, 5);
  } finally {
    await server.stop();
  }
});

// ─── B5 fix: a reauth attempt that itself fails must not escape the ───────
// deliberate jellyfin_auth_failed classification
//
// `jellyfinRequest`'s 401/403 branch calls `onReauth?.()` unguarded. If the
// mid-run `AuthenticateByName` call this triggers throws (e.g. the server
// 500s while the session is already dead), that exception used to propagate
// straight out of `jellyfinRequest`, bypassing the `throw new
// Error("jellyfin_auth_failed")` a few lines below and surfacing instead as
// whatever `AuthenticateByName`'s own error was (`jellyfin_http_500`) —
// which `skipReasonFor` maps to the generic `jellyfin_http_error` reason
// instead of the auth-specific classification an owner needs to know "your
// password/API key is the problem" vs. "the server had a transient error".
// Fix: `.catch(() => undefined)` on the reauth call, so a failed reauth is
// indistinguishable from "no self-heal available" and falls through to the
// same terminal `jellyfin_auth_failed` a real bad password produces.
test("B5: a mid-run reauth attempt that itself throws (server 500s on AuthenticateByName) still terminates with jellyfin_auth_failed, not a generic error", async () => {
  class FakeJellyfinReauth500Server {
    private server: any;
    private port = 0;
    private tokenCounter = 0;
    private currentToken = "";
    private authCallCount = 0;

    start(): Promise<string> {
      return new Promise((resolve, reject) => {
        this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
          const path = req.url || "";
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(req.headers)) {
            if (typeof value === "string") {
              headers[key] = value;
            }
          }
          const chunks: Buffer[] = [];
          req.on("data", (chunk) => chunks.push(chunk));
          req.on("end", () => this.route(res, path, headers));
        });
        this.server.listen(0, "127.0.0.1", () => {
          this.port = (this.server.address() as any).port;
          resolve(`http://127.0.0.1:${this.port}`);
        });
        this.server.on("error", reject);
      });
    }

    private route(res: ServerResponse, path: string, headers: Record<string, string>) {
      if (path === "/Users/AuthenticateByName") {
        this.authCallCount += 1;
        if (this.authCallCount === 1) {
          // Initial sign-in succeeds normally.
          this.tokenCounter += 1;
          this.currentToken = `token-${this.tokenCounter}`;
          res.writeHead(200);
          res.end(JSON.stringify({ AccessToken: this.currentToken, User: { Id: "user-alice-1", Name: "alice" } }));
          return;
        }
        // Every subsequent reauth attempt (the mid-run self-heal) 500s —
        // authenticateByName throws jellyfin_http_500 for this call.
        res.writeHead(500);
        res.end("Internal Server Error");
        return;
      }

      if (path === "/Users/user-alice-1/Views") {
        if (headers["x-emby-token"] !== this.currentToken) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify({ Items: [{ Id: "lib1", Name: "Movies", CollectionType: "movies" }] }));
        return;
      }

      if (path.includes("/Users/user-alice-1/Items")) {
        // Every Items request 401s — the session is dead and the only escape
        // hatch (reauth) is the one that 500s.
        res.writeHead(401);
        res.end("Unauthorized");
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
  }

  const server = new FakeJellyfinReauth500Server();
  const baseUrl = await server.start();

  try {
    const { ctx, messages } = makeContext({
      credentials: { base_url: baseUrl, username: "alice", password: "correct-password" },
      streams: [{ name: "libraries" }, { name: "items" }],
    });

    // The decisive assertion: jellyfin_auth_failed, not jellyfin_http_500
    // (which is what authenticateByName's own throw would produce if it
    // escaped jellyfinRequest unguarded) and not a generic jellyfin_error.
    await assert.rejects(() => collect(ctx), /jellyfin_auth_failed/);

    const itemsSkip = messages.find((m) => m.type === "SKIP_RESULT" && (m as { stream?: string }).stream === "items") as
      | { reason?: string }
      | undefined;
    assert.notEqual(itemsSkip, undefined, "a failed reauth must still emit an honest SKIP_RESULT for items");
    assert.equal(
      itemsSkip?.reason,
      "jellyfin_auth_failed",
      "a reauth attempt that itself throws must not escape as generic jellyfin_error or jellyfin_http_error — " +
        "the owner needs the auth-specific classification, not a transient-error-shaped one"
    );
  } finally {
    await server.stop();
  }
});

test("B5 counterweight: repeated rejection (reauth never throws, just keeps failing the session) still classifies as jellyfin_auth_failed", async () => {
  // Distinguishes "reauth attempt itself throws" (the B5 defect) from
  // "reauth completes but the session is still rejected" (already-correct
  // behavior via late-auth-self-heal.test.ts's alwaysReject case) — both
  // must land on the same terminal classification, proving the .catch added
  // for B5 does not change behavior for the already-working rejection path.
  class FakeJellyfinAlwaysRejectServer {
    private server: any;
    private port = 0;
    private tokenCounter = 0;
    private currentToken = "";
    readonly authCalls: string[] = [];

    start(): Promise<string> {
      return new Promise((resolve, reject) => {
        this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
          const path = req.url || "";
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(req.headers)) {
            if (typeof value === "string") {
              headers[key] = value;
            }
          }
          const chunks: Buffer[] = [];
          req.on("data", (chunk) => chunks.push(chunk));
          req.on("end", () => this.route(res, path, headers));
        });
        this.server.listen(0, "127.0.0.1", () => {
          this.port = (this.server.address() as any).port;
          resolve(`http://127.0.0.1:${this.port}`);
        });
        this.server.on("error", reject);
      });
    }

    private route(res: ServerResponse, path: string, headers: Record<string, string>) {
      if (path === "/Users/AuthenticateByName") {
        this.tokenCounter += 1;
        this.currentToken = `token-${this.tokenCounter}`;
        this.authCalls.push(this.currentToken);
        res.writeHead(200);
        res.end(JSON.stringify({ AccessToken: this.currentToken, User: { Id: "user-alice-1", Name: "alice" } }));
        return;
      }
      if (path === "/Users/user-alice-1/Views") {
        if (headers["x-emby-token"] !== this.currentToken) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify({ Items: [{ Id: "lib1", Name: "Movies", CollectionType: "movies" }] }));
        return;
      }
      if (path.includes("/Users/user-alice-1/Items")) {
        // Always rejects, even with a just-minted token from a "successful" reauth.
        res.writeHead(401);
        res.end("Unauthorized");
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
  }

  const server = new FakeJellyfinAlwaysRejectServer();
  const baseUrl = await server.start();

  try {
    const { ctx, messages } = makeContext({
      credentials: { base_url: baseUrl, username: "alice", password: "correct-password" },
      streams: [{ name: "libraries" }, { name: "items" }],
    });

    await assert.rejects(() => collect(ctx), /jellyfin_auth_failed/);
    assert.equal(server.authCalls.length, 2, "sign-in plus exactly one self-heal attempt before giving up");

    const itemsSkip = messages.find((m) => m.type === "SKIP_RESULT" && (m as { stream?: string }).stream === "items") as
      | { reason?: string }
      | undefined;
    assert.equal(itemsSkip?.reason, "jellyfin_auth_failed");
  } finally {
    await server.stop();
  }
});
