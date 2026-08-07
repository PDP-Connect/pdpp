// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * GroupMe auth probe test (live only).
 *
 * Live probe: requires GROUPME_ACCESS_TOKEN env var pointing to a valid
 * GroupMe OAuth token. Confirms basic connectivity to the GroupMe API v3.
 *
 * This test is SKIPPED (not silently passed) if token is absent.
 * Public listing remains "unproven" until live run succeeds.
 */

import assert from "node:assert/strict";
import { describe, it, skip } from "node:test";

describe("GroupMe auth probe (live only)", () => {
  const testFn = process.env.GROUPME_ACCESS_TOKEN ? it : skip;

  testFn("verifies token connectivity to /users/me", async () => {
    const token = process.env.GROUPME_ACCESS_TOKEN;
    assert.ok(token, "GROUPME_ACCESS_TOKEN must be set");

    // Live mode: verify X-Access-Token header is recognized
    const res = await fetch("https://api.groupme.com/v3/users/me", {
      headers: { "X-Access-Token": token },
    });

    assert.strictEqual(res.status, 200, "valid token should return 200 OK");
    const body = (await res.json()) as { response?: Record<string, unknown> };
    assert.ok(body.response, "response should have a response field");
    assert.ok(body.response.id, "user should have an id");
  });
});
