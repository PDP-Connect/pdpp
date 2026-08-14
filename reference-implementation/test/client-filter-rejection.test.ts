// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { rejectUnsupportedClientQuery } from "../server/record-filters.ts";

const CLIENT_FILTER_UNSUPPORTED = /filter\[\.\.\.\] is not supported/;
const CLIENT_EXPAND_UNSUPPORTED = /expand\[\] is not supported/;
const CLIENT_EXPAND_LIMIT_UNSUPPORTED = /expand_limit\[\.\.\.\] is not supported/;

test("client filter rejection accepts requests without a filter parameter", () => {
  assert.doesNotThrow(() => rejectUnsupportedClientQuery("client", { fields: "id", limit: 25 }));
});

test("client filter rejection rejects exact and range filter shapes before compilation", () => {
  for (const filter of [{ name: "Ada" }, { received_at: { gte: "2026-01-01T00:00:00Z" } }]) {
    assert.throws(
      () => rejectUnsupportedClientQuery("client", { filter }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "invalid_request");
        assert.equal((error as { param?: string }).param, "filter");
        assert.match((error as Error).message, CLIENT_FILTER_UNSUPPORTED);
        return true;
      }
    );
  }
});

test("client expansion rejection accepts requests without expansion parameters", () => {
  assert.doesNotThrow(() => rejectUnsupportedClientQuery("client", { fields: "id", limit: 25 }));
});

test("client expansion rejection covers parsed and raw expand parameter names", () => {
  for (const requestParams of [{ expand: "children" }, { "expand[]": "children" }]) {
    assert.throws(
      () => rejectUnsupportedClientQuery("client", requestParams),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "invalid_request");
        assert.equal((error as { param?: string }).param, "expand");
        assert.match((error as Error).message, CLIENT_EXPAND_UNSUPPORTED);
        return true;
      }
    );
  }
});

test("client expansion rejection covers parsed and raw expand-limit parameter names", () => {
  for (const requestParams of [{ expand_limit: { children: 1 } }, { "expand_limit[]": 1 }]) {
    assert.throws(
      () => rejectUnsupportedClientQuery("client", requestParams),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "invalid_request");
        assert.equal((error as { param?: string }).param, "expand_limit");
        assert.match((error as Error).message, CLIENT_EXPAND_LIMIT_UNSUPPORTED);
        return true;
      }
    );
  }
});
