// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// A precondition the harness could not arrange is `skip`, never `fail`.
//
// Protected risk: the reference-AS adapter once sent an unauthenticated revoke,
// ignored the 401, and the AS-8 cases then reported "revoked token still
// active" -- a false conformance failure caused by the harness. The stub target
// below issues grants normally but answers every revoke with 401, so the
// revocation cannot be arranged. Both AS-8 revocation cases must say `skip` and
// name the failed step (status and body excerpt).

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import type { SeededStream } from "../src/harness/adapter.ts";
import { makeContext, runCase } from "../src/harness/runner.ts";
import { ReferenceAsAdapter } from "../src/targets/reference-as-adapter.ts";
import { AUTHORIZATION_SERVER_CASES } from "../src/tests/authorization-server.ts";
import { GRANT_LIFECYCLE_CASES } from "../src/tests/grant-lifecycle.ts";
import { QUERY_SURFACE_CASES } from "../src/tests/query-surface.ts";

const REVOKE_STEP = /revoke/i;
const STATUS_401 = /401/;
const BODY_EXCERPT = /revoke-denied-by-stub/;
const TIME_CONSTRAINT_STEP = /without the requested time_constraint/;

const STREAM: SeededStream = {
  cursorField: "updated_at",
  name: "repositories",
  fields: ["id", "name"],
  primaryKey: ["id"],
  semantics: "mutable_state",
  recordCount: 1,
};

const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/** AS and RS in one stub. Revocation is always refused with 401; tokens never go inactive. */
function startStub(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    req.resume();
    req.on("end", () => {
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        const origin = `http://${req.headers.host}`;
        return json(res, 200, { issuer: origin, introspection_endpoint: `${origin}/oauth/introspect` });
      }
      if (url.pathname === "/oauth/introspect") {
        return json(res, 200, { active: true, pdpp_token_kind: "client", grant_id: "grant_1" });
      }
      if (url.pathname.startsWith("/grants/") && url.pathname.endsWith("/revoke")) {
        return json(res, 401, { error: "revoke-denied-by-stub" });
      }
      if (url.pathname === "/oauth/register") {
        return json(res, 201, { client_id: "client_stub" });
      }
      if (url.pathname === "/oauth/device_authorization") {
        return json(res, 200, { device_code: "dev", user_code: "USER" });
      }
      if (url.pathname === "/device/approve") {
        return json(res, 200, {});
      }
      if (url.pathname === "/oauth/token") {
        return json(res, 200, { access_token: "owner_token" });
      }
      if (url.pathname === "/oauth/par") {
        return json(res, 201, { request_uri: "urn:stub:par" });
      }
      if (url.pathname === "/consent/review") {
        return json(res, 200, { approval_review_revision: "rev1" });
      }
      if (url.pathname === "/consent/approve") {
        return json(res, 200, {
          token: "client_token",
          grant_id: "grant_1",
          // Deliberately no time_constraint: the AS "forgot" the requested window.
          grant: { streams: [{ name: STREAM.name, fields: [...STREAM.fields] }] },
        });
      }
      if (url.pathname.startsWith("/v1/streams/")) {
        return json(res, 200, { object: "list", data: [{ id: "r1" }], has_more: false });
      }
      return json(res, 404, { error: "not_found" });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    });
  });
}

function stubAdapter(url: string): ReferenceAsAdapter {
  return new ReferenceAsAdapter({
    asUrl: url,
    rsUrl: url,
    capabilities: {
      separatedDeployment: true,
      ownerTokens: true,
      selfExport: true,
      incrementalSync: false,
      views: false,
      singleUseGrants: false,
      refreshTokens: false,
      blobs: false,
    },
    dcrInitialAccessToken: "dcr",
    roles: ["authorization-server", "resource-server"],
    source: { kind: "connector", id: "https://example.test/connectors/stub" },
    streams: [STREAM],
    subjectId: "subject_stub",
    targetId: "stub",
    targetVersion: "0",
  });
}

describe("harness steps that cannot arrange a precondition report skip", () => {
  let stub: { server: Server; url: string };
  before(async () => {
    stub = await startStub();
  });
  after(() => {
    stub.server.close();
  });

  const cases = [
    ...AUTHORIZATION_SERVER_CASES.filter((c) => c.caseId === "AS-8/revoked-token-introspects-inactive"),
    ...GRANT_LIFECYCLE_CASES.filter((c) => c.caseId === "AS-8/revoked-grant-refused"),
  ];

  it("finds both AS-8 revocation cases", () => {
    assert.equal(cases.length, 2);
  });

  for (const caseId of ["AS-8/revoked-token-introspects-inactive", "AS-8/revoked-grant-refused"]) {
    it(`${caseId} skips when revoke answers 401`, async () => {
      const conformanceCase = cases.find((c) => c.caseId === caseId);
      assert.ok(conformanceCase);
      const adapter = stubAdapter(stub.url);
      await adapter.setup();
      const result = await runCase(conformanceCase, makeContext(adapter, [STREAM]));
      assert.equal(result.outcome, "skip", `got ${result.outcome}: ${"detail" in result ? result.detail : ""}`);
      assert.match(result.detail ?? "", REVOKE_STEP);
      assert.match(result.detail ?? "", STATUS_401);
      assert.match(result.detail ?? "", BODY_EXCERPT);
    });
  }

  it("RS-2/time-constraint-enforced skips when the AS resolves the grant without the requested window", async () => {
    const conformanceCase = QUERY_SURFACE_CASES.find((c) => c.caseId === "RS-2/time-constraint-enforced");
    assert.ok(conformanceCase);
    const adapter = stubAdapter(stub.url);
    await adapter.setup();
    // The stub serves one record whatever the grant says, so a case that issued
    // an unconstrained grant and went on would report "overbroad access".
    const result = await runCase(conformanceCase, makeContext(adapter, [STREAM]));
    assert.equal(result.outcome, "skip", `got ${result.outcome}: ${result.detail ?? ""}`);
    assert.match(result.detail ?? "", TIME_CONSTRAINT_STEP);
  });
});
