// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { rejectClientTokenFilters } from "../server/record-filters.ts";

const CLIENT_FILTER_UNSUPPORTED = /filter\[\.\.\.\] is not supported/;

test("client filter rejection accepts requests without a filter parameter", () => {
  assert.doesNotThrow(() => rejectClientTokenFilters({ fields: "id", limit: 25 }));
});

test("client filter rejection rejects exact and range filter shapes before compilation", () => {
  for (const filter of [{ name: "Ada" }, { received_at: { gte: "2026-01-01T00:00:00Z" } }]) {
    assert.throws(
      () => rejectClientTokenFilters({ filter }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "invalid_request");
        assert.equal((error as { param?: string }).param, "filter");
        assert.match((error as Error).message, CLIENT_FILTER_UNSUPPORTED);
        return true;
      }
    );
  }
});
