// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Root cause (live candidate, run_1786418205219_1, 2026-08-11): a scheduled
 * run signed in successfully via AuthenticateByName, fetched all 4 libraries,
 * and had emitted 1085 items across two full item-pagination batches — then a
 * LATER items page returned 401/403 with the SAME token that had already
 * authenticated fine earlier in the same run. `jellyfinRequest` mapped every
 * 401/403 to the same terminal `jellyfin_auth_failed`, indistinguishable from
 * a genuinely wrong password, even though the run's own history moments
 * earlier proved the credential valid. The run failed non-retryable with 85
 * records buffered and dropped and no checkpoint committed, though the
 * password had not changed (`connector_instance_credentials.rejected_at` is
 * null and `rotated_at` predates the run by days).
 *
 * Fix (this connector only, primary/username-password path only — an API key
 * is a static credential with no refresh concept): on a 401/403,
 * `jellyfinRequest` calls back into a fresh `AuthenticateByName` once and, if
 * the resulting token genuinely differs from the one that just failed,
 * retries the SAME request once with the fresh token before giving up. If
 * the token is unchanged or the retry also fails, the run fails exactly as
 * before — this does not change behavior for a real bad password. Mirrors
 * the ChatGPT connector's stale-token self-heal (chatgpt/index.ts fetchOnce).
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
 * Fake server that reproduces the exact live sequence: auth succeeds, the
 * first item page succeeds with the token AuthenticateByName issued, then the
 * NEXT item page 401s that same token exactly once (simulating a rotated/
 * invalidated session) — a fresh AuthenticateByName call issues a new token,
 * and any request bearing the new token succeeds. `revokeAfterPages` counts
 * only page requests actually served with a currently-valid token, so the
 * revoke fires once regardless of which library/page happens to trigger it.
 */
class FakeJellyfinLateAuthServer {
  private server: any;
  private port = 0;
  private tokenCounter = 0;
  private currentToken = "";
  private revoked = false;
  private servedPages = 0;
  private readonly revokeAfterPages: number;
  private readonly alwaysReject: boolean;
  private readonly sameTokenOnReauth: boolean;
  readonly authCalls: string[] = [];
  readonly itemsRequestsByToken: string[] = [];

  /**
   * `revokeAfterPages`: the Nth successfully-served items page invalidates
   * the token that served it, so the next request with that same token 401s
   * — models a stale-token blip. `alwaysReject`: every items request 401s
   * regardless of token freshness, including a just-re-authenticated token —
   * models a genuinely dead credential, distinct from a stale-token blip.
   * `sameTokenOnReauth`: `AuthenticateByName` hands back the IDENTICAL token
   * that just 401'd instead of minting a new one — models a server whose
   * session store is wedged (or a load balancer that pins the same dead
   * session), distinct from `alwaysReject`'s "the credential itself is
   * rejected" — here the credential is fine, but re-authenticating produces
   * no new token to retry with.
   */
  constructor(revokeAfterPages: number, alwaysReject = false, sameTokenOnReauth = false) {
    this.revokeAfterPages = revokeAfterPages;
    this.alwaysReject = alwaysReject;
    this.sameTokenOnReauth = sameTokenOnReauth;
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
      if (!this.sameTokenOnReauth || this.tokenCounter === 0) {
        this.tokenCounter += 1;
        this.currentToken = `token-${this.tokenCounter}`;
        this.revoked = false; // a fresh sign-in always yields a currently-valid token
      }
      // sameTokenOnReauth: every call after the first hands back the exact
      // same (already-revoked) token — `revoked` is deliberately NOT reset,
      // so the connector's retry with this "fresh" token would 401 again if
      // it ever attempted the retry (it must not).
      this.authCalls.push(this.currentToken);
      res.writeHead(200);
      res.end(JSON.stringify({ AccessToken: this.currentToken, User: { Id: "user-alice-1", Name: "alice" } }));
      return;
    }

