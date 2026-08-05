// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { type Check, followSameOriginRedirects, summarizeChecks } from "./friend-journey-acceptance.ts";

const CROSS_ORIGIN_REDIRECT_PATTERN = /cross-origin redirect/;
const REDIRECT_LOOP_PATTERN = /redirect loop/;
const REDIRECT_LIMIT_PATTERN = /redirect limit/;

function response(status: number, headers: Record<string, string> = {}, body = ""): Response {
  return new Response(body, { headers, status });
}

function fakeFetch(responses: Response[], urls: string[]): typeof fetch {
  let index = 0;
  return ((input) => {
    urls.push(String(input));
    const next = responses[index];
    index += 1;
    if (!next) {
      return Promise.reject(new Error("fake fetch exhausted"));
    }
    return Promise.resolve(next);
  }) as typeof fetch;
}

test("manual UAT is visible and does not fail machine readiness", () => {
  const checks: Check[] = [
    { evidence: "machine proof", id: "machine", label: "Machine proof", status: "pass" },
    { evidence: "credential required", id: "account", label: "Account collection", status: "manual_uat" },
  ];

  assert.deepEqual(summarizeChecks(checks), {
    blockerCount: 0,
    manualUatCount: 1,
    ok: true,
    passCount: 1,
  });
  assert.equal(checks.find((check) => check.id === "account")?.status, "manual_uat");
  assert.equal(
    checks.filter((check) => check.status === "pass").some((check) => check.id === "account"),
    false,
    "manual UAT must not be counted as a pass"
  );
});

test("actual blockers still fail machine readiness while manual UAT remains distinct", () => {
  const summary = summarizeChecks([
    { evidence: "credential required", id: "account", label: "Account collection", status: "manual_uat" },
    { evidence: "HTTP 500", id: "server", label: "Server", status: "blocker" },
  ]);
  assert.deepEqual(summary, { blockerCount: 1, manualUatCount: 1, ok: false, passCount: 0 });
});

test("reference redirect follows same-origin 308 and returns the rendered canonical page", async () => {
  const urls: string[] = [];
  const result = await followSameOriginRedirects("https://docs.example.test/reference", {
    fetchImpl: fakeFetch(
      [response(308, { location: "/self-host" }), response(200, {}, "<html><title>Self-Host</title></html>")],
      urls
    ),
  });

  assert.equal(result.response.status, 200);
  assert.equal(result.finalUrl.href, "https://docs.example.test/self-host");
  assert.deepEqual(result.redirectChain, [
    "https://docs.example.test/reference -> https://docs.example.test/self-host",
  ]);
  assert.deepEqual(urls, ["https://docs.example.test/reference", "https://docs.example.test/self-host"]);
});

test("reference redirect refuses cross-origin destinations", async () => {
  await assert.rejects(
    followSameOriginRedirects("https://docs.example.test/reference", {
      fetchImpl: fakeFetch([response(308, { location: "https://evil.example.test/self-host" })], []),
    }),
    CROSS_ORIGIN_REDIRECT_PATTERN
  );
});

test("reference redirect refuses loops and excessive redirect chains", async () => {
  await assert.rejects(
    followSameOriginRedirects("https://docs.example.test/reference", {
      fetchImpl: fakeFetch([response(308, { location: "/self-host" }), response(308, { location: "/reference" })], []),
    }),
    REDIRECT_LOOP_PATTERN
  );

  await assert.rejects(
    followSameOriginRedirects("https://docs.example.test/reference", {
      maxRedirects: 1,
      fetchImpl: fakeFetch([response(308, { location: "/one" }), response(308, { location: "/two" })], []),
    }),
    REDIRECT_LIMIT_PATTERN
  );
});
