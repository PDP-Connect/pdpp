// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression suite for the canonical `(connection_id, connector_instance_id)`
 * alias contract on public read operations.
 *
 * Closes Section 3 of `openspec/changes/canonicalize-public-read-contract`
 * (and the corresponding deferred items in
 * `openspec/changes/expose-connection-identity-on-public-read`):
 *
 *   - records list / aggregate accept `connection_id` and `connector_instance_id`
 *     as optional filters without `invalid_request` rejection;
 *   - search lexical / semantic / hybrid accept the same optional filters;
 *   - sending both with conflicting values raises a typed `invalid_argument`
 *     error with `param: 'connector_instance_id'` (the deprecated alias),
 *     not a silent winner.
 *
 * Multi-connection storage enumeration (which would let the filter narrow
 * results) is deferred; this suite exercises the validation surface, which
 * is the part that ships in this tranche.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { parseSearchHybridParams, SearchHybridRequestError } from "../operations/rs-search-hybrid/index.ts";
import { parseSearchLexicalParams, SearchLexicalRequestError } from "../operations/rs-search-lexical/index.ts";
import { parseSearchSemanticParams, SearchSemanticRequestError } from "../operations/rs-search-semantic/index.ts";
import { validateConnectionAlias } from "../server/records.ts";

const TOP_LEVEL_REGEX_1 = /same connection/;

// ─── records.js: shared alias validator ────────────────────────────────────

test("validateConnectionAlias accepts canonical-only request", () => {
  assert.doesNotThrow(() => validateConnectionAlias({ connection_id: "cin_abc" }));
});

test("validateConnectionAlias accepts deprecated-alias-only request", () => {
  assert.doesNotThrow(() => validateConnectionAlias({ connector_instance_id: "cin_abc" }));
});

test("validateConnectionAlias accepts matching values on both fields", () => {
  assert.doesNotThrow(() =>
    validateConnectionAlias({
      connection_id: "cin_abc",
      connector_instance_id: "cin_abc",
    })
  );
});

test("validateConnectionAlias rejects conflicting values", () => {
  assert.throws(
    () =>
      validateConnectionAlias({
        connection_id: "cin_abc",
        connector_instance_id: "cin_xyz",
      }),
    (err: unknown) => {
      const error = err as Error & { code?: string; param?: string };
      return (
        error.code === "invalid_argument" &&
        error.param === "connector_instance_id" &&
        TOP_LEVEL_REGEX_1.test(error.message)
      );
    }
  );
});

test("validateConnectionAlias treats empty alias as absent", () => {
  assert.doesNotThrow(() =>
    validateConnectionAlias({
      connection_id: "cin_abc",
      connector_instance_id: "",
    })
  );
});

// ─── rs.search.lexical ─────────────────────────────────────────────────────

test("lexical parser accepts connection_id as additive filter", () => {
  const params = parseSearchLexicalParams({ connection_id: "cin_abc", q: "hello" });
  assert.equal(params.q, "hello");
});

test("lexical parser accepts deprecated connector_instance_id alias", () => {
  const params = parseSearchLexicalParams({
    connector_instance_id: "cin_abc",
    q: "hello",
  });
  assert.equal(params.q, "hello");
});

test("lexical parser accepts matching values on both fields", () => {
  const params = parseSearchLexicalParams({
    connection_id: "cin_abc",
    connector_instance_id: "cin_abc",
    q: "hello",
  });
  assert.equal(params.q, "hello");
});

test("lexical parser rejects conflicting connection_id / connector_instance_id", () => {
  assert.throws(
    () =>
      parseSearchLexicalParams({
        connection_id: "cin_abc",
        connector_instance_id: "cin_xyz",
        q: "hello",
      }),
    (err: unknown) =>
      err instanceof SearchLexicalRequestError &&
      err.code === "invalid_argument" &&
      err.param === "connector_instance_id"
  );
});

// ─── rs.search.semantic ────────────────────────────────────────────────────

test("semantic parser accepts connection_id as additive filter", () => {
  const params = parseSearchSemanticParams({ connection_id: "cin_abc", q: "hello" });
  assert.equal(params.q, "hello");
});

test("semantic parser accepts deprecated connector_instance_id alias", () => {
  const params = parseSearchSemanticParams({
    connector_instance_id: "cin_abc",
    q: "hello",
  });
  assert.equal(params.q, "hello");
});

test("semantic parser rejects conflicting connection_id / connector_instance_id", () => {
  assert.throws(
    () =>
      parseSearchSemanticParams({
        connection_id: "cin_abc",
        connector_instance_id: "cin_xyz",
        q: "hello",
      }),
    (err) =>
      err instanceof SearchSemanticRequestError &&
      err.code === "invalid_argument" &&
      err.param === "connector_instance_id"
  );
});

// ─── rs.search.hybrid ──────────────────────────────────────────────────────

test("hybrid parser accepts connection_id as additive filter", () => {
  const params = parseSearchHybridParams({ connection_id: "cin_abc", q: "hello" });
  assert.equal(params.q, "hello");
});

test("hybrid parser accepts deprecated connector_instance_id alias", () => {
  const params = parseSearchHybridParams({
    connector_instance_id: "cin_abc",
    q: "hello",
  });
  assert.equal(params.q, "hello");
});

test("hybrid parser rejects conflicting connection_id / connector_instance_id", () => {
  assert.throws(
    () =>
      parseSearchHybridParams({
        connection_id: "cin_abc",
        connector_instance_id: "cin_xyz",
        q: "hello",
      }),
    (err) =>
      err instanceof SearchHybridRequestError &&
      err.code === "invalid_argument" &&
      err.param === "connector_instance_id"
  );
});
