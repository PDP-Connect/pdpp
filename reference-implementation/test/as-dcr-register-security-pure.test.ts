// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for the DCR register operation's security logic in
// operations/as-dcr-register/index.ts. Only the summary helper was pinned before;
// the execute path's auth-token validation, registration_access derivation, and the
// issuer_subject_id ANTI-SPOOFING sanitization were unpinned.
//
// RED note: auth-surface. Tests OBSERVE the auth decisions with a stubbed
// registerDynamicClient; no client is actually registered.
//
// Mutation surface:
//   - DCR disabled -> invalid_request (404).
//   - malformed (non-Bearer) auth header -> invalid_client (401).
//   - Bearer token not in the allowlist -> invalid_client (401).
//   - registration_access: valid token -> initial_access_token; owner session ->
//     owner_session; neither -> public.
//   - issuer_subject_id is DELETED from the body (anonymous cannot self-tag) and
//     replaced with the owner session subject via extraMetadata for owner callers.

import assert from "node:assert/strict";
import test from "node:test";

import {
  type DcrRegisterDependencies,
  type DcrRegisterInput,
  executeAsDcrRegister,
} from "../operations/as-dcr-register/index.ts";

interface CapturedCall {
  extraMetadata: Record<string, unknown>;
  sanitizedInput: Record<string, unknown>;
}

// Records what registerDynamicClient was called with and returns a canned client.
function capturingDeps(): DcrRegisterDependencies & { calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  return {
    calls,
    // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
    registerDynamicClient: async (sanitizedInput, extraMetadata) => {
      calls.push({ extraMetadata, sanitizedInput });
      return { client_id: "new-cli", client_name: "App", redirect_uris: ["u"], token_endpoint_auth_method: "none" };
    },
  };
}

function inputFor(
  overrides: Partial<DcrRegisterInput> & { dcrEnabled: boolean; initialAccessTokens: readonly string[] }
): DcrRegisterInput {
  return {
    authorizationHeader: null,
    body: {},
    ownerSessionSubjectId: null,
    ...overrides,
  };
}

test("executeAsDcrRegister: DCR disabled is a 404 invalid_request", async () => {
  const out = await executeAsDcrRegister(
    inputFor({ body: {}, dcrEnabled: false, initialAccessTokens: [] }),
    capturingDeps()
  );
  assert.ok(out.outcome === "failure");
  assert.equal(out.status, 404);
  assert.equal(out.errorCode, "invalid_request");
});

test("executeAsDcrRegister: a malformed (non-Bearer) auth header is a 401 invalid_client", async () => {
  const out = await executeAsDcrRegister(
    inputFor({ authorizationHeader: "Basic abc", body: {}, dcrEnabled: true, initialAccessTokens: ["tok"] }),
    capturingDeps()
  );
  assert.ok(out.outcome === "failure");
  assert.equal(out.status, 401);
  assert.equal(out.errorCode, "invalid_client");
});

test("executeAsDcrRegister: a Bearer token not in the allowlist is a 401 invalid_client", async () => {
  const out = await executeAsDcrRegister(
    inputFor({ authorizationHeader: "Bearer wrong", body: {}, dcrEnabled: true, initialAccessTokens: ["right"] }),
    capturingDeps()
  );
  assert.ok(out.outcome === "failure");
  assert.equal(out.status, 401);
  assert.equal(out.errorCode, "invalid_client");
});

test("executeAsDcrRegister: a valid initial access token yields registration_access=initial_access_token and 201", async () => {
  const out = await executeAsDcrRegister(
    inputFor({
      authorizationHeader: "Bearer right",
      body: { client_name: "X" },
      dcrEnabled: true,
      initialAccessTokens: ["right"],
    }),
    capturingDeps()
  );
  assert.ok(out.outcome === "success");
  assert.equal(out.status, 201);
  assert.equal(out.spineData.registration_access, "initial_access_token");
});

test("executeAsDcrRegister: an anonymous public caller gets registration_access=public", async () => {
  const out = await executeAsDcrRegister(
    inputFor({ body: { client_name: "X" }, dcrEnabled: true, initialAccessTokens: [] }),
    capturingDeps()
  );
  assert.ok(out.outcome === "success");
  assert.equal(out.spineData.registration_access, "public");
});

test("executeAsDcrRegister: SECURITY — an anonymous caller CANNOT self-tag issuer_subject_id", async () => {
  const deps = capturingDeps();
  await executeAsDcrRegister(
    inputFor({ body: { client_name: "X", issuer_subject_id: "ATTACKER" }, dcrEnabled: true, initialAccessTokens: [] }),
    deps
  );
  // biome-ignore lint/style/useDestructuring: index access documents the asserted ordered position
  const call = deps.calls[0];
  assert.ok(call, "expected registerDynamicClient to have been called");
  assert.ok(!("issuer_subject_id" in call.sanitizedInput), "body issuer_subject_id is stripped");
  assert.deepEqual(call.extraMetadata, {}, "no owner stamp for an anonymous caller");
});

test("executeAsDcrRegister: SECURITY — owner session subject is stamped, body value ignored", async () => {
  const deps = capturingDeps();
  const out = await executeAsDcrRegister(
    inputFor({
      body: { client_name: "X", issuer_subject_id: "ATTACKER" },
      dcrEnabled: true,
      initialAccessTokens: [],
      ownerSessionSubjectId: "real-owner",
    }),
    deps
  );
  assert.ok(out.outcome === "success");
  assert.equal(out.spineData.registration_access, "owner_session");
  // biome-ignore lint/style/useDestructuring: index access documents the asserted ordered position
  const call = deps.calls[0];
  assert.ok(call, "expected registerDynamicClient to have been called");
  assert.ok(!("issuer_subject_id" in call.sanitizedInput), "the attacker-supplied body value is removed");
  assert.deepEqual(
    call.extraMetadata,
    { issuer_subject_id: "real-owner" },
    "the trusted session subject is stamped instead"
  );
});

test("executeAsDcrRegister: success spine data reflects the registered client shape", async () => {
  const out = await executeAsDcrRegister(
    inputFor({ body: { client_name: "X" }, dcrEnabled: true, initialAccessTokens: [] }),
    capturingDeps()
  );
  assert.ok(out.outcome === "success");
  assert.equal(out.spineData.registration_mode, "dynamic");
  assert.equal(out.spineData.client_name, "App");
  assert.equal(out.spineData.token_endpoint_auth_method, "none");
  assert.equal(out.spineData.redirect_uri_count, 1);
});
