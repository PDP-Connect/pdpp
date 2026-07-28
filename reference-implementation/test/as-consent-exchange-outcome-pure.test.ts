// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for the consent-exchange code-redemption operation in
// operations/as-consent-exchange/index.ts. No test imports it by name. It maps a
// consent-exchange code redemption into a typed success or a reason-specific
// failure (missing / expired / consumed / unknown) — the redemption contract that
// governs whether a client obtains a grant token.
//
// RED note: auth-surface. Tests OBSERVE the outcome mapping; the store is a stub,
// no grant/token is minted.
//
// Mutation surface:
//   - missing code -> 400/invalid_request/"code is required".
//   - expired  -> 410/invalid_grant (expired message).
//   - consumed -> 410/invalid_grant (already-redeemed message).
//   - other not-ok -> 404/not_found (unknown-code message).
//   - ok -> success with { grant_id, token, grant } envelope.

import assert from "node:assert/strict";
import test from "node:test";

import {
  type AsConsentExchangeDependencies,
  executeAsConsentExchange,
} from "../operations/as-consent-exchange/index.ts";

const okDeps: AsConsentExchangeDependencies = {
  consumeConsentExchangeCode: () => ({ grant: { id: "grant-1" }, grantId: "grant-1", ok: true, token: "tok-1" }),
};

function notOkDeps(reason: string): AsConsentExchangeDependencies {
  return { consumeConsentExchangeCode: () => ({ ok: false, reason }) };
}

test("executeAsConsentExchange: a missing code is a 400 invalid_request", async () => {
  for (const code of ["", null, undefined]) {
    // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
    const out = await executeAsConsentExchange({ code }, okDeps);
    assert.ok(out.outcome === "failure");
    assert.equal(out.status, 400);
    assert.equal(out.errorCode, "invalid_request");
    assert.equal(out.errorMessage, "code is required");
  }
});

test("executeAsConsentExchange: an expired code is a 410 invalid_grant", async () => {
  const out = await executeAsConsentExchange({ code: "c" }, notOkDeps("expired"));
  assert.ok(out.outcome === "failure");
  assert.equal(out.status, 410);
  assert.equal(out.errorCode, "invalid_grant");
  assert.ok(out.errorMessage.toLowerCase().includes("expired"));
});

test("executeAsConsentExchange: an already-consumed code is a 410 invalid_grant", async () => {
  const out = await executeAsConsentExchange({ code: "c" }, notOkDeps("consumed"));
  assert.ok(out.outcome === "failure");
  assert.equal(out.status, 410);
  assert.equal(out.errorCode, "invalid_grant");
  assert.ok(out.errorMessage.toLowerCase().includes("redeemed"));
});

test("executeAsConsentExchange: any other not-ok reason is a 404 not_found", async () => {
  const out = await executeAsConsentExchange({ code: "c" }, notOkDeps("never_existed"));
  assert.ok(out.outcome === "failure");
  assert.equal(out.status, 404);
  assert.equal(out.errorCode, "not_found");
});

test("executeAsConsentExchange: expired and consumed are distinguished from unknown (distinct statuses)", async () => {
  const expired = await executeAsConsentExchange({ code: "c" }, notOkDeps("expired"));
  assert.ok(expired.outcome === "failure");
  const unknown = await executeAsConsentExchange({ code: "c" }, notOkDeps("mystery"));
  assert.ok(unknown.outcome === "failure");
  assert.notEqual(expired.status, unknown.status, "expired(410) must differ from unknown(404)");
  assert.equal(expired.status, 410);
  assert.equal(unknown.status, 404);
});

test("executeAsConsentExchange: a successful redemption returns the grant + token envelope", async () => {
  let redeemedCode: string | null = null;
  const out = await executeAsConsentExchange(
    { code: "good-code" },
    {
      consumeConsentExchangeCode: (c) => {
        redeemedCode = c;
        return { grant: { id: "g-9", scope: "read" }, grantId: "g-9", ok: true, token: "tok-9" };
      },
    }
  );
  assert.equal(redeemedCode, "good-code", "the code is forwarded to the store");
  assert.ok(out.outcome === "success");
  assert.equal(out.envelope.grant_id, "g-9");
  assert.equal(out.envelope.token, "tok-9");
  assert.deepEqual(out.envelope.grant, { id: "g-9", scope: "read" });
});
