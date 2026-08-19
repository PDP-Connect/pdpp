// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression for production `run_1787101857760` (2026-08-18, the owner's
 * first-ever Venmo run): `connector_error_json.message` recorded
 * `"venmo_session_failed: [REDACTED]: Failed to fetch"`. The full, unredacted
 * message (`spine_events.data_json.run.failed.known_gaps[].message`, which
 * bypasses `boundConnectorErrorMessage`) proved the eaten token was
 * `venmo_probe_transport_error` — a 27-char, PII-free categorical fault-class
 * name, not a secret. `stderr-redact.ts`'s `LONG_OPAQUE_RE` treats any
 * >=24-char alnum run as an unlabelled-API-key risk with no notion that a
 * declared reason code is not that.
 *
 * `runtime/stderr-redact.ts` already had a `declaredReasonTokens` allowlist
 * mechanism (added the same day for an identical HEB incident), but it was
 * wired only into `run-logger.ts` (internal scheduler/executor logging) —
 * never into `boundConnectorErrorMessage`, the function that actually
 * redacts `connector_error_json.message` before it reaches a durable spine
 * event. This suite proves that gap is now closed for Venmo specifically,
 * via `runtime/declared-reason-tokens.ts`'s per-connector registry.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { VENMO_DECLARED_REASON_TOKENS } from "../../packages/polyfill-connectors/src/auto-login/venmo.ts";
import { boundConnectorErrorMessage } from "../runtime/connector-gap-bounding.ts";
import { declaredReasonTokensFor } from "../runtime/declared-reason-tokens.ts";

test("regression: the production defect reproduced — without declared tokens, venmo_probe_transport_error is eaten", () => {
  const raw = "venmo_session_failed: venmo_probe_transport_error: Failed to fetch";
  assert.equal(boundConnectorErrorMessage(raw), "venmo_session_failed: [REDACTED]: Failed to fetch");
});

test("fix: boundConnectorErrorMessage with venmo's declared tokens preserves the real cause", () => {
  const raw = "venmo_session_failed: venmo_probe_transport_error: Failed to fetch";
  const declared = declaredReasonTokensFor("venmo");
  assert.ok(declared, "venmo must be registered in declared-reason-tokens.ts");
  assert.equal(boundConnectorErrorMessage(raw, declared), raw, "the declared token must survive verbatim");
});

test("declaredReasonTokensFor('venmo') matches the connector's OWN exported vocabulary, not a hand-copied string", () => {
  // Provenance, not spelling (see stderr-redact.ts's module doc): the
  // registry must import the connector's real constant, so a future rename
  // of a Venmo throw site cannot silently desync the two.
  assert.deepEqual(declaredReasonTokensFor("venmo"), VENMO_DECLARED_REASON_TOKENS);
});

test("declaredReasonTokensFor returns undefined for an unregistered connector — byte-identical prior behavior", () => {
  assert.equal(declaredReasonTokensFor("chase"), undefined);
  assert.equal(declaredReasonTokensFor("nonexistent_connector"), undefined);
  // And boundConnectorErrorMessage with no declared set still redacts exactly
  // as before for a connector this registry doesn't cover.
  const raw = "chase_session_failed: some_twenty_four_plus_char_token";
  assert.equal(boundConnectorErrorMessage(raw, declaredReasonTokensFor("chase")), boundConnectorErrorMessage(raw));
});

const SECRET_MUST_NOT_SURVIVE_RE = /SECRETVALUEXXXXXXXXXXXXX/;

test("secrets embedded alongside a declared token are still redacted — the allowlist cannot become a hole", () => {
  const declared = declaredReasonTokensFor("venmo");
  const [sampleToken] = VENMO_DECLARED_REASON_TOKENS;
  assert.ok(sampleToken);
  const hostile = `venmo_session_failed: ${sampleToken}: token=SECRETVALUEXXXXXXXXXXXXX`;
  const result = boundConnectorErrorMessage(hostile, declared);
  assert.ok(result);
  assert.doesNotMatch(
    result,
    SECRET_MUST_NOT_SURVIVE_RE,
    "a real secret must not survive just because a declared token is nearby"
  );
  assert.ok(result.includes(sampleToken), "the declared token itself still survives");
});

test("every one of venmo's declared reason tokens is >=24 chars — the exact length class that motivated this fix", () => {
  // Disclosed counterweight: if a future refactor shortens these below 24
  // chars, they'd survive LONG_OPAQUE_RE unaided and this registry entry
  // becomes a no-op, not a regression — this test documents that boundary,
  // it does not assert the registry is the ONLY thing keeping them legible.
  for (const token of VENMO_DECLARED_REASON_TOKENS) {
    assert.ok(token.length >= 24, `expected ${token} to be >=24 chars (got ${token.length})`);
  }
});
