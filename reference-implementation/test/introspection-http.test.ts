// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticateIntrospectionCaller,
  basicIntrospectionAuthorization,
  createRemoteIntrospector,
} from "../server/introspection-http.ts";

const CREDENTIALS = { clientId: "pr89-rs-test", clientSecret: "pr89-rs-test-secret" };
const CLOCK_MS = Date.parse("2026-08-11T12:00:00Z");
const ISSUER = "https://as.example";
const AUDIENCE = "https://rs.example";

function validResponse(): Record<string, unknown> {
  return {
    active: true,
    aud: AUDIENCE,
    authorization_details: [
      {
        access_mode: "continuous",
        purpose_code: "https://pdpp.dev/purpose/personal-ai",
        source: { id: "https://sources.example/spotify", kind: "connector" },
        streams: [{ fields: ["id"], instance_ids: ["account-a"], name: "top_artists" }],
        type: "https://pdpp.dev/data-access",
      },
    ],
    client_id: "pr89-seam-client",
    exp: CLOCK_MS / 1000 + 300,
    grant_id: "grt_pr89",
    grant_storage_binding: { connector_id: "spotify" },
    iss: ISSUER,
    pdpp: {
      client_id: "pr89-seam-client",
      context_kind: "oauth_rar_0_1",
      grant_id: "grt_pr89",
      issued_at: "2026-08-11T11:55:00Z",
      source: { id: "https://sources.example/spotify", kind: "connector" },
      source_declaration: { version: "spotify-v1" },
      subject_id: "owner_local",
    },
    pdpp_token_kind: "client",
    subject_id: "owner_local",
  };
}

function responseFetch(
  payload: Record<string, unknown>,
  observe?: (request: { input: string | URL | Request; init?: RequestInit }) => void
): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    observe?.({ input, ...(init ? { init } : {}) });
    return Promise.resolve(
      new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" }, status: 200 })
    );
  }) as typeof fetch;
}

function introspectorFor(payload: Record<string, unknown>, fetchImpl = responseFetch(payload)) {
  return createRemoteIntrospector({
    ...CREDENTIALS,
    endpoint: `${ISSUER}/introspect`,
    expectedAudience: () => AUDIENCE,
    expectedIssuer: () => ISSUER,
    fetchImpl,
    now: () => CLOCK_MS,
  });
}

test("confidential introspection caller authentication rejects missing and wrong credentials", () => {
  assert.equal(authenticateIntrospectionCaller(undefined, CREDENTIALS), false);
  assert.equal(authenticateIntrospectionCaller("Bearer token", CREDENTIALS), false);
  assert.equal(
    authenticateIntrospectionCaller(
      basicIntrospectionAuthorization({ clientId: CREDENTIALS.clientId, clientSecret: "wrong" }),
      CREDENTIALS
    ),
    false
  );
  assert.equal(authenticateIntrospectionCaller(basicIntrospectionAuthorization(CREDENTIALS), CREDENTIALS), true);
});

test("remote introspection makes one authenticated HTTP request and resolves the response only", async () => {
  const requests: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  const introspect = introspectorFor(
    validResponse(),
    responseFetch(validResponse(), (request) => requests.push(request))
  );
  const result = await introspect("tok_pr89");

  assert.equal(result.active, true, JSON.stringify(result));
  assert.equal(requests.length, 1);
  assert.equal(String(requests[0]?.input), `${ISSUER}/introspect`);
  assert.equal(requests[0]?.init?.method, "POST");
  assert.equal(
    (requests[0]?.init?.headers as Record<string, string> | undefined)?.Authorization,
    basicIntrospectionAuthorization(CREDENTIALS)
  );
  assert.equal(requests[0]?.init?.body, "token=tok_pr89");
});

test("remote introspection accepts an owner token with a subject binding", async () => {
  const result = await introspectorFor({
    active: true,
    aud: AUDIENCE,
    iss: ISSUER,
    pdpp_token_kind: "owner",
    subject_id: "owner_local",
  })("tok_owner");

  assert.equal(result.active, true);
  assert.equal(result.pdpp_token_kind, "owner");
  assert.equal(result.subject_id, "owner_local");
});

test("remote introspection maps invalid authenticated responses to stable context reasons", async () => {
  const cases: ReadonlyArray<{
    expected: string;
    mutate: (response: Record<string, unknown>) => void;
  }> = [
    {
      expected: "context.issuer_mismatch",
      mutate: (response) => {
        response.iss = "https://wrong.example";
      },
    },
    {
      expected: "context.audience_mismatch",
      mutate: (response) => {
        response.aud = "https://wrong.example";
      },
    },
    {
      expected: "context.expired",
      mutate: (response) => {
        response.exp = CLOCK_MS / 1000;
      },
    },
    {
      expected: "context.cache_stale",
      mutate: (response) => {
        response.cache_expires_at = CLOCK_MS / 1000;
      },
    },
    {
      expected: "context.kind_mismatch",
      mutate: (response) => {
        response.pdpp_token_kind = "unsupported";
      },
    },
    {
      expected: "context.identity_mismatch",
      mutate: (response) => {
        (response.pdpp as Record<string, unknown>).client_id = "wrong-client";
      },
    },
    {
      expected: "context.source_mismatch",
      mutate: (response) => {
        (response.pdpp as Record<string, unknown>).source = {
          id: "https://sources.example/wrong",
          kind: "connector",
        };
      },
    },
    {
      expected: "context.grant_mismatch",
      mutate: (response) => {
        response.grant_id = "wrong-grant";
      },
    },
    {
      expected: "context.rights_missing",
      mutate: (response) => {
        response.authorization_details = undefined;
      },
    },
    {
      expected: "context.rights_duplicated",
      mutate: (response) => {
        (response.pdpp as Record<string, unknown>).streams = [];
      },
    },
  ];

  for (const fixture of cases) {
    const response = validResponse();
    fixture.mutate(response);
    // biome-ignore lint/performance/noAwaitInLoops: Table rows are intentionally resolved in stable assertion order.
    const result = await introspectorFor(response)("tok_pr89");
    assert.deepEqual(result, { active: false, inactive_reason: fixture.expected });
  }
});

test("remote introspection fails closed on transport, status, and JSON errors", async () => {
  const failures: (typeof fetch)[] = [
    (() => Promise.reject(new Error("offline"))) as typeof fetch,
    (() => Promise.resolve(new Response("denied", { status: 401 }))) as typeof fetch,
    (() => Promise.resolve(new Response("not-json", { status: 200 }))) as typeof fetch,
  ];
  for (const fetchImpl of failures) {
    // biome-ignore lint/performance/noAwaitInLoops: Table rows are intentionally resolved in stable assertion order.
    const result = await introspectorFor(validResponse(), fetchImpl)("tok_pr89");
    assert.deepEqual(result, { active: false, inactive_reason: "context.authentication_failed" });
  }
});
