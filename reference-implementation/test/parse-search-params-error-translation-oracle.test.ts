// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure-logic oracle for the ERROR-TRANSLATION contract of parseSearchParams
// (server/search.js), the /v1/search wrapper. It delegates to
// parseSearchLexicalParams and translates the internal typed
// SearchLexicalRequestError into a plain Error that PRESERVES .code and .param
// so the route surfaces the same typed vocabulary. lexical-retrieval.test.js
// asserts the error MESSAGES but not the .code/.param carry-over — the property
// this oracle pins. A mutation dropping the carry-over would degrade a typed
// 4xx to a generic 500 with no failing test. No DB.

import assert from "node:assert/strict";
import test from "node:test";
import { parseSearchParams as parseSearchParamsUntyped } from "../server/search.ts";

/**
 * server/search.js is untyped JS (allowJs, checkJs:false); its
 * parseSearchParams is a thin delegating shim over the real typed
 * parseSearchLexicalParams (operations/rs-search-lexical/index.ts), whose
 * return shape (NormalizedRequestParams) is not exported by name — modeled
 * locally from the source instead.
 */
interface NormalizedLexicalParams {
  cursor: string | null;
  filter: unknown;
  filteredStream: string | null;
  limit: number;
  q: string;
  streams: string[] | null;
  warnings: { code: string; param?: string; message?: string; detail?: Record<string, unknown> }[];
}

function parseSearchParams(query: Record<string, unknown>): NormalizedLexicalParams {
  return (parseSearchParamsUntyped as (query: Record<string, unknown>) => NormalizedLexicalParams)(query);
}

test("parseSearchParams returns normalized params for a valid query", () => {
  const params = parseSearchParams({ limit: "5", q: "pasta" });
  assert.equal(params.q, "pasta");
  assert.equal(params.limit, 5);
  assert.equal(params.cursor, null);
  assert.equal(params.streams, null);
  assert.equal(params.filter, null);
  assert.deepEqual(params.warnings, []);
});

test("parseSearchParams rethrows a plain Error carrying code + param on a missing q", () => {
  assert.throws(
    () => parseSearchParams({}),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      const { code, param } = err as Error & { code?: string; param?: string };
      assert.equal(err.constructor.name, "Error"); // plain Error, not the internal typed class
      assert.equal(code, "invalid_request");
      assert.equal(param, "q");
      assert.ok(err.message.includes("q is required"));
      return true;
    }
  );
});

test("parseSearchParams preserves code + param for unsupported-param and connection-alias errors", () => {
  assert.throws(
    () => parseSearchParams({ bogus: "y", q: "x" }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      const { code, param } = err as Error & { code?: string; param?: string };
      assert.equal(code, "invalid_request");
      assert.equal(param, "bogus");
      return true;
    }
  );
  assert.throws(
    () => parseSearchParams({ connection_id: "a", connector_instance_id: "b", q: "x" }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      const { code, param } = err as Error & { code?: string; param?: string };
      assert.equal(code, "invalid_argument");
      assert.equal(param, "connector_instance_id");
      return true;
    }
  );
});
