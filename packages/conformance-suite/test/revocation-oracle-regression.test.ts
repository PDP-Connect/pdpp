// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import type { SeededStream, TargetAdapter } from "../src/harness/adapter.ts";
import { makeContext, runCase } from "../src/harness/runner.ts";
import { ALL_CASES } from "../src/suite.ts";

const CASES = [
  "AS-25/client-revocation-of-an-access-token-ends-it",
  "AS-25/refresh-token-revocation-ends-the-family-grants",
];
const streams: SeededStream[] = [
  {
    name: "events",
    fields: ["id"],
    primaryKey: ["id"],
    recordCount: 1,
    semantics: "append_only",
  },
];

async function scripted(
  t: TestContext,
  caseId: string,
  delay: number,
  status = 401,
  code = "grant_revoked",
  challenge = 'Bearer error="invalid_token"',
  transport = false
) {
  let now = 0;
  let revoked = false;
  const realTimeout = globalThis.setTimeout;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setTimeout", ((callback: () => void, ms = 0) => {
    now += ms;
    return realTimeout(callback, 0);
  }) as typeof setTimeout);
  t.mock.method(globalThis, "fetch", () => {
    if (revoked && now >= delay) {
      if (transport) {
        return Promise.reject(new Error("scripted transport failure"));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ error: { type: "authentication_error", code, message: "refused" } }), {
          status,
          headers: { "www-authenticate": challenge, "content-type": "application/json" },
        })
      );
    }
    return Promise.resolve(new Response('{"data":[{"id":"1"}]}', { status: 200 }));
  });
  const grant = {
    accessToken: "synthetic-access",
    refreshToken: "synthetic-refresh",
    grantId: "synthetic-grant",
    streams: [{ name: "events", fields: ["id"] }],
  };
  const adapter = {
    baseUrl: "https://scripted.invalid",
    queryBase: "/v1",
    capabilities: { refreshTokens: true },
    issueGrant: async () => grant,
    issueRefreshableGrant: async () => grant,
    revokeToken: () => {
      revoked = true;
      return Promise.resolve({ status: 200 });
    },
  } as unknown as TargetAdapter;
  const c = ALL_CASES.find((entry) => entry.caseId === caseId);
  assert.ok(c);
  const result = await runCase(c, makeContext(adapter, streams));
  return { result, elapsed: now };
}

for (const caseId of CASES) {
  for (const delay of [30_000, 60_000]) {
    it(`${caseId} accepts a conformant ${delay}ms positive cache`, async (t) => {
      const { result, elapsed } = await scripted(t, caseId, delay);
      assert.equal(result.outcome, "pass", result.detail ?? "(no detail)");
      assert.equal(elapsed, delay);
    });
  }
  it(`${caseId} fails continued success after the 60s ceiling`, async (t) => {
    const { result, elapsed } = await scripted(t, caseId, Number.POSITIVE_INFINITY);
    assert.equal(result.outcome, "fail", result.detail ?? "(no detail)");
    assert.equal(elapsed, 60_000);
  });
  for (const status of [500, 403]) {
    it(`${caseId} rejects HTTP ${status} as proof of revocation`, async (t) => {
      const { result } = await scripted(t, caseId, 0, status);
      assert.equal(result.outcome, "fail", result.detail ?? "(no detail)");
    });
  }
  it(`${caseId} rejects a wrong structured error code`, async (t) => {
    const { result } = await scripted(t, caseId, 0, 401, "server_error");
    assert.equal(result.outcome, "fail", result.detail ?? "(no detail)");
  });
  it(`${caseId} rejects a missing invalid_token challenge`, async (t) => {
    const { result } = await scripted(t, caseId, 0, 401, "grant_revoked", "Bearer");
    assert.equal(result.outcome, "fail", result.detail ?? "(no detail)");
  });
  it(`${caseId} accepts authentication_error when the cause is undisclosed`, async (t) => {
    const { result } = await scripted(t, caseId, 0, 401, "authentication_error");
    assert.equal(result.outcome, "pass", result.detail ?? "(no detail)");
  });
  it(`${caseId} never passes a transport failure`, async (t) => {
    const { result } = await scripted(t, caseId, 0, 401, "grant_revoked", "Bearer", true);
    assert.notEqual(result.outcome, "pass");
  });
}
