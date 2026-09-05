// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "./route.ts";

test("the public supporters route returns the runtime register with a one-minute cache", async () => {
  const supporters = [
    {
      country: "United States",
      principlesVersion: "1.0",
      publicName: "Public P.",
      signedOn: "2026-09-05",
      type: "Individual",
    },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(Response.json(supporters));
  try {
    const response = await GET();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, max-age=60");
    assert.deepEqual(await response.json(), supporters);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
