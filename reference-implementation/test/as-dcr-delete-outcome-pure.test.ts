// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for the DCR client-delete operation in
// operations/as-dcr-delete/index.ts. No test imports it by name. It maps the
// deleteRegisteredClient store call into a 204 success or a typed failure whose
// HTTP status is derived from the error code — the delete-outcome contract.
//
// RED note: auth-surface. Tests OBSERVE the outcome mapping only; the delete
// itself is a stub, no client state is modified.
//
// Mutation surface:
//   - success -> { outcome:'success', status:204 }.
//   - thrown error -> status via mapErrorStatus (not_found->404, forbidden->403,
//     else 400); errorCode from err.code (default 'invalid_request'); errorMessage
//     from err.message (default 'Client deletion rejected').

import assert from "node:assert/strict";
import test from "node:test";

import {
  type DcrDeleteDependencies,
  type DcrDeleteInput,
  executeAsDcrDelete,
} from "../operations/as-dcr-delete/index.ts";

class CodedError extends Error {
  code?: string;
}

function throwingDeps(code: string | undefined, message: string): DcrDeleteDependencies {
  return {
    deleteRegisteredClient: () => {
      const err = new CodedError(message);
      if (code !== undefined) {
        err.code = code;
      }
      throw err;
    },
  };
}

function inputFor(clientId: string): DcrDeleteInput {
  return { actingSubjectId: "owner", clientId, requestId: "r", traceId: "t" };
}

test("executeAsDcrDelete: a clean delete is a 204 success", async () => {
  let received: string | null = null;
  const out = await executeAsDcrDelete(inputFor("cli-1"), {
    deleteRegisteredClient: (id) => {
      received = id;
    },
  });
  assert.equal(received, "cli-1", "clientId forwarded to the store");
  assert.deepEqual(out, { outcome: "success", status: 204 });
});

test("executeAsDcrDelete: a not_found error maps to 404", async () => {
  const out = await executeAsDcrDelete(inputFor("x"), throwingDeps("not_found", "gone"));
  assert.equal(out.outcome, "failure");
  assert.ok(out.outcome === "failure");
  assert.equal(out.status, 404);
  assert.equal(out.errorCode, "not_found");
  assert.equal(out.errorMessage, "gone", "the store error message is surfaced");
});

test("executeAsDcrDelete: a forbidden error maps to 403", async () => {
  const out = await executeAsDcrDelete(inputFor("x"), throwingDeps("forbidden", "no"));
  assert.ok(out.outcome === "failure");
  assert.equal(out.status, 403);
  assert.equal(out.errorCode, "forbidden");
});

test("executeAsDcrDelete: an unmapped error code defaults to 400", async () => {
  const out = await executeAsDcrDelete(inputFor("x"), throwingDeps("invalid_client", "bad client"));
  assert.ok(out.outcome === "failure");
  assert.equal(out.status, 400, "invalid_client is not in the map -> 400");
  assert.equal(out.errorCode, "invalid_client");
});

test("executeAsDcrDelete: an error with no code/message uses the defaults", async () => {
  const out = await executeAsDcrDelete(inputFor("x"), throwingDeps(undefined, ""));
  assert.ok(out.outcome === "failure");
  assert.equal(out.errorCode, "invalid_request", "default error code");
  assert.equal(out.errorMessage, "Client deletion rejected", "default error message");
  assert.equal(out.status, 400);
});
