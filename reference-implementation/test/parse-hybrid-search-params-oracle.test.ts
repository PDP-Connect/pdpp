// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure-logic oracle for parseHybridSearchParams (server/search-hybrid.js), the
// server-side wrapper the GET /v1/search/hybrid route uses. It delegates param
// validation to parseSearchHybridParams and translates the typed
// SearchHybridRequestError into a plain Error that PRESERVES .code and .param
// so the route surfaces the same typed vocabulary. Previously untested by name.
// A mutation that dropped the .code/.param carry-over would silently degrade the
// route's error contract to a generic 500 with no failing test. No DB.

import assert from "node:assert/strict";
import test from "node:test";
import { parseHybridSearchParams as parseHybridSearchParamsUntyped } from "../server/search-hybrid.ts";

/**
 * server/search-hybrid.js is untyped JS (allowJs, checkJs:false); its
 * parseHybridSearchParams is a thin delegating shim over the real typed
 * parseSearchHybridParams (operations/rs-search-hybrid/index.ts), whose
 * return shape (NormalizedRequestParams) is not exported by name — modeled
 * locally from the source instead.
 */
interface NormalizedHybridParams {
  filter: unknown;
  limit: number;
  q: string;
  streams: string[] | null;
  warnings: { code: string; param?: string; message?: string; detail?: Record<string, unknown> }[];
}

function parseHybridSearchParams(query: Record<string, unknown>): NormalizedHybridParams {
  return (parseHybridSearchParamsUntyped as (query: Record<string, unknown>) => NormalizedHybridParams)(query);
}

test("parseHybridSearchParams returns normalized params for a valid query", () => {
  const params = parseHybridSearchParams({ limit: "5", q: "pasta" });
  assert.equal(params.q, "pasta");
  assert.equal(params.limit, 5);
  assert.equal(params.streams, null);
  assert.equal(params.filter, null);
  assert.deepEqual(params.warnings, []);
});

test("parseHybridSearchParams rethrows a plain Error carrying code + param on a missing q", () => {
  assert.throws(
    () => parseHybridSearchParams({}),
    (err: unknown) => {
      // Translated to a plain Error (not the internal typed class) but the
      // typed vocabulary is preserved.
      assert.ok(err instanceof Error);
      const { code, param } = err as Error & { code?: string; param?: string };
      assert.equal(err.constructor.name, "Error");
      assert.equal(code, "invalid_request");
      assert.equal(param, "q");
      assert.ok(err.message.includes("q is required"));
      return true;
    }
  );
});

test("parseHybridSearchParams preserves code + param for cursor, unsupported-param, and alias errors", () => {
  assert.throws(
    () => parseHybridSearchParams({ cursor: "abc", q: "x" }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      const { code, param } = err as Error & { code?: string; param?: string };
      assert.equal(code, "invalid_request");
      assert.equal(param, "cursor");
      return true;
    }
  );
  assert.throws(
    () => parseHybridSearchParams({ bogus: "y", q: "x" }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      const { code, param } = err as Error & { code?: string; param?: string };
      assert.equal(code, "invalid_request");
      assert.equal(param, "bogus");
      return true;
    }
  );
  assert.throws(
    () => parseHybridSearchParams({ connection_id: "a", connector_instance_id: "b", q: "x" }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      const { code, param } = err as Error & { code?: string; param?: string };
      assert.equal(code, "invalid_argument");
      assert.equal(param, "connector_instance_id");
      return true;
    }
  );
});