    if (path === "/Users/user-alice-1/Views") {
      if (headers["x-emby-token"] !== this.currentToken || this.revoked) {
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
      this.itemsRequestsByToken.push(presented);

      if (this.alwaysReject || presented !== this.currentToken || this.revoked) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }

      this.servedPages += 1;
      if (this.servedPages === this.revokeAfterPages) {
        // This page is served successfully, but the token is invalidated
        // server-side immediately after — the NEXT request with this same
        // token will 401, matching a session dropped mid-run.
        this.revoked = true;
      }

      // The real connector always requests Limit=500 and increments StartIndex
      // by 500 (collectItemsForLibrary) — a fixed page size the fake server
      // must honor for TotalRecordCount-driven pagination to end correctly.
      const url = new URL(path, `http://localhost:${this.port}`);
      const startIndex = Number.parseInt(url.searchParams.get("StartIndex") || "0", 10);
      const pageSize = 500;
      const totalCount = 600; // forces exactly 2 pages: StartIndex 0 and 500
      const items = Array.from({ length: Math.min(pageSize, totalCount - startIndex) }, (_, i) => ({
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

test("fake server sanity check: an unrecognized/stale token 401s on the items endpoint (does not exercise the connector)", async () => {
  // This test drives a bare `fetch` against the fake server directly — it
  // never calls `jellyfinRequest` or `collect()`, so it proves nothing about
  // the connector's OLD or NEW behavior. It only pins down that
  // `FakeJellyfinLateAuthServer` itself 401s an unrecognized token, which the
  // real regression tests below rely on. The actual "pre-fix, no self-heal"
  // behavior is proven directly by the assertions inside the "persists after
  // re-authentication" and "reauth returns the same token" tests below (both
  // exercise the real `collect()` path and assert the terminal
  // `jellyfin_auth_failed` the live run hit) — a from-scratch `fetch` against
  // this fake server cannot stand in for that, since it bypasses
  // `jellyfinRequest` entirely.
  const server = new FakeJellyfinLateAuthServer(1);
  const baseUrl = await server.start();
  try {
    const res = await fetch(`${baseUrl}/Users/user-alice-1/Items?StartIndex=2&Limit=2`, {
      headers: { "X-Emby-Token": "stale-token-not-yet-issued" },
    });
    assert.equal(res.status, 401, "the fake server reproduces a 401 on an unrecognized/stale token");
  } finally {
    await server.stop();
  }
});

test("pass-after: a mid-run 401 on a proven-valid token self-heals via one AuthenticateByName retry and the run completes with all records", async () => {
  // TotalRecordCount=600 forces exactly 2 real pages at the connector's fixed
  // Limit=500 (StartIndex 0, then 500) — revoke after the 1st items page is
  // served, so the 2nd page's first attempt 401s with the token that just
  // worked one page earlier. This is structurally identical to the live run:
  // proven-valid credential, later request 401s mid-pagination.
  const server = new FakeJellyfinLateAuthServer(1);
  const baseUrl = await server.start();

  try {
    const { ctx, records } = makeContext({
      credentials: { base_url: baseUrl, username: "alice", password: "correct-password" },
      streams: [{ name: "items" }],
    });

    await collect(ctx);

    const itemRecords = records.filter((r) => r.stream === "items");
    assert.equal(itemRecords.length, 600, "all 600 items across both pages must be collected despite the mid-run 401");

    assert.equal(server.authCalls.length, 2, "must re-authenticate exactly once after the mid-run 401");
    assert.notEqual(
      server.authCalls[0],
      server.authCalls[1],
      "the re-authentication must produce a genuinely fresh token, not reuse the stale one"
    );

    // The failing request must have been retried with the NEW token, not
    // abandoned — i.e. the stale token appears, then the fresh token appears
    // and succeeds.
    const lastRequestToken = server.itemsRequestsByToken.at(-1);
    assert.equal(lastRequestToken, server.authCalls[1], "the retried request must carry the freshly-issued token");
  } finally {
    await server.stop();
  }
});

test("a 401 that persists after re-authentication (token genuinely rejected) still fails the run honestly", async () => {
  // alwaysReject=true means EVERY items request 401s, including the retry
  // with the freshly re-authenticated token — a genuinely dead credential,
  // not a stale-token blip. Self-heal must not paper over a real failure.
  const server = new FakeJellyfinLateAuthServer(0, true);
  const baseUrl = await server.start();

  try {
    const { ctx } = makeContext({
      credentials: { base_url: baseUrl, username: "alice", password: "correct-password" },
      streams: [{ name: "items" }],
    });

    await assert.rejects(() => collect(ctx), /jellyfin_auth_failed/);
    assert.equal(server.authCalls.length, 2, "must still attempt exactly one re-authentication before giving up");
  } finally {
    await server.stop();
  }
});

test("reauth that hands back the identical (still-revoked) token does not retry the request, and fails after exactly one auth call", async () => {
  // sameTokenOnReauth=true: AuthenticateByName succeeds (HTTP 200, a real
  // token) but hands back the EXACT same token that just 401'd — a wedged
  // server-side session store, not a rejected credential. `jellyfinRequest`
  // gates the retry on `freshToken !== apiKey`: since the token is
  // unchanged, retrying would just replay the identical failing request, so
  // it must skip the retry and fail immediately instead of looping.
  const server = new FakeJellyfinLateAuthServer(1, false, true);
  const baseUrl = await server.start();

  try {
    const { ctx } = makeContext({
      credentials: { base_url: baseUrl, username: "alice", password: "correct-password" },
      streams: [{ name: "items" }],
    });

    await assert.rejects(() => collect(ctx), /jellyfin_auth_failed/);

    // One AuthenticateByName call happens at sign-in (before any request is
    // even attempted); the mid-run 401 triggers exactly one MORE reauth
    // attempt — the same-token gate must stop there rather than looping.
    assert.equal(
      server.authCalls.length,
      2,
      "exactly one auth call at sign-in plus exactly one reauth attempt after the mid-run 401 — no retry loop"
    );
    assert.equal(server.authCalls[0], server.authCalls[1], "sanity: the fake server actually returned the same token");

    // The decisive assertion: since the reauth token was identical, the
    // retried-request code path must never fire. `itemsRequestsByToken`
    // records every Items request the fake server actually received, in
    // order: page 1 (StartIndex=0, succeeds with token-1), page 2
    // (StartIndex=500, 401s with token-1, triggering reauth). If
    // `jellyfinRequest` retried anyway, a THIRD Items request would appear
    // here bearing the same (still-revoked) token again.
    assert.equal(
      server.itemsRequestsByToken.length,
      2,
      "the same-token retry must never be attempted — only the original 2 pagination requests, no extra retry request"
    );
  } finally {
    await server.stop();
  }
});
