// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// AS-9 evidence via `TargetAdapter.coLocatedIntrospect`.
//
// Protected risk: a co-located deployment can implement a real introspection
// route (the same `PdppTokenService.introspect` its enforcement path reads)
// without publishing RFC 8414 `introspection_endpoint` metadata — there is no
// separate AS to advertise. Before this hook, AS-9 against such a target
// always reported `skip`, even though the requirement ("access tokens bound
// to specific grants, carrying the PDPP introspection extension fields") was
// genuinely observable there. That is missing evidence masquerading as an
// inapplicable requirement, exactly the failure mode
// colocated-applicability.test.ts protects for the RFC-8414-discoverable
// case; this file protects the adapter-supplied fallback the same way.
//
// The independent truth source: a real HTTP server, started fresh per test,
// that implements the introspection contract the Vana Personal Server's
// `POST /pdpp/v1/introspect` actually has (owner-bearer authenticated, RFC
// 7662 + PDPP extension fields) — not a mock the case's own expectations
// shaped. Oracle discrimination (pass on a clean server, fail on a deviating
// one) follows the same pattern oracle-discrimination.test.ts uses for the
// resource-server cases.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import type { TargetAdapter } from "../src/harness/adapter.ts";
import type { PdppResponse } from "../src/harness/http.ts";
import { request } from "../src/harness/http.ts";
import { makeContext, runCase } from "../src/harness/runner.ts";
import { DEFAULT_FIXTURES, ReferenceTargetAdapter } from "../src/targets/reference-adapter.ts";
import { AUTHORIZATION_SERVER_CASES } from "../src/tests/authorization-server.ts";

const AS9_CASE = AUTHORIZATION_SERVER_CASES.find((c) => c.caseId === "AS-9/introspection-carries-pdpp-extensions");
assert.ok(AS9_CASE, "AS-9/introspection-carries-pdpp-extensions must exist");

const PDPP_TOKEN_KIND_PATTERN = /pdpp_token_kind/;
const GRANT_ID_PATTERN = /grant_id/;

const OWNER_TOKEN = "owner-stub-token";

/**
 * A minimal HTTP server implementing exactly the contract
 * `packages/server/src/routes/pdpp-auth.ts` `POST /introspect` has: reject any
 * caller that is not the owner bearer, otherwise resolve the submitted token
 * against an in-memory table and answer the RFC 7662 + PDPP shape. `deviate`
 * models the specific ways a co-located route could get this wrong, so each
 * has a server that genuinely produces the wrong answer rather than a stub
 * the test merely asserts on.
 */
type Deviate = "accept-client-token-as-caller" | "wrong-token-kind" | "wrong-grant-id";

class StubIntrospectServer {
  private server?: Server;
  private port = 0;
  private readonly tokens = new Map<string, { kind: "client"; grantId: string } | { kind: "owner" }>();
  private readonly deviate: Deviate | undefined;

  constructor(deviate?: Deviate) {
    this.deviate = deviate;
    this.tokens.set(OWNER_TOKEN, { kind: "owner" });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  issueClientToken(grantId: string): string {
    const token = `client-${grantId}`;
    this.tokens.set(token, { kind: "client", grantId });
    return token;
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        this.handle(req.url ?? "/", req.headers.authorization, body, res);
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

  private handle(
    url: string,
    authorization: string | undefined,
    body: string,
    res: import("node:http").ServerResponse
  ): void {
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (url !== "/pdpp/v1/introspect") {
      send(404, { error: { code: "not_found" } });
      return;
    }
    const caller = authorization?.startsWith("Bearer ")
      ? this.tokens.get(authorization.slice("Bearer ".length))
      : undefined;
    // The real route requires the caller to resolve to an owner-kind
    // principal (packages/server/src/routes/pdpp-auth.ts:692). The deviation
    // models a route that instead honours any authenticated caller, including
    // a client token that has no business introspecting.
    const callerIsAuthorized =
      this.deviate === "accept-client-token-as-caller" ? caller !== undefined : caller?.kind === "owner";
    if (!callerIsAuthorized) {
      send(401, {
        error: { code: "invalid_client", message: "introspection requires an authenticated resource server" },
      });
      return;
    }
    const token = new URLSearchParams(body).get("token") ?? "";
    const resolved = this.tokens.get(token);
    if (!resolved) {
      send(200, { active: false });
      return;
    }
    if (resolved.kind === "owner") {
      send(200, { active: true, pdpp_token_kind: "owner" });
      return;
    }
    send(200, {
      active: true,
      pdpp_token_kind: this.deviate === "wrong-token-kind" ? "owner" : "client",
      grant_id: this.deviate === "wrong-grant-id" ? `${resolved.grantId}-wrong` : resolved.grantId,
      client_id: "stub-client",
    });
  }
}

/**
 * Wraps `ReferenceTargetAdapter` (co-located, no RFC 8414 metadata) with a
 * `coLocatedIntrospect` hook backed by a `StubIntrospectServer`, so the AS-9
 * case exercises the fallback path this change adds rather than any of the
 * reference target's own HTTP surface.
 */
class StubbedAdapter implements TargetAdapter {
  private readonly inner: ReferenceTargetAdapter;
  readonly stub: StubIntrospectServer;

  constructor(deviate?: Deviate) {
    this.inner = new ReferenceTargetAdapter(DEFAULT_FIXTURES);
    this.stub = new StubIntrospectServer(deviate);
  }

  get targetId() {
    return this.inner.targetId;
  }
  get targetVersion() {
    return this.inner.targetVersion;
  }
  get baseUrl() {
    return this.inner.baseUrl;
  }
  get roles() {
    return this.inner.roles;
  }
  get capabilities() {
    return this.inner.capabilities;
  }
  // No authorizationServerUrl: this models a target with no RFC 8414
  // metadata at all, so discoverIntrospectionEndpoint must fail and the case
  // must fall through to coLocatedIntrospect.

  async setup() {
    await this.stub.start();
    return await this.inner.setup();
  }
  async teardown() {
    await this.stub.stop();
    await this.inner.teardown();
  }
  issueGrant: TargetAdapter["issueGrant"] = async (grantRequest) => {
    const issued = await this.inner.issueGrant(grantRequest);
    if (!issued) {
      return null;
    }
    // Bind a stub-recognized token to the same grant id, independent of the
    // reference target's own token: the case must observe the STUB's
    // introspection answer, not the reference server's.
    const stubToken = this.stub.issueClientToken(issued.grantId);
    return { ...issued, accessToken: stubToken };
  };
  revokeGrant: TargetAdapter["revokeGrant"] = (grantId) => this.inner.revokeGrant(grantId);
  ownerToken: TargetAdapter["ownerToken"] = async () => OWNER_TOKEN;

  coLocatedIntrospect = async (accessToken: string): Promise<PdppResponse | null> => {
    const owner = await this.ownerToken();
    if (!owner) {
      return null;
    }
    return await request(this.stub.baseUrl, "/pdpp/v1/introspect", {
      method: "POST",
      token: owner,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: accessToken }).toString(),
    });
  };
}

