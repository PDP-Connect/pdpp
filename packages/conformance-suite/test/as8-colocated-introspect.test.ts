// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// AS-8 evidence via `TargetAdapter.coLocatedIntrospect`.
//
// Protected risk: same as as9-colocated-introspect.test.ts, applied to AS-8's
// revocation obligation instead of AS-9's grant-bound-claims obligation. A
// co-located deployment can reflect revocation through the same
// `PdppTokenService.introspect` its enforcement path reads, without
// publishing RFC 8414 `introspection_endpoint` metadata. Before this change,
// AS-8 against such a target always reported `skip`, even though Section 9
// item 8's "reflected immediately in introspection responses" obligation was
// observable there through an adapter hook.
//
// The independent truth source is a real HTTP server, started fresh per test,
// that answers the introspection contract and can flip a token from active to
// inactive on command — modeling revocation, not a mock the case's own
// expectations shaped.

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

const AS8_CASE = AUTHORIZATION_SERVER_CASES.find((c) => c.caseId === "AS-8/revoked-token-introspects-inactive");
assert.ok(AS8_CASE, "AS-8/revoked-token-introspects-inactive must exist");

const OWNER_TOKEN = "owner-stub-token";

type Deviate = "stays-active-after-revoke" | "discloses-extra-fields-when-inactive";

/**
 * A minimal HTTP server implementing the same
 * `packages/server/src/routes/pdpp-auth.ts` `POST /introspect` contract the
 * AS-9 stub uses, extended with a revocable token so this file can drive the
 * before/after revocation shape AS-8 actually checks.
 */
class RevocableIntrospectServer {
  private server?: Server;
  private port = 0;
  private readonly tokens = new Map<string, { grantId: string; active: boolean }>();
  private readonly deviate: Deviate | undefined;

  constructor(deviate?: Deviate) {
    this.deviate = deviate;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  issueClientToken(grantId: string): string {
    const token = `client-${grantId}`;
    this.tokens.set(token, { grantId, active: true });
    return token;
  }

  revoke(token: string): void {
    const entry = this.tokens.get(token);
    if (entry && this.deviate !== "stays-active-after-revoke") {
      entry.active = false;
    }
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
    // Mirrors packages/server/src/routes/pdpp-auth.ts:692: introspection
    // requires an authenticated owner-bearer caller.
    if (authorization !== `Bearer ${OWNER_TOKEN}`) {
      send(401, {
        error: { code: "invalid_client", message: "introspection requires an authenticated resource server" },
      });
      return;
    }
    const token = new URLSearchParams(body).get("token") ?? "";
    const resolved = this.tokens.get(token);
    if (!(resolved && resolved.active)) {
      send(200, {
        active: false,
        ...(this.deviate === "discloses-extra-fields-when-inactive"
          ? { grant_id: resolved?.grantId, subject_id: "stub-subject" }
          : {}),
      });
      return;
    }
    send(200, { active: true, pdpp_token_kind: "client", grant_id: resolved.grantId });
  }
}

/**
 * Wraps `ReferenceTargetAdapter` (co-located, no RFC 8414 metadata) with a
 * `coLocatedIntrospect` hook backed by a `RevocableIntrospectServer`, and
 * routes `revokeGrant` to the stub so the case observes the stub's own
 * active/inactive transition rather than the reference target's.
 */
class StubbedAdapter implements TargetAdapter {
  private readonly inner: ReferenceTargetAdapter;
  private readonly issuedTokens = new Map<string, string>();
  readonly stub: RevocableIntrospectServer;

  constructor(deviate?: Deviate) {
    this.inner = new ReferenceTargetAdapter(DEFAULT_FIXTURES);
    this.stub = new RevocableIntrospectServer(deviate);
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
  // No authorizationServerUrl: models a target with no RFC 8414 metadata,
  // forcing AS-8 to fall through to coLocatedIntrospect.

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
    const stubToken = this.stub.issueClientToken(issued.grantId);
    this.issuedTokens.set(issued.accessToken, stubToken);
    return { ...issued, accessToken: stubToken };
  };
  revokeGrant: TargetAdapter["revokeGrant"] = async (grantId) => {
    await this.inner.revokeGrant(grantId);
    for (const stubToken of this.issuedTokens.values()) {
      this.stub.revoke(stubToken);
    }
  };
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

describe("AS-8 co-located introspection fallback (coLocatedIntrospect)", () => {
  it("skips when post-revocation evidence is unavailable", async () => {
    const adapter = new StubbedAdapter();
    const introspect = adapter.coLocatedIntrospect.bind(adapter);
    let calls = 0;
    adapter.coLocatedIntrospect = (token) => (++calls === 1 ? introspect(token) : Promise.resolve(null));
    const { streams } = await adapter.setup();
    try {
      const result = await runCase(AS8_CASE, makeContext(adapter, streams));
      assert.equal(result.outcome, "skip");
    } finally {
      await adapter.teardown();
    }
  });

  it("passes: active before revocation, inactive after, no extra disclosure", async () => {
    const adapter = new StubbedAdapter();
    const { streams } = await adapter.setup();
    try {
      const result = await runCase(AS8_CASE, makeContext(adapter, streams));
      assert.equal(
        result.outcome,
        "pass",
        result.outcome === "fail" ? (result.detail ?? "expected pass") : "expected pass"
      );
    } finally {
      await adapter.teardown();
    }
  });

  it("still reports skip (missing evidence) when the adapter supplies no coLocatedIntrospect hook", async () => {
    // Regression guard mirroring as9-colocated-introspect.test.ts: adding the
    // fallback must not turn "no hook" into anything but skip.
    const adapter = new ReferenceTargetAdapter(DEFAULT_FIXTURES);
    const { streams } = await adapter.setup();
    try {
      const result = await runCase(AS8_CASE, makeContext(adapter, streams));
      assert.equal(result.outcome, "skip");
    } finally {
      await adapter.teardown();
    }
  });

  it("fails when the revoked token still introspects active", async () => {
    const adapter = new StubbedAdapter("stays-active-after-revoke");
    const { streams } = await adapter.setup();
    try {
      const result = await runCase(AS8_CASE, makeContext(adapter, streams));
      assert.equal(result.outcome, "fail");
      assert.match(result.outcome === "fail" ? (result.detail ?? "") : "", /revoked token as active/);
    } finally {
      await adapter.teardown();
    }
  });

  it("reports advisory (not fail) when the inactive response discloses extra fields", async () => {
    // The SHOULD-not-the-MUST: RFC 7662 Section 2.2's "SHOULD NOT" on extra
    // fields for an inactive token must never be elevated to a conformance
    // failure. Mirrors the equivalent live-adapter behavior this case already
    // covers, exercised here through the co-located path.
    const adapter = new StubbedAdapter("discloses-extra-fields-when-inactive");
    const { streams } = await adapter.setup();
    try {
      const result = await runCase(AS8_CASE, makeContext(adapter, streams));
      assert.equal(result.outcome, "advisory");
      assert.match(
        result.outcome === "advisory" ? (result.detail ?? "") : "",
        /grant_id, subject_id|subject_id, grant_id/
      );
    } finally {
      await adapter.teardown();
    }
  });
});
