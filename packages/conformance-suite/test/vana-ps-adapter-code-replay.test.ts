// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// `VanaPsAdapter.stageApproval`/`approve`/`replayLastCode` against a real HTTP
// fixture, not fabricated responses.
//
// Protected risk: `oracle-discrimination.test.ts`'s `CodeReplayStageableAdapter`
// proves the AS-19 CASE's pass/fail/skip branching, but its `onReplay` hook
// returns a fixed answer directly — no HTTP round trip, no adapter transport.
// It cannot show that `VanaPsAdapter` itself performs a genuine second
// token-endpoint redemption with the SAME authorization code and PKCE
// verifier, or that a transport failure during replay is honored as `null`
// rather than an uncaught exception. Only driving the real adapter against a
// server does.
//
// The independent truth source: a minimal local HTTP server implementing just
// enough of the Vana Personal Server's authorize/review/approve/token
// contract for `stageApproval` to complete a real journey, with `redeemed`
// toggling whether the fixture is a clean target (second redemption refused
// with 400 invalid_grant, so AS-19 passes) or a violating one (second
// redemption issues a further token, so AS-19 fails).

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { makeContext, runCase } from "../src/harness/runner.ts";
import { VanaPsAdapter } from "../src/targets/vana-ps-adapter.ts";
import { AUTHORIZATION_SERVER_CASES } from "../src/tests/authorization-server.ts";

const AS19_CASE = AUTHORIZATION_SERVER_CASES.find(
  (c) => c.caseId === "AS-19/authorization-code-redemption-is-not-replayable"
);
assert.ok(AS19_CASE, "AS-19/authorization-code-redemption-is-not-replayable must exist");

const OWNER_BOOTSTRAP = "owner-bootstrap-stub";
const OWNER_TOKEN = "owner-session-stub";
const CLIENT_ID = "pdpp-conformance-client";
const REDIRECT_URI = "https://client.example/callback";

interface TokenRequest {
  readonly client_id: string | null;
  readonly code: string | null;
  readonly code_verifier: string | null;
  readonly grant_type: string | null;
  readonly redirect_uri: string | null;
}

/**
 * Implements the five routes `VanaPsAdapter.stageApproval` and
 * `replayLastCode` call: owner bootstrap, authorize, review, approve, token.
 * One authorization code is issued per session and, once redeemed, `mode`
 * decides what a second redemption of that SAME code does — the fact AS-19
 * must discriminate on. Every `/pdpp/v1/token` request is recorded so the
 * test can assert the replay reused the exact code, PKCE verifier, client_id,
 * and redirect_uri from the first redemption.
 */
class CodeReplayFixture {
  private server?: Server;
  private port = 0;
  private sessionId = 0;
  private code: string | undefined;
  private redemptions = 0;
  private readonly mode: "refuse-replay" | "accept-replay" | "transport-failure-on-replay";
  readonly tokenRequests: TokenRequest[] = [];

  constructor(mode: "refuse-replay" | "accept-replay" | "transport-failure-on-replay") {
    this.mode = mode;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        this.handle(req.method ?? "GET", req.url ?? "/", Buffer.concat(chunks).toString("utf8"), res);
      });
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.port = (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }

  private handle(method: string, url: string, body: string, res: import("node:http").ServerResponse): void {
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (method === "POST" && url === "/pdpp/v1/owner/token") {
      send(200, { access_token: OWNER_TOKEN });
      return;
    }

    if (method === "POST" && url === "/pdpp/v1/authorize") {
      this.sessionId += 1;
      send(201, { session_id: String(this.sessionId) });
      return;
    }

    if (method === "GET" && url === `/pdpp/v1/authorize/${this.sessionId}/review`) {
      send(200, { review: { review_digest: "digest-1" } });
      return;
    }

    if (method === "POST" && url === `/pdpp/v1/authorize/${this.sessionId}/approve`) {
      this.code = `code-${this.sessionId}`;
      const redirect = new URL(REDIRECT_URI);
      redirect.searchParams.set("code", this.code);
      send(200, {
        redirect_uri: redirect.toString(),
        grant_id: `grant-${this.sessionId}`,
        grant: { streams: [] },
      });
      return;
    }

    if (method === "POST" && url === "/pdpp/v1/token") {
      const form = new URLSearchParams(body);
      this.tokenRequests.push({
        client_id: form.get("client_id"),
        code: form.get("code"),
        code_verifier: form.get("code_verifier"),
        grant_type: form.get("grant_type"),
        redirect_uri: form.get("redirect_uri"),
      });

      const submittedCode = form.get("code");
      if (!this.code || submittedCode !== this.code) {
        send(400, { error: "invalid_grant" });
        return;
      }

      this.redemptions += 1;
      if (this.redemptions === 1) {
        send(200, { access_token: `access-${this.sessionId}` });
        return;
      }

      if (this.mode === "accept-replay") {
        send(200, { access_token: "second-live-token" });
        return;
      }
      if (this.mode === "transport-failure-on-replay") {
        // A malformed/aborted response `fetch` cannot parse as a normal HTTP
        // exchange: destroy the socket mid-response so the client's `fetch`
        // rejects, exercising the adapter's transport-failure path rather
        // than any well-formed status code.
        res.destroy();
        return;
      }
      send(400, { error: "invalid_grant" });
      return;
    }

    send(404, { error: "not_found" });
  }
}