describe("AS-9 co-located introspection fallback (coLocatedIntrospect)", () => {
  it("passes against a clean co-located introspection route with no RFC 8414 metadata", async () => {
    const adapter = new StubbedAdapter();
    const { streams } = await adapter.setup();
    try {
      const result = await runCase(AS9_CASE, makeContext(adapter, streams));
      assert.equal(result.outcome, "pass", result.detail ?? "expected pass");
    } finally {
      await adapter.teardown();
    }
  });

  it("still reports skip (missing evidence) when the adapter supplies no coLocatedIntrospect hook", async () => {
    // Regression guard for colocated-applicability.test.ts's contract: adding
    // the fallback must not turn "no hook" into anything but skip.
    const adapter = new ReferenceTargetAdapter(DEFAULT_FIXTURES);
    const { streams } = await adapter.setup();
    try {
      const result = await runCase(AS9_CASE, makeContext(adapter, streams));
      assert.equal(result.outcome, "skip");
    } finally {
      await adapter.teardown();
    }
  });

  it("fails when the route reports the wrong pdpp_token_kind", async () => {
    const adapter = new StubbedAdapter("wrong-token-kind");
    const { streams } = await adapter.setup();
    try {
      const result = await runCase(AS9_CASE, makeContext(adapter, streams));
      assert.equal(result.outcome, "fail");
      assert.match(result.detail ?? "", PDPP_TOKEN_KIND_PATTERN);
    } finally {
      await adapter.teardown();
    }
  });

  it("fails when the route reports the wrong grant_id", async () => {
    const adapter = new StubbedAdapter("wrong-grant-id");
    const { streams } = await adapter.setup();
    try {
      const result = await runCase(AS9_CASE, makeContext(adapter, streams));
      assert.equal(result.outcome, "fail");
      assert.match(result.detail ?? "", GRANT_ID_PATTERN);
    } finally {
      await adapter.teardown();
    }
  });

  it(
    "negative control: a route that accepts a client token as the introspection caller still lets AS-9 pass, " +
      "proving AS-9 does not itself check caller authentication (that is a separate boundary, not this requirement)",
    async () => {
      // This is not a defect in the AS-9 assertion: Section 9 item 9 is about
      // what the token claims once introspected, not who may call the
      // endpoint. Documented here so a future reader does not mistake AS-9's
      // silence on this deviation for a discrimination gap.
      const adapter = new StubbedAdapter("accept-client-token-as-caller");
      const { streams } = await adapter.setup();
      try {
        const result = await runCase(AS9_CASE, makeContext(adapter, streams));
        assert.equal(result.outcome, "pass");
      } finally {
        await adapter.teardown();
      }
    }
  );

  it("the stub's own auth gate refuses a non-owner caller — the clean refusal this hook depends on", async () => {
    // Direct proof that StubIntrospectServer's caller check (mirroring
    // packages/server/src/routes/pdpp-auth.ts:692's tokenKind !== "owner"
    // branch) actually refuses, independent of the AS-9 case: if this gate
    // were unreachable, the "accept-client-token-as-caller" deviation above
    // would prove nothing.
    const stub = new StubIntrospectServer();
    await stub.start();
    try {
      const clientToken = stub.issueClientToken("grant_x");
      const response = await request(stub.baseUrl, "/pdpp/v1/introspect", {
        method: "POST",
        token: clientToken,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: clientToken }).toString(),
      });
      assert.equal(response.status, 401);
    } finally {
      await stub.stop();
    }
  });
});
