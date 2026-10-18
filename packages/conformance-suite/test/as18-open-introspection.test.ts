// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Oracle-discrimination proof for AS-18/introspection-requires-authentication.
//
// Protected risk: the case applies only to a separated deployment, which the
// bundled target is not, so it is never run against a bundled-server defect. A
// check that cannot fire certifies an open introspection endpoint as
// conforming. The proof runs the case against a small HTTP server that
// publishes RFC 8414 metadata and answers introspection either behind a
// credential (conforming) or without one (the defect).

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { describe, it } from "node:test";
import { makeContext, runCase } from "../src/harness/runner.ts";
import { ALL_CASES } from "../src/suite.ts";
import { ReferenceTargetAdapter } from "../src/targets/reference-adapter.ts";

const AS18 =
  ALL_CASES.find((c) => c.caseId === "AS-18/introspection-requires-authentication") ??
  assert.fail("AS-18/introspection-requires-authentication must exist");

class IntrospectionServer {
  private server?: Server;
  private port = 0;
  private readonly requireCredential: boolean;

  constructor(requireCredential: boolean) {
    this.requireCredential = requireCredential;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/.well-known/oauth-authorization-server") {
        res.end(JSON.stringify({ issuer: this.baseUrl, introspection_endpoint: `${this.baseUrl}/introspect` }));
        return;
      }
      if (req.url === "/introspect" && req.method === "POST") {
        if (this.requireCredential && !req.headers.authorization) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: "invalid_client" }));
          return;
        }
        res.end(JSON.stringify({ active: true }));
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

/** The bundled target, relabelled as a separated deployment whose AS is `asUrl`. */
class SeparatedAdapter extends ReferenceTargetAdapter {
  override readonly capabilities = { ...new ReferenceTargetAdapter().capabilities, separatedDeployment: true };
  private readonly asUrl: string;

  constructor(asUrl: string) {
    super();
    this.asUrl = asUrl;
  }
  override get authorizationServerUrl(): string {
    return this.asUrl;
  }
}

async function runAgainstIntrospection(requireCredential: boolean) {
  const as = new IntrospectionServer(requireCredential);
  await as.start();
  const adapter = new SeparatedAdapter(as.baseUrl);
  const { streams } = await adapter.setup();
  try {
    return await runCase(AS18, makeContext(adapter, streams));
  } finally {
    await adapter.teardown();
    await as.stop();
  }
}

describe("AS-18 discriminates an authenticated from an open introspection endpoint", () => {
  it("passes when the endpoint refuses a caller with no credential", async () => {
    const result = await runAgainstIntrospection(true);
    assert.equal(result.outcome, "pass", result.detail ?? "expected pass");
  });

  it("fails when the endpoint answers an unauthenticated caller", async () => {
    const result = await runAgainstIntrospection(false);
    assert.equal(result.outcome, "fail", result.detail ?? "expected fail");
    assert.ok(result.detail);
  });
});