function makeAdapter(fixture: CodeReplayFixture): VanaPsAdapter {
  return new VanaPsAdapter({
    baseUrl: fixture.baseUrl,
    capabilities: {
      blobs: false,
      incrementalSync: false,
      ownerTokens: true,
      refreshTokens: false,
      selfExport: false,
      separatedDeployment: false,
      singleUseGrants: false,
      views: false,
    },
    clientId: CLIENT_ID,
    ownerBootstrapToken: OWNER_BOOTSTRAP,
    redirectUri: REDIRECT_URI,
    roles: ["authorization-server", "resource-server"],
    sourceId: "test-source",
    streams: [{ name: "test-stream", fields: ["a"], primaryKey: ["a"], recordCount: 1, semantics: "append_only" }],
    targetId: "vana-ps-code-replay-fixture",
    targetVersion: "0.0.0-test",
  });
}

describe("VanaPsAdapter drives a real second token-endpoint redemption for AS-19", () => {
  it("passes against a fixture that refuses replay with 400 invalid_grant", async () => {
    const fixture = new CodeReplayFixture("refuse-replay");
    await fixture.start();
    const adapter = makeAdapter(fixture);
    try {
      const { streams } = await adapter.setup();
      const result = await runCase(AS19_CASE, makeContext(adapter, streams));
      assert.equal(result.outcome, "pass", result.detail ?? "expected pass");

      assert.equal(fixture.tokenRequests.length, 2, "expected exactly two token-endpoint requests");
      const [first, replay] = fixture.tokenRequests as [TokenRequest, TokenRequest];
      assert.equal(first.code, "code-1");
      assert.ok(first.code_verifier, "the initial redemption must supply a PKCE verifier");
      assert.equal(first.client_id, CLIENT_ID);
      assert.equal(first.redirect_uri, REDIRECT_URI);
      assert.equal(first.grant_type, "authorization_code");
      assert.deepEqual(replay, first, "replay must preserve the entire token request");
      assert.equal(replay.code, first.code, "replay must reuse the exact same authorization code");
      assert.equal(replay.code_verifier, first.code_verifier, "replay must reuse the exact same PKCE verifier");
      assert.equal(replay.client_id, first.client_id, "replay must reuse the exact same client_id");
      assert.equal(replay.redirect_uri, first.redirect_uri, "replay must reuse the exact same redirect_uri");
    } finally {
      await fixture.stop();
    }
  });

  it("fails against a fixture that issues a further access token on replay (real AS-19 case)", async () => {
    const fixture = new CodeReplayFixture("accept-replay");
    await fixture.start();
    const adapter = makeAdapter(fixture);
    try {
      const { streams } = await adapter.setup();
      const result = await runCase(AS19_CASE, makeContext(adapter, streams));
      assert.equal(result.outcome, "fail", `expected fail, got ${result.outcome}: ${result.detail ?? ""}`);
      assert.ok(result.detail && result.detail.length > 0, "failure must carry a detail");
    } finally {
      await fixture.stop();
    }
  });

  it("skips, without throwing, when the replay attempt is a transport failure", async () => {
    const fixture = new CodeReplayFixture("transport-failure-on-replay");
    await fixture.start();
    const adapter = makeAdapter(fixture);
    try {
      const { streams } = await adapter.setup();
      const result = await runCase(AS19_CASE, makeContext(adapter, streams));
      assert.equal(result.outcome, "skip", `expected skip, got ${result.outcome}: ${result.detail ?? ""}`);
    } finally {
      await fixture.stop();
    }
  });
});
