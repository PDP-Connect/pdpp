// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Oracle-discrimination proof for the introspection half of
// AS-20/refresh-reuse-revokes-the-family.
//
// Protected risk: the case accepted anything that was not an observed
// `active: true` as "not active", so a 200 whose body is not an RFC 7662
// response (`{}`, or `active` as a string) passed on the resource server's
// refusal alone. An introspection route that was never reached was treated the
// same way. The proof answers introspection from a scripted authorization server
// and keeps the bundled resource server, so the AS's answer is the only variable.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { describe, it } from "node:test";
import type { PdppResponse } from "../src/harness/http.ts";
import { makeContext, runCase } from "../src/harness/runner.ts";
import { ALL_CASES } from "../src/suite.ts";
import { ReferenceTargetAdapter } from "../src/targets/reference-adapter.ts";

const AS20 =
  ALL_CASES.find((c) => c.caseId === "AS-20/refresh-reuse-revokes-the-family") ??
  assert.fail("AS-20/refresh-reuse-revokes-the-family must exist");

const PATTERN_ACTIVE_AS_JSON_BOOLEAN = /`active` as a JSON boolean/;
const PATTERN_NO_ROUTE = /no usable introspection route was found/;
const PATTERN_ENDPOINT_404 = /the endpoint answered 404/;
const PATTERN_ENDPOINT_500 = /the endpoint answered 500/;

/**
 * What the scripted authorization server answers. `no-endpoint` publishes RFC
 * 8414 metadata without an `introspection_endpoint`; any other answer is served
 * at the advertised endpoint.
 */
type Answer = { readonly status: number; readonly body: string } | "no-endpoint";

class ScriptedAuthorizationServer {
  private server?: Server;
  private port = 0;
  private readonly answer: Answer;

  constructor(answer: Answer) {
    this.answer = answer;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/.well-known/oauth-authorization-server") {
        const endpoint = this.answer === "no-endpoint" ? {} : { introspection_endpoint: `${this.baseUrl}/introspect` };
        res.end(JSON.stringify({ issuer: this.baseUrl, ...endpoint }));
        return;
      }
      if (req.url === "/introspect" && req.method === "POST" && this.answer !== "no-endpoint") {
        res.statusCode = this.answer.status;
        res.end(this.answer.body);
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const address = this.server?.address();
    this.port = address && typeof address === "object" ? address.port : 0;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

/**
 * The bundled target with refresh tokens declared, whose authorization server is
 * the scripted one. Its co-located introspection is removed, so the scripted
 * endpoint is the only introspection the case can reach.
 */
class ScriptedIntrospectionAdapter extends ReferenceTargetAdapter {
  override readonly capabilities = { ...new ReferenceTargetAdapter().capabilities, refreshTokens: true };
  private readonly asUrl: string;

  constructor(asUrl: string) {
    super();
    this.asUrl = asUrl;
  }

  override get authorizationServerUrl(): string {
    return this.asUrl;
  }

  override coLocatedIntrospect(): Promise<PdppResponse | null> {
    return Promise.resolve(null);
  }
}

async function runWithIntrospection(answer: Answer) {
  const as = new ScriptedAuthorizationServer(answer);
  await as.start();
  const adapter = new ScriptedIntrospectionAdapter(as.baseUrl);
  const { streams } = await adapter.setup();
  try {
    return await runCase(AS20, makeContext(adapter, streams));
  } finally {
    await adapter.teardown();
    await as.stop();
  }
}

const json = (body: unknown): Answer => ({ status: 200, body: JSON.stringify(body) });

describe("AS-20 requires an observed inactive state from introspection", () => {
  it("passes when introspection reports the family-linked token inactive", async () => {
    const result = await runWithIntrospection(json({ active: false }));
    assert.equal(result.outcome, "pass", result.detail ?? "(no detail)");
  });

  it("fails when introspection still reports the family-linked token active", async () => {
    const result = await runWithIntrospection(json({ active: true }));
    assert.equal(result.outcome, "fail", result.detail ?? "(no detail)");
  });

  it("fails a 200 introspection body of {}, which carries no active member", async () => {
    const result = await runWithIntrospection(json({}));
    assert.equal(result.outcome, "fail", result.detail ?? "(no detail)");
    assert.match(result.detail ?? "", PATTERN_ACTIVE_AS_JSON_BOOLEAN);
  });

  it('fails a 200 introspection body whose active member is the string "false"', async () => {
    const result = await runWithIntrospection(json({ active: "false" }));
    assert.equal(result.outcome, "fail", result.detail ?? "(no detail)");
    assert.match(result.detail ?? "", PATTERN_ACTIVE_AS_JSON_BOOLEAN);
  });

  it("fails a 200 introspection body that is not JSON", async () => {
    const result = await runWithIntrospection({ status: 200, body: "active=false" });
    assert.equal(result.outcome, "fail", result.detail ?? "(no detail)");
    assert.match(result.detail ?? "", PATTERN_ACTIVE_AS_JSON_BOOLEAN);
  });

  it("skips when the endpoint refuses the suite's credentials and no other route answers", async () => {
    const result = await runWithIntrospection({ status: 401, body: '{"error":"invalid_client"}' });
    assert.equal(result.outcome, "skip", result.detail ?? "(no detail)");
    assert.match(result.detail ?? "", PATTERN_NO_ROUTE);
  });

  it("skips when the metadata publishes no introspection endpoint", async () => {
    const result = await runWithIntrospection("no-endpoint");
    assert.equal(result.outcome, "skip", result.detail ?? "(no detail)");
    assert.match(result.detail ?? "", PATTERN_NO_ROUTE);
  });

  it("skips when the endpoint answers 404, which means there is no route at all", async () => {
    const result = await runWithIntrospection({ status: 404, body: "{}" });
    assert.equal(result.outcome, "skip", result.detail ?? "(no detail)");
    assert.match(result.detail ?? "", PATTERN_ENDPOINT_404);
  });

  it("skips when the endpoint answers 500, which is not an answer about the token", async () => {
    const result = await runWithIntrospection({ status: 500, body: "{}" });
    assert.equal(result.outcome, "skip", result.detail ?? "(no detail)");
    assert.match(result.detail ?? "", PATTERN_ENDPOINT_500);
  });
});
